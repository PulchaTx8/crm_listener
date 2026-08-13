'use client';

import { useTranslations } from 'next-intl';
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { Route } from 'next';
import { Input } from '@/components/ui/input';
import { albumHref, hasActiveAlbumFilters } from './list-params';
import type { AlbumListState } from './list-params';

const DEBOUNCE_MS = 350;

/**
 * One filter narrower than SongsFilters (music/songs/songs-filters.tsx): an
 * album list has nothing else to narrow by, so the debounced title search is
 * the whole form. Same shape as ArtistsFilters (music/artists/artists-filters.tsx)
 * otherwise — this control filters nothing itself, it edits the URL, and the
 * Server Component asks Postgres a narrower question.
 */
export function AlbumsFilters({ state }: { state: AlbumListState }) {
  const t = useTranslations('music');
  const router = useRouter();
  const [search, setSearch] = useState(state.search ?? '');
  // Re-synced from the URL so browser back/forward leaves this input agreeing
  // with the list beside it; after this component's own edits the prop
  // arrives holding what was already typed, making the sync a no-op.
  useEffect(() => setSearch(state.search ?? ''), [state.search]);

  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  function navigate(next: Partial<AlbumListState>) {
    clearTimeout(timer.current);
    const typed: AlbumListState = { ...state, search: search.trim() || undefined };
    // typedRoutes cannot express a query string assembled at runtime as a
    // route literal — the same cast the rest of this codebase uses.
    router.replace(albumHref({ ...typed, ...next }) as Route);
  }

  return (
    <div className="flex flex-wrap items-end gap-3" data-testid="albums-filters">
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
          placeholder={t('albumTitleFilter')}
          aria-label={t('searchAlbumsByTitle')}
          data-testid="album-search-input"
        />
      </label>

      {hasActiveAlbumFilters(state) && (
        <Link
          href={
            albumHref({
              companyId: state.companyId,
              stationSearch: state.stationSearch,
              direction: state.direction,
            }) as Route
          }
          className="rounded-md border px-3 py-1.5 text-sm ring-offset-background hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          data-testid="album-clear-filters"
        >
          {t('clearFilters')}
        </Link>
      )}
    </div>
  );
}
