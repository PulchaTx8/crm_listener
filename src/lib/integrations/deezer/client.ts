import {
  buildSearchQuery,
  type DeezerAlbumDetail,
  type DeezerResult,
  type DeezerSearchFilters,
  type DeezerTrack,
  type DeezerTransport,
} from './transport';

const BASE = 'https://api.deezer.com';

/** What a person can scan in one list before scrolling stops being reading. */
const SEARCH_LIMIT = 20;

/**
 * Deezer's own error codes for "you are asking too often". 4 is the documented
 * quota refusal; 700 is the service-busy variant it answers under load. Both
 * mean wait, which is a different instruction from the one `not-found` gives,
 * which is why they are told apart at all.
 */
const QUOTA_CODES = new Set([4, 700]);

/**
 * DEEZER ANSWERS FAILURES WITH HTTP 200.
 *
 * Verified against the live API on 2026-08-07: `GET /track/999999999999`
 * returns **200** with `{"error":{"type":"DataException","message":"no data",
 * "code":800}}` in the body. So `response.ok` is true for a request that found
 * nothing, and any code that branches on it reads a failure as a success and
 * carries an empty object forward as if it were a record.
 *
 * Every call in this module goes through here, and THE BODY IS INSPECTED
 * BEFORE THE STATUS. The status is still consulted — but only to catch the
 * case where Deezer answered a real HTTP error without its usual error object,
 * which is the one situation the body cannot describe.
 */
async function call<T>(url: string, fetchImpl: typeof fetch): Promise<DeezerResult<T>> {
  let body: unknown;

  try {
    const response = await fetchImpl(url, { headers: { accept: 'application/json' } });
    body = await response.json();

    if (!response.ok && !isErrorBody(body)) {
      return { ok: false, reason: 'network', message: `deezer answered ${response.status}` };
    }
  } catch (cause) {
    // A refused connection, a DNS failure, a timeout — and also a body that is
    // not JSON at all, which `.json()` throws on. All of them mean the same
    // thing to the operator: it could not be reached, try again.
    return { ok: false, reason: 'network', message: String(cause) };
  }

  if (isErrorBody(body)) {
    const { code, message } = body.error;
    if (QUOTA_CODES.has(code)) return { ok: false, reason: 'quota', message };
    return { ok: false, reason: 'not-found', message };
  }

  return { ok: true, value: body as T };
}

function isErrorBody(body: unknown): body is { error: { code: number; message: string } } {
  if (typeof body !== 'object' || body === null || !('error' in body)) return false;
  const { error } = body as { error: unknown };
  return typeof error === 'object' && error !== null;
}

export function createDeezerClient(options: { fetchImpl?: typeof fetch } = {}): DeezerTransport {
  const fetchImpl = options.fetchImpl ?? fetch;

  return {
    async search(filters: DeezerSearchFilters) {
      const q = buildSearchQuery(filters);

      // Nothing typed searches nothing, rather than asking Deezer for its
      // whole catalogue and showing twenty arbitrary rows.
      if (!q) return { ok: true, value: [] };

      const url = `${BASE}/search?q=${encodeURIComponent(q)}&limit=${SEARCH_LIMIT}`;
      const result = await call<{ data: unknown[] }>(url, fetchImpl);
      if (!result.ok) return result;

      if (!Array.isArray(result.value?.data)) {
        return { ok: false, reason: 'malformed', message: 'no data array' };
      }

      return {
        ok: true,
        value: result.value.data
          .map(toTrack)
          .filter((track): track is DeezerTrack => track !== null),
      };
    },

    async album(albumId: number) {
      const result = await call<Record<string, unknown>>(`${BASE}/album/${albumId}`, fetchImpl);
      if (!result.ok) return result;
      return { ok: true, value: toAlbum(result.value) };
    },

    async track(trackId: number) {
      const result = await call<unknown>(`${BASE}/track/${trackId}`, fetchImpl);
      if (!result.ok) return result;

      // `toTrack` — the same mapping `search` uses, not a second one. Two
      // mappings for one Deezer object is how the two paths come to disagree
      // about which title a recording has.
      const track = toTrack(result.value);

      // Null here is a body Deezer answered 200 for and this code cannot read.
      // `search` drops such a row because one bad result among twenty is not a
      // broken search; here it is the entire answer, so it is a failure.
      if (track === null) {
        return { ok: false, reason: 'malformed', message: 'a track with no id' };
      }

      return { ok: true, value: track };
    },
  };
}

/**
 * Null for anything without a numeric id, and the caller drops it. A row this
 * function cannot read is one bad result, not a broken search — the same
 * instinct services/music.ts applies to an embed RLS hides.
 */
function toTrack(raw: unknown): DeezerTrack | null {
  if (typeof raw !== 'object' || raw === null) return null;

  const track = raw as Record<string, unknown>;
  if (typeof track.id !== 'number') return null;

  const album = (typeof track.album === 'object' && track.album !== null
    ? track.album
    : {}) as Record<string, unknown>;
  const artist = (typeof track.artist === 'object' && track.artist !== null
    ? track.artist
    : {}) as Record<string, unknown>;

  return {
    id: track.id,
    // `title`, never `title_short`: "(Ao Vivo)" is the difference between two
    // recordings, and a radio needs to know which one is on the shelf.
    title: text(track.title) ?? '',
    artistName: text(artist.name) ?? '',
    albumId: typeof album.id === 'number' ? album.id : 0,
    albumTitle: text(album.title) ?? '',
    coverMd5: text(album.md5_image),
    durationSeconds: typeof track.duration === 'number' ? track.duration : 0,
    isrc: text(track.isrc),
    // Signed, and valid for hours. It reaches the browser, plays, and is
    // discarded — see the field's own comment in transport.ts.
    previewUrl: text(track.preview),
  };
}

function toAlbum(raw: Record<string, unknown>): DeezerAlbumDetail {
  const genres =
    (raw.genres as { data?: { name?: string }[] } | undefined)?.data ?? [];

  return {
    id: typeof raw.id === 'number' ? raw.id : 0,
    title: text(raw.title) ?? '',
    upc: text(raw.upc),
    label: text(raw.label),
    // The first of however many. Deezer orders them broadest first, and a song
    // in this product carries exactly one genre.
    genreName: text(genres[0]?.name),
    releaseDate: text(raw.release_date),
    coverMd5: text(raw.md5_image),
  };
}

/** A non-empty string, or null. Deezer uses `""` and `null` interchangeably for "absent". */
function text(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}
