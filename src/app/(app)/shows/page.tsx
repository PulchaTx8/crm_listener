import { getTranslations } from 'next-intl/server';
import Link from 'next/link';
import type { Route } from 'next';
import { redirect } from 'next/navigation';
import { createUserClient } from '@/lib/supabase/user-client';
import { logger } from '@/lib/logger';
import { PageHeader } from '@/components/layout/app-shell';
import { Card, CardContent } from '@/components/ui/card';
import { decodeCursor } from '@/lib/keyset';
import { SHOW_SEARCH_MAX_LENGTH, listShowsPage } from '@/services/shows';
import type { ShowListPage } from '@/services/shows';
import { STATION_SEARCH_MAX_LENGTH, listCompanyAccess } from '../inventory/station-access';
import { getMusicPermissions } from '../music/permissions';
import { StationSearchForm } from '../inventory/station-search-form';
import type { ViewableCompany } from '../inventory/station-access';
import { ShowsGrid } from './shows-grid';
import { parseShowCursor, parseShowListState, showHref } from './list-params';
import type { ShowSearchParams } from './list-params';

/**
 * Block 18. Programmes, third under Audiência after Ouvintes and Participações.
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
  let capped: boolean;
  try {
    ({ viewable, capped } = await listCompanyAccess(supabase, 'music.view', stationSearch));
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
      search: state.search,
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

  // `music.manage` decides whether the register button and the edit action
  // appear. It is a courtesy rather than the boundary: save_show and end_show
  // each re-check it against auth.uid() before writing anything.
  const permissions = await getMusicPermissions(supabase, selected.id);

  return (
    <>
      <PageHeader title={t('programmes')} />

      {capped && (
        <StationSearchForm
          action="/shows"
          value={stationSearch ?? ''}
          preserve={{}}
          label={t('findAStation')}
        />
      )}

      <Card>
        <CardContent className="flex flex-col gap-4 pt-6">
          <form className="flex flex-wrap items-end gap-2" action="/shows">
            <input type="hidden" name="companyId" value={state.companyId} />
            {stationSearch && <input type="hidden" name="station" value={stationSearch} />}
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-muted-foreground">{t('search')}</span>
              <input
                type="search"
                name="q"
                defaultValue={state.search ?? ''}
                maxLength={SHOW_SEARCH_MAX_LENGTH}
                className="rounded-md border border-input bg-background px-3 py-2 text-sm"
                data-testid="shows-search"
              />
            </label>
            <label className="flex items-center gap-2 text-sm">
              {/* D8: ended programmes are archived rather than deleted, so they
                  are hidden and reachable rather than gone. */}
              <input
                type="checkbox"
                name="ended"
                value="1"
                defaultChecked={state.includeEnded}
                className="h-4 w-4 rounded border-input"
                data-testid="shows-include-ended"
              />
              <span>{t('showEndedProgrammes')}</span>
            </label>
            <button
              type="submit"
              className="rounded-md border px-3 py-2 text-sm"
              data-testid="shows-filter"
            >
              {t('filter')}
            </button>
          </form>

          <ShowsGrid companyId={state.companyId} rows={page.rows} canManage={permissions.manage} />

          {/* typedRoutes cannot express a query string assembled at runtime,
              which is why songs-filters.tsx casts the same way for the same
              reason. The PATH is checked; only the query is not. */}
          <nav className="flex items-center gap-3 text-sm">
            {page.previousCursor && (
              <Link href={showHref(state, { side: 'before', value: page.previousCursor }) as Route}>
                {t('previous')}
              </Link>
            )}
            {page.nextCursor && (
              <Link href={showHref(state, { side: 'after', value: page.nextCursor }) as Route}>
                {t('next')}
              </Link>
            )}
            <span className="text-muted-foreground">{t('total', { count: page.total })}</span>
          </nav>
        </CardContent>
      </Card>
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
