// Split out the same way promotions/errors.ts, inventory/errors.ts and
// members/errors.ts are: a plain function a Server Component can call directly
// with no await, kept out of a 'use server' actions.ts so it stays a
// synchronous string mapper rather than being forced async by that directive's
// "every export must be an async function" rule.
import {
  BusinessRuleError,
  ConflictError,
  NotFoundError,
  UnauthorizedError,
  ValidationError,
} from '@/lib/errors';

/**
 * The reads this screen performs — listParticipationsPage, listPromotionsPage
 * for the promotion filter, listCompanyAccess, has_permission — are selects and
 * one plain boolean predicate, so in practice InternalError and ValidationError
 * are the two that are reachable today. The full taxonomy is mapped anyway, for
 * the reason describePromotionsReadError gives for its own read-only callers:
 * collapsing it to one generic message works until a read on this surface starts
 * going through a gated call, and then it silently stops being true. On the
 * promotions screen that moment arrived with list_linkable_prizes.
 *
 * ValidationError is the one that is live rather than forward-looking, and it is
 * worth naming: mapParticipationError routes 22P02 there, and decodeCursor
 * accepts any non-empty string as a cursor's id, so a hand-edited `?after=`
 * reaches Postgres as `id.lt."abc"` and comes back with that code. Passing the
 * message through rather than replacing it is right — it is the caller's value
 * that is wrong, not the request and not the server.
 *
 * `what` mirrors describePromotionsReadError's own parameter and defaults to the
 * original wording, so a call site that does not pass one reads exactly as this
 * screen's other reads do. The promotion filter passes its own phrase, because
 * that read is gated by `promotions.view` and this screen is reached with
 * `participations.view` — telling somebody they cannot view participations when
 * what they actually lack is the ability to name a promotion sends them to fix
 * the wrong thing.
 */
export function describeParticipationsReadError(
  cause: unknown,
  what: string = 'participations here',
): string {
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
  return 'Could not load the entries. Refresh the page and try again.';
}
