import 'server-only';
import { createClient } from '@supabase/supabase-js';
import { createUserClient } from '@/lib/supabase/user-client';
import { getUserSupabaseConfig } from '@/lib/supabase/config';
import { BusinessRuleError, InternalError, NotFoundError, UnauthorizedError } from '@/lib/errors';
import { keysetFilter, keysetPage } from '@/lib/keyset';
import type { Cursor, SortDirection } from '@/lib/keyset';
import { escapeLikePattern } from '@/lib/postgrest';
import { toBands, type Band, type ScheduleRow } from '@/lib/shows/bands';
import type { Database } from '@/lib/supabase/database.types';
import type { ShowFormInput } from '@/schemas/shows';

export type ShowKind = Database['public']['Enums']['show_kind'];
export type ShowAgeRating = Database['public']['Enums']['show_age_rating'];

/**
 * Block 18. Programmes, read through PostgREST and written through 0175's doors.
 *
 * READS GO STRAIGHT TO THE TABLE, like songs and unlike promotions: `shows` and
 * `show_schedules` each carry one select policy gated on `music.view`, so RLS
 * already scopes every row to the Stations the caller can see. Adding a list
 * RPC would be a second pattern for a job this codebase already has one for.
 *
 * WRITES CANNOT: neither table has an insert or update policy at all, which is
 * how `shows` has always worked. save_show and end_show are SECURITY DEFINER and
 * re-check `music.manage` against auth.uid().
 */

