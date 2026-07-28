import Link from 'next/link';
import { redirect } from 'next/navigation';
import { createUserClient } from '@/lib/supabase/user-client';
import { logger } from '@/lib/logger';
import { PageHeader } from '@/components/layout/app-shell';
import { Card, CardContent } from '@/components/ui/card';
import { listOrganizationMembers } from '@/services/members';
import type { MemberListRow } from '@/services/members';
import { canViewAudience } from './access';
import { describeMembersReadError } from './errors';
import { formatDate } from './format';
import { MemberSearchForm } from './member-search-form';

// Renders from the caller's session cookies and a live per-Organization
// permission check, so it can never be static.
export const dynamic = 'force-dynamic';

// A URL query parameter is caller-controlled and otherwise unbounded (Task 8
// review) — listOrganizationMembers (services/members.ts) enforces the same
// bound on its own `search` argument, but a query string this long has no
// legitimate use before it ever reaches that function, so it is trimmed here
// too rather than relying solely on the service to catch it.
const MAX_QUERY_LENGTH = 100;

export default async function MembersPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const params = await searchParams;
  const search = params.q?.trim().slice(0, MAX_QUERY_LENGTH) || undefined;

  const supabase = await createUserClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { data: memberships, error: membershipsError } = await supabase
    .from('organization_memberships')
    .select('organization_id')
    .eq('user_id', user.id)
    .is('deleted_at', null)
    .order('created_at', { ascending: true })
    .limit(1);
  if (membershipsError) {
    logger.error({ err: membershipsError }, 'could not resolve organization for the audience screen');
  }
  const organizationId = memberships?.[0]?.organization_id;

  if (!organizationId) {
    return (
      <>
        <PageHeader title="Members" />
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

  let canView: boolean;
  try {
    canView = await canViewAudience(supabase, organizationId);
  } catch (cause) {
    logger.error({ err: cause, organizationId }, 'could not resolve audience access');
    return <LoadError message={describeMembersReadError(cause)} />;
  }

  // A courtesy, not the boundary: every read below goes through RLS
  // (members_select_reachable and its siblings, 0035_rls_members.sql), which
  // re-checks reachability per row regardless of this gate. This only saves
  // someone holding members.view nowhere a trip to a screen that would
  // otherwise show nothing — the same shape inventory/page.tsx's own redirect
  // uses for inventory.view.
  if (!canView) redirect('/app');

  const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
  if (sessionError || !sessionData.session) redirect('/login');
  const accessToken = sessionData.session.access_token;

  let members: MemberListRow[];
  let capped: boolean;
  try {
    ({ members, capped } = await listOrganizationMembers(organizationId, search, accessToken));
  } catch (cause) {
    logger.error({ err: cause, organizationId }, 'could not load the audience');
    return <LoadError message={describeMembersReadError(cause)} />;
  }

  return (
    <>
      <PageHeader
        title="Members"
        description="The audience across every Station you can reach."
      />

      <MemberSearchForm initialQuery={search ?? ''} />

      {capped && (
        <p className="mb-2 mt-4 text-xs text-muted-foreground">
          {search
            ? `Showing the first ${members.length} matches. Narrow your search further to see more.`
            : `Showing the first ${members.length}. Search to narrow this down.`}
        </p>
      )}

      {members.length === 0 ? (
        <Card className="mt-4">
          <CardContent className="pt-6">
            <p className="text-sm text-muted-foreground">
              {search
                ? 'No listener matches this search.'
                : 'No listener registered yet at a Station you can reach.'}
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="mt-4 flex flex-col gap-3">
          {members.map((member) => {
            const contact = [
              member.phone,
              member.email,
              member.cpfLastDigits ? `CPF ···${member.cpfLastDigits}` : null,
            ]
              .filter((v): v is string => Boolean(v))
              .join(' · ');
            return (
              <Link
                key={member.id}
                href={`/members/${member.id}`}
                data-testid="member-row"
                className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-4 transition-colors hover:bg-accent/40"
              >
                <div className="flex flex-col gap-1">
                  <span className="font-medium">
                    {member.anonymizedAt
                      ? 'Personal data erased'
                      : (member.fullName ?? 'Unnamed listener')}
                  </span>
                  <span className="text-sm text-muted-foreground">
                    {/* An anonymised row's contact fields are all null
                        (anonymize_member, 0034), which is what would
                        otherwise fall through to "No contact details on
                        file" here — false: something WAS recorded and was
                        deliberately erased, not never provided (Task 8
                        review). Mirrors the detail page's own
                        `Erased ${formatDate(...)}` description. */}
                    {member.anonymizedAt
                      ? `Erased ${formatDate(member.anonymizedAt)}`
                      : contact || 'No contact details on file'}
                  </span>
                </div>
                {member.blocked && (
                  <span
                    data-testid="member-blocked-badge"
                    className="rounded-full bg-destructive/10 px-2.5 py-0.5 text-xs font-medium text-destructive"
                  >
                    Blocked
                  </span>
                )}
              </Link>
            );
          })}
        </div>
      )}
    </>
  );
}

function LoadError({ message }: { message: string }) {
  return (
    <>
      <PageHeader title="Members" />
      <Card>
        <CardContent className="pt-6">
          <p className="text-sm text-destructive">{message}</p>
        </CardContent>
      </Card>
    </>
  );
}
