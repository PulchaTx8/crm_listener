import { PARTICIPATION_STATUSES } from '@/lib/participation-status';
import type { ParticipationStatus } from '@/lib/participation-status';
import type { ParticipationSource } from '@/services/participations';

/**
 * The participations screen's URL contract, in one place for the same reason
 * the inventory, audience and promotions screens have one: the Server Component
 * that reads it, the filter bar that writes it and the paging links that
 * rewrite parts of it all have to agree, and a second hand-rolled query string
 * is how a Station selection silently stops surviving a filter change.
 *
 * A type-only import from `@/services/participations`, which is `server-only`:
 * a type is erased at build time, so the filter bar — a client component — can
 * import this module without pulling the service across the boundary. The
 * runtime halves it needs (the status vocabulary above, the source labels
 * below) are values, and values cannot cross that line; @/lib/participation-status
 * is where the status ones live for exactly that reason, and this file's own
 * `SOURCE_LABELS` sits here rather than beside them because only this screen
 * ever renders a source.
 */

export interface ParticipationSearchParams {
  companyId?: string;
  station?: string;
  promotion?: string;
  status?: string;
  source?: string;
  from?: string;
  to?: string;
  q?: string;
  after?: string;
  before?: string;
}

/** `'all'` is a filter, not a status: it is how the URL says "do not narrow by status at all". */
export const ANY_STATUS = 'all';
export type ParticipationStatusFilter = ParticipationStatus | typeof ANY_STATUS;

/**
 * The screen opens on the entries that counted, because almost every question
 * asked of it — how many are in the draw, who is in it — is about those.
 *
 * The cost of that default is the whole reason design spec D5 exists: a refusal
 * is WRITTEN DOWN with the status that says what happened, rather than thrown
 * away, and an operator who never learns the default is on would conclude from
 * this screen that the refused attempts were never recorded. So the status
 * control is rendered with the others rather than hidden behind an "advanced"
 * disclosure, `'all'` is one click away, and page.tsx says in words that a
 * default is narrowing the list. A default that hides rows without saying so
 * would make this screen lie about the one thing the block was built to prove.
 */
export const DEFAULT_PARTICIPATION_STATUS: ParticipationStatusFilter = 'VALID';

/**
 * How a row got here, written from the operator's side rather than the enum's.
 * MANUAL and IMPORT are recorded, never consulted — the source says how the row
 * arrived and decides nothing about who may write it (0054) — so these are
 * labels over a contract that lives in the database.
 */
export const SOURCE_LABELS: Record<ParticipationSource, string> = {
  MANUAL: 'Entered by hand',
  IMPORT: 'From a file',
};

export const SOURCE_ORDER: ParticipationSource[] = ['MANUAL', 'IMPORT'];

/**
 * The id of the page's explanation of why the listener search is unavailable.
 * page.tsx puts it on the paragraph; the filter bar points `aria-describedby` at
 * it from the disabled input, so the two ends of that link cannot drift.
 *
 * Here, and NOT beside the input it describes, because the input's module opens
 * with 'use client'. A Server Component importing a value from a client module
 * does not get the value — React hands back a registered client reference, which
 * is a function — and this branch already carries a commit that moved six
 * screens' tab tuples into @/lib/record-params.ts for precisely that reason
 * (`parseRecordParam` read `.includes` off a function and threw, while `[0]`
 * answered undefined and quietly stopped validating). A string survives that
 * round trip well enough to render today, which makes it the quiet half of the
 * same defect rather than a different one. This module is imported by both files
 * and is not a client module, so it is the one place both can read it from.
 */
export const SEARCH_NOTE_ID = 'participation-search-note';

export interface ParticipationListState {
  companyId: string;
  /** A Station-name search, carried by every link for the reason inventory/list-params.ts gives. */
  stationSearch?: string;
  /** One promotion. Also how a promotion's own record links into this screen. */
  promotionId?: string;
  /** Never undefined: absent from the URL means the default above, not "any". */
  status: ParticipationStatusFilter;
  source?: ParticipationSource;
  /** Instants, converted from the operator's calendar days in the Station's zone. */
  from?: string;
  to?: string;
  /**
   * By listener name, phone or CPF digits. Unlike every other filter here, this
   * one needs a permission the rest of the screen does not — see ./access.ts.
   */
  search?: string;
}

