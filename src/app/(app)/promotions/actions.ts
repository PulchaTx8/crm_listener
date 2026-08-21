'use server';

import { getTranslations } from 'next-intl/server';
import { redirect } from 'next/navigation';
import { createUserClient } from '@/lib/supabase/user-client';
import { logger } from '@/lib/logger';
import {
  promotionFormSchema,
  promotionPrizeLinkSchema,
  questionFormSchema,
} from '@/schemas/promotions';
import type { PromotionPrizeLinkInput, RequestedField } from '@/schemas/promotions';
import type { ArtworkKind } from '@/lib/security/artwork';
import {
  archivePromotion,
  cancelPromotion,
  clearPromotionImage,
  createPromotion,
  linkPrizeToPromotion,
  listLinkablePrizes,
  removePromotionQuestion,
  savePromotionQuestion,
  setQuestionModerationGuidelines,
  unlinkPrizeFromPromotion,
  updatePromotion,
  uploadPromotionImage,
} from '@/services/promotions';
import type { LinkablePrizePage, PromotionQuestionKind } from '@/services/promotions';
import { describePromotionsReadError, describePromotionsWriteError } from './errors';

// ---------------------------------------------------------------------------
// Not one revalidatePath in this file, deliberately (Block 3c) — the same rule
// members/actions.ts and inventory/actions.ts carry, for the same reason.
//
// Every write below is invoked from the promotion record dialog, and
// revalidatePath returns a fresh render of the current route alongside the
// action's result, re-running the promotions list's keyset query and losing the
// operator's place in it. The grid patches its own row instead
// (src/lib/row-patch.ts), which is why the actions that change a promotion
// report the id rather than relying on a re-render to show the change.
// ---------------------------------------------------------------------------

async function requireAccessToken(): Promise<string> {
  const supabase = await createUserClient();
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) redirect('/login');
  return token;
}

/**
 * A checkbox list arrives as repeated entries under one name, and absent
 * entirely when nothing is ticked. `getAll` handles both; the schema is what
 * refuses a value outside the enum.
 */
function readRequestedFields(formData: FormData): RequestedField[] {
  return formData.getAll('requestedFields').map(String) as RequestedField[];
}

