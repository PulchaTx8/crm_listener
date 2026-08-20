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
import { keysetPage } from '@/lib/keyset';
import type { Cursor } from '@/lib/keyset';
import { escapeLikePattern, quoteForOrFilter } from '@/lib/postgrest';
import { PARTICIPATION_STATUSES } from '@/lib/participation-status';
import type { ParticipationStatus } from '@/lib/participation-status';
// The picker's page size lives in @/lib for the reason that module's own
// comment gives: the form that announces the cut is a client component and
// cannot import a value out of this `server-only` file.
import { STATION_LISTENER_PAGE_SIZE } from '@/lib/station-listeners';
import type { Database } from '@/lib/supabase/database.types';
import { cpfLastDigits, hashCpf } from '@/services/members';
// The question's kind, for the participation window's answers. A type import
// only — this module still never calls into promotions, so there is no cycle to
// reason about beyond the one the record read already documents in the other
// direction.
import type { PromotionQuestionKind } from '@/services/promotions';
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
   * participations.view but not members.view. That second case used to fall out
   * of an embed under RLS; since 6c it is a branch inside list_participations
   * (0090), which withholds the three listener fields and still lists the rows.
   */
  listenerName: string | null;
  /**
   * The last four digits, or null — withheld with listenerName and
   * listenerCpfLastDigits from a caller without members.view, the same
   * branch inside list_participations (0090) that withholds all three
   * listener fields together. The whole number is NOT here on purpose (Block
   * 30a D1): it is asked for one listener at a time through
   * reveal_member_field (0253), which records the asking. Masking a number
   * the page already carries would be a lock on a door standing in an open
   * field.
   */
  listenerPhoneLast4: string | null;
  listenerCpfLastDigits: string | null;
  status: ParticipationStatus;
  source: ParticipationSource;
  participatedAt: string;
  /**
   * Whether this listener has already won in this promotion — which is why they
   * will not be in the next round's hat (0076). Shown so that a row
   * disappearing between rounds is accounted for rather than merely missing.
   */
  alreadyWon: boolean;
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
  /** By listener name, phone or CPF. Requires members.view, and returns nothing without it. */
  search?: string;
  /**
   * Block 6c. True lists only those who answered every QUIZ question correctly,
   * false only the others, undefined both. Undefined rather than null because
   * PostgREST omits an undefined argument and the function's own default is
   * null — sending null explicitly would mean the same thing by a longer road.
   */
  answeredCorrectly?: boolean;
  /** Block 6c. Only participations that chose this option. ANDs with the above. */
  optionId?: string;
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
 * One keyset page of the participants list.
 *
 * It reads ONE function rather than composing a PostgREST query, and that is
 * Block 6c: "did they answer correctly" and "did they choose this option" are
 * not conditions over an embed, and the two cheaper routes each lose something
 * — a view cannot carry the foreign key to the embedded listener, which is what
 * the name search is, and sending the matching ids back as a filter puts a
 * promotion's whole participation list into a URL.
 *
 * The ordering is FIXED, newest first tie-broken by id, because that is what
 * participations_listing_idx (0052) carries and a keyset cursor must compare
 * precisely what it orders by (Block 3b).
 *
 * The total arrives on every row, computed inside the function from the same
 * filtered set the rows come from, so a page and its count can no longer narrow
 * differently — the old code got that from building both reads with one
 * builder; there is now only one read.
 *
 * Reads through asCaller rather than createUserClient(), so this can be driven
 * from tests/isolation: the same reasoning the previous version carried, and
 * more load-bearing now that list_participations is SECURITY DEFINER and its
 * permission boundary is written in SQL rather than enforced by RLS.
 */
