import type { MemberSortKey } from '@/services/members';
import type { SortDirection } from '@/lib/keyset';

/**
 * The audience screen's URL contract, in one place because three callers have
 * to agree on it: the Server Component that reads it, the filter form that
 * writes it, and the sort/paging links that rewrite parts of it while leaving
 * the rest alone. A second hand-rolled query string anywhere is how a filter
 * silently stops surviving a sort click.
 *
 * Filters, sort and cursor travel in the URL rather than in client state, so
 * a filtered page is a link somebody can send to a colleague — spec §4.
 */

/** Raw `searchParams`, before any of it is trusted. Every value here is caller-controlled. */
export interface MemberListSearchParams {
  q?: string;
  /** A Station-name search, used only by the registration card's Station list — never by the audience query. */
  station?: string;
  sort?: string;
  dir?: string;
  after?: string;
  before?: string;
  ageMin?: string;
  ageMax?: string;
  blocked?: string;
  consent?: string;
  from?: string;
  to?: string;
}

/** Everything except the cursor: what the filter form edits and what sort links preserve. */
export interface MemberListState {
  search?: string;
  /**
   * A Station-name search. It narrows the REGISTRATION card's Station list,
   * never the audience query, and it is carried by every link on the screen
   * for the same reason the inventory screen carries its own: a selection the
   * caller made should not evaporate on the next sort click. Deliberately not
   * counted by hasActiveFilters — it filters Stations, not listeners.
   */
  stationSearch?: string;
  sort: MemberSortKey;
  direction: SortDirection;
  ageMin?: number;
  ageMax?: number;
  blockedOnly: boolean;
  /** 'yes' — the latest rules consent is a grant; 'no' — it is not, or there is none. */
  consent?: 'yes' | 'no';
  /** Instants, converted from the operator's calendar days in the browser (see members-filters.tsx). */
  registeredFrom?: string;
  registeredTo?: string;
}

export interface MemberListCursor {
  side: 'after' | 'before';
  value: string;
}

/** Newest first: what a support desk reaches for absent a reason to look further back. */
export const DEFAULT_SORT: MemberSortKey = 'created';

/** Sorting a name Z→A by default would be perverse; sorting registrations oldest-first equally so. */
export function defaultDirectionFor(sort: MemberSortKey): SortDirection {
  return sort === 'name' ? 'asc' : 'desc';
}

/** Nobody is 200. A bound here keeps a hand-edited URL from turning an age band into a date far outside any index. */
const MAX_AGE = 130;

function parseAge(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value < 0 || value > MAX_AGE) return undefined;
  return value;
}

/** An unparseable instant is dropped rather than passed on: a filter nobody can read is not a filter. */
function parseInstant(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

/**
 * Everything arriving here is a URL query parameter, so everything is
 * hostile input. Nothing throws: an unreadable value falls back to the
 * default, exactly as decodeCursor (src/lib/keyset.ts) returns null rather
 * than an error page for a cursor somebody has been typing into.
 */
export function parseMemberListState(raw: MemberListSearchParams): MemberListState {
  const sort: MemberSortKey = raw.sort === 'name' ? 'name' : DEFAULT_SORT;
  const direction: SortDirection =
    raw.dir === 'asc' ? 'asc' : raw.dir === 'desc' ? 'desc' : defaultDirectionFor(sort);

  return {
    search: raw.q?.trim() || undefined,
    stationSearch: raw.station?.trim() || undefined,
    sort,
    direction,
    ageMin: parseAge(raw.ageMin),
    ageMax: parseAge(raw.ageMax),
    blockedOnly: raw.blocked === '1',
    consent: raw.consent === 'yes' ? 'yes' : raw.consent === 'no' ? 'no' : undefined,
    registeredFrom: parseInstant(raw.from),
    registeredTo: parseInstant(raw.to),
  };
}

export function parseMemberListCursor(raw: MemberListSearchParams): MemberListCursor | null {
  if (raw.before) return { side: 'before', value: raw.before };
  if (raw.after) return { side: 'after', value: raw.after };
  return null;
}

/** True when the screen is showing anything other than the whole audience. */
export function hasActiveFilters(state: MemberListState): boolean {
  return Boolean(
    state.search ||
      state.ageMin !== undefined ||
      state.ageMax !== undefined ||
      state.blockedOnly ||
      state.consent ||
      state.registeredFrom ||
      state.registeredTo,
  );
}

/**
 * Builds the screen's URL from a state and, optionally, a cursor.
 *
 * Omitting the cursor is how every caller that changes what is being listed —
 * a new filter, a new sort — resets paging, and it must: a cursor is a
 * position in one particular ordering of one particular result set, so
 * carrying it across a change to either resumes from a row that no longer
 * means anything.
 *
 * Defaults are left out of the URL so the common case stays a clean `/members`.
 */
export function membersHref(state: MemberListState, cursor?: MemberListCursor | null): string {
  const query = new URLSearchParams();

  if (state.search) query.set('q', state.search);
  if (state.stationSearch) query.set('station', state.stationSearch);
  if (state.sort !== DEFAULT_SORT) query.set('sort', state.sort);
  if (state.direction !== defaultDirectionFor(state.sort)) query.set('dir', state.direction);
  if (state.ageMin !== undefined) query.set('ageMin', String(state.ageMin));
  if (state.ageMax !== undefined) query.set('ageMax', String(state.ageMax));
  if (state.blockedOnly) query.set('blocked', '1');
  if (state.consent) query.set('consent', state.consent);
  if (state.registeredFrom) query.set('from', state.registeredFrom);
  if (state.registeredTo) query.set('to', state.registeredTo);
  if (cursor) query.set(cursor.side, cursor.value);

  const search = query.toString();
  return search ? `/members?${search}` : '/members';
}

/**
 * The href a column header points at: clicking the column already sorted
 * flips its direction, clicking any other column starts from that column's
 * own natural direction rather than inheriting the previous column's.
 */
export function sortHref(state: MemberListState, sort: MemberSortKey): string {
  const direction: SortDirection =
    state.sort === sort
      ? state.direction === 'asc'
        ? 'desc'
        : 'asc'
      : defaultDirectionFor(sort);
  return membersHref({ ...state, sort, direction });
}
