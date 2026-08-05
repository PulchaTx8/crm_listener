import Link from 'next/link';
import { redirect } from 'next/navigation';
import type { Route } from 'next';
import { createUserClient } from '@/lib/supabase/user-client';
import { logger } from '@/lib/logger';
import { PageHeader } from '@/components/layout/app-shell';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { getMusicDashboard } from '@/services/dashboards';
import type { MusicDashboard } from '@/schemas/dashboards';
import { MonthlyBars } from '@/components/charts/monthly-bars';
import { BreakdownBars } from '@/components/charts/breakdown-bars';
import { TopList } from '@/components/charts/top-list';
import { listCompanyAccess, STATION_SEARCH_MAX_LENGTH } from '../../inventory/station-access';
import { StationSearchForm } from '../../inventory/station-search-form';
import type { SuspendedCompany, ViewableCompany } from '../../inventory/station-access';
import { NATIONALITY_LABELS, VOCAL_LABELS } from '../../music/format';
import { parsePeriod, periodHref, withStationSearch } from '../period';
import { describeDashboardError } from '../errors';
import { PeriodControl } from '../period-control';
import { ConsolidatedToggle } from '../consolidated-toggle';
import { DashboardCards } from '../dashboard-cards';
import type { CardSpec } from '../dashboard-cards';
import { StationPeriodNote } from '../station-period-note';
import { withOperatorLabels } from '../slice-labels';

// Renders from the caller's session cookies and a live per-Station permission
// check, so it can never be static.
export const dynamic = 'force-dynamic';

const BASE = '/dashboards/music';

// Order and labels from design spec §3.2. "Total" and "new in the period"
// are reported for both the catalogue and the requests, separately labelled,
// because the master spec never said which it meant and the two answer
// different questions. Nothing on this panel is ever withheld (D13): every
// table it reads answers to music.view alone.
const CARD_SPECS: readonly CardSpec[] = [
  { key: 'catalogue', label: 'Songs in the catalogue' },
  { key: 'new_songs', label: 'Songs added in the period' },
  { key: 'requests', label: 'Requests in the period' },
];