export interface ParticipationCursor {
  side: 'after' | 'before';
  value: string;
}

/**
 * There is no sort key and no direction, and their absence is deliberate rather
 * than an omission: listParticipationsPage orders by `participated_at` desc
 * tie-broken by id, fixed, because that is exactly what participations_listing_idx
 * (0052) carries and a keyset cursor must compare precisely the columns it
 * orders by. An ordering the index does not serve would scan the Station, so
 * offering one in the URL would be offering a way to make the screen slow. The
 * promotions screen's `promotionSortHref` has no participations counterpart for
 * that reason.
 */

function parseStatus(raw: string | undefined): ParticipationStatusFilter {
  const value = raw?.trim();
  if (value === ANY_STATUS) return ANY_STATUS;
  // Anything unrecognised falls back to the default rather than being refused —
  // a hand-edited URL should not be an error page, the same contract
  // decodeCursor and parseRecordParam carry for their own hostile input.
  return PARTICIPATION_STATUSES.find((s) => s === value) ?? DEFAULT_PARTICIPATION_STATUS;
}

function parseSource(raw: string | undefined): ParticipationSource | undefined {
  const value = raw?.trim();
  return SOURCE_ORDER.find((s) => s === value);
}

/** Anything unparseable is ignored rather than refused, for the reason parseStatus gives. */
function parseInstant(raw: string | undefined): string | undefined {
  const value = raw?.trim();
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : new Date(parsed).toISOString();
}

export function parseParticipationListState(
  raw: ParticipationSearchParams,
  companyId: string,
): ParticipationListState {
  return {
    companyId,
    stationSearch: raw.station?.trim() || undefined,
    promotionId: raw.promotion?.trim() || undefined,
    status: parseStatus(raw.status),
    source: parseSource(raw.source),
    from: parseInstant(raw.from),
    to: parseInstant(raw.to),
    search: raw.q?.trim() || undefined,
  };
}

export function parseParticipationCursor(
  raw: ParticipationSearchParams,
): ParticipationCursor | null {
  if (raw.before) return { side: 'before', value: raw.before };
  if (raw.after) return { side: 'after', value: raw.after };
  return null;
}

/**
 * A status of anything but the default counts as an active filter, `'all'`
 * included: "Clear filters" has to be able to take the operator back to the
 * screen as it opens, and if widening to every status did not register as a
 * change there would be no control that undoes it.
 */
export function hasActiveParticipationFilters(state: ParticipationListState): boolean {
  return Boolean(
    state.promotionId ||
      state.status !== DEFAULT_PARTICIPATION_STATUS ||
      state.source ||
      state.from ||
      state.to ||
      state.search,
  );
}

/**
 * Omitting the cursor is how a filter change resets paging, and it must: a
 * cursor is a position in one ordering of one result set.
 *
 * The default status is written as an ABSENCE rather than as `status=VALID`,
 * which keeps the parse and the link agreeing about one thing: a URL with no
 * status parameter and a URL this function produced for the default are the
 * same list.
 */
export function participationsHref(
  state: ParticipationListState,
  cursor?: ParticipationCursor | null,
): string {
  const query = new URLSearchParams();
  query.set('companyId', state.companyId);
  if (state.stationSearch) query.set('station', state.stationSearch);
  if (state.promotionId) query.set('promotion', state.promotionId);
  if (state.status !== DEFAULT_PARTICIPATION_STATUS) query.set('status', state.status);
  if (state.source) query.set('source', state.source);
  if (state.from) query.set('from', state.from);
  if (state.to) query.set('to', state.to);
  if (state.search) query.set('q', state.search);
  if (cursor) query.set(cursor.side, cursor.value);
  return `/participations?${query.toString()}`;
}
