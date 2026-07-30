import 'server-only';
import { InternalError } from '@/lib/errors';
import type { UserClient } from '@/lib/supabase/user-client';

/**
 * Whether the caller holds members.view anywhere in this Organization — a
 * courtesy gate for the whole /members surface, the same shape roles/page.tsx
 * uses inline for roles.manage. members_select_reachable and its four sibling
 * policies (0035_rls_members.sql) re-check reachability per row regardless of
 * this result, so a stale "yes" here — the permission revoked after this page
 * loaded but before the query underneath actually runs — still returns
 * nothing; this only decides whether the screen is worth rendering at all.
 */
export async function canViewAudience(
  supabase: UserClient,
  organizationId: string,
): Promise<boolean> {
  const { data, error } = await supabase.rpc('has_org_permission', {
    p_permission: 'members.view',
    p_organization_id: organizationId,
  });
  if (error) throw new InternalError(`Could not check audience access: ${error.message}`);
  return data === true;
}

export interface AudiencePowers {
  create: boolean;
  edit: boolean;
  block: boolean;
  archive: boolean;
  erase: boolean;
}

/**
 * Which controls the audience grid renders. A courtesy, not the boundary: every
 * RPC behind these re-checks its own power in the database before writing, so a
 * hidden pencil saves a refusal rather than replacing one.
 *
 * Asked Organization-wide, like canViewAudience above, because that is the
 * scope these screens work at — the per-Station refusal, where it applies,
 * comes from the RPC itself.
 */
export async function getAudiencePowers(
  supabase: UserClient,
  organizationId: string,
): Promise<AudiencePowers> {
  const codes = ['members.create', 'members.edit', 'members.block', 'members.archive', 'members.erase'] as const;

  const answers = await Promise.all(
    codes.map(async (code) => {
      const { data, error } = await supabase.rpc('has_org_permission', {
        p_permission: code,
        p_organization_id: organizationId,
      });
      if (error) throw new InternalError(`Could not check ${code}: ${error.message}`);
      return data === true;
    }),
  );

  return {
    create: answers[0] ?? false,
    edit: answers[1] ?? false,
    block: answers[2] ?? false,
    archive: answers[3] ?? false,
    erase: answers[4] ?? false,
  };
}
