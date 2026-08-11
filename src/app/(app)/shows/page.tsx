import { getTranslations } from 'next-intl/server';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { createUserClient } from '@/lib/supabase/user-client';
import { logger } from '@/lib/logger';
import { stationSwitchHref } from '@/lib/station-switch';
import { PageHeader } from '@/components/layout/app-shell';
import { Card, CardContent } from '@/components/ui/card';
import { decodeCursor } from '@/lib/keyset';
import { parseRecordParam, SHOW_TABS } from '@/lib/record-params';
import { SHOW_SEARCH_MAX_LENGTH, listShowsPage } from '@/services/shows';
import type { ShowListPage } from '@/services/shows';
import { STATION_SEARCH_MAX_LENGTH, listCompanyAccess } from '../inventory/station-access';
import { getMusicPermissions } from '../music/permissions';
import { StationSearchForm } from '../inventory/station-search-form';
import type { SuspendedCompany, ViewableCompany } from '../inventory/station-access';
import { ShowsFilters } from './shows-filters';
import { ShowsGrid } from './shows-grid';
import { parseShowCursor, parseShowListState, showHref } from './list-params';
import type { ShowSearchParams } from './list-params';

/**
 * Block 18. Programmes, third under Audiência after Ouvintes and Participações.
 *
 * THE SCREEN IS `/music/songs` WITH DIFFERENT COLUMNS, deliberately: the same
 * Station switcher, the same URL-driven filter bar, the same keyset paging and
 * the same record-as-a-modal. An operator who has registered a song already
 * knows how to register a programme, and a second layout for the same job would
 * only be a second thing to maintain.
 *
 * THE PERMISSION IS STILL A MUSIC ONE, and that is recorded rather than
 * accidental: `shows` carries exactly one policy, gated on `music.view`, and it
 * has no insert or update policy at all. Moving the screen under Audiência does
 * not move the permission, so a member who administers the audience and holds
 * nothing in music cannot open this.
 *
 * A `shows.view` / `shows.manage` pair is not two rows in a table — it is a
 * permissions migration, the roles screen, every seeded role, PERMISSIONS.md,
 * and above all EVERY ROLE A CUSTOMER HAS ALREADY CONFIGURED, none of which
 * would grant it. Shipping this screen behind a permission nobody holds would
 * hide it from everyone. The spec's §5 carries the full reasoning.
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
  const cursorParam = parseShowCursor(params);

  let page: ShowListPage;
  try {
    page = await listShowsPage({
      companyId: state.companyId,
      search: state.search?.slice(0, SHOW_SEARCH_MAX_LENGTH),
      kind: state.kind,
      includeEnded: state.includeEnded,
      sort: state.sort,
      direction: state.direction,
      cursor: cursorParam ? decodeCursor(cursorParam.value) : null,
      cursorSide: cursorParam?.side ?? 'after',
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
              aria-current={company.id === selected.id ? 'page' : undefined}
              className={
                company.id === selected.id
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

      <ShowsFilters state={state} />

      <ShowsGrid
        initialRows={page.rows}
        initialTotal={page.total}
        state={state}
        previousHref={
          page.previousCursor ? showHref(state, { side: 'before', value: page.previousCursor }) : null
        }
        nextHref={page.nextCursor ? showHref(state, { side: 'after', value: page.nextCursor }) : null}
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
