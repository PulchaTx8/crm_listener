import { getTranslations } from 'next-intl/server';
import Link from 'next/link';
import type { Route } from 'next';
import { redirect } from 'next/navigation';
import { createUserClient } from '@/lib/supabase/user-client';
import { logger } from '@/lib/logger';
import { stationSwitchHref } from '@/lib/station-switch';
import { PageHeader } from '@/components/layout/app-shell';
import { Card, CardContent } from '@/components/ui/card';
import { decodeCursor } from '@/lib/keyset';
import { listAlbumsPage, SONG_SEARCH_MAX_LENGTH } from '@/services/music';
import type { AlbumListPage } from '@/services/music';
import { STATION_SEARCH_MAX_LENGTH, listCompanyAccess } from '../../inventory/station-access';
import { StationSearchForm } from '../../inventory/station-search-form';
import type { SuspendedCompany, ViewableCompany } from '../../inventory/station-access';
import { getMusicPermissions } from '../../music/permissions';
import type { MusicPermissions } from '../../music/permissions';
import { describeMusicReadError } from '../../music/errors';
import { AlbumsFilters } from './albums-filters';
import { AlbumsGrid } from './albums-grid';
import { parseRecordParam, ALBUM_TABS } from '@/lib/record-params';
import { albumHref, parseAlbumCursor, parseAlbumListState } from './list-params';
import type { AlbumSearchParams } from './list-params';

// Renders from the caller's session cookies and a live per-Station permission
// check, so it can never be static.
export const dynamic = 'force-dynamic';

export default async function AlbumsPage({
  searchParams,
}: {
  searchParams: Promise<AlbumSearchParams>;
}) {
  const t = await getTranslations('music');
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
    logger.error({ err: cause }, 'could not resolve music access');
    return <LoadError message={describeMusicReadError(cause, await getTranslations('music'))} />;
  }

  const first = viewable[0];

  // A courtesy, not the boundary: create_album, update_album, archive_album,
  // set_album_cover and albums' own select policy (0136) each re-check
  // has_permission themselves before writing or reading anything. This
  // redirect only saves someone holding music.view nowhere a trip to a
  // screen that would otherwise have nothing to show — indistinguishable, if
  // rendered instead of redirected, from a Station with no albums in it.
  // A Station search that matches nothing leaves this caller with no Station
  // to show, which is not the same as holding music.view nowhere: the
  // redirect above would throw them off the screen with no way to clear the
  // search. Handled before it, so the search can always be undone.
  if (!first && stationSearch) return <NoStationMatch search={stationSearch} />;
  if (!first) redirect('/app');

  // A stale or tampered companyId that is not in `viewable` — access revoked
  // since the link was generated, or a hand-edited URL — falls back to the
  // first Station this caller can actually view rather than erroring.
  const selected = viewable.find((c) => c.id === params.companyId) ?? first;

  const state = parseAlbumListState(params, selected.id);
  const cursorParam = parseAlbumCursor(params);
  // An unreadable cursor means "start from the beginning", never an error page.
  const cursor = decodeCursor(cursorParam?.value);

  let page: AlbumListPage;
  let permissions: MusicPermissions;
  try {
    [page, permissions] = await Promise.all([
      listAlbumsPage({
        companyId: selected.id,
        // The same bound the service enforces on its own argument, imported
        // rather than copied so a URL parameter cannot drift the two apart.
        search: state.search?.slice(0, SONG_SEARCH_MAX_LENGTH),
        direction: state.direction,
        cursor,
        cursorSide: cursorParam?.side ?? 'after',
      }),
      getMusicPermissions(supabase, selected.id),
    ]);
  } catch (cause) {
    logger.error({ err: cause, companyId: selected.id }, 'could not load the albums list');
    return <LoadError message={describeMusicReadError(cause, await getTranslations('music'))} />;
  }

  return (
    <>
      <PageHeader title={t('albums')} description={t('referenceAlbumsDescription')} />

      {(capped || stationSearch) && (
        <div className="mb-4 flex flex-col gap-2">
          {capped && (
            <p className="text-xs text-muted-foreground">
              {t('showing')} {viewable.length + suspended.length} {t('ofTheStationsYouCanReach')}
            </p>
          )}
          <StationSearchForm
            action="/catalog/albums"
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
              href={stationSwitchHref('/catalog/albums', company.id, stationSearch)}
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
          {/* A suspended Station passes the Company visibility policy — which
              deliberately keeps suspended Companies visible so the UI can
              explain why access stopped — then fails has_permission
              unconditionally (has_company_access requires status =
              'active'). Rendered here, disabled, with the reason, instead of
              silently vanishing from the switcher with no explanation. */}
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
      )}

      <AlbumsFilters state={state} />

      <AlbumsGrid
        initialRows={page.rows}
        initialTotal={page.total}
        state={state}
        previousHref={
          page.previousCursor ? albumHref(state, { side: 'before', value: page.previousCursor }) : null
        }
        nextHref={page.nextCursor ? albumHref(state, { side: 'after', value: page.nextCursor }) : null}
        manage={permissions.manage}
        initialRecord={parseRecordParam(params as Record<string, string | undefined>, ALBUM_TABS)}
      />
    </>
  );
}

async function NoStationMatch({ search }: { search: string }) {
  const t = await getTranslations('music');
  return (
    <>
      <PageHeader title={t('albums')} />
      <Card>
        <CardContent className="flex flex-col gap-3 pt-6">
          <p className="text-sm text-muted-foreground">
            {t('noStationYouCanReachMatches', { search })}
          </p>
          {/* typedRoutes cannot see a brand-new route's static literal until
              Next regenerates its route types (`next dev`/`next build`) — the
              same cast catalog/labels/page.tsx uses for the identical reason. */}
          <Link href={'/catalog/albums' as Route} className="text-sm text-primary underline underline-offset-2">
            {t('clearTheStationSearch')}
          </Link>
        </CardContent>
      </Card>
    </>
  );
}

async function LoadError({ message }: { message: string }) {
  const t = await getTranslations('music');
  return (
    <>
      <PageHeader title={t('albums')} />
      <Card>
        <CardContent className="pt-6">
          <p className="text-sm text-destructive">{message}</p>
        </CardContent>
      </Card>
    </>
  );
}
