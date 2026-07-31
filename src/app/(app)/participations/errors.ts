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
 * `what` names the thing that could not be read, and it is consumed by the
 * permission branch AND by the generic fallback. That second one is the whole
 * point rather than symmetry, and it is a deliberate departure from
 * describePromotionsReadError, which spends the argument only on the permission
 * branch.
 *
 * The reason is that on THIS screen the permission branch is the unreachable one
 * and the fallback is the live one, which is the opposite of what the argument
 * was originally introduced for. The promotion picker's read is
 * listPromotionsPage: every failure path inside it wraps in InternalError, and a
 * caller who may not read promotions is answered by RLS with an empty result
 * rather than a 42501, so it cannot raise UnauthorizedError at all. With `what`
 * spent only there, the single message that picker could ever show was "Could
 * not load the entries. Refresh the page and try again." — rendered beside a list
 * of entries that had loaded perfectly, which sends the operator to look at
 * exactly the wrong thing. Naming the subject in both branches is what makes the
 * paragraph above true of the behaviour rather than only of the intention.
 *
 * What the fallback still does NOT do is repeat the error: InternalError means
 * the fault is ours, not theirs, and its message may carry raw database text.
 * `what` names the subject, never the cause.
 */
export function describeParticipationsReadError(
  cause: unknown,
  what: string = 'the entries in this Station',
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
  return `Could not load ${what}. Refresh the page and try again.`;
}
