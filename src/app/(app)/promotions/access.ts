import 'server-only';
import { InternalError } from '@/lib/errors';
import type { createUserClient } from '@/lib/supabase/user-client';

type UserClient = Awaited<ReturnType<typeof createUserClient>>;

export interface PromotionPowers {
  create: boolean;
  edit: boolean;
  cancel: boolean;
  archive: boolean;
  /** True for the platform admin and the Organization owner — the only callers whose reads return archived rows (0044). */
  seesArchived: boolean;
}

const WRITE_CODES = [
  'promotions.create',
  'promotions.edit',
  'promotions.cancel',
  'promotions.archive',
] as const;

/**
 * Which of the four write permissions the caller holds in this one Station,
 * plus whether they are the caller 0044 admits to archived rows.
 *
 * A courtesy gate for which controls get rendered at all, never the boundary:
 * create_promotion, update_promotion, cancel_promotion, archive_promotion and
 * both quiz RPCs re-check has_permission themselves before writing anything
 * (0042/0043), so a permission revoked after this page rendered — with a form
 * still sitting in an open tab — is still refused where it matters.
 *
 * A failed has_permission call throws rather than being folded into "not
 * granted", the same reasoning getInventoryPermissions gives: collapsing a
 * transient RPC failure into "no access" would silently hide every control
 * from somebody who does hold the permission, and they would have no way to
 * tell that from having lost it.
 */
export async function getPromotionPowers(
  supabase: UserClient,
  companyId: string,
): Promise<PromotionPowers> {
  const [writes, archived] = await Promise.all([
    Promise.all(
      WRITE_CODES.map((code) =>
        supabase.rpc('has_permission', { p_permission: code, p_company_id: companyId }),
      ),
    ),
    supabase.rpc('is_owner_of_company', { p_company_id: companyId }),
  ]);

  writes.forEach((result, i) => {
    if (result.error) {
      throw new InternalError(
        `Could not check ${WRITE_CODES[i]} access for this station: ${result.error.message}`,
      );
    }
  });
  if (archived.error) {
    throw new InternalError(
      `Could not check whether this caller sees archived promotions: ${archived.error.message}`,
    );
  }

  return {
    create: writes[0]?.data === true,
    edit: writes[1]?.data === true,
    cancel: writes[2]?.data === true,
    archive: writes[3]?.data === true,
    seesArchived: archived.data === true,
  };
}
