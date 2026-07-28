// Split out the same way inventory/errors.ts's describeInventoryReadError is:
// a plain function a Server Component can call directly with no await, kept
// out of a 'use server' actions.ts (Task 9's, not this one) so it stays a
// synchronous string mapper rather than being forced async by that
// directive's own "every export must be an async function" rule.
import {
  BusinessRuleError,
  ConflictError,
  NotFoundError,
  UnauthorizedError,
  ValidationError,
} from '@/lib/errors';

/**
 * Every read the two Task 8 screens perform — listOrganizationMembers,
 * getMember, listMemberConsents, listMemberNotes, listMemberBlocks,
 * listMemberStations, canViewAudience — reads a table or calls
 * is_member_blocked/has_org_permission, neither of which raises anything
 * beyond InternalError today: is_member_blocked and has_org_permission are
 * plain boolean predicates with no permission gate of their own to refuse,
 * and a `.from(...)` select either returns rows (possibly zero, which is not
 * an error) or a genuine database fault. The full taxonomy is mapped anyway,
 * the same reasoning describeInventoryReadError (inventory/errors.ts) gives
 * for its own read-only callers: collapsing it to one generic message would
 * work today and silently stop being true the moment a read on this surface
 * starts going through a gated RPC, which Task 9's forms will add nearby.
 */
export function describeMembersReadError(cause: unknown): string {
  if (cause instanceof ConflictError) return cause.message;
  if (cause instanceof BusinessRuleError) return cause.message;
  if (cause instanceof NotFoundError) {
    return 'That could not be found. Refresh the page and try again.';
  }
  if (cause instanceof UnauthorizedError) {
    return 'You do not have permission to view the audience here.';
  }
  if (cause instanceof ValidationError) return cause.message;
  // Generic on purpose: InternalError means the fault is ours, not theirs,
  // and its message may carry a raw database error — not something to show.
  return 'Could not load the audience. Refresh the page and try again.';
}

/**
 * Same taxonomy as describeMembersReadError, worded for a write instead of a
 * page load (Task 9's forms) — the same shape describeInventoryWriteError
 * (inventory/errors.ts) gives its own six mutating actions. Each caller in
 * actions.ts passes its own `action` phrase — "register a listener", "record
 * this consent", "block this listener", "lift this block", "erase this
 * listener's personal data", "link this listener to this Station" — so a 403
 * reads as "you cannot do THIS, here" rather than a generic refusal.
 * mapMemberError (services/members.ts) itself only ever throws
 * UnauthorizedError with the raw Postgres text ("permission denied:
 * members.X required") — it names the permission code, not the action in the
 * person's own words, so that message is rewritten here rather than passed
 * through.
 *
 * ConflictError already carries a complete, specific sentence from
 * mapMemberError's own mapping (23505) — a duplicate phone/e-mail/CPF/
 * passport from create_member/update_member, or "this listener is already
 * linked to that station" from link_member_to_company — and passes through
 * verbatim, the same reasoning describeInventoryWriteError's own doc comment
 * gives for not replacing those with something generic. **"A block already
 * lifted" is NOT one of these examples**, despite an earlier draft of this
 * comment naming it here (Task 9 review, Important 3): lift_member_block
 * raises that case as P0002 ("block not found, or already lifted",
 * 0034:652), which mapMemberError maps to NotFoundError, not
 * ConflictError/BusinessRuleError — it is rewritten to the generic "That
 * could not be found" two lines below, not passed through. BusinessRuleError
 * (23503) has no live example to cite at all yet: mapMemberError's own
 * comment on that code says none of 0033/0034's RAISE statements currently
 * use it — it is mapped defensively, for a foreign key that does not yet
 * exist.
 */
export function describeMembersWriteError(cause: unknown, action: string): string {
  if (cause instanceof ConflictError) return cause.message;
  if (cause instanceof BusinessRuleError) return cause.message;
  if (cause instanceof NotFoundError) {
    return 'That could not be found. Refresh the page and try again.';
  }
  if (cause instanceof UnauthorizedError) {
    return `You do not have permission to ${action}.`;
  }
  if (cause instanceof ValidationError) return cause.message;
  // Generic on purpose: InternalError means the fault is ours, not theirs,
  // and its message may carry a raw database error — not something to show.
  return 'Could not save. Refresh the page and try again.';
}
