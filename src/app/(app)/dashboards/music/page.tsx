import { getTranslations } from 'next-intl/server';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import type { Route } from 'next';
import { createUserClient } from '@/lib/supabase/user-client';
import { logger } from '@/lib/logger';
import { PageHeader } from '@/components/layout/app-shell';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { getMusicDashboard } from '@/services/dashboards';
import { getMusicGeography } from '@/services/geography';
import type { MusicGeography } from '@/schemas/geography';
import type { MusicDashboard, Slice } from '@/schemas/dashboards';
import { coversForSongs } from '@/services/music';
import { coverUrl } from '@/lib/integrations/deezer/cover';
import { MonthlyBars } from '@/components/charts/monthly-bars';
import { BreakdownBars } from '@/components/charts/breakdown-bars';
import { TopList } from '@/components/charts/top-list';
import { listCompanyAccess, STATION_SEARCH_MAX_LENGTH } from '../../inventory/station-access';
import { StationSearchForm } from '../../inventory/station-search-form';
import type { SuspendedCompany, ViewableCompany } from '../../inventory/station-access';
import { NATIONALITY_LABEL_KEYS, VOCAL_LABEL_KEYS } from '../../music/format';
import { parsePeriod } from '../period';
import { describeDashboardError } from '../errors';
import { PeriodControl } from '../period-control';
import { StationSelection } from '../station-selection';
import { GeographyPanel } from '../geography-panel';
import { DashboardCards } from '../dashboard-cards';
import type { CardSpec } from '../dashboard-cards';
import { StationPeriodNote } from '../station-period-note';
import { ExportDialog } from '@/components/reports/export-dialog';
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
//
// A function taking `t` rather than a module-level constant, for the reason
// the audience panel's own cardSpecs already gives: a module body has no
// request behind it, so it has no language either.
function cardSpecs(t: (key: string) => string): CardSpec[] {
  return [
    { key: 'catalogue', label: t('songsInTheCatalogue') },
    { key: 'new_songs', label: t('songsAddedInThePeriod') },
    { key: 'requests', label: t('requestsInThePeriod') },
  ];
}

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
    ({ viewable, suspended, capped } = await listCompanyAccess(supabase, 'music.view', stationSearch));
  } catch (cause) {
    logger.error({ err: cause }, 'could not resolve music dashboard access');
    return <LoadError message={describeDashboardError(cause, t)} />;
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
    return <LoadError message={describeDashboardError(cause, t)} />;
  }

  // Block 28. Its own try/catch, for the reason the audience page's own
  // geography read states: a failure here costs the map, never the cards.
  let geography: MusicGeography | null = null;
  try {
    geography = await getMusicGeography(companyIds, selection);
  } catch (cause) {
    logger.error({ err: cause, companyIds }, 'could not load the music geography');
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
        title={t('music')}
        description={t('musicDescription')}
        // Block 8b. The Stations and the period ALREADY RESOLVED above, not a
        // second set the dialog asks for: this panel's PDF must carry the
        // figures on this screen, and the only way to guarantee that is to
        // hand the export the same arguments the aggregate just took.
        action={
          <ExportDialog reportType="MUSIC_PANEL" companyIds={companyIds} filters={selection} />
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

      {/* ONE STATION CONTROL, in the corner the switcher row used to hold. Both
          rows carried the same names and differed only in what a click meant,
          which is a distinction an operator had to be told rather than shown;
          StationSelection now carries it per pill. */}
      {(viewable.length + suspended.length > 1 || consolidatedEligible.length >= 2) && (
        <div className="mb-6">
          <StationSelection
            base={BASE}
            period={selection}
            stationSearch={stationSearch}
            singleCompanyId={first.id}
            viewable={viewable}
            suspended={suspended}
            consolidatedCompanyIds={consolidatedEligible.map((c) => c.id)}
            // `companyIds`, not `params.companyId`: this is the selection the
            // page actually resolved and read the panel with, after a stale or
            // tampered id was dropped above. A control drawn from the raw URL
            // would show a pill lit for a Station whose figures are not on the
            // screen.
            selectedIds={companyIds}
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

      <DashboardCards specs={cardSpecs(t)} cards={dashboard.cards} withheld={dashboard.withheld} />

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>{t('monthlyRequests')}</CardTitle>
          </CardHeader>
          <CardContent>
            <MonthlyBars data={dashboard.monthly} label={t('monthlyRequests')} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{t('domesticInternational')}</CardTitle>
          </CardHeader>
          <CardContent>
            {/* `key` is the raw music_nationality value; NATIONALITY_LABEL_KEYS
                is the wording the Songs grid already uses (whole-branch
                review, Important B2). The NOT_STATED bucket carries its own
                human label from SQL and passes through untouched — it was the
                mix of the two on one axis that gave this away. */}
            <BreakdownBars
              data={withOperatorLabels(dashboard.breakdowns.nationality, NATIONALITY_LABEL_KEYS, tv)}
              label={t('domesticInternational')}
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{t('vocal')}</CardTitle>
          </CardHeader>
          <CardContent>
            <BreakdownBars
              data={withOperatorLabels(dashboard.breakdowns.vocal, VOCAL_LABEL_KEYS, tv)}
              label={t('vocal')}
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{t('mostRequestedSongs')}</CardTitle>
          </CardHeader>
          <CardContent>
            {/*
              get_music_dashboard (0119) returns title and count and no cover.
              Rather than DROP + CREATE a 290-line SECURITY INVOKER function
              with its own test suite to add one field, the covers for the ten
              rows it did return are read here, in one scoped query.
            */}
            <TopList
              data={dashboard.top.songs}
              label={t('mostRequestedSongs')}
              covers={await songCoverUrls(dashboard.top.songs)}
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{t('mostRequestedGenres')}</CardTitle>
          </CardHeader>
          <CardContent>
            <TopList data={dashboard.top.genres} label={t('mostRequestedGenres')} />
          </CardContent>
        </Card>
      </div>

      {geography && (
        <GeographyPanel
          title={t('whereTheMusicIsAskedFor')}
          places={geography.places}
          withPlace={geography.with_place}
          total={geography.total}
          // The music panel's extra table: the most-requested song in each
          // place, which is the whole reason this map differs from the
          // audience one.
          songs={geography.places}
        />
      )}
    </>
  );
}

async function NoStationMatch({ search }: { search: string }) {
  const t = await getTranslations('dashboards');
  return (
    <>
      <PageHeader title={t('music')} />
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
      <PageHeader title={t('music')} />
      <Card>
        <CardContent className="pt-6">
          <p className="text-sm text-destructive">{message}</p>
        </CardContent>
      </Card>
    </>
  );
}

/**
 * Cover URLs for the ten songs the aggregate ranked, keyed by song id.
 *
 * URLs rather than hashes, because the consumer is an SVG `<image href>` inside
 * a chart tick and coverUrl is a server-safe pure function — building them here
 * keeps the client component free of the CDN host, which lives in exactly two
 * places (cover.ts and the CSP) and should not gain a third.
 *
 * Songs with no album, or with one this caller cannot read, are simply absent
 * from the map and their row renders the plain label it always did.
 */
async function songCoverUrls(slices: Slice[]): Promise<Map<string, string>> {
  const ids = slices.map((slice) => slice.id).filter((id): id is string => Boolean(id));
  const hashes = await coversForSongs(ids);

  const urls = new Map<string, string>();
  for (const [songId, md5] of hashes) {
    const url = coverUrl(md5, 56);
    if (url) urls.set(songId, url);
  }
  return urls;
}
