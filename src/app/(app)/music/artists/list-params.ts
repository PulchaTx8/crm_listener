import type { ArtistSortKey } from '@/services/music';
import type { SortDirection } from '@/lib/keyset';

/**
 * The Artists screen's URL contract, on the shape of songs/list-params.ts:
 * the Server Component that reads it, the filter form that writes it and the
 * sort/paging links that rewrite parts of it all have to agree, and a second
 * hand-rolled query string is how a Station selection silently stops
 * surviving a sort click.
 *
 * One filter narrower than songs/list-params.ts: there is no artist or genre
 * to filter an artist list BY, so `q` (a name search) is the only one.
 */

export interface ArtistSearchParams {
  companyId?: string;
  station?: string;
  q?: string;
  sort?: string;
  dir?: string;
  after?: string;
  before?: string;
  record?: string;
  tab?: string;
}

export interface ArtistListState {
  companyId: string;
  /**
   * A Station-name search, when the caller's Station list was capped and they
   * narrowed it. Carried by every link on the screen: dropping it would put
   * the Station list back to its capped first page, and a Station only
   * reachable THROUGH the search would fall out of it — silently moving the
   * caller to somebody else's catalogue on the next sort click.
   */
  stationSearch?: string;
  search?: string;
  sort: ArtistSortKey;
  direction: SortDirection;
}

export interface ArtistCursor {
  side: 'after' | 'before';
  value: string;
}

/** Alphabetical: an artist list is browsed by name, not by recency. */
export const DEFAULT_ARTIST_SORT: ArtistSortKey = 'name';

export function defaultDirectionFor(sort: ArtistSortKey): SortDirection {
  return sort === 'name' ? 'asc' : 'desc';
}

/**
 * `companyId` is resolved by the page against the Stations the caller can
 * actually reach before it gets here, so this only carries it — a tampered
 * value falls back to the caller's first Station there, as it always has.
 */
export function parseArtistListState(raw: ArtistSearchParams, companyId: string): ArtistListState {
  const sort: ArtistSortKey = raw.sort === 'created' ? 'created' : DEFAULT_ARTIST_SORT;
  const direction: SortDirection =
    raw.dir === 'asc' ? 'asc' : raw.dir === 'desc' ? 'desc' : defaultDirectionFor(sort);

  return {
    companyId,
    stationSearch: raw.station?.trim() || undefined,
    search: raw.q?.trim() || undefined,
    sort,
    direction,
  };
}

export function parseArtistCursor(raw: ArtistSearchParams): ArtistCursor | null {
  if (raw.before) return { side: 'before', value: raw.before };
  if (raw.after) return { side: 'after', value: raw.after };
  return null;
}

export function hasActiveArtistFilters(state: ArtistListState): boolean {
  return Boolean(state.search);
}

/**
 * Omitting the cursor is how a filter or sort change resets paging, and it
 * must: a cursor is a position in one ordering of one result set.
 */
export function artistHref(state: ArtistListState, cursor?: ArtistCursor | null): string {
  const query = new URLSearchParams();
  query.set('companyId', state.companyId);
  if (state.stationSearch) query.set('station', state.stationSearch);
  if (state.search) query.set('q', state.search);
  if (state.sort !== DEFAULT_ARTIST_SORT) query.set('sort', state.sort);
  if (state.direction !== defaultDirectionFor(state.sort)) query.set('dir', state.direction);
  if (cursor) query.set(cursor.side, cursor.value);
  return `/music/artists?${query.toString()}`;
}

/** Clicking the sorted column flips it; clicking another starts from that column's own natural direction. */
export function artistSortHref(state: ArtistListState, sort: ArtistSortKey): string {
  const direction: SortDirection =
    state.sort === sort
      ? state.direction === 'asc'
        ? 'desc'
        : 'asc'
      : defaultDirectionFor(sort);
  return artistHref({ ...state, sort, direction });
}
