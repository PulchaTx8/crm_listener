'use server';

import { getTranslations } from 'next-intl/server';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { createUserClient } from '@/lib/supabase/user-client';
import { logger } from '@/lib/logger';
import { renderCampaignEmail } from '@/lib/mailer/frame';
import { archiveTemplateSchema, marketingTemplateSchema, templateRegistrationSchema } from '@/schemas/templates';
import { archiveTemplate, registerTemplate, saveMarketingTemplate } from '@/services/templates';
import { describeTemplateWriteError } from '../errors';

async function requireAccessToken(): Promise<string> {
  const supabase = await createUserClient();
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) redirect('/login');
  return token;
}

export type RegisterTemplateState =
  | { status: 'idle' }
  | { status: 'saved' }
  | { status: 'error'; message: string };

/**
 * Records what Meta approved, or replaces what was recorded for that purpose.
 *
 * `register_message_template` (0113) upserts on 0110's partial unique index, so
 * one purpose keeps one live registration and this single action serves both
 * the first registration and every correction after it — there is no separate
 * edit door to keep in step.
 *
 * The variable descriptions arrive as repeated `variables` fields rather than
 * a JSON blob in a hidden input, so the browser's own form encoding carries
 * their ORDER — which is the whole meaning of the list. `getAll` preserves
 * document order for repeated names, and the form renders one input per
 * placeholder in ascending `{{n}}`.
 */
export async function registerTemplateAction(
  _prev: RegisterTemplateState,
  formData: FormData,
): Promise<RegisterTemplateState> {
  const parsed = templateRegistrationSchema.safeParse({
    companyId: formData.get('companyId'),
    purpose: formData.get('purpose'),
    name: formData.get('name'),
    language: formData.get('language'),
    body: formData.get('body'),
    // A file input would arrive here as a File; there is none on this form, and
    // filtering rather than casting means a hand-built request cannot smuggle
    // one past Zod's string check as "[object File]".
    variables: formData.getAll('variables').filter((v): v is string => typeof v === 'string'),
    // A checkbox posts nothing at all when it is clear, so absence IS the
    // answer "no button" — there is no third state to tell apart, and reading
    // it as a boolean here keeps the schema free of the browser's 'on'.
    otpButton: formData.get('otpButton') !== null,
  });

  if (!parsed.success) {
    return { status: 'error', message: parsed.error.issues[0]?.message ?? 'Check the form.' };
  }

  const token = await requireAccessToken();

  try {
    await registerTemplate(parsed.data, token);
    revalidatePath('/messages/templates');
    return { status: 'saved' };
  } catch (cause) {
    logger.error(
      { err: cause, companyId: parsed.data.companyId, purpose: parsed.data.purpose },
      'register an approved template failed',
    );
    return {
      status: 'error',
      message: describeTemplateWriteError(cause, await getTranslations('templates'), 'actionRegisterAnApprovedTemplate'),
    };
  }
}

export type ArchiveTemplateState =
  | { status: 'idle' }
  | { status: 'archived' }
  | { status: 'error'; message: string };

/**
 * Stops a purpose from sending. Never a DELETE — 0113's own door soft-deletes,
 * and the outbox keeps its rendered body and template stamp regardless (D6),
 * so every reminder already sent stays readable afterwards.
 */
export async function archiveTemplateAction(
  _prev: ArchiveTemplateState,
  formData: FormData,
): Promise<ArchiveTemplateState> {
  const parsed = archiveTemplateSchema.safeParse({ templateId: formData.get('templateId') ?? '' });
  if (!parsed.success) {
    return {
      status: 'error',
      message: (await getTranslations('templates'))('thatRegistrationCouldNotBeIdentified'),
    };
  }

  const token = await requireAccessToken();

  try {
    await archiveTemplate(parsed.data, token);
    revalidatePath('/messages/templates');
    return { status: 'archived' };
  } catch (cause) {
    logger.error(
      { err: cause, templateId: parsed.data.templateId },
      'archive a registered template failed',
    );
    return {
      status: 'error',
      message: describeTemplateWriteError(cause, await getTranslations('templates'), 'actionRemoveARegisteredTemplate'),
    };
  }
}

export type SaveMarketingTemplateState =
  | { status: 'idle' }
  | { status: 'saved'; templateId: string }
  | { status: 'error'; message: string };

