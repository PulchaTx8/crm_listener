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

export interface InventoryPermissions {
  catalogue: boolean;
  entry: boolean;
  exit: boolean;
  adjust: boolean;
  reserve: boolean;
}

const MOVEMENT_PERMISSION_CODES = [
  'inventory.catalogue',
  'inventory.entry',
  'inventory.exit',
  'inventory.adjust',
  'inventory.reserve',
] as const;

/**
 * Which of the five write permissions the caller holds in this one Station —
 * a courtesy gate for which of Task 9's forms get rendered at all, the exact
 * same shape listViewableCompanies uses for inventory.view: has_permission
 * asked once per code, never the boundary itself. Every RPC these forms call
 * (record_stock_entry, record_stock_exit, adjust_stock, reserve_stock,
 * release_reservation, create_prize_category, create_prize) re-checks its own
 * permission with the same function before writing anything (0027), so a
 * stale render — a permission revoked after this page loaded but before a
 * form still sitting in an open tab is submitted — is still refused where it
 * actually matters, not merely hidden here.
 *
 * A failed has_permission call throws rather than being folded into "not
 * granted", the same reasoning listViewableCompanies gives for its own check:
 * collapsing a transient RPC failure into "no access" would silently hide
 * every form from someone who does hold the permission.
 */
export async function getInventoryPermissions(
  supabase: UserClient,
  companyId: string,
): Promise<InventoryPermissions> {
  const results = await Promise.all(
    MOVEMENT_PERMISSION_CODES.map((code) =>
      supabase.rpc('has_permission', { p_permission: code, p_company_id: companyId }),
    ),
  );

  results.forEach((result, i) => {
    if (result.error) {
      throw new InternalError(
        `Could not check ${MOVEMENT_PERMISSION_CODES[i]} access for this station: ${result.error.message}`,
      );
    }
  });

  // Index access under noUncheckedIndexedAccess types each element as
  // `boolean | undefined` even though results.length is always exactly 5
  // (one per MOVEMENT_PERMISSION_CODES entry, mapped 1:1 above) — the `??
  // false` is satisfying the compiler about a case that cannot actually
  // occur, not a real fallback.
  const flags = results.map((r) => r.data === true);
  return {
    catalogue: flags[0] ?? false,
    entry: flags[1] ?? false,
    exit: flags[2] ?? false,
    adjust: flags[3] ?? false,
    reserve: flags[4] ?? false,
  };
}
