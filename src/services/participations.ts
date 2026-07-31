import 'server-only';
import { createClient } from '@supabase/supabase-js';
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
import { PARTICIPATION_STATUSES } from '@/lib/participation-status';
import type { ParticipationStatus } from '@/lib/participation-status';
// The picker's page size lives in @/lib for the reason that module's own
// comment gives: the form that announces the cut is a client component and
// cannot import a value out of this `server-only` file.
import { STATION_LISTENER_PAGE_SIZE } from '@/lib/station-listeners';
import type { Database } from '@/lib/supabase/database.types';
import { cpfLastDigits, hashCpf } from '@/services/members';
import type { ImportRowInput, ParticipationAnswerInput } from '@/schemas/participations';

/** MANUAL or IMPORT. Block 5 adds WHATSAPP to the enum, and nothing here has to change. */
export type ParticipationSource = Database['public']['Enums']['participation_source'];

/**
 * Re-exported so a server-side caller looks in one place for the row's own
 * vocabulary, while the grid — a client component — reaches the same type and
 * the labels beside it without importing this `server-only` module. The values
 * live in @/lib/participation-status; see its own comment.
 */
export type { ParticipationStatus };

/**
 * A client bound to the caller's JWT. record_participation and
 * import_participations re-check has_permission against auth.uid() inside their
 * SECURITY DEFINER bodies, and resolve_or_create_member is SECURITY INVOKER
 * whose two callees do the same, so calling any of them with the service key
 * would defeat the check it exists to make — the reasoning services/promotions.ts
 * and services/inventory.ts both give for their own asCaller.
 */
