import 'server-only';
import { InternalError } from '@/lib/errors';
import type { UserClient } from '@/lib/supabase/user-client';

/**
 * Whether this caller may search the list by listener at this one Station.
 *
 * The question is `members.view`, not any participations code, and that is the
 * asymmetry this screen exists to be honest about. Plain listing needs
 * `participations.view` alone: listParticipationsPage's default select embeds
 * the listener as an outer join, so a caller without `members.view` still gets
 * every row with the name left null. A SEARCH swaps that select for one whose
 * two embeds are `!inner`, because a search has to be a condition Postgres
 * evaluates rather than a filter over a page that has already been fetched —
 * and member_company_links and members are behind 0035's policies, which need
 * `members.view` at the Station. Both halves are pinned by the second case in
 * tests/isolation/participations.test.ts, over one fixture with the permission
 * the only difference between the two callers.
 *
 * So a caller who lacks it and searches gets nothing back, and an empty list is
 * indistinguishable from "no listener matched". The screen therefore has to ask
 * this question BEFORE it sends a term, which is the only reason this function
 * exists.
 *
 * `has_permission` and not `has_org_permission`: `members.view` is catalogued
 * with company scope (0031:141) and member_company_links_select_reachable
 * (0035:111) checks it against the link row's own `company_id` — which for
 * every row on this screen is the Station being viewed.
 *
 * A courtesy gate for what the filter bar renders, never the boundary: 0035's
 * policies decide the same question again on every row underneath, so a
 * permission revoked after this page rendered still empties a search that was
 * already on screen — it is refused where it matters, not merely hidden here.
 *
 * A failed check throws rather than being folded into "not granted", the same
 * reasoning getPromotionPowers and getInventoryPermissions both give: collapsing
 * a transient RPC failure into "no access" would silently take the search box
 * away from somebody who does hold the permission, and they would have no way
 * to tell that from having lost it.
 */
export async function canSearchByListener(
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

/**
 * Whether this caller may run a draw at this one Station — Block 6c, because the
 * Draw button lives on this screen now.
 *
 * One `has_permission` and not `getPromotionPowers`, which asks sixteen: this
 * screen needs exactly one of them, and borrowing that helper would put fifteen
 * more round trips on every render of a list that never opens a promotion
 * record.
 *
 * A courtesy gate for whether the button renders, never the boundary —
 * `run_draw` (0078) re-checks `draws.execute` inside its own SECURITY DEFINER
 * body — and a failed check throws rather than folding into "not granted", for
 * the reason canSearchByListener gives just above.
 */
export async function canRunDraw(supabase: UserClient, companyId: string): Promise<boolean> {
  const { data, error } = await supabase.rpc('has_permission', {
    p_permission: 'draws.execute',
    p_company_id: companyId,
  });
  if (error) {
    throw new InternalError(
      `Could not check whether this caller may run a draw here: ${error.message}`,
    );
  }
  return data === true;
}
