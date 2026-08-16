'use client';

import { useTranslations } from 'next-intl';
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { Route } from 'next';
import { Input, Select } from '@/components/ui/input';
import type { ReferenceSummary } from '@/services/music';
import { hasActiveSongFilters, songHref } from './list-params';
import type { SongListState } from './list-params';

const DEBOUNCE_MS = 350;
const ALL_ARTISTS = '';
const ALL_GENRES = '';
const ALL_SONGWRITERS = '';

/**
 * The selects are fed from listMusicReferences (music/songs/page.tsx), so an
 * operator filters by the artists, genres and songwriters their own Station
 * registered — never a platform-wide list. Same shape as InventoryFilters:
 * these controls filter nothing themselves, they edit the URL, and the Server
 * Component asks Postgres a narrower question.
 */
export function SongsFilters({
  state,
  artists,
  genres,
  songwriters,
}: {
  state: SongListState;
  artists: ReferenceSummary[];
  genres: ReferenceSummary[];
  songwriters: ReferenceSummary[];
}) {
  const t = useTranslations('music');
  const router = useRouter();
  const [search, setSearch] = useState(state.search ?? '');
  // Re-synced from the URL so browser back/forward leaves this input agreeing
  // with the list beside it; after this component's own edits the prop
  // arrives holding what was already typed, making the sync a no-op.
  useEffect(() => setSearch(state.search ?? ''), [state.search]);

  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  function navigate(next: Partial<SongListState>) {
    clearTimeout(timer.current);
    const typed: SongListState = { ...state, search: search.trim() || undefined };
    // typedRoutes cannot express a query string assembled at runtime as a
    // route literal — the same cast the rest of this codebase uses.
    router.replace(songHref({ ...typed, ...next }) as Route);
  }

  return (
    <div className="flex flex-wrap items-end gap-3" data-testid="songs-filters">
      <label className="flex w-64 flex-col gap-1 text-sm">
        <span className="text-muted-foreground">{t('search')}</span>
        <Input
          type="search"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            clearTimeout(timer.current);
            timer.current = setTimeout(() => navigate({}), DEBOUNCE_MS);
          }}
          placeholder={t('titleOrCode')}
          aria-label={t('searchSongsByTitleOrCode')}
          data-testid="song-search-input"
        />
      </label>

      <label className="flex w-56 flex-col gap-1 text-sm">
        <span className="text-muted-foreground">{t('artist')}</span>
        <Select
          value={state.artistId ?? ALL_ARTISTS}
          onChange={(e) => navigate({ artistId: e.target.value || undefined })}
          data-testid="song-artist-filter"
        >
          <option value={ALL_ARTISTS}>{t('allArtists')}</option>
          {artists.map((artist) => (
            <option key={artist.id} value={artist.id}>
              {artist.name}
            </option>
          ))}
        </Select>
      </label>

      <label className="flex w-56 flex-col gap-1 text-sm">
        <span className="text-muted-foreground">{t('genre')}</span>
        <Select
          value={state.genreId ?? ALL_GENRES}
          onChange={(e) => navigate({ genreId: e.target.value || undefined })}
          data-testid="song-genre-filter"
        >
          <option value={ALL_GENRES}>{t('allGenres')}</option>
          {genres.map((genre) => (
            <option key={genre.id} value={genre.id}>
              {genre.name}
            </option>
          ))}
        </Select>
      </label>

      {/* Block 27. Without this control the Songwriters screen would be a list
          that changes nothing an operator can see — the same argument Block 26
          made for why /inventory/categories had to exist rather than staying a
          button. (That route keeps its own word: it is inventory's, and a
          different domain.) */}
      <label className="flex w-56 flex-col gap-1 text-sm">
        <span className="text-muted-foreground">{t('songwriter')}</span>
        <Select
          value={state.songwriterId ?? ALL_SONGWRITERS}
          onChange={(e) => navigate({ songwriterId: e.target.value || undefined })}
          data-testid="song-songwriter-filter"
        >
          <option value={ALL_SONGWRITERS}>{t('allSongwriters')}</option>
          {songwriters.map((songwriter) => (
            <option key={songwriter.id} value={songwriter.id}>
              {songwriter.name}
            </option>
          ))}
        </Select>
      </label>

      {/* The clear link builds a href from four NAMED fields and omits every
          filter, which is how it clears this one too without being touched. */}
      {hasActiveSongFilters(state) && (
        <Link
          href={
            songHref({
              companyId: state.companyId,
              stationSearch: state.stationSearch,
              sort: state.sort,
              direction: state.direction,
            }) as Route
          }
          className="rounded-md border px-3 py-1.5 text-sm ring-offset-background hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          data-testid="song-clear-filters"
        >
          {t('clearFilters')}</Link>
      )}
    </div>
  );
}
