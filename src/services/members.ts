import 'server-only';
import { createHash } from 'node:crypto';
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
import type { Database } from '@/lib/supabase/database.types';
import type {
  AddMemberNoteInput,
  BlockMemberInput,
  CreateMemberInput,
  LiftMemberBlockInput,
  LinkMemberToCompanyInput,
  RecordMemberConsentInput,
  UpdateMemberInput,
} from '@/schemas/members';

export type MemberConsentType = Database['public']['Enums']['member_consent_type'];
export type MemberBlockKind = Database['public']['Enums']['member_block_kind'];
export type MemberErasureReason = Database['public']['Enums']['member_erasure_reason'];

/**
 * A client bound to the caller's JWT. Every RPC in 0033/0034 re-checks the
 * caller's own permission against auth.uid() inside a SECURITY DEFINER (or,
 * for member_reachable, SECURITY INVOKER) body, so calling one with the
 * service key would defeat the check it exists to make — the same reasoning
 * services/inventory.ts and services/roles.ts give for their own asCaller.
 */
function asCaller(accessToken: string) {
  const { url, anonKey } = getUserSupabaseConfig();
  return createClient<Database>(url, anonKey, {
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

// ---------------------------------------------------------------------------
// The CPF, hashed here and only here.
//
// The raw CPF must never reach the database (0031_members.sql's own comment
// on cpf_hash: "the raw number is stored nowhere and appears in no query
// log"; its cpf_hash CHECK, `~ '^[0-9a-f]{64}$'`, backs that structurally by
// refusing an eleven-digit raw CPF outright). This file hashes it in Node
// with node:crypto before a value ever reaches an RPC argument — exactly the
// same reasoning services/invitations.ts gives for hashing an invitation
// token client-side: an argument passed to an RPC lands in query logs and in
// backups, so the value that must never appear there must never be sent.
// ---------------------------------------------------------------------------

/** Digits only. "123.456.789-09" and "12345678909" both normalise to the same string. */
export function normalizeCpf(rawCpf: string): string {
  return rawCpf.replace(/[^0-9]/g, '');
}

/**
 * SHA-256 of the normalised CPF. Two spellings of the same number therefore
 * hash identically — the equality 0031's cpf_hash unique index (and
 * find_member_by_identifier, 0033) depends on to deduplicate at all.
 */
export function hashCpf(rawCpf: string): string {
  return createHash('sha256').update(normalizeCpf(rawCpf)).digest('hex');
}

/** The last three digits — cpf_last_digits' own format (0031): what a person confirms out loud. */
export function cpfLastDigits(rawCpf: string): string {
  return normalizeCpf(rawCpf).slice(-3);
}

function toDateOnly(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export interface FindMemberByIdentifierInput {
  organizationId: string;
  phone?: string;
  email?: string;
  /** Raw CPF — hashed here before the RPC ever sees it, same as create/updateMember. */
  cpf?: string;
  passport?: string;
}

/**
 * The three, and only three, answers 0033_member_dedup.sql's function is
 * allowed to give (spec §4): no match; a match the caller may see, with its
 * id; a match the caller may not see, with nothing else. The union type is
 * what makes a caller that reaches into the `elsewhere` branch for a
 * `memberId` that was never returned a compile error instead of `undefined`
 * discovered at runtime.
 */
export type FindMemberByIdentifierResult =
  | { outcome: 'none' }
  | { outcome: 'visible'; memberId: string }
  | { outcome: 'elsewhere' };

function parseFindMemberByIdentifierResult(data: unknown): FindMemberByIdentifierResult {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw new InternalError('find_member_by_identifier returned an unexpected shape');
  }
  const row = data as Record<string, unknown>;
  if (row.outcome === 'none') return { outcome: 'none' };
  if (row.outcome === 'elsewhere') return { outcome: 'elsewhere' };
  if (row.outcome === 'visible') {
    if (typeof row.member_id !== 'string') {
      throw new InternalError('find_member_by_identifier returned "visible" with no member_id');
    }
    return { outcome: 'visible', memberId: row.member_id };
  }
  throw new InternalError(
    `find_member_by_identifier returned an unrecognised outcome: ${String(row.outcome)}`,
  );
}

/**
 * The friendly, cross-visibility duplicate check (spec §4, 0033's own
 * comment: "the one place in this project that reads across the visibility
 * boundary by design"). A read, and its error is surfaced like any other —
 * a caller that cannot tell a failed lookup from a genuine "no match" would
 * register a duplicate believing it had already checked.
 */
export async function findMemberByIdentifier(
  input: FindMemberByIdentifierInput,
  accessToken: string,
): Promise<FindMemberByIdentifierResult> {
  const { data, error } = await asCaller(accessToken).rpc('find_member_by_identifier', {
    p_organization_id: input.organizationId,
    p_phone: input.phone,
    p_email: input.email,
    p_cpf_hash: input.cpf ? hashCpf(input.cpf) : undefined,
    p_passport: input.passport,
  });
  if (error) throw mapMemberError(error.code, error.message);
  return parseFindMemberByIdentifierResult(data);
}

/**
 * The actual is_member_blocked call, taking an already-built client rather
 * than an accessToken — split out (Task 8 review, Important 2) so a caller
 * that already holds a client for a batch of checks (listOrganizationMembers,
 * listMemberStations) can reuse it instead of paying asCaller's own
 * createClient cost on every single row. isMemberBlocked, below, is the
 * public one-off entry point and is unchanged for every existing caller.
 */
async function checkMemberBlocked(
  supabase: ReturnType<typeof asCaller>,
  memberId: string,
  companyId: string,
): Promise<boolean> {
  const { data, error } = await supabase.rpc('is_member_blocked', {
    p_member_id: memberId,
    p_company_id: companyId,
  });
  if (error) throw mapMemberError(error.code, error.message);
  return data;
}

/**
 * Whether an active block bars this Member at this Station right now
 * (is_member_blocked, 0032) — a block with a past ends_at no longer counts,
 * one with no ends_at always does, derived at read time rather than from a
 * status column nothing maintains. A read; its error is surfaced, not
 * swallowed into a false "not blocked".
 */
export async function isMemberBlocked(
  memberId: string,
  companyId: string,
  accessToken: string,
): Promise<boolean> {
  return checkMemberBlocked(asCaller(accessToken), memberId, companyId);
}

/**
 * Whether the caller holds p_permission at any Station this Member is linked
 * to (member_reachable, 0033) — admits the owner and the platform admin
 * outside the per-link check, so a Member whose only Station is archived is
 * not a permanent dead end. A read; its error is surfaced, not swallowed.
 */
export async function memberReachable(
  memberId: string,
  organizationId: string,
  permission: string,
  accessToken: string,
): Promise<boolean> {
  const { data, error } = await asCaller(accessToken).rpc('member_reachable', {
    p_member_id: memberId,
    p_organization_id: organizationId,
    p_permission: permission,
  });
  if (error) throw mapMemberError(error.code, error.message);
  return data;
}

// ---------------------------------------------------------------------------
// The two read screens (Task 8): the audience list and one listener's detail.
//
// Every function below reads through asCaller(accessToken), same as every
// other function in this file — members_select_reachable and its four
// sibling policies (0035_rls_members.sql) are what actually decide which
// rows come back, not anything in this file. A search term narrows the SQL
// `where` clause itself (listOrganizationMembers' own `.or(...)` below), so
// the audience a caller cannot reach is never fetched in order to be
// filtered away — it is never fetched at all.
// ---------------------------------------------------------------------------

export interface MemberListRow {
  id: string;
  fullName: string | null;
  phone: string | null;
  email: string | null;
  cpfLastDigits: string | null;
  birthDate: string | null;
  /**
   * Free text, and Block 3b's spec §7 is explicit that it will not stay: the
   * geography block replaces it with a link to a real place, or with nothing.
   * Shown as a column, never counted or filtered — `Campinas`, `campinas` and
   * `Campinas/SP` are three values today.
   */
  city: string | null;
  anonymizedAt: string | null;
  createdAt: string;
  /** True if an active block bars this row at any Station it is linked to that the caller can reach — see listOrganizationMembers' own comment. */
  blocked: boolean;
}

/** One page. Fifty is the plan's number; nothing else in this file depends on it. */
const PAGE_SIZE = 50;

/** The columns the audience table renders. Kept in one place: the row read and the count read must agree. */
const MEMBER_LIST_COLUMNS =
  'id, full_name, phone, email, cpf_last_digits, birth_date, city, anonymized_at, created_at';

/**
 * The same columns plus the join that makes "blocked only" a query condition.
 * The count read has to carry it too — a count taken without the join would
 * count every listener while the page showed only the blocked ones.
 */
const MEMBER_LIST_COLUMNS_WITH_BLOCKS = `${MEMBER_LIST_COLUMNS}, member_blocks!inner(id)` as const;

/**
 * The one bound on a search term's length, exported so page.tsx enforces the
 * SAME number rather than a hand-copied literal that could silently drift
 * from this one (Task 8 re-review) — a caller-controlled URL query parameter
 * is otherwise unbounded, and a query string this long has no legitimate use
 * before it ever reaches listOrganizationMembers below.
 */
export const MEMBER_SEARCH_MAX_LENGTH = 100;

/**
 * Re-exported from src/lib/postgrest.ts, the one shared implementation of
 * this escaping rule (also used by src/lib/keyset.ts for cursor values) —
 * so tests/unit/member-search-filter.test.ts and every other existing
 * import of `quoteForOrFilter` from this module keep working unchanged. The
 * search clauses built below (full_name, phone, email, cpf_last_digits, and
 * — since whole-branch review I2 — phone_normalized) are exactly why a
 * search term matching one of them must not be able to break out of the
 * quoting it is wrapped in; see src/lib/postgrest.ts for the escaping
 * itself. Exported for its own unit test — a small, pure, security-relevant
 * function taking untrusted input is worth testing directly rather than
 * only through a query nothing but a live database can execute.
 */
export { escapeLikePattern, quoteForOrFilter };


export type MemberSortKey = 'name' | 'created';

export interface MemberListParams {
  organizationId: string;
  search?: string;
  sort: MemberSortKey;
  direction: SortDirection;
  cursor: Cursor | null;
  /**
   * Which side of `cursor` to read. 'before' walks one page back — the same
   * query read in the opposite direction with the rows turned around
   * afterwards, so Previous costs exactly what Next costs. Ignored when
   * `cursor` is null, where "the page before the first page" means nothing.
   */
  cursorSide: 'after' | 'before';
  /** Inclusive, in years, converted to a birth_date range — never an age computed per row. */
  ageMin?: number;
  ageMax?: number;
  /** Blocked only. There is no "not blocked" option — see the note in the body. */
  blockedOnly?: boolean;
  /** Filters on the LATEST rules consent, which costs the total — see the note in the body. */
  hasRulesConsent?: boolean;
  /**
   * The gender block. One of the three stored codes, or 'none' for listeners
   * with no answer recorded — a distinct population from 'N', which is
   * somebody who was asked and declined.
   */
  gender?: string;
  /** Instants, not calendar days: members-filters.tsx converts the operator's chosen dates in the browser. */
  registeredFrom?: string;
  registeredTo?: string;
}

export interface MemberListPage {
  rows: MemberListRow[];
  nextCursor: string | null;
  previousCursor: string | null;
  /**
   * Exact, or null. Null means "not counted", which happens only under the
   * rules-consent filter: that one is applied after the page is fetched, so
   * no count taken here could describe what the screen actually shows. The
   * screen renders no number at all in that case rather than a number that
   * would be wrong — spec §2's own rule.
   */
  total: number | null;
}

/** The row shape the two reads below share. The embedded-join variant carries extra keys this ignores. */
interface MemberListRecord {
  id: string;
  full_name: string | null;
  phone: string | null;
  email: string | null;
  cpf_last_digits: string | null;
  birth_date: string | null;
  city: string | null;
  anonymized_at: string | null;
  created_at: string;
}

/**
 * Today, minus `years`, as a date-only string — the birth_date of somebody
 * turning exactly `years` today. Computed in UTC off the SERVER's clock, so
 * an age boundary can sit a calendar day out for a few hours a day for an
 * operator east or west of UTC. That is the same class of gap Block 3
 * disclosed for formatDate, and unlike the block-expiry instant (whole-branch
 * review C1, where three hours changed whether a listener was barred) a day's
 * slack on an age band changes who appears in a demographic count, not
 * whether anyone is barred from anything.
 *
 * 29 February is carried to 1 March in a non-leap year, which is what
 * Date.UTC does with an out-of-range day and the convention most of this
 * product's neighbours use.
 */
function isoDateYearsAgo(years: number): string {
  const today = new Date();
  return new Date(
    Date.UTC(today.getUTCFullYear() - years, today.getUTCMonth(), today.getUTCDate()),
  )
    .toISOString()
    .slice(0, 10);
}

/**
 * The block state for one page, in one call per distinct Station rather than
 * one call per listener per Station.
 *
 * The semantics are the ones the screen already had and the badge already
 * means: blocked at ANY Station this listener is linked to that the caller can
 * reach. member_company_links' own RLS policy (0035) narrows the link read to
 * exactly that set, so the grouping below never asks about a Station the
 * caller cannot reach — which is also what keeps members_blocked_bulk's caller
 * guard (0036) from refusing the whole page.
 *
 * This deliberately does NOT collapse the question to a single Station. The
 * plan's Task 4 sketched one `companyId` per page, but this screen lists the
 * audience across every Station the caller reaches and shows no Station
 * column: a badge that answered for one Station while the rows came from
 * several would read as "not blocked" for somebody who is. The bulk predicate
 * is per-Station by design (its guard is checked once for the one Station a
 * batch concerns), so the fan-out is over Stations — one to three in this
 * product's real shape, and at most the number the caller can reach — instead
 * of over the fifty rows.
 */
async function blockStateForPage(
  supabase: ReturnType<typeof asCaller>,
  memberIds: readonly string[],
): Promise<Map<string, boolean>> {
  const blocked = new Map<string, boolean>(memberIds.map((id) => [id, false]));
  if (memberIds.length === 0) return blocked;

  const { data: links, error } = await supabase
    .from('member_company_links')
    .select('member_id, company_id')
    .in('member_id', [...memberIds]);
  if (error) throw mapMemberError(error.code, error.message);

  const membersByCompany = new Map<string, string[]>();
  for (const link of links ?? []) {
    const batch = membersByCompany.get(link.company_id) ?? [];
    batch.push(link.member_id);
    membersByCompany.set(link.company_id, batch);
  }

  const answers = await Promise.all(
    [...membersByCompany].map(async ([companyId, batch]) => {
      const { data, error: bulkError } = await supabase.rpc('members_blocked_bulk', {
        p_member_ids: batch,
        p_company_id: companyId,
      });
      if (bulkError) throw mapMemberError(bulkError.code, bulkError.message);
      return data ?? [];
    }),
  );

  for (const rows of answers) {
    for (const row of rows) if (row.blocked) blocked.set(row.member_id, true);
  }
  return blocked;
}

/**
 * Whether the LATEST rules consent on record for each listed Member is a
 * grant. member_consents is append-only (0032): a withdrawal is a new row, so
 * a listener who consented and then withdrew has both, and "a granted row
 * exists" is a different — wrong — question.
 *
 * Two honest limits. The rows this reads are the ones RLS shows the caller,
 * and member_consents is visible only at the Station that recorded it
 * (0035), so this answers "the latest rules consent YOU can see", exactly as
 * the listener's own detail screen does. And two rows sharing a granted_at
 * are ordered by id, which is arbitrary though stable — granted_at is the
 * only ordering this table records.
 */
async function latestRulesConsent(
  supabase: ReturnType<typeof asCaller>,
  memberIds: readonly string[],
): Promise<Map<string, boolean>> {
  const latest = new Map<string, boolean>();
  if (memberIds.length === 0) return latest;

  const { data, error } = await supabase
    .from('member_consents')
    .select('member_id, granted, granted_at, id')
    .in('member_id', [...memberIds])
    .eq('consent_type', 'rules')
    .order('granted_at', { ascending: false })
    .order('id', { ascending: false });
  if (error) throw mapMemberError(error.code, error.message);

  for (const row of data ?? []) {
    if (!latest.has(row.member_id)) latest.set(row.member_id, row.granted);
  }
  return latest;
}

/**
 * The audience list, one keyset page at a time (Block 3b).
 *
 * Filters, sort and cursor are all conditions Postgres evaluates: nothing is
 * fetched here in order to be thrown away, with one disclosed exception (the
 * rules-consent filter). RLS — members_select_reachable and its siblings,
 * 0035 — is what decides which rows exist for this caller at all; nothing
 * here narrows that, and nothing here widens it.
 *
 * `search` becomes an `.or(...)` Postgres evaluates itself: full_name, phone
 * and email by substring, plus — when the term carries digits —
 * cpf_last_digits and phone_normalized (0031's generated, digits-only column,
 * the identity this block's dedup and RLS both rest on, and what lets an
 * operator find "+55 (11) 98765-4321" by typing the digits off caller ID;
 * whole-branch review I2). Verified against the running PostgREST rather than
 * assumed: two `or=` parameters on one request are ANDed, so the search
 * clause and the keyset clause narrow together instead of one replacing the
 * other.
 *
 * "Blocked only" is a condition on the query — an inner join to member_blocks
 * restricted to the active window — so a filtered page still fills and the
 * total still counts. There is deliberately no "not blocked" option: its
 * negation cannot be expressed the same way, and spec §6 asks for exactly the
 * positive one.
 *
 * The block state each row displays costs one members_blocked_bulk call
 * (0036) per distinct Station on the page, not one is_member_blocked call per
 * listener per Station.
 */
export async function listOrganizationMembers(
  params: MemberListParams,
  accessToken: string,
): Promise<MemberListPage> {
  const supabase = asCaller(accessToken);

  const column = params.sort === 'name' ? 'full_name' : 'created_at';
  // full_name is nullable; created_at is not. The null region only exists for one of them.
  const nullable = column === 'full_name';

  const walkingBack = params.cursorSide === 'before' && params.cursor !== null;
  const ascending = walkingBack ? params.direction === 'desc' : params.direction === 'asc';
  const readDirection: SortDirection = ascending ? 'asc' : 'desc';
  // No `nullsFirst` is sent below, so Postgres' own default applies: ASC puts
  // NULLs last, DESC puts them first. keysetFilter is told the same thing —
  // a cursor whose null handling disagrees with the ordering it resumes
  // strands every row on the far side of the null boundary, silently, because
  // the pages still load and the total still looks right.
  const nullsLast = nullable && ascending;

  const now = new Date().toISOString();
  const select = params.blockedOnly ? MEMBER_LIST_COLUMNS_WITH_BLOCKS : MEMBER_LIST_COLUMNS;

  const build = (options?: { count: 'exact'; head: true }) => {
    let q = supabase
      .from('members')
      .select(select, options)
      .eq('organization_id', params.organizationId)
      .is('deleted_at', null);

    if (params.blockedOnly) {
      // `!inner` in the select turns the embed into a join, so these three
      // conditions on the child rows narrow the PARENT set: a listener with
      // no block row inside the active window does not come back at all.
      // Same active-window test members_blocked_bulk applies (0036) and the
      // same one is_member_blocked has always applied (0032) — lifted_at
      // null, started, not yet ended — evaluated here through RLS, which
      // shows the caller only the blocks they may read (0035).
      q = q
        .is('member_blocks.lifted_at', null)
        .lte('member_blocks.starts_at', now)
        .or(`ends_at.is.null,ends_at.gt.${now}`, { referencedTable: 'member_blocks' });
    }

    // An age band is a birth_date range. Computing an age per row in the
    // WHERE clause would defeat members_birth_date_idx (0036) and scan the
    // whole Organization. `gt`, not `gte`, on the upper bound: somebody born
    // exactly ageMax + 1 years ago today has had that birthday, so they are
    // outside the band.
    if (params.ageMax !== undefined) q = q.gt('birth_date', isoDateYearsAgo(params.ageMax + 1));
    if (params.ageMin !== undefined) q = q.lte('birth_date', isoDateYearsAgo(params.ageMin));

    // The gender block. A plain equality on an indexed-by-nothing column, and
    // deliberately not given an index of its own: three values over a whole
    // Organization is not selective enough for one to be read, and the query
    // is already bounded by organization_id. The day this filter is combined
    // with a campaign over hundreds of thousands of listeners is the day to
    // measure it, not before.
    //
    // `is('gender', null)` FOR 'none', NOT `eq`: SQL equality against null is
    // null, so an `eq` here would return nothing at all and read on screen as
    // "no listener has been left unasked" — the most misleading possible
    // answer to the one filter that exists to find them.
    if (params.gender === 'none') q = q.is('gender', null);
    else if (params.gender) q = q.eq('gender', params.gender);

    if (params.registeredFrom) q = q.gte('created_at', params.registeredFrom);
    if (params.registeredTo) q = q.lte('created_at', params.registeredTo);

    // Bounded again here (the page trims to MEMBER_SEARCH_MAX_LENGTH before
    // this is ever called) — a service function's own arguments should not
    // depend on a caller upstream having remembered a bound for it. The same
    // exported constant, not a second hand-copied number, so the two cannot
    // drift apart (Block 3, Task 8 re-review).
    const term = params.search?.trim().slice(0, MEMBER_SEARCH_MAX_LENGTH);
    if (term) {
      // escapeLikePattern runs BEFORE the %...% wildcard markers are added,
      // so it only ever escapes what the caller typed, never the markers this
      // function adds itself.
      const wildcard = quoteForOrFilter(`%${escapeLikePattern(term)}%`);
      const clauses = [
        `full_name.ilike.${wildcard}`,
        `phone.ilike.${wildcard}`,
        `email.ilike.${wildcard}`,
      ];
      // Digits only: cpf_last_digits (0031) is always exactly three digits,
      // so a term carrying no digit at all (a name search) has nothing
      // meaningful to compare against it. A digit-only string can never
      // contain % or _, so escapeLikePattern would be a no-op here — skipped,
      // not forgotten.
      const digits = term.replace(/[^0-9]/g, '');
      if (digits) {
        clauses.push(`cpf_last_digits.ilike.${quoteForOrFilter(`%${digits}%`)}`);
        clauses.push(`phone_normalized.ilike.${quoteForOrFilter(`%${digits}%`)}`);
      }
      q = q.or(clauses.join(','));
    }

    return q;
  };

  let query = build().order(column, { ascending });
  if (params.cursor) {
    query = query.or(keysetFilter(column, readDirection, params.cursor, nullsLast));
  }
  // The tiebreak, on every ordering without exception: two listeners sharing
  // a name (or a registration instant) make an ordering without it skip or
  // repeat rows between pages.
  query = query.order('id', { ascending });

  const { data, error } = await query.limit(PAGE_SIZE + 1);
  if (error) throw mapMemberError(error.code, error.message);

  // One cast, because `select` is chosen between two constants above and
  // PostgREST cannot type a runtime choice. Both constants list the same
  // columns; the blocked-only one adds an embedded array this never reads.
  const fetched = (data ?? []) as unknown as MemberListRecord[];

  // Cursors come from the page as FETCHED, before the consent filter below
  // drops anything: a cursor is a position in the ordering, and taking it
  // from a filtered row would skip everything between it and the row that
  // was actually last.
  const { rows: page, nextCursor, previousCursor } = keysetPage(fetched, {
    pageSize: PAGE_SIZE,
    walkingBack,
    hadCursor: params.cursor !== null,
    cursorFor: (row) => ({
      value: column === 'full_name' ? row.full_name : row.created_at,
      id: row.id,
    }),
  });

  // Skipped entirely under the consent filter: a count of what the query
  // returned would not describe what the screen shows, and this saves the
  // round trip rather than spending it on a number nobody may see.
  let total: number | null = null;
  if (params.hasRulesConsent === undefined) {
    const { count, error: countError } = await build({ count: 'exact', head: true });
    if (countError) throw mapMemberError(countError.code, countError.message);
    total = count ?? 0;
  }

  let rows = page;
  if (params.hasRulesConsent !== undefined) {
    const consent = await latestRulesConsent(
      supabase,
      page.map((r) => r.id),
    );
    // A listener with no rules consent at all counts as not consented, which
    // is what makes "lacking rules consent" a usable chase list.
    rows = page.filter((r) => (consent.get(r.id) ?? false) === params.hasRulesConsent);
  }

  const blocked = await blockStateForPage(
    supabase,
    rows.map((r) => r.id),
  );

  return {
    rows: rows.map((m) => ({
      id: m.id,
      fullName: m.full_name,
      phone: m.phone,
      email: m.email,
      cpfLastDigits: m.cpf_last_digits,
      birthDate: m.birth_date,
      city: m.city,
      anonymizedAt: m.anonymized_at,
      createdAt: m.created_at,
      blocked: blocked.get(m.id) ?? false,
    })),
    nextCursor,
    previousCursor,
    total,
  };
}

export interface MemberDetail {
  id: string;
  fullName: string | null;
  phone: string | null;
  email: string | null;
  cpfLastDigits: string | null;
  passport: string | null;
  birthDate: string | null;
  addressLine: string | null;
  addressNumber: string | null;
  addressComplement: string | null;
  neighbourhood: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
  country: string | null;
  /** 'M', 'F' or 'N' (0220). Null is a FOURTH state: nobody has asked. */
  gender: string | null;
  discoverySource: string | null;
  firstContactAt: string | null;
  firstContactOrigin: string | null;
  anonymizedAt: string | null;
  createdAt: string;
}

/**
 * One listener's identity. Returns null rather than throwing NotFoundError
 * when the row is absent — archived (members_select_reachable's own
 * `deleted_at is null`, 0035) and genuinely-never-existed both come back as
 * "no row" from PostgREST, and a Member the caller cannot reach (linked to no
 * Station they hold members.view in) is indistinguishable from either at this
 * layer, by design: the RLS policy is the boundary, and it does not leak
 * which of the three actually happened. A `memberId` that is not even a
 * well-formed UUID (a hand-edited URL, a stale bookmark) is folded into the
 * same null (Task 8 review) rather than left to throw InternalError —
 * verified live against the local stack: `.eq('id', 'not-a-uuid')` returns
 * `{ code: '22P02', message: 'invalid input syntax for type uuid: ...' }`,
 * Postgres's own "this was never going to match", not a database fault.
 */
export async function getMember(memberId: string, accessToken: string): Promise<MemberDetail | null> {
  // A single string literal, not built by concatenation: supabase-js infers
  // the returned row's shape by parsing this argument's literal TYPE at
  // compile time, so a runtime-assembled string collapses every field below
  // to GenericStringError instead of its real column type.
  const { data, error } = await asCaller(accessToken)
    .from('members')
    .select(
      'id, full_name, phone, email, cpf_last_digits, passport, birth_date, gender, address_line, address_number, address_complement, neighbourhood, city, state, postal_code, country, discovery_source, first_contact_at, first_contact_origin, anonymized_at, created_at',
    )
    .eq('id', memberId)
    .is('deleted_at', null)
    .maybeSingle();
  if (error) {
    if (error.code === '22P02') return null;
    throw new InternalError(`Could not read this listener: ${error.message}`);
  }
  if (!data) return null;
  return {
    id: data.id,
    fullName: data.full_name,
    phone: data.phone,
    email: data.email,
    cpfLastDigits: data.cpf_last_digits,
    passport: data.passport,
    birthDate: data.birth_date,
    addressLine: data.address_line,
    addressNumber: data.address_number,
    addressComplement: data.address_complement,
    neighbourhood: data.neighbourhood,
    city: data.city,
    state: data.state,
    postalCode: data.postal_code,
    country: data.country,
    gender: data.gender,
    discoverySource: data.discovery_source,
    firstContactAt: data.first_contact_at,
    firstContactOrigin: data.first_contact_origin,
    anonymizedAt: data.anonymized_at,
    createdAt: data.created_at,
  };
}

/**
 * Block 30a. One whole value, and an audit row written by the door.
 *
 * Thin on purpose: every rule -- which Station decides, which field names are
 * legal, the FOR SHARE against a racing erasure -- is reveal_member_field's
 * (0253), and a second copy here would be a second thing to keep in step.
 */
export async function revealMemberField(
  memberId: string,
  field: 'phone' | 'email' | 'passport' | 'address',
  accessToken: string,
): Promise<string | null> {
  const { data, error } = await asCaller(accessToken).rpc('reveal_member_field', {
    p_member_id: memberId,
    p_field: field,
  });
  if (error) throw mapMemberError(error.code, error.message);
  return data ?? null;
}

/** The four members columns Block 29d-2's campaign screen needs to build a recipient's variable values and address -- see getMembersForCampaign's own header. */
export interface CampaignRecipientDetail {
  fullName: string | null;
  city: string | null;
  phoneNormalized: string | null;
  emailNormalized: string | null;
}

/**
 * Block 29d-2, Task 7 addendum §1 and §3. Reads full_name, city and both
 * normalised addresses for a batch of ids, under members_select_reachable's
 * own RLS (0035: `members.view` at some Station this listener is linked to,
 * or the platform admin, or the Organization's owner) -- the SAME permission
 * the addendum names as what the create-campaign action needs and the door
 * (0243) deliberately does not have: "reading a listener's phone or e-mail
 * needs members.view -- which the operator has and the door does not."
 *
 * A caller lacking members.view for some of `memberIds` gets a Map missing
 * exactly those entries, never a thrown error and never a fabricated row --
 * RLS only ever hides a real row here, the same trade filterMemberIdsLinkedToStation
 * (services/send-lists.ts) accepts for its own read of member_company_links.
 * The campaign action reads this Map with `.get(id)`, so a missing entry
 * becomes a recipient with no resolved address and no resolved variables --
 * exactly the existing `no_address` outcome the drain (services/campaigns.ts)
 * already settles a WHATSAPP row with no phone on file as, not a new failure
 * mode this file invents.
 *
 * `phone_normalized`/`email_normalized`, not the raw `phone`/`email` columns:
 * the same generated, digits-only / lower-cased-and-trimmed values
 * enqueue_pickup_reminder (0112) already sends WhatsApp template messages to
 * (`m.phone_normalized`, read directly as the outbound `to`), so a campaign's
 * own address resolution agrees with the one other place in this codebase
 * that already resolves a listener's address for an outbound send.
 */
export async function getMembersForCampaign(
  memberIds: string[],
  accessToken: string,
): Promise<Map<string, CampaignRecipientDetail>> {
  if (memberIds.length === 0) return new Map();

  // CHUNKED, the same 200-per-request bound and the same reason
  // filterMemberIdsLinkedToStation (services/send-lists.ts) already chunks
  // its own `.in()` read: memberIds here can be up to RESOLVE_CAP (10,000) --
  // a LIVING list's whole eligible audience, in the spec's own twenty-
  // thousand-recipient example -- and a single GET carrying that many UUIDs
  // is not a PostgREST request this project has anywhere else asked a URL to
  // carry. 200 is the same constant, not a second number to keep in step
  // with the first.
  const CHUNK = 200;
  const rows: {
    id: string;
    full_name: string | null;
    city: string | null;
    phone_normalized: string | null;
    email_normalized: string | null;
  }[] = [];
  const client = asCaller(accessToken);

  for (let i = 0; i < memberIds.length; i += CHUNK) {
    const chunk = memberIds.slice(i, i + CHUNK);
    const { data, error } = await client
      .from('members')
      .select('id, full_name, city, phone_normalized, email_normalized')
      .in('id', chunk);
    if (error) {
      throw new InternalError(`Could not read listener details for a campaign: ${error.message}`);
    }
    rows.push(...(data ?? []));
  }

  return new Map(
    rows.map((row) => [
      row.id,
      {
        fullName: row.full_name,
        city: row.city,
        phoneNormalized: row.phone_normalized,
        emailNormalized: row.email_normalized,
      },
    ]),
  );
}

export interface MemberConsentRow {
  id: string;
  companyId: string;
  consentType: MemberConsentType;
  granted: boolean;
  grantedAt: string;
  origin: string | null;
  promotionId: string | null;
}

/** Every consent recorded at a Station the caller can reach (member_consents_select_reachable, 0035), newest first. */
export async function listMemberConsents(
  memberId: string,
  accessToken: string,
): Promise<MemberConsentRow[]> {
  const { data, error } = await asCaller(accessToken)
    .from('member_consents')
    .select('id, company_id, consent_type, granted, granted_at, origin, promotion_id')
    .eq('member_id', memberId)
    .order('granted_at', { ascending: false });
  if (error) throw new InternalError(`Could not read this listener's consents: ${error.message}`);
  return (data ?? []).map((c) => ({
    id: c.id,
    companyId: c.company_id,
    consentType: c.consent_type,
    granted: c.granted,
    grantedAt: c.granted_at,
    origin: c.origin,
    promotionId: c.promotion_id,
  }));
}

export interface MemberNoteRow {
  id: string;
  companyId: string;
  body: string | null;
  createdAt: string;
}

/**
 * Every note recorded at a Station the caller can reach
 * (member_notes_select_reachable, 0035), newest first. `body` is null only
 * for a note anonymize_member has scrubbed (0034, Ruling B) — the row, its
 * Station, its date and its author survive; the free text does not.
 */
export async function listMemberNotes(memberId: string, accessToken: string): Promise<MemberNoteRow[]> {
  const { data, error } = await asCaller(accessToken)
    .from('member_notes')
    .select('id, company_id, body, created_at')
    .eq('member_id', memberId)
    .order('created_at', { ascending: false });
  if (error) throw new InternalError(`Could not read this listener's notes: ${error.message}`);
  return (data ?? []).map((n) => ({
    id: n.id,
    companyId: n.company_id,
    body: n.body,
    createdAt: n.created_at,
  }));
}

export interface MemberBlockRow {
  id: string;
  companyId: string | null;
  kind: MemberBlockKind;
  reason: string | null;
  startsAt: string;
  endsAt: string | null;
  liftedAt: string | null;
  liftedBy: string | null;
  liftReason: string | null;
}

/**
 * Every block ever recorded against this listener that the caller can reach
 * (member_blocks_select_reachable, 0035 — a Station-scoped row at a Station
 * the caller holds members.view in, or an Organization-wide row the caller
 * both holds members.view somewhere for AND can reach this listener through),
 * newest first. A plain history read: whether a given row is CURRENTLY in
 * effect is deliberately not computed here by re-deriving is_member_blocked's
 * own date-window logic (lifted_at is null and starts_at <= now() and
 * (ends_at is null or ends_at > now()), 0032) — a hand-copy of that window
 * risks disagreeing with the real predicate, which is exactly the failure
 * mode this comment's own file already warns against for
 * normalize_phone/normalize_email (0031). Screens that need "is this listener
 * blocked right now" call isMemberBlocked instead, which is this same file's
 * existing wrapper around the real function.
 */
export async function listMemberBlocks(memberId: string, accessToken: string): Promise<MemberBlockRow[]> {
  const { data, error } = await asCaller(accessToken)
    .from('member_blocks')
    .select('id, company_id, kind, reason, starts_at, ends_at, lifted_at, lifted_by, lift_reason')
    .eq('member_id', memberId)
    .order('starts_at', { ascending: false });
  if (error) throw new InternalError(`Could not read this listener's block history: ${error.message}`);
  return (data ?? []).map((b) => ({
    id: b.id,
    companyId: b.company_id,
    kind: b.kind,
    reason: b.reason,
    startsAt: b.starts_at,
    endsAt: b.ends_at,
    liftedAt: b.lifted_at,
    liftedBy: b.lifted_by,
    liftReason: b.lift_reason,
  }));
}

export interface MemberStationRow {
  companyId: string;
  companyName: string;
  linkedAt: string;
  /** is_member_blocked(memberId, companyId) — true regardless of whether the active block is scoped to this Station specifically or applies Organization-wide. */
  blocked: boolean;
}

/**
 * The Stations this listener took part in THAT THE CALLER CAN REACH — spec's
 * own load-bearing clause. member_company_links_select_reachable (0035)
 * already does the narrowing: a link at a Station the caller holds
 * members.view in comes back, any other link on the same listener simply
 * does not exist as far as this query is concerned. Nothing here works
 * around that to "complete" a short list — a short list IS the correct
 * answer when the caller cannot reach every Station this listener has ever
 * been linked to.
 */
export async function listMemberStations(
  memberId: string,
  accessToken: string,
): Promise<MemberStationRow[]> {
  const supabase = asCaller(accessToken);

  const { data: links, error } = await supabase
    .from('member_company_links')
    .select('company_id, linked_at')
    .eq('member_id', memberId)
    .order('linked_at', { ascending: true });
  if (error) {
    throw new InternalError(`Could not read the Stations this listener has taken part in: ${error.message}`);
  }

  const companyIds = (links ?? []).map((l) => l.company_id);
  const { data: companies, error: companiesError } = companyIds.length
    ? await supabase.from('companies').select('id, name').in('id', companyIds)
    : { data: [], error: null };
  if (companiesError) {
    throw new InternalError(`Could not read station names: ${companiesError.message}`);
  }
  const nameById = new Map((companies ?? []).map((c) => [c.id, c.name]));

  // checkMemberBlocked(supabase, …), not isMemberBlocked(…, accessToken) —
  // reuses the client already built above instead of asCaller building a
  // fresh one per Station (Task 8 review, Important 2). No concurrency bound
  // here: this fan-out is one listener's own Station count, not up to
  // MEMBER_LIST_LIMIT rows — the shape mapWithConcurrency (above) exists to
  // bound.
  const blocked = await Promise.all(
    (links ?? []).map((l) => checkMemberBlocked(supabase, memberId, l.company_id)),
  );

  return (links ?? []).map((l, i) => ({
    companyId: l.company_id,
    companyName: nameById.get(l.company_id) ?? 'Unknown Station',
    linkedAt: l.linked_at,
    blocked: blocked[i] ?? false,
  }));
}

// ---------------------------------------------------------------------------
// create_member / update_member — named arguments only, never positional.
//
// Both RPCs (0034_member_rpcs.sql) take eight consecutive `text` parameters
// — this task's own analysis, not a warning 0034 states itself: a single
// omitted positional argument would shift every later value one column left
// with no type error possible. Supabase's JS client already forces every
// .rpc() call through an object keyed by parameter name rather than a
// positional array, so that shift-by-one hazard cannot occur through this
// client the way it could through a raw positional
// `select create_member($1, $2, ...)`. The object literals below keep that
// guarantee visible rather than incidental: every field is spelled out by
// its `p_` name, in the RPC's own declared names, not assembled from an
// array or spread from a tuple that could silently drop or reorder one.
// ---------------------------------------------------------------------------

export async function createMember(input: CreateMemberInput, accessToken: string): Promise<string> {
  const { data, error } = await asCaller(accessToken).rpc('create_member', {
    p_company_id: input.companyId,
    p_full_name: input.fullName,
    p_phone: input.phone,
    p_email: input.email,
    p_cpf_hash: input.cpf ? hashCpf(input.cpf) : undefined,
    p_cpf_last_digits: input.cpf ? cpfLastDigits(input.cpf) : undefined,
    p_passport: input.passport,
    p_birth_date: input.birthDate ? toDateOnly(input.birthDate) : undefined,
    p_address_line: input.addressLine,
    p_address_number: input.addressNumber,
    p_address_complement: input.addressComplement,
    p_neighbourhood: input.neighbourhood,
    p_city: input.city,
    p_state: input.state,
    p_postal_code: input.postalCode,
    p_country: input.country,
    p_gender: input.gender,
    p_discovery_source: input.discoverySource,
    p_first_contact_at: input.firstContactAt ? input.firstContactAt.toISOString() : undefined,
    p_first_contact_origin: input.firstContactOrigin,
  });
  if (error) throw mapMemberError(error.code, error.message);
  if (typeof data !== 'string') throw new InternalError('create_member returned no id');
  return data;
}

export async function updateMember(input: UpdateMemberInput, accessToken: string): Promise<void> {
  const { error } = await asCaller(accessToken).rpc('update_member', {
    p_member_id: input.memberId,
    p_full_name: input.fullName,
    p_phone: input.phone,
    p_email: input.email,
    p_cpf_hash: input.cpf ? hashCpf(input.cpf) : undefined,
    p_cpf_last_digits: input.cpf ? cpfLastDigits(input.cpf) : undefined,
    p_passport: input.passport,
    p_birth_date: input.birthDate ? toDateOnly(input.birthDate) : undefined,
    p_address_line: input.addressLine,
    p_address_number: input.addressNumber,
    p_address_complement: input.addressComplement,
    p_neighbourhood: input.neighbourhood,
    p_city: input.city,
    p_state: input.state,
    p_postal_code: input.postalCode,
    p_country: input.country,
    p_gender: input.gender,
    p_discovery_source: input.discoverySource,
  });
  if (error) throw mapMemberError(error.code, error.message);
}

export async function linkMemberToCompany(
  input: LinkMemberToCompanyInput,
  accessToken: string,
): Promise<void> {
  const { error } = await asCaller(accessToken).rpc('link_member_to_company', {
    p_member_id: input.memberId,
    p_company_id: input.companyId,
  });
  if (error) throw mapMemberError(error.code, error.message);
}

export async function archiveMember(memberId: string, accessToken: string): Promise<void> {
  const { error } = await asCaller(accessToken).rpc('archive_member', { p_member_id: memberId });
  if (error) throw mapMemberError(error.code, error.message);
}

export async function recordMemberConsent(
  input: RecordMemberConsentInput,
  accessToken: string,
): Promise<string> {
  const { data, error } = await asCaller(accessToken).rpc('record_member_consent', {
    p_member_id: input.memberId,
    p_company_id: input.companyId,
    p_consent_type: input.consentType,
    p_granted: input.granted,
    p_origin: input.origin,
    p_promotion_id: input.promotionId,
  });
  if (error) throw mapMemberError(error.code, error.message);
  if (typeof data !== 'string') throw new InternalError('record_member_consent returned no id');
  return data;
}

export async function addMemberNote(input: AddMemberNoteInput, accessToken: string): Promise<string> {
  const { data, error } = await asCaller(accessToken).rpc('add_member_note', {
    p_member_id: input.memberId,
    p_company_id: input.companyId,
    p_body: input.body,
  });
  if (error) throw mapMemberError(error.code, error.message);
  if (typeof data !== 'string') throw new InternalError('add_member_note returned no id');
  return data;
}

export async function blockMember(input: BlockMemberInput, accessToken: string): Promise<string> {
  const { data, error } = await asCaller(accessToken).rpc('block_member', {
    p_member_id: input.memberId,
    p_kind: input.kind,
    p_reason: input.reason,
    p_company_id: input.companyId,
    p_ends_at: input.endsAt ? input.endsAt.toISOString() : undefined,
  });
  if (error) throw mapMemberError(error.code, error.message);
  if (typeof data !== 'string') throw new InternalError('block_member returned no id');
  return data;
}

export async function liftMemberBlock(input: LiftMemberBlockInput, accessToken: string): Promise<void> {
  const { error } = await asCaller(accessToken).rpc('lift_member_block', {
    p_block_id: input.blockId,
    p_reason: input.reason,
  });
  if (error) throw mapMemberError(error.code, error.message);
}

/**
 * LGPD erasure (spec §7). p_reason is public.member_erasure_reason — a
 * bounded enum (subject_request | court_order | internal_policy), not text:
 * the owner's ruling (0034's own comment) is that an escape hatch such as
 * `other` would invite back exactly the free text about a person that this
 * ruling exists to keep out of an immutable audit trail. MemberErasureReason
 * is the generated union of those three literals — there is no fourth value
 * this function's TypeScript signature can express, which is deliberate.
 */
export async function anonymizeMember(
  memberId: string,
  reason: MemberErasureReason,
  accessToken: string,
): Promise<void> {
  const { error } = await asCaller(accessToken).rpc('anonymize_member', {
    p_member_id: memberId,
    p_reason: reason,
  });
  if (error) throw mapMemberError(error.code, error.message);
}

/**
 * The error taxonomy in lib/errors.ts exists so a caller can tell these
 * apart; collapsing them into one class throws that away, the same warning
 * services/inventory.ts's mapInventoryError and services/roles.ts's
 * mapRoleError both carry.
 *
 * - `23505` is any of the four partial unique indexes on members (phone,
 *   e-mail, CPF hash, passport — 0031_members.sql) colliding in
 *   create_member/update_member, or a listener already linked to a Station
 *   in link_member_to_company. create_member/update_member catch the raw
 *   unique_violation and rewrite it to name the field categories that could
 *   have collided (phone, e-mail, CPF or passport) — deliberately not which
 *   one, the owner's ruling against per-identifier resolution (0033's own
 *   comment: resolving per-identifier "was deliberately rejected, because it
 *   would ripple into Tasks 6 and 9"). link_member_to_company's own message
 *   is precise, because it has only one possible cause: this exact pair is
 *   already linked.
 * - `P0002` is every "not found" raise across 0033/0034 — a stale
 *   Station/member/block id, or a listener already archived or anonymised.
 *   Not a permission refusal: the row is simply gone, and telling someone
 *   they lack permission when the record no longer exists sends them to fix
 *   the wrong thing.
 * - `42501` is has_permission/has_org_permission/member_reachable failing
 *   inside a SECURITY DEFINER body — every RPC in 0033/0034 raises this with
 *   the same shape, having already written a RAISE LOG line server-side.
 * - `22023` is every application-level validation and state raise across
 *   0033/0034 that chose this code: a blank name, a missing consent type,
 *   granted flag or block kind, a blank note/reason, find_member_by_
 *   identifier's "give at least one identifier" guard, and — easy to mistake
 *   for a permission refusal — update_member's own distinct messages for
 *   editing an already-archived or an already-anonymised listener (0034's
 *   own comment explains why it re-reads to tell the two apart rather than
 *   guessing). schemas/members.ts catches the field-level cases before a
 *   request is ever sent; this mapping is what still applies to those, and
 *   is the only thing that catches the state-conflict cases at all, since no
 *   client-side schema can know a row was archived after the form loaded.
 * - `23503` is a foreign key violation. Unlike inventory.ts's own use of this
 *   code (archive_prize's explicit `raise ... using errcode = '23503'` for a
 *   prize still in stock), none of 0033/0034's RAISE statements use it —
 *   there is no application-level business rule raising it here. It is
 *   mapped anyway, per this task's own instruction, as a forward-looking
 *   defensive case: member_consents.promotion_id (0032) carries no foreign
 *   key yet ("public.promotions does not exist" — 0032's own comment) and
 *   the three composite FKs record_member_consent/add_member_note/
 *   block_member do write against (member_consents_company_org_fk,
 *   member_notes_company_org_fk, member_blocks_company_org_fk, 0032) cannot
 *   currently fail in normal operation, because nothing in this codebase
 *   hard-deletes a company or a member (archive_member's own comment) — the
 *   row a member_company_links entry already proved exists
 *   (member_linked_to_company, 0034) never disappears out from under it. If
 *   promotion_id's foreign key is added later, or a future migration
 *   introduces a real deletion path, this mapping is already correct rather
 *   than silently swallowing the new failure as an InternalError.
 * - `22P02` is what casting an out-of-vocabulary string to
 *   public.member_erasure_reason (anonymize_member's p_reason) raises —
 *   Postgres's own "invalid input value for enum" failure, not one this
 *   project's SQL wrote. anonymizeMember's own TypeScript signature only
 *   accepts the three literal values the enum declares, so this cannot fire
 *   through that function honestly typed — but a caller who bypasses the
 *   type system (an `as` cast over untrusted external input, for instance)
 *   can still reach it, and record_member_consent/block_member's own enum
 *   parameters carry the identical risk. Same SQLSTATE class as `22023`
 *   (class 22, "Data Exception") and the same verdict: the caller supplied a
 *   value that does not parse as what was asked for. That is what
 *   ValidationError means here — the value is wrong, not the request itself,
 *   and not a server fault.
 * - Anything else is ours, not the caller's. Labelling an unexpected
 *   database fault a refusal hides a real fault behind a plausible-looking
 *   permission or business-rule message.
 */
function mapMemberError(code: string | undefined, message: string): Error {
  if (code === '23505') return new ConflictError(message);
  if (code === 'P0002') return new NotFoundError(message);
  if (code === '42501') return new UnauthorizedError(message);
  if (code === '22023') return new ValidationError(message);
  if (code === '22P02') return new ValidationError(message);
  if (code === '23503') return new BusinessRuleError(message);
  return new InternalError(message);
}
