'use server';

import { redirect } from 'next/navigation';
import { createUserClient } from '@/lib/supabase/user-client';
import { logger } from '@/lib/logger';
import { promotionFormSchema, questionFormSchema } from '@/schemas/promotions';
import type { RequestedField } from '@/schemas/promotions';
import {
  archivePromotion,
  cancelPromotion,
  createPromotion,
  removePromotionQuestion,
  savePromotionQuestion,
  updatePromotion,
} from '@/services/promotions';
import type { PromotionQuestionKind } from '@/services/promotions';
import { describePromotionsWriteError } from './errors';

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
      message: describePromotionsWriteError(cause, 'register a promotion'),
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
    return { status: 'error', message: describePromotionsWriteError(cause, 'edit this promotion') };
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
      message: describePromotionsWriteError(cause, 'cancel this promotion'),
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
      message: describePromotionsWriteError(cause, 'archive this promotion'),
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
    return { status: 'error', message: describePromotionsWriteError(cause, 'edit this quiz') };
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
    return { status: 'error', message: describePromotionsWriteError(cause, 'edit this quiz') };
  }
}
