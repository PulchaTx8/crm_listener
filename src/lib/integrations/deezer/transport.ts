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
   * Deezer's own version marker — `(Cover Version)`, `(Live)`, `(Radio Edit)`.
   *
   * Block 31a read it because Block 24's exclusion could not see it: the field
   * exists beside `title` and `toTrack` had never taken it, so every cover
   * marked only here arrived looking like the original.
   */
  version: string | null;
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
  /**
   * One recording, by id, mapped exactly as a search hit is.
   *
   * BLOCK 17b, D4. The widget sends an integer and never a record, so a payload
   * crafted in a browser cannot name what lands in a Station's catalogue — and
   * that only works if the server can turn the integer back into a recording.
   * The operator screens never needed this because their operator had the
   * search result in hand; a public widget is the first caller that does.
   */
  track(trackId: number): Promise<DeezerResult<DeezerTrack>>;
}

/**
 * Titles a Station's search must not offer (Block 24, D1).
 *
 * FOUR OF THE FIVE CARRY A BRACKET, and that is the whole of the rule rather
 * than a detail of it. A cover announces itself in a title by being set apart —
 * "Yesterday (Cover)", "Evidências [Cover Version]" — while the bare letters
 * `cover` sit inside "Undercover", "Discovery", "Coverage" and a real recording
 * called "Cover Me". Matching the word alone would take all of those with it,
 * which is why the owner's list gave the bracketed forms and not the word.
 *
 * `karaoke` needs no bracket: nothing else spells it. `Karaoké` is deliberately
 * not matched — accented, it is a different string, and widening this to strip
 * accents would start matching titles nobody listed.
 */
/**
 * `cover version` joined the list in Block 31a, and it is the ONE unbracketed
 * term. It is safe where the bare word is not: two words cannot sit inside
 * "Undercover", "Discovery" or "Coverage", and the real recording called "Cover
 * Me" does not contain the phrase either. It earns its place because Deezer
 * writes exactly that in the `version` field, where nothing brackets it.
 */
const EXCLUDED_TITLE_TERMS = [
  'karaoke',
  'cover)',
  '(cover',
  'cover]',
  '[cover',
  'cover version',
] as const;

/**
 * Whether a recording is a karaoke backing track or a cover, judged by its
 * title alone.
 *
 * Applied to SEARCH RESULTS ONLY. A recording already registered in a Station's
 * catalogue is fetched by id — the widget's song request does exactly that —
 * and filtering there would make an existing row unresolvable. The search is a
 * list to choose from; the lookup is an answer about one thing that already
 * exists and was already chosen.
 */
export function isExcludedTitle(title: string): boolean {
  const lowered = title.toLowerCase();
  return EXCLUDED_TITLE_TERMS.some((term) => lowered.includes(term));
}

/**
 * Block 31a, D9. The same rule, applied to the PAIR Deezer actually publishes.
 *
 * `isExcludedTitle` above judges a title, and until this block that was all the
 * search read: `toTrack` never took Deezer's `version` field, so a recording
 * whose title is clean and whose version says "(Cover Version)" arrived looking
 * like the original. That is what the owner reported on 2026-08-22, and it was
 * never a gap in the term list — it was a field nobody read.
 *
 * Joined with a space rather than concatenated, so a title ending in "co" and a
 * version starting with "ver" cannot spell a term between them.
 *
 * APPLIED TO SEARCH RESULTS ONLY, like its half above: `track(id)` — the lookup
 * the widget's song request makes for a recording already in a Station's
 * catalogue — must keep answering, or an existing row becomes unresolvable.
 */
export function isExcludedRecording(title: string, version: string | null): boolean {
  return isExcludedTitle(version ? `${title} ${version}` : title);
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