export async function listParticipationsPage(
  params: ParticipationListParams,
  accessToken: string,
): Promise<ParticipationListPage> {
  const walkingBack = params.cursorSide === 'before' && params.cursor !== null;
  const term = params.search?.trim().slice(0, PARTICIPATION_SEARCH_MAX_LENGTH) || undefined;

  const { data, error } = await asCaller(accessToken).rpc('list_participations', {
    p_company_id: params.companyId,
    p_promotion_id: params.promotionId,
    p_status: params.status,
    p_source: params.source,
    p_from: params.from,
    p_to: params.to,
    p_search: term,
    p_answered_correctly: params.answeredCorrectly,
    p_option_id: params.optionId,
    // Cursor.value is nullable because other screens sort by a nullable column;
    // participated_at is not null (0052), so a null here can only mean "no
    // cursor", which is what undefined says to the function's default.
    p_cursor_at: params.cursor?.value ?? undefined,
    p_cursor_id: params.cursor?.id,
    p_walking_back: walkingBack,
    // One past the page, which is how keysetPage knows there is a next one.
    p_limit: PARTICIPATION_PAGE_SIZE + 1,
  });

  if (error) throw mapParticipationError(error.code, error.message);

  const fetched = data ?? [];

  const { rows: page, nextCursor, previousCursor } = keysetPage(fetched, {
    pageSize: PARTICIPATION_PAGE_SIZE,
    walkingBack,
    hadCursor: params.cursor !== null,
    cursorFor: (row) => ({ value: row.participated_at, id: row.id }),
  });

  return {
    rows: page.map((row) => ({
      id: row.id,
      promotionId: row.promotion_id,
      promotionName: row.promotion_name,
      memberId: row.member_id,
      listenerName: row.listener_name,
      listenerPhoneLast4: row.listener_phone_last4,
      listenerCpfLastDigits: row.listener_cpf_last_digits,
      status: row.status,
      source: row.source,
      participatedAt: row.participated_at,
      alreadyWon: row.already_won,
    })),
    nextCursor,
    previousCursor,
    // Every row carries the same figure; an empty page carries none, and an
    // empty page is a total of zero.
    total: Number(fetched[0]?.total_count ?? 0),
  };
}

/**
 * One answer, as the participation window reads it (Block 24, item 6).
 *
 * NO `isCorrect` FLAG ON THE ANSWER ITSELF, because there is none to read: 0052
 * stores what the person chose and never whether it was right, and the draw
 * derives correctness at draw time by joining `promotion_question_options`. This
 * type carries the chosen option's own `isCorrect`, which is that same join —
 * one hop, not a second truth.
 */
export interface ParticipationAnswerDetail {
  id: string;
  questionId: string;
  position: number;
  kind: PromotionQuestionKind;
  prompt: string;
  /**
   * The internal guidance a Poll question carries for whoever reads its answers
   * (Block 24, item 5). Null on every other kind, and never shown to a listener.
   */
  moderationGuidelines: string | null;
  /** What they chose, on a Quiz or a deprecated poll. Null on a written answer. */
  optionLabel: string | null;
  /** Whether the option they chose is the right one. Null when there is no option, and false on a MULTIPLE_CHOICE, which has no right answer. */
  optionIsCorrect: boolean | null;
  /** What they wrote, on a Poll. Null on anything that picked from options. */
  answerText: string | null;
}

/**
 * What one person answered, for the participation window.
 *
 * READ THROUGH RLS, no RPC. `participation_answers_select_participations_view`
 * (0053) already gates this on `participations.view` and carries the
 * archived-promotion rule through its own sub-select; `promotion_questions` and
 * `promotion_question_options` (0044) gate the prompt and the option label on
 * `promotions.view`. `list_participations` requires BOTH of those permissions
 * before it will list a single row, so anybody who reached this screen holds
 * them — and a caller who somehow does not gets an empty list rather than
 * somebody else's answers.
 *
 * Ordered by the QUESTION's position rather than by anything on the answer: the
 * window shows the quiz as it was asked, and an answer table has no order of its
 * own.
 */
