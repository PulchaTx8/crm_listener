'use client';

import { useTranslations } from 'next-intl';
import { useEffect, useId, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { Route } from 'next';
import { Input, Select } from '@/components/ui/input';
import { MUSIC_REQUEST_CHANNELS } from '@/schemas/music';
import type { ReferenceSummary } from '@/services/music';
import { requestHref } from './list-params';
import type { RequestListState } from './list-params';

const DEBOUNCE_MS = 350;
const ANY_SHOW = '';
const ANY_CHANNEL = '';

// The shared `vocab` keys — see requests-grid.tsx's own note.
const CHANNEL_LABEL_KEYS: Record<(typeof MUSIC_REQUEST_CHANNELS)[number], string> = {
  MANUAL: 'sourceManual',
  IMPORT: 'sourceImport',
};

/**
 * `state.songId` counts here even though this bar offers no control that
 * sets it — see this component's own comment on that filter for why — so
 * that a request list reached through it (a future cross-link, not built by
 * this task) still shows "Clear filters" rather than looking unfiltered
 * while narrowed.
 */
function hasActiveRequestFilters(state: RequestListState): boolean {
  return Boolean(state.search || state.showId || state.channel || state.songId);
}

/**
 * These controls filter nothing themselves: they edit the URL, and the
 * Server Component asks Postgres a narrower question — the shape every list
 * in this codebase has used since Block 3b. There is no sort control, the
 * same reasoning ParticipationsFilters gives for its own screen: the list is
 * ordered newest first, fixed, because that is the one ordering
 * list_music_requests (0107) serves and a keyset cursor must compare
 * exactly the columns it orders by.
 *
 * No song filter is offered here on purpose. `songId` is part of the URL
 * contract (list-params.ts) and the read (listMusicRequestsPage) already
 * narrows by it, but resolving an id back to a title to show as a filter
 * chip needs getSongById — a read Task 7's service layer never shipped for
 * this screen, and Task 8's own brief lists exactly what this screen
 * consumes without it. `songId` survives on the URL as a door a future
 * cross-link can use (a "requests for this song" link from elsewhere), and
 * this bar stays honest about it via hasActiveRequestFilters above rather
 * than silently ignoring a filter that is doing real work.
 */
export function RequestsFilters({
  state,
  shows,
  canSearchByListener,
}: {
  state: RequestListState;
  shows: ReferenceSummary[];
  /** members.view at this Station — a search without it returns nothing at all (0107's RULE 3). */
  canSearchByListener: boolean;
}) {
  const t = useTranslations('music');
  // The shared enum vocabulary, which several screens render.
  const tv = useTranslations('vocab');
  const router = useRouter();
  const noteId = useId();
  const [search, setSearch] = useState(state.search ?? '');
  // Re-synced from the URL so browser back/forward leaves this input
  // agreeing with the list beside it.
  useEffect(() => setSearch(state.search ?? ''), [state.search]);

  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  function navigate(next: Partial<RequestListState>) {
    clearTimeout(timer.current);
    const typed: RequestListState = { ...state, search: search.trim() || undefined };
    // typedRoutes cannot express a query string assembled at runtime as a
    // route literal — the same cast the rest of this codebase uses.
    router.replace(requestHref({ ...typed, ...next }) as Route);
  }

  return (
    <div className="flex flex-wrap items-end gap-3" data-testid="requests-filters">
      <label className="flex w-64 flex-col gap-1 text-sm">
        <span className="text-muted-foreground">{t('listener')}</span>
        <Input
          type="search"
          value={search}
          disabled={!canSearchByListener}
          onChange={(e) => {
            setSearch(e.target.value);
            clearTimeout(timer.current);
            timer.current = setTimeout(() => navigate({}), DEBOUNCE_MS);
          }}
          placeholder={t('nameOrPhone')}
          aria-label={t('searchRequestsByListenerNameOr')}
          aria-describedby={canSearchByListener ? undefined : noteId}
          data-testid="request-search-input"
        />
        {!canSearchByListener && (
          <span
            id={noteId}
            className="text-xs text-muted-foreground"
            data-testid="request-search-note"
          >
            {t('youCannotSearchByListenerAt')}</span>
        )}
      </label>

      <label className="flex w-56 flex-col gap-1 text-sm">
        <span className="text-muted-foreground">{t('programme')}</span>
        <Select
          value={state.showId ?? ANY_SHOW}
          onChange={(e) => navigate({ showId: e.target.value || undefined })}
          data-testid="request-show-filter"
        >
          <option value={ANY_SHOW}>{t('everyProgramme')}</option>
          {shows.map((show) => (
            <option key={show.id} value={show.id}>
              {show.name}
            </option>
          ))}
        </Select>
      </label>

      <label className="flex w-48 flex-col gap-1 text-sm">
        <span className="text-muted-foreground">{t('channel')}</span>
        <Select
          value={state.channel ?? ANY_CHANNEL}
          onChange={(e) =>
            navigate({ channel: (e.target.value || undefined) as RequestListState['channel'] })
          }
          data-testid="request-channel-filter"
        >
          <option value={ANY_CHANNEL}>{t('anyChannel')}</option>
          {MUSIC_REQUEST_CHANNELS.map((channel) => (
            <option key={channel} value={channel}>
              {tv(CHANNEL_LABEL_KEYS[channel])}
            </option>
          ))}
        </Select>
      </label>

      {hasActiveRequestFilters(state) && (
        <Link
          href={
            requestHref({ companyId: state.companyId, stationSearch: state.stationSearch }) as Route
          }
          className="rounded-md border px-3 py-1.5 text-sm ring-offset-background hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          data-testid="request-clear-filters"
        >
          {t('clearFilters')}</Link>
      )}
    </div>
  );
}
