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

/**
 * The same taxonomy worded for a write, in the shape describePromotionsWriteError
 * and describeMembersWriteError both carry: each caller passes what it was
 * trying to do, so a refusal reads as "you cannot do THIS" rather than as a
 * permission code.
 *
 * NotFoundError is the one branch that is genuinely different here, and it is
 * different because P0002 on this surface has a meaning the other screens' does
 * not. apply_participation (0054) raises it for a listener the promotion's
 * Station is not linked to, alongside the ordinary stale-promotion case — and
 * that first one is reachable through the front door: resolve_or_create_member
 * searches the whole ORGANIZATION through find_member_by_identifier (0033), so
 * a listener registered at a sister Station resolves perfectly and then cannot
 * be entered here. "That could not be found. Refresh the page and try again."
 * would send an operator to reload a screen that is not stale, over and over,
 * for a promotion and a listener that both plainly exist. The sentence names
 * both possibilities instead, because from this layer the code alone cannot
 * tell them apart, and names the one thing that fixes the live half.
 *
 * ConflictError carries two very different messages and passes both through.
 * create_member's 23505 is already a sentence naming which identifier collided.
 * participations_one_per_member's is Postgres's own, naming an index — ugly, and
 * still better than a generic replacement, because it appears only when the
 * advisory lock did not serialise two simultaneous entries and the operator's
 * next action is to look at what actually got written rather than to retry.
 */
export function describeParticipationsWriteError(cause: unknown, action: string): string {
  if (cause instanceof ConflictError) return cause.message;
  if (cause instanceof ValidationError) return cause.message;
  if (cause instanceof BusinessRuleError) return cause.message;
  if (cause instanceof NotFoundError) {
    return 'The promotion or the listener is no longer reachable from this Station. A listener registered at another Station of this Organization has to be linked to this one before an entry can be recorded for them.';
  }
  if (cause instanceof UnauthorizedError) {
    return `You do not have permission to ${action}.`;
  }
  return 'Could not save. Refresh the page and try again.';
}