export async function getParticipationAnswers(
  participationId: string,
  accessToken: string,
): Promise<ParticipationAnswerDetail[]> {
  const { data, error } = await asCaller(accessToken)
    .from('participation_answers')
    .select(
      'id,question_id,kind,answer_text,' +
        'promotion_questions(position,prompt,moderation_guidelines),' +
        'promotion_question_options(label,is_correct)',
    )
    .eq('participation_id', participationId);

  if (error) throw mapParticipationError(error.code, error.message);

  type AnswerRow = {
    id: string;
    question_id: string;
    kind: PromotionQuestionKind;
    answer_text: string | null;
    promotion_questions: {
      position: number;
      prompt: string;
      moderation_guidelines: string | null;
    } | null;
    promotion_question_options: { label: string; is_correct: boolean } | null;
  };

  return ((data ?? []) as unknown as AnswerRow[])
    .map((row) => ({
      id: row.id,
      questionId: row.question_id,
      // Zero when the embed came back null, which RLS can do: a caller holding
      // participations.view and not promotions.view reads the answer row and not
      // the question behind it. Sorting them to the front rather than dropping
      // them is deliberate — the window says an answer is there and that its
      // question could not be read, which is the honest report.
      position: row.promotion_questions?.position ?? 0,
      kind: row.kind,
      prompt: row.promotion_questions?.prompt ?? '',
      moderationGuidelines: row.promotion_questions?.moderation_guidelines ?? null,
      optionLabel: row.promotion_question_options?.label ?? null,
      optionIsCorrect: row.promotion_question_options?.is_correct ?? null,
      answerText: row.answer_text,
    }))
    .sort((a, b) => a.position - b.position);
}

/**
 * The most participations one hat may name.
 *
 * There is a ceiling because the ids travel — out of the database into a server
 * action's result, into the browser, back through a second action and into a
 * `uuid[]` — and a set with no upper bound would eventually meet a limit
 * somewhere in that chain with no sentence attached to it. Five thousand at
 * thirty-seven bytes is under two hundred kilobytes, comfortably inside Next's
 * one-megabyte action body, and larger than any single promotion this product
 * has been asked to draw.
 *
 * Reaching it REFUSES rather than drawing the first five thousand, which is D3
 * applied to this end of the wire: a hat quietly cut to a size nobody chose is
 * exactly the draw an operator would go on describing as "everyone who
 * answered".
 */
export const DRAW_HAT_MAX = 5000;

export interface DrawHat {
  /** The participations this hat names, in the list's own order. */
  participationIds: string[];
  /** Rows the filters matched whose listener has already won here, left out and counted. */
  alreadyWon: number;
  /** Rows the filters matched that are not VALID, left out and counted. */
  notValid: number;
  /** Everything the filters matched, drawable or not — what the list's own footer says. */
  matched: number;
}

/**
 * The hat the participants screen proposes: every row the operator's filters
 * match, minus the ones a draw cannot take.
 *
 * TWO exclusions happen here and they are not the database being second-guessed.
 * A row that is not VALID and a listener who has already won in this promotion
 * are both visible on the screen — the status badge and the "Won here" column —
 * and both are refused by `draw_eligible_participations` (0076). Sending them
 * would refuse every draw made from the default filters the moment a promotion
 * has a second round, so they are dropped HERE and COUNTED, and the dialog says
 * how many and why before the operator approves anything. That is what
 * separates this from the silent narrowing D3 forbids: the number the operator
 * agrees to is the number that goes in.
 *
 * What is NOT dropped here is anything the screen cannot see — a listener
 * blocked or erased since the page rendered. Those still reach `run_draw` and
 * still refuse it with `22023`, which is the "the list has moved, refresh it"
 * case D3 was written for.
 *
 * Read through the same function the list reads, with the same arguments, so
 * the set the operator looked at and the set that goes in the hat cannot be
 * assembled by two different queries.
 */
