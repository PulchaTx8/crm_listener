import { createUserClient } from '@/lib/supabase/user-client';
import { logger } from '@/lib/logger';
import { PageHeader } from '@/components/layout/app-shell';
import { Card, CardContent } from '@/components/ui/card';
import { parseRecordParam, TEAM_TABS } from '@/lib/record-params';
import { listRoles } from '@/services/roles';
import { TeamGrid } from './team-grid';
import type { TeamRow } from './team-record-dialog';

// Renders from the caller's session cookies, so it can never be static.
export const dynamic = 'force-dynamic';

/**
 * A safety net, NOT paging — this screen deliberately has none (spec §6).
 * At the owner's real scale, 30 users and 3 Stations per Organization, it
 * renders 30 rows and roughly 90 nested per-Station-per-role controls: a
 * screen that fits, where Previous/Next would cost more in navigation than
 * it saved in rows. The bound exists so that an Organization far outside
 * that shape degrades into a truncated list rather than an unbounded read,
 * and it is set high enough that reaching it means the assumption above has
 * stopped holding and this screen needs paging for real.
 */
const TEAM_SAFETY_BOUND = 500;

export default async function TeamPage({
  searchParams,
}: {
  searchParams: Promise<{ record?: string; tab?: string }>;
}) {
  const params = await searchParams;
  const supabase = await createUserClient();

  const { data: memberships, error: membershipsError } = await supabase
    .from('organization_memberships')
    .select('id, user_id, role, organization_id')
    // Archived memberships were listed as current ones, unlike members/page.tsx
    // and roles/page.tsx, which have always filtered this. The column exists on
    // this table (0003) — verified before filtering on it, per the plan's own
    // instruction — so a removed teammate reappeared here with live controls
    // beside their name.
    .is('deleted_at', null)
    .order('created_at', { ascending: true })
    .limit(TEAM_SAFETY_BOUND);

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
  //
  // Batched, not one `.in(...)` across every member of this Organization: the
  // same unbounded-IN-list defect Block 2 Task 10 found and fixed on
  // admin/customers/page.tsx (a real 414 there, at 268 owners platform-wide).
  // Scoped to one Organization here, so the count is far lower — but it is the
  // same defect class at its other occurrence, and chunking costs nothing
  // when the list is short.
  const userIds = [...new Set((memberships ?? []).map((m) => m.user_id))];
  const MEMBER_PROFILE_BATCH_SIZE = 100;
  const profiles: { id: string; email: string; full_name: string | null }[] = [];
  for (let i = 0; i < userIds.length; i += MEMBER_PROFILE_BATCH_SIZE) {
    const batch = userIds.slice(i, i + MEMBER_PROFILE_BATCH_SIZE);
    const { data: batchProfiles, error: batchError } = await supabase
      .from('profiles')
      .select('id, email, full_name')
      .in('id', batch);
    if (batchError) {
      logger.error({ err: batchError }, 'could not load a batch of member profiles');
      continue;
    }
    profiles.push(...(batchProfiles ?? []));
  }

  const profileByUser = new Map((profiles ?? []).map((p) => [p.id, p]));

  const { data: invitations, error: invitationsError } = await supabase
    .from('invitations')
    .select('id, email, is_owner, role_id, status, expires_at')
    .eq('status', 'pending')
    .order('created_at', { ascending: false });

  if (invitationsError) logger.error({ err: invitationsError }, 'could not load invitations');

  // A batched read of `roles` by id used to sit here, purely to label each
  // pending invitation. It has gone: listRoles below already returns every live
  // role in this Organization, and an invitation's role always belongs to the
  // Organization the invitation is in (create_invitation, 0018), so the grid
  // labels its rows from that one list. The property the old read carried is
  // kept exactly — both reads are filtered to deleted_at is null, so a role
  // archived after the invitation was sent is missing from the map either way,
  // and the grid says "Role unavailable" rather than "Member", which is also
  // what validate_invitation refuses on acceptance.

  // Block 1c: what each non-owner member can do in each Station. links is
  // every live company_membership so each row's Select can default to what
  // is actually assigned today.
  //
  // list_manageable_companies (0022, reworked by 0023), not a direct
  // `companies` select, and called ONCE PER SURFACE with the permission that
  // surface actually needs: assign_company_role authorises users.manage
  // Organization-wide (any Station, via has_org_permission), and
  // create_invitation authorises users.invite the same way — two distinct,
  // independently assignable permissions, not one. companies_select_org_member
  // (0021) scopes a direct select to the Stations the caller personally
  // belongs to, so a non-owner holding only one of these two permissions in
  // only one Station needs the function to see every Station THAT permission
  // authorises, not the other one's roster and not their own membership list.
  // `/app` is the screen that answers "which Stations can I reach" and keeps
  // reading `companies` directly; this page answers "which Stations can I
  // administer" and "which Stations can I invite into" — two different
  // questions with two different answers.
  const [
    { data: manageableCompanies, error: manageableCompaniesError },
    { data: invitableCompanies, error: invitableCompaniesError },
    roles,
    { data: links, error: linksError },
  ] = await Promise.all([
    supabase.rpc('list_manageable_companies', {
      p_organization_id: organizationId,
      p_permission: 'users.manage',
    }),
    supabase.rpc('list_manageable_companies', {
      p_organization_id: organizationId,
      p_permission: 'users.invite',
    }),
    listRoles(organizationId),
    supabase
      .from('company_memberships')
      .select('user_id, company_id, role_id')
      .eq('organization_id', organizationId)
      .is('deleted_at', null),
  ]);

  if (manageableCompaniesError) {
    logger.error({ err: manageableCompaniesError }, 'could not load manageable stations');
  }
  if (invitableCompaniesError) {
    logger.error({ err: invitableCompaniesError }, 'could not load invitable stations');
  }
  if (linksError) logger.error({ err: linksError }, 'could not load station access links');

  // One list, two kinds of line: people who are here, and invitations nobody
  // has accepted yet. They answer the same question at two stages — who is in
  // this Organization and what may they do — so they share a grid, and the
  // operations beside them differ rather than their place in it.
  //
  // The ids are prefixed because a membership id and an invitation id are
  // uuids from different tables: applyRowPatch keys on `id` alone, and two rows
  // that ever collided would patch each other.
  const rows: TeamRow[] = [
    ...(memberships ?? []).map((m) => {
      const profile = profileByUser.get(m.user_id);
      return {
        id: `member:${m.id}`,
        kind: 'member' as const,
        entityId: m.id,
        userId: m.user_id,
        email: profile?.email ?? m.user_id,
        fullName: profile?.full_name ?? null,
        orgRole: m.role as 'owner' | 'member',
        isOwner: m.role === 'owner',
        roleId: null,
        expiresAt: null,
        access: (links ?? [])
          .filter((l) => l.user_id === m.user_id)
          .map((l) => ({ companyId: l.company_id, roleId: l.role_id })),
      };
    }),
    ...(invitations ?? []).map((i) => ({
      id: `invitation:${i.id}`,
      kind: 'invitation' as const,
      entityId: i.id,
      userId: null,
      email: i.email,
      fullName: null,
      orgRole: null,
      isOwner: i.is_owner,
      roleId: i.role_id,
      expiresAt: i.expires_at,
      access: [],
    })),
  ];

  return (
    <>
      <PageHeader
        title="Team"
        description="Invite colleagues and decide what each of them may do."
      />

      <TeamGrid
        initialRows={rows}
        organizationId={organizationId}
        roles={roles}
        manageableStations={manageableCompanies ?? []}
        invitableStations={invitableCompanies ?? []}
        initialRecord={parseRecordParam(params, TEAM_TABS)}
      />
    </>
  );
}
