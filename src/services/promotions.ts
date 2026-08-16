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
// Block 24, D3. The two halves of a WhatsApp list message, now supplied by this
// module rather than typed by an operator. They live with the rest of the
// listener-facing copy in the conversation engine, which is what they are — see
// their own comment there for why the fallback happens at write time here and at
// send time for the yes/no labels.
import {
  DEFAULT_QUESTION_BUTTON_LABEL,
  DEFAULT_QUESTION_MENU_TITLE,
} from '@/lib/conversation/engine';
import { keysetFilter, keysetPage } from '@/lib/keyset';
import type { Cursor, SortDirection } from '@/lib/keyset';
// One warning, from promotionThumbs: a failed picture read is degraded rather
// than fatal, and a silent fallback nobody logged is a fallback nobody knows is
// happening.
import { logger } from '@/lib/logger';
import { LINKABLE_PRIZE_PAGE_SIZE } from '@/lib/linkable-prizes';
import { escapeLikePattern, quoteForOrFilter } from '@/lib/postgrest';
import {
  describeArtworkRejection,
  type ArtworkKind,
} from '@/lib/security/artwork';
import { readImageDimensions } from '@/lib/security/image-dimensions';
import { ARTWORK_BUCKET, artworkKey, artworkPublicUrl } from '@/lib/storage/artwork-keys';
import type { ArtworkSlot } from '@/lib/storage/artwork-keys';
import type { Database } from '@/lib/supabase/database.types';
import { situationOf } from '@/lib/promotion-situation';
import type { PromotionSituation } from '@/lib/promotion-situation';
// The promotion record carries the fifth tab's two counts, so it reads them
// through the participations service rather than writing a second count query
// here. One direction only — participations never imports this module — so
// there is no cycle to reason about.
import { countPromotionParticipations } from '@/services/participations';
import type { PromotionParticipationCounts } from '@/services/participations';
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

  /** Block 17c (D1). Whether this promotion takes part through the embedded widget. */

  webEnabled: boolean;

  /** Block 17c (D2). What a listener agrees to before entering from the website. */

  rules: string | null;
  hashtag: string | null;
  siteIntegrationCode: number | null;
  questionCount: number;
  /**
   * Of those, how many are of kind QUIZ — the only kind with a right answer
   * (0041 refuses is_correct on the others). Block 6c needs it apart from the
   * total: the participants screen offers a correct/wrong filter only where
   * there is something to be right about, and a poll-only promotion has
   * questions but no gabarito.
   */
  quizQuestionCount: number;
  /**
   * The picture that identifies this promotion on the list (Block 14). NOT the
   * banner: `art_url` is what Meta fetches, is held to different limits and is
   * not read here at all — a list has no use for it and would download fifty
   * full-size ones.
   */
  thumbUrl: string | null;
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
  web_enabled: boolean;
  rules: string | null;
  hashtag: string | null;
  thumb_url: string | null;
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
        'id,name,starts_at,ends_at,cancelled_at,whatsapp_enabled,web_enabled,rules,hashtag,site_integration_code,thumb_url,deleted_at',
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
  const shape = (
    row: PromotionRow,
    questionCount: number,
    quizQuestionCount: number,
  ): PromotionSummary => ({
    id: row.id,
    name: row.name,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    cancelledAt: row.cancelled_at,
    whatsappEnabled: row.whatsapp_enabled,

    webEnabled: row.web_enabled,

    rules: row.rules,
    hashtag: row.hashtag,
    siteIntegrationCode: row.site_integration_code,
    thumbUrl: row.thumb_url,
    questionCount,
    quizQuestionCount,
    deletedAt: row.deleted_at,
  });

  if (rows.length === 0) return [];

  const { data, error } = await supabase
    .from('promotion_questions')
    // kind comes back so the two counts can be taken in one read rather than
    // two: the screen shows the total, and Block 6c needs the quiz-only figure.
    .select('promotion_id, kind')
    .in(
      'promotion_id',
      rows.map((r) => r.id),
    );

  if (error) throw new InternalError(`Could not count quiz questions: ${error.message}`);

  const counts = new Map<string, number>();
  const quizCounts = new Map<string, number>();
  for (const { promotion_id, kind } of data ?? []) {
    counts.set(promotion_id, (counts.get(promotion_id) ?? 0) + 1);
    if (kind === 'QUIZ') quizCounts.set(promotion_id, (quizCounts.get(promotion_id) ?? 0) + 1);
  }

  return rows.map((row) => shape(row, counts.get(row.id) ?? 0, quizCounts.get(row.id) ?? 0));
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
  /**
   * The two halves of the WhatsApp list message. Still read, and no longer
   * typed: Block 24 (D3) took both off the Quiz screen and
   * `savePromotionQuestion` supplies the defaults. They stay on this type
   * because they are facts about the stored question — the participation record
   * and any future diagnosis of "what did WhatsApp actually send" read them.
   */
  menuTitle: string | null;
  buttonLabel: string | null;
  /**
   * Block 24, item 5. What a Poll question tells whoever reads its answers.
   * INTERNAL — see 0197's own comment. Null on every kind but ESSAY, which
   * `promotion_questions_guidelines_shape` enforces rather than assumes.
   */
  moderationGuidelines: string | null;
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
  /**
   * The fifth tab's two figures: in the draw, and recorded but not in it. Part
   * of the record rather than a read of the tab's own, so that moving onto that
   * tab reaches the server no more than moving onto Prizes does — see the note
   * beside the read itself.
   */
  participationCounts: PromotionParticipationCounts;
  /**
   * Whether `save_promotion_question` will refuse to REPLACE a question here
   * (`0055`): once anybody has entered, rewording an option would leave every
   * `participation_answers` row pointing at text the person never read, and the
   * draw derives correctness by reading exactly that option back.
   *
   * Derived from the two counts above rather than from a third query, and the
   * imprecision that buys is safe in the one direction it can go. Those counts
   * are PostgREST's `estimated`, which falls through to an exact `COUNT(*)`
   * whenever the planner's estimate is under `max_rows` — so the 0-versus-1
   * boundary, the only one this flag turns on, is exact. A promotion whose
   * counts are large enough to be estimated is frozen under any estimate.
   *
   * A COURTESY, never the boundary: the screen stops offering what the database
   * will refuse, and the database refuses it regardless. Block 24 added the flag
   * so the Quiz tab can offer the one field the freeze does NOT cover — the
   * moderation guidelines, which have their own door (`0197`).
   */
  frozen: boolean;
  name: string;
  siteIntegrationCode: number | null;
  startsAt: string;
  endsAt: string;
  allowMultipleEntries: boolean;
  minHoursBetweenEntries: number | null;
  /** How many times one person may enter; null means no ceiling (D1, 0052). Carried back so the form renders what is stored. */
  maxEntriesPerMember: number | null;
  requireCorrectAnswer: boolean;
  callToAction: string | null;
  whatsappEnabled: boolean;

  /** Block 17c (D1). Whether this promotion takes part through the embedded widget. */

  webEnabled: boolean;

  /** Block 17c (D2). What a listener agrees to before entering from the website. */

  rules: string | null;
  hashtag: string | null;
  /** Set from the presence of the banner and never independently (0144); the screen no longer offers a tick for it. */
  useArt: boolean;
  artUrl: string | null;
  /** The picture that identifies this promotion inside the system. Never sent anywhere. */
  thumbUrl: string | null;
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
/**
 * Which Station owns this promotion, or null when this caller cannot see it.
 *
 * One column, so that a write path can establish its own Station instead of
 * being told one. `recordParticipationAction` read `companyId` off the form: it
 * was never parsed as a uuid and never checked against the promotion, so a
 * caller holding members.create at Station A could register a listener into A's
 * audience while naming a promotion at Station B, and only then be refused —
 * the listener stays registered, and nobody asked for them.
 *
 * Not `getPromotionRecord`: that is four reads and a whole record, and this
 * question is one column of one row. Read through the caller's token like
 * everything else here, so 0044's policy decides it — a promotion this caller
 * may not see answers null, which is the same answer `record_participation`
 * would give them a moment later and for the same reason.
 */