function asCaller(accessToken: string) {
  const { url, anonKey } = getUserSupabaseConfig();
  return createClient<Database>(url, anonKey, {
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

export const PARTICIPATION_PAGE_SIZE = 25;

/** The one bound on a search term, exported so the page enforces this number rather than a copy of it. */
export const PARTICIPATION_SEARCH_MAX_LENGTH = 100;

export interface ParticipationSummary {
  id: string;
  promotionId: string;
  /** Never null in practice: 0053's policy only shows a participation whose promotion is readable. */
  promotionName: string | null;
  memberId: string;
  /**
   * Null in two different situations, and the grid must not tell them apart:
   * an anonymised listener (0034 scrubs full_name), and a caller who holds
   * participations.view but not members.view — see the note on the two selects
   * below.
   */
  listenerName: string | null;
  listenerPhone: string | null;
  listenerCpfLastDigits: string | null;
  status: ParticipationStatus;
  source: ParticipationSource;
  participatedAt: string;
}

export interface ParticipationListParams {
  companyId: string;
  /** One promotion, which is also how the promotion record's tab links into this screen. */
  promotionId?: string;
  status?: ParticipationStatus;
  source?: ParticipationSource;
  /** Instants. Narrow by when the person entered, never by when the row was written. */
  from?: string;
  to?: string;
  /** By listener name, phone or CPF. Requires members.view — see the note below. */
  search?: string;
  cursor: Cursor | null;
  cursorSide: 'after' | 'before';
}

export interface ParticipationListPage {
  rows: ParticipationSummary[];
  nextCursor: string | null;
  previousCursor: string | null;
  total: number;
}

/**
 * The columns the grid renders, plus the two embeds it needs to name a
 * promotion and a listener.
 *
 * `promotions!participations_promotion_fk` is disambiguated on purpose, not out
 * of habit: participations carries TWO foreign keys to promotions — the
 * composite (promotion_id, company_id) and 0052's (promotion_id,
 * allows_multiple), which exists to make the partial unique index possible — and
 * PostgREST answers a bare `promotions(...)` with PGRST201 rather than picking
 * one (probed against the running stack).
 *
 * The listener is reached THROUGH member_company_links because there is no
 * foreign key from participations to members: 0052 keys on the link table
 * instead, deliberately, so that one constraint proves both that the listener
 * exists and that this Station has them. The nested embed is the join that
 * follows from that choice.
 *
 * A single string literal, never assembled by concatenation: supabase-js infers
 * the returned row's shape by parsing this argument's literal TYPE at compile
 * time, so a runtime-built string collapses every field to GenericStringError
 * (services/members.ts states the same rule for its own select).
 */
const PARTICIPATION_COLUMNS =
  'id,promotion_id,member_id,status,source,participated_at,promotions!participations_promotion_fk(name),member_company_links(members(full_name,phone,cpf_last_digits))' as const;

/**
 * The same read with both embeds made inner, used ONLY when a search term is
 * present, because a search has to be a condition Postgres evaluates rather
 * than a filter applied to a page that has already been fetched.
 *
 * The cost of `!inner`, stated rather than discovered later: member_company_links
 * and members are behind 0035's policies, which need members.view. A caller who
 * holds participations.view and not members.view therefore gets NOTHING from
 * this variant, where the plain one above still lists every participation with
 * the listener's name left null. That is why the two exist rather than one: the
 * list must not empty itself for a caller who is allowed to see it, and a caller
 * who may not read a listener's name cannot search by it either. The same shape
 * listOrganizationMembers uses for its blocked-only filter.
 */
const PARTICIPATION_COLUMNS_SEARCHED =
  'id,promotion_id,member_id,status,source,participated_at,promotions!participations_promotion_fk(name),member_company_links!inner(members!inner(full_name,phone,cpf_last_digits))' as const;

/** The row shape both selects share; the searched variant carries no extra keys. */
interface ParticipationRecord {
  id: string;
  promotion_id: string;
  member_id: string;
  status: ParticipationStatus;
  source: ParticipationSource;
  participated_at: string;
  promotions: { name: string } | null;
  member_company_links: {
    members: { full_name: string | null; phone: string | null; cpf_last_digits: string | null } | null;
  } | null;
}

/**
 * One keyset page, ordered by when the person entered — newest first, tie-broken
 * by id, which is exactly what participations_listing_idx (0052) carries. A
 * keyset cursor must compare precisely the columns it orders by (Block 3b), and
 * that is the whole reason the ordering here is FIXED rather than a sort key the
 * operator chooses: there is one index, and an ordering it does not serve would
 * scan the Station.
 *
 * Every filter is a condition on the query. Nothing is fetched here in order to
 * be thrown away, and the count read is built from the same builder as the row
 * read, so the two cannot narrow differently — the defect listOrganizationMembers'
 * own comment describes for its blocked-only join.
 *
 * Takes the caller's token and reads through asCaller, as listOrganizationMembers
 * does and unlike listPromotionsPage's createUserClient(). Both reach the
 * database as the same user and RLS decides identically either way; the
 * difference is that createUserClient() reads `cookies()` from next/headers, so
 * a function built on it can only ever run inside a request and CANNOT be driven
 * from tests/isolation. This read is the participations screen — its two selects,
 * its cursor and the permission boundary between them — and proving it by hand
 * against a running stack proves it only until somebody stops typing.
 */
export async function listParticipationsPage(
  params: ParticipationListParams,
  accessToken: string,
): Promise<ParticipationListPage> {
  const supabase = asCaller(accessToken);

  const walkingBack = params.cursorSide === 'before' && params.cursor !== null;
  // The display direction is always descending, so the ascending read is
  // precisely the backward one — this is listPromotionsPage's
  // `walkingBack ? direction === 'desc' : direction === 'asc'` with the
  // direction fixed, and the rows keysetPage turns back around afterwards.
  const ascending = walkingBack;
  const readDirection: SortDirection = ascending ? 'asc' : 'desc';

  const term = params.search?.trim().slice(0, PARTICIPATION_SEARCH_MAX_LENGTH);
  const select = term ? PARTICIPATION_COLUMNS_SEARCHED : PARTICIPATION_COLUMNS;

  const build = (options?: { count: 'exact'; head: true }) => {
    let q = supabase
      .from('participations')
      .select(select, options)
      .eq('company_id', params.companyId);

    if (params.promotionId) q = q.eq('promotion_id', params.promotionId);
    if (params.status) q = q.eq('status', params.status);
    if (params.source) q = q.eq('source', params.source);
    if (params.from) q = q.gte('participated_at', params.from);
    if (params.to) q = q.lte('participated_at', params.to);

    if (term) {
      // escapeLikePattern runs BEFORE the wildcards are added, so it only ever
      // escapes what the operator typed and never the markers added here. The
      // digit-only clauses mirror listOrganizationMembers exactly: cpf_last_digits
      // is always three digits and phone_normalized is 0031's generated
      // digits-only column, so a term carrying no digit has nothing to compare
      // against either, and a digit-only term can contain no % or _ to escape.
      const wildcard = quoteForOrFilter(`%${escapeLikePattern(term)}%`);
      const clauses = [`full_name.ilike.${wildcard}`, `phone.ilike.${wildcard}`];
      const digits = term.replace(/[^0-9]/g, '');
      if (digits) {
        clauses.push(`cpf_last_digits.ilike.${quoteForOrFilter(`%${digits}%`)}`);
        clauses.push(`phone_normalized.ilike.${quoteForOrFilter(`%${digits}%`)}`);
      }
      // Two `or=` parameters on one request are ANDed by PostgREST, and this one
      // is scoped to the embedded table rather than to participations — verified
      // against the running stack, together with the keyset `or` below, which
      // narrows alongside it instead of replacing it.
      q = q.or(clauses.join(','), { referencedTable: 'member_company_links.members' });
    }

    return q;
  };

  let query = build().order('participated_at', { ascending });
  if (params.cursor) {
    // nullsLast is false because participated_at is not null (0052): there is
    // no null region for a cursor to cross into, unlike the audience list where
    // full_name is nullable.
    query = query.or(keysetFilter('participated_at', readDirection, params.cursor, false));
  }
  query = query.order('id', { ascending });

  const { data, error } = await query.limit(PARTICIPATION_PAGE_SIZE + 1);
  if (error) throw mapParticipationError(error.code, error.message);

  // One cast, because `select` is chosen between two constants above and
  // PostgREST cannot type a runtime choice.
  const fetched = (data ?? []) as unknown as ParticipationRecord[];

  const { rows: page, nextCursor, previousCursor } = keysetPage(fetched, {
    pageSize: PARTICIPATION_PAGE_SIZE,
    walkingBack,
    hadCursor: params.cursor !== null,
    cursorFor: (row) => ({ value: row.participated_at, id: row.id }),
  });

  const { count, error: countError } = await build({ count: 'exact', head: true });
  if (countError) throw mapParticipationError(countError.code, countError.message);

  return {
    rows: page.map((row) => {
      const member = row.member_company_links?.members ?? null;
      return {
        id: row.id,
        promotionId: row.promotion_id,
        promotionName: row.promotions?.name ?? null,
        memberId: row.member_id,
        listenerName: member?.full_name ?? null,
        listenerPhone: member?.phone ?? null,
        listenerCpfLastDigits: member?.cpf_last_digits ?? null,
        status: row.status,
        source: row.source,
        participatedAt: row.participated_at,
      };
    }),
    nextCursor,
    previousCursor,
    total: count ?? 0,
  };
}

export interface PromotionParticipationCounts {
  /** In the draw. */
  valid: number;
  /** Written down and not in the draw: DUPLICATE, TOO_SOON and OVER_LIMIT together. */
  refused: number;
}

/**
 * The two figures the promotion record's fifth tab shows, and nothing else.
 *
 * Two `head: true` count reads rather than a page of rows, because that tab is
 * the one place in this block where the size of a promotion could get into the
 * record dialog (design spec D8): the record is read once per opening, and a
 * promotion with eight thousand entries cannot be. Two counts cost the same at
 * eight thousand as at eight.
 *
 * `neq('status', 'VALID')` rather than three `eq` counts or one `in`: the tab
 * asks one question — how many did not count — and the three reasons are the
 * list screen's job, which is what the tab links out to. Adding a fourth status
 * to the enum in Block 5 therefore changes this figure's meaning without
 * changing this code, which is the behaviour that is wanted: anything that is
 * not VALID is not in the draw.
 *
 * Read through the caller's token like every other read here, so 0053's select
 * policy decides what is counted. A caller who cannot see this promotion's
 * entries gets zeroes rather than an error, which is the same answer the list
 * screen gives them.
 */
export async function countPromotionParticipations(
  promotionId: string,
  accessToken: string,
): Promise<PromotionParticipationCounts> {
  const supabase = asCaller(accessToken);

  // One builder, called twice: the two counts must narrow identically apart
  // from the status, and two hand-written selects are how a `promotion_id`
  // added to one and not the other turns into a refused total that counts the
  // whole Station.
  const build = () =>
    supabase
      .from('participations')
      .select('id', { count: 'exact', head: true })
      .eq('promotion_id', promotionId);

  const [valid, refused] = await Promise.all([
    build().eq('status', 'VALID'),
    build().neq('status', 'VALID'),
  ]);

  if (valid.error) throw mapParticipationError(valid.error.code, valid.error.message);
  if (refused.error) throw mapParticipationError(refused.error.code, refused.error.message);

  return { valid: valid.count ?? 0, refused: refused.count ?? 0 };
}

export interface StationListener {
  memberId: string;
  fullName: string | null;
  phone: string | null;
  cpfLastDigits: string | null;
}

export interface StationListenerPage {
  listeners: StationListener[];
  /** True when the search matched more than one page — surfaced, never silently dropped. */
  hasMore: boolean;
}

/**
 * The manual form's picker: listeners already linked to THIS Station, by name,
 * phone or CPF digits.
 *
 * Station-scoped and not Organization-scoped, and that is the whole reason this
 * is not listOrganizationMembers with a search term. apply_participation (0054)
 * refuses a listener the promotion's Station is not linked to — it checks
 * member_company_links itself so the refusal is a sentence rather than a
 * composite foreign key's name — so an Organization-wide picker would offer
 * people that recording an entry for is guaranteed to fail. A picker whose
 * options can be picked is worth a query of its own.
 *
 * The read is from `members` with the link table embedded `!inner`, rather than
 * from the link table outwards, because the ordering has to be on the parent:
 * PostgREST orders by an embedded column only within the embed. The `or` clauses
 * are listOrganizationMembers' and listParticipationsPage's, same escaping and
 * same digit-only pair — `cpf_last_digits` is three digits and
 * `phone_normalized` is 0031's generated digits-only column, so a term with no
 * digit has nothing to compare against either.
 *
 * An anonymised listener is excluded, which is a filter with a reason rather
 * than a convenience: 0034 scrubs full_name, so the row would be offered as a
 * blank line nobody can identify, and recording a fresh entry against somebody
 * who exercised erasure is precisely what that erasure was for.
 *
 * Needs members.view at this Station — 0035's policies decide it, and the
 * screen asks the same question first through canSearchByListener so an empty
 * answer is never mistaken for "nobody matched".
 */
export async function searchStationListeners(
  companyId: string,
  search: string,
  accessToken: string,
): Promise<StationListenerPage> {
  const term = search.trim().slice(0, PARTICIPATION_SEARCH_MAX_LENGTH);

  let query = asCaller(accessToken)
    .from('members')
    .select('id,full_name,phone,cpf_last_digits,member_company_links!inner(company_id)')
    .eq('member_company_links.company_id', companyId)
    .is('deleted_at', null)
    .is('anonymized_at', null);

  if (term) {
    const wildcard = quoteForOrFilter(`%${escapeLikePattern(term)}%`);
    const clauses = [`full_name.ilike.${wildcard}`, `phone.ilike.${wildcard}`];
    const digits = term.replace(/[^0-9]/g, '');
    if (digits) {
      clauses.push(`cpf_last_digits.ilike.${quoteForOrFilter(`%${digits}%`)}`);
      clauses.push(`phone_normalized.ilike.${quoteForOrFilter(`%${digits}%`)}`);
    }
    query = query.or(clauses.join(','));
  }

  // One row past the page, spent on `hasMore` and never rendered as an option —
  // the same shape listLinkablePrizes uses, and the reason the picker can say it
  // was cut instead of quietly ending.
  const { data, error } = await query
    .order('full_name', { ascending: true })
    .limit(STATION_LISTENER_PAGE_SIZE + 1);

  if (error) throw mapParticipationError(error.code, error.message);

  const rows = data ?? [];
  return {
    listeners: rows.slice(0, STATION_LISTENER_PAGE_SIZE).map((row) => ({
      memberId: row.id,
      fullName: row.full_name,
      phone: row.phone,
      cpfLastDigits: row.cpf_last_digits,
    })),
    hasMore: rows.length > STATION_LISTENER_PAGE_SIZE,
  };
}

/**
 * The three, and only three, answers resolve_or_create_member (0054) is allowed
 * to give. The union is what makes a caller that reaches into the `elsewhere`
 * branch for a `memberId` that was never returned a compile error instead of an
 * `undefined` found at runtime — the same shape and the same reason
 * FindMemberByIdentifierResult carries in services/members.ts.
 */
export type ResolveMemberResult =
  | { outcome: 'resolved'; memberId: string }
  | { outcome: 'created'; memberId: string }
  | { outcome: 'elsewhere' };

function parseResolveMemberResult(data: unknown): ResolveMemberResult {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw new InternalError('resolve_or_create_member returned an unexpected shape');
  }
  const row = data as Record<string, unknown>;
  if (row.outcome === 'elsewhere') return { outcome: 'elsewhere' };
  if (row.outcome === 'resolved' || row.outcome === 'created') {
    if (typeof row.member_id !== 'string') {
      throw new InternalError(
        `resolve_or_create_member returned "${row.outcome}" with no member_id`,
      );
    }
    return { outcome: row.outcome, memberId: row.member_id };
  }
  throw new InternalError(
    `resolve_or_create_member returned an unrecognised outcome: ${String(row.outcome)}`,
  );
}

export interface ResolveMemberInput {
  companyId: string;
  fullName: string;
  phone?: string;
  email?: string;
  /** Raw CPF — hashed here before the RPC ever sees it, same as createMember. */
  cpf?: string;
  passport?: string;
}

/**
 * Block 3's deduplication, or a registration when it finds nobody (design spec
 * D4). Both doors into a participation resolve through this one function so
 * they cannot drift — the manual form calls it unless the operator already
 * picked somebody, and the import calls it per row inside its own RPC.
 *
 * `elsewhere` is not an error and not a registration: an identifier matches a
 * listener this caller may not reach, the RPC deliberately returns no id, and
 * 0031's per-Organization unique indexes would refuse the duplicate anyway. The
 * caller reports it and moves on.
 */
export async function resolveOrCreateMember(
  input: ResolveMemberInput,
  accessToken: string,
): Promise<ResolveMemberResult> {
  const { data, error } = await asCaller(accessToken).rpc('resolve_or_create_member', {
    p_company_id: input.companyId,
    p_full_name: input.fullName,
    p_phone: input.phone,
    p_email: input.email,
    p_cpf_hash: input.cpf ? hashCpf(input.cpf) : undefined,
    p_cpf_last_digits: input.cpf ? cpfLastDigits(input.cpf) : undefined,
    p_passport: input.passport,
  });
  if (error) throw mapParticipationError(error.code, error.message);
  return parseResolveMemberResult(data);
}

export interface RecordParticipationInput {
  promotionId: string;
  /** Already resolved: record_participation takes a listener, never a set of identifying fields (spec §5). */
  memberId: string;
  participatedAt: string;
  /** Recorded, not consulted — it says how the row arrived and decides nothing about who may write it (0054). */
  source: ParticipationSource;
  answers?: ParticipationAnswerInput[];
}

export interface RecordParticipationResult {
  participationId: string;
  /**
   * What happened to the attempt. Three of the four values are NOT failures:
   * repeating, coming back too soon and passing the ceiling are written down
   * with the status that says so (design spec D5), so a caller that treats
   * anything but VALID as an error is reporting a refusal the database chose to
   * record rather than reject.
   */
  status: ParticipationStatus;
}

/**
 * Checked against the vocabulary rather than cast to it. Both RPCs return their
 * status inside a jsonb object, which arrives here as `unknown`, and `as
 * ParticipationStatus` on an unrecognised string would type-check perfectly and
 * then render as a blank badge — STATUS_LABELS has no entry for it — with
 * nothing anywhere saying why. Block 5 adding a status to the enum without
 * adding it to @/lib/participation-status is exactly how that would arise.
 */
function asStatus(value: unknown, source: string): ParticipationStatus {
  if (typeof value === 'string' && PARTICIPATION_STATUSES.includes(value as ParticipationStatus)) {
    return value as ParticipationStatus;
  }
  throw new InternalError(`${source} returned an unrecognised status: ${String(value)}`);
}

function parseRecordParticipationResult(data: unknown): RecordParticipationResult {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw new InternalError('record_participation returned an unexpected shape');
  }
  const row = data as Record<string, unknown>;
  if (typeof row.participation_id !== 'string') {
    throw new InternalError('record_participation returned no participation_id');
  }
  return {
    participationId: row.participation_id,
    status: asStatus(row.status, 'record_participation'),
  };
}

export async function recordParticipation(
  input: RecordParticipationInput,
  accessToken: string,
): Promise<RecordParticipationResult> {
  const { data, error } = await asCaller(accessToken).rpc('record_participation', {
    p_promotion_id: input.promotionId,
    p_member_id: input.memberId,
    p_participated_at: input.participatedAt,
    p_source: input.source,
    p_answers: (input.answers ?? []).map((a) => ({
      question_id: a.questionId,
      option_id: a.optionId,
      answer_text: a.answerText,
    })),
  });
  if (error) throw mapParticipationError(error.code, error.message);
  return parseRecordParticipationResult(data);
}

export interface ImportRowOutcome {
  /** The line of the file this row came from, so the screen can name what it skipped. */
  line: number;
  outcome: 'recorded' | 'skipped';
  /** Present on a recorded row only. */
  status?: ParticipationStatus;
  /**
   * Present on a skipped row only, and one of exactly three (0054, 0056):
   * `'no identifier'`, `'listener is out of reach'`, `'listener is at another
   * station'`. Typed as a plain string rather than as a union on purpose — it
   * arrives from a jsonb payload, and a union here would promise the compiler
   * something only the database can keep. The screen matches on the three and
   * has a fallback, so a fourth reason added in Block 5 renders the reason
   * itself rather than the sentence for one of these.
   */
  reason?: string;
}

export interface ImportParticipationsResult {
  /**
   * Rows WRITTEN, which is not the same as rows that count: import_participations
   * increments this for every row it records, refused ones included, and then
   * counts the refusals again in the three fields below. The entries that will
   * be in the draw are `recorded - duplicate - tooSoon - overLimit`, and a screen
   * that renders `recorded` as "entered" would overstate a file of repeats.
   */
  recorded: number;
  duplicate: number;
  tooSoon: number;
  overLimit: number;
  skipped: number;
  membersCreated: number;
  rows: ImportRowOutcome[];
}

function asCount(value: unknown, field: string): number {
  if (typeof value !== 'number') {
    throw new InternalError(`import_participations returned no ${field}`);
  }
  return value;
}

function parseImportResult(data: unknown): ImportParticipationsResult {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw new InternalError('import_participations returned an unexpected shape');
  }
  const result = data as Record<string, unknown>;
  if (!Array.isArray(result.rows)) {
    throw new InternalError('import_participations returned no per-row outcomes');
  }
  return {
    recorded: asCount(result.recorded, 'recorded'),
    duplicate: asCount(result.duplicate, 'duplicate'),
    tooSoon: asCount(result.too_soon, 'too_soon'),
    overLimit: asCount(result.over_limit, 'over_limit'),
    skipped: asCount(result.skipped, 'skipped'),
    membersCreated: asCount(result.members_created, 'members_created'),
    // Every field below is checked rather than defaulted. A missing line number
    // would otherwise render as "line 0" — a line the operator can look for in
    // their file and never find — and an unrecognised outcome falling back to
    // "recorded" would report a row as entered that the RPC skipped, which is
    // the one direction a wrong answer here must not go.
    rows: result.rows.map((raw) => {
      const row = raw as Record<string, unknown>;
      if (typeof row.line !== 'number') {
        throw new InternalError('import_participations returned a row with no line number');
      }
      if (row.outcome !== 'recorded' && row.outcome !== 'skipped') {
        throw new InternalError(
          `import_participations returned an unrecognised outcome: ${String(row.outcome)}`,
        );
      }
      return {
        line: row.line,
        outcome: row.outcome,
        status:
          row.outcome === 'recorded' ? asStatus(row.status, 'import_participations') : undefined,
        reason: typeof row.reason === 'string' ? row.reason : undefined,
      };
    }),
  };
}