export async function collectDrawHat(
  params: Omit<ParticipationListParams, 'cursor' | 'cursorSide'>,
  accessToken: string,
): Promise<DrawHat> {
  const term = params.search?.trim().slice(0, PARTICIPATION_SEARCH_MAX_LENGTH) || undefined;

  const { data, error } = await asCaller(accessToken).rpc('list_participations', {
    p_company_id: params.companyId,
    p_promotion_id: params.promotionId,
    p_status: params.status,
    p_source: params.source,
    p_from: params.from,
    p_to: params.to,
    p_search: term,
    p_answered_correctly: params.answeredCorrectly,
    p_option_id: params.optionId,
    // No cursor: a hat is the whole filtered set and not the page the operator
    // happens to be standing on. One past the ceiling, so a set that is too big
    // can say so rather than arriving already trimmed.
    p_limit: DRAW_HAT_MAX + 1,
  });

  if (error) throw mapParticipationError(error.code, error.message);

  const rows = data ?? [];
  if (rows.length > DRAW_HAT_MAX) {
    throw new ValidationError(
      `These filters match more than ${DRAW_HAT_MAX} entries, which is more than one hat can name. Narrow the list, or draw among everybody from the promotion's own draws screen.`,
    );
  }

  const hat: DrawHat = {
    participationIds: [],
    alreadyWon: 0,
    notValid: 0,
    matched: rows.length,
  };

  for (const row of rows) {
    if (row.status !== 'VALID') {
      hat.notValid += 1;
      continue;
    }
    if (row.already_won) {
      hat.alreadyWon += 1;
      continue;
    }
    hat.participationIds.push(row.id);
  }

  return hat;
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
 * promotion with eight thousand entries cannot be.
 *
 * `count: 'estimated'`, not `'exact'` — a fix-round correction of this
 * function's own former claim that "two counts cost the same at eight
 * thousand as at eight". That was false: `exact` is PostgREST doing a real
 * `COUNT(*)` over every matching row, which is linear in the number of
 * participations this promotion has, precisely the figure design spec D8
 * says this tab must not pay for. `estimated` (PostgREST's own docs, Pagination
 * and Count §Estimated Count) runs a cheap `EXPLAIN`-based planned count first
 * and only falls through to an exact `COUNT(*)` when that plan estimate is
 * BELOW `db-max-rows` (`max_rows = 1000` in supabase/config.toml) — so a
 * promotion with dozens or low hundreds of entries, the ordinary case, still
 * gets the same exact number `exact` gave it, and only a promotion whose valid
 * or refused count has grown into the thousands trades exactness for the O(1)
 * planner estimate design spec D8 requires at that size. `planned` alone was
 * rejected: it is fast unconditionally, but a freshly-written table has thin
 * statistics until autovacuum's next ANALYZE, and a screen that can answer "1"
 * with "0" right after the operator's own entry was recorded is a worse defect
 * than the one this fixes.
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
      .select('id', { count: 'estimated', head: true })
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
   * Present on a skipped row only, and one of exactly four (0054, 0056):
   * `'no identifier'`, `'outside the promotion window'`, `'listener is out of
   * reach'`, `'listener is at another station'`. Typed as a plain string rather
   * than as a union on purpose — it arrives from a jsonb payload, and a union
   * here would promise the compiler something only the database can keep. The
   * screen matches on the four and has a fallback, so a fifth reason added in
   * Block 5 renders the reason itself rather than the sentence for one of these.
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
 *   at all: the RPCs reach it through `(v_answer ->> 'option_id')::uuid` and
 *   `(v_row ->> 'line')::integer`, and the list read reaches it through
 *   `list_participations`'s own `p_promotion_id`/`p_option_id` (0090, both
 *   uuid), neither checked before the call. Until Block 6d this code also had
 *   a door through decodeCursor, which accepted any non-empty string as a
 *   cursor's id and let a hand-edited `?after=` reach Postgres as
 *   `id.lt."abc"` (reproduced against the running stack); decodeCursor
 *   (@/lib/keyset) now rejects an id that is not a uuid before any query runs,
 *   closing that door for every keyset screen at once. ValidationError, for
 *   the reason mapMemberError gives its own 22P02: the value is wrong, not the
 *   request, and not a server fault.
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
