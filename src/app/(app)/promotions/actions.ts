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
import {
  archivePromotion,
  cancelPromotion,
  createPromotion,
  linkPrizeToPromotion,
  listLinkablePrizes,
  removePromotionQuestion,
  savePromotionQuestion,
  unlinkPrizeFromPromotion,
  updatePromotion,
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
  const useArt = formData.get('useArt') === 'on';

  return promotionFormSchema.safeParse({
    companyId: formData.get('companyId'),
    name: formData.get('name'),
    startsAt: formData.get('startsAt'),
    endsAt: formData.get('endsAt'),
    siteIntegrationCode: readOptionalNumber(formData.get('siteIntegrationCode')),
    callToAction: formData.get('callToAction') || null,
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
    useArt: whatsappEnabled ? useArt : false,
    artUrl: whatsappEnabled && useArt ? formData.get('artUrl') || null : null,
    yesButtonLabel: whatsappEnabled ? formData.get('yesButtonLabel') || null : null,
    noButtonLabel: whatsappEnabled ? formData.get('noButtonLabel') || null : null,
    requestedFields: whatsappEnabled ? readRequestedFields(formData) : [],
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

export async function createPromotionAction(
  _prev: PromotionFormState,
  formData: FormData,
): Promise<PromotionFormState> {
  const parsed = readPromotionForm(formData);
  if (!parsed.success) {
    return { status: 'error', message: parsed.error.issues[0]?.message ?? 'Check the form.' };
  }

  const token = await requireAccessToken();
  try {
    const promotionId = await createPromotion(parsed.data, token);
    return { status: 'saved', promotionId };
  } catch (cause) {
    logger.error({ err: cause, companyId: parsed.data.companyId }, 'create promotion failed');
    return {
      status: 'error',
      message: describePromotionsWriteError(cause, await getTranslations('promotions'), 'actionRegisterAPromotion'),
    };
  }
}

export async function updatePromotionAction(
  _prev: PromotionFormState,
  formData: FormData,
): Promise<PromotionFormState> {
  const promotionId = String(formData.get('promotionId') ?? '');
  if (!promotionId) return { status: 'error', message: 'Which promotion? Reopen the record.' };

  const parsed = readPromotionForm(formData);
  if (!parsed.success) {
    return { status: 'error', message: parsed.error.issues[0]?.message ?? 'Check the form.' };
  }

  const token = await requireAccessToken();
  try {
    await updatePromotion(promotionId, parsed.data, token);
    return { status: 'saved', promotionId };
  } catch (cause) {
    logger.error({ err: cause, promotionId }, 'update promotion failed');
    return { status: 'error', message: describePromotionsWriteError(cause, await getTranslations('promotions'), 'actionEditThisPromotion') };
  }
}

export interface CancelPromotionState {
  status: 'idle' | 'cancelled' | 'error';
  message?: string;
}

export async function cancelPromotionAction(
  _prev: CancelPromotionState,
  formData: FormData,
): Promise<CancelPromotionState> {
  const promotionId = String(formData.get('promotionId') ?? '');
  const reason = String(formData.get('reason') ?? '').trim();

  if (!promotionId) return { status: 'error', message: 'Which promotion? Reopen the record.' };
  // cancel_promotion refuses this too; catching it here saves a round trip and
  // says it beside the field rather than at the top of the dialog.
  if (!reason) return { status: 'error', message: 'Say why this promotion is being cancelled.' };

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
  const promotionId = String(formData.get('promotionId') ?? '');
  if (!promotionId) return { status: 'error', message: 'Which promotion? Reopen the record.' };

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

export async function savePromotionQuestionAction(
  _prev: QuestionFormState,
  formData: FormData,
): Promise<QuestionFormState> {
  const promotionId = String(formData.get('promotionId') ?? '');
  const questionId = String(formData.get('questionId') ?? '') || null;
  if (!promotionId) return { status: 'error', message: 'Which promotion? Reopen the record.' };

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
    menuTitle: kind === 'ESSAY' ? null : formData.get('menuTitle') || null,
    buttonLabel: kind === 'ESSAY' ? null : formData.get('buttonLabel') || null,
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
  try {
    await savePromotionQuestion(promotionId, questionId, parsed.data, token);
    return { status: 'saved' };
  } catch (cause) {
    logger.error({ err: cause, promotionId, questionId }, 'save promotion question failed');
    return { status: 'error', message: describePromotionsWriteError(cause, await getTranslations('promotions'), 'actionEditThisQuiz') };
  }
}

export async function removePromotionQuestionAction(
  _prev: QuestionFormState,
  formData: FormData,
): Promise<QuestionFormState> {
  const questionId = String(formData.get('questionId') ?? '');
  if (!questionId) return { status: 'error', message: 'Which question? Reopen the record.' };

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
function readPrizeLinkForm(formData: FormData): PrizeLinkFormResult {
  const promotionId = String(formData.get('promotionId') ?? '');
  if (!promotionId) return { success: false, message: 'Which promotion? Reopen the record.' };

  const prizeId = String(formData.get('prizeId') ?? '');
  if (!prizeId) return { success: false, message: 'Choose a prize.' };

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
    return { success: false, message: parsed.error.issues[0]?.message ?? 'Check the form.' };
  }
  return { success: true, data: parsed.data };
}

export async function linkPrizeAction(
  _prev: PrizeLinkState,
  formData: FormData,
): Promise<PrizeLinkState> {
  const parsed = readPrizeLinkForm(formData);
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
  const parsed = readPrizeLinkForm(formData);
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
