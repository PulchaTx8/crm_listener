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
 * listCompanyAccess, has_permission — are selects and one plain boolean
 * predicate, so in practice only InternalError is reachable today. The full
 * taxonomy is mapped anyway, for the reason describeInventoryReadError gives
 * for its own read-only callers: collapsing it to one generic message works
 * until a read on this surface starts going through a gated call, and then it
 * silently stops being true.
 */
export function describePromotionsReadError(cause: unknown): string {
  if (cause instanceof ConflictError) return cause.message;
  if (cause instanceof BusinessRuleError) return cause.message;
  if (cause instanceof NotFoundError) {
    return 'That could not be found. Refresh the page and try again.';
  }
  if (cause instanceof UnauthorizedError) {
    return 'You do not have permission to view promotions here.';
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
