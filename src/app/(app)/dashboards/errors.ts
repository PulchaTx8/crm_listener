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
 * already refuses an unknown preset or an impossible/reversed date before a
 * request leaves the browser, so a 22023 that reaches here is a caller who
 * bypassed that (or, in principle, an empty Station list) — "that period is
 * not valid" is true of both without repeating a raw database sentence that
 * was never written with an operator in mind.
 */
export function describeDashboardError(cause: unknown): string {
  if (cause instanceof ValidationError) return 'That period is not valid.';
  if (cause instanceof UnauthorizedError) {
    return 'You do not have permission to see this dashboard in every station selected.';
  }
  return 'Could not load this dashboard. Refresh the page and try again.';
}
