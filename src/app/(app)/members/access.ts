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
