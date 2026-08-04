import { MUSIC_REQUEST_CHANNELS } from '@/schemas/music';
import type { SortDirection } from '@/lib/keyset';

/**
 * The Requests screen's URL contract, on the shape of ../songs/list-params.ts:
 * the Server Component that reads it, the filter form that writes it and the
 * paging links that rewrite parts of it all have to agree, and a second
 * hand-rolled query string is how a Station selection silently stops
 * surviving a filter change.
 *
 * No sort key here, and that is not an omission: list_music_requests (0107)
 * orders by requested_at desc, id desc, fixed — the same reasoning
 * participations/list-params.ts gives for its own screen, one diary reading
 * newest first with nothing to choose.
 */

export interface MusicRequestSearchParams {
  companyId?: string;
  station?: string;
  q?: string;
  song?: string;
  show?: string;
  channel?: string;
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
}

export interface RequestCursor {
  side: 'after' | 'before';
  value: string;
}

/** Newest first, and there is no second sort: a request list is read as a diary. */
export const REQUEST_DIRECTION: SortDirection = 'desc';

/** Anything the URL carries that is not one of the two channels narrows nothing, rather than erroring. */
function parseChannel(raw: string | undefined): 'MANUAL' | 'IMPORT' | undefined {
  const value = raw?.trim();
  return MUSIC_REQUEST_CHANNELS.find((c) => c === value);
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
  };
}

export function parseRequestCursor(raw: MusicRequestSearchParams): RequestCursor | null {
  if (raw.before) return { side: 'before', value: raw.before };
  if (raw.after) return { side: 'after', value: raw.after };
  return null;
}

/**
 * Omitting the cursor is how a filter change resets paging, and it must: a
 * cursor is a position in one ordering of one result set.
 */
export function requestHref(state: RequestListState, cursor?: RequestCursor | null): string {
  const query = new URLSearchParams();
  query.set('companyId', state.companyId);
  if (state.stationSearch) query.set('station', state.stationSearch);
  if (state.search) query.set('q', state.search);
  if (state.songId) query.set('song', state.songId);
  if (state.showId) query.set('show', state.showId);
  if (state.channel) query.set('channel', state.channel);
  if (cursor) query.set(cursor.side, cursor.value);
  return `/music/requests?${query.toString()}`;
}
