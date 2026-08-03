import type { WinnerStatus } from '@/services/pickups';

/**
 * The pickups screen's URL contract, the same reason participations/list-params.ts
 * gives for its own: the Server Component that reads it, the filter bar that
 * writes it and the paging links that rewrite parts of it all have to agree.
 *
 * A type-only import from `@/services/pickups`, which is `server-only`: a type
 * is erased at build time, so pickups-filters.tsx and pickups-grid.tsx — both
 * client components — can import this module without pulling the service
 * across the boundary. Block 4b's own defect (a Server Component reading a
 * value out of a client module and silently getting `undefined`) is the other
 * direction of the same rule; this is the direction that actually works, and
 * participations/list-params.ts's own comment is the fuller account.
 */

export interface PickupSearchParams {
  companyId?: string;
  station?: string;
  promotion?: string;
  status?: string;
  q?: string;
  after?: string;
  before?: string;
}

/**
 * The id of the page's explanation of why the listener search is unavailable.
 * page.tsx puts it on the paragraph; pickups-filters.tsx points
 * `aria-describedby` at it from the disabled input, so the two ends of that
 * link cannot drift — the exact same reasoning and the exact same placement
 * participations/list-params.ts's own SEARCH_NOTE_ID gives: a Server Component
 * importing a value out of a client module gets a registered client
 * reference rather than the value (Block 4b), so this lives in a module
 * neither side treats as the other's.
 */
export const SEARCH_NOTE_ID = 'pickup-search-note';

/** `'all'` is a filter, not a status: it is how the URL says "do not narrow by status at all". */
export const ANY_STATUS = 'all';
export type PickupStatusFilter = WinnerStatus | typeof ANY_STATUS;

/**
 * The five statuses in the order the design spec's own filter lists them
 * (6.2): the one still open without incident, the one the clock parked, then
 * the three ways a prize leaves this list for good.
 */
export const PICKUP_STATUSES: readonly WinnerStatus[] = [
  'AWAITING_PICKUP',
  'RETURN_PENDING',
  'DELIVERED',
  'RETURNED',
  'WRITTEN_OFF',
];

/**
 * Operator English, not enum text — the global constraint every screen in
 * this codebase carries, and named explicitly here because these five are
 * exactly the words an operator reads on the button and the filter both.
 */
export const STATUS_LABELS: Record<WinnerStatus, string> = {
  AWAITING_PICKUP: 'Awaiting pickup',
  RETURN_PENDING: 'Return pending',
  DELIVERED: 'Delivered',
  RETURNED: 'Returned',
  WRITTEN_OFF: 'Written off',
};

/**
 * One warm colour for each of the two statuses still open (the clock has not
 * finished with them), one calm colour for the one that closed well, and one
 * muted family shared by the two that closed without the prize changing
 * hands — the same reasoning participation-status.ts's own STATUS_CLASSES
 * gives for sharing a look across outcomes that are, from the operator's
 * question, the same answer.
 */
export const STATUS_CLASSES: Record<WinnerStatus, string> = {
  AWAITING_PICKUP: 'bg-amber-100 text-amber-900',
  RETURN_PENDING: 'bg-orange-100 text-orange-900',
  DELIVERED: 'bg-emerald-100 text-emerald-900',
  RETURNED: 'bg-muted text-muted-foreground',
  WRITTEN_OFF: 'bg-muted text-muted-foreground',
};

/**
 * The screen opens on every winner, unnarrowed by status — unlike
 * participations, whose default (VALID) is design spec D5's own decision,
 * nothing in this block's design spec (§6.2) asks the pickups list to open
 * pre-filtered. `list_pickups`'s own `p_status` defaults to null for the same
 * reading: "no filter" is the RPC's own resting state, not a screen invention
 * layered on top of it.
 */
export const DEFAULT_PICKUP_STATUS: PickupStatusFilter = ANY_STATUS;

export interface PickupListState {
  companyId: string;
  /** A Station-name search, carried by every link for the reason inventory/list-params.ts gives. */
  stationSearch?: string;
  /** One promotion. */
  promotionId?: string;
  /** Never undefined: absent from the URL means ANY_STATUS, same as the RPC's own default. */
  status: PickupStatusFilter;
  /**
   * By listener name or phone. Needs a permission this screen's other filters
   * do not — members.view — see ./access.ts and list_pickups' own Rule 3
   * (0095): searching a field you may not read is an oracle.
   */
  search?: string;
}

export interface PickupCursor {
  side: 'after' | 'before';
  value: string;
}

