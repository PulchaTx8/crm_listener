import { getTranslations } from 'next-intl/server';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { createUserClient } from '@/lib/supabase/user-client';
import { logger } from '@/lib/logger';
import { stationSwitchHref } from '@/lib/station-switch';
import { PageHeader } from '@/components/layout/app-shell';
import { Card, CardContent } from '@/components/ui/card';
import { parseRecordParam, SHOW_TABS } from '@/lib/record-params';
import { SHOW_SEARCH_MAX_LENGTH, listShows, listShowsForWeek } from '@/services/shows';
import type { ShowList } from '@/services/shows';
import { isoWeekStart, layOutWeek, weekDays } from '@/lib/shows/week-grid';
import { STATION_SEARCH_MAX_LENGTH, listCompanyAccess } from '../inventory/station-access';
import { getMusicPermissions } from '../music/permissions';
import { StationSearchForm } from '../inventory/station-search-form';
import type { SuspendedCompany, ViewableCompany } from '../inventory/station-access';
import { ShowsFilters } from './shows-filters';
import { ShowsGrid } from './shows-grid';
import { ScheduleBoard } from './schedule-board';
import { parseShowListState } from './list-params';
import type { ShowSearchParams } from './list-params';

/**
 * Block 18. Programmes — now filed under **Promotions**, directly after
 * Pickups (`src/lib/auth/shell.ts`). Its third section in twelve blocks:
 * Audience filed it in Block 18, Catalog took it in Block 27, and Block 30c
 * moved it here, on the owner's ruling of 2026-08-19, because a promotion can
 * now name the Programme it belongs to. The nav entry's own comment carries
 * the full history; this header only needs to stop claiming a section the
 * screen has since left twice.
 *
 * THE SCREEN IS `/music/songs` WITH DIFFERENT COLUMNS, deliberately: the same
 * Station switcher, the same URL-driven filter bar, the same keyset paging and
 * the same record-as-a-modal. An operator who has registered a song already
 * knows how to register a programme, and a second layout for the same job would
 * only be a second thing to maintain.
 *
 * THE PERMISSION IS STILL A MUSIC ONE, and that is recorded rather than
 * accidental: `shows` carries exactly one policy, gated on `music.view`, and it
 * has no insert or update policy at all. Neither move has ever moved the
 * permission with it, so a member who administers Promotions today (or,
 * before Block 27, the audience) and holds nothing in music cannot open this.
 * Block 30c found a second surface of the identical mismatch: the Programme
 * combobox on a promotion's own record (`listShowOptions`) is gated the same
 * way, and reads as an empty list rather than a broken link.
 *
 * A `shows.view` / `shows.manage` pair is not two rows in a table — it is a
 * permissions migration, the roles screen, every seeded role, PERMISSIONS.md,
 * and above all EVERY ROLE A CUSTOMER HAS ALREADY CONFIGURED, none of which
 * would grant it. Shipping this screen behind a permission nobody holds would
 * hide it from everyone. `docs/PERMISSIONS.md`'s "Programmes are gated on
 * music" section carries the full reasoning, including why re-gating on a
 * Promotions permission instead was also rejected.
 */
export const dynamic = 'force-dynamic';

