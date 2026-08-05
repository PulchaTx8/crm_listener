// Kept synchronous and free of 'use server' (mirrors templates/errors.ts and
// music/errors.ts) so a Server Component — all three dashboard pages — can
// call describeDashboardError directly without an unnecessary await.
import { UnauthorizedError, ValidationError } from '@/lib/errors';

/**
 * Shared by all three dashboard screens, on the shape `templates/errors.ts`
 * gives its own two screens: one taxonomy for the block rather than three
 * copies of it drifting apart.
 *
 * Only two branches, because `services/dashboards.ts`'s own `mapDashboardError`
 * only ever constructs two kinds of `AppError` for these three read-only
 * RPCs — no `NotFoundError`, no `ConflictError`, nothing to construct one
 * for. `ValidationError`'s sentence is fixed rather than passed through
 * verbatim the way `templates/errors.ts` forwards its own: `parsePeriod`
 * refuses an unknown preset, an impossible date and a range that does not
 * open before it closes, all before a request leaves the browser, so a 22023
 * that reaches here is a caller who bypassed that (or, in principle, an empty
 * Station list) — "that period is not valid" is true of both without
 * repeating a raw database sentence that was never written with an operator
 * in mind.
 *
 * THAT CLAIM WAS FALSE FOR ONE INPUT until the whole-branch review (Important
 * B3), and it is worth recording which: `parsePeriod` tested `from > to` while
 * 0117 refuses `p_to <= p_from`, so a `from` equal to `to` — the URL an
 * operator produces by picking the same date twice — passed this layer and
 * threw at the database, replacing the entire page with the sentence below. A
 * comment asserting a case cannot happen is the comment that stops anyone
 * checking whether it can.
 */
export function describeDashboardError(cause: unknown): string {
  if (cause instanceof ValidationError) return 'That period is not valid.';
  if (cause instanceof UnauthorizedError) {
    return 'You do not have permission to see this dashboard in every station selected.';
  }
  return 'Could not load this dashboard. Refresh the page and try again.';
}
