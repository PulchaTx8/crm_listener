import type { SortDirection } from '@/lib/keyset';

/**
 * The Albums screen's URL contract, on the shape of music/artists/list-params.ts:
 * the Server Component that reads it, the filter form that writes it and the
 * paging links all have to agree, and a second hand-rolled query string is
 * how a Station selection silently stops surviving a navigation.
 *
 * One difference from the Artists contract: no `sort` field. listAlbumsPage
 * (services/music.ts) orders by title alone — there is no second column to
 * choose between, the same reason catalog/references/list-params.ts's
 * ReferenceListState carries no `sort` either.
 *
 * Unlike the References contract, this DOES carry `record`/`tab`: albums do
 * not share References' component set (design spec §2 D3) — five columns
 * against two, and a picture control neither reference table has — so the
 * album record is its own dialog, addressed in the URL the way
 * music/artists/list-params.ts's is, not derived from a row already in the
 * caller's hand the way ReferenceRecordDialog's is.
 */

export interface AlbumSearchParams {
  companyId?: string;
  station?: string;
  q?: string;
  dir?: string;
  after?: string;
  before?: string;
  record?: string;
  tab?: string;
}

export interface AlbumListState {
  companyId: string;
  /**
   * A Station-name search, when the caller's Station list was capped and they
   * narrowed it. Carried by every link on the screen: dropping it would put
   * the Station list back to its capped first page, and a Station only
   * reachable THROUGH the search would fall out of it — silently moving the
   * caller to somebody else's catalogue on the next click. Same field, same
   * reasoning, as ArtistListState.stationSearch (music/artists/list-params.ts).
   */
  stationSearch?: string;
  search?: string;
  direction: SortDirection;
}

export interface AlbumCursor {
  side: 'after' | 'before';
  value: string;
}

/** Alphabetical: an album list is browsed by title, the only column listAlbumsPage orders by. */
export function defaultDirectionFor(): SortDirection {
  return 'asc';
}

/**
 * `companyId` is resolved by the page against the Stations the caller can
 * actually reach before it gets here, so this only carries it — a tampered
 * value falls back to the caller's first Station there, as it always has.
 */
export function parseAlbumListState(raw: AlbumSearchParams, companyId: string): AlbumListState {
  const direction: SortDirection = raw.dir === 'desc' ? 'desc' : defaultDirectionFor();

  return {
    companyId,
    stationSearch: raw.station?.trim() || undefined,
    search: raw.q?.trim() || undefined,
    direction,
  };
}

export function parseAlbumCursor(raw: AlbumSearchParams): AlbumCursor | null {
  if (raw.before) return { side: 'before', value: raw.before };
  if (raw.after) return { side: 'after', value: raw.after };
  return null;
}

export function hasActiveAlbumFilters(state: AlbumListState): boolean {
  return Boolean(state.search);
}

/**
 * Omitting the cursor is how a filter or direction change resets paging, and
 * it must: a cursor is a position in one ordering of one result set.
 */
export function albumHref(state: AlbumListState, cursor?: AlbumCursor | null): string {
  const query = new URLSearchParams();
  query.set('companyId', state.companyId);
  if (state.stationSearch) query.set('station', state.stationSearch);
  if (state.search) query.set('q', state.search);
  if (state.direction !== defaultDirectionFor()) query.set('dir', state.direction);
  if (cursor) query.set(cursor.side, cursor.value);
  return `/catalog/albums?${query.toString()}`;
}

/** Clicking the Title column flips its direction — the only sortable column, so there is no "start from that column's own natural direction" branch artistSortHref (music/artists/list-params.ts) needs for its second column. */
export function albumSortHref(state: AlbumListState): string {
  const direction: SortDirection = state.direction === 'asc' ? 'desc' : 'asc';
  return albumHref({ ...state, direction });
}
