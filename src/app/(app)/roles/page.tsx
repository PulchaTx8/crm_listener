import { redirect } from 'next/navigation';
import { createUserClient } from '@/lib/supabase/user-client';
import { PageHeader } from '@/components/layout/app-shell';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { listPermissionCatalogue, listRoles } from '@/services/roles';
import { deleteRoleAction } from './actions';
import { RoleForm } from './role-form';

// Renders from the caller's session cookies and a live permission check, so it
// can never be static.
export const dynamic = 'force-dynamic';

export default async function RolesPage() {
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
        title="Roles"
        description="A role is a set of powers you assign to someone in a Station."
      />

      <div className="flex flex-col gap-6">
        <Card>
          <CardHeader>
            <CardTitle>Existing roles</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            {roles.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No roles yet. Create one below, then assign it on the Team screen.
              </p>
            ) : (
              roles.map((role) => (
                <div key={role.id} data-testid="role-row" className="rounded-lg border p-4">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <p className="text-sm font-medium">{role.name}</p>
                      <p className="text-sm text-muted-foreground">
                        {role.permissionCodes.length} permission(s) · held by {role.holders} user(s)
                      </p>
                    </div>
                    <form action={deleteRoleAction}>
                      <input type="hidden" name="roleId" value={role.id} />
                      <Button
                        type="submit"
                        variant="outline"
                        disabled={role.holders > 0}
                        title={
                          role.holders > 0
                            ? `${role.holders} user(s) hold this role — reassign them on the Team screen before deleting it.`
                            : 'Delete this role'
                        }
                      >
                        Delete
                      </Button>
                    </form>
                  </div>

                  {/* A hover title alone would not be discoverable on touch, so
                      the reason a disabled Delete button cannot be pressed is
                      also written out here. */}
                  {role.holders > 0 && (
                    <p className="mt-2 text-xs text-muted-foreground">
                      Reassign all {role.holders} holder(s) on the Team screen before this role can
                      be deleted.
                    </p>
                  )}

                  <details className="mt-3">
                    <summary className="cursor-pointer text-sm text-primary underline underline-offset-2">
                      Edit permissions
                    </summary>
                    <div className="mt-4 border-t pt-4">
                      <RoleForm
                        organizationId={membership.organization_id}
                        catalogue={catalogue}
                        role={role}
                      />
                    </div>
                  </details>
                </div>
              ))
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>New role</CardTitle>
          </CardHeader>
          <CardContent>
            <RoleForm organizationId={membership.organization_id} catalogue={catalogue} />
          </CardContent>
        </Card>
      </div>
    </>
  );
}
