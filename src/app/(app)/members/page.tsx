import Link from 'next/link';
import { redirect } from 'next/navigation';
import { createUserClient } from '@/lib/supabase/user-client';
import { decodeCursor } from '@/lib/keyset';
import { logger } from '@/lib/logger';
import { PageHeader } from '@/components/layout/app-shell';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  PageControls,
  SortLink,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { listOrganizationMembers, MEMBER_SEARCH_MAX_LENGTH } from '@/services/members';
import type { MemberListPage } from '@/services/members';
import { canViewAudience } from './access';
import { describeMembersReadError } from './errors';
import { ageFromBirthDate, formatDate } from './format';
import {
  membersHref,
  parseMemberListCursor,
  parseMemberListState,
  sortHref,
} from './list-params';
import type { MemberListSearchParams } from './list-params';
import { MembersFilters } from './members-filters';
import { RegisterMemberForm } from './register-member-form';
import { listCompanyAccess } from '../inventory/station-access';
import type { SuspendedCompany, ViewableCompany } from '../inventory/station-access';

// Renders from the caller's session cookies and a live per-Organization
// permission check, so it can never be static.
export const dynamic = 'force-dynamic';

/** How many columns the empty-state row has to span. */
const COLUMN_COUNT = 8;

export default async function MembersPage({
  searchParams,
}: {
  searchParams: Promise<MemberListSearchParams>;
}) {
  const raw = await searchParams;
  const state = parseMemberListState(raw);
  const cursorParam = parseMemberListCursor(raw);
  // An unreadable cursor means "start from the beginning", never an error
  // page — decodeCursor's own contract (src/lib/keyset.ts).
  const cursor = decodeCursor(cursorParam?.value);

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

  let page: MemberListPage;
  try {
    page = await listOrganizationMembers(
      {
        organizationId,
        // The same bound the service enforces on its own argument, imported
        // rather than hand-copied so a caller-controlled URL parameter cannot
        // drift the two apart (Block 3, Task 8 re-review).
        search: state.search?.slice(0, MEMBER_SEARCH_MAX_LENGTH),
        sort: state.sort,
        direction: state.direction,
        cursor,
        cursorSide: cursorParam?.side ?? 'after',
        ageMin: state.ageMin,
        ageMax: state.ageMax,
        blockedOnly: state.blockedOnly || undefined,
        hasRulesConsent: state.consent === undefined ? undefined : state.consent === 'yes',
        registeredFrom: state.registeredFrom,
        registeredTo: state.registeredTo,
      },
      accessToken,
    );
  } catch (cause) {
    logger.error({ err: cause, organizationId }, 'could not load the audience');
    return <LoadError message={describeMembersReadError(cause)} />;
  }

  // Rendered only as a courtesy, the same reasoning inventory/page.tsx gives
  // for its own catalogue forms: create_member (0034) re-checks members.create
  // itself before writing anything, so hiding this card from someone who
  // holds it nowhere is convenience, not the refusal itself.
  //
  // listCompanyAccess (inventory/station-access.ts) genuinely throws on a
  // failed read or permission check, per its own doc comment — caught here
  // and folded into an empty list anyway, a DELIBERATE, NARROWER choice made
  // only at this call site: this screen's primary purpose is the audience
  // list below, not registration, so a failure resolving who can register
  // should not take down the whole page the way it legitimately does for
  // inventory/page.tsx, whose entire content depends on resolving Company
  // access first.
  let registrableStations: ViewableCompany[] = [];
  let suspendedStations: SuspendedCompany[] = [];
  let registrationCapped = false;
  try {
    ({ viewable: registrableStations, suspended: suspendedStations, capped: registrationCapped } =
      await listCompanyAccess(supabase, 'members.create'));
  } catch (cause) {
    logger.error({ err: cause, organizationId }, 'could not resolve registration access');
  }

  const nameSorted = state.sort === 'name';
  const registeredSorted = state.sort === 'created';
  const ariaSort = (sorted: boolean) =>
    sorted ? (state.direction === 'asc' ? 'ascending' : 'descending') : 'none';

  return (
    <>
      <PageHeader
        title="Members"
        description="The audience across every Station you can reach."
      />

      {(registrableStations.length > 0 || suspendedStations.length > 0) && (
        <Card className="mb-6">
          <CardHeader>
            <CardTitle>Register a listener</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {registrationCapped && (
              <p className="text-xs text-muted-foreground">
                Only the first {registrableStations.length + suspendedStations.length} Stations
                you can reach were checked. If the Station you want is not listed below, contact
                us.
              </p>
            )}
            <RegisterMemberForm stations={registrableStations} suspended={suspendedStations} />
          </CardContent>
        </Card>
      )}

      <MembersFilters state={state} />

      {/* The one filter that cannot be a query condition, said plainly rather
          than left for somebody to infer from a short page. member_consents
          is append-only, so "consented to the rules" means the LATEST rules
          row is a grant — a question about rows this page has already
          fetched, not one Postgres can answer while paging. */}
      {state.consent && (
        <p className="mt-4 text-xs text-muted-foreground" data-testid="member-consent-note">
          Rules consent is checked after each page is read, so a page can show fewer than 50
          listeners and no total is available while this filter is on. Previous and Next still
          walk the whole audience.
        </p>
      )}

      <div className="mt-4 rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead aria-sort={ariaSort(nameSorted)}>
                <SortLink
                  href={sortHref(state, 'name')}
                  active={nameSorted}
                  direction={nameSorted ? state.direction : 'asc'}
                >
                  Name
                </SortLink>
              </TableHead>
              <TableHead>Phone</TableHead>
              <TableHead>E-mail</TableHead>
              <TableHead>CPF</TableHead>
              <TableHead>Age</TableHead>
              <TableHead>City</TableHead>
              <TableHead aria-sort={ariaSort(registeredSorted)}>
                <SortLink
                  href={sortHref(state, 'created')}
                  active={registeredSorted}
                  direction={registeredSorted ? state.direction : 'desc'}
                >
                  Registered
                </SortLink>
              </TableHead>
              <TableHead>Block state</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {page.rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={COLUMN_COUNT} className="text-sm text-muted-foreground">
                  No listener matches these filters.
                </TableCell>
              </TableRow>
            ) : (
              page.rows.map((member) => {
                const age = ageFromBirthDate(member.birthDate);
                return (
                  <TableRow key={member.id} data-testid="member-row">
                    <TableCell className="font-medium">
                      <Link
                        href={`/members/${member.id}`}
                        className="ring-offset-background hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                      >
                        {member.anonymizedAt
                          ? 'Personal data erased'
                          : (member.fullName ?? 'Unnamed listener')}
                      </Link>
                    </TableCell>
                    {/* An anonymised row's contact fields are all null
                        (anonymize_member, 0034) and read as an em dash here,
                        the same as a listener who never gave one — the Name
                        cell above is what says which of the two happened. */}
                    <TableCell>{member.phone ?? '—'}</TableCell>
                    <TableCell>{member.email ?? '—'}</TableCell>
                    <TableCell>
                      {member.cpfLastDigits ? `···${member.cpfLastDigits}` : '—'}
                    </TableCell>
                    <TableCell>{age === null ? '—' : age}</TableCell>
                    <TableCell>{member.city ?? '—'}</TableCell>
                    <TableCell>{formatDate(member.createdAt)}</TableCell>
                    <TableCell>
                      {member.blocked ? (
                        <span
                          data-testid="member-blocked-badge"
                          className="rounded-full bg-destructive/10 px-2.5 py-0.5 text-xs font-medium text-destructive"
                        >
                          Blocked
                        </span>
                      ) : (
                        '—'
                      )}
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>

        {/* Outside Table, never inside it: PageControls renders a div, and a
            div inside a table is invalid HTML the browser foster-parents out
            (the component's own warning). */}
        <PageControls
          total={page.total}
          label={
            page.total === null
              ? 'Not counted while the rules-consent filter is on'
              : page.total === 1
                ? 'listener'
                : 'listeners'
          }
          previousHref={
            page.previousCursor
              ? membersHref(state, { side: 'before', value: page.previousCursor })
              : null
          }
          nextHref={
            page.nextCursor ? membersHref(state, { side: 'after', value: page.nextCursor }) : null
          }
        />
      </div>
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