function readOptionalNumber(raw: FormDataEntryValue | null): number | undefined {
  const value = String(raw ?? '').trim();
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function readPromotionForm(formData: FormData) {
  const whatsappEnabled = formData.get('whatsappEnabled') === 'on';
  const webEnabled = formData.get('webEnabled') === 'on';
  /**
   * Block 17c. Whether this promotion can ask a listener anything at all, on
   * either door. What used to be `whatsappEnabled` in the two places below is
   * this instead, and the distinction is the whole of that block's edit here.
   */
  const conversational = whatsappEnabled || webEnabled;

  return promotionFormSchema.safeParse({
    companyId: formData.get('companyId'),
    name: formData.get('name'),
    startsAt: formData.get('startsAt'),
    endsAt: formData.get('endsAt'),
    siteIntegrationCode: readOptionalNumber(formData.get('siteIntegrationCode')),
    // Block 30c. Both read unconditionally: neither depends on a door being
    // open, so there is no stale-tab case to guard against the way the
    // WhatsApp fields further down are guarded.
    authorizationCertificate: formData.get('authorizationCertificate') || undefined,
    showId: formData.get('showId') || undefined,
    // `callToAction` is gone from this read and from the schema (Block 24, D2).
    // The column stays and goes to null on the next save of each promotion.
    allowMultipleEntries: formData.get('allowMultipleEntries') === 'on',
    minHoursBetweenEntries: readOptionalNumber(formData.get('minHoursBetweenEntries')),
    // Read unconditionally, exactly as the interval above is, and NOT dropped
    // when repeats are off the way the WhatsApp fields are dropped when
    // WhatsApp is off. The two situations look alike and are not: the WhatsApp
    // fields are dropped because promotion_whatsapp_shape wants them empty and
    // a stale tab could post a hashtag the operator believes is coherent, so
    // silence is the right answer. Here the schema has a SENTENCE for a ceiling
    // arriving with repeats off — "There is no ceiling to set while only one
    // entry per listener is allowed" — and dropping the value would throw that
    // sentence away and save the promotion as if nothing had been typed.
    //
    // This line was the missing half of Task 6's work: the schema and both RPC
    // doors already carried the ceiling, and without a reader here the input
    // added to promotion-fields.tsx would have posted a value that arrived as
    // `undefined` and wrote null on every save — the exact defect the plan
    // predicted for the field it had not yet added.
    maxEntriesPerMember: readOptionalNumber(formData.get('maxEntriesPerMember')),
    requireCorrectAnswer: formData.get('requireCorrectAnswer') === 'on',
    whatsappEnabled,
    // Everything on the WhatsApp tab is dropped when WhatsApp is off, rather
    // than sent and refused. The tab is disabled on screen, but a stale form in
    // an open tab can still post what it was holding, and the promotion's own
    // check would then reject a submission the operator believes is coherent.
    hashtag: whatsappEnabled ? formData.get('hashtag') || null : null,
    // The two pictures are NOT read here. They are not fields of this schema
    // and neither RPC takes them; settlePromotionImages handles both against
    // the saved record. See its own comment for why that has to come second.
    //
    // The two button labels are gone from this read too (Block 24, D2). Their
    // columns stay and take null from now on, which is what engine.ts's
    // DEFAULT_YES_BUTTON_LABEL / DEFAULT_NO_BUTTON_LABEL have always answered.
    // `conversational`, NOT `whatsappEnabled`, and this line was the defect
    // Block 17c set out to fix. The moment web_enabled existed, saving a
    // web-only promotion here threw away the very fields it asks for -- and no
    // constraint would have caught it, because an empty array is valid. The
    // reason the WhatsApp fields above are still dropped is unchanged and
    // still right: promotions_whatsapp_fields wants them empty, so a stale tab
    // posting a hashtag gets silence rather than a refusal the operator cannot
    // explain.
    requestedFields: conversational ? readRequestedFields(formData) : [],
    webEnabled,
    // Read unconditionally. A promotion can be marked for the web while its
    // wording is still being written, and the rules can be written before the
    // box is ticked -- neither half is dropped because the other is missing.
    rules: formData.get('rules') || null,
  });
}

export interface PromotionFormState {
  status: 'idle' | 'saved' | 'error';
  message?: string;
  /**
   * The promotion that was just registered. The grid opens its record on this
   * id and takes the row from that read, rather than this action assembling a
   * summary — a summary carries a question count, and inventing one here would
   * be the second read Block 3c removed.
   */
  promotionId?: string;
}

/**
 * The two pictures do not travel with the rest of the form, and cannot.
 *
 * update_promotion no longer takes them (0144) and create_promotion never has a
 * record to key an upload against — the storage key is derived from the
 * promotion's id, which does not exist until the row does. So both actions save
 * the promotion first and settle each picture against the id afterwards.
 *
 * A picture that fails therefore leaves a promotion that SAVED. That is the
 * right way round — the alternative is losing a whole form's worth of typing
 * over an image — and it is why the caller keeps returning `promotionId`
 * alongside the failure: the dialog still refreshes onto the promotion that
 * exists, and the operator can try the picture again without retyping anything.
 *
 * `<field>Cleared` is what tells "left alone" from "taken away". An empty file
 * input looks identical to a deliberate removal, so without that flag every
 * Save would either clear the picture or none ever would.
 */
async function settlePromotionImages(
  token: string,
  companyId: string,
  promotionId: string,
  formData: FormData,
  t: Awaited<ReturnType<typeof getTranslations>>,
): Promise<string | null> {
  const fields: ReadonlyArray<{ kind: ArtworkKind; field: string }> = [
    { kind: 'thumb', field: 'thumb' },
    { kind: 'banner', field: 'art' },
  ];

  for (const { kind, field } of fields) {
    const file = formData.get(field);
    const cleared = formData.get(`${field}Cleared`) === 'on';

    try {
      if (file instanceof File && file.size > 0) {
        await uploadPromotionImage(token, { kind, companyId, promotionId, file });
      } else if (cleared) {
        await clearPromotionImage(token, { kind, promotionId });
      }
    } catch (cause) {
      logger.error({ err: cause, promotionId, kind }, 'promotion image failed');
      return describePromotionsWriteError(cause, t, 'actionEditThisPromotion');
    }
  }
  return null;
}

export async function createPromotionAction(
  _prev: PromotionFormState,
  formData: FormData,
): Promise<PromotionFormState> {
  const t = await getTranslations('promotions');
  const parsed = readPromotionForm(formData);
  if (!parsed.success) {
    return { status: 'error', message: parsed.error.issues[0]?.message ?? t('checkTheForm') };
  }

  const token = await requireAccessToken();
  let promotionId: string;
  try {
    promotionId = await createPromotion(parsed.data, token);
  } catch (cause) {
    logger.error({ err: cause, companyId: parsed.data.companyId }, 'create promotion failed');
    return {
      status: 'error',
      message: describePromotionsWriteError(cause, await getTranslations('promotions'), 'actionRegisterAPromotion'),
    };
  }

  // The promotion exists from here on, so every exit below carries its id.
  const failure = await settlePromotionImages(
    token,
    parsed.data.companyId,
    promotionId,
    formData,
    t,
  );
  if (failure) return { status: 'error', message: failure, promotionId };
  return { status: 'saved', promotionId };
}

export async function updatePromotionAction(
  _prev: PromotionFormState,
  formData: FormData,
): Promise<PromotionFormState> {
  const t = await getTranslations('promotions');
  const promotionId = String(formData.get('promotionId') ?? '');
  if (!promotionId) return { status: 'error', message: t('whichPromotionReopenTheRecord') };

  const parsed = readPromotionForm(formData);
  if (!parsed.success) {
    return { status: 'error', message: parsed.error.issues[0]?.message ?? t('checkTheForm') };
  }

  const token = await requireAccessToken();
  try {
    await updatePromotion(promotionId, parsed.data, token);
  } catch (cause) {
    logger.error({ err: cause, promotionId }, 'update promotion failed');
    return { status: 'error', message: describePromotionsWriteError(cause, await getTranslations('promotions'), 'actionEditThisPromotion') };
  }

  // AFTER the update, never before, and the order matters in one direction
  // only: switching WhatsApp off clears the banner and queues its object
  // (0144), so an upload settled first would be undone by the very save that
  // followed it — and the operator would be looking at a picture the row no
  // longer has.
  const failure = await settlePromotionImages(
    token,
    parsed.data.companyId,
    promotionId,
    formData,
    t,
  );
  if (failure) return { status: 'error', message: failure, promotionId };
  return { status: 'saved', promotionId };
}

export interface CancelPromotionState {
  status: 'idle' | 'cancelled' | 'error';
  message?: string;
}

export async function cancelPromotionAction(
  _prev: CancelPromotionState,
  formData: FormData,
): Promise<CancelPromotionState> {
  const t = await getTranslations('promotions');
  const promotionId = String(formData.get('promotionId') ?? '');
  const reason = String(formData.get('reason') ?? '').trim();

  if (!promotionId) return { status: 'error', message: t('whichPromotionReopenTheRecord') };
  // cancel_promotion refuses this too; catching it here saves a round trip and
  // says it beside the field rather than at the top of the dialog.
  if (!reason) return { status: 'error', message: t('sayWhyThisPromotionIsBeingCancelled') };

  const token = await requireAccessToken();
  try {
    await cancelPromotion(promotionId, reason, token);
    return { status: 'cancelled' };
  } catch (cause) {
    logger.error({ err: cause, promotionId }, 'cancel promotion failed');
    return {
      status: 'error',
      message: describePromotionsWriteError(cause, await getTranslations('promotions'), 'actionCancelThisPromotion'),
    };
  }
}

export interface ArchivePromotionState {
  status: 'idle' | 'archived' | 'error';
  message?: string;
}

export async function archivePromotionAction(
  _prev: ArchivePromotionState,
  formData: FormData,
): Promise<ArchivePromotionState> {
  const t = await getTranslations('promotions');
  const promotionId = String(formData.get('promotionId') ?? '');
  if (!promotionId) return { status: 'error', message: t('whichPromotionReopenTheRecord') };

  const token = await requireAccessToken();
  try {
    await archivePromotion(promotionId, token);
    return { status: 'archived' };
  } catch (cause) {
    logger.error({ err: cause, promotionId }, 'archive promotion failed');
    return {
      status: 'error',
      message: describePromotionsWriteError(cause, await getTranslations('promotions'), 'actionArchiveThisPromotion'),
    };
  }
}

export interface QuestionFormState {
  status: 'idle' | 'saved' | 'error';
  message?: string;
}

/**
 * Block 24, item 5. The question and, for a Poll, its moderation guidelines.
 *
 * TWO DOORS IN ONE SUBMISSION, and the split is not tidiness. `0055` freezes
 * `save_promotion_question`'s REPLACE branch once anybody has entered;
 * `set_question_moderation_guidelines` (`0197`) is deliberately outside that
 * freeze, because the guidance is internal text no listener ever read and the
 * only moment anybody needs it is while answers are arriving. So the screen has
 * two shapes and this action serves both:
 *
 *   * `guidelinesOnly` — a frozen promotion's existing question. Only the second
 *     door is called, which is the only one that would succeed.
 *   * everything else — the question is written, and then, for an ESSAY, its
 *     guidelines against the id the first door returns.
 *
 * THE SECOND CALL FAILING DOES NOT UNDO THE FIRST, and the state says so rather
 * than reporting a failure that would tempt a second Save. A second Save of a
 * NEW question would create a second question — the id it was given back is not
 * in the form — so the answer is `saved` carrying a warning, which the tab shows
 * beside the list the operator lands back on. The guidance is then one Edit
 * away, and nothing was duplicated.
 */
export async function savePromotionQuestionAction(
  _prev: QuestionFormState,
  formData: FormData,
): Promise<QuestionFormState> {
  const t = await getTranslations('promotions');
  const promotionId = String(formData.get('promotionId') ?? '');
  const questionId = String(formData.get('questionId') ?? '') || null;
  if (!promotionId) return { status: 'error', message: t('whichPromotionReopenTheRecord') };

  // Blank is null, matching what the RPC does with whitespace: a cleared box
  // means "there is no guidance", not "guidance that says nothing".
  const guidelines = String(formData.get('moderationGuidelines') ?? '').trim() || null;

  // The frozen shape. Trusted only in the direction that narrows what is
  // written: a stale form posting this when the promotion is NOT frozen simply
  // saves less, and the door still re-checks the permission itself.
  if (formData.get('guidelinesOnly') === 'on') {
    if (!questionId) return { status: 'error', message: t('whichQuestionReopenTheRecord') };
    const onlyToken = await requireAccessToken();
    try {
      await setQuestionModerationGuidelines(questionId, guidelines, onlyToken);
      return { status: 'saved' };
    } catch (cause) {
      logger.error({ err: cause, questionId }, 'save moderation guidelines failed');
      return {
        status: 'error',
        message: describePromotionsWriteError(cause, t, 'actionEditThisQuiz'),
      };
    }
  }

  const kind = String(formData.get('kind') ?? '') as PromotionQuestionKind;
  // Labels and their ticks arrive as two parallel lists. The tick list carries
  // the INDEX of each ticked option rather than a boolean per row, because an
  // unticked checkbox posts nothing at all and the two lists would otherwise
  // fall out of step the moment any option was left unmarked.
  const labels = formData.getAll('optionLabel').map(String);
  const correct = new Set(formData.getAll('optionCorrect').map(String));

  const parsed = questionFormSchema.safeParse({
    kind,
    prompt: formData.get('prompt'),
    // `menuTitle` and `buttonLabel` are gone from this read and from the schema
    // (Block 24, D3). They are still WRITTEN — savePromotionQuestion supplies
    // the two defaults, because 0041's check requires them on a QUIZ — but the
    // operator no longer invents them per question.
    options:
      kind === 'ESSAY'
        ? []
        : labels
            .map((label, index) => ({ label, isCorrect: correct.has(String(index)) }))
            .filter((option) => option.label.trim().length > 0),
  });

  if (!parsed.success) {
    return { status: 'error', message: parsed.error.issues[0]?.message ?? 'Check the question.' };
  }

  const token = await requireAccessToken();
  let savedId: string;
  try {
    savedId = await savePromotionQuestion(promotionId, questionId, parsed.data, token);
  } catch (cause) {
    logger.error({ err: cause, promotionId, questionId }, 'save promotion question failed');
    return { status: 'error', message: describePromotionsWriteError(cause, t, 'actionEditThisQuiz') };
  }

  // Only for a written answer, and only through the second door. A QUIZ carries
  // no guidelines — 0197's shape constraint says so, and its trigger has just
  // retired any the question had while it was still a Poll — so calling the door
  // for one would be asking for a refusal we already know the answer to.
  if (parsed.data.kind === 'ESSAY') {
    try {
      await setQuestionModerationGuidelines(savedId, guidelines, token);
    } catch (cause) {
      logger.error({ err: cause, promotionId, questionId: savedId }, 'save moderation guidelines failed');
      // `saved`, deliberately. See this function's header: the question exists,
      // and reporting a failure here would invite a second Save that creates a
      // second question.
      return { status: 'saved', message: t('theQuestionWasSavedButItsModerationGuidelines') };
    }
  }

  return { status: 'saved' };
}

export async function removePromotionQuestionAction(
  _prev: QuestionFormState,
  formData: FormData,
): Promise<QuestionFormState> {
  const t = await getTranslations('promotions');
  const questionId = String(formData.get('questionId') ?? '');
  if (!questionId) return { status: 'error', message: t('whichQuestionReopenTheRecord') };

  const token = await requireAccessToken();
  try {
    await removePromotionQuestion(questionId, token);
    return { status: 'saved' };
  } catch (cause) {
    logger.error({ err: cause, questionId }, 'remove promotion question failed');
    return { status: 'error', message: describePromotionsWriteError(cause, await getTranslations('promotions'), 'actionEditThisQuiz') };
  }
}

export interface PrizeLinkState {
  status: 'idle' | 'saved' | 'error';
  message?: string;
}

type PrizeLinkFormResult =
  | { success: true; data: PromotionPrizeLinkInput }
  | { success: false; message: string };

/**
 * The same missing-id guard updatePromotionAction, cancelPromotionAction,
 * archivePromotionAction and the two quiz actions all check before parsing —
 * added here because it was missing, not because the shape differs. It has to
 * run before the schema, not merely be replaced by it:
 * z.string().uuid(msg)'s own message only fires once the value has already
 * passed as a string, so an absent field arrives as `null`, fails that base
 * type check first, and the operator would have seen Zod's generic
 * "Expected string, received null" instead of a sentence they can act on —
 * the same failure mode this module was written to keep out of RPC codes.
 * Both ids are guarded here rather than in each action, because both actions
 * post the same three fields through this one reader.
 */
function readPrizeLinkForm(
  formData: FormData,
  t: (key: string) => string,
): PrizeLinkFormResult {
  const promotionId = String(formData.get('promotionId') ?? '');
  if (!promotionId) return { success: false, message: t('whichPromotionReopenTheRecord') };

  const prizeId = String(formData.get('prizeId') ?? '');
  if (!prizeId) return { success: false, message: t('chooseAPrizeRequired') };

  const raw = String(formData.get('quantity') ?? '').trim();
  const parsed = promotionPrizeLinkSchema.safeParse({
    promotionId,
    prizeId,
    // Number('') is 0, which would reach the schema as a real quantity and be
    // refused with "Link at least one unit" for a field the operator left
    // blank. NaN gets the "How many units?" message instead, which is the true
    // one.
    quantity: raw === '' ? Number.NaN : Number(raw),
  });
  if (!parsed.success) {
    return { success: false, message: parsed.error.issues[0]?.message ?? t('checkTheForm') };
  }
  return { success: true, data: parsed.data };
}

export async function linkPrizeAction(
  _prev: PrizeLinkState,
  formData: FormData,
): Promise<PrizeLinkState> {
  const parsed = readPrizeLinkForm(formData, await getTranslations('promotions'));
  if (!parsed.success) {
    return { status: 'error', message: parsed.message };
  }

  const token = await requireAccessToken();
  try {
    await linkPrizeToPromotion(parsed.data, token);
    return { status: 'saved' };
  } catch (cause) {
    logger.error({ err: cause, promotionId: parsed.data.promotionId }, 'link prize failed');
    return {
      status: 'error',
      message: describePromotionsWriteError(cause, await getTranslations('promotions'), 'actionLinkThisPrize'),
    };
  }
}

export async function unlinkPrizeAction(
  _prev: PrizeLinkState,
  formData: FormData,
): Promise<PrizeLinkState> {
  const parsed = readPrizeLinkForm(formData, await getTranslations('promotions'));
  if (!parsed.success) {
    return { status: 'error', message: parsed.message };
  }

  const token = await requireAccessToken();
  try {
    await unlinkPrizeFromPromotion(parsed.data, token);
    return { status: 'saved' };
  } catch (cause) {
    logger.error({ err: cause, promotionId: parsed.data.promotionId }, 'unlink prize failed');
    return {
      status: 'error',
      message: describePromotionsWriteError(cause, await getTranslations('promotions'), 'actionReturnThisPrizeToStock'),
    };
  }
}

/**
 * The prize picker's own read, called from the tab rather than folded into the
 * record: the record is read once per opening and this list changes with every
 * keystroke in the search box. Not a form action — it takes arguments directly,
 * because there is no form.
 */
export async function searchLinkablePrizesAction(
  companyId: string,
  search: string,
): Promise<
  { status: 'ok'; page: LinkablePrizePage } | { status: 'error'; message: string }
> {
  const token = await requireAccessToken();
  try {
    return { status: 'ok', page: await listLinkablePrizes(companyId, search.trim(), token) };
  } catch (cause) {
    logger.error({ err: cause, companyId }, 'could not list linkable prizes');
    // list_linkable_prizes gates on promotions.prizes rather than
    // promotions.view (0051), so the default "promotions here" would be wrong
    // here specifically: it would tell a caller who holds promotions.view —
    // which is how this tab is open at all — that they cannot view
    // promotions, when what they actually lack is the narrower permission to
    // link stock.
    return {
      status: 'error',
      message: describePromotionsReadError(cause, await getTranslations('promotions'), 'subjectThePrizesAvailableToLink'),
    };
  }
}
