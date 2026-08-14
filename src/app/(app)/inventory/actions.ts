'use server';

import { getTranslations } from 'next-intl/server';
import { redirect } from 'next/navigation';
import { createUserClient } from '@/lib/supabase/user-client';
import {
  prizeFormSchema,
  prizeUpdateSchema,
  movementFormSchema,
  reverseMovementSchema,
} from '@/schemas/inventory';
import { promotionPrizeLinkSchema } from '@/schemas/promotions';
import {
  adjustStock,
  archivePrize,
  clearPrizePhoto,
  createPrize,
  createPrizeCategory,
  getPrizeById,
  reconcileInventory,
  recordStockEntry,
  recordStockExit,
  releaseReservation,
  reserveStock,
  reverseMovement,
  updatePrize,
  uploadPrizePhoto,
} from '@/services/inventory';
import type { PrizeSummary, ReconciliationRow } from '@/services/inventory';
// The promotion-link door itself (design D6): "Vincular promoção" calls the
// SAME linkPrizeToPromotion the Promotions screen's own prizes-tab.tsx calls
// (src/app/(app)/promotions/actions.ts's linkPrizeAction) — it takes a
// promotion id AND a prize id as flat, independent parameters rather than a
// promotion as its sole subject, so calling it from a PRIZE's own record is
// exactly as sensible as calling it from a promotion's. Not a second door.
import { linkPrizeToPromotion, listLinkablePromotions } from '@/services/promotions';
import type { LinkablePromotion } from '@/services/promotions';
import { listReservableShows } from '@/services/shows';
import type { ReservableShow } from '@/services/shows';
import { logger } from '@/lib/logger';
import { describeInventoryReadError, describeInventoryWriteError } from './errors';

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
    return { status: 'error', message: describeInventoryWriteError(cause, await getTranslations('inventory'), 'actionRegisterCategories') };
  }
}

export interface PrizeFormState {
  status: 'idle' | 'saved' | 'error';
  message?: string;
  /**
   * The prize that was just created. The grid opens its record on this id and
   * takes the row from that read, rather than this action assembling a summary
   * — a PrizeSummary carries a balance, and a balance is the ledger's
   * arithmetic, not something a create call should be inventing.
   */
  prizeId?: string;
}

/**
 * The photograph does not travel with the rest of the form, and cannot.
 *
 * update_prize does not take it (0145) and createPrize has no record to key an
 * upload against — the storage key is derived from the prize's id, which does
 * not exist until the row does. So both actions save the prize first and settle
 * the picture against the id afterwards.
 *
 * A photograph that fails therefore leaves a prize that SAVED, which is the
 * right way round: losing a whole catalogue entry over an image would be worse
 * than a prize with no picture yet.
 *
 * `photoCleared` is what tells "left alone" from "taken away". An empty file
 * input looks identical to a deliberate removal, so without that flag every
 * Save would either clear the photograph or none ever would.
 *
 * Reports the resulting address so a caller holding a summary can patch it
 * rather than read the prize a second time: `undefined` means untouched, `null`
 * means cleared.
 */
