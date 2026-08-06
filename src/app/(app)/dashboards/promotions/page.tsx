import Link from 'next/link';
import { redirect } from 'next/navigation';
import type { Route } from 'next';
import { createUserClient } from '@/lib/supabase/user-client';
import { logger } from '@/lib/logger';
import { PageHeader } from '@/components/layout/app-shell';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { getPromotionsDashboard } from '@/services/dashboards';
import type { PromotionsDashboard } from '@/schemas/dashboards';
import { MonthlyBars } from '@/components/charts/monthly-bars';
import { SplitDonut } from '@/components/charts/split-donut';
import { TopList } from '@/components/charts/top-list';
import { listCompanyAccess, STATION_SEARCH_MAX_LENGTH } from '../../inventory/station-access';
import { StationSearchForm } from '../../inventory/station-search-form';
import type { SuspendedCompany, ViewableCompany } from '../../inventory/station-access';
import { STATUS_LABELS as PARTICIPATION_STATUS_LABELS } from '@/lib/participation-status';
import { STATUS_LABELS as WINNER_STATUS_LABELS } from '../../pickups/list-params';
import { parsePeriod, periodHref, withStationSearch } from '../period';
import { describeDashboardError } from '../errors';
import { PeriodControl } from '../period-control';
import { ConsolidatedToggle } from '../consolidated-toggle';
import { DashboardCards, WithheldFigure } from '../dashboard-cards';
import type { CardSpec } from '../dashboard-cards';
import { StationPeriodNote } from '../station-period-note';
import { ExportDialog } from '@/components/reports/export-dialog';
import { withOperatorLabels } from '../slice-labels';

// Renders from the caller's session cookies and a live per-Station permission
// check, so it can never be static.
export const dynamic = 'force-dynamic';

const BASE = '/dashboards/promotions';

// Order and labels from design spec §3.3. `live_now` and `overdue` carry no
// `previous` at all — facts about this instant, not the chosen period — and
// DashboardCards renders whichever of `current`/`previous` the payload
// actually sent, never inventing the missing one. `participations` and
// `distinct_participants` are withheld together without participations.view
// (D13); the prize cycle (`awarded`, `overdue`) is unaffected, because
// `winners` answers to promotions.view alone.
const CARD_SPECS: readonly CardSpec[] = [
  { key: 'live_now', label: 'On air now' },
  { key: 'ended', label: 'Ended in the period' },
  { key: 'participations', label: 'Participations' },
  { key: 'distinct_participants', label: 'Distinct listeners taking part' },
  { key: 'awarded', label: 'Prizes awarded' },
  { key: 'overdue', label: 'Overdue and uncollected' },
];

