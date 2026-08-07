import { getTranslations } from 'next-intl/server';
import { redirect } from 'next/navigation';
import { createUserClient } from '@/lib/supabase/user-client';
import { PageHeader } from '@/components/layout/app-shell';
import { parseRecordParam, ROLE_TABS } from '@/lib/record-params';
import { listPermissionCatalogue, listRoles } from '@/services/roles';
import { RolesGrid } from './roles-grid';

// Renders from the caller's session cookies and a live permission check, so it
// can never be static.
export const dynamic = 'force-dynamic';

export default async function RolesPage({
  searchParams,
}: {
  searchParams: Promise<{ record?: string; tab?: string }>;
}) {
  const t = await getTranslations('roles');
  const params = await searchParams;
  const supabase = await createUserClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { data: membership } = await supabase
    .from('organization_memberships')
    .select('organization_id')
    .eq('user_id', user.id)
    .is('deleted_at', null)
    .single();

  if (!membership) redirect('/app');

  const { data: allowed } = await supabase.rpc('has_org_permission', {
    p_permission: 'roles.manage',
    p_organization_id: membership.organization_id,
  });

  // A courtesy, not the boundary: the Roles link in lib/auth/shell.ts stays
  // visible to every member of the Organization section regardless of this
  // check, and create_role/update_role/delete_role each re-run
  // has_org_permission('roles.manage', ...) themselves before writing anything.
  // This redirect only saves someone without the permission a wasted trip.
  if (!allowed) redirect('/app');

  const [roles, catalogue] = await Promise.all([
    listRoles(membership.organization_id),
    listPermissionCatalogue(),
  ]);

  return (
    <>
      <PageHeader
        title={t('roles')}
        description={t('rolesDescription')}
      />

      <RolesGrid
        initialRoles={roles}
        organizationId={membership.organization_id}
        catalogue={catalogue}
        initialRecord={parseRecordParam(params, ROLE_TABS)}
      />
    </>
  );
}