/**
 * There is no sort key and no direction in this URL, and that absence is
 * deliberate rather than an omission — the same reasoning participations/
 * list-params.ts states for its own screen. listPickups orders by
 * (deadline_at, id) ascending, fixed, because that is exactly what
 * list_pickups (0095) itself is written to serve and a keyset cursor must
 * compare precisely the columns it orders by.
 */

function parseStatus(raw: string | undefined): PickupStatusFilter {
  const value = raw?.trim();
  if (!value || value === ANY_STATUS) return ANY_STATUS;
  // Anything unrecognised falls back to no filter rather than being refused —
  // a hand-edited URL should not be an error page, the same contract
  // parseStatus in participations/list-params.ts and parseRecordParam both carry
  // for their own hostile input.
  return PICKUP_STATUSES.find((s) => s === value) ?? ANY_STATUS;
}

export function parsePickupListState(
  raw: PickupSearchParams,
  companyId: string,
): PickupListState {
  return {
    companyId,
    stationSearch: raw.station?.trim() || undefined,
    promotionId: raw.promotion?.trim() || undefined,
    status: parseStatus(raw.status),
    search: raw.q?.trim() || undefined,
  };
}

export function parsePickupCursor(raw: PickupSearchParams): PickupCursor | null {
  if (raw.before) return { side: 'before', value: raw.before };
  if (raw.after) return { side: 'after', value: raw.after };
  return null;
}

/** Whether any filter narrows this screen away from how it opens. */
export function hasActivePickupFilters(state: PickupListState): boolean {
  return Boolean(
    state.promotionId || state.status !== DEFAULT_PICKUP_STATUS || state.search,
  );
}

/**
 * Omitting the cursor is how a filter change resets paging, and it must: a
 * cursor is a position in one ordering of one result set — the same rule
 * participationsHref carries.
 *
 * The default status is written as an ABSENCE rather than as `status=all`,
 * which keeps the parse and the link agreeing about one thing: a URL with no
 * status parameter and a URL this function produced for ANY_STATUS are the
 * same list.
 */
export function pickupsHref(state: PickupListState, cursor?: PickupCursor | null): string {
  const query = new URLSearchParams();
  query.set('companyId', state.companyId);
  if (state.stationSearch) query.set('station', state.stationSearch);
  if (state.promotionId) query.set('promotion', state.promotionId);
  if (state.status !== DEFAULT_PICKUP_STATUS) query.set('status', state.status);
  if (state.search) query.set('q', state.search);
  if (cursor) query.set(cursor.side, cursor.value);
  return `/pickups?${query.toString()}`;
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** Whole units only — "overdue by 1 day", never "1 day, 3 hours, 12 minutes". */
function roughDuration(ms: number): string {
  const minutes = Math.round(ms / MINUTE_MS);
  if (minutes < 1) return 'under a minute';
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  const hours = Math.round(ms / HOUR_MS);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'}`;
  const days = Math.round(ms / DAY_MS);
  return `${days} day${days === 1 ? '' : 's'}`;
}

/**
 * The deadline column's whole reason for existing (this task's own brief):
 * `sweep_pickup_deadlines` (0094) runs hourly, so a winner can sit
 * AWAITING_PICKUP with `deadlineAt` already in the past for up to an hour
 * before the sweep parks it in RETURN_PENDING. A column that waited for the
 * status to say RETURN_PENDING before admitting the deadline had passed would
 * tell the operator a prize is fine for that whole window — so this reads the
 * DATE, not the status, for both of the two LIVE statuses (AWAITING_PICKUP and
 * RETURN_PENDING alike; the sweep's own transition between them changes
 * nothing about whether the clock has already run out).
 *
 * `status` still matters for the other three: DELIVERED, RETURNED and
 * WRITTEN_OFF are the three ways a prize leaves this list for good
 * (winner-actions.tsx's own comment), and once a matter is resolved a
 * deadline that already passed is not a problem an operator can still act on
 * — "overdue by 3 days" beside a Delivered badge would read as an alarm this
 * screen's own Status column already says is settled.
 */
export function describeDeadline(deadlineAt: Date | string | null, status: WinnerStatus): string {
  if (status === 'DELIVERED' || status === 'RETURNED' || status === 'WRITTEN_OFF') return '—';
  if (!deadlineAt) return 'no deadline';

  const date = typeof deadlineAt === 'string' ? new Date(deadlineAt) : deadlineAt;
  const diffMs = date.getTime() - Date.now();
  if (diffMs <= 0) return `overdue by ${roughDuration(-diffMs)}`;
  return `due in ${roughDuration(diffMs)}`;
}
