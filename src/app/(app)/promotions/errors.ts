// Split out the same way inventory/errors.ts and members/errors.ts are: a
// plain function a Server Component can call directly with no await, kept out
// of a 'use server' actions.ts so it stays a synchronous string mapper rather
// than being forced async by that directive's "every export must be an async
// function" rule.
import {
  BusinessRuleError,
  ConflictError,
  NotFoundError,
  UnauthorizedError,
  ValidationError,
} from '@/lib/errors';

/**
 * The reads this screen performs — listPromotionsPage, getPromotionRecord,
 * listCompanyAccess, has_permission — were selects and one plain boolean
 * predicate, so in practice only InternalError was reachable. The full
 * taxonomy was mapped anyway, for the reason describeInventoryReadError gives
 * for its own read-only callers: collapsing it to one generic message works
 * until a read on this surface starts going through a gated call, and then it
 * silently stops being true.
 *
 * That moment arrived with listLinkablePrizes: list_linkable_prizes (0051)
 * gates on `promotions.prizes`, not `promotions.view`, and a fixed "you do not
 * have permission to view promotions here" would tell a caller who holds
 * promotions.view — which is how the Prizes tab is open at all — that they
 * cannot view promotions, when what they actually lack is the narrower
 * capability to link stock. `what` exists for the same reason
 * describePromotionsWriteError's own `action` parameter does: a fixed message
 * was accurate only while every read on this surface was gated by the same
 * permission, and it no longer is. Defaults to the original wording, so every
 * call site that does not pass `what` reads exactly as it always did.
 */
export function describePromotionsReadError(cause: unknown, what: string = 'promotions here'): string {
  if (cause instanceof ConflictError) return cause.message;
  if (cause instanceof BusinessRuleError) return cause.message;
  if (cause instanceof NotFoundError) {
    return 'That could not be found. Refresh the page and try again.';
  }
  if (cause instanceof UnauthorizedError) {
    return `You do not have permission to view ${what}.`;
  }
  if (cause instanceof ValidationError) return cause.message;
  // Generic on purpose: InternalError means the fault is ours, not theirs, and
  // its message may carry a raw database error — not something to show.
  return 'Could not load promotions. Refresh the page and try again.';
}

/**
 * Same taxonomy, worded for a write. Each caller in actions.ts passes its own
 * `action` phrase — "register a promotion", "edit this promotion", "cancel
 * this promotion", "archive this promotion", "edit this quiz" — so a refusal
 * reads as "you cannot do THIS, here" rather than as a generic denial.
 * mapPromotionError only ever throws UnauthorizedError carrying the raw
 * Postgres text ("permission denied: promotions.X required"), which names a
 * permission code rather than the thing the person was trying to do, so that
 * message is rewritten here instead of passed through.
 *
 * ConflictError and ValidationError pass through verbatim, and both already
 * carry a complete sentence written by the RPC that raised them: the hashtag
 * clash names the hashtag and the period, the duplicate integration code names
 * the number, and every 22023 refusal — a missing cancellation reason, a
 * promotion already cancelled or already over, archiving one still accepting,
 * a quiz without exactly one right answer — says what is wrong in words the
 * operator can act on. Replacing those with something generic would throw away
 * the only part of the message that helps.
 */
export function describePromotionsWriteError(cause: unknown, action: string): string {
  if (cause instanceof ConflictError) return cause.message;
  if (cause instanceof ValidationError) return cause.message;
  if (cause instanceof BusinessRuleError) return cause.message;
  if (cause instanceof NotFoundError) {
    return 'That could not be found. Refresh the page and try again.';
  }
  if (cause instanceof UnauthorizedError) {
    return `You do not have permission to ${action}.`;
  }
  return 'Could not save. Refresh the page and try again.';
}