export async function getPromotionStationId(
  promotionId: string,
  accessToken: string,
): Promise<string | null> {
  const { data, error } = await asCaller(accessToken)
    .from('promotions')
    .select('company_id')
    .eq('id', promotionId)
    .maybeSingle();

  if (error) throw new InternalError(`Could not read the promotion: ${error.message}`);
  return data?.company_id ?? null;
}

/**
 * The promotion pictures for a page of rows, by promotion id (Block 24, item 6).
 *
 * A SECOND, NARROW READ RATHER THAN A WIDER LIST FUNCTION.
 * `list_participations` (0090) is SECURITY DEFINER with a fixed RETURNS TABLE,
 * so adding one column to it means DROP + CREATE on a long function — the
 * operation this repository has already reverted its own fixes with three times.
 * `coversForSongs` (services/music.ts) made exactly this trade for the requests
 * grid and the shape is copied from it.
 *
 * A FAILED PICTURE READ MUST NOT TAKE THE LIST DOWN. The grid falls back to the
 * grey placeholder, which is the rendering it already has for every promotion
 * that carries no picture.
 */
export async function promotionThumbs(
  promotionIds: string[],
): Promise<Map<string, string | null>> {
  const unique = [...new Set(promotionIds)];
  if (unique.length === 0) return new Map();

  const supabase = await createUserClient();
  const { data, error } = await supabase
    .from('promotions')
    .select('id, thumb_url')
    .in('id', unique);

  if (error) {
    logger.warn({ err: error }, 'could not read promotion thumbnails');
    return new Map();
  }

  const thumbs = new Map<string, string | null>();
  for (const row of data ?? []) thumbs.set(row.id, row.thumb_url);
  return thumbs;
}

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
    .select('id,position,kind,prompt,menu_title,button_label,moderation_guidelines')
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

  // Through mapPromotionError like every other RPC call in this module, rather
  // than wrapped in InternalError directly. This is the one call in
  // getPromotionRecord that can raise 42501 — list_promotion_prizes re-checks
  // promotions.view in its own body because it is SECURITY DEFINER — and
  // InternalError would have turned a permission refusal into a 500 and logged
  // it as ours. The three reads above it are ordinary PostgREST selects, where a
  // policy denial arrives as an empty result and never as an error, so they have
  // nothing to map.
  if (prizeError) throw mapPromotionError(prizeError.code, prizeError.message);

  // The fifth tab's two figures, read here for exactly the reason the prizes
  // above are: moving between tabs must not reach the server. Two `head: true`
  // counts and not a page of rows — design spec D8 is explicit that a promotion
  // with eight thousand entries cannot be read once per opening, and a count is
  // the same size at eight thousand as at eight.
  //
  // The alternative, tried and rejected during Task 8: the tab calling a server
  // action of its own when it mounts. It works and it is cheaper — nobody who
  // never opens that tab pays for it — but it is dispatched from an effect that
  // runs immediately after the tab strip's own navigation, and a server action
  // dispatched in that window is silently dropped when the navigation aborts the
  // record re-read that a Save on the Promotion tab has in flight. The tab then
  // sits on "Counting the entries…" for ever. Reproduced deterministically: save,
  // click Entries, and the request is never issued; put two seconds between the
  // two and it always is. Reading it with the record removes the window instead
  // of narrowing it.
  const participationCounts = await countPromotionParticipations(promotionId, accessToken);

  return {
    id: promotion.id,
    companyId: promotion.company_id,
    participationCounts,
    frozen: participationCounts.valid + participationCounts.refused > 0,
    name: promotion.name,
    siteIntegrationCode: promotion.site_integration_code,
    startsAt: promotion.starts_at,
    endsAt: promotion.ends_at,
    allowMultipleEntries: promotion.allow_multiple_entries,
    minHoursBetweenEntries: promotion.min_hours_between_entries,
    maxEntriesPerMember: promotion.max_entries_per_member,
    requireCorrectAnswer: promotion.require_correct_answer,
    callToAction: promotion.call_to_action,
    whatsappEnabled: promotion.whatsapp_enabled,

    webEnabled: promotion.web_enabled,

    rules: promotion.rules,
    hashtag: promotion.hashtag,
    useArt: promotion.use_art,
    artUrl: promotion.art_url,
    thumbUrl: promotion.thumb_url,
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
      moderationGuidelines: q.moderation_guidelines,
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
 * The per-person ceiling is in here, sent to BOTH doors, and that is the whole
 * point of this function existing: p_max_entries_per_member is one field of one
 * form, and a promotion that could be edited into a ceiling but never born with
 * one would be an asymmetry with no rule behind it. 0055 recreates
 * create_promotion as well as update_promotion so that both signatures carry it
 * — an earlier draft of that migration gave it to update_promotion alone, and
 * this builder is where the consequence would have landed: a seventeenth
 * argument sent to a sixteen-argument function does not raise a type error,
 * PostgREST simply fails to resolve it and answers PGRST202.
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
    // Block 24, D2: the screen no longer collects a call to action, so every
    // save writes null and the WhatsApp consent message carries the promotion's
    // name alone — which buildConsentInteractive already did whenever this was
    // blank. Sent explicitly rather than dropped from this builder: the RPC
    // parameter still exists, and both doors replace every field they take, so
    // saying null here is saying the same thing as omitting it while staying
    // legible next to the argument it replaced.
    p_call_to_action: undefined,
    p_allow_multiple_entries: input.allowMultipleEntries,
    p_min_hours_between_entries: input.minHoursBetweenEntries,
    p_require_correct_answer: input.requireCorrectAnswer,
    p_whatsapp_enabled: input.whatsappEnabled,
    // Block 17c, and the comment below is why these two are easy to forget:
    // both have SQL defaults, so omitting them type-checks perfectly and writes
    // `false` and `null` on every save -- a promotion silently unpublished from
    // the website each time somebody edited its name.
    p_web_enabled: input.webEnabled,
    p_rules: input.rules ?? undefined,
    p_hashtag: input.hashtag,
    // p_use_art and p_art_url are GONE from both doors (0144), and their absence
    // here is not cosmetic. update_promotion replaces every field it takes, and
    // the banner is now uploaded rather than typed — so a p_art_url left on this
    // builder would post null on every ordinary Save and delete the banner.
    //
    // NOTHING IN TYPESCRIPT CATCHES THIS. The result of this function is spread
    // into `.rpc()`, and a spread is not subject to excess-property checking, so
    // an argument the function no longer has type-checks perfectly and fails at
    // runtime as PGRST202 — PostgREST cannot resolve the overload, which maps to
    // InternalError and reaches the operator as "Could not save". That is the
    // same trap 0055's header describes from the other direction, and it is why
    // the pgTAP in 30_promotion_images asserts the parameter is absent.
    // Block 24, D2. Undefined, so PostgREST omits them and each RPC's own
    // `default null` applies — which for update_promotion is the wholesale
    // replace it documents. engine.ts falls back to DEFAULT_YES_BUTTON_LABEL /
    // DEFAULT_NO_BUTTON_LABEL for a null one, so the buttons a listener sees on
    // WhatsApp do not change.
    p_yes_button_label: undefined,
    p_no_button_label: undefined,
    p_requested_fields: input.requestedFields,
    // Sent on every write, not merged into one: both RPCs replace every field
    // they are given, so an omitted ceiling is a ceiling written null. That is
    // the defect this argument exists to close on update_promotion, and sending
    // it from the shared builder is what stops the two doors drifting apart
    // again.
    p_max_entries_per_member: input.maxEntriesPerMember,
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
    // Block 24, D3. The Quiz screen stopped asking for these two, and the
    // database still requires them: promotion_questions_list_fields (0041)
    // refuses a QUIZ or MULTIPLE_CHOICE whose menu title or button label is null
    // or blank, and questionOutbound (engine.ts) throws if either reaches it
    // null. So the default is applied HERE, at the one door that writes a
    // question, rather than in each caller — a second caller supplying its own
    // wording is how two questions come to open different-looking menus.
    //
    // ESSAY takes null and must: the same constraint refuses a written answer
    // that carries either field, because it shows no menu at all.
    p_menu_title: input.kind === 'ESSAY' ? undefined : DEFAULT_QUESTION_MENU_TITLE,
    p_button_label: input.kind === 'ESSAY' ? undefined : DEFAULT_QUESTION_BUTTON_LABEL,
    p_options: input.options.map((o) => ({ label: o.label, is_correct: o.isCorrect })),
  });
  if (error) throw mapPromotionError(error.code, error.message);
  return data as string;
}

