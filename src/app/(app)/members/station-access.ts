import 'server-only';
import { InternalError } from '@/lib/errors';
import type { UserClient } from '@/lib/supabase/user-client';

export interface RegistrableStation {
  id: string;
  name: string;
}

// Same bound inventory/station-access.ts's COMPANY_SCAN_CAP gives for its own
// scan, for the same reason: a platform admin's read of `companies` is not
// filtered to one Organization (companies_select_org_member, 0021), so it is
// unbounded in the platform's total Company count unless capped here.
const STATION_SCAN_CAP = 50;

/**
 * Every live Station the caller holds `permission` in, bounded rather than
 * O(N) in the platform's total Station count — the same shape and the same
 * reasoning as inventory/station-access.ts's own listCompanyAccess, generalised
 * over the permission code instead of hard-coding inventory.view: a platform
 * admin's active Stations are resolved with no per-Station RPC at all
 * (has_permission's own body is `has_company_access(...) AND
 * (is_platform_admin() OR owner OR a role grant)`, so is_platform_admin()
 * alone already satisfies the second half for an active Station); everyone
 * else pays one has_permission round trip per visible, active Station.
 *
 * Used here for the registration form's Station picker (`members.create`) —
 * the one place this block's screens need "which Stations can I do X in"
 * answered for a permission other than inventory.view, so the existing
 * inventory-only helper is generalised here rather than hand-copied a second
 * time with a different hard-coded permission string.
 *
 * A failed read or permission check throws rather than returning an empty
 * list — the same convention listCompanyAccess follows, so a caller that
 * wants to distinguish "genuinely no Station grants this permission" from "the
 * check itself failed" can. The one caller today (members/page.tsx) chooses
 * to catch it and degrade to an empty list rather than fail the whole
 * audience screen over a courtesy registration card — a deliberate, narrower
 * choice made at that call site, not a property of this function.
 */
export async function listStationsWithPermission(
  supabase: UserClient,
  permission: string,
): Promise<{ stations: RegistrableStation[]; capped: boolean }> {
  const { data: companies, error } = await supabase
    .from('companies')
    .select('id, name, status')
    .is('deleted_at', null)
    .order('name')
    .limit(STATION_SCAN_CAP + 1);
  if (error) throw new InternalError(`Could not read stations: ${error.message}`);

  const rows = companies ?? [];
  const capped = rows.length > STATION_SCAN_CAP;
  const scanned = capped ? rows.slice(0, STATION_SCAN_CAP) : rows;
  const active = scanned.filter((c) => c.status === 'active');

  const { data: isAdmin, error: adminError } = await supabase.rpc('is_platform_admin');
  if (adminError) {
    throw new InternalError(`Could not check platform-admin status: ${adminError.message}`);
  }

  if (isAdmin === true) {
    return { stations: active.map((c) => ({ id: c.id, name: c.name })), capped };
  }

  const checked = await Promise.all(
    active.map(async (company) => {
      const { data: allowed, error: permError } = await supabase.rpc('has_permission', {
        p_permission: permission,
        p_company_id: company.id,
      });
      if (permError) {
        throw new InternalError(
          `Could not check ${permission} access for a station: ${permError.message}`,
        );
      }
      return allowed === true ? { id: company.id, name: company.name } : null;
    }),
  );

  return {
    stations: checked.filter((c): c is RegistrableStation => c !== null),
    capped,
  };
}
