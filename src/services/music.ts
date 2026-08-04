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
import type { Database } from '@/lib/supabase/database.types';
import { SONG_SEARCH_MAX_LENGTH } from '@/schemas/music';
import type {
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

// ---------------------------------------------------------------------------
// Songs
// ---------------------------------------------------------------------------

/** The audience and inventory lists' page size, for the same reason: it is what a person can scan. Reused below for the Artists list too — one number for the whole module. */
export const SONG_PAGE_SIZE = 50;

/**
 * One constant shared by the row read and the count read, so the two cannot
 * disagree. The three embeds are resolved through the foreign keys 0098
 * declares (songs.artist_id/label_id/genre_id) — confirmed against the
 * generated types, not assumed: artist_id is NOT NULL, so `artists` comes
 * back as a single non-null object; label_id and genre_id are nullable, so
 * `record_labels`/`music_genres` come back as an object or null. See SongRow
 * below, which encodes exactly that shape.
 */
const SONG_COLUMNS =
  'id, title, artist_id, label_id, genre_id, nationality, vocal, duration_seconds, internal_code, legacy_id, created_at, artists(name), record_labels(name), music_genres(name)';

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
> & {
  artists: { name: string };
  record_labels: { name: string } | null;
  music_genres: { name: string } | null;
};

export interface SongSummary {
  id: string;
  title: string;
  artistId: string;
  artistName: string;
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
}

function toSongSummary(row: SongRow): SongSummary {
  return {
    id: row.id,
    title: row.title,
    artistId: row.artist_id,
    artistName: row.artists.name,
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
  });
  if (error) throw mapMusicError(error.code, error.message);
  if (typeof data !== 'string') throw new InternalError('create_song returned no id');
  return data;
}

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
    p_legacy_id: input.legacyId,
  });
  if (error) throw mapMusicError(error.code, error.message);
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
    .select('id, title, created_at')
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
    rows: windowed.map((row) => ({ id: row.id, title: row.title, createdAt: row.created_at })),
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
 * Replaces a reference record's name and legacy handle wholesale —
 * update_music_reference (0100) sets every field on every call, never
 * merged. The Station is resolved from the row itself inside the RPC, never
 * from a parameter here.
 */
export async function updateMusicReference(
  input: ReferenceUpdateInput,
  accessToken: string,
): Promise<void> {
  const { error } = await asCaller(accessToken).rpc('update_music_reference', {
    p_kind: input.kind,
    p_id: input.id,
    p_name: input.name,
    p_legacy_id: input.legacyId,
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
 *   learn whether an id names anything they cannot reach.
 * - `P0002` is a named reference (artist/label/genre) that is missing, or
 *   belongs to another Station — assert_song_references_live's own raise.
 * - `23505` is a duplicate legacy_id, rewritten by the RPC itself to name
 *   the handle ("a record with legacy id ... already exists in this
 *   station").
 * - `22023` is every validation raise: a blank name/title, or a duration
 *   that is not a positive whole number of seconds. schemas/music.ts
 *   catches all of these before a request is ever sent; this mapping is
 *   what still applies if a caller bypasses the form.
 * - `23503` is archive_music_reference's refusal while a live song (or
 *   request, for a show) still names the record; its message names the
 *   count ("this record is still used by N live row(s)").
 * - Anything else is ours, not the caller's. Labelling an unexpected
 *   database fault a refusal hides a real fault behind a plausible-looking
 *   permission or business-rule message.
 */
function mapMusicError(code: string | undefined, message: string): Error {
  if (code === '23503') return new BusinessRuleError(message);
  if (code === '23505') return new ConflictError(message);
  if (code === '22023' || code === '23514') return new ValidationError(message);
  if (code === 'P0002') return new NotFoundError(message);
  if (code === '42501') return new UnauthorizedError(message);
  return new InternalError(message);
}
