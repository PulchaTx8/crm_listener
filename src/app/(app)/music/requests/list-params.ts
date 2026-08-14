import { MUSIC_REQUEST_CHANNELS, REQUEST_LIMIT_MAX, REQUEST_LIMIT_MIN } from '@/schemas/music';
import type {
  MusicRequestPlayStatus,
  MusicRequestReadStatus,
  RequestSortKey,
} from '@/schemas/music';
import type { SortDirection } from '@/lib/keyset';

/**
 * The Requests screen's URL contract, on the shape of ../songs/list-params.ts:
 * the Server Component that reads it, the filter form that writes it and the
 * paging links that rewrite parts of it all have to agree, and a second
 * hand-rolled query string is how a Station selection silently stops
 * surviving a filter change.
 *
 * Block 22 gave the RPC (0191) two status filters, a choice of ordering and a
 * bounded batch mode alongside the keyset page — this file is where a URL
 * carries all three. `REQUEST_LIMIT_MIN`/`MAX` come from schemas/music.ts,
 * not services/music.ts: that module is `import 'server-only'`, and this file
 * is reached at runtime from the client graph (requests-filters.tsx, 'use
 * client'). The two types below are erased at compile time, so importing
 * them as types costs nothing either way — they come from schemas/music.ts
 * too, so this file has one rule about where its Block 22 vocabulary comes
 * from, not two.
 */

export interface MusicRequestSearchParams {
  companyId?: string;
  station?: string;
  q?: string;
  song?: string;
  show?: string;
  channel?: string;
  read?: string;
  play?: string;
  sort?: string;
  limit?: string;
  after?: string;
  before?: string;
}

export interface RequestListState {
  companyId: string;
  /** Carried by every link on the screen — see src/lib/station-switch.ts for what dropping it costs. */
  stationSearch?: string;
  /** A listener search. Returns nothing at all without members.view — 0107's RULE 3, not a bug. */
  search?: string;
  songId?: string;
  showId?: string;
  channel?: 'MANUAL' | 'IMPORT';
  readStatus?: MusicRequestReadStatus;
  playStatus?: MusicRequestPlayStatus;
  sort: RequestSortKey;
  /**
   * Undefined means "page it". A number means the operator asked for a bounded
   * batch, which is also the only way the three text orderings can be served —
   * a keyset cursor compares exactly the columns it orders by.
   */
  limit?: number;
}

export interface RequestCursor {
  side: 'after' | 'before';
  value: string;
}

/** Newest first, and there is no second sort: a request list is read as a diary. */
export const REQUEST_DIRECTION: SortDirection = 'desc';

const READ_STATUSES: readonly MusicRequestReadStatus[] = ['UNREAD', 'READ', 'CANCELLED'];
const PLAY_STATUSES: readonly MusicRequestPlayStatus[] = ['NOT_PLAYED', 'PLAYED', 'CANCELLED'];
const SORT_KEYS: readonly RequestSortKey[] = ['requested', 'song', 'artist', 'show'];

/** Newest first — a request list is read as a diary until somebody says otherwise. */
export const DEFAULT_REQUEST_SORT: RequestSortKey = 'requested';

/** Anything the URL carries that is not one of the two channels narrows nothing, rather than erroring. */
function parseChannel(raw: string | undefined): 'MANUAL' | 'IMPORT' | undefined {
  const value = raw?.trim();
  return MUSIC_REQUEST_CHANNELS.find((c) => c === value);
}

/**
 * A limit typed into a box, made safe. Clamped to the same range 0191 also
 * enforces at the RPC, imported rather than retyped: this parser is the only
 * thing standing between a hand-edited `limit` on the URL and an unbounded
 * read, so the two bounds drifting apart is how a screen asks for 10,000 rows
 * and gets served whatever the database alone decides to allow. A fraction is
 * rounded down: somebody typed a decimal point, and 2.5 rows is not a
 * question. Anything that is not a finite number at all — non-numeric text,
 * an empty string, an absent value — has no reading to clamp, so it comes
 * back undefined ("page it") rather than silently becoming REQUEST_LIMIT_MIN.
 */
export function parseRequestLimit(raw: string | undefined): number | undefined {
  const trimmed = raw?.trim();
  if (!trimmed) return undefined;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) return undefined;
  const floored = Math.floor(parsed);
  if (floored < REQUEST_LIMIT_MIN) return REQUEST_LIMIT_MIN;
  if (floored > REQUEST_LIMIT_MAX) return REQUEST_LIMIT_MAX;
  return floored;
}

function parseReadStatus(raw: string | undefined): MusicRequestReadStatus | undefined {
  return READ_STATUSES.find((s) => s === raw?.trim());
}

function parsePlayStatus(raw: string | undefined): MusicRequestPlayStatus | undefined {
  return PLAY_STATUSES.find((s) => s === raw?.trim());
}

/** Anything the URL carries that is not one of the four orderings falls back to the default rather than erroring. */
function parseSort(raw: string | undefined): RequestSortKey {
  return SORT_KEYS.find((s) => s === raw?.trim()) ?? DEFAULT_REQUEST_SORT;
}

/**
 * `companyId` is resolved by the page against the Stations the caller can
 * actually reach before it gets here, so this only carries it — a tampered
 * value falls back to the caller's first Station there, as it always has.
 */
export function parseRequestListParams(
  raw: MusicRequestSearchParams,
  companyId: string,
): RequestListState {
  return {
    companyId,
    stationSearch: raw.station?.trim() || undefined,
    search: raw.q?.trim() || undefined,
    songId: raw.song?.trim() || undefined,
    showId: raw.show?.trim() || undefined,
    channel: parseChannel(raw.channel),
    readStatus: parseReadStatus(raw.read),
    playStatus: parsePlayStatus(raw.play),
    sort: parseSort(raw.sort),
    limit: parseRequestLimit(raw.limit),
  };
}

export function parseRequestCursor(raw: MusicRequestSearchParams): RequestCursor | null {
  if (raw.before) return { side: 'before', value: raw.before };
  if (raw.after) return { side: 'after', value: raw.after };
  return null;
}

/**
 * Omitting the cursor is how a filter, sort or limit change resets paging,
 * and it must: a cursor is a position in one ordering of one result set.
 * `sort` is written only when it differs from the default, so "no sort
 * parameter" and "sort=requested" cannot become two different-looking
 * addresses for one screen.
 */
export function requestHref(state: RequestListState, cursor?: RequestCursor | null): string {
  const query = new URLSearchParams();
  query.set('companyId', state.companyId);
  if (state.stationSearch) query.set('station', state.stationSearch);
  if (state.search) query.set('q', state.search);
  if (state.songId) query.set('song', state.songId);
  if (state.showId) query.set('show', state.showId);
  if (state.channel) query.set('channel', state.channel);
  if (state.readStatus) query.set('read', state.readStatus);
  if (state.playStatus) query.set('play', state.playStatus);
  if (state.sort !== DEFAULT_REQUEST_SORT) query.set('sort', state.sort);
  if (state.limit !== undefined) query.set('limit', String(state.limit));
  if (cursor) query.set(cursor.side, cursor.value);
  return `/music/requests?${query.toString()}`;
}
