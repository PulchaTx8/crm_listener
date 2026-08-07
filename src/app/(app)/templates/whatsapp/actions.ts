'use server';

import { getTranslations } from 'next-intl/server';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { createUserClient } from '@/lib/supabase/user-client';
import { logger } from '@/lib/logger';
import { archiveTemplateSchema, templateRegistrationSchema } from '@/schemas/templates';
import { archiveTemplate, registerTemplate } from '@/services/templates';
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
  });

  if (!parsed.success) {
    return { status: 'error', message: parsed.error.issues[0]?.message ?? 'Check the form.' };
  }

  const token = await requireAccessToken();

  try {
    await registerTemplate(parsed.data, token);
    revalidatePath('/templates/whatsapp');
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
    revalidatePath('/templates/whatsapp');
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