async function settlePrizePhoto(
  token: string,
  companyId: string,
  prizeId: string,
  formData: FormData,
  t: Awaited<ReturnType<typeof getTranslations>>,
): Promise<{ ok: true; url?: string | null } | { ok: false; message: string }> {
  const file = formData.get('photo');
  const cleared = formData.get('photoCleared') === 'on';

  try {
    if (file instanceof File && file.size > 0) {
      return { ok: true, url: await uploadPrizePhoto(token, { companyId, prizeId, file }) };
    }
    if (cleared) {
      await clearPrizePhoto(token, prizeId);
      return { ok: true, url: null };
    }
    return { ok: true };
  } catch (cause) {
    logger.error({ err: cause, prizeId }, 'prize photograph failed');
    return { ok: false, message: describeInventoryWriteError(cause, t, 'actionSaveThisPrize') };
  }
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

  let prizeId: string;
  try {
    prizeId = await createPrize(parsed.data, token);
  } catch (cause) {
    logger.error({ err: cause, companyId: parsed.data.companyId }, 'create prize failed');
    return { status: 'error', message: describeInventoryWriteError(cause, await getTranslations('inventory'), 'actionRegisterPrizes') };
  }

  // The prize exists from here on, so the failure below carries its id: the
  // screen still offers "View prize", and the operator retries the picture
  // without retyping the catalogue entry.
  const photo = await settlePrizePhoto(
    token,
    parsed.data.companyId,
    prizeId,
    formData,
    await getTranslations('inventory'),
  );
  if (!photo.ok) return { status: 'error', message: photo.message, prizeId };
  return { status: 'saved', prizeId };
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

/**
 * `unitAmount`/`totalAmount` are optional numeric fields (movementFormSchema's
 * own `optionalAmount`): an empty string from a number input has to read as
 * "not given", never as the number 0 — `Number('')` is 0 in JavaScript, which
 * would silently record a zero-value invoice line for every entry the
 * operator left blank rather than omitting the figure entirely.
 */
function parseOptionalAmount(value: FormDataEntryValue | null): number | null {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed === '' ? null : Number(trimmed);
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
    invoiceNumber: formData.get('invoiceNumber') || null,
    unitAmount: parseOptionalAmount(formData.get('unitAmount')),
    totalAmount: parseOptionalAmount(formData.get('totalAmount')),
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
    return { status: 'error', message: describeInventoryWriteError(cause, await getTranslations('inventory'), 'actionAddStock') };
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
    type: formData.get('type') || undefined,
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
    return { status: 'error', message: describeInventoryWriteError(cause, await getTranslations('inventory'), 'actionRecordAManualExit') };
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
      const t = await getTranslations('inventory');
      return {
        status: 'no_change',
        message: t('theCountAlreadyMatchedWhatWasBooked'),
      };
    }
    return { status: 'saved' };
  } catch (cause) {
    logger.error({ err: cause, prizeId: data.prizeId }, 'adjust stock failed');
    return { status: 'error', message: describeInventoryWriteError(cause, await getTranslations('inventory'), 'actionAdjustStock') };
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
    // "Vincular programa" (Task 7): reservation-forms.tsx only renders this
    // field for that Tipo, so a plain "Reservar" submission arrives with the
    // field absent — `|| null` reads that as the door's own anonymous hold
    // (movementFormSchema's optionalUuid, which reserve_stock's own p_show_id
    // already treats as "no owner").
    showId: formData.get('showId') || null,
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
    return { status: 'error', message: describeInventoryWriteError(cause, await getTranslations('inventory'), 'actionReserveStock') };
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
    // Task 7 brief, note 1: release_reservation's own remaining-quantity
    // arithmetic is gated on `p_reservation_id`, and a call omitting it
    // over-releases freely — that compatibility shape (optionalUuid on the
    // schema, `default null` on the RPC) exists only for callers that
    // predate D5. This screen's own ReleaseForm (reservation-forms.tsx)
    // always carries this as a hidden field naming the reservation it is
    // releasing, so `|| null` here is read from formData for the same
    // uniform reason every other field on this call is, never as a
    // deliberate anonymous-release path this door offers.
    reservationId: formData.get('reservationId') || null,
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
      message: describeInventoryWriteError(cause, await getTranslations('inventory'), 'actionReleaseAReservation'),
    };
  }
}

/**
 * "Vincular promoção" (Reservas tab, Task 7, design D6): the SAME door
 * promotions/actions.ts's linkPrizeAction calls, parsed with the SAME
 * promotionPrizeLinkSchema that door's own form posts against — not a
 * movementFormSchema variant, because this is not a movement-ledger form at
 * all on this side of the call; it is the promotion-prize link, reached from
 * the prize's own record instead of the promotion's. `note` is deliberately
 * absent (link_prize_to_promotion's own comment, 0049: "the link itself
 * names the promotion, which is the explanation an exit or a reservation
 * lacks"), matching the Promotions screen's own LinkForm, which collects
 * none either.
 */
export async function linkPrizeToPromotionAction(
  _prev: MovementFormState,
  formData: FormData,
): Promise<MovementFormState> {
  const parsed = promotionPrizeLinkSchema.safeParse({
    promotionId: formData.get('promotionId'),
    prizeId: formData.get('prizeId'),
    quantity: Number(formData.get('quantity')),
  });

  if (!parsed.success) {
    return { status: 'error', message: parsed.error.issues[0]?.message ?? 'Check the form.' };
  }

  const token = await requireAccessToken();

  try {
    await linkPrizeToPromotion(parsed.data, token);
    return { status: 'saved' };
  } catch (cause) {
    logger.error(
      { err: cause, prizeId: parsed.data.prizeId, promotionId: parsed.data.promotionId },
      'link prize to promotion failed',
    );
    return {
      status: 'error',
      message: describeInventoryWriteError(cause, await getTranslations('inventory'), 'actionLinkAPrizeToAPromotion'),
    };
  }
}

export interface ReservationTargets {
  shows: ReservableShow[];
  promotions: LinkablePromotion[];
}