/**
 * Block 24, item 5. The Poll question's internal moderation guidelines, and
 * nothing else.
 *
 * ITS OWN CALL RATHER THAN A FIELD OF THE ONE ABOVE, and 0197's header carries
 * the full argument. The short of it: `save_promotion_question` is frozen once
 * a participation exists, this field is not (nothing points at it and no
 * listener ever read it), and the only moment anybody needs it is after the
 * first participation.
 */
export async function setQuestionModerationGuidelines(
  questionId: string,
  guidelines: string | null,
  accessToken: string,
): Promise<void> {
  const { error } = await asCaller(accessToken).rpc('set_question_moderation_guidelines', {
    p_question_id: questionId,
    // `undefined`, not `null`, for a cleared box — the shape the generated
    // argument type takes and the one every other optional argument in this file
    // uses. PostgREST omits an undefined argument, the function's own `default
    // null` applies, and `nullif(btrim(...))` inside it writes null. So clearing
    // still clears; it simply travels as an absence rather than as an explicit
    // null, which is the same round trip the promotion builder above documents.
    p_guidelines: guidelines ?? undefined,
  });
  if (error) throw mapPromotionError(error.code, error.message);
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

export interface LinkablePromotion {
  id: string;
  name: string;
}

/**
 * Promotions a prize can still be linked to from its OWN record (Block 23's
 * Reservas tab, "Vincular promoção"): scheduled or live, in `situationOf`'s
 * own words (@/lib/promotion-situation) — the SAME pure function the
 * promotions list's badge and its own situation filter are pinned to,
 * reused here rather than a second, ad hoc copy of the boundary rule its own
 * header already warns a third copy would be. Neither an ended promotion
 * (its window is closed) nor a cancelled one belongs in this picker, though
 * link_prize_to_promotion (0049) re-checks both regardless of what this list
 * offers.
 *
 * A plain select rather than listPromotionsPage's own paginated one: that
 * function's `situation` param takes exactly one of the four values, and
 * this picker needs two of them at once — a combination its own switch has
 * no branch for. No search, no cursor, no cap: a Station's live-and-upcoming
 * promotions are the same small, self-limiting set listPrizeCategories reads
 * whole for the identical reason.
 */
export async function listLinkablePromotions(companyId: string): Promise<LinkablePromotion[]> {
  const supabase = await createUserClient();

  const { data, error } = await supabase
    .from('promotions')
    .select('id, name, starts_at, ends_at, cancelled_at')
    .eq('company_id', companyId)
    .is('deleted_at', null)
    .order('name');

  if (error) throw new InternalError(`Could not read promotions: ${error.message}`);

  const now = new Date();
  return (data ?? [])
    .filter((row) => {
      const situation = situationOf(
        { startsAt: row.starts_at, endsAt: row.ends_at, cancelledAt: row.cancelled_at },
        now,
      );
      return situation === 'scheduled' || situation === 'live';
    })
    .map((row) => ({ id: row.id, name: row.name }));
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

// ---------------------------------------------------------------------------
// The two pictures (Block 14).

const SLOT_FOR: Record<ArtworkKind, ArtworkSlot> = {
  thumb: 'promotion-thumbs',
  banner: 'promotion-banners',
};

const SETTER_FOR = {
  thumb: 'set_promotion_thumb',
  banner: 'set_promotion_art',
} as const;

/**
 * Uploads the object and then files it, IN THAT ORDER.
 *
 * The same order attachDeliveryReceipt takes, for a different reason: the row
 * must never point at bytes that failed to arrive, because that is a broken
 * image on every screen and, for the banner, a message Meta refuses to send. If
 * the RPC below fails instead, what is left is an object at a key derived from
 * this promotion — unreferenced, harmless, and overwritten by the next upload,
 * because the key never changes.
 *
 * The upload runs on the CALLER's token rather than the service key, so the
 * bucket policy written in 0143 is the boundary rather than a decoration — the
 * reasoning 0086 gives for the receipt, unchanged.
 */
export async function uploadPromotionImage(
  accessToken: string,
  input: { kind: ArtworkKind; companyId: string; promotionId: string; file: File },
): Promise<string> {
  const bytes = new Uint8Array(await input.file.arrayBuffer());
  const rejection = describeArtworkRejection(
    input.kind,
    { type: input.file.type, size: input.file.size },
    readImageDimensions(bytes),
  );
  // The bucket refuses the type and the size as well (0143). This is here so
  // the failure is a sentence rather than a Storage error, so the pixel ceiling
  // — which no bucket can express — is enforced somewhere a client cannot
  // reach, and so nothing is uploaded first.
  if (rejection) throw new ValidationError(rejection);

  const key = artworkKey(SLOT_FOR[input.kind], input.companyId, input.promotionId);

  const uploaded = await asCaller(accessToken)
    .storage.from(ARTWORK_BUCKET)
    .upload(key, input.file, {
      // From the validated list, and NOT optional: the key carries no
      // extension, so an object uploaded with no content type is served back as
      // application/octet-stream and Meta refuses the image.
      contentType: input.file.type,
      // The whole point of a key derived from the record. Without this the
      // SECOND upload for a promotion fails instead of replacing the first,
      // which is the accumulation this block was asked to prevent.
      upsert: true,
    });
  if (uploaded.error) {
    throw new InternalError(`Could not upload the image: ${uploaded.error.message}`);
  }

  const url = artworkPublicUrl(getUserSupabaseConfig().url, key, Date.now());
  const { error } = await asCaller(accessToken).rpc(SETTER_FOR[input.kind], {
    p_promotion_id: input.promotionId,
    p_url: url,
  });
  if (error) throw mapPromotionError(error.code, error.message);
  return url;
}

/**
 * Clears the column and queues the object, in one transaction (0144).
 *
 * NOTHING HERE DELETES ANYTHING. The bucket has no delete policy for
 * `authenticated`, deliberately: a client that could reach it could take a
 * Station's banner off the air without leaving a row saying so. The worker
 * drains the queue through service_role, which is where 0087 put that power.
 */
export async function clearPromotionImage(
  accessToken: string,
  input: { kind: ArtworkKind; promotionId: string },
): Promise<void> {
  // p_url is OMITTED rather than sent as null, and that is the setter's own
  // contract: 0144 gives it `default null` precisely so clearing can be
  // expressed without a cast. PostgREST leaves out what is not sent and the
  // function's default applies.
  const { error } = await asCaller(accessToken).rpc(SETTER_FOR[input.kind], {
    p_promotion_id: input.promotionId,
  });
  if (error) throw mapPromotionError(error.code, error.message);
}
