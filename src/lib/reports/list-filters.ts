/**
 * Block 8b. The screen's filter state, translated into the report's.
 *
 * WHY THIS IS A MODULE AND NOT FOUR INLINE EXPRESSIONS. The two vocabularies
 * are deliberately different -- a screen carries a cursor, a sort, a page size
 * and a Station search that no report has -- so every mount site has to
 * translate. Four translations written inline at four call sites drift from
 * `reportRequestSchema` one at a time, and the failure is quiet in the worst
 * way: `.strict()` refuses the request, the operator sees "unrecognized key",
 * and nothing points at the screen that sent it.
 *
 * Here, one unit test parses every function's output through the real schema.
 *
 * EVERY FUNCTION OMITS RATHER THAN NULLS. `.strict()` accepts an absent
 * optional key and refuses an unknown one, and `JSON.stringify` drops
 * `undefined` -- so building the object with undefined values and letting it
 * serialise away is correct, and explicitly setting null would not be.
 */

const PARTICIPATION_STATUSES = new Set(['VALID', 'DUPLICATE', 'TOO_SOON', 'OVER_LIMIT']);
const PARTICIPATION_SOURCES = new Set(['MANUAL', 'IMPORT', 'WHATSAPP']);
const WINNER_STATUSES = new Set(['AWAITING_PICKUP', 'DELIVERED', 'RETURNED', 'WRITTEN_OFF']);
const REQUEST_CHANNELS = new Set(['MANUAL', 'IMPORT', 'WHATSAPP']);

/** Keeps a value only when it is one the report schema will accept. */
function oneOf(allowed: Set<string>, value: unknown): string | undefined {
  return typeof value === 'string' && allowed.has(value) ? value : undefined;
}

function trimmed(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

interface ParticipationsState {
  promotionId?: string;
  status?: unknown;
  source?: unknown;
  from?: string;
  to?: string;
}

export function participationsReportFilters(state: ParticipationsState) {
  return {
    promotion_id: trimmed(state.promotionId),
    status: oneOf(PARTICIPATION_STATUSES, state.status),
    source: oneOf(PARTICIPATION_SOURCES, state.source),
    from: trimmed(state.from),
    to: trimmed(state.to),
  };
}

interface PickupsState {
  promotionId?: string;
  status?: unknown;
}

export function winnersReportFilters(state: PickupsState) {
  return {
    promotion_id: trimmed(state.promotionId),
    status: oneOf(WINNER_STATUSES, state.status),
  };
}

interface MovementsState {
  type?: unknown;
  prizeId?: string;
  promotionId?: string;
  from?: string;
  to?: string;
}

export function movementsReportFilters(state: MovementsState) {
  return {
    // Not validated against a fixed set, unlike the others: inventory_movement_type
    // has nine values today and Block 2's own comment says the list grows with
    // the domain. The schema bounds it by length and the page function compares
    // it against the enum, where an unknown value simply matches nothing.
    movement_type: trimmed(state.type),
    prize_id: trimmed(state.prizeId),
    promotion_id: trimmed(state.promotionId),
    from: trimmed(state.from),
    to: trimmed(state.to),
  };
}

interface MusicRequestsState {
  songId?: string;
  showId?: string;
  channel?: unknown;
}

export function musicRequestsReportFilters(state: MusicRequestsState) {
  return {
    song_id: trimmed(state.songId),
    show_id: trimmed(state.showId),
    channel: oneOf(REQUEST_CHANNELS, state.channel),
  };
}

interface MembersState {
  situation?: unknown;
  ageMin?: number;
  ageMax?: number;
}

const MEMBER_SITUATIONS = new Set(['active', 'blocked', 'archived']);

export function listenersReportFilters(state: MembersState) {
  return {
    situation: oneOf(MEMBER_SITUATIONS, state.situation),
    age_min: typeof state.ageMin === 'number' ? state.ageMin : undefined,
    age_max: typeof state.ageMax === 'number' ? state.ageMax : undefined,
  };
}
