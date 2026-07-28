import 'server-only';
import { InternalError } from '@/lib/errors';
import type { UserClient } from '@/lib/supabase/user-client';

export interface ViewableCompany {
  id: string;
  name: string;
}

/**
 * A Company visible under the Company read policy (the caller belongs to it,
 * owns it, or is a platform admin) but suspended, so has_permission always
 * returns false for it (has_company_access requires status = 'active'
 * unconditionally, even for a platform admin — 0016). Without surfacing this
 * separately it simply vanishes from the switcher with no explanation — the
 * same defect /app's own page already guards against for its Station cards.
 */
export interface SuspendedCompany {
  id: string;
  name: string;
}

export interface CompanyAccess {
  /** Every Company the caller currently holds inventory.view in. */
  viewable: ViewableCompany[];
  /** Visible but suspended — rendered with the reason, never selectable. */
  suspended: SuspendedCompany[];
  /**
   * True when the Company read below was capped rather than exhaustive (see
   * COMPANY_SCAN_CAP). The caller may hold inventory.view in a Company that
   * did not make the cut — the UI must say so, not act as if the list were
   * complete.
   */
  capped: boolean;
}

// A platform admin's `companies` read (companies_select_org_member, 0021) is
// every Company on the platform, not just their own — unbounded in the
// platform's total Company count, which nothing in this block controls.
// Capping the read itself, rather than only the has_permission fan-out below,
// is what actually bounds the cost end to end: without this, an admin with
// thousands of Companies would still pull every row before any filtering
// happened. Ordered by name, so which Companies get cut is at least stable
// and alphabetical rather than arbitrary.
const COMPANY_SCAN_CAP = 50;

/**
 * Resolves which Companies (Stations) the signed-in caller can reach for
 * inventory purposes, bounded rather than O(N) in the platform's total
 * Company count.
 *
 * Two things kept this unbounded before: every visible Company got its own
 * `has_permission` round trip regardless of status, and the read itself had
 * no limit — for a platform admin, "visible" is every Company on the
 * platform. Both are addressed here: a suspended Company is never asked
 * about (has_company_access always refuses it, so the answer is already
 * known from the status column alone), and a platform admin's active
 * Companies are resolved without any per-Company RPC at all — has_permission's
 * own body is `has_company_access(...) AND (is_platform_admin() OR owner OR a
 * role grant)`, so for an active Company `is_platform_admin()` alone already
 * satisfies the second half. An owner or an ordinary delegate's own visible
 * Company list is bounded by their own memberships already, so the
 * per-Company check below costs them nothing extra — it only skips for the
 * one caller whose Company count is genuinely unbounded.
 *
 * A failed read or permission check throws rather than being folded into "no
 * access" — see the reasoning this file's functions have always carried:
 * collapsing a transient RPC failure into "not granted" would make it
 * indistinguishable from the genuinely-empty case this whole block exists to
 * avoid.
 */
export async function listCompanyAccess(supabase: UserClient): Promise<CompanyAccess> {
  const { data: companies, error } = await supabase
    .from('companies')
    .select('id, name, status')
    .is('deleted_at', null)
    .order('name')
    .limit(COMPANY_SCAN_CAP + 1);

  if (error) throw new InternalError(`Could not read stations: ${error.message}`);

  const rows = companies ?? [];
  const capped = rows.length > COMPANY_SCAN_CAP;
  const scanned = capped ? rows.slice(0, COMPANY_SCAN_CAP) : rows;

  const suspended = scanned
    .filter((c) => c.status === 'suspended')
    .map((c) => ({ id: c.id, name: c.name }));

  const active = scanned.filter((c) => c.status === 'active');

  const { data: isAdmin, error: adminError } = await supabase.rpc('is_platform_admin');
  if (adminError) {
    throw new InternalError(`Could not check platform-admin status: ${adminError.message}`);
  }

  if (isAdmin === true) {
    return {
      viewable: active.map((c) => ({ id: c.id, name: c.name })),
      suspended,
      capped,
    };
  }

  const checked = await Promise.all(
    active.map(async (company) => {
      const { data: allowed, error: permError } = await supabase.rpc('has_permission', {
        p_permission: 'inventory.view',
        p_company_id: company.id,
      });
      if (permError) {
        throw new InternalError(
          `Could not check inventory access for a station: ${permError.message}`,
        );
      }
      return allowed === true ? { id: company.id, name: company.name } : null;
    }),
  );

  return {
    viewable: checked.filter((c): c is ViewableCompany => c !== null),
    suspended,
    capped,
  };
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
 * same shape listCompanyAccess uses for inventory.view: has_permission asked
 * once per code, never the boundary itself. Every RPC these forms call
 * (record_stock_entry, record_stock_exit, adjust_stock, reserve_stock,
 * release_reservation, create_prize_category, create_prize) re-checks its own
 * permission with the same function before writing anything (0027), so a
 * stale render — a permission revoked after this page loaded but before a
 * form still sitting in an open tab is submitted — is still refused where it
 * actually matters, not merely hidden here.
 *
 * A failed has_permission call throws rather than being folded into "not
 * granted", the same reasoning listCompanyAccess gives for its own check:
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
