'use server';

import { redirect } from 'next/navigation';
import { createUserClient } from '@/lib/supabase/user-client';
import { prizeFormSchema, prizeUpdateSchema, movementFormSchema } from '@/schemas/inventory';
import {
  adjustStock,
  archivePrize,
  createPrize,
  createPrizeCategory,
  getPrizeById,
  reconcileInventory,
  recordStockEntry,
  recordStockExit,
  releaseReservation,
  reserveStock,
  updatePrize,
} from '@/services/inventory';
import type { PrizeSummary, ReconciliationRow } from '@/services/inventory';
import { logger } from '@/lib/logger';
import { describeInventoryWriteError } from './errors';

// ---------------------------------------------------------------------------
// Not one revalidatePath in this file, deliberately (Block 3c) — the same rule
// members/actions.ts carries, for the same reason.
//
// Every write below is invoked from the prize record dialog, and revalidatePath
// returns a fresh render of the current route alongside the action's result,
// re-running the inventory list's keyset query and losing the operator's place
// in it. The grid patches its own row instead (src/lib/row-patch.ts), which is
// why the actions that change a prize return what was stored.
// ---------------------------------------------------------------------------

async function requireAccessToken(): Promise<string> {
  const supabase = await createUserClient();
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) redirect('/login');
  return token;
}

// ---------------------------------------------------------------------------
// Catalogue — inventory.catalogue
// ---------------------------------------------------------------------------

export interface CategoryFormState {
  status: 'idle' | 'saved' | 'error';
  message?: string;
}

export async function createCategoryAction(
  _prev: CategoryFormState,
  formData: FormData,
): Promise<CategoryFormState> {
  const companyId = String(formData.get('companyId') ?? '');
  const name = String(formData.get('name') ?? '').trim();

  if (!companyId) return { status: 'error', message: 'Choose a Station first.' };
  if (!name) return { status: 'error', message: 'Name the category.' };
  // create_prize_category stores this as unbounded `text`, same as
  // prizes.name — bounded here to the same 120 characters prizeFormSchema
  // gives prizes.name, so a caller bypassing the form (which already carries
  // maxLength={120}) cannot store an arbitrarily long category name.
  if (name.length > 120) {
    return { status: 'error', message: 'Keep the category name to 120 characters or fewer.' };
  }

  const token = await requireAccessToken();

  try {
    await createPrizeCategory(companyId, name, token);
    return { status: 'saved' };
  } catch (cause) {
    logger.error({ err: cause, companyId }, 'create prize category failed');
    return { status: 'error', message: describeInventoryWriteError(cause, 'register categories') };
  }
}

export interface PrizeFormState {
  status: 'idle' | 'saved' | 'error';
  message?: string;
}

export async function createPrizeAction(
  _prev: PrizeFormState,
  formData: FormData,
): Promise<PrizeFormState> {
  const parsed = prizeFormSchema.safeParse({
    companyId: formData.get('companyId'),
    categoryId: formData.get('categoryId') || null,
    name: formData.get('name'),
    internalCode: formData.get('internalCode') || null,
    description: formData.get('description') || null,
    allowsReturnToStock: formData.get('allowsReturnToStock') === 'on',
  });

  if (!parsed.success) {
    return { status: 'error', message: parsed.error.issues[0]?.message ?? 'Check the form.' };
  }

  const token = await requireAccessToken();

  try {
    await createPrize(parsed.data, token);
    return { status: 'saved' };
  } catch (cause) {
    logger.error({ err: cause, companyId: parsed.data.companyId }, 'create prize failed');
    return { status: 'error', message: describeInventoryWriteError(cause, 'register prizes') };
  }
}

// ---------------------------------------------------------------------------
// Movements. Every action below parses against movementFormSchema with its
// own `kind` literal folded in, then narrows on `data.kind` before calling the
// matching service function. That narrowing check is not decoration: it is
// what lets the compiler — not a hand-written field mapping — prove the
// parsed object actually matches the service call's input type, since
// services/inventory.ts's Stock*Input types are each
// `Extract<MovementFormInput, { kind: '...' }>` (Task 7/8's closed seam). A
// `parsed.data` that somehow carried the wrong kind would fail to compile
// against the service function it is passed to, rather than silently
// mismapping a field at runtime.
// ---------------------------------------------------------------------------

export interface MovementFormState {
  status: 'idle' | 'saved' | 'error';
  message?: string;
}

