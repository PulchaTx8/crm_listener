'use client';

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

/**
 * The selects are fed from listMusicReferences (music/songs/page.tsx), so an
 * operator filters by the artists and genres their own Station registered —
 * never a platform-wide list. Same shape as InventoryFilters: these controls
 * filter nothing themselves, they edit the URL, and the Server Component
 * asks Postgres a narrower question.
 */
export function SongsFilters({
  state,
  artists,
  genres,
}: {
  state: SongListState;
  artists: ReferenceSummary[];
  genres: ReferenceSummary[];
}) {
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
        <span className="text-muted-foreground">Search</span>
        <Input
          type="search"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            clearTimeout(timer.current);
            timer.current = setTimeout(() => navigate({}), DEBOUNCE_MS);
          }}
          placeholder="Title or code"
          aria-label="Search songs by title or code"
          data-testid="song-search-input"
        />
      </label>

      <label className="flex w-56 flex-col gap-1 text-sm">
        <span className="text-muted-foreground">Artist</span>
        <Select
          value={state.artistId ?? ALL_ARTISTS}
          onChange={(e) => navigate({ artistId: e.target.value || undefined })}
          data-testid="song-artist-filter"
        >
          <option value={ALL_ARTISTS}>All artists</option>
          {artists.map((artist) => (
            <option key={artist.id} value={artist.id}>
              {artist.name}
            </option>
          ))}
        </Select>
      </label>

      <label className="flex w-56 flex-col gap-1 text-sm">
        <span className="text-muted-foreground">Genre</span>
        <Select
          value={state.genreId ?? ALL_GENRES}
          onChange={(e) => navigate({ genreId: e.target.value || undefined })}
          data-testid="song-genre-filter"
        >
          <option value={ALL_GENRES}>All genres</option>
          {genres.map((genre) => (
            <option key={genre.id} value={genre.id}>
              {genre.name}
            </option>
          ))}
        </Select>
      </label>

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
          Clear filters
        </Link>
      )}
    </div>
  );
}
