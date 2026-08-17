import { getTranslations } from 'next-intl/server';
import { redirect } from 'next/navigation';
import { createUserClient } from '@/lib/supabase/user-client';
import { decodeCursor } from '@/lib/keyset';
import { logger } from '@/lib/logger';
import { PageHeader } from '@/components/layout/app-shell';
import { Card, CardContent } from '@/components/ui/card';
import { listOrganizationMembers, MEMBER_SEARCH_MAX_LENGTH } from '@/services/members';
import type { MemberListPage } from '@/services/members';
import { canViewAudience, getAudiencePowers } from './access';
import type { AudiencePowers } from './access';
import { describeMembersReadError } from './errors';
import { membersHref, parseMemberListCursor, parseMemberListState } from './list-params';
import type { MemberListSearchParams } from './list-params';
import { MembersFilters } from './members-filters';
import { MembersGrid } from './members-grid';
import { parseRecordParam, MEMBER_TABS } from '@/lib/record-params';
import { listCompanyAccess, STATION_SEARCH_MAX_LENGTH } from '../inventory/station-access';
import type { SuspendedCompany, ViewableCompany } from '../inventory/station-access';
import { StationSearchForm } from '../inventory/station-search-form';
import { ExportDialog } from '@/components/reports/export-dialog';
import { listenersReportFilters } from '@/lib/reports/list-filters';

// Renders from the caller's session cookies and a live per-Organization
// permission check, so it can never be static.
export const dynamic = 'force-dynamic';

export default async function MembersPage({
  searchParams,
}: {
  searchParams: Promise<MemberListSearchParams>;
}) {
  const t = await getTranslations('members');
  const raw = await searchParams;
  const state = parseMemberListState(raw);
  const cursorParam = parseMemberListCursor(raw);
  // An unreadable cursor means "start from the beginning", never an error
  // page — decodeCursor's own contract (src/lib/keyset.ts).
  const cursor = decodeCursor(cursorParam?.value);
  // The same bound listCompanyAccess enforces on its own argument, imported
  // rather than copied.
  const stationSearch = state.stationSearch?.slice(0, STATION_SEARCH_MAX_LENGTH);

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
        <PageHeader title={t('members')} />
        <Card>
          <CardContent className="pt-6">
            <p className="text-sm text-muted-foreground">
              {t('youDoNotBelongToAn')}</p>
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
    return <LoadError message={describeMembersReadError(cause, await getTranslations('members'))} />;
  }

  // A courtesy, not the boundary: every read below goes through RLS
  // (members_select_reachable and its siblings, 0035_rls_members.sql), which
  // re-checks reachability per row regardless of this gate. This only saves
  // someone holding members.view nowhere a trip to a screen that would
  // otherwise show nothing — the same shape inventory/page.tsx's own redirect
  // uses for inventory.view.
  if (!canView) redirect('/app');

  // Which controls the grid renders. A courtesy, not the boundary: every RPC
  // behind them re-checks its own power before writing.
  let powers: AudiencePowers;
  try {
    powers = await getAudiencePowers(supabase, organizationId);
  } catch (cause) {
    logger.error({ err: cause, organizationId }, 'could not resolve audience powers');
    return <LoadError message={describeMembersReadError(cause, await getTranslations('members'))} />;
  }

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
        gender: state.gender,
        registeredFrom: state.registeredFrom,
        registeredTo: state.registeredTo,
      },
      accessToken,
    );
  } catch (cause) {
    logger.error({ err: cause, organizationId }, 'could not load the audience');
    return <LoadError message={describeMembersReadError(cause, await getTranslations('members'))} />;
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
      await listCompanyAccess(supabase, 'members.create', stationSearch));
  } catch (cause) {
    logger.error({ err: cause, organizationId }, 'could not resolve registration access');
  }

  // Block 8b. Which Stations this caller may READ listeners in, which is a
  // different question from which they may register one at, and the one the
  // export needs: report_page_listeners takes Station ids, and this screen is
  // Organization-scoped -- it shows the audience across everything reachable
  // without ever naming the Stations that make it up.
  //
  // Folded into an empty list on failure, exactly as the call above is and for
  // the same reason: this screen's purpose is the list below, and a failure
  // resolving the export's scope should cost the export, not the page. An empty
  // list simply disables the button.
  //
  // A caller reaching more than one Station will need reports.consolidated,
  // which request_report (0127) enforces. That is correct rather than awkward:
  // the file WOULD combine several radios' audiences into one document, which
  // is exactly what that permission governs.
  let exportableStations: ViewableCompany[] = [];
  try {
    ({ viewable: exportableStations } = await listCompanyAccess(supabase, 'members.view'));
  } catch (cause) {
    logger.error({ err: cause, organizationId }, 'could not resolve listener export scope');
  }

  return (
    <>
      <PageHeader
        title={t('members')}
        description={t('membersDescription')}
        action={
          <ExportDialog
            reportType="LISTENERS"
            companyIds={exportableStations.map((station) => station.id)}
            filters={listenersReportFilters(state)}
            // Disabled rather than hidden when there is no Station to export:
            // a button that vanishes reads as a feature that does not exist,
            // where a disabled one reads as one this caller cannot use here.
            disabled={exportableStations.length === 0}
          />
        }
      />

      {/* The registration form itself now lives in a dialog the grid opens
          (Block 3c). What stays on the page is the way to REACH a Station
          beyond listCompanyAccess's cap, because that is a navigation the
          operator asks for rather than something the record dialog does. */}
      {(registrationCapped || stationSearch) && (
        <div className="mb-6 flex flex-col gap-2">
          {registrationCapped && (
            <p className="text-xs text-muted-foreground">
              {t('showing')}{' '}{registrableStations.length + suspendedStations.length} {t('ofTheStationsYouCanRegister')}</p>
          )}
          <StationSearchForm
            action="/members"
            value={stationSearch ?? ''}
            preserve={Object.fromEntries(
              new URLSearchParams(membersHref(state).split('?')[1] ?? ''),
            )}
            label={t('findAStationToRegisterAt')}
          />
        </div>
      )}

      <MembersFilters state={state} />

      {/* The one filter that cannot be a query condition, said plainly rather
          than left for somebody to infer from a short page. member_consents
          is append-only, so "consented to the rules" means the LATEST rules
          row is a grant — a question about rows this page has already
          fetched, not one Postgres can answer while paging. */}
      {state.consent && (
        <p className="mt-4 text-xs text-muted-foreground" data-testid="member-consent-note">
          {t('rulesConsentIsCheckedAfterEach')}</p>
      )}

      <MembersGrid
        initialRows={page.rows}
        initialTotal={page.total}
        state={state}
        previousHref={
          page.previousCursor
            ? membersHref(state, { side: 'before', value: page.previousCursor })
            : null
        }
        nextHref={
          page.nextCursor ? membersHref(state, { side: 'after', value: page.nextCursor }) : null
        }
        powers={powers}
        registrableStations={registrableStations}
        suspendedStations={suspendedStations}
        initialRecord={parseRecordParam(raw as Record<string, string | undefined>, MEMBER_TABS)}
      />
    </>
  );
}

async function LoadError({ message }: { message: string }) {
  const t = await getTranslations('members');
  return (
    <>
      <PageHeader title={t('members')} />
      <Card>
        <CardContent className="pt-6">
          <p className="text-sm text-destructive">{message}</p>
        </CardContent>
      </Card>
    </>
  );
}