export async function recordStockEntryAction(
  _prev: MovementFormState,
  formData: FormData,
): Promise<MovementFormState> {
  const parsed = movementFormSchema.safeParse({
    kind: 'entry',
    companyId: formData.get('companyId'),
    prizeId: formData.get('prizeId'),
    entryType: formData.get('entryType'),
    quantity: Number(formData.get('quantity')),
    note: formData.get('note') || null,
  });

  if (!parsed.success) {
    return { status: 'error', message: parsed.error.issues[0]?.message ?? 'Check the form.' };
  }
  const data = parsed.data;
  if (data.kind !== 'entry') return { status: 'error', message: 'Unexpected form submission.' };

  const token = await requireAccessToken();

  try {
    await recordStockEntry(data, token);
    return { status: 'saved' };
  } catch (cause) {
    logger.error({ err: cause, prizeId: data.prizeId }, 'record stock entry failed');
    return { status: 'error', message: describeInventoryWriteError(cause, 'add stock') };
  }
}

export async function recordStockExitAction(
  _prev: MovementFormState,
  formData: FormData,
): Promise<MovementFormState> {
  const parsed = movementFormSchema.safeParse({
    kind: 'exit',
    companyId: formData.get('companyId'),
    prizeId: formData.get('prizeId'),
    quantity: Number(formData.get('quantity')),
    note: formData.get('note'),
  });

  if (!parsed.success) {
    return { status: 'error', message: parsed.error.issues[0]?.message ?? 'Check the form.' };
  }
  const data = parsed.data;
  if (data.kind !== 'exit') return { status: 'error', message: 'Unexpected form submission.' };

  const token = await requireAccessToken();

  try {
    await recordStockExit(data, token);
    return { status: 'saved' };
  } catch (cause) {
    logger.error({ err: cause, prizeId: data.prizeId }, 'record stock exit failed');
    return { status: 'error', message: describeInventoryWriteError(cause, 'record a manual exit') };
  }
}

export interface AdjustmentFormState {
  status: 'idle' | 'saved' | 'no_change' | 'error';
  message?: string;
}

export async function adjustStockAction(
  _prev: AdjustmentFormState,
  formData: FormData,
): Promise<AdjustmentFormState> {
  const parsed = movementFormSchema.safeParse({
    kind: 'adjustment',
    companyId: formData.get('companyId'),
    prizeId: formData.get('prizeId'),
    counted: Number(formData.get('counted')),
    note: formData.get('note'),
  });

  if (!parsed.success) {
    return { status: 'error', message: parsed.error.issues[0]?.message ?? 'Check the form.' };
  }
  const data = parsed.data;
  if (data.kind !== 'adjustment') {
    return { status: 'error', message: 'Unexpected form submission.' };
  }

  const token = await requireAccessToken();

  try {
    const movementId = await adjustStock(data, token);
    // adjustStock (services/inventory.ts) returns null specifically when the
    // counted figure already matched what was booked — a well-defined
    // success, not a failure (adjust_stock's own comment: "every failure path
    // raises, so NULL never means an error"). Rendering that as an error
    // would tell someone who counted correctly and found nothing wrong that
    // something went wrong.
    if (movementId === null) {
      return {
        status: 'no_change',
        message: 'The count already matched what was booked — nothing needed recording.',
      };
    }
    return { status: 'saved' };
  } catch (cause) {
    logger.error({ err: cause, prizeId: data.prizeId }, 'adjust stock failed');
    return { status: 'error', message: describeInventoryWriteError(cause, 'adjust stock') };
  }
}

export async function reserveStockAction(
  _prev: MovementFormState,
  formData: FormData,
): Promise<MovementFormState> {
  const parsed = movementFormSchema.safeParse({
    kind: 'reserve',
    companyId: formData.get('companyId'),
    prizeId: formData.get('prizeId'),
    quantity: Number(formData.get('quantity')),
    note: formData.get('note'),
  });

  if (!parsed.success) {
    return { status: 'error', message: parsed.error.issues[0]?.message ?? 'Check the form.' };
  }
  const data = parsed.data;
  if (data.kind !== 'reserve') return { status: 'error', message: 'Unexpected form submission.' };

  const token = await requireAccessToken();

  try {
    await reserveStock(data, token);
    return { status: 'saved' };
  } catch (cause) {
    logger.error({ err: cause, prizeId: data.prizeId }, 'reserve stock failed');
    return { status: 'error', message: describeInventoryWriteError(cause, 'reserve stock') };
  }
}

