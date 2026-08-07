// Split out of actions.ts when Task 9 gave that file a real 'use server'
// directive: a "use server" file may only export async functions, and both
// helpers below are synchronous string-mapping functions, not Server Actions
// themselves. Kept in their own file rather than made async, so a Server
// Component (page.tsx, [prizeId]/page.tsx) can call describeInventoryReadError
// directly without an unnecessary await, exactly as before.
//
// Which is also why `t` is a PARAMETER on both functions below rather than
// something they read: reading it would mean `getTranslations`, which is
// async, and every caller already holds a translator for the `inventory`
// namespace at the point it catches. `actionKey` is a catalogue key for the
// same reason — the phrase it names has to exist in three languages, and a
// call site cannot pass a Portuguese verb it never had.
import {
  BusinessRuleError,
  ConflictError,
  NotFoundError,
  UnauthorizedError,
  ValidationError,
} from '@/lib/errors';

/**
 * Every read the two inventory screens perform — listCompanyAccess,
 * listPrizeCategories, listPrizesPage, getPrizeById, getPrizeMovements (the
 * last two replaced Block 2's listPrizes-per-Station scan in 3b) — only throws
 * InternalError: none of them call an RPC, so none of the write-side codes
 * mapInventoryError (services/inventory.ts) maps can surface here today. The
 * full taxonomy is handled anyway, the same reasoning roles/actions.ts's
 * describeRoleError gives for its own two callers: collapsing it to a single
 * generic message would work today and silently stop being true the moment a
 * read starts going through an RPC — reconcileInventory (Task 9) is exactly
 * that, but it has its own describeInventoryWriteError call below rather than
 * this one, since its 403 needs the same per-action wording the six mutating
 * actions get.
 */
export function describeInventoryReadError(
  cause: unknown,
  t: (key: string, values?: Record<string, string>) => string,
): string {
  if (cause instanceof ConflictError) return cause.message;
  if (cause instanceof BusinessRuleError) return cause.message;
  if (cause instanceof NotFoundError) {
    return t('thatCouldNotBeFound');
  }
  if (cause instanceof UnauthorizedError) {
    return t('youDoNotHavePermissionToViewInventory');
  }
  if (cause instanceof ValidationError) return cause.message;
  // Generic on purpose: InternalError means the fault is ours, not theirs,
  // and its message may carry a raw database error — not something to show.
  return t('couldNotLoadTheInventory');
}

/**
 * Same taxonomy as describeInventoryReadError, worded for a write (or
 * reconciliation) instead of a page load. Each of Task 9's six mutating
 * actions and the reconciliation check pass their own `action` phrase — "add
 * stock", "adjust stock", "reserve stock", "release a reservation", "record a
 * manual exit", "register prizes", "register categories", "view inventory" —
 * so a 403 reads as "you cannot do THIS, here" rather than a generic
 * "inventory" refusal. mapInventoryError (services/inventory.ts) itself only
 * ever throws UnauthorizedError with the raw Postgres text ("permission
 * denied: inventory.entry required") — it names the permission code, not the
 * action in the person's own words, so that message is rewritten here rather
 * than passed through.
 *
 * ConflictError and BusinessRuleError already carry a complete, specific
 * sentence from mapInventoryError's own mapping: the bucket-floor refusal
 * names the available count ("only 5 unit(s) are in available, and 10 were
 * requested"), the physical-stock-remaining refusal on archive names that
 * count, and a duplicate category name/internal_code names the value. Those
 * pass through verbatim — replacing any of them with something generic would
 * throw away the one number the person actually needed to read.
 */
export function describeInventoryWriteError(
  cause: unknown,
  t: (key: string, values?: Record<string, string>) => string,
  actionKey: string,
): string {
  if (cause instanceof ConflictError) return cause.message;
  if (cause instanceof BusinessRuleError) return cause.message;
  if (cause instanceof NotFoundError) {
    return t('thatCouldNotBeFound');
  }
  if (cause instanceof UnauthorizedError) {
    return t('youDoNotHavePermissionToHere', { action: t(actionKey) });
  }
  if (cause instanceof ValidationError) return cause.message;
  // Generic on purpose: InternalError means the fault is ours, not theirs,
  // and its message may carry a raw database error — not something to show.
  return t('couldNotSave');
}
