import { createUserClient } from '@/lib/supabase/user-client';
import { logger } from '@/lib/logger';
import { PageHeader } from '@/components/layout/app-shell';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Select } from '@/components/ui/input';
import { changeOrgRoleAction, removeMemberAction, revokeAction } from './actions';
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
  // handful of pending invitations.
  const roleIds = [
    ...new Set((invitations ?? []).map((i) => i.role_id).filter((id): id is string => id !== null)),
  ];
  const { data: invitationRoles } = roleIds.length
    ? await supabase.from('roles').select('id, name').in('id', roleIds)
    : { data: [] };
  const roleNameById = new Map((invitationRoles ?? []).map((r) => [r.id, r.name]));

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
            <InviteForm organizationId={organizationId} />
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
                return (
                  <div
                    key={m.id}
                    data-testid="member-row"
                    className="flex flex-wrap items-center justify-between gap-3 border-b pb-3 last:border-0 last:pb-0"
                  >
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
                        {i.is_owner ? 'Owner' : (roleNameById.get(i.role_id ?? '') ?? 'Member')}
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