/**
 * The Reservas tab's own picker reads (Task 7): programmes and promotions
 * "active or starting in the future", for "Vincular programa" and "Vincular
 * promoção" respectively. Not bound to `useActionState` — like
 * searchLinkablePrizesAction on the Promotions screen, this is called
 * directly with an argument rather than posted as a form, and it runs once
 * when the tab opens rather than per keystroke, so both reads travel
 * together in one round trip.
 */
export async function listReservationTargetsAction(
  companyId: string,
): Promise<
  { status: 'ok'; targets: ReservationTargets } | { status: 'error'; message: string }
> {
  try {
    const [shows, promotions] = await Promise.all([
      listReservableShows(companyId),
      listLinkablePromotions(companyId),
    ]);
    return { status: 'ok', targets: { shows, promotions } };
  } catch (cause) {
    logger.error({ err: cause, companyId }, 'could not read the reservation pickers');
    return { status: 'error', message: describeInventoryReadError(cause, await getTranslations('inventory')) };
  }
}

export type ReverseMovementState =
  | { status: 'idle' }
  | { status: 'saved' }
  | { status: 'error'; message: string };

/**
 * The single door behind every Arquivar button (Task 6, design spec §5/D1):
 * archives an entry or an exit by writing its opposite through
 * reverse_movement (0195). Gated on the ORIGINAL movement's own permission
 * (entry or exit), never a separate inventory.reverse code — the same
 * borrowing reverse_movement's own body does, so this action needs no
 * permission check of its own beyond what the RPC re-checks.
 *
 * The reason is REQUIRED (Task 6 brief, note 1): reverse_movement refuses a
 * blank p_note with 22023 exactly as record_stock_exit/reserve_stock/
 * release_reservation already do, and reversalReason/reversalReasonHint's
 * dialog is what collects it — never invented here.
 *
 * A ValidationError's message passes through describeInventoryWriteError
 * verbatim, which matters more here than on any of its siblings: the refusal
 * this door hits in practice is "the stock is no longer there to take back"
 * (spec §5), and that message names the shortfall — the whole point of
 * showing it at all.
 */
export async function reverseMovementAction(
  _prev: ReverseMovementState,
  formData: FormData,
): Promise<ReverseMovementState> {
  const parsed = reverseMovementSchema.safeParse({
    movementId: formData.get('movementId'),
    note: formData.get('note'),
  });

  if (!parsed.success) {
    return { status: 'error', message: parsed.error.issues[0]?.message ?? 'Check the form.' };
  }

  const token = await requireAccessToken();

  try {
    await reverseMovement(parsed.data.movementId, parsed.data.note, token);
    return { status: 'saved' };
  } catch (cause) {
    logger.error({ err: cause, movementId: parsed.data.movementId }, 'reverse movement failed');
    return {
      status: 'error',
      message: describeInventoryWriteError(cause, await getTranslations('inventory'), 'actionArchiveMovement'),
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
    return { status: 'error', message: describeInventoryWriteError(cause, await getTranslations('inventory'), 'actionViewInventory') };
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

  let found: Awaited<ReturnType<typeof getPrizeById>>;
  try {
    await updatePrize(parsed.data, token);
    // Re-read rather than echo the form: the balance buckets the grid shows
    // come from the ledger, not from anything this write touched, and the row
    // has to keep showing them. It also hands over the Station, which the
    // photograph's storage key needs and this form does not carry.
    found = await getPrizeById(parsed.data.prizeId);
  } catch (cause) {
    logger.error({ err: cause, prizeId: parsed.data.prizeId }, 'update prize failed');
    return { status: 'error', message: describeInventoryWriteError(cause, await getTranslations('inventory'), 'actionSaveThisPrize') };
  }

  if (!found) return { status: 'saved' };

  const photo = await settlePrizePhoto(
    token,
    found.companyId,
    parsed.data.prizeId,
    formData,
    await getTranslations('inventory'),
  );
  if (!photo.ok) return { status: 'error', message: photo.message, prize: found.prize };

  // Patched from what the upload returned rather than read a second time. The
  // row the grid patches itself with must carry the new picture, or the list
  // goes on showing the old one until the record is reopened — the same defect
  // Block 3c fixed for every other field on this dialog.
  const prize =
    photo.url === undefined ? found.prize : { ...found.prize, photoUrl: photo.url };
  return { status: 'saved', prize };
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
    return { status: 'error', message: describeInventoryWriteError(cause, await getTranslations('inventory'), 'actionArchiveThisPrize') };
  }
}
