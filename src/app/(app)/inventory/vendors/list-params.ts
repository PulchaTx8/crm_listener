import type { VendorSortKey } from '@/services/vendors';
import type { SortDirection } from '@/lib/keyset';

/**
 * Block 24, item 7. The Vendors screen's URL contract, on the shape of
 * `shows/list-params.ts`: the Server Component that reads it, the filter form
 * that writes it and the sort and paging links that rewrite parts of it all have
 * to agree, and a second hand-rolled query string is how a Station selection
 * silently stops surviving a sort click.
 */

export interface VendorSearchParams {
  companyId?: string;
  station?: string;
  q?: string;
  city?: string;
  sort?: string;
  dir?: string;
  after?: string;
  before?: string;
  record?: string;
}

export interface VendorListState {
  companyId: string;
  /**
   * A Station-name search, when the caller's Station list was capped and they
   * narrowed it. Carried by every link, for the reason shows records: dropping
   * it puts the Station list back to its capped first page, and a Station only
   * reachable THROUGH the search falls out of it.
   */
  stationSearch?: string;
  search?: string;
  city?: string;
  sort: VendorSortKey;
  direction: SortDirection;
}

export interface VendorCursor {
  side: 'after' | 'before';
  value: string;
}

/** Alphabetical: a supplier list is browsed by name, not by when somebody typed it. */
export const DEFAULT_VENDOR_SORT: VendorSortKey = 'name';

export function defaultDirectionFor(sort: VendorSortKey): SortDirection {
  return sort === 'name' ? 'asc' : 'desc';
}

export function parseVendorListState(
  raw: VendorSearchParams,
  companyId: string,
): VendorListState {
  const sort: VendorSortKey = raw.sort === 'created' ? 'created' : DEFAULT_VENDOR_SORT;
  const direction: SortDirection =
    raw.dir === 'asc' ? 'asc' : raw.dir === 'desc' ? 'desc' : defaultDirectionFor(sort);

  return {
    companyId,
    stationSearch: raw.station?.trim() || undefined,
    search: raw.q?.trim() || undefined,
    // Not validated against the known list here, unlike `shows`' kind: a city is
    // free text on the record, so there is no enum to check it against. It
    // reaches PostgREST as an equality filter on a text column, which is a
    // parameterised comparison rather than an interpolation — a nonsense value
    // matches nothing, which is the honest answer to a nonsense filter.
    city: raw.city?.trim() || undefined,
    sort,
    direction,
  };
}

export function parseVendorCursor(raw: VendorSearchParams): VendorCursor | null {
  if (raw.before) return { side: 'before', value: raw.before };
  if (raw.after) return { side: 'after', value: raw.after };
  return null;
}

export function hasActiveVendorFilters(state: VendorListState): boolean {
  return Boolean(state.search || state.city);
}

/**
 * Omitting the cursor is how a filter or sort change resets paging, and it must:
 * a cursor is a position in one ordering of one result set.
 */
export function vendorHref(state: VendorListState, cursor?: VendorCursor | null): string {
  const query = new URLSearchParams();
  query.set('companyId', state.companyId);
  if (state.stationSearch) query.set('station', state.stationSearch);
  if (state.search) query.set('q', state.search);
  if (state.city) query.set('city', state.city);
  if (state.sort !== DEFAULT_VENDOR_SORT) query.set('sort', state.sort);
  if (state.direction !== defaultDirectionFor(state.sort)) query.set('dir', state.direction);
  if (cursor) query.set(cursor.side, cursor.value);
  return `/inventory/vendors?${query.toString()}`;
}

/** Clicking the sorted column flips it; clicking another starts from that column's own natural direction. */
export function vendorSortHref(state: VendorListState, sort: VendorSortKey): string {
  const direction: SortDirection =
    state.sort === sort ? (state.direction === 'asc' ? 'desc' : 'asc') : defaultDirectionFor(sort);
  return vendorHref({ ...state, sort, direction });
}
