import { getTranslations } from 'next-intl/server';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { createUserClient } from '@/lib/supabase/user-client';
import { logger } from '@/lib/logger';
import { stationSwitchHref } from '@/lib/station-switch';
import { PageHeader } from '@/components/layout/app-shell';
import { Card, CardContent } from '@/components/ui/card';
import { decodeCursor } from '@/lib/keyset';
import { listMusicReferences, listSongsPage, SONG_SEARCH_MAX_LENGTH } from '@/services/music';
import type { ReferenceSummary, SongListPage } from '@/services/music';
import { STATION_SEARCH_MAX_LENGTH, listCompanyAccess } from '../../inventory/station-access';
import { StationSearchForm } from '../../inventory/station-search-form';
import type { SuspendedCompany, ViewableCompany } from '../../inventory/station-access';
import { getMusicPermissions } from '../permissions';
import type { MusicPermissions } from '../permissions';
import { describeMusicReadError } from '../errors';
import { SongsFilters } from './songs-filters';
import { SongsGrid } from './songs-grid';
import { parseRecordParam, SONG_TABS } from '@/lib/record-params';
import { parseSongCursor, parseSongListState, songHref } from './list-params';
import type { MusicSearchParams } from './list-params';

// Renders from the caller's session cookies and a live per-Station permission
// check, so it can never be static.
export const dynamic = 'force-dynamic';

export default async function SongsPage({
  searchParams,
}: {
  searchParams: Promise<MusicSearchParams>;
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

  // A courtesy, not the boundary: create_song, update_song, archive_song and
  // the reference RPCs (0100/0101) each re-check has_permission themselves
  // before writing or reading anything, and songs/artists/record_labels/
  // music_genres' own select policies (0099) already filter to exactly the
  // Stations listCompanyAccess just resolved. This redirect only saves
  // someone holding music.view nowhere a trip to a screen that would
  // otherwise have nothing to show — indistinguishable, if rendered instead
  // of redirected, from a Station with no songs in it.
  // A Station search that matches nothing leaves this caller with no Station
  // to show, which is not the same as holding music.view nowhere: the
  // redirect above would throw them off the screen with no way to clear the
  // search. Handled before it, so the search can always be undone.
  if (!first && stationSearch) return <NoStationMatch search={stationSearch} />;
  if (!first) redirect('/app');

  // Next's searchParams arrives already percent-decoded (same as every other
  // ?param=-style value in this codebase). A stale or tampered companyId that
  // is not in `viewable` — access revoked since the link was generated, or a
  // hand-edited URL — falls back to the first Station this caller can
  // actually view rather than erroring.
  const selected = viewable.find((c) => c.id === params.companyId) ?? first;

  const state = parseSongListState(params, selected.id);
  const cursorParam = parseSongCursor(params);
  // An unreadable cursor means "start from the beginning", never an error page.
  const cursor = decodeCursor(cursorParam?.value);

  let artists: ReferenceSummary[];
  let labels: ReferenceSummary[];
  let genres: ReferenceSummary[];
  let page: SongListPage;
  let permissions: MusicPermissions;
  try {
    [artists, labels, genres, page, permissions] = await Promise.all([
      listMusicReferences(selected.id, 'ARTIST'),
      listMusicReferences(selected.id, 'LABEL'),
      listMusicReferences(selected.id, 'GENRE'),
      listSongsPage({
        companyId: selected.id,
        // The same bound the service enforces on its own argument, imported
        // rather than copied so a URL parameter cannot drift the two apart.
        search: state.search?.slice(0, SONG_SEARCH_MAX_LENGTH),
        artistId: state.artistId,
        genreId: state.genreId,
        sort: state.sort,
        direction: state.direction,
        cursor,
        cursorSide: cursorParam?.side ?? 'after',
      }),
      getMusicPermissions(supabase, selected.id),
    ]);
  } catch (cause) {
    logger.error({ err: cause, companyId: selected.id }, 'could not load the songs list');
    return <LoadError message={describeMusicReadError(cause, await getTranslations('music'))} />;
  }

  return (
    <>
      <PageHeader
        title={t('songs')}
        description={t('songsDescription')}
      />

      {(capped || stationSearch) && (
        <div className="mb-4 flex flex-col gap-2">
          {capped && (
            <p className="text-xs text-muted-foreground">
              {t('showing')}{' '}{viewable.length + suspended.length} {t('ofTheStationsYouCanReach')}</p>
          )}
          <StationSearchForm
            action="/music/songs"
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
              href={stationSwitchHref('/music/songs', company.id, stationSearch)}
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

      <SongsFilters state={state} artists={artists} genres={genres} />

      <SongsGrid
        initialRows={page.rows}
        initialTotal={page.total}
        state={state}
        previousHref={
          page.previousCursor ? songHref(state, { side: 'before', value: page.previousCursor }) : null
        }
        nextHref={page.nextCursor ? songHref(state, { side: 'after', value: page.nextCursor }) : null}
        artists={artists}
        labels={labels}
        genres={genres}
        manage={permissions.manage}
        initialRecord={parseRecordParam(params as Record<string, string | undefined>, SONG_TABS)}
      />
    </>
  );
}

async function NoStationMatch({ search }: { search: string }) {
  const t = await getTranslations('music');
  return (
    <>
      <PageHeader title={t('songs')} />
      <Card>
        <CardContent className="flex flex-col gap-3 pt-6">
          <p className="text-sm text-muted-foreground">
            {t('noStationYouCanReachMatches', { search })}
          </p>
          <Link href="/music/songs" className="text-sm text-primary underline underline-offset-2">
            {t('clearTheStationSearch')}</Link>
        </CardContent>
      </Card>
    </>
  );
}

async function LoadError({ message }: { message: string }) {
  const t = await getTranslations('music');
  return (
    <>
      <PageHeader title={t('songs')} />
      <Card>
        <CardContent className="pt-6">
          <p className="text-sm text-destructive">{message}</p>
        </CardContent>
      </Card>
    </>
  );
}