export default async function MusicDashboardPage({
  searchParams,
}: {
  searchParams: Promise<{
    companyId?: string | string[];
    station?: string;
    preset?: string;
    from?: string;
    to?: string;
  }>;
}) {
  const params = await searchParams;
  // The same bound listCompanyAccess enforces on its own argument, imported
  // rather than copied.
  const stationSearch = params.station?.trim().slice(0, STATION_SEARCH_MAX_LENGTH) || undefined;

  const supabase = await createUserClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  let viewable: ViewableCompany[];
  let suspended: SuspendedCompany[];
  let capped: boolean;
  try {
    ({ viewable, suspended, capped } = await listCompanyAccess(supabase, 'music.view', stationSearch));
  } catch (cause) {
    logger.error({ err: cause }, 'could not resolve music dashboard access');
    return <LoadError message={describeDashboardError(cause)} />;
  }

  const first = viewable[0];

  // A Station search that matches nothing leaves this caller with no Station
  // to show, which is not the same as holding music.view nowhere: the
  // redirect below would throw them off the screen with no way to clear the
  // search. Handled before it, so the search can always be undone.
  if (!first && stationSearch) return <NoStationMatch search={stationSearch} />;
  // A courtesy, not the boundary: 0099's select policies filter every read
  // and get_music_dashboard (0119) re-checks music.view itself before
  // counting anything.
  if (!first) redirect('/app');

  // Whether the consolidated toggle even renders is a second courtesy check,
  // for reports.consolidated rather than music.view — a failure here should
  // not take down a screen whose primary purpose (the single-Station panel)
  // does not depend on it, the same narrower catch members/page.tsx gives
  // its own courtesy registration card.
  let consolidatedEligible: ViewableCompany[] = [];
  let reportCapped = false;
  try {
    const { viewable: reportEligible, capped: consolidatedCapped } = await listCompanyAccess(
      supabase,
      'reports.consolidated',
      stationSearch,
    );
    reportCapped = consolidatedCapped;
    const reportIds = new Set(reportEligible.map((c) => c.id));
    consolidatedEligible = viewable.filter((c) => reportIds.has(c.id));
  } catch (cause) {
    logger.error({ err: cause }, 'could not resolve consolidated eligibility for the music dashboard');
  }

  // A stale, tampered, or no-longer-reachable companyId is dropped rather
  // than erroring — the same fallback templates/messages/page.tsx gives a
  // single stale id, generalised to an array for a consolidated selection.
  const requestedIds = ([] as string[]).concat(params.companyId ?? []);
  const viewableIds = new Set(viewable.map((c) => c.id));
  const validIds = Array.from(new Set(requestedIds.filter((id) => viewableIds.has(id))));
  const companyIds = validIds.length > 0 ? validIds : [first.id];

  const selection = parsePeriod(params);

  let dashboard: MusicDashboard;
  try {
    dashboard = await getMusicDashboard(companyIds, selection);
  } catch (cause) {
    logger.error({ err: cause, companyIds }, 'could not load the music dashboard');
    return <LoadError message={describeDashboardError(cause)} />;
  }

  // Whether the Station list above is the caller's WHOLE relationship or a
  // narrowed view of it (whole-branch review, Important B7). Both
  // listCompanyAccess calls are capped at fifty and both are filtered by the
  // active search term, so "All stations" is only true when neither applies —
  // and that means BOTH calls' own `capped` flag, not just the first
  // (residual from the fix wave: the second call's `capped` used to be
  // destructured away unread, so a caller holding reports.consolidated in
  // more than fifty Stations but music.view in fewer would still see "All
  // stations (N)" over a truncated intersection).
  const stationListIsComplete = !capped && !reportCapped && !stationSearch;

  return (
    <>
      <PageHeader
        title="Music"
        description="The catalogue, what the audience asked for, and how — one Station or several, side by side."
      />

      {(capped || stationSearch) && (
        <div className="mb-4 flex flex-col gap-2">
          {/* Rendered for a SEARCH as well as for the cap. A search narrows
              exactly the same list the cap does, including the one the
              consolidated toggle sums, and saying nothing about it left "All
              stations" standing over a filtered set. */}
          <p className="text-xs text-muted-foreground" data-testid="station-scope-note">
            Showing {viewable.length + suspended.length} of the Stations you can reach
            {stationSearch ? ` that match “${stationSearch}”` : ''}. A consolidated view covers
            only the Stations listed here. Search by name to reach one that is not listed.
          </p>
          <StationSearchForm
            action={BASE}
            value={stationSearch ?? ''}
            preserve={{
              ...(selection.preset !== 'current_month' ? { preset: selection.preset } : {}),
              ...(selection.from ? { from: selection.from } : {}),
              ...(selection.to ? { to: selection.to } : {}),
            }}
            label="Find a Station"
          />
        </div>
      )}

      {(viewable.length + suspended.length > 1 || consolidatedEligible.length >= 2) && (
        <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap gap-2">
            {viewable.map((company) => (
              <Link
                key={company.id}
                href={
                  withStationSearch(periodHref(BASE, selection, [company.id]), stationSearch) as Route
                }
                aria-current={
                  companyIds.length === 1 && companyIds[0] === company.id ? 'page' : undefined
                }
                className={
                  companyIds.length === 1 && companyIds[0] === company.id
                    ? 'rounded-full bg-primary px-3 py-1 text-xs font-medium text-primary-foreground'
                    : 'rounded-full border px-3 py-1 text-xs font-medium text-muted-foreground hover:bg-accent'
                }
              >
                {company.name}
              </Link>
            ))}
            {suspended.map((company) => (
              <span
                key={company.id}
                title="Suspended — no data is available while the subscription is inactive."
                className="rounded-full border border-dashed px-3 py-1 text-xs font-medium text-muted-foreground"
              >
                {company.name} (suspended)
              </span>
            ))}
          </div>

          <ConsolidatedToggle
            eligible={consolidatedEligible.length >= 2}
            base={BASE}
            period={selection}
            stationSearch={stationSearch}
            active={companyIds.length > 1}
            singleCompanyId={first.id}
            consolidatedCompanyIds={consolidatedEligible.map((c) => c.id)}
            complete={stationListIsComplete}
          />
        </div>
      )}

      <PeriodControl
        base={BASE}
        selection={selection}
        resolved={dashboard.period}
        companyIds={companyIds}
        stationSearch={stationSearch}
      />

      <StationPeriodNote stations={dashboard.stations} />

      <DashboardCards specs={CARD_SPECS} cards={dashboard.cards} withheld={dashboard.withheld} />

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Monthly requests</CardTitle>
          </CardHeader>
          <CardContent>
            <MonthlyBars data={dashboard.monthly} label="Monthly requests" />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Domestic × international</CardTitle>
          </CardHeader>
          <CardContent>
            {/* `key` is the raw music_nationality value; NATIONALITY_LABELS
                is the wording the Songs grid already uses (whole-branch
                review, Important B2). The NOT_STATED bucket carries its own
                human label from SQL and passes through untouched — it was the
                mix of the two on one axis that gave this away. */}
            <BreakdownBars
              data={withOperatorLabels(dashboard.breakdowns.nationality, NATIONALITY_LABELS)}
              label="Domestic × international"
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Vocal</CardTitle>
          </CardHeader>
          <CardContent>
            <BreakdownBars
              data={withOperatorLabels(dashboard.breakdowns.vocal, VOCAL_LABELS)}
              label="Vocal"
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Most requested songs</CardTitle>
          </CardHeader>
          <CardContent>
            <TopList data={dashboard.top.songs} label="Most requested songs" />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Most requested genres</CardTitle>
          </CardHeader>
          <CardContent>
            <TopList data={dashboard.top.genres} label="Most requested genres" />
          </CardContent>
        </Card>
      </div>
    </>
  );
}

function NoStationMatch({ search }: { search: string }) {
  return (
    <>
      <PageHeader title="Music" />
      <Card>
        <CardContent className="flex flex-col gap-3 pt-6">
          <p className="text-sm text-muted-foreground">
            No Station you can reach matches “{search}”.
          </p>
          <Link href={BASE as Route} className="text-sm text-primary underline underline-offset-2">
            Clear the Station search
          </Link>
        </CardContent>
      </Card>
    </>
  );
}

function LoadError({ message }: { message: string }) {
  return (
    <>
      <PageHeader title="Music" />
      <Card>
        <CardContent className="pt-6">
          <p className="text-sm text-destructive">{message}</p>
        </CardContent>
      </Card>
    </>
  );
}
