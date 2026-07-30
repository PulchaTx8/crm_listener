import type { PromotionSituation, PromotionSortKey } from '@/services/promotions';
import type { SortDirection } from '@/lib/keyset';

/**
 * The promotions screen's URL contract, in one place for the same reason the
 * inventory and audience screens have one: the Server Component that reads it,
 * the filter form that writes it and the sort/paging links that rewrite parts
 * of it all have to agree, and a second hand-rolled query string is how a
 * Station selection silently stops surviving a sort click.
 */

export interface PromotionSearchParams {
  companyId?: string;
  station?: string;
  q?: string;
  situation?: string;
  from?: string;
  to?: string;
  archived?: string;
  sort?: string;
  dir?: string;
  after?: string;
  before?: string;
}

export interface PromotionListState {
  companyId: string;
  /** A Station-name search, carried by every link for the reason inventory/list-params.ts gives. */
  stationSearch?: string;
  search?: string;
  /**
   * Which situation to show. Computed from starts_at, ends_at and cancelled_at
   * rather than stored, which is exactly why it FILTERS and does not SORT:
   * Block 3b proved a keyset cursor must compare the column it orders by, and
   * there is no column here to compare. `promotionSortHref` offers no link for
   * it, and that is deliberate rather than an omission.
   */
  situation?: PromotionSituation;
  /** Instants, converted from the operator's calendar days in the browser. */
  startsFrom?: string;
  startsTo?: string;
  /**
   * Show archived promotions too. Only the owner and the platform admin can
   * see anything when this is on — nobody else's reads return an archived row
   * at all (0044) — so the control is rendered only for them.
   */
  includeArchived: boolean;
  sort: PromotionSortKey;
  direction: SortDirection;
}

export interface PromotionCursor {
  side: 'after' | 'before';
  value: string;
}

/** Newest first: what somebody opening this screen is looking for is the promotion running now. */
export const DEFAULT_PROMOTION_SORT: PromotionSortKey = 'starts';

export function defaultDirectionFor(sort: PromotionSortKey): SortDirection {
  return sort === 'name' ? 'asc' : 'desc';
}

const SITUATIONS: PromotionSituation[] = ['scheduled', 'live', 'ended', 'cancelled'];

function parseSituation(raw: string | undefined): PromotionSituation | undefined {
  const value = raw?.trim();
  return SITUATIONS.find((s) => s === value);
}

/** Anything unparseable is ignored rather than refused — a hand-edited URL should not be an error page. */
function parseInstant(raw: string | undefined): string | undefined {
  const value = raw?.trim();
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : new Date(parsed).toISOString();
}

export function parsePromotionListState(
  raw: PromotionSearchParams,
  companyId: string,
): PromotionListState {
  const sort: PromotionSortKey = raw.sort === 'name' ? 'name' : DEFAULT_PROMOTION_SORT;
  const direction: SortDirection =
    raw.dir === 'asc' ? 'asc' : raw.dir === 'desc' ? 'desc' : defaultDirectionFor(sort);

  return {
    companyId,
    stationSearch: raw.station?.trim() || undefined,
    search: raw.q?.trim() || undefined,
    situation: parseSituation(raw.situation),
    startsFrom: parseInstant(raw.from),
    startsTo: parseInstant(raw.to),
    includeArchived: raw.archived === '1',
    sort,
    direction,
  };
}

export function parsePromotionCursor(raw: PromotionSearchParams): PromotionCursor | null {
  if (raw.before) return { side: 'before', value: raw.before };
  if (raw.after) return { side: 'after', value: raw.after };
  return null;
}

export function hasActivePromotionFilters(state: PromotionListState): boolean {
  return Boolean(
    state.search || state.situation || state.startsFrom || state.startsTo || state.includeArchived,
  );
}

/**
 * Omitting the cursor is how a filter or sort change resets paging, and it
 * must: a cursor is a position in one ordering of one result set.
 */
export function promotionsHref(
  state: PromotionListState,
  cursor?: PromotionCursor | null,
): string {
  const query = new URLSearchParams();
  query.set('companyId', state.companyId);
  if (state.stationSearch) query.set('station', state.stationSearch);
  if (state.search) query.set('q', state.search);
  if (state.situation) query.set('situation', state.situation);
  if (state.startsFrom) query.set('from', state.startsFrom);
  if (state.startsTo) query.set('to', state.startsTo);
  if (state.includeArchived) query.set('archived', '1');
  if (state.sort !== DEFAULT_PROMOTION_SORT) query.set('sort', state.sort);
  if (state.direction !== defaultDirectionFor(state.sort)) query.set('dir', state.direction);
  if (cursor) query.set(cursor.side, cursor.value);
  return `/promotions?${query.toString()}`;
}

/**
 * Clicking the sorted column flips it; clicking another starts from that
 * column's own natural direction.
 *
 * There is no entry for Situation, and there cannot be: see PromotionListState.
 */
export function promotionSortHref(state: PromotionListState, sort: PromotionSortKey): string {
  const direction: SortDirection =
    state.sort === sort
      ? state.direction === 'asc'
        ? 'desc'
        : 'asc'
      : defaultDirectionFor(sort);
  return promotionsHref({ ...state, sort, direction });
}
