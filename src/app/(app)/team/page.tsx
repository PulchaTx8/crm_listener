import { createUserClient } from '@/lib/supabase/user-client';
import { logger } from '@/lib/logger';
import { PageHeader } from '@/components/layout/app-shell';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Select } from '@/components/ui/input';
import { listRoles } from '@/services/roles';
import {
  assignCompanyRoleAction,
  changeOrgRoleAction,
  removeCompanyAccessAction,
  removeMemberAction,
  revokeAction,
} from './actions';
import { InviteForm } from './invite-form';

// Renders from the caller's session cookies, so it can never be static.
export const dynamic = 'force-dynamic';

export default async function TeamPage() {
  const supabase = await createUserClient();

  const { data: memberships, error: membershipsError } = await supabase
    .from('organization_memberships')
    .select('id, user_id, role, organization_id')
    .order('created_at', { ascending: true });

  if (membershipsError) logger.error({ err: membershipsError }, 'could not load memberships');

  const organizationId = memberships?.[0]?.organization_id;

  // Moved ahead of the rest of this page's reads (it used to sit after them):
  // every query below is scoped to this Organization, and the Companies/roles/
  // memberships read added for Block 1c would otherwise need its own
  // organizationId ?? '' fallback just to keep TypeScript happy — worse, an
  // empty-string uuid filter on `roles` would make listRoles's own error
  // handling throw, turning "no organization yet" into a 500. Returning here
  // first lets everything after this point treat organizationId as a plain
  // string.
  if (!organizationId) {
    return (
      <>
        <PageHeader title="Team" />
        <Card>
          <CardContent className="pt-6">
            <p className="text-sm text-muted-foreground">
              You do not belong to an organization yet.
            </p>
          </CardContent>
        </Card>
      </>
    );
  }

  // Two queries joined in JS, not a PostgREST embed: organization_memberships
  // and profiles both reference auth.users, so there is no foreign key for an
  // embed to travel along and it would fail with PGRST200 (Block 1a review).
  const userIds = [...new Set((memberships ?? []).map((m) => m.user_id))];
  const { data: profiles, error: profilesError } = userIds.length
    ? await supabase.from('profiles').select('id, email, full_name').in('id', userIds)
    : { data: [], error: null };

  if (profilesError) logger.error({ err: profilesError }, 'could not load member profiles');

  const profileByUser = new Map((profiles ?? []).map((p) => [p.id, p]));

  const { data: invitations } = await supabase
    .from('invitations')
    .select('id, email, is_owner, role_id, status, expires_at')
    .eq('status', 'pending')
    .order('created_at', { ascending: false });

  // A third JS-side join, same pattern as the two above: role_id names a row in
  // roles, and there is no reason to fetch the whole catalogue just to label a
  // handful of pending invitations. The roles_select_org_member policy filters
  // deleted_at is null, so a role archived after the invitation was sent comes
  // back missing here — which is also exactly the case validate_invitation
  // refuses on acceptance, so the fallback below must not say "Member".
  const roleIds = [
    ...new Set((invitations ?? []).map((i) => i.role_id).filter((id): id is string => id !== null)),
  ];
  const { data: invitationRoles } = roleIds.length
    ? await supabase.from('roles').select('id, name').in('id', roleIds)
    : { data: [] };
  const roleNameById = new Map((invitationRoles ?? []).map((r) => [r.id, r.name]));

  // Block 1c: what each non-owner member can do in each Station. companies is
  // the full roster to render a row per Station even where no membership
  // exists yet ("No access"); links is every live company_membership so each
  // row's Select can default to what is actually assigned today.
  const [
    { data: companies, error: companiesError },
    roles,
    { data: links, error: linksError },
  ] = await Promise.all([
    supabase
      .from('companies')
      .select('id, name, status')
      .eq('organization_id', organizationId)
      .is('deleted_at', null)
      .order('name'),
    listRoles(organizationId),
    supabase
      .from('company_memberships')
      .select('user_id, company_id, role_id')
      .eq('organization_id', organizationId)
      .is('deleted_at', null),
  ]);

  if (companiesError) logger.error({ err: companiesError }, 'could not load stations');
  if (linksError) logger.error({ err: linksError }, 'could not load station access links');

  return (
    <>
      <PageHeader
        title="Team"
        description="Invite colleagues and decide what each of them may do."
      />

      <div className="grid gap-6 lg:grid-cols-[minmax(0,360px)_minmax(0,1fr)] lg:items-start">
        <Card>
          <CardHeader>
            <CardTitle>Invite a colleague</CardTitle>
            <CardDescription>
              They choose their own password, so it never travels outside their browser.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <InviteForm organizationId={organizationId} roles={roles} companies={companies ?? []} />
          </CardContent>
        </Card>

        <div className="flex flex-col gap-6">
          <Card>
            <CardHeader>
              <CardTitle>Members</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              {(memberships ?? []).map((m) => {
                const profile = profileByUser.get(m.user_id);
                const isOwner = m.role === 'owner';
                return (
                  <div
                    key={m.id}
                    data-testid="member-row"
                    className="flex flex-col gap-3 border-b pb-3 last:border-0 last:pb-0"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <span className="text-sm">
                        {profile?.full_name ? `${profile.full_name} — ` : ''}
                        {profile?.email ?? m.user_id}
                      </span>
                      <div className="flex items-center gap-2">
                        <form action={changeOrgRoleAction} className="flex items-center gap-2">
                          <input type="hidden" name="membershipId" value={m.id} />
                          <Select name="role" defaultValue={m.role} className="h-9 w-32 text-sm">
                            <option value="owner">Owner</option>
                            <option value="member">Member</option>
                          </Select>
                          <Button type="submit" variant="outline">
                            Save
                          </Button>
                        </form>
                        <form action={removeMemberAction}>
                          <input type="hidden" name="membershipId" value={m.id} />
                          <Button type="submit" variant="outline">
                            Remove
                          </Button>
                        </form>
                      </div>
                    </div>

                    {/* Per-Station role assignment. An owner holds no
                        company_memberships row by design — mapping the
                        Company list for them would render every Station as
                        "No access", which is false; they reach all of them by
                        ownership. So they get one line instead, and no
                        controls: assign_company_role itself refuses to give
                        the owner a role ("the owner already has full access
                        and takes no role"), so there is nothing here for a
                        control to do. */}
                    {isOwner ? (
                      <p className="pl-1 text-sm text-muted-foreground" data-testid="owner-access-label">
                        Owner — full access to every Station
                      </p>
                    ) : roles.length === 0 ? (
                      <p className="pl-1 text-sm text-muted-foreground">
                        No roles yet. Create one on the Roles screen, then grant Station access
                        here.
                      </p>
                    ) : (
                      <div className="flex flex-col gap-2 pl-1">
                        {(companies ?? []).map((company) => {
                          const link = (links ?? []).find(
                            (l) => l.user_id === m.user_id && l.company_id === company.id,
                          );
                          return (
                            <div
                              key={company.id}
                              data-testid="station-access-row"
                              className="flex flex-wrap items-center gap-3 text-sm"
                            >
                              <span className="w-40 truncate text-muted-foreground">
                                {company.name}
                              </span>
                              <form
                                action={assignCompanyRoleAction}
                                className="flex items-center gap-2"
                              >
                                <input type="hidden" name="companyId" value={company.id} />
                                <input type="hidden" name="userId" value={m.user_id} />
                                <Select
                                  name="roleId"
                                  defaultValue={link?.role_id ?? ''}
                                  className="h-9 w-40 text-sm"
                                >
                                  <option value="" disabled>
                                    No access
                                  </option>
                                  {roles.map((role) => (
                                    <option key={role.id} value={role.id}>
                                      {role.name}
                                    </option>
                                  ))}
                                </Select>
                                <Button type="submit" variant="outline">
                                  Apply
                                </Button>
                              </form>
                              {link ? (
                                <form action={removeCompanyAccessAction}>
                                  <input type="hidden" name="companyId" value={company.id} />
                                  <input type="hidden" name="userId" value={m.user_id} />
                                  <Button type="submit" variant="outline">
                                    Remove
                                  </Button>
                                </form>
                              ) : null}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Pending invitations</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              {(invitations ?? []).length === 0 ? (
                <p className="text-sm text-muted-foreground">None.</p>
              ) : (
                (invitations ?? []).map((i) => (
                  <div
                    key={i.id}
                    data-testid="invitation-row"
                    className="flex flex-wrap items-center justify-between gap-3 border-b pb-3 last:border-0 last:pb-0"
                  >
                    <span className="text-sm">
                      {i.email}
                      <span className="ml-2 rounded-full bg-muted px-2.5 py-0.5 text-xs font-medium text-muted-foreground">
                        {i.is_owner ? 'Owner' : (roleNameById.get(i.role_id ?? '') ?? 'Role unavailable')}
                      </span>
                      <span className="ml-2 text-muted-foreground">
                        expires {new Date(i.expires_at).toLocaleDateString('en-GB')}
                      </span>
                    </span>
                    <form action={revokeAction}>
                      <input type="hidden" name="invitationId" value={i.id} />
                      <Button type="submit" variant="outline">
                        Revoke
                      </Button>
                    </form>
                  </div>
                ))
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </>
  );
}
