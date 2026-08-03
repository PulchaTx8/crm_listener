// Split out the same way pickups/errors.ts, participations/errors.ts,
// promotions/errors.ts, inventory/errors.ts and members/errors.ts all are: a
// plain function a Server Component can call directly with no await, kept out
// of any 'use server' actions file (this screen has none: it has no write
// side, see movements-grid.tsx's own header) so it stays a synchronous string
// mapper.
import {
  BusinessRuleError,
  ConflictError,
  NotFoundError,
  UnauthorizedError,
  ValidationError,
} from '@/lib/errors';

/**
 * The reads this screen performs — listMovements, listCompanyAccess,
 * listPrizesPage and listPromotionsPage for the prize and promotion pickers —
 * throw the same taxonomy every list screen in this codebase maps for its own
 * reads (pickups/errors.ts, inventory/errors.ts). listMovements
 * (services/movements.ts) itself only ever raises UnauthorizedError (42501,
 * inventory.view) or InternalError — it has no write side and no sibling RPC
 * to share a fuller mapper with, the same as services/movements.ts's own
 * mapMovementError — but the other two reads on this screen can raise the
 * rest of the taxonomy, so the full set is handled here rather than narrowed
 * to what listMovements alone can produce.
 *
 * `what` names the thing that could not be read, spent in both the
 * permission branch and the generic fallback for the same reason
 * describePickupsReadError's own parameter carries one: the prize and
 * promotion pickers' own reads can never themselves raise UnauthorizedError —
 * a caller who may not read them is answered by RLS with an empty result
 * rather than a 42501 — so naming the subject only in the permission branch
 * would leave that caller with one generic message ("Could not load the
 * movements...") rendered beside a ledger that loaded fine.
 */
export function describeMovementsReadError(
  cause: unknown,
  what: string = 'the movements at this Station',
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
  // Generic on purpose: InternalError means the fault is ours, not theirs,
  // and its message may carry a raw database error — not something to show.
  return `Could not load ${what}. Refresh the page and try again.`;
}
