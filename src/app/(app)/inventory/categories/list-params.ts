import type { PrizeCategorySortKey } from '@/services/inventory';
import type { SortDirection } from '@/lib/keyset';

/**
 * Block 26. The Categories screen's URL contract, on the shape of
 * `vendors/list-params.ts`: the Server Component that reads it, the filter form
 * that writes it and the sort and paging links that rewrite parts of it all have
 * to agree, and a second hand-rolled query string is how a Station selection
 * silently stops surviving a sort click.
 *
 * ONE FILTER, because a category is a name. The Station switcher above the grid
 * is the other half of "where am I looking" and it travels in `companyId` and
 * `station`, exactly as it does on Stock, Movements and Vendors.
 */

export interface PrizeCategorySearchParams {
  companyId?: string;
  station?: string;
  q?: string;
  sort?: string;
  dir?: string;
  after?: string;
  before?: string;
  record?: string;
}

export interface PrizeCategoryListState {
  companyId: string;
  /**
   * A Station-name search, when the caller's Station list was capped and they
   * narrowed it. Carried by every link, for the reason vendors records: dropping
   * it puts the Station list back to its capped first page, and a Station only
   * reachable THROUGH the search falls out of it.
   */
  stationSearch?: string;
  search?: string;
  sort: PrizeCategorySortKey;
  direction: SortDirection;
}

export interface PrizeCategoryCursor {
  side: 'after' | 'before';
  value: string;
}

/** Alphabetical: a list of labels is browsed by name, not by when somebody typed it. */
export const DEFAULT_PRIZE_CATEGORY_SORT: PrizeCategorySortKey = 'name';

export function defaultDirectionFor(sort: PrizeCategorySortKey): SortDirection {
  return sort === 'name' ? 'asc' : 'desc';
}

export function parsePrizeCategoryListState(
  raw: PrizeCategorySearchParams,
  companyId: string,
): PrizeCategoryListState {
  const sort: PrizeCategorySortKey = raw.sort === 'created' ? 'created' : DEFAULT_PRIZE_CATEGORY_SORT;
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

export function parsePrizeCategoryCursor(
  raw: PrizeCategorySearchParams,
): PrizeCategoryCursor | null {
  if (raw.before) return { side: 'before', value: raw.before };
  if (raw.after) return { side: 'after', value: raw.after };
  return null;
}

export function hasActivePrizeCategoryFilters(state: PrizeCategoryListState): boolean {
  return Boolean(state.search);
}

/**
 * Omitting the cursor is how a filter or sort change resets paging, and it must:
 * a cursor is a position in one ordering of one result set.
 */
export function prizeCategoryHref(
  state: PrizeCategoryListState,
  cursor?: PrizeCategoryCursor | null,
): string {
  const query = new URLSearchParams();
  query.set('companyId', state.companyId);
  if (state.stationSearch) query.set('station', state.stationSearch);
  if (state.search) query.set('q', state.search);
  if (state.sort !== DEFAULT_PRIZE_CATEGORY_SORT) query.set('sort', state.sort);
  if (state.direction !== defaultDirectionFor(state.sort)) query.set('dir', state.direction);
  if (cursor) query.set(cursor.side, cursor.value);
  return `/inventory/categories?${query.toString()}`;
}

/** Clicking the sorted column flips it; clicking another starts from that column's own natural direction. */
export function prizeCategorySortHref(
  state: PrizeCategoryListState,
  sort: PrizeCategorySortKey,
): string {
  const direction: SortDirection =
    state.sort === sort ? (state.direction === 'asc' ? 'desc' : 'asc') : defaultDirectionFor(sort);
  return prizeCategoryHref({ ...state, sort, direction });
}

/**
 * The Stock screen, narrowed to one category — where the grid's Prizes count
 * links to. Built here rather than with `inventoryHref` because that function
 * takes an `InventoryListState`, and this screen has no sort, direction or
 * search belonging to THAT list to hand it; inventing defaults for three of its
 * fields to reach one parameter would be a second, silent copy of Stock's URL
 * contract. What it does share is the parameter's spelling, and `cat` is stated
 * once here, next to the only link that uses it.
 */
export function prizesInCategoryHref(
  state: PrizeCategoryListState,
  categoryId: string,
): string {
  const query = new URLSearchParams();
  query.set('companyId', state.companyId);
  if (state.stationSearch) query.set('station', state.stationSearch);
  query.set('cat', categoryId);
  return `/inventory?${query.toString()}`;
}
