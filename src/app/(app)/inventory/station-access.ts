import 'server-only';
import { InternalError } from '@/lib/errors';
import type { UserClient } from '@/lib/supabase/user-client';

export interface ViewableCompany {
  id: string;
  name: string;
}

/**
 * Every Company (Station) the signed-in caller holds inventory.view in — not
 * every Company they merely belong to. companies_select_org_member (0021)
 * already scopes a direct `companies` read to the caller's own memberships,
 * the Organization they own, or platform-admin status; but belonging to a
 * Station says nothing about which permission the role assigned there
 * carries. A colleague holding only, say, inventory.entry in a Station is a
 * member of it and a bare membership check would make it look able to view
 * that Station's inventory too.
 *
 * has_permission (0024) — the same SECURITY DEFINER function every inventory
 * RPC in 0027/0028 re-checks against auth.uid() in its own body — is asked
 * once per Company here. This is what lets the two inventory screens decide
 * what to show and redirect politely; it is not the boundary itself, which is
 * RLS on prizes/inventory_balances/inventory_movements (0029) and the RPCs'
 * own checks.
 *
 * A failed has_permission call is not the same fact as "not granted" and must
 * not collapse into it: doing so would make a transient RPC failure look
 * identical to a caller with no access anywhere, which the page would then
 * render as "no Station" — indistinguishable from the genuinely-empty case
 * this whole block exists to avoid. So it throws instead of swallowing.
 */
export async function listViewableCompanies(supabase: UserClient): Promise<ViewableCompany[]> {
  const { data: companies, error } = await supabase
    .from('companies')
    .select('id, name')
    .is('deleted_at', null)
    .order('name');

  if (error) throw new InternalError(`Could not read stations: ${error.message}`);

  const checked = await Promise.all(
    (companies ?? []).map(async (company) => {
      const { data: allowed, error: permError } = await supabase.rpc('has_permission', {
        p_permission: 'inventory.view',
        p_company_id: company.id,
      });
      if (permError) {
        throw new InternalError(
          `Could not check inventory access for a station: ${permError.message}`,
        );
      }
      return allowed === true ? company : null;
    }),
  );

  return checked.filter((c): c is ViewableCompany => c !== null);
}
