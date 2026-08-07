import { getTranslations } from 'next-intl/server';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import type { Route } from 'next';
import { createUserClient } from '@/lib/supabase/user-client';
import { logger } from '@/lib/logger';
import { PageHeader } from '@/components/layout/app-shell';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { getAudienceDashboard } from '@/services/dashboards';
import type { AudienceDashboard } from '@/schemas/dashboards';
import { MonthlyBars } from '@/components/charts/monthly-bars';
import { BreakdownBars } from '@/components/charts/breakdown-bars';
import { TopList } from '@/components/charts/top-list';
import { listCompanyAccess, STATION_SEARCH_MAX_LENGTH } from '../../inventory/station-access';
import { StationSearchForm } from '../../inventory/station-search-form';
import type { SuspendedCompany, ViewableCompany } from '../../inventory/station-access';
import { BLOCK_KIND_LABEL_KEYS } from '../../members/format';
import { parsePeriod, periodHref, withStationSearch } from '../period';
import { describeDashboardError } from '../errors';
import { PeriodControl } from '../period-control';
import { ConsolidatedToggle } from '../consolidated-toggle';
import { DashboardCards } from '../dashboard-cards';
import type { CardSpec } from '../dashboard-cards';
import { StationPeriodNote } from '../station-period-note';
import { ExportDialog } from '@/components/reports/export-dialog';
import { withOperatorLabels } from '../slice-labels';

// Renders from the caller's session cookies and a live per-Station permission
// check, so it can never be static.
export const dynamic = 'force-dynamic';

const BASE = '/dashboards/audience';

// Order and labels from design spec §3.1. `took_part` has no card in
// `cards` for a caller lacking participations.view — it is named in
// `withheld` instead (D13), and DashboardCards renders that tile identically
// to every other withheld figure without this list knowing the difference.
//
// A function rather than a constant because of the caveat (whole-branch
// review, Important B5): all four of these count DISTINCT MEMBERS, so in a
// consolidated view none of them is the sum of the single-Station figures —
// a listener reachable from two selected Stations is one listener. Only
// `barred` used to say so, and only under its own chart, which made a
// property of the whole panel read as a quirk of that one bar.
// `t` is threaded in rather than read here because this sits outside the page
// component: the caveat and the four labels it hangs under render in the same
// tile, and a tile with a translated caveat over an English label reads worse
// than either language on its own.
function cardSpecs(consolidated: boolean, t: (key: string) => string): CardSpec[] {
  const note = consolidated ? t('countsDistinctListenersOneReachable') : undefined;
  return [
    { key: 'listeners', label: t('listenersAtThisStation'), note },
    { key: 'new_listeners', label: t('newInThePeriod'), note },
    { key: 'took_part', label: t('tookPartInThePeriod'), note },
    { key: 'barred', label: t('listenersBarredInThePeriod'), note },
  ];
}

