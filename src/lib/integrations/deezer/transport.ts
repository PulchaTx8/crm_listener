/**
 * The seam the master spec means by a "decoupled" integration layer: a module
 * boundary, not a network hop — the same shape whatsapp/transport.ts uses, and
 * for the same reason. It is what lets CI prove the whole block with no
 * network anywhere near it.
 */

/** One recording, as this product needs it. Mapped from Deezer's track object. */
export interface DeezerTrack {
  id: number;
  /**
   * The full title, never `title_short`. "Sozinho (Ao Vivo)" and "Sozinho" are
   * two different recordings, and a radio needs to know which one is on the
   * shelf.
   */
  title: string;
  artistName: string;
  albumId: number;
  albumTitle: string;
  coverMd5: string | null;
  /** Deezer answers in whole seconds already — no conversion, unlike Spotify's milliseconds. */
  durationSeconds: number;
  /** Present in the SEARCH result itself, which is why registering costs no extra call for it. */
  isrc: string | null;
  /**
   * The 30-second preview.
   *
   * SIGNED AND SHORT-LIVED. Deezer returns it carrying `hdnea=exp=<unix>~hmac=…`
   * — a validity stamp measured in hours. It MUST NOT be stored in a column, a
   * cache or a form field: it works in testing and is dead in production the
   * next day. It travels to the browser, plays, and is discarded.
   */
  previewUrl: string | null;
}

/** What the second call adds, and only the second call: UPC, label and genre are not in a search result. */
export interface DeezerAlbumDetail {
  id: number;
  title: string;
  upc: string | null;
  label: string | null;
  genreName: string | null;
  /** ISO `YYYY-MM-DD`, as Deezer gives it. */
  releaseDate: string | null;
  coverMd5: string | null;
}

/**
 * `reason` is why this is not a nullable value. A quota refusal, a row that
 * does not exist and a network failure need three different sentences on
 * screen: "it didn't work" sends the operator to support, and these say what
 * to do instead.
 */
export type DeezerFailureReason = 'not-found' | 'quota' | 'network' | 'malformed';

export type DeezerResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: DeezerFailureReason; message: string };

export interface DeezerSearchFilters {
  track?: string;
  artist?: string;
  album?: string;
}

export interface DeezerTransport {
  search(filters: DeezerSearchFilters): Promise<DeezerResult<DeezerTrack[]>>;
  /** One call, made on the register click alone — never once per search result. */
  album(albumId: number): Promise<DeezerResult<DeezerAlbumDetail>>;
}

/**
 * Deezer's advanced search syntax: `track:"…" artist:"…" album:"…"`.
 *
 * Each term is quoted, so a space inside one does not become a second filter.
 * Any double quote the operator typed is REMOVED first: left in, it closes the
 * filter it sits in and everything after it is read as a new one — which is
 * how a search for a song with a quote in its name silently becomes a search
 * for something else.
 */
export function buildSearchQuery(filters: DeezerSearchFilters): string {
  const parts: string[] = [];

  const add = (key: 'track' | 'artist' | 'album') => {
    const raw = filters[key]?.replace(/"/g, '').trim();
    if (raw) parts.push(`${key}:"${raw}"`);
  };

  add('track');
  add('artist');
  add('album');

  return parts.join(' ');
}
