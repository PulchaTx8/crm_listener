import 'server-only';
import { InternalError } from '@/lib/errors';
import type { UserClient } from '@/lib/supabase/user-client';
import type { WinnerPowers } from '@/components/draws/winner-actions';

/**
 * Whether this caller may search the pickups list by listener at this one
 * Station — the exact same asymmetry participations/access.ts's own
 * canSearchByListener documents, and the same permission: list_pickups'
 * Rule 3 (0095) returns nothing at all to a search from a caller who lacks
 * members.view, because searching a field you may not read is an oracle. A
 * courtesy gate for what the filter bar renders, never the boundary — 0095
 * asks the same question again on every call.
 *
 * A failed check throws rather than being folded into "not granted", the
 * same reasoning canSearchByListener gives: collapsing a transient RPC
 * failure into "no access" would silently take the search box away from
 * somebody who does hold the permission.
 */
export async function canSearchPickupsByListener(
  supabase: UserClient,
  companyId: string,
): Promise<boolean> {
  const { data, error } = await supabase.rpc('has_permission', {
    p_permission: 'members.view',
    p_company_id: companyId,
  });
  if (error) {
    throw new InternalError(
      `Could not check whether this caller may search by listener: ${error.message}`,
    );
  }
  return data === true;
}

const WINNER_PERMISSION_CODES = [
  'winners.deliver',
  'winners.deliver_cancel',
  'winners.return',
  'winners.write_off',
  'winners.reopen_deadline',
] as const;

/**
 * Which of the five winner-transition permissions this caller holds at this
 * one Station — the same five WinnerPowers names, resolved once per render
 * rather than once per row: every winner on this screen belongs to the same
 * Station (the whole point of a pickups list spanning every promotion of
 * it), so the answer is identical for every row and asking it per row would
 * be `n` round trips for one fact.
 *
 * A courtesy gate for which buttons render, never the boundary: deliver_prize,
 * cancel_delivery, return_prize, write_off_prize (0084/0085) and
 * reopen_pickup_deadline (0093) each re-check their own permission before
 * writing anything, so a permission revoked after this page rendered is
 * still refused where it matters.
 *
 * A failed has_permission call throws rather than being folded into "not
 * granted", the same reasoning getPromotionPowers and getInventoryPermissions
 * both give.
 */
export async function getWinnerPowers(
  supabase: UserClient,
  companyId: string,
): Promise<WinnerPowers> {
  const results = await Promise.all(
    WINNER_PERMISSION_CODES.map((code) =>
      supabase.rpc('has_permission', { p_permission: code, p_company_id: companyId }),
    ),
  );

  results.forEach((result, i) => {
    if (result.error) {
      throw new InternalError(
        `Could not check ${WINNER_PERMISSION_CODES[i]} access for this station: ${result.error.message}`,
      );
    }
  });

  const flags = results.map((r) => r.data === true);
  return {
    deliver: flags[0] ?? false,
    deliverCancel: flags[1] ?? false,
    return: flags[2] ?? false,
    writeOff: flags[3] ?? false,
    reopenDeadline: flags[4] ?? false,
  };
}