/**
 * One call for the whole file (design spec D6): it writes what it can and
 * reports what it skipped, with the line number and the reason. There is no
 * preview-and-confirm stage and no per-row round trip.
 *
 * The CPF is hashed HERE, in Node, before a value reaches an RPC argument —
 * 0031's rule, because an argument passed to an RPC lands in query logs and in
 * backups, and 0054's own comment restates it for this function in particular.
 * hashCpf and cpfLastDigits come from services/members.ts rather than being
 * re-derived, so the digits this import deduplicates on are the same digits the
 * audience screen registered.
 */
export async function importParticipations(
  promotionId: string,
  rows: ImportRowInput[],
  accessToken: string,
): Promise<ImportParticipationsResult> {
  const { data, error } = await asCaller(accessToken).rpc('import_participations', {
    p_promotion_id: promotionId,
    p_rows: rows.map((row) => ({
      line: row.line,
      full_name: row.fullName,
      phone: row.phone,
      cpf_hash: row.cpf ? hashCpf(row.cpf) : undefined,
      cpf_last_digits: row.cpf ? cpfLastDigits(row.cpf) : undefined,
      participated_at: row.participatedAt,
    })),
  });
  if (error) throw mapParticipationError(error.code, error.message);
  return parseImportResult(data);
}

/**
 * Built in the shape of mapPromotionError, but NOT copied from it: every code
 * below was read off a `raise` in 0054 or off a constraint 0054's writes can
 * trip, and two of them are not in the four the plan named. An unmapped code
 * falls through to InternalError, which shows an operator a sentence written for
 * a developer and logs their mistake as ours.
 *
 * - `22023` is every validation and state refusal on the way in: a cancelled
 *   promotion, a promotion outside its window (apply_participation), and — from
 *   the resolution path both doors share — create_member's blank name and
 *   find_member_by_identifier's "give at least one identifier". Their messages
 *   are already sentences, so they pass straight through.
 * - `P0002` is a stale id: the promotion, the Station, a listener this Station
 *   is not linked to, or an answer naming a question from another promotion.
 *   Not a permission refusal — telling somebody they lack permission for a
 *   record that no longer exists sends them to fix the wrong thing.
 * - `42501` is has_permission failing inside a SECURITY DEFINER body, already
 *   logged server-side. Three different codes reach it here:
 *   participations.create on the manual door, and participations.import AND
 *   members.create on the import (D10), the second of which is checked before
 *   the first row is written rather than halfway through.
 * - `23505` has two sources and one verdict. 0031's per-Organization unique
 *   indexes refuse a listener whose phone, e-mail, CPF or passport already
 *   belongs to somebody — create_member rewrites that into a sentence naming the
 *   field categories. And participations_one_per_member (0052) refuses the
 *   second valid entry for a pair when the advisory lock did not serialise them,
 *   which is the second line of defence the lock is measured against; its
 *   message is Postgres's own and names the index rather than reading as a
 *   sentence. ConflictError is right for both: retry-as-is is wrong, and the
 *   caller has to look at what collided.
 *
 * Two codes the plan's list did not name, both found by reading 0052 and 0054
 * against each other rather than by trusting the template:
 *
 * - `23503` is participation_answers_option_fk: an answer naming an option that
 *   belongs to a DIFFERENT question. The design spec lists that refusal as part
 *   of the contract (§5), and apply_participation does not pre-check it — it
 *   pre-checks only that the QUESTION belongs to the promotion — so the answer
 *   is inserted and the composite foreign key refuses it with a bare constraint
 *   name. Unmapped it is a 500 for a refusal the spec promised. BusinessRuleError
 *   rather than ValidationError because the shape of the request was fine and
 *   the combination of two real ids was not, which is the same reading
 *   mapMemberError gives 23503.
 * - `23514` is participation_answers_shape: written text on a question that has
 *   options, an option on an essay, or an essay whose text is blank.
 *   participationFormSchema refuses all three first, so reaching this means a
 *   caller bypassed the form. The message names a constraint rather than being a
 *   sentence, and mislabelling it would hide that — the same verdict and the
 *   same wording mapPromotionError gives its own 23514.
 *
 * - `22P02` is a value that does not parse as the type it is compared or cast
 *   against, and unlike the two above it has a live path that needs no bypass
 *   at all: decodeCursor accepts any non-empty string as a cursor's id, so a
 *   hand-edited `?after=` on the list read reaches Postgres as
 *   `id.lt."abc"` and comes back with this code (reproduced against the running
 *   stack). The RPCs reach it too, through `(v_answer ->> 'option_id')::uuid`
 *   and `(v_row ->> 'line')::integer`. ValidationError, for the reason
 *   mapMemberError gives its own 22P02: the value is wrong, not the request,
 *   and not a server fault.
 * - `22007` is the same verdict for the one datetime cast, `(v_row ->>
 *   'participated_at')::timestamptz`. importRowSchema refuses an unreadable
 *   instant before a request is sent, so this is the forward-looking half of the
 *   pair rather than a live path — mapped anyway, because the schema is one
 *   caller of this function and not a guarantee about all of them.
 * - Anything else is ours, not the caller's.
 */
function mapParticipationError(code: string | undefined, message: string): Error {
  if (code === '22023') return new ValidationError(message);
  if (code === 'P0002') return new NotFoundError(message);
  if (code === '42501') return new UnauthorizedError(message);
  if (code === '23505') return new ConflictError(message);
  if (code === '23503') return new BusinessRuleError(message);
  if (code === '23514') return new BusinessRuleError(message);
  if (code === '22P02') return new ValidationError(message);
  if (code === '22007') return new ValidationError(message);
  return new InternalError(message);
}