export async function releaseReservationAction(
  _prev: MovementFormState,
  formData: FormData,
): Promise<MovementFormState> {
  const parsed = movementFormSchema.safeParse({
    kind: 'release',
    companyId: formData.get('companyId'),
    prizeId: formData.get('prizeId'),
    quantity: Number(formData.get('quantity')),
    note: formData.get('note'),
  });

  if (!parsed.success) {
    return { status: 'error', message: parsed.error.issues[0]?.message ?? 'Check the form.' };
  }
  const data = parsed.data;
  if (data.kind !== 'release') return { status: 'error', message: 'Unexpected form submission.' };

  const token = await requireAccessToken();

  try {
    await releaseReservation(data, token);
    return { status: 'saved' };
  } catch (cause) {
    logger.error({ err: cause, prizeId: data.prizeId }, 'release reservation failed');
    return {
      status: 'error',
      message: describeInventoryWriteError(cause, 'release a reservation'),
    };
  }
}

// ---------------------------------------------------------------------------
// Reconciliation — inventory.view (already the gate for the whole page)
// ---------------------------------------------------------------------------

// A discriminated union rather than one interface with every field optional:
// the state machine already guarantees `rows`/`checkedAt` are present
// together on 'checked' and absent otherwise, and `message` only on 'error' —
// but a single interface cannot express that, which is what pushed
// reconciliation-panel.tsx into an `as string` cast on `checkedAt` instead of
// a real narrowing. Modelled here, `state.status === 'checked'` alone is
// enough for the compiler to know `rows` and `checkedAt` exist, with no cast.
export type ReconciliationState =
  | { status: 'idle' }
  | { status: 'error'; message: string }
  | { status: 'checked'; rows: ReconciliationRow[]; checkedAt: string };

export async function runReconciliationAction(
  _prev: ReconciliationState,
  formData: FormData,
): Promise<ReconciliationState> {
  const companyId = String(formData.get('companyId') ?? '');
  if (!companyId) return { status: 'error', message: 'Choose a Station first.' };

  const token = await requireAccessToken();

  try {
    const rows = await reconcileInventory(companyId, token);
    // The server's own clock, taken the moment the check actually completed —
    // not a client Date.now() that would instead say when the response was
    // received, which can lag the real check under a slow connection.
    return { status: 'checked', rows, checkedAt: new Date().toISOString() };
  } catch (cause) {
    logger.error({ err: cause, companyId }, 'reconcile inventory failed');
    return { status: 'error', message: describeInventoryWriteError(cause, 'view inventory') };
  }
}

// ---------------------------------------------------------------------------
// update_prize and archive_prize (0027) reach an interface for the first time
// here. Both have existed in the database since Block 2 with nothing calling
// either of them, exactly as update_member and archive_member had.
// ---------------------------------------------------------------------------

export interface PrizeSaveState {
  status: 'idle' | 'saved' | 'error';
  message?: string;
  /** What the database actually stored, for the grid to patch its row with. */
  prize?: PrizeSummary;
}

export async function updatePrizeAction(
  _prev: PrizeSaveState,
  formData: FormData,
): Promise<PrizeSaveState> {
  const parsed = prizeUpdateSchema.safeParse({
    prizeId: formData.get('prizeId'),
    name: formData.get('name'),
    categoryId: formData.get('categoryId') || null,
    internalCode: formData.get('internalCode') || null,
    description: formData.get('description') || null,
    allowsReturnToStock: formData.get('allowsReturnToStock') === 'on',
  });
  if (!parsed.success) {
    return { status: 'error', message: parsed.error.issues[0]?.message ?? 'Check the form.' };
  }

  const token = await requireAccessToken();

  try {
    await updatePrize(parsed.data, token);
    // Re-read rather than echo the form: the balance buckets the grid shows
    // come from the ledger, not from anything this write touched, and the row
    // has to keep showing them.
    const found = await getPrizeById(parsed.data.prizeId);
    return found ? { status: 'saved', prize: found.prize } : { status: 'saved' };
  } catch (cause) {
    logger.error({ err: cause, prizeId: parsed.data.prizeId }, 'update prize failed');
    return { status: 'error', message: describeInventoryWriteError(cause, 'save this prize') };
  }
}

export interface ArchivePrizeState {
  status: 'idle' | 'archived' | 'error';
  message?: string;
}

export async function archivePrizeAction(
  _prev: ArchivePrizeState,
  formData: FormData,
): Promise<ArchivePrizeState> {
  const prizeId = String(formData.get('prizeId') ?? '');
  if (!prizeId) return { status: 'error', message: 'Missing prize.' };

  const token = await requireAccessToken();

  try {
    await archivePrize(prizeId, token);
    return { status: 'archived' };
  } catch (cause) {
    logger.error({ err: cause, prizeId }, 'archive prize failed');
    return { status: 'error', message: describeInventoryWriteError(cause, 'archive this prize') };
  }
}
