// Kept synchronous and free of 'use server' (mirrors music/errors.ts) so a
// Server Component — both screens in this block — can call
// describeTemplateReadError directly without an unnecessary await.
import {
  ConflictError,
  NotFoundError,
  UnauthorizedError,
  ValidationError,
} from '@/lib/errors';

/**
 * Shared by both Templates screens, which is why this sits at `templates/` and
 * not under either one — one taxonomy for the block rather than two copies
 * drifting apart, the same reasoning music/errors.ts gives for its own.
 *
 * There is no `BusinessRuleError` branch here, and that is not an omission:
 * mapTemplateError (services/templates.ts) never constructs one. Nothing in
 * this block refuses a write because of what else exists — an override
 * replaces a default, and archiving a registry row leaves nothing pointing at
 * it, so the "still used by other rows" case music has simply has no analogue.
 */
export function describeTemplateReadError(cause: unknown): string {
  if (cause instanceof ConflictError) return cause.message;
  if (cause instanceof ValidationError) return cause.message;
  if (cause instanceof NotFoundError) {
    return 'That could not be found. Refresh the page and try again.';
  }
  if (cause instanceof UnauthorizedError) {
    return 'You do not have permission to view the message templates in this Station.';
  }
  // Generic on purpose: InternalError means the fault is ours, not theirs, and
  // its message may carry a raw database error — not something to show.
  return 'Could not load the templates. Refresh the page and try again.';
}

/**
 * The same taxonomy, worded for a write. Each action passes its own `action`
 * phrase — "change this text", "register a template", "remove this template" —
 * so a 403 reads as "you cannot do THIS, here" rather than a generic refusal.
 *
 * The `UnauthorizedError` rewrite is the load-bearing one: mapTemplateError
 * passes the raw Postgres text through ("permission denied: templates.manage
 * required"), which names a permission code rather than the thing the operator
 * was trying to do. And by 0093's rule — which all four doors follow — that
 * same 42501 is also what an unknown id and an unreachable Station answer, so
 * this sentence has to be true of all three at once. "You do not have
 * permission to X in this Station" is: for the caller, those three cases are
 * one fact.
 *
 * `ValidationError` passes through verbatim. schemas/templates.ts catches all
 * of these before a request leaves the browser, so a 22023 that arrives here
 * came from a caller who bypassed the form — and the database's own sentence
 * ("template expects 2 variable(s), got 3") is more specific than anything
 * this function could invent.
 */
export function describeTemplateWriteError(cause: unknown, action: string): string {
  if (cause instanceof ConflictError) return cause.message;
  if (cause instanceof ValidationError) return cause.message;
  if (cause instanceof NotFoundError) {
    return 'That could not be found. Refresh the page and try again.';
  }
  if (cause instanceof UnauthorizedError) {
    return `You do not have permission to ${action} in this Station.`;
  }
  return 'Could not save. Refresh the page and try again.';
}

/**
 * Clearing an override has its own describer for one branch only.
 *
 * `clear_station_message_template` (0113) raises `P0002` when the text has no
 * override to remove, and describeTemplateWriteError's "refresh the page and
 * try again" is wrong advice for that: nothing failed and nothing needs
 * retrying — the text is already at the system default, which is where the
 * operator was trying to put it. Reached when two people clear the same text
 * at once, or when a page has been open long enough for somebody else to have
 * done it. Separate for the same reason describeMergeError (music/errors.ts)
 * is separate from its own block's write describer.
 */
export function describeClearMessageError(cause: unknown): string {
  if (cause instanceof NotFoundError) {
    return 'That text is already the system default — somebody else may have cleared it. Refresh the page.';
  }
  return describeTemplateWriteError(cause, 'change the message templates');
}
