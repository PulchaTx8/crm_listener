import 'server-only';
import { createClient } from '@supabase/supabase-js';
import { createUserClient } from '@/lib/supabase/user-client';
import { getUserSupabaseConfig } from '@/lib/supabase/config';
import {
  BusinessRuleError,
  ConflictError,
  InternalError,
  NotFoundError,
  UnauthorizedError,
  ValidationError,
} from '@/lib/errors';
import { keysetFilter, keysetPage } from '@/lib/keyset';
import type { Cursor, SortDirection } from '@/lib/keyset';
import { escapeLikePattern, quoteForOrFilter } from '@/lib/postgrest';
import { logger } from '@/lib/logger';
import type { Database } from '@/lib/supabase/database.types';
import { SONG_SEARCH_MAX_LENGTH } from '@/schemas/music';
import type {
  MergeFormInput,
  MusicMergeKind,
  MusicReferenceKind,
  ReferenceFormInput,
  ReferenceUpdateInput,
  SongFormInput,
  SongUpdateInput,
} from '@/schemas/music';

export { SONG_SEARCH_MAX_LENGTH };

/** A client bound to the caller's JWT — see services/inventory.ts's asCaller for why every write uses one. */
function asCaller(accessToken: string) {
  const { url, anonKey } = getUserSupabaseConfig();
  return createClient<Database>(url, anonKey, {
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

// ---------------------------------------------------------------------------
// Reference lists (genres, labels, artists-as-dropdown, shows)
// ---------------------------------------------------------------------------

export interface ReferenceSummary {
  id: string;
  name: string;
  legacyId: string | null;
}

/** The one place a kind becomes a table name in this module — mirrors 0100's own music_reference_table, so a caller's kind can never reach a query as a raw string. */
const REFERENCE_TABLES: Record<
  MusicReferenceKind,
  'music_genres' | 'record_labels' | 'artists' | 'shows'
> = {
  GENRE: 'music_genres',
  LABEL: 'record_labels',
  ARTIST: 'artists',
  SHOW: 'shows',
};

/**
 * The short lists behind a select — a genre, label, artist or show picker.
 * Ordered by name, not paged: 0099 already scopes this to one Station's live
 * rows, and these lists exist to be scanned whole, the way a <select> is.
 *
 * No archived filter is offered, and none can be built from here: every
 * policy in 0099 is `deleted_at is null and has_permission(...)`, so an
 * archived reference is unreadable through RLS for every caller, not merely
 * hidden — the identical finding services/inventory.ts records for prizes.
 */
export async function listMusicReferences(
  companyId: string,
  kind: MusicReferenceKind,
): Promise<ReferenceSummary[]> {
  const supabase = await createUserClient();
  const table = REFERENCE_TABLES[kind];

  const { data, error } = await supabase
    .from(table)
    .select('id, name, legacy_id')
    .eq('company_id', companyId)
    .is('deleted_at', null)
    .order('name');

  if (error) throw new InternalError(`Could not read the ${kind.toLowerCase()} list: ${error.message}`);

  return (data ?? []).map((row) => ({ id: row.id, name: row.name, legacyId: row.legacy_id }));
}

/**
 * The album picker's options — the same shape and the same RLS consequence as
 * listMusicReferences above, but not folded into it: albums live in their own
 * table with their own columns (0136), and REFERENCE_TABLES maps the four
 * lists that are a name and nothing else.
 *
 * `title` is aliased to `name` here so a caller can hand this straight to the
 * same <Select> the other three pickers use. The alias is the whole reason
 * this function returns ReferenceSummary rather than a shape of its own.
 */
export async function listAlbums(companyId: string): Promise<ReferenceSummary[]> {
  const supabase = await createUserClient();

  const { data, error } = await supabase
    .from('albums')
    .select('id, title, legacy_id')
    .eq('company_id', companyId)
    .is('deleted_at', null)
    .order('title');

  if (error) throw new InternalError(`Could not read the album list: ${error.message}`);

  return (data ?? []).map((row) => ({ id: row.id, name: row.title, legacyId: row.legacy_id }));
}

// ---------------------------------------------------------------------------
// Songs
// ---------------------------------------------------------------------------

/** The audience and inventory lists' page size, for the same reason: it is what a person can scan. Reused below for the Artists list too — one number for the whole module. */
export const SONG_PAGE_SIZE = 50;

/**
 * One constant shared by the row read and the count read, so the two cannot
 * disagree. The three embeds are resolved through the foreign keys 0098
 * declares (songs.artist_id/label_id/genre_id).
 *
 * All three are typed nullable below, `artists` included. An earlier version
 * of this comment argued that one from the column — "artist_id is NOT NULL, so
 * `artists` comes back as a single non-null object" — and that answers the
 * wrong question. PostgREST resolves a to-one embed as a LEFT JOIN and returns
 * null for the embedded object whenever the parent row is not VISIBLE, which
 * is not the same fact as whether the child column has a value. 0099's policy
 * on artists is `deleted_at is null and has_permission('music.view', ...)`, so
 * an archived artist is unreadable for every caller including the owner (the
 * same finding listMusicReferences records above), and a live song naming one
 * comes back as `artist_id: '<uuid>', artists: null`.
 *
 * 0103 closes the concurrency window that could newly create such a song, but
 * the type has to survive the row existing at all — Block 9's ETL writes these
 * tables directly, and any row written before 0103 is still in the table. The
 * cost of getting it wrong is not one bad cell: toSongSummary would throw a
 * TypeError inside listSongsPage, and the Songs screen for that whole Station
 * would render its load-error state with no way back through the UI.
 *
 * Nor was the compiler ever checking this claim, and `as const` — the obvious
 * way to make it — would make things worse rather than better. Measured, not
 * assumed: with `as const` on this string, supabase-js infers
 * `artists: { name: string }`, non-null, alongside `record_labels`/
 * `music_genres` as `| null`. Its inference reads an embed's nullability off
 * the foreign-key column's nullability, which is precisely the mistake this
 * comment exists to correct — so it would not check the shape, it would
 * endorse `row.artists.name` and hide the bug behind a green typecheck. Left a
 * plain string deliberately, with the shape declared by hand in SongRow just
 * below.
 */
const SONG_COLUMNS =
  'id, title, artist_id, label_id, genre_id, nationality, vocal, duration_seconds, internal_code, legacy_id, created_at, album_id, deezer_track_id, isrc, artists(name), record_labels(name), music_genres(name), albums(title, cover_md5)';

type SongRow = Pick<
  Database['public']['Tables']['songs']['Row'],
  | 'id'
  | 'title'
  | 'artist_id'
  | 'label_id'
  | 'genre_id'
  | 'nationality'
  | 'vocal'
  | 'duration_seconds'
  | 'internal_code'
  | 'legacy_id'
  | 'created_at'
  | 'album_id'
  | 'deezer_track_id'
  | 'isrc'
> & {
  /** Null when the artist row is hidden by RLS — an archived artist. Never null because the song has no artist: artist_id is NOT NULL and 0101 refuses a song without one. */
  artists: { name: string } | null;
  record_labels: { name: string } | null;
  music_genres: { name: string } | null;
  /**
   * Null for TWO different reasons, unlike the three above: the song may have
   * no album at all (album_id is nullable — a song typed by hand has none), or
   * the album may be archived and so unreadable through 0136's policy while
   * album_id still names it. Typed nullable by hand for the reason
   * SONG_COLUMNS' comment sets out at length: supabase-js infers an embed's
   * nullability from the foreign-key column, which is the wrong question, and
   * `as const` here would endorse `row.albums.title` and hide the bug behind a
   * green typecheck.
   */
  albums: { title: string; cover_md5: string | null } | null;
};

export interface SongSummary {
  id: string;
  title: string;
  artistId: string;
  /**
   * Null means "this song has an artist and this caller cannot read it" —
   * never "this song has no artist", which 0101 refuses. Nullable rather than
   * a placeholder string because the two nullable siblings below already put
   * the choice of what to show in the screen's hands, and because an artist
   * that cannot be read is a different fact from a label that was never set:
   * the Songs grid renders it differently on purpose.
   */
  artistName: string | null;
  labelId: string | null;
  labelName: string | null;
  genreId: string | null;
  genreName: string | null;
  nationality: Database['public']['Enums']['music_nationality'] | null;
  vocal: Database['public']['Enums']['music_vocal'] | null;
  durationSeconds: number | null;
  internalCode: string | null;
  legacyId: string | null;
  createdAt: string;
  albumId: string | null;
  /**
   * Null means either "no album" or "an album this caller cannot read". The
   * screens render both as no cover, which is the honest rendering of both —
   * unlike artistName above, where the two facts differ and the grid says so.
   */
  albumTitle: string | null;
  /** Deezer's md5_image. src/lib/integrations/deezer/cover.ts turns it into a URL; nothing stores one (Block 13a, design D4). */
  coverMd5: string | null;
  /** Read-only in every screen: 0139's two doors are the only write path (design D6). */
  deezerTrackId: number | null;
  isrc: string | null;
}

/**
 * Exported for the unit suite, and for one case in particular: an album hidden
 * by RLS arrives as `albums: null` with `album_id` still set, and getting that
 * wrong for artists once cost a whole Station's Songs screen (see
 * SONG_COLUMNS). A test that cannot reach this function cannot pin that.
 */
export function toSongSummary(row: SongRow): SongSummary {
  return {
    id: row.id,
    title: row.title,
    artistId: row.artist_id,
    // `?.`, like the two lines below it — the reason is in SONG_COLUMNS'
    // comment: an archived artist is invisible through RLS, so the embed is
    // null while artist_id still names it. One such row must cost one cell,
    // not the whole Station's list.
    artistName: row.artists?.name ?? null,
    labelId: row.label_id,
    labelName: row.record_labels?.name ?? null,
    genreId: row.genre_id,
    genreName: row.music_genres?.name ?? null,
    nationality: row.nationality,
    vocal: row.vocal,
    durationSeconds: row.duration_seconds,
    internalCode: row.internal_code,
    legacyId: row.legacy_id,
    createdAt: row.created_at,
    albumId: row.album_id,
    // `?.` for the same reason as the three above it, and one more besides:
    // the album is optional on a song, so this embed is legitimately null on
    // every hand-typed record in the catalogue.
    albumTitle: row.albums?.title ?? null,
    coverMd5: row.albums?.cover_md5 ?? null,
    deezerTrackId: row.deezer_track_id,
    isrc: row.isrc,
  };
}

export type SongSortKey = 'title' | 'created';

export interface SongListParams {
  companyId: string;
  search?: string;
  artistId?: string;
  genreId?: string;
  sort: SongSortKey;
  direction: SortDirection;
  cursor: Cursor | null;
  cursorSide: 'after' | 'before';
}

export interface SongListPage {
  rows: SongSummary[];
  nextCursor: string | null;
  previousCursor: string | null;
  /** Always exact: one Station's catalogue, cut by RLS before it touches disk. */
  total: number;
}

/**
 * The Songs list, one keyset page at a time — modelled directly on
 * listPrizesPage (services/inventory.ts): the same build() closure shared
 * between the row read and the exact count, the same walkingBack handling.
 *
 * The search term covers title and internal_code only, never the artist's
 * name: PostgREST's `.or()` cannot reach an embedded resource's column, and
 * faking it with a second query would make the exact count wrong. This is a
 * known, recorded limitation, not an oversight — the Artists screen is where
 * an artist is found by name.
 *
 * No archived filter is offered, for the same reason listMusicReferences
 * above has none: 0099's select policy on songs is `deleted_at is null and
 * has_permission(...)`, so an archived song is unreadable through RLS for
 * every caller.
 */
export async function listSongsPage(params: SongListParams): Promise<SongListPage> {
  const supabase = await createUserClient();

  const column = params.sort === 'title' ? 'title' : 'created_at';
  // Neither sort column is nullable (0098), so no null region exists on
  // either — nullsLast below is always false.
  const walkingBack = params.cursorSide === 'before' && params.cursor !== null;
  const ascending = walkingBack ? params.direction === 'desc' : params.direction === 'asc';
  const readDirection: SortDirection = ascending ? 'asc' : 'desc';

  const build = (options?: { count: 'exact'; head: true }) => {
    let q = supabase
      .from('songs')
      .select(SONG_COLUMNS, options)
      .eq('company_id', params.companyId)
      .is('deleted_at', null);

    if (params.artistId) q = q.eq('artist_id', params.artistId);
    if (params.genreId) q = q.eq('genre_id', params.genreId);

    const term = params.search?.trim().slice(0, SONG_SEARCH_MAX_LENGTH);
    if (term) {
      // escapeLikePattern before the wildcard markers, so only what the
      // caller typed is escaped — never the markers this adds itself.
      const wildcard = quoteForOrFilter(`%${escapeLikePattern(term)}%`);
      q = q.or(`title.ilike.${wildcard},internal_code.ilike.${wildcard}`);
    }

    return q;
  };

  let query = build().order(column, { ascending });
  if (params.cursor) {
    // nullsLast is false because neither sort column is nullable: there is
    // no null region for a cursor to cross into.
    query = query.or(keysetFilter(column, readDirection, params.cursor, false));
  }
  query = query.order('id', { ascending });

  const { data, error } = await query.limit(SONG_PAGE_SIZE + 1);
  if (error) throw new InternalError(`Could not read songs: ${error.message}`);

  const rows: SongRow[] = data ?? [];

  const { rows: page, nextCursor, previousCursor } = keysetPage(rows, {
    pageSize: SONG_PAGE_SIZE,
    walkingBack,
    hadCursor: params.cursor !== null,
    cursorFor: (row) => ({
      value: params.sort === 'title' ? row.title : row.created_at,
      id: row.id,
    }),
  });

  const { count, error: countError } = await build({ count: 'exact', head: true });
  if (countError) throw new InternalError(`Could not count songs: ${countError.message}`);

  return {
    rows: page.map(toSongSummary),
    nextCursor,
    previousCursor,
    total: count ?? 0,
  };
}

/** One song, and the Station it belongs to, by id — the same shape getPrizeById gives, for the same reason: RLS already scopes songs to the Stations the caller holds music.view in, so a song at an unreachable Station comes back null here. */
export async function getSongById(
  songId: string,
): Promise<{ companyId: string; song: SongSummary } | null> {
  const supabase = await createUserClient();
  const { data, error } = await supabase
    .from('songs')
    .select(`${SONG_COLUMNS}, company_id`)
    .eq('id', songId)
    .is('deleted_at', null)
    .maybeSingle();

  if (error) throw new InternalError(`Could not read the song: ${error.message}`);
  if (!data) return null;

  return { companyId: data.company_id, song: toSongSummary(data) };
}

/**
 * Replaces a song's fields wholesale — update_song (0101) sets every column
 * it takes on every call, so a partial input blanks what it omits.
 *
 * input.durationSeconds is `number | null | undefined` (schemas/music.ts):
 * the field is nullable in the form, but create_song/update_song's generated
 * Args type only the SQL default (`integer default null`) as optional —
 * `p_duration_seconds?: number`, with no `| null` in the union, because
 * Postgres's function metadata carries no nullability signal beyond "has a
 * default". Coercing null to undefined below is not a cast: omitting the key
 * lets the RPC's own default apply, and that default is null, so the
 * observable effect — the column ends up null — is identical either way.
 */
export async function createSong(input: SongFormInput, accessToken: string): Promise<string> {
  const { data, error } = await asCaller(accessToken).rpc('create_song', {
    p_company_id: input.companyId,
    p_title: input.title,
    p_artist_id: input.artistId,
    p_label_id: input.labelId,
    p_genre_id: input.genreId,
    p_nationality: input.nationality,
    p_vocal: input.vocal,
    p_duration_seconds: input.durationSeconds ?? undefined,
    p_internal_code: input.internalCode,
    p_legacy_id: input.legacyId,
    // Block 13a (0140). SongFields is one component shared by this form and
    // the edit form, so without these two the create dialog would render an
    // album select and an ISRC input that quietly discarded what was typed.
    p_album_id: input.albumId,
    p_isrc: input.isrc,
  });
  if (error) throw mapMusicError(error.code, error.message);
  if (typeof data !== 'string') throw new InternalError('create_song returned no id');
  return data;
}

/**
 * legacy_id is deliberately absent from this call: update_song (0102) no
 * longer takes a p_legacy_id parameter at all, and SongUpdateInput
 * (schemas/music.ts) carries no `legacyId` field to read one from. Before
 * 0102, update_song took p_legacy_id defaulting to null and applied it
 * unconditionally — the UI's own form never carried the current value
 * forward (legacyId renders read-only, with no `name` attribute), so every
 * ordinary save silently erased a song's import handle. Removing the
 * parameter at the database layer is what actually closes that: there is no
 * longer a value this function — or a hand-crafted RPC call bypassing it
 * entirely — could send that would touch the column.
 */
export async function updateSong(input: SongUpdateInput, accessToken: string): Promise<void> {
  const { error } = await asCaller(accessToken).rpc('update_song', {
    p_song_id: input.songId,
    p_title: input.title,
    p_artist_id: input.artistId,
    p_label_id: input.labelId,
    p_genre_id: input.genreId,
    p_nationality: input.nationality,
    p_vocal: input.vocal,
    p_duration_seconds: input.durationSeconds ?? undefined,
    p_internal_code: input.internalCode,
    // Both hand-editable (design D7), and both sent on EVERY call: 0138 keeps
    // the convention that every field is set on every call, so an omitted
    // album here blanks the one already stored.
    //
    // There is deliberately no p_deezer_track_id beside them. 0138 has no such
    // parameter, and adding one would undo design D6 — the code and the cover
    // travel together, and 0139's two doors are the only write path.
    p_album_id: input.albumId ?? undefined,
    p_isrc: input.isrc ?? undefined,
  });
  if (error) throw mapMusicError(error.code, error.message);
}

// ---------------------------------------------------------------------------
// The Deezer doors (0139). Each takes what the tab found and nothing the
// operator typed — see each function's own comment in the migration.
// ---------------------------------------------------------------------------

export interface DeezerRegistration {
  companyId: string;
  title: string;
  artistName: string;
  labelName?: string | null;
  genreName?: string | null;
  albumTitle?: string | null;
  deezerTrackId: number;
  deezerAlbumId?: number | null;
  isrc?: string | null;
  upc?: string | null;
  coverMd5?: string | null;
  releaseDate?: string | null;
  durationSeconds?: number | null;
}

/** Resolves or creates artist, label, genre and album and inserts the song — all in one transaction (design D3). Returns the new song's id. */
export async function createSongFromDeezer(
  input: DeezerRegistration,
  accessToken: string,
): Promise<string> {
  const { data, error } = await asCaller(accessToken).rpc('create_song_from_deezer', {
    p_company_id: input.companyId,
    p_title: input.title,
    p_artist_name: input.artistName,
    p_label_name: input.labelName ?? undefined,
    p_genre_name: input.genreName ?? undefined,
    p_album_title: input.albumTitle ?? undefined,
    p_deezer_track_id: input.deezerTrackId,
    p_deezer_album_id: input.deezerAlbumId ?? undefined,
    p_isrc: input.isrc ?? undefined,
    p_upc: input.upc ?? undefined,
    p_cover_md5: input.coverMd5 ?? undefined,
    p_release_date: input.releaseDate ?? undefined,
    p_duration_seconds: input.durationSeconds ?? undefined,
  });

  if (error) throw mapMusicError(error.code, error.message);
  return data as string;
}

export interface DeezerLink {
  songId: string;
  deezerTrackId: number;
  albumTitle?: string | null;
  deezerAlbumId?: number | null;
  upc?: string | null;
  coverMd5?: string | null;
  releaseDate?: string | null;
  isrc?: string | null;
}

/** Writes the Deezer id, the album and (only if absent) the ISRC onto a song that already exists. Touches nothing the operator typed. */
export async function linkSongToDeezer(input: DeezerLink, accessToken: string): Promise<void> {
  const { error } = await asCaller(accessToken).rpc('link_song_to_deezer', {
    p_song_id: input.songId,
    p_deezer_track_id: input.deezerTrackId,
    p_album_title: input.albumTitle ?? undefined,
    p_deezer_album_id: input.deezerAlbumId ?? undefined,
    p_upc: input.upc ?? undefined,
    p_cover_md5: input.coverMd5 ?? undefined,
    p_release_date: input.releaseDate ?? undefined,
    p_isrc: input.isrc ?? undefined,
  });
  if (error) throw mapMusicError(error.code, error.message);
}

/** Clears the Deezer id alone. The album and the ISRC survive — unlinking is not a statement that either was wrong. */
export async function unlinkSongFromDeezer(
  songId: string,
  accessToken: string,
): Promise<void> {
  const { error } = await asCaller(accessToken).rpc('unlink_song_from_deezer', {
    p_song_id: songId,
  });
  if (error) throw mapMusicError(error.code, error.message);
}

/** Registers an album typed by hand. The Deezer path goes through create_song_from_deezer instead, which resolves or creates one atomically with the song. */
export async function createAlbum(
  input: { companyId: string; title: string },
  accessToken: string,
): Promise<string> {
  const { data, error } = await asCaller(accessToken).rpc('create_album', {
    p_company_id: input.companyId,
    p_title: input.title,
  });
  if (error) throw mapMusicError(error.code, error.message);
  if (typeof data !== 'string') throw new InternalError('create_album returned no id');
  return data;
}

/** The fields update_album replaces, as they stand right now. */
export interface AlbumRecordFields {
  title: string;
  upc: string | null;
  releaseDate: string | null;
}

/**
 * Reads back the three fields updateAlbum replaces.
 *
 * It exists because update_album writes ALL of them on every call and 0187
 * removed the defaults that used to hide that: a caller holding only a new
 * title has to fetch the other two and send them back unchanged, or it is not
 * renaming an album, it is emptying two columns. The alternative — hidden
 * inputs on the form carrying the current values forward — is the one 0141
 * explicitly refused, because a value that arrives from the browser is a value
 * anybody who can craft a POST may choose.
 *
 * Its only caller is the one-field rename row on /music/catalog, which Block
 * 20c deletes; the record dialog that replaces it edits all three fields and
 * has no use for this.
 *
 * An archived album is NotFoundError rather than an empty result, and so is one
 * hidden by RLS — the same refusal for "no such album" and "not your Station",
 * which is the distinction 0093 deliberately refuses to draw anywhere else.
 */
export async function getAlbumRecordFields(albumId: string): Promise<AlbumRecordFields> {
  const supabase = await createUserClient();

  const { data, error } = await supabase
    .from('albums')
    .select('title, upc, release_date')
    .eq('id', albumId)
    .is('deleted_at', null)
    .maybeSingle();

  if (error) throw new InternalError(`Could not read the album: ${error.message}`);
  if (!data) throw new NotFoundError('That album could not be found.');

  return { title: data.title, upc: data.upc, releaseDate: data.release_date };
}

/**
 * Saves an album record: title, UPC and release date, every one of them on
 * every call. NOT "renames an album" any more, and the difference is the whole
 * point of 0187.
 *
 * 0141 had cut the UPC parameter because the screen was a one-field row and
 * `default null` on the RPC made "this form has no box for that" and "the
 * operator cleared that box" the same request — so every rename erased the UPC.
 * 0187 puts the field back WITHOUT a default, which separates them again: this
 * function must state all three, and a caller that forgets one fails at the
 * call with 42883 rather than quietly emptying a column. Passing null still
 * clears, because an operator who empties a box means it.
 *
 * `deezerAlbumId` and `coverMd5` are absent and must stay absent — they travel
 * together out of the Deezer path alone (0139). `thumbUrl` is absent for the
 * other reason: it has its own writer, setAlbumCover, because this function
 * replaces every field it takes and a cover on that list would be deleted by
 * every ordinary save.
 */
export async function updateAlbum(
  input: { albumId: string } & AlbumRecordFields,
  accessToken: string,
): Promise<void> {
  const { error } = await asCaller(accessToken).rpc('update_album', {
    p_album_id: input.albumId,
    p_title: input.title,
    // THE TWO ASSERTIONS ARE THE GENERATED TYPE'S LIMIT, NOT A RELAXED RULE.
    // `supabase gen types` marks an argument optional exactly when the SQL
    // declares a DEFAULT, and types it as the bare type otherwise — so it has
    // no way to spell "required, and may be null", which is precisely what
    // 0187 made these two. Giving them defaults would make the types honest and
    // reintroduce 0141's defect, which is the wrong trade: an album with no UPC
    // is ordinary, and null here means "cleared", not "unspecified".
    //
    // PostgREST sends the null through as SQL NULL, and the database is the
    // authority: it refuses a call that OMITS either (42883) and accepts null,
    // which 49_album_covers.test.sql asserts in both directions.
    p_upc: input.upc as string,
    p_release_date: input.releaseDate as string,
  });
  if (error) throw mapMusicError(error.code, error.message);
}

export async function archiveAlbum(albumId: string, accessToken: string): Promise<void> {
  const { error } = await asCaller(accessToken).rpc('archive_album', { p_album_id: albumId });
  if (error) throw mapMusicError(error.code, error.message);
}

/**
 * The cover hash for a set of songs, by song id.
 *
 * THREE SCREENS READ THEIR ROWS FROM AN RPC -- the Requests list (0107), the
 * Music dashboard (0119) and the merge panel (0108) -- and each returns a
 * fixed set of columns with no cover among them. Widening those three would
 * mean DROP + CREATE on three long SECURITY DEFINER/INVOKER functions, each
 * with its own tests and its own reasoning, to add one field apiece. This
 * costs one extra scoped query per page instead, over at most a page's worth
 * of ids.
 *
 * It is NOT an N+1: one query for the whole page, called once. The Block 3b
 * finding this codebase already carries -- 102 queries measured down to 5 --
 * is the reason that distinction is spelled out rather than assumed.
 *
 * RLS applies exactly as it does everywhere else: a song or an album this
 * caller cannot read simply does not appear in the map, and its screen renders
 * the fallback.
 */
export async function coversForSongs(
  songIds: string[],
): Promise<Map<string, string | null>> {
  const unique = [...new Set(songIds)];
  if (unique.length === 0) return new Map();

  const supabase = await createUserClient();
  const { data, error } = await supabase
    .from('songs')
    .select('id, albums(cover_md5)')
    .in('id', unique);

  // A failed cover read must not take a whole list down with it. The screens
  // fall back to the music-note icon, which is a rendering they already have
  // for every song typed by hand.
  if (error) {
    logger.warn({ err: error }, 'could not read covers for songs');
    return new Map();
  }

  const covers = new Map<string, string | null>();
  for (const row of (data ?? []) as { id: string; albums: { cover_md5: string | null } | null }[]) {
    covers.set(row.id, row.albums?.cover_md5 ?? null);
  }
  return covers;
}

/**
 * Which of a set of Deezer track ids this Station already has (design D9).
 * ONE query for the whole result page, not one per row — the N+1 Block 3b
 * measured at 102 queries and fixed to 5 is the reason this is not a `.map`.
 */
export async function findSongsByDeezerIds(
  companyId: string,
  deezerTrackIds: number[],
): Promise<Map<number, string>> {
  if (deezerTrackIds.length === 0) return new Map();

  const supabase = await createUserClient();
  const { data, error } = await supabase
    .from('songs')
    .select('id, deezer_track_id')
    .eq('company_id', companyId)
    .is('deleted_at', null)
    .in('deezer_track_id', deezerTrackIds);

  if (error) throw new InternalError(`Could not check registered songs: ${error.message}`);

  const found = new Map<number, string>();
  for (const row of data ?? []) {
    if (row.deezer_track_id !== null) found.set(row.deezer_track_id, row.id);
  }
  return found;
}

/**
 * Archives a song. Irreversible from this app: 0099's select policy makes an
 * archived song unreadable through RLS for every caller, including the
 * owner. Unlike archive_music_reference, archive_song is never refused over
 * a live music_requests row naming it (0101's own comment: a request is a
 * historical fact that outlives the song).
 */
export async function archiveSong(songId: string, accessToken: string): Promise<void> {
  const { error } = await asCaller(accessToken).rpc('archive_song', { p_song_id: songId });
  if (error) throw mapMusicError(error.code, error.message);
}

// ---------------------------------------------------------------------------
// Artists
// ---------------------------------------------------------------------------

const ARTIST_COLUMNS = 'id, name, legacy_id, created_at';

type ArtistRow = Pick<
  Database['public']['Tables']['artists']['Row'],
  'id' | 'name' | 'legacy_id' | 'created_at'
>;

export interface ArtistSummary {
  id: string;
  name: string;
  legacyId: string | null;
  createdAt: string;
}

function toArtistSummary(row: ArtistRow): ArtistSummary {
  return { id: row.id, name: row.name, legacyId: row.legacy_id, createdAt: row.created_at };
}

export type ArtistSortKey = 'name' | 'created';

export interface ArtistListParams {
  companyId: string;
  search?: string;
  sort: ArtistSortKey;
  direction: SortDirection;
  cursor: Cursor | null;
  cursorSide: 'after' | 'before';
}

export interface ArtistListPage {
  rows: ArtistSummary[];
  nextCursor: string | null;
  previousCursor: string | null;
  /** Always exact: one Station's artists, cut by RLS before it touches disk. */
  total: number;
}

/**
 * The Artists list, one keyset page at a time — same shape as listSongsPage
 * above, over the `artists` table's own name rather than an embed. This is
 * deliberately where an artist is found by name, since listSongsPage cannot
 * search one (see its own comment).
 *
 * Reuses SONG_PAGE_SIZE and SONG_SEARCH_MAX_LENGTH rather than a second
 * pair of constants: one number for "what a person can scan" and one for
 * "the bound on a search term", used the same way in both places.
 */
export async function listArtistsPage(params: ArtistListParams): Promise<ArtistListPage> {
  const supabase = await createUserClient();

  const column = params.sort === 'name' ? 'name' : 'created_at';
  const walkingBack = params.cursorSide === 'before' && params.cursor !== null;
  const ascending = walkingBack ? params.direction === 'desc' : params.direction === 'asc';
  const readDirection: SortDirection = ascending ? 'asc' : 'desc';

  const build = (options?: { count: 'exact'; head: true }) => {
    let q = supabase
      .from('artists')
      .select(ARTIST_COLUMNS, options)
      .eq('company_id', params.companyId)
      .is('deleted_at', null);

    const term = params.search?.trim().slice(0, SONG_SEARCH_MAX_LENGTH);
    if (term) {
      const wildcard = quoteForOrFilter(`%${escapeLikePattern(term)}%`);
      q = q.or(`name.ilike.${wildcard}`);
    }

    return q;
  };

  let query = build().order(column, { ascending });
  if (params.cursor) {
    // nullsLast is false: neither name nor created_at is nullable (0098).
    query = query.or(keysetFilter(column, readDirection, params.cursor, false));
  }
  query = query.order('id', { ascending });

  const { data, error } = await query.limit(SONG_PAGE_SIZE + 1);
  if (error) throw new InternalError(`Could not read artists: ${error.message}`);

  const rows: ArtistRow[] = data ?? [];

  const { rows: page, nextCursor, previousCursor } = keysetPage(rows, {
    pageSize: SONG_PAGE_SIZE,
    walkingBack,
    hadCursor: params.cursor !== null,
    cursorFor: (row) => ({
      value: params.sort === 'name' ? row.name : row.created_at,
      id: row.id,
    }),
  });

  const { count, error: countError } = await build({ count: 'exact', head: true });
  if (countError) throw new InternalError(`Could not count artists: ${countError.message}`);

  return {
    rows: page.map(toArtistSummary),
    nextCursor,
    previousCursor,
    total: count ?? 0,
  };
}

/** One artist, and the Station it belongs to, by id — same shape as getSongById. */
export async function getArtistById(
  artistId: string,
): Promise<{ companyId: string; artist: ArtistSummary } | null> {
  const supabase = await createUserClient();
  const { data, error } = await supabase
    .from('artists')
    .select(`${ARTIST_COLUMNS}, company_id`)
    .eq('id', artistId)
    .is('deleted_at', null)
    .maybeSingle();

  if (error) throw new InternalError(`Could not read the artist: ${error.message}`);
  if (!data) return null;

  return { companyId: data.company_id, artist: toArtistSummary(data) };
}

export interface ArtistSongSummary {
  id: string;
  title: string;
  createdAt: string;
  /** Null when the song has no album, or has one this caller cannot read — both render as the fallback icon. */
  coverMd5: string | null;
}

export interface ArtistSongsPage {
  rows: ArtistSongSummary[];
  hasMore: boolean;
}

/** The cap on the artist record's songs tab — not a page size: see the module comment on getArtistSongs below. */
const ARTIST_SONGS_CAP = 200;

/**
 * Feeds the artist record's second tab: every live song naming this artist,
 * ordered by title, capped at 200 rather than paged. An artist with more
 * than two hundred songs in one Station is not what this tab is for — the
 * Songs screen filtered by artist (listSongsPage with artistId) is.
 */
export async function getArtistSongs(
  companyId: string,
  artistId: string,
): Promise<ArtistSongsPage> {
  const supabase = await createUserClient();
  const { data, error } = await supabase
    .from('songs')
    // A direct select on songs, so the cover comes through an embed here
    // rather than through coversForSongs — no second query needed.
    .select('id, title, created_at, albums(cover_md5)')
    .eq('company_id', companyId)
    .eq('artist_id', artistId)
    .is('deleted_at', null)
    .order('title')
    .limit(ARTIST_SONGS_CAP + 1);

  if (error) throw new InternalError(`Could not read the artist's songs: ${error.message}`);

  const rows = data ?? [];
  const hasMore = rows.length > ARTIST_SONGS_CAP;
  const windowed = hasMore ? rows.slice(0, ARTIST_SONGS_CAP) : rows;

  return {
    rows: windowed.map((row) => ({
      id: row.id,
      title: row.title,
      createdAt: row.created_at,
      // `?.` for the reason SONG_COLUMNS records: an archived album is
      // invisible through RLS while album_id still names it.
      coverMd5: (row as { albums: { cover_md5: string | null } | null }).albums?.cover_md5 ?? null,
    })),
    hasMore,
  };
}

// ---------------------------------------------------------------------------
// Reference writes (genre, label, artist, show)
// ---------------------------------------------------------------------------

export async function createMusicReference(
  input: ReferenceFormInput,
  accessToken: string,
): Promise<string> {
  const { data, error } = await asCaller(accessToken).rpc('create_music_reference', {
    p_company_id: input.companyId,
    p_kind: input.kind,
    p_name: input.name,
    p_legacy_id: input.legacyId,
  });
  if (error) throw mapMusicError(error.code, error.message);
  if (typeof data !== 'string') throw new InternalError('create_music_reference returned no id');
  return data;
}

/**
 * Replaces a reference record's name wholesale — update_music_reference
 * (0102) no longer takes or writes legacy_id at all. It used to (0100), set
 * unconditionally on every call the same way update_song's did, and
 * ReferenceUpdateInput (schemas/music.ts) carries no `legacyId` field to read
 * one from any more, for the identical reason updateSong's own comment gives:
 * legacy_id is Block 9's ETL idempotency handle (D7), read-only in every
 * screen, and only createMusicReference sets it. The Station is resolved
 * from the row itself inside the RPC, never from a parameter here.
 */
export async function updateMusicReference(
  input: ReferenceUpdateInput,
  accessToken: string,
): Promise<void> {
  const { error } = await asCaller(accessToken).rpc('update_music_reference', {
    p_kind: input.kind,
    p_id: input.id,
    p_name: input.name,
  });
  if (error) throw mapMusicError(error.code, error.message);
}

/**
 * Archives a genre, label, artist or show. Can be refused with 23503 while a
 * live song (or, for a show, a live music_requests row) still names it —
 * mapMusicError turns that into a BusinessRuleError carrying the RPC's own
 * message, which names the count, so the screen can show it rather than a
 * generic refusal.
 */
export async function archiveMusicReference(
  kind: MusicReferenceKind,
  id: string,
  accessToken: string,
): Promise<void> {
  const { error } = await asCaller(accessToken).rpc('archive_music_reference', {
    p_kind: kind,
    p_id: id,
  });
  if (error) throw mapMusicError(error.code, error.message);
}

// ---------------------------------------------------------------------------
// Merges
// ---------------------------------------------------------------------------

/** The one place a merge kind becomes an RPC name — mirrors 0105's music_merge_table, so a caller's kind can never reach the wire as a raw string. */
const MERGE_DOORS: Record<
  MusicMergeKind,
  'merge_songs' | 'merge_artists' | 'merge_record_labels' | 'merge_music_genres' | 'merge_shows'
> = {
  SONG: 'merge_songs',
  ARTIST: 'merge_artists',
  LABEL: 'merge_record_labels',
  GENRE: 'merge_music_genres',
  SHOW: 'merge_shows',
};

/**
 * Collapses duplicates into a survivor and returns how many children moved.
 *
 * The count is returned rather than discarded because it is the only feedback
 * the operator gets that the merge did what they meant: "3 requests moved" and
 * "0 requests moved" are the difference between having merged the right pair
 * and having merged two rows nobody had used, and the screen says which.
 */
export async function mergeMusicRecords(
  input: MergeFormInput,
  accessToken: string,
): Promise<number> {
  const { data, error } = await asCaller(accessToken).rpc(MERGE_DOORS[input.kind], {
    p_winner_id: input.winnerId,
    p_loser_ids: input.loserIds,
    p_reason: input.reason,
  });
  if (error) throw mapMusicError(error.code, error.message);
  if (typeof data !== 'number') throw new InternalError('the merge returned no count');
  return data;
}

export interface MergeCandidate {
  id: string;
  label: string;
  /** Null for the four short lists: only a song has a second line to show — its artist (0108's own comment). */
  subLabel: string | null;
  childCount: number;
  legacyId: string | null;
}

/**
 * list_merge_candidates (0108) takes its own `p_limit`, and this is it — one
 * capped read, not something to page through, which is why
 * music/maintenance/list-params.ts carries no cursor type at all.
 */
export const MERGE_CANDIDATE_LIMIT = 100;

/**
 * The Maintenance screen's one read: every live record of one kind in this
 * Station, with the number of children a merge would move — the figure that
 * makes naming the survivor a decision rather than a coin flip (0108's own
 * comment).
 */
export async function listMergeCandidates(
  companyId: string,
  kind: MusicMergeKind,
  search: string | undefined,
  accessToken: string,
): Promise<MergeCandidate[]> {
  const term = search?.trim().slice(0, SONG_SEARCH_MAX_LENGTH) || undefined;

  const { data, error } = await asCaller(accessToken).rpc('list_merge_candidates', {
    p_company_id: companyId,
    p_kind: kind,
    p_search: term,
    p_limit: MERGE_CANDIDATE_LIMIT,
  });
  if (error) throw mapMusicError(error.code, error.message);

  return (data ?? []).map((row) => ({
    id: row.id,
    label: row.label,
    subLabel: row.sub_label,
    childCount: row.child_count,
    legacyId: row.legacy_id,
  }));
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

/** MANUAL or IMPORT. Block 9's ETL adds the second door for the latter; nothing here has to change when it does. */
export type MusicRequestChannel = Database['public']['Enums']['music_request_channel'];

/** The same number the Songs and Artists lists use: what a person can scan. */
export const REQUEST_PAGE_SIZE = 50;

export interface RequestSummary {
  requestId: string;
  memberId: string;
  /**
   * Null for two different reasons — NOT exactly the situation
   * listParticipationsPage's own listenerName documents, which is itself two
   * causes, not one; do not conflate the two functions' reasons. Here: (1)
   * the caller holds music.view but not members.view, in which case 0107's
   * RULE 2 withholds this and memberPhone, not the row — the list still
   * lists, every row, with the two names blank rather than the page refused;
   * or (2) the caller DOES hold members.view and the listener has since
   * exercised LGPD erasure — 0107's join carries no anonymized_at filter, and
   * anonymize_member (0034) nulls members.full_name. The screen must not tell
   * the two apart (requests-grid.tsx gates its wording on canFindListeners
   * for exactly this reason).
   */
  memberName: string | null;
  memberPhone: string | null;
  songId: string;
  songTitle: string;
  /**
   * True once the song named here has since been archived. The row still
   * carries its title — archive_song (0101) is deliberately never refused
   * over a live request naming it, because a request is a historical fact
   * that outlives the song — so this is what tells the screen to say
   * "archived" rather than imply the song is still in the catalogue.
   */
  songArchived: boolean;
  artistName: string;
  showId: string | null;
  showName: string | null;
  channel: MusicRequestChannel;
  /**
   * What a listener typed alongside a request made from the Station's own
   * website (Block 17b). Null for every other channel, and null for a widget
   * request whose listener wrote nothing — the screen has no reason to tell
   * those apart, because both mean there is nothing to read.
   *
   * NOT withheld with memberName and memberPhone when the caller lacks
   * members.view: a note is about the request, not about who made it.
   */
  listenerNote: string | null;
  requestedAt: string;
}

export interface RequestListParams {
  companyId: string;
  songId?: string;
  showId?: string;
  channel?: MusicRequestChannel;
  /** A listener search. Returns nothing at all without members.view — 0107's RULE 3, not a bug (music/requests/list-params.ts's own comment). */
  search?: string;
  cursor: Cursor | null;
  cursorSide: 'after' | 'before';
}

export interface RequestListPage {
  rows: RequestSummary[];
  nextCursor: string | null;
  previousCursor: string | null;
  total: number;
}

/**
 * Reads the figure list_music_requests repeats on every row of one batch
 * (0107's own comment: computed from the same CTE the rows come from), so the
 * first row carries it for the whole page.
 *
 * Pulled out on its own because it is the one piece of this file's new code
 * that needed checking rather than assuming: is there ever a first row to
 * read when the filtered set is empty? Read against 0107's SQL directly —
 * `list_music_requests` is `returns table`, built from `select ... from
 * visible f where ...`, and a CTE with nothing in it joins to ZERO output
 * rows, not one row carrying `total_count = 0`. So an empty batch has no
 * first row to default away; it is simply the same fact as a total of zero,
 * exactly as listParticipationsPage (services/participations.ts) already
 * treats its own empty batch. Exported so that answer is pinned by a test
 * that needs no database, rather than left as a claim in a comment.
 */
export function totalFromRequestBatch(rows: readonly { total_count: number }[]): number {
  return Number(rows[0]?.total_count ?? 0);
}

/**
 * One keyset page of a Station's music requests, newest first — modelled
 * directly on listParticipationsPage (services/participations.ts): the
 * cursor travels apart from the row values, the read takes
 * `REQUEST_PAGE_SIZE + 1` rows, and a walking-back read is reversed by
 * keysetPage before this returns.
 *
 * Reads through asCaller rather than createUserClient(), for the identical
 * reason listParticipationsPage's own comment gives: list_music_requests
 * (0107) is SECURITY DEFINER, so its permission boundary is written in SQL
 * rather than enforced by RLS, and an explicit token is what lets this be
 * driven from tests/isolation too.
 */
export async function listMusicRequestsPage(
  params: RequestListParams,
  accessToken: string,
): Promise<RequestListPage> {
  const walkingBack = params.cursorSide === 'before' && params.cursor !== null;
  const term = params.search?.trim().slice(0, SONG_SEARCH_MAX_LENGTH) || undefined;

  const { data, error } = await asCaller(accessToken).rpc('list_music_requests', {
    p_company_id: params.companyId,
    p_song_id: params.songId,
    p_show_id: params.showId,
    p_channel: params.channel,
    p_search: term,
    // Cursor.value is nullable because other screens sort by a nullable
    // column; requested_at is not null (0098), so a null here can only mean
    // "no cursor", which is what undefined says to the function's default —
    // listParticipationsPage's identical reasoning for participated_at.
    p_cursor_at: params.cursor?.value ?? undefined,
    p_cursor_id: params.cursor?.id,
    p_walking_back: walkingBack,
    // One past the page, which is how keysetPage knows there is a next one.
    p_limit: REQUEST_PAGE_SIZE + 1,
  });

  if (error) throw mapMusicError(error.code, error.message);

  const fetched = data ?? [];

  const { rows: page, nextCursor, previousCursor } = keysetPage(fetched, {
    pageSize: REQUEST_PAGE_SIZE,
    walkingBack,
    hadCursor: params.cursor !== null,
    cursorFor: (row) => ({ value: row.requested_at, id: row.request_id }),
  });

  return {
    rows: page.map((row) => ({
      requestId: row.request_id,
      memberId: row.member_id,
      memberName: row.member_name,
      memberPhone: row.member_phone,
      songId: row.song_id,
      songTitle: row.song_title,
      songArchived: row.song_archived,
      artistName: row.artist_name,
      showId: row.show_id,
      showName: row.show_name,
      channel: row.channel,
      listenerNote: row.listener_note,
      requestedAt: row.requested_at,
    })),
    nextCursor,
    previousCursor,
    total: totalFromRequestBatch(fetched),
  };
}

export interface CreateMusicRequestInput {
  companyId: string;
  /**
   * Already resolved: create_music_request (0107) takes a listener, never a
   * set of identifying fields. resolveOrCreateMember (services/participations.ts)
   * is the door that turns the form's "pick one or register one" choice into
   * this one id — the same split record-participation-form.tsx already makes
   * before calling recordParticipation.
   */
  memberId: string;
  songId: string;
  showId?: string;
  requestedAt?: string;
}

/**
 * Records a request by hand. `p_requested_at` is sent only when the form gave
 * one — `coalesce(p_requested_at, now())` in 0107 means omitting the key and
 * sending null are the same, and omitting it is the one that survives a
 * future change to the default.
 */
export async function createMusicRequest(
  input: CreateMusicRequestInput,
  accessToken: string,
): Promise<string> {
  const { data, error } = await asCaller(accessToken).rpc('create_music_request', {
    p_company_id: input.companyId,
    p_member_id: input.memberId,
    p_song_id: input.songId,
    p_show_id: input.showId,
    p_requested_at: input.requestedAt,
  });
  if (error) throw mapMusicError(error.code, error.message);
  if (typeof data !== 'string') throw new InternalError('create_music_request returned no id');
  return data;
}

/**
 * Withdraws a mistyped manual entry. Gated on music.request, not a
 * destructive code — archive_music_request's own comment (0107) says why:
 * deleted_at exists on this table for exactly this one purpose, and whoever
 * may record a request is who notices they typed it wrong. Never a DELETE.
 */
export async function archiveMusicRequest(requestId: string, accessToken: string): Promise<void> {
  const { error } = await asCaller(accessToken).rpc('archive_music_request', {
    p_request_id: requestId,
  });
  if (error) throw mapMusicError(error.code, error.message);
}

const SONG_OPTION_COLUMNS = 'id, title, artists(name), albums(cover_md5)';

/**
 * Left a plain string rather than `as const`, for the identical reason
 * SONG_COLUMNS above gives at length: supabase-js would infer `artists` as
 * non-null from `artist_id`'s own non-nullability, which is exactly the
 * mistake 0099's RLS makes possible — an archived artist is unreadable for
 * every caller including the owner — so the shape is declared by hand below
 * rather than trusted to a green typecheck that isn't actually checking it.
 */
type SongOptionRow = Pick<Database['public']['Tables']['songs']['Row'], 'id' | 'title'> & {
  artists: { name: string } | null;
  albums: { cover_md5: string | null } | null;
};

export interface SongOption {
  songId: string;
  title: string;
  /**
   * Null for the reason SONG_COLUMNS' comment gives in full: an archived
   * artist is unreadable through RLS even though the song still names one.
   * Same fact SongSummary.artistName (above) already carries; this picker can
   * hit it too, so the mapping is exported and pinned by a test rather than
   * trusted to look obviously right.
   */
  artistName: string | null;
  /** The album cover, for the picker's thumb. Null for a song with no album, and for one whose album RLS hides. */
  coverMd5: string | null;
}

/** Turns one fetched row into the option the picker renders. Exported for the reason its own doc comment gives. */
export function toSongOption(row: SongOptionRow): SongOption {
  return {
    songId: row.id,
    title: row.title,
    artistName: row.artists?.name ?? null,
    coverMd5: row.albums?.cover_md5 ?? null,
  };
}

/**
 * A picker is scanned, not paged — the same magnitude
 * `STATION_LISTENER_PAGE_SIZE` (@/lib/station-listeners) uses for the
 * identical reason, smaller than SONG_PAGE_SIZE because this list is never
 * meant to be the whole catalogue.
 */
export const SONG_PICKER_MAX_RESULTS = 20;

export interface SongSearchPage {
  songs: SongOption[];
  /**
   * True when the search matched more than this page shows —
   * searchStationListeners' (services/participations.ts) own shape, so the
   * picker can say it was cut instead of quietly ending. Deliberately not a
   * bare `SongOption[]`: this codebase already rejects inferring a cut from a
   * full page (listLinkablePrizes' own comment, services/promotions.ts) — a
   * Station whose search matches exactly `SONG_PICKER_MAX_RESULTS` songs
   * would otherwise be told about a truncation that never happened.
   */
  hasMore: boolean;
}

/**
 * The request form's song picker: live songs in this Station, searched by
 * title and internal_code — never the artist's name, for the identical
 * PostgREST limitation listSongsPage's own comment gives (`.or()` cannot
 * reach an embedded resource's column).
 *
 * Archived songs are excluded: this feeds the choice for a NEW request, and
 * create_music_request (0107) refuses one naming a song that is not live
 * here. An existing request that already names an archived song is still
 * shown by listMusicRequestsPage, with songArchived marking it — a different
 * screen answering a different question.
 *
 * Reads through asCaller rather than createUserClient(), matching every other
 * exported function in this module that takes an accessToken — searchSongs is
 * called from the same Server Actions that already hold one, and a second
 * client-construction convention in one file is a seam worth not having.
 */
export async function searchSongs(
  companyId: string,
  term: string,
  accessToken: string,
): Promise<SongSearchPage> {
  const trimmed = term.trim().slice(0, SONG_SEARCH_MAX_LENGTH);

  let query = asCaller(accessToken)
    .from('songs')
    .select(SONG_OPTION_COLUMNS)
    .eq('company_id', companyId)
    .is('deleted_at', null);

  if (trimmed) {
    const wildcard = quoteForOrFilter(`%${escapeLikePattern(trimmed)}%`);
    query = query.or(`title.ilike.${wildcard},internal_code.ilike.${wildcard}`);
  }

  const { data, error } = await query
    .order('title', { ascending: true })
    .limit(SONG_PICKER_MAX_RESULTS + 1);

  if (error) throw new InternalError(`Could not search songs: ${error.message}`);

  const rows: SongOptionRow[] = data ?? [];
  return {
    songs: rows.slice(0, SONG_PICKER_MAX_RESULTS).map(toSongOption),
    hasMore: rows.length > SONG_PICKER_MAX_RESULTS,
  };
}

/**
 * The error taxonomy in lib/errors.ts exists so a caller can tell these
 * apart; collapsing them into one class throws that away — the same warning
 * mapInventoryError (services/inventory.ts) and mapRoleError (services/roles.ts)
 * carry for their own tables.
 *
 * - `42501` is has_permission failing inside a SECURITY DEFINER body — every
 *   RPC in 0100/0101 raises this with the same shape, having already written
 *   a RAISE LOG line server-side. Also what an unknown id answers, by
 *   design: 0100/0101 check permission BEFORE existence, so a caller cannot
 *   learn whether an id names anything they cannot reach. Block 7b's write
 *   doors (0106's five merge doors, 0107's create_music_request) raise it the
 *   identical way for music.merge and music.request respectively, checked
 *   before the Station or the record either. 0108's list_merge_candidates
 *   raises it too, but for music.view (Task 9's fix round corrected this
 *   from an original music.merge gate — see 0108's own comment) — a read,
 *   not a write, listed here because it throws through this same taxonomy.
 * - `P0002` is a named reference (artist/label/genre) that is missing, or
 *   belongs to another Station — assert_song_references_live's own raise.
 *   Now also covers: a merge naming a record that is missing, already
 *   archived or in another Station (0106 answers all three identically on
 *   purpose — a distinct message would let a caller probe another Station),
 *   and a request naming a listener not linked to this Station, a song that
 *   is not live here, or a programme that is not.
 * - `23505` is a duplicate legacy_id, rewritten by the RPC itself to name
 *   the handle ("a record with legacy id ... already exists in this
 *   station").
 * - `22023` is every validation raise: a blank name/title, or a duration
 *   that is not a positive whole number of seconds. schemas/music.ts
 *   catches all of these before a request is ever sent; this mapping is
 *   what still applies if a caller bypasses the form. 0106's merge core adds
 *   three more of the same shape, caught the same way by mergeFormSchema
 *   before a request is ever sent: a blank reason, an empty loser list, and a
 *   survivor named among its own losers.
 * - `23503` is archive_music_reference's refusal while a live song (or
 *   request, for a show) still names the record; its message names the
 *   count ("this record is still used by N live row(s)").
 * - Anything else is ours, not the caller's. Labelling an unexpected
 *   database fault a refusal hides a real fault behind a plausible-looking
 *   permission or business-rule message. `XX000` — the unreachable branch in
 *   0106's and 0108's own kind dispatch — falls through to here on purpose:
 *   it exists to be loud if the enum ever grows a sixth value with no rule
 *   written for it, not to be given a friendlier face.
 */
function mapMusicError(code: string | undefined, message: string): Error {
  if (code === '23503') return new BusinessRuleError(message);
  if (code === '23505') return new ConflictError(message);
  if (code === '22023' || code === '23514') return new ValidationError(message);
  if (code === 'P0002') return new NotFoundError(message);
  if (code === '42501') return new UnauthorizedError(message);
  return new InternalError(message);
}
