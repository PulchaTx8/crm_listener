import type { ShowKind, ShowSortKey } from '@/services/shows';
import type { SortDirection } from '@/lib/keyset';
import { SHOW_KINDS } from '@/schemas/shows';

/**
 * Block 18. The Programmes screen's URL contract, on the shape of
 * `music/songs/list-params.ts`: the Server Component that reads it, the filter
 * form that writes it and the sort and paging links that rewrite parts of it
 * all have to agree, and a second hand-rolled query string is how a Station
 * selection silently stops surviving a sort click.
 */

export interface ShowSearchParams {
  companyId?: string;
  station?: string;
  q?: string;
  kind?: string;
  /** `1` shows the ended ones too. Absent is the ordinary case (D8). */
  ended?: string;
  sort?: string;
  dir?: string;
  record?: string;
}

export interface ShowListState {
  companyId: string;
  /**
   * A Station-name search, when the caller's Station list was capped and they
   * narrowed it. Carried by every link, for the reason songs records: dropping
   * it puts the Station list back to its capped first page, and a Station only
   * reachable THROUGH the search falls out of it.
   */
  stationSearch?: string;
  search?: string;
  /** One kind, or every kind. Undefined is "every kind", never the enum's first. */
  kind?: ShowKind;
  /**
   * D8: an ended programme is archived rather than deleted, so it is hidden by
   * default and reachable rather than gone — the way the promotions list treats
   * an archived promotion.
   */
  includeEnded: boolean;
  sort: ShowSortKey;
  direction: SortDirection;
}

/** Alphabetical: a schedule is browsed by name, not by when somebody typed it. */
export const DEFAULT_SHOW_SORT: ShowSortKey = 'name';

export function defaultDirectionFor(sort: ShowSortKey): SortDirection {
  return sort === 'name' ? 'asc' : 'desc';
}

export function parseShowListState(raw: ShowSearchParams, companyId: string): ShowListState {
  const sort: ShowSortKey = raw.sort === 'created' ? 'created' : DEFAULT_SHOW_SORT;
  const direction: SortDirection =
    raw.dir === 'asc' ? 'asc' : raw.dir === 'desc' ? 'desc' : defaultDirectionFor(sort);

  // Anything the enum does not name is no filter at all. A URL is hostile input,
  // and `kind=DROP` must leave the list showing everything rather than reaching
  // PostgREST as a value it will refuse.
  const requestedKind = raw.kind?.trim();
  const kind = SHOW_KINDS.find((known) => known === requestedKind);

  return {
    companyId,
    stationSearch: raw.station?.trim() || undefined,
    search: raw.q?.trim() || undefined,
    kind,
    includeEnded: raw.ended === '1',
    sort,
    direction,
  };
}

export function hasActiveShowFilters(state: ShowListState): boolean {
  return Boolean(state.search || state.kind || state.includeEnded);
}

/**
 * The whole address, rebuilt from the state every time.
 *
 * Block 30e, D1: there is no cursor to omit any more. The screen shows every
 * programme, so a link only ever carries the Station, the filters and the sort.
 */
export function showHref(state: ShowListState): string {
  const query = new URLSearchParams();
  query.set('companyId', state.companyId);
  if (state.stationSearch) query.set('station', state.stationSearch);
  if (state.search) query.set('q', state.search);
  if (state.kind) query.set('kind', state.kind);
  if (state.includeEnded) query.set('ended', '1');
  if (state.sort !== DEFAULT_SHOW_SORT) query.set('sort', state.sort);
  if (state.direction !== defaultDirectionFor(state.sort)) query.set('dir', state.direction);
  return `/shows?${query.toString()}`;
}

/** Clicking the sorted column flips it; clicking another starts from that column's own natural direction. */
export function showSortHref(state: ShowListState, sort: ShowSortKey): string {
  const direction: SortDirection =
    state.sort === sort ? (state.direction === 'asc' ? 'desc' : 'asc') : defaultDirectionFor(sort);
  return showHref({ ...state, sort, direction });
}
