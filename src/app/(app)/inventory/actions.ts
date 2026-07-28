// No 'use server' directive: Task 8 has no mutations of its own, only reads,
// and a "use server" file may only export async functions — describeReadError
// below is synchronous. Task 9's movement forms and reconciliation view will
// add real Server Actions to this file; when they do, this directive arrives
// with them, and this helper will need to either become async or move out of
// the actions file entirely, whichever Task 9 finds does not disturb the
// forms' own error handling.
import {
  BusinessRuleError,
  ConflictError,
  NotFoundError,
  UnauthorizedError,
  ValidationError,
} from '@/lib/errors';

/**
 * Every read the two Task 8 screens perform — listViewableCompanies,
 * listPrizeCategories, listPrizes, getPrizeMovements — only ever throws
 * InternalError: none of them call an RPC, so none of the write-side codes
 * mapInventoryError (services/inventory.ts) maps can surface here today. The
 * full taxonomy is handled anyway, the same reasoning roles/actions.ts's
 * describeRoleError gives for its own two callers: collapsing it to a single
 * generic message would work today and silently stop being true the moment a
 * read starts going through an RPC (reconcile_inventory is exactly that, and
 * arrives in Task 9).
 */
export function describeInventoryReadError(cause: unknown): string {
  if (cause instanceof ConflictError) return cause.message;
  if (cause instanceof BusinessRuleError) return cause.message;
  if (cause instanceof NotFoundError) {
    return 'That could not be found. Refresh the page and try again.';
  }
  if (cause instanceof UnauthorizedError) {
    return 'You do not have permission to view inventory in this Station.';
  }
  if (cause instanceof ValidationError) return cause.message;
  // Generic on purpose: InternalError means the fault is ours, not theirs,
  // and its message may carry a raw database error — not something to show.
  return 'Could not load the inventory. Refresh the page and try again.';
}