export default async function PromotionsDashboardPage({
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
    ({ viewable, suspended, capped } = await listCompanyAccess(
      supabase,
      'promotions.view',
      stationSearch,
    ));
  } catch (cause) {
    logger.error({ err: cause }, 'could not resolve promotions dashboard access');
    return <LoadError message={describeDashboardError(cause)} />;
  }

  const first = viewable[0];

  // A Station search that matches nothing leaves this caller with no Station
  // to show, which is not the same as holding promotions.view nowhere: the
  // redirect below would throw them off the screen with no way to clear the
  // search. Handled before it, so the search can always be undone.
  if (!first && stationSearch) return <NoStationMatch search={stationSearch} />;
  // A courtesy, not the boundary: 0044's select policies filter every read
  // and get_promotions_dashboard (0120) re-checks promotions.view itself
  // before counting anything.
  if (!first) redirect('/app');

  // Whether the consolidated toggle even renders is a second courtesy check,
  // for reports.consolidated rather than promotions.view — a failure here
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
    logger.error(
      { err: cause },
      'could not resolve consolidated eligibility for the promotions dashboard',
    );
  }

  // A stale, tampered, or no-longer-reachable companyId is dropped rather
  // than erroring — the same fallback templates/messages/page.tsx gives a
  // single stale id, generalised to an array for a consolidated selection.
  const requestedIds = ([] as string[]).concat(params.companyId ?? []);
  const viewableIds = new Set(viewable.map((c) => c.id));
  const validIds = Array.from(new Set(requestedIds.filter((id) => viewableIds.has(id))));
  const companyIds = validIds.length > 0 ? validIds : [first.id];

  const selection = parsePeriod(params);

  let dashboard: PromotionsDashboard;
  try {
    dashboard = await getPromotionsDashboard(companyIds, selection);
  } catch (cause) {
    logger.error({ err: cause, companyIds }, 'could not load the promotions dashboard');
    return <LoadError message={describeDashboardError(cause)} />;
  }

  // Whether the Station list above is the caller's WHOLE relationship or a
  // narrowed view of it (whole-branch review, Important B7). Both
  // listCompanyAccess calls are capped at fifty and both are filtered by the
  // active search term, so "All stations" is only true when neither applies —
  // and that means BOTH calls' own `capped` flag, not just the first
  // (residual from the fix wave: the second call's `capped` used to be
  // destructured away unread, so a caller holding reports.consolidated in
  // more than fifty Stations but promotions.view in fewer would still see
  // "All stations (N)" over a truncated intersection).
  const stationListIsComplete = !capped && !reportCapped && !stationSearch;

  // `monthly`, `breakdowns.participation_status` and `top.promotions` are the
  // three payload keys D13 can omit OUTSIDE `cards` (0120's own header): an
  // absent key here is not a defect to paper over with an empty chart — an
  // empty twelve-month chart reads as "nobody took part", the same false
  // claim a zero card would make. `neededFor` looks the permission up from
  // the payload's own `withheld` array rather than hard-coding
  // `participations.view` three times over.
  function neededFor(figure: string): string | undefined {
    return dashboard.withheld.find((w) => w.figure === figure)?.needs;
  }

  return (
    <>
      <PageHeader
        title="Promotions"
        description="What is on air, who took part, and how the prize cycle is moving — one Station or several, side by side."
        // Block 8b. The Stations and the period ALREADY RESOLVED above, not a
        // second set the dialog asks for: this panel's PDF must carry the
        // figures on this screen, and the only way to guarantee that is to
        // hand the export the same arguments the aggregate just took.
        action={
          <ExportDialog reportType="PROMOTIONS_PANEL" companyIds={companyIds} filters={selection} />
        }
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
            <CardTitle>Monthly participations</CardTitle>
          </CardHeader>
          <CardContent>
            {dashboard.monthly ? (
              <MonthlyBars data={dashboard.monthly} label="Monthly participations" />
            ) : (
              <WithheldFigure needs={neededFor('monthly')} />
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>The prize cycle</CardTitle>
          </CardHeader>
          <CardContent>
            {/* `key` is the raw winner_status value; the pickups screen's own
                STATUS_LABELS is the wording an operator already reads on that
                list's badges and buttons (whole-branch review, Important B2).
                One vocabulary for winner_status, not two. */}
            <SplitDonut
              data={withOperatorLabels(dashboard.breakdowns.prize_cycle, WINNER_STATUS_LABELS)}
              label="The prize cycle"
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Why entries were refused</CardTitle>
          </CardHeader>
          <CardContent>
            {dashboard.breakdowns.participation_status ? (
              <SplitDonut
                data={withOperatorLabels(
                  dashboard.breakdowns.participation_status,
                  PARTICIPATION_STATUS_LABELS,
                )}
                label="Why entries were refused"
              />
            ) : (
              <WithheldFigure needs={neededFor('participation_status')} />
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Busiest promotions</CardTitle>
          </CardHeader>
          <CardContent>
            {dashboard.top.promotions ? (
              <TopList data={dashboard.top.promotions} label="Busiest promotions" />
            ) : (
              <WithheldFigure needs={neededFor('promotions')} />
            )}
          </CardContent>
        </Card>
      </div>
    </>
  );
}

function NoStationMatch({ search }: { search: string }) {
  return (
    <>
      <PageHeader title="Promotions" />
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
      <PageHeader title="Promotions" />
      <Card>
        <CardContent className="pt-6">
          <p className="text-sm text-destructive">{message}</p>
        </CardContent>
      </Card>
    </>
  );
}