/**
 * Creates a marketing template, or replaces the one named by `templateId` —
 * one action for both, the same shape `registerTemplateAction` gives its own:
 * `save_marketing_template` (0225) is one door for both, writing by id rather
 * than upserting on a conflict target this family has none of (that
 * function's own header explains why a marketing template cannot use the
 * system half's ON CONFLICT clause at all).
 *
 * `variables` only ever carries anything for a WHATSAPP row — an EMAIL body
 * names its own placeholders inline, and 0223's own CHECK refuses a non-empty
 * array on that channel — but the field is read the same way either way:
 * `save_marketing_template`, not this action, is what has to know which
 * channel is asking. Reading it uniformly is what lets TemplateDialog render
 * either shape without this action branching on `channel` to match.
 */
export async function saveMarketingTemplateAction(
  _prev: SaveMarketingTemplateState,
  formData: FormData,
): Promise<SaveMarketingTemplateState> {
  const parsed = marketingTemplateSchema.safeParse({
    templateId: formData.get('templateId') || undefined,
    companyId: formData.get('companyId'),
    channel: formData.get('channel'),
    internalName: formData.get('internalName'),
    description: formData.get('description') || undefined,
    body: formData.get('body'),
    subject: formData.get('subject') || undefined,
    name: formData.get('name') || undefined,
    language: formData.get('language') || undefined,
    variables: formData.getAll('variables').filter((v): v is string => typeof v === 'string'),
    fromName: formData.get('fromName') || undefined,
    fromEmail: formData.get('fromEmail') || undefined,
    replyTo: formData.get('replyTo') || undefined,
  });

  if (!parsed.success) {
    return { status: 'error', message: parsed.error.issues[0]?.message ?? 'Check the form.' };
  }

  const token = await requireAccessToken();

  try {
    const templateId = await saveMarketingTemplate(parsed.data, token);
    revalidatePath('/messages/templates');
    return { status: 'saved', templateId };
  } catch (cause) {
    logger.error(
      { err: cause, companyId: parsed.data.companyId, channel: parsed.data.channel },
      'save a marketing template failed',
    );
    return {
      status: 'error',
      message: describeTemplateWriteError(cause, await getTranslations('templates'), 'actionSaveAMarketingTemplate'),
    };
  }
}

export type PreviewCampaignEmailState =
  | { status: 'ok'; html: string }
  | { status: 'error'; message: string };

/**
 * Frames whatever body is typed right now, for the dialog's own Preview
 * button — read-only and called directly (the shape `getSongRecordAction`,
 * music/songs/record.ts, already uses for a read that is not a form
 * submission), never through `useActionState`, because nothing about looking
 * at a preview should behave like a save.
 *
 * THE VARIABLES ARE SHOWN AS TYPED, `{{listener_first_name}}` and all, never
 * substituted. There is no listener behind a preview — the real substitution
 * belongs to 29d's send loop, which has a recipient to substitute one for and
 * this screen never does.
 *
 * The one HTML this action returns is read by exactly one thing downstream:
 * `<iframe sandbox srcdoc={html} />` (frame.ts's own header states the rule
 * this keeps — this application injects HTML into a page nowhere else).
 */
export async function previewCampaignEmailAction(
  companyId: string,
  body: string,
): Promise<PreviewCampaignEmailState> {
  try {
    const supabase = await createUserClient();
    // A plain read, not a Company this caller necessarily holds
    // templates.manage in checked again: TemplateDialog only reaches this
    // action from a dialog templates.manage already gated (page.tsx's own
    // `manage`), and everything the frame carries beyond the operator's own
    // typed body — the Station's name and picture — is public within this
    // console to anyone who can already see this screen. RLS on `companies`
    // (companies_select_org_member) is still the actual boundary: a caller
    // with no standing in this Station reads no row here at all.
    const { data, error } = await supabase
      .from('companies')
      .select('name, thumb_url')
      .eq('id', companyId)
      .single();

    if (error || !data) {
      return {
        status: 'error',
        message: (await getTranslations('templates'))('couldNotBuildThePreview'),
      };
    }

    const { html } = renderCampaignEmail({
      stationName: data.name,
      logoUrl: data.thumb_url,
      body,
    });
    return { status: 'ok', html };
  } catch (cause) {
    logger.error({ err: cause, companyId }, 'could not render the campaign preview');
    return {
      status: 'error',
      message: (await getTranslations('templates'))('couldNotBuildThePreview'),
    };
  }
}
