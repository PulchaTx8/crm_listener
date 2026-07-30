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
import { LINKABLE_PRIZE_PAGE_SIZE } from '@/lib/linkable-prizes';
import { escapeLikePattern, quoteForOrFilter } from '@/lib/postgrest';
import type { Database } from '@/lib/supabase/database.types';
import type { PromotionSituation } from '@/lib/promotion-situation';
import type {
  PromotionFormInput,
  PromotionPrizeLinkInput,
  QuestionFormInput,
  RequestedField,
} from '@/schemas/promotions';

export type PromotionQuestionKind = Database['public']['Enums']['promotion_question_kind'];

/**
 * A client bound to the caller's JWT. Every RPC in 0042/0043 re-checks
 * has_permission against auth.uid(), so calling one with the service key would
 * defeat the check it exists to make — the same reasoning services/inventory.ts
 * gives for its own asCaller.
 */
function asCaller(accessToken: string) {
  const { url, anonKey } = getUserSupabaseConfig();
  return createClient<Database>(url, anonKey, {
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

export const PROMOTION_PAGE_SIZE = 25;

/** The one bound on a search term, exported so the page enforces this number rather than a copy of it. */
export const PROMOTION_SEARCH_MAX_LENGTH = 100;

export type PromotionSortKey = 'starts' | 'name';

/**
 * What the list shows in its Situation column: computed from three columns,
 * never stored — the owner's decision was that the window decides, with
 * cancellation the one exception (design spec D1/D2). That makes it a filter
 * and NOT a sort key: Block 3b proved a keyset cursor must compare exactly the
 * column it orders by, and there is no column here to compare. See
 * listPromotionsPage.
 *
 * The rule itself lives in @/lib/promotion-situation because this module is
 * `server-only` and the grid and the dialog are client components.
 */
export type { PromotionSituation };

export interface PromotionSummary {
  id: string;
  name: string;
  startsAt: string;
  endsAt: string;
  cancelledAt: string | null;
  whatsappEnabled: boolean;
  hashtag: string | null;
  siteIntegrationCode: number | null;
  questionCount: number;
  /** Non-null only for the owner and the platform admin: nobody else's read returns an archived row (0044). */
  deletedAt: string | null;
}

export interface PromotionListParams {
  companyId: string;
  search?: string;
  situation?: PromotionSituation;
  /** Instants. Narrow by when the promotion starts. */
  startsFrom?: string;
  startsTo?: string;
  /** Only the owner and the platform admin can see anything when this is true. */
  includeArchived?: boolean;
  sort: PromotionSortKey;
  direction: SortDirection;
  cursor: Cursor | null;
  cursorSide: 'after' | 'before';
}

export interface PromotionListPage {
  rows: PromotionSummary[];
  nextCursor: string | null;
  previousCursor: string | null;
  total: number;
}

type PromotionRow = {
  id: string;
  name: string;
  starts_at: string;
  ends_at: string;
  cancelled_at: string | null;
  whatsapp_enabled: boolean;
  hashtag: string | null;
  site_integration_code: number | null;
  deleted_at: string | null;
};

export async function listPromotionsPage(
  params: PromotionListParams,
): Promise<PromotionListPage> {
  const supabase = await createUserClient();

  const column = params.sort === 'name' ? 'name' : 'starts_at';
  // Neither sort column is nullable (0040), so no null region exists on either
  // — unlike the audience list, where full_name is.
  const walkingBack = params.cursorSide === 'before' && params.cursor !== null;
  const ascending = walkingBack ? params.direction === 'desc' : params.direction === 'asc';
  const readDirection: SortDirection = ascending ? 'asc' : 'desc';

  const nowIso = new Date().toISOString();

  const build = (options?: { count: 'exact'; head: true }) => {
    let q = supabase
      .from('promotions')
      .select(
        'id,name,starts_at,ends_at,cancelled_at,whatsapp_enabled,hashtag,site_integration_code,deleted_at',
        options,
      )
      .eq('company_id', params.companyId);

    // Archived rows are unreadable for everyone but the owner and the platform
    // admin, so this is a narrowing for them and a no-op for everybody else.
    // Unlike prizes (0029), the hiding is done here rather than inside the
    // policy — which is precisely what makes the filter possible at all.
    if (!params.includeArchived) q = q.is('deleted_at', null);

    if (params.search) {
      const term = escapeLikePattern(params.search.slice(0, PROMOTION_SEARCH_MAX_LENGTH));
      const like = quoteForOrFilter(`%${term}%`);
      q = q.or(`name.ilike.${like},hashtag.ilike.${like}`);
    }

    // Situation narrows; it never orders. Each arm is a predicate over the same
    // three columns the badge is computed from, so the screen and the query
    // cannot disagree about what "No ar" means.
    switch (params.situation) {
      case 'scheduled':
        q = q.is('cancelled_at', null).gt('starts_at', nowIso);
        break;
      case 'live':
        q = q.is('cancelled_at', null).lte('starts_at', nowIso).gt('ends_at', nowIso);
        break;
      case 'ended':
        q = q.is('cancelled_at', null).lte('ends_at', nowIso);
        break;
      case 'cancelled':
        q = q.not('cancelled_at', 'is', null);
        break;
      default:
        break;
    }

    if (params.startsFrom) q = q.gte('starts_at', params.startsFrom);
    if (params.startsTo) q = q.lte('starts_at', params.startsTo);

    return q;
  };

  let query = build().order(column, { ascending });
  if (params.cursor) {
    // nullsLast is false because neither sort column is nullable: there is no
    // null region for a cursor to cross into.
    query = query.or(keysetFilter(column, readDirection, params.cursor, false));
  }
  query = query.order('id', { ascending });

  const { data, error } = await query.limit(PROMOTION_PAGE_SIZE + 1);
  if (error) throw new InternalError(`Could not read promotions: ${error.message}`);

  const { rows: page, nextCursor, previousCursor } = keysetPage((data ?? []) as PromotionRow[], {
    pageSize: PROMOTION_PAGE_SIZE,
    walkingBack,
    hadCursor: params.cursor !== null,
    cursorFor: (row) => ({
      value: params.sort === 'name' ? row.name : row.starts_at,
      id: row.id,
    }),
  });

  const { count, error: countError } = await build({ count: 'exact', head: true });
  if (countError) throw new InternalError(`Could not count promotions: ${countError.message}`);

  return {
    rows: await withQuestionCounts(supabase, page),
    nextCursor,
    previousCursor,
    total: count ?? 0,
  };
}

/**
 * Attaches each promotion's question count in ONE read for the whole page.
 *
 * A count per row would be twenty-six round trips for a page of twenty-five,
 * which is the shape Block 3b measured at 102 for the audience list and spent
 * a block removing. Scoped to the page rather than the Station, for the same
 * reason: the cost follows what is on screen.
 */
async function withQuestionCounts(
  supabase: Awaited<ReturnType<typeof createUserClient>>,
  rows: PromotionRow[],
): Promise<PromotionSummary[]> {
  const shape = (row: PromotionRow, questionCount: number): PromotionSummary => ({
    id: row.id,
    name: row.name,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    cancelledAt: row.cancelled_at,
    whatsappEnabled: row.whatsapp_enabled,
    hashtag: row.hashtag,
    siteIntegrationCode: row.site_integration_code,
    questionCount,
    deletedAt: row.deleted_at,
  });

  if (rows.length === 0) return [];

  const { data, error } = await supabase
    .from('promotion_questions')
    .select('promotion_id')
    .in(
      'promotion_id',
      rows.map((r) => r.id),
    );

  if (error) throw new InternalError(`Could not count quiz questions: ${error.message}`);

  const counts = new Map<string, number>();
  for (const { promotion_id } of data ?? []) {
    counts.set(promotion_id, (counts.get(promotion_id) ?? 0) + 1);
  }

  return rows.map((row) => shape(row, counts.get(row.id) ?? 0));
}

export interface PromotionQuestionOption {
  id: string;
  label: string;
  isCorrect: boolean;
  position: number;
}

export interface PromotionQuestion {
  id: string;
  position: number;
  kind: PromotionQuestionKind;
  prompt: string;
  menuTitle: string | null;
  buttonLabel: string | null;
  options: PromotionQuestionOption[];
}

export interface PromotionPrizeRow {
  promotionPrizeId: string;
  prizeId: string;
  prizeName: string;
  /** Units committed to this promotion. Includes the drawn ones — the screen calls it Vinculados. */
  linked: number;
  /** Written by Block 6. Zero on every row until then, and the floor an unlink cannot go below. */
  drawn: number;
}

export interface LinkablePrize {
  prizeId: string;
  name: string;
  available: number;
}

export interface PromotionDetail {
  id: string;
  companyId: string;
  name: string;
  siteIntegrationCode: number | null;
  startsAt: string;
  endsAt: string;
  allowMultipleEntries: boolean;
  minHoursBetweenEntries: number | null;
  requireCorrectAnswer: boolean;
  callToAction: string | null;
  whatsappEnabled: boolean;
  hashtag: string | null;
  useArt: boolean;
  artUrl: string | null;
  yesButtonLabel: string | null;
  noButtonLabel: string | null;
  requestedFields: RequestedField[];
  createdAt: string;
  cancelledAt: string | null;
  cancellationReason: string | null;
  deletedAt: string | null;
  /** Who archived it. Null while live; readable only by the callers 0044 admits to archived rows. */
  deletedBy: string | null;
  questions: PromotionQuestion[];
  prizes: PromotionPrizeRow[];
}

/**
 * The whole record in four reads — the promotion, its questions, the options
 * of those questions, and its linked prizes — rather than one per tab or one
 * per question.
 *
 * Returns null when the promotion is not readable, which deliberately covers
 * two different facts: it does not exist, and it exists in a Station this
 * caller cannot reach. Telling those apart would make `?record=<id>` an oracle
 * for ids, the same reasoning the audience record carries.
 */
export async function getPromotionRecord(
  promotionId: string,
  accessToken: string,
): Promise<PromotionDetail | null> {
  const supabase = asCaller(accessToken);

  const { data: promotion, error } = await supabase
    .from('promotions')
    .select('*')
    .eq('id', promotionId)
    .maybeSingle();

  if (error) throw new InternalError(`Could not read the promotion: ${error.message}`);
  if (!promotion) return null;

  const { data: questions, error: questionError } = await supabase
    .from('promotion_questions')
    .select('id,position,kind,prompt,menu_title,button_label')
    .eq('promotion_id', promotionId)
    .order('position', { ascending: true });

  if (questionError) {
    throw new InternalError(`Could not read the quiz: ${questionError.message}`);
  }

  const questionIds = (questions ?? []).map((q) => q.id);

  // Skipped when the quiz is empty: `.in('question_id', [])` is a round trip
  // whose answer is knowable here.
  const options = questionIds.length
    ? await (async () => {
        const { data, error: optionError } = await supabase
          .from('promotion_question_options')
          .select('id,question_id,label,is_correct,position')
          .in('question_id', questionIds)
          .order('position', { ascending: true });
        if (optionError) {
          throw new InternalError(`Could not read the quiz options: ${optionError.message}`);
        }
        return data ?? [];
      })()
    : [];

  const byQuestion = new Map<string, PromotionQuestionOption[]>();
  for (const option of options) {
    const list = byQuestion.get(option.question_id) ?? [];
    list.push({
      id: option.id,
      label: option.label,
      isCorrect: option.is_correct,
      position: option.position,
    });
    byQuestion.set(option.question_id, list);
  }

  // The Prizes tab, read here rather than when the tab is opened: moving
  // between tabs must not reach the server, because a server round trip from
  // inside the dialog is how the list behind it gets re-rendered. Four reads
  // per opening, still one opening.
  //
  // list_promotion_prizes is SECURITY DEFINER (0051) and re-checks
  // promotions.view itself, so this is not a hole in the read gate: it is the
  // only way to get the prize NAME to a caller who holds no inventory
  // permission, which is most of the people who will use this tab.
  const { data: prizes, error: prizeError } = await supabase.rpc('list_promotion_prizes', {
    p_promotion_id: promotionId,
  });

  if (prizeError) {
    throw new InternalError(`Could not read the linked prizes: ${prizeError.message}`);
  }

  return {
    id: promotion.id,
    companyId: promotion.company_id,
    name: promotion.name,
    siteIntegrationCode: promotion.site_integration_code,
    startsAt: promotion.starts_at,
    endsAt: promotion.ends_at,
    allowMultipleEntries: promotion.allow_multiple_entries,
    minHoursBetweenEntries: promotion.min_hours_between_entries,
    requireCorrectAnswer: promotion.require_correct_answer,
    callToAction: promotion.call_to_action,
    whatsappEnabled: promotion.whatsapp_enabled,
    hashtag: promotion.hashtag,
    useArt: promotion.use_art,
    artUrl: promotion.art_url,
    yesButtonLabel: promotion.yes_button_label,
    noButtonLabel: promotion.no_button_label,
    requestedFields: promotion.requested_fields,
    createdAt: promotion.created_at,
    cancelledAt: promotion.cancelled_at,
    cancellationReason: promotion.cancellation_reason,
    deletedAt: promotion.deleted_at,
    deletedBy: promotion.deleted_by,
    questions: (questions ?? []).map((q) => ({
      id: q.id,
      position: q.position,
      kind: q.kind,
      prompt: q.prompt,
      menuTitle: q.menu_title,
      buttonLabel: q.button_label,
      options: byQuestion.get(q.id) ?? [],
    })),
    prizes: (prizes ?? []).map((row) => ({
      promotionPrizeId: row.promotion_prize_id,
      prizeId: row.prize_id,
      prizeName: row.prize_name,
      linked: row.linked,
      drawn: row.drawn,
    })),
  };
}

/**
 * Every code below is raised deliberately by 0042/0043, and each maps to what
 * the caller should do about it. 0049's two linking RPCs — link_prize_to_promotion
 * and unlink_prize_from_promotion — raise from the same set rather than adding
 * a new one, and are folded into each bullet below rather than given their own:
 *
 * - `22023` is every validation and business refusal the RPCs raise — a
 *   missing cancellation reason, a promotion already cancelled or already
 *   over, archiving one that is still accepting, a quiz without exactly one
 *   right answer. Their messages already say what is wrong in a sentence, so
 *   they pass straight through. 0049 raises it too: a non-positive quantity on
 *   either linking RPC, and linking to a promotion that is cancelled.
 * - `23514` is a table check the form did not catch, which means a caller
 *   bypassed the form. The database's message is not a sentence, but it does
 *   name the constraint, and mislabelling it would hide that. 0049 also raises
 *   this code directly — the over-link (apply_inventory_movement names the
 *   units available and requested) and the D4 floor on unlinking
 *   (unlink_prize_from_promotion names the units free, linked and drawn) — and
 *   there the message already is a sentence rather than a constraint name.
 *   BusinessRuleError is still the right class for both: what changes is the
 *   shape of the message under this code, not what the caller should do about
 *   it, which in every case is read the refusal and adjust the request rather
 *   than retry it unchanged.
 * - `23P01` is the hashtag overlap and `23505` the duplicate integration
 *   code; both are rewritten by the RPC to name the value.
 * - `P0002` is a stale id — the promotion, the Station or the question is
 *   gone. Not a permission refusal: telling somebody they lack permission
 *   for a record that no longer exists sends them to fix the wrong thing.
 *   0049 raises it for a stale promotion or a stale prize on linking, and for
 *   a stale link — the pair is not linked at all — on unlinking.
 * - `42501` is has_permission failing inside a SECURITY DEFINER body, already
 *   logged server-side by the RPC. 0049's two RPCs gate on `promotions.prizes`
 *   rather than any of the four codes 0042/0043 check, and raise this same
 *   code for it.
 * - Anything else is ours, not the caller's.
 */
function mapPromotionError(code: string | undefined, message: string): Error {
  if (code === '22023') return new ValidationError(message);
  if (code === '23514') return new BusinessRuleError(message);
  if (code === '23P01') return new ConflictError(message);
  if (code === '23505') return new ConflictError(message);
  if (code === 'P0002') return new NotFoundError(message);
  if (code === '42501') return new UnauthorizedError(message);
  return new InternalError(message);
}

/**
 * The RPC parameters both writes share; `create` adds the Station, `update` the id.
 *
 * Absent fields are sent as `undefined` rather than `null`, which means
 * PostgREST omits them and the function's own `default null` applies. For
 * update_promotion that is exactly the wholesale replace the RPC documents: a
 * field cleared on screen arrives absent and is written null, rather than
 * keeping whatever was there before.
 */
function promotionRpcArgs(input: PromotionFormInput) {
  return {
    p_name: input.name,
    p_starts_at: input.startsAt,
    p_ends_at: input.endsAt,
    p_site_integration_code: input.siteIntegrationCode,
    p_call_to_action: input.callToAction,
    p_allow_multiple_entries: input.allowMultipleEntries,
    p_min_hours_between_entries: input.minHoursBetweenEntries,
    p_require_correct_answer: input.requireCorrectAnswer,
    p_whatsapp_enabled: input.whatsappEnabled,
    p_hashtag: input.hashtag,
    p_use_art: input.useArt,
    p_art_url: input.artUrl,
    p_yes_button_label: input.yesButtonLabel,
    p_no_button_label: input.noButtonLabel,
    p_requested_fields: input.requestedFields,
  };
}

export async function createPromotion(
  input: PromotionFormInput,
  accessToken: string,
): Promise<string> {
  const { data, error } = await asCaller(accessToken).rpc('create_promotion', {
    p_company_id: input.companyId,
    ...promotionRpcArgs(input),
  });
  if (error) throw mapPromotionError(error.code, error.message);
  return data as string;
}

export async function updatePromotion(
  promotionId: string,
  input: PromotionFormInput,
  accessToken: string,
): Promise<void> {
  const { error } = await asCaller(accessToken).rpc('update_promotion', {
    p_promotion_id: promotionId,
    ...promotionRpcArgs(input),
  });
  if (error) throw mapPromotionError(error.code, error.message);
}

export async function cancelPromotion(
  promotionId: string,
  reason: string,
  accessToken: string,
): Promise<void> {
  const { error } = await asCaller(accessToken).rpc('cancel_promotion', {
    p_promotion_id: promotionId,
    p_reason: reason,
  });
  if (error) throw mapPromotionError(error.code, error.message);
}

export async function archivePromotion(
  promotionId: string,
  accessToken: string,
): Promise<void> {
  const { error } = await asCaller(accessToken).rpc('archive_promotion', {
    p_promotion_id: promotionId,
  });
  if (error) throw mapPromotionError(error.code, error.message);
}

export async function savePromotionQuestion(
  promotionId: string,
  questionId: string | null,
  input: QuestionFormInput,
  accessToken: string,
): Promise<string> {
  const { data, error } = await asCaller(accessToken).rpc('save_promotion_question', {
    p_promotion_id: promotionId,
    // Absent rather than null when appending: the RPC's `default null` on
    // p_question_id is what tells it to create instead of replace.
    p_question_id: questionId ?? undefined,
    p_kind: input.kind,
    p_prompt: input.prompt,
    p_menu_title: input.menuTitle,
    p_button_label: input.buttonLabel,
    p_options: input.options.map((o) => ({ label: o.label, is_correct: o.isCorrect })),
  });
  if (error) throw mapPromotionError(error.code, error.message);
  return data as string;
}

export async function removePromotionQuestion(
  questionId: string,
  accessToken: string,
): Promise<void> {
  const { error } = await asCaller(accessToken).rpc('remove_promotion_question', {
    p_question_id: questionId,
  });
  if (error) throw mapPromotionError(error.code, error.message);
}

/**
 * What the picker shows. The RPC reads one more than this and the extra row is
 * the signal.
 *
 * Re-exported rather than declared here so that this module stays the one place
 * a server-side caller looks for it, while the Prizes tab — a client component —
 * can reach the same number without importing a `server-only` module. See
 * @/lib/linkable-prizes.
 */
export { LINKABLE_PRIZE_PAGE_SIZE };

export interface LinkablePrizePage {
  prizes: LinkablePrize[];
  /** True when the catalogue holds more than this page shows, so the screen can say so truthfully. */
  hasMore: boolean;
}

/**
 * `list_linkable_prizes` (0051) reads fifty-one rows and returns them all. The
 * fifty-first is not a result — it is the answer to "is there more", which is
 * the same convention listPromotionsPage uses with PROMOTION_PAGE_SIZE + 1 and
 * keysetPage. Counting instead would cost a second scan of the catalogue on
 * every keystroke; asking the screen to infer truncation from a full page would
 * make it announce a cut that did not happen to a Station holding exactly fifty
 * prizes, which is worse than saying nothing.
 */
export async function listLinkablePrizes(
  companyId: string,
  search: string | null,
  accessToken: string,
): Promise<LinkablePrizePage> {
  const { data, error } = await asCaller(accessToken).rpc('list_linkable_prizes', {
    p_company_id: companyId,
    p_search: search || undefined,
  });
  if (error) throw mapPromotionError(error.code, error.message);

  const rows = data ?? [];
  return {
    prizes: rows.slice(0, LINKABLE_PRIZE_PAGE_SIZE).map((row) => ({
      prizeId: row.prize_id,
      name: row.name,
      available: row.available,
    })),
    hasMore: rows.length > LINKABLE_PRIZE_PAGE_SIZE,
  };
}

export async function linkPrizeToPromotion(
  input: PromotionPrizeLinkInput,
  accessToken: string,
): Promise<string> {
  const { data, error } = await asCaller(accessToken).rpc('link_prize_to_promotion', {
    p_promotion_id: input.promotionId,
    p_prize_id: input.prizeId,
    p_quantity: input.quantity,
  });
  if (error) throw mapPromotionError(error.code, error.message);
  return data as string;
}

export async function unlinkPrizeFromPromotion(
  input: PromotionPrizeLinkInput,
  accessToken: string,
): Promise<void> {
  const { error } = await asCaller(accessToken).rpc('unlink_prize_from_promotion', {
    p_promotion_id: input.promotionId,
    p_prize_id: input.prizeId,
    p_quantity: input.quantity,
  });
  if (error) throw mapPromotionError(error.code, error.message);
}