export default async function AudienceDashboardPage({
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
  const t = await getTranslations('dashboards');
  // The shared enum vocabulary, which several screens render.
  const tv = await getTranslations('vocab');
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
    ({ viewable, suspended, capped } = await listCompanyAccess(supabase, 'members.view', stationSearch));
  } catch (cause) {
    logger.error({ err: cause }, 'could not resolve audience dashboard access');
    return <LoadError message={describeDashboardError(cause, t)} />;
  }

  const first = viewable[0];

  // A Station search that matches nothing leaves this caller with no Station
  // to show, which is not the same as holding members.view nowhere: the
  // redirect below would throw them off the screen with no way to clear the
  // search. Handled before it, so the search can always be undone.
  if (!first && stationSearch) return <NoStationMatch search={stationSearch} />;
  // A courtesy, not the boundary: 0035's select policies filter every read
  // and get_audience_dashboard (0118) re-checks members.view itself before
  // counting anything.
  if (!first) redirect('/app');

  // Whether the consolidated toggle even renders is a second courtesy check,
  // for reports.consolidated rather than members.view — a failure here
  // should not take down a screen whose primary purpose (the single-Station
  // panel) does not depend on it, the same narrower catch members/page.tsx
  // gives its own courtesy registration card.
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
    logger.error({ err: cause }, 'could not resolve consolidated eligibility for the audience dashboard');
  }

  // A stale, tampered, or no-longer-reachable companyId (access revoked since
  // a link was generated or shared, or a hand-edited URL) is dropped rather
  // than erroring — the same fallback templates/messages/page.tsx gives a
  // single stale id, generalised to an array for a consolidated selection.
  // D3 is not restated here: which ids ended up in reports.consolidated is
  // irrelevant to what gets REQUESTED — the RPC below refuses regardless of
  // what this page or the toggle offered.
  const requestedIds = ([] as string[]).concat(params.companyId ?? []);
  const viewableIds = new Set(viewable.map((c) => c.id));
  const validIds = Array.from(new Set(requestedIds.filter((id) => viewableIds.has(id))));
  const companyIds = validIds.length > 0 ? validIds : [first.id];

  const selection = parsePeriod(params);

  let dashboard: AudienceDashboard;
  try {
    dashboard = await getAudienceDashboard(companyIds, selection);
  } catch (cause) {
    logger.error({ err: cause, companyIds }, 'could not load the audience dashboard');
    return <LoadError message={describeDashboardError(cause, t)} />;
  }

  // Whether the Station list above is the caller's WHOLE relationship or a
  // narrowed view of it (whole-branch review, Important B7). Both
  // listCompanyAccess calls are capped at fifty and both are filtered by the
  // active search term, so "All stations" is only true when neither applies —
  // and that means BOTH calls' own `capped` flag, not just the first
  // (residual from the fix wave: the second call's `capped` used to be
  // destructured away unread, so a caller holding reports.consolidated in
  // more than fifty Stations but members.view in fewer would still see "All
  // stations (N)" over a truncated intersection).
  const stationListIsComplete = !capped && !reportCapped && !stationSearch;

  return (
    <>
      <PageHeader
        title={t('audience')}
        description={t('audienceDescription')}
        // Block 8b. The Stations and the period ALREADY RESOLVED above, not a
        // second set the dialog asks for: this panel's PDF must carry the
        // figures on this screen, and the only way to guarantee that is to
        // hand the export the same arguments getAudienceDashboard just took.
        action={
          <ExportDialog reportType="AUDIENCE_PANEL" companyIds={companyIds} filters={selection} />
        }
      />

      {(capped || stationSearch) && (
        <div className="mb-4 flex flex-col gap-2">
          {/* Rendered for a SEARCH as well as for the cap. A search narrows
              exactly the same list the cap does, including the one the
              consolidated toggle sums, and saying nothing about it left "All
              stations" standing over a filtered set. */}
          {/* One whole message per branch, not a stem with a clause glued on:
              the search phrase lands in the middle of the sentence in English
              and nowhere near the middle in Portuguese. */}
          <p className="text-xs text-muted-foreground" data-testid="station-scope-note">
            {stationSearch
              ? t('stationScopeNoteFiltered', {
                  count: viewable.length + suspended.length,
                  search: stationSearch,
                })
              : t('stationScopeNote', { count: viewable.length + suspended.length })}
          </p>
          <StationSearchForm
            action={BASE}
            value={stationSearch ?? ''}
            preserve={{
              ...(selection.preset !== 'current_month' ? { preset: selection.preset } : {}),
              ...(selection.from ? { from: selection.from } : {}),
              ...(selection.to ? { to: selection.to } : {}),
            }}
            label={t('findAStation')}
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
                title={t('suspendedNoDataIsAvailableWhile')}
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

      <DashboardCards
        specs={cardSpecs(dashboard.stations.length > 1, t)}
        cards={dashboard.cards}
        withheld={dashboard.withheld}
      />

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>{t('monthlyArrivals')}</CardTitle>
          </CardHeader>
          <CardContent>
            <MonthlyBars data={dashboard.monthly} label={t('monthlyArrivals')} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{t('barredByKind')}</CardTitle>
          </CardHeader>
          <CardContent>
            {/* A member barred both ways counts in both bars, and an
                Organization-wide bar counts once across every Station
                selected — the bar figure above is therefore not always the
                sum of the two kinds shown here (design spec §3.1). */}
            {dashboard.stations.length > 1 && (
              <p className="mb-2 text-xs text-muted-foreground">
                {t('countsDistinctListenersAnOrganizationWide')}</p>
            )}
            {/* `key` is the raw member_block_kind value; BLOCK_KIND_LABEL_KEYS is
                the wording the audience record already uses for the same two
                (whole-branch review, Important B2) — not a second vocabulary
                invented here. */}
            <BreakdownBars
              data={withOperatorLabels(dashboard.breakdowns.blocks_by_kind, BLOCK_KIND_LABEL_KEYS, tv)}
              label={t('barredByKind')}
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{t('howTheyWereFound')}</CardTitle>
          </CardHeader>
          <CardContent>
            <TopList data={dashboard.top.discovery_source} label={t('howTheyWereFound')} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{t('firstContact')}</CardTitle>
          </CardHeader>
          <CardContent>
            <TopList data={dashboard.top.first_contact_origin} label={t('firstContact')} />
          </CardContent>
        </Card>
      </div>
    </>
  );
}

async function NoStationMatch({ search }: { search: string }) {
  const t = await getTranslations('dashboards');
  return (
    <>
      <PageHeader title={t('audience')} />
      <Card>
        <CardContent className="flex flex-col gap-3 pt-6">
          <p className="text-sm text-muted-foreground">
            {t('noStationYouCanReachMatches', { search })}
          </p>
          <Link href={BASE as Route} className="text-sm text-primary underline underline-offset-2">
            {t('clearTheStationSearch')}</Link>
        </CardContent>
      </Card>
    </>
  );
}

async function LoadError({ message }: { message: string }) {
  const t = await getTranslations('dashboards');
  return (
    <>
      <PageHeader title={t('audience')} />
      <Card>
        <CardContent className="pt-6">
          <p className="text-sm text-destructive">{message}</p>
        </CardContent>
      </Card>
    </>
  );
}