export default async function ShowsPage({
  searchParams,
}: {
  searchParams: Promise<ShowSearchParams>;
}) {
  const t = await getTranslations('shows');
  const params = await searchParams;
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
    logger.error({ err: cause }, 'could not resolve programme access');
    return <LoadError message={t('couldNotReadTheProgrammes')} />;
  }

  const first = viewable[0];
  // A Station search matching nothing is not the same as holding music.view
  // nowhere: handled first, so the search can always be undone.
  if (!first && stationSearch) return <NoStationMatch search={stationSearch} />;
  if (!first) redirect('/app');

  const selected = viewable.find((c) => c.id === params.companyId) ?? first;
  const state = parseShowListState(params, selected.id);

  /**
   * WHOSE TODAY, decided once and in the Station's zone.
   *
   * Every date this screen draws — the week it opens on, the column it marks,
   * the minute the now-line sits at — is a wall-clock question, and
   * `companies.timezone` is whose wall it is. The trap is the one
   * `shows_on_air` (0175) documents on itself: read from the server's own clock
   * a schedule passes every suite run in the afternoon and is wrong at 21:00.
   */
  const at = new Date();
  const stationToday = new Intl.DateTimeFormat('en-CA', {
    timeZone: selected.timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at);
  const stationClock = new Intl.DateTimeFormat('en-GB', {
    timeZone: selected.timezone,
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
  }).format(at);

  const weekStart = state.week ?? isoWeekStart(stationToday);
  const days = weekDays(weekStart);
  const weekEnd = days[6]?.date ?? weekStart;
  // The state every link on this screen is built from carries the week actually
  // drawn, never the absent one: an arrow built from `undefined` would name the
  // week before whichever week the NEXT render happened to default to.
  const drawn = { ...state, week: weekStart };

  if (state.view === 'schedule') {
    let week: Awaited<ReturnType<typeof listShowsForWeek>>;
    try {
      week = await listShowsForWeek({
        companyId: state.companyId,
        search: state.search?.slice(0, SHOW_SEARCH_MAX_LENGTH),
        kind: state.kind,
        weekStart,
        weekEnd,
      });
    } catch (cause) {
      logger.error({ err: cause, companyId: state.companyId }, 'could not read the programme week');
      return <LoadError message={t('couldNotReadTheProgrammes')} />;
    }

    const permissions = await getMusicPermissions(supabase, selected.id);
    const inThisWeek = stationToday >= weekStart && stationToday <= weekEnd;
    const [hours = '0', minutes = '0'] = stationClock.split(':');

    return (
      <>
        <PageHeader title={t('programmes')} description={t('programmesDescription')} />
        <StationChoice
          capped={capped}
          stationSearch={stationSearch}
          viewable={viewable}
          suspended={suspended}
          selectedId={selected.id}
        />
        <ShowsFilters state={drawn} />
        <ScheduleBoard
          blocks={layOutWeek(week.rows, days)}
          days={days}
          state={drawn}
          manage={permissions.manage}
          capped={week.capped}
          nowMinutes={inThisWeek ? Number(hours) * 60 + Number(minutes) : null}
          todayDate={inThisWeek ? stationToday : null}
          initialRecord={parseRecordParam(params as Record<string, string | undefined>, SHOW_TABS)}
        />
      </>
    );
  }

  let page: ShowList;
  try {
    page = await listShows({
      companyId: state.companyId,
      search: state.search?.slice(0, SHOW_SEARCH_MAX_LENGTH),
      kind: state.kind,
      includeEnded: state.includeEnded,
      sort: state.sort,
      direction: state.direction,
    });
  } catch (cause) {
    logger.error({ err: cause, companyId: state.companyId }, 'could not read programmes');
    return <LoadError message={t('couldNotReadTheProgrammes')} />;
  }

  // `music.manage` decides whether the register button and the row menu appear.
  // It is a courtesy rather than the boundary: save_show and end_show each
  // re-check it against auth.uid() before writing anything.
  const permissions = await getMusicPermissions(supabase, selected.id);

  return (
    <>
      <PageHeader title={t('programmes')} description={t('programmesDescription')} />

      <StationChoice
        capped={capped}
        stationSearch={stationSearch}
        viewable={viewable}
        suspended={suspended}
        selectedId={selected.id}
      />

      <ShowsFilters state={drawn} />

      <ShowsGrid
        initialRows={page.rows}
        initialTotal={page.total}
        state={state}
        capped={page.capped}
        manage={permissions.manage}
        initialRecord={parseRecordParam(params as Record<string, string | undefined>, SHOW_TABS)}
      />
    </>
  );
}

async function NoStationMatch({ search }: { search: string }) {
  const t = await getTranslations('shows');
  return (
    <>
      <PageHeader title={t('programmes')} />
      <Card>
        <CardContent className="flex flex-col gap-3 pt-6">
          <p className="text-sm text-muted-foreground">{t('noStationMatches', { search })}</p>
          <Link href="/shows" className="text-sm text-primary underline underline-offset-2">
            {t('clearTheStationSearch')}
          </Link>
        </CardContent>
      </Card>
    </>
  );
}

async function LoadError({ message }: { message: string }) {
  const t = await getTranslations('shows');
  return (
    <>
      <PageHeader title={t('programmes')} />
      <Card>
        <CardContent className="pt-6">
          <p className="text-sm text-destructive">{message}</p>
        </CardContent>
      </Card>
    </>
  );
}

/**
 * The Station chooser, shared by both views of this screen (Block 30e, item 12).
 *
 * Extracted rather than duplicated: the list and the week grid are two renders of
 * the same screen, and a second copy of these pills is how one view keeps a
 * Station search the other drops.
 */
async function StationChoice({
  capped,
  stationSearch,
  viewable,
  suspended,
  selectedId,
}: {
  capped: boolean;
  stationSearch: string | undefined;
  viewable: ViewableCompany[];
  suspended: SuspendedCompany[];
  selectedId: string;
}) {
  const t = await getTranslations('shows');

  return (
    <>
      {(capped || stationSearch) && (
        <div className="mb-4 flex flex-col gap-2">
          {capped && (
            <p className="text-xs text-muted-foreground">
              {t('showingOfTheStationsYouCanReach', { count: viewable.length + suspended.length })}
            </p>
          )}
          <StationSearchForm
            action="/shows"
            value={stationSearch ?? ''}
            preserve={{}}
            label={t('findAStation')}
          />
        </div>
      )}

      {viewable.length + suspended.length > 1 && (
        <div className="mb-6 flex flex-wrap gap-2">
          {viewable.map((company) => (
            <Link
              key={company.id}
              href={stationSwitchHref('/shows', company.id, stationSearch)}
              aria-current={company.id === selectedId ? 'page' : undefined}
              className={
                company.id === selectedId
                  ? 'rounded-full bg-primary px-3 py-1 text-xs font-medium text-primary-foreground'
                  : 'rounded-full border px-3 py-1 text-xs font-medium text-muted-foreground hover:bg-accent'
              }
            >
              {company.name}
            </Link>
          ))}
          {/* A suspended Station stays visible so the UI can explain why access
              stopped, then fails has_permission unconditionally. Rendered
              disabled with the reason instead of silently vanishing. */}
          {suspended.map((company) => (
            <span
              key={company.id}
              title={t('suspendedNoDataIsAvailable')}
              className="rounded-full border border-dashed px-3 py-1 text-xs font-medium text-muted-foreground"
            >
              {company.name}
            </span>
          ))}
        </div>
      )}
    </>
  );
}
