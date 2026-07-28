'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { createUserClient } from '@/lib/supabase/user-client';
import { prizeFormSchema, movementFormSchema } from '@/schemas/inventory';
import {
  adjustStock,
  createPrize,
  createPrizeCategory,
  reconcileInventory,
  recordStockEntry,
  recordStockExit,
  releaseReservation,
  reserveStock,
} from '@/services/inventory';
import type { ReconciliationRow } from '@/services/inventory';
import { logger } from '@/lib/logger';
import { describeInventoryWriteError } from './errors';

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
    revalidatePath('/inventory');
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
    revalidatePath('/inventory');
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
    revalidatePath(`/inventory/${data.prizeId}`);
    revalidatePath('/inventory');
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
    revalidatePath(`/inventory/${data.prizeId}`);
    revalidatePath('/inventory');
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
    revalidatePath(`/inventory/${data.prizeId}`);
    revalidatePath('/inventory');
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
    revalidatePath(`/inventory/${data.prizeId}`);
    revalidatePath('/inventory');
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
    revalidatePath(`/inventory/${data.prizeId}`);
    revalidatePath('/inventory');
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

export interface ReconciliationState {
  status: 'idle' | 'checked' | 'error';
  message?: string;
  rows?: ReconciliationRow[];
  checkedAt?: string;
}

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
