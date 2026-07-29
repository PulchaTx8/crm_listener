import type { PrizeSortKey } from '@/services/inventory';
import type { SortDirection } from '@/lib/keyset';

/**
 * The inventory screen's URL contract, in one place for the same reason the
 * audience screen has one (members/list-params.ts): the Server Component that
 * reads it, the filter form that writes it and the sort/paging links that
 * rewrite parts of it all have to agree, and a second hand-rolled query
 * string is how a Station selection silently stops surviving a sort click.
 *
 * `companyId` is the one parameter that predates this block — the Station
 * switcher has always used it — and every link built here carries it.
 */

export interface InventorySearchParams {
  companyId?: string;
  station?: string;
  q?: string;
  cat?: string;
  sort?: string;
  dir?: string;
  after?: string;
  before?: string;
}

export interface InventoryListState {
  companyId: string;
  /**
   * A Station-name search, when the caller's Station list was capped and they
   * narrowed it. Carried by every link on the screen: dropping it would put
   * the Station list back to its capped first page, and a Station only
   * reachable THROUGH the search would fall out of it — silently moving the
   * caller to somebody else's inventory on the next sort click.
   */
  stationSearch?: string;
  search?: string;
  /** A category id, or the "uncategorised" sentinel; undefined means every category. */
  categoryId?: string;
  sort: PrizeSortKey;
  direction: SortDirection;
}

export interface InventoryCursor {
  side: 'after' | 'before';
  value: string;
}

/** Alphabetical: the catalogue is browsed by name, unlike the audience, which is browsed by recency. */
export const DEFAULT_PRIZE_SORT: PrizeSortKey = 'name';

export function defaultDirectionFor(sort: PrizeSortKey): SortDirection {
  return sort === 'name' ? 'asc' : 'desc';
}

/**
 * `companyId` is resolved by the page against the Stations the caller can
 * actually reach before it gets here, so this only carries it — a tampered
 * value falls back to the caller's first Station there, as it always has.
 */
export function parseInventoryListState(
  raw: InventorySearchParams,
  companyId: string,
): InventoryListState {
  const sort: PrizeSortKey = raw.sort === 'created' ? 'created' : DEFAULT_PRIZE_SORT;
  const direction: SortDirection =
    raw.dir === 'asc' ? 'asc' : raw.dir === 'desc' ? 'desc' : defaultDirectionFor(sort);

  return {
    companyId,
    stationSearch: raw.station?.trim() || undefined,
    search: raw.q?.trim() || undefined,
    categoryId: raw.cat?.trim() || undefined,
    sort,
    direction,
  };
}

export function parseInventoryCursor(raw: InventorySearchParams): InventoryCursor | null {
  if (raw.before) return { side: 'before', value: raw.before };
  if (raw.after) return { side: 'after', value: raw.after };
  return null;
}

export function hasActiveInventoryFilters(state: InventoryListState): boolean {
  return Boolean(state.search || state.categoryId);
}

/**
 * Omitting the cursor is how a filter or sort change resets paging, and it
 * must: a cursor is a position in one ordering of one result set.
 */
export function inventoryHref(state: InventoryListState, cursor?: InventoryCursor | null): string {
  const query = new URLSearchParams();
  query.set('companyId', state.companyId);
  if (state.stationSearch) query.set('station', state.stationSearch);
  if (state.search) query.set('q', state.search);
  if (state.categoryId) query.set('cat', state.categoryId);
  if (state.sort !== DEFAULT_PRIZE_SORT) query.set('sort', state.sort);
  if (state.direction !== defaultDirectionFor(state.sort)) query.set('dir', state.direction);
  if (cursor) query.set(cursor.side, cursor.value);
  return `/inventory?${query.toString()}`;
}

/** Clicking the sorted column flips it; clicking another starts from that column's own natural direction. */
export function inventorySortHref(state: InventoryListState, sort: PrizeSortKey): string {
  const direction: SortDirection =
    state.sort === sort
      ? state.direction === 'asc'
        ? 'desc'
        : 'asc'
      : defaultDirectionFor(sort);
  return inventoryHref({ ...state, sort, direction });
}
