import type { ShowKind, ShowSortKey } from '@/services/shows';
import type { SortDirection } from '@/lib/keyset';
import { SHOW_KINDS } from '@/schemas/shows';
import { isoWeekStart } from '@/lib/shows/week-grid';

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
  /** Block 30e: `schedule` draws the week; anything else is the list. */
  view?: string;
  /** Block 30e: any date inside the week to draw; normalised to its Monday. */
  week?: string;
  record?: string;
}

/** Block 30e, item 12. Two views of one list. */
export type ShowView = 'list' | 'schedule';

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
  /**
   * D6. Two views of ONE list, under one set of filters, which is why this is a
   * parameter rather than a second route: every link on this screen is built by
   * `showHref`, and a second route would need the whole filter contract copied
   * into it. Block 20b's `?tab=` mistake was the opposite situation — an item
   * that asked for tabs to STOP EXISTING, kept alive under another name.
   */
  view: ShowView;
  /**
   * The Monday of the week the grid draws. Absent means the week containing the
   * STATION's today, which only the page can resolve: this module is pure and
   * has no timezone of its own.
   */
  week?: string;
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

  // Anything the vocabulary does not name is the list, the same way an unknown
  // `kind` above is no filter at all: a URL is hostile input and a typo must not
  // be an error page.
  const view: ShowView = raw.view === 'schedule' ? 'schedule' : 'list';

  // A week that is not a date is dropped rather than refused; the page then falls
  // back to the week containing the Station's today. Normalised to its Monday
  // here, so a hand-typed Thursday and the arrow that produced its Monday are the
  // same week rather than two.
  const requestedWeek = raw.week?.trim() ?? '';
  const week = /^\d{4}-\d{2}-\d{2}$/.test(requestedWeek) ? isoWeekStart(requestedWeek) : undefined;

  return {
    companyId,
    stationSearch: raw.station?.trim() || undefined,
    search: raw.q?.trim() || undefined,
    kind,
    includeEnded: raw.ended === '1',
    sort,
    direction,
    view,
    week,
  };
}

/**
 * The VIEW and the WEEK are deliberately absent: neither narrows the list, and
 * counting them would make "Clear filters" throw the operator back to the list
 * view from the grid they were reading.
 */
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
  // The week rides along only on the view that draws one: a `week` on the list is
  // a parameter that names nothing, and it would survive into every link.
  if (state.view === 'schedule') {
    query.set('view', 'schedule');
    if (state.week) query.set('week', state.week);
  }
  return `/shows?${query.toString()}`;
}

/** Clicking the sorted column flips it; clicking another starts from that column's own natural direction. */
export function showSortHref(state: ShowListState, sort: ShowSortKey): string {
  const direction: SortDirection =
    state.sort === sort ? (state.direction === 'asc' ? 'desc' : 'asc') : defaultDirectionFor(sort);
  return showHref({ ...state, sort, direction });
}
