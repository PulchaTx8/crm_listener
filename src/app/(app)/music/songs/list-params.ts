import type { SongSortKey } from '@/services/music';
import type { SortDirection } from '@/lib/keyset';

/**
 * The Songs screen's URL contract, on the shape of inventory/list-params.ts:
 * the Server Component that reads it, the filter form that writes it and the
 * sort/paging links that rewrite parts of it all have to agree, and a second
 * hand-rolled query string is how a Station selection silently stops
 * surviving a sort click.
 */

export interface MusicSearchParams {
  companyId?: string;
  station?: string;
  q?: string;
  artist?: string;
  genre?: string;
  sort?: string;
  dir?: string;
  after?: string;
  before?: string;
  record?: string;
  tab?: string;
}

export interface SongListState {
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
  /** An artist id; undefined means every artist. */
  artistId?: string;
  /** A genre id; undefined means every genre. */
  genreId?: string;
  sort: SongSortKey;
  direction: SortDirection;
}

export interface SongCursor {
  side: 'after' | 'before';
  value: string;
}

/** Alphabetical: a catalogue is browsed by title, not by recency. */
export const DEFAULT_SONG_SORT: SongSortKey = 'title';

export function defaultDirectionFor(sort: SongSortKey): SortDirection {
  return sort === 'title' ? 'asc' : 'desc';
}

/**
 * `companyId` is resolved by the page against the Stations the caller can
 * actually reach before it gets here, so this only carries it — a tampered
 * value falls back to the caller's first Station there, as it always has.
 */
export function parseSongListState(raw: MusicSearchParams, companyId: string): SongListState {
  const sort: SongSortKey = raw.sort === 'created' ? 'created' : DEFAULT_SONG_SORT;
  const direction: SortDirection =
    raw.dir === 'asc' ? 'asc' : raw.dir === 'desc' ? 'desc' : defaultDirectionFor(sort);

  return {
    companyId,
    stationSearch: raw.station?.trim() || undefined,
    search: raw.q?.trim() || undefined,
    artistId: raw.artist?.trim() || undefined,
    genreId: raw.genre?.trim() || undefined,
    sort,
    direction,
  };
}

export function parseSongCursor(raw: MusicSearchParams): SongCursor | null {
  if (raw.before) return { side: 'before', value: raw.before };
  if (raw.after) return { side: 'after', value: raw.after };
  return null;
}

export function hasActiveSongFilters(state: SongListState): boolean {
  return Boolean(state.search || state.artistId || state.genreId);
}

/**
 * Omitting the cursor is how a filter or sort change resets paging, and it
 * must: a cursor is a position in one ordering of one result set.
 */
export function songHref(state: SongListState, cursor?: SongCursor | null): string {
  const query = new URLSearchParams();
  query.set('companyId', state.companyId);
  if (state.stationSearch) query.set('station', state.stationSearch);
  if (state.search) query.set('q', state.search);
  if (state.artistId) query.set('artist', state.artistId);
  if (state.genreId) query.set('genre', state.genreId);
  if (state.sort !== DEFAULT_SONG_SORT) query.set('sort', state.sort);
  if (state.direction !== defaultDirectionFor(state.sort)) query.set('dir', state.direction);
  if (cursor) query.set(cursor.side, cursor.value);
  return `/music/songs?${query.toString()}`;
}

/** Clicking the sorted column flips it; clicking another starts from that column's own natural direction. */
export function songSortHref(state: SongListState, sort: SongSortKey): string {
  const direction: SortDirection =
    state.sort === sort
      ? state.direction === 'asc'
        ? 'desc'
        : 'asc'
      : defaultDirectionFor(sort);
  return songHref({ ...state, sort, direction });
}
