// Split out the same way participations/errors.ts, promotions/errors.ts,
// inventory/errors.ts and members/errors.ts all are: a plain function a
// Server Component can call directly with no await, kept out of the 'use
// server' actions.ts so it stays a synchronous string mapper rather than
// being forced async by that directive's "every EXPORTED binding must be an
// async function" rule. (team/actions.ts shows the other legal shape —
// describeTeamError lives inside a 'use server' file because it is never
// exported — but this screen's describer is needed by page.tsx too, which
// that shape cannot reach.)
//
// Not in Task 9's brief's own file list, which was written before this
// screen's actual shape was settled; every sibling list screen carries this
// exact module for the reason above, so this is the established pattern
// rather than scope creep.
import {
  BusinessRuleError,
  ConflictError,
  NotFoundError,
  UnauthorizedError,
  ValidationError,
} from '@/lib/errors';

/**
 * The reads this screen performs — listPickups, listCompanyAccess,
 * listPromotionsPage for the promotion filter, has_permission — throw the same
 * taxonomy participations/errors.ts describes for its own reads, over the
 * same reasoning: collapsing it to one generic message works until a read on
 * this surface starts going through a gated call other than the plain
 * permission check, and then it silently stops being true.
 *
 * `what` names the thing that could not be read, spent in both the
 * permission branch and the generic fallback for the same reason
 * describeParticipationsReadError gives for its own promotion-picker caller:
 * the promotion filter's own read (listPromotionsPage) can never itself raise
 * UnauthorizedError — a caller who may not read promotions is answered by RLS
 * with an empty result rather than a 42501 — so naming the subject only in
 * the permission branch would leave that caller with one message ("Could not
 * load the pickups...") rendered beside a list of pickups that loaded fine.
 */
export function describePickupsReadError(
  cause: unknown,
  what: string = 'the pickups at this Station',
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
 * The same taxonomy worded for a write, the shape describeParticipationsWriteError
 * and describePromotionsWriteError both carry: each caller passes what it was
 * trying to do, so a refusal reads as "you cannot do THIS" rather than as a
 * permission code.
 *
 * NotFoundError covers P0002 from deliver_prize, cancel_delivery, return_prize
 * and write_off_prize (0084/0085) — each raises it for an unknown winner id
 * before checking the permission, the existence-leak design spec §7.2 records
 * as inherited and unfixed. reopen_pickup_deadline (0093) never raises it at
 * all — an unknown id there answers 42501 instead, on purpose, so it does not
 * extend that leak — but the branch still has to exist for its four siblings.
 */
export function describePickupsWriteError(cause: unknown, action: string): string {
  if (cause instanceof ConflictError) return cause.message;
  if (cause instanceof ValidationError) return cause.message;
  if (cause instanceof BusinessRuleError) return cause.message;
  if (cause instanceof NotFoundError) {
    return 'This prize could not be found. Refresh the page and try again.';
  }
  if (cause instanceof UnauthorizedError) {
    return `You do not have permission to ${action}.`;
  }
  return 'Could not save. Refresh the page and try again.';
}