function asCaller(accessToken: string) {
  const { url, anonKey } = getUserSupabaseConfig();
  return createClient<Database>(url, anonKey, {
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

export const SHOW_PAGE_SIZE = 25;
export const SHOW_SEARCH_MAX_LENGTH = 100;

export type ShowSortKey = 'name' | 'created';

export interface ShowSummary {
  id: string;
  /**
   * The Station the programme belongs to, carried on the row rather than taken
   * from whichever Station the list happens to be showing: a record opened from
   * a pasted `?record=` link may not be one of them, and `save_show` scopes its
   * update by company — a mismatch would come back as "programme not found".
   */
  companyId: string;
  name: string;
  kind: ShowKind | null;
  ageRating: ShowAgeRating | null;
  presenterName: string | null;
  producerName: string | null;
  thumbUrl: string | null;
  startsOn: string | null;
  endsOn: string | null;
  /** When the programme was registered here — the second thing the list sorts by. */
  createdAt: string;
  bands: Band[];
  /**
   * Whether the programme carries everything D3 and D7 require. Computed HERE
   * rather than on each screen, so the list's badge and the dialog's validation
   * cannot come to disagree about what incomplete means.
   *
   * On the day Block 18 ships this is false for all four existing programmes,
   * which is the intended behaviour rather than a migration gap.
   */
  complete: boolean;
  /** `ends_on` in the past. Hidden from the list unless the filter is opened. */
  ended: boolean;
}

export interface ShowListParams {
  companyId: string;
  search?: string;
  /** One kind of programme, when the filter bar narrows to it. */
  kind?: ShowKind;
  includeEnded?: boolean;
  sort: ShowSortKey;
  direction: SortDirection;
  cursor: Cursor | null;
  cursorSide: 'after' | 'before';
}

export interface ShowListPage {
  rows: ShowSummary[];
  nextCursor: string | null;
  previousCursor: string | null;
  total: number;
}

const SHOW_COLUMNS =
  'id,company_id,name,kind,age_rating,presenter_name,producer_name,thumb_url,starts_on,ends_on,created_at,' +
  'show_schedules(band,weekday,starts_at,ends_at)';

type ShowRow = {
  id: string;
  company_id: string;
  name: string;
  kind: ShowKind | null;
  age_rating: ShowAgeRating | null;
  presenter_name: string | null;
  producer_name: string | null;
  thumb_url: string | null;
  starts_on: string | null;
  ends_on: string | null;
  created_at: string;
  show_schedules: ScheduleRow[] | null;
};

function toSummary(row: ShowRow, today: string): ShowSummary {
  const bands = toBands(row.show_schedules ?? []);

  return {
    id: row.id,
    companyId: row.company_id,
    name: row.name,
    kind: row.kind,
    ageRating: row.age_rating,
    presenterName: row.presenter_name,
    producerName: row.producer_name,
    thumbUrl: row.thumb_url,
    startsOn: row.starts_on,
    endsOn: row.ends_on,
    createdAt: row.created_at,
    bands,
    complete:
      row.kind !== null && row.age_rating !== null && row.starts_on !== null && bands.length > 0,
    ended: row.ends_on !== null && row.ends_on < today,
  };
}

export async function listShowsPage(params: ShowListParams): Promise<ShowListPage> {
  const supabase = await createUserClient();

  const column = params.sort === 'name' ? 'name' : 'created_at';
  const walkingBack = params.cursorSide === 'before' && params.cursor !== null;
  const ascending = walkingBack ? params.direction === 'desc' : params.direction === 'asc';
  const readDirection: SortDirection = ascending ? 'asc' : 'desc';

  // The Station's own date rather than the server's, for the same reason
  // shows_on_air converts through companies.timezone: "ended" is a wall-clock
  // question. The screen passes the date it computed from the Station it is
  // showing, so this function never has to guess whose midnight it is.
  const today = new Date().toISOString().slice(0, 10);

  const build = (options?: { count: 'exact'; head: true }) => {
    let q = supabase
      .from('shows')
      .select(SHOW_COLUMNS, options)
      .eq('company_id', params.companyId)
      .is('deleted_at', null);

    // D8: an ended programme is hidden rather than gone. `or` because ends_on
    // is nullable and a null end means indeterminate, which is very much on air.
    if (!params.includeEnded) q = q.or(`ends_on.is.null,ends_on.gte.${today}`);

    // The four programmes that predate this block carry no kind at all, so this
    // filter hides them: an operator narrowing to Musical is asking for the ones
    // marked Musical, and a null is not an unmarked member of every kind.
    if (params.kind) q = q.eq('kind', params.kind);

    if (params.search) {
      const term = escapeLikePattern(params.search.slice(0, SHOW_SEARCH_MAX_LENGTH));
      q = q.ilike('name', `%${term}%`);
    }

    return q;
  };

  let query = build().order(column, { ascending });
  if (params.cursor) {
    // Neither sort column is nullable, so there is no null region for a cursor
    // to cross into — the same reasoning listSongsPage records.
    query = query.or(keysetFilter(column, readDirection, params.cursor, false));
  }
  query = query.order('id', { ascending });

  const { data, error } = await query.limit(SHOW_PAGE_SIZE + 1);
  if (error) throw new InternalError(`Could not read programmes: ${error.message}`);

  const rows = (data ?? []) as unknown as ShowRow[];

  const { rows: page, nextCursor, previousCursor } = keysetPage(rows, {
    pageSize: SHOW_PAGE_SIZE,
    walkingBack,
    hadCursor: params.cursor !== null,
    cursorFor: (row) => ({
      value: params.sort === 'name' ? row.name : row.created_at,
      id: row.id,
    }),
  });

  const { count, error: countError } = await build({ count: 'exact', head: true });
  if (countError) throw new InternalError(`Could not count programmes: ${countError.message}`);

  return {
    rows: page.map((row) => toSummary(row, today)),
    nextCursor,
    previousCursor,
    total: count ?? 0,
  };
}

/** One programme by id. RLS already scopes this, so an unreachable one comes back null. */
export async function getShowById(showId: string): Promise<ShowSummary | null> {
  const supabase = await createUserClient();
  const today = new Date().toISOString().slice(0, 10);

  const { data, error } = await supabase
    .from('shows')
    .select(SHOW_COLUMNS)
    .eq('id', showId)
    .is('deleted_at', null)
    .maybeSingle();

  if (error) throw new InternalError(`Could not read the programme: ${error.message}`);
  return data ? toSummary(data as unknown as ShowRow, today) : null;
}

function mapShowError(code: string | undefined, message: string): Error {
  if (code === '42501') return new UnauthorizedError(message);
  if (code === 'P0002') return new NotFoundError(message);
  // 22023 is every refusal save_show raises for a missing required field, and
  // its message is written to be read by an operator rather than decoded.
  if (code === '22023') return new BusinessRuleError(message);
  return new InternalError(message);
}

export async function saveShow(input: ShowFormInput, accessToken: string): Promise<string> {
  const { data, error } = await asCaller(accessToken).rpc('save_show', {
    p_company_id: input.companyId,
    p_name: input.name,
    p_kind: input.kind,
    p_age_rating: input.ageRating,
    p_starts_on: input.startsOn,
    // The bands go across UNTRANSLATED: the form, this call and save_show all
    // speak `{days, starts, ends}`. A mapping here would be a layer whose only
    // job is to undo itself on the other side.
    p_bands: input.bands,
    p_presenter_name: input.presenterName ?? undefined,
    p_producer_name: input.producerName ?? undefined,
    p_ends_on: input.endsOn ?? undefined,
    p_show_id: input.showId ?? undefined,
  });

  if (error) throw mapShowError(error.code, error.message);
  if (typeof data !== 'string') throw new InternalError('save_show returned no id');
  return data;
}

export async function endShow(
  showId: string,
  endsOn: string,
  accessToken: string,
): Promise<void> {
  const { error } = await asCaller(accessToken).rpc('end_show', {
    p_show_id: showId,
    p_ends_on: endsOn,
  });
  if (error) throw mapShowError(error.code, error.message);
}
