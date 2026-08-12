'use server';

import { getTranslations } from 'next-intl/server';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { createUserClient } from '@/lib/supabase/user-client';
import { logger } from '@/lib/logger';
import {
  clearSystemMessageSchema,
  serviceHashtagsFormSchema,
  systemMessageFormSchema,
} from '@/schemas/templates';
import { clearSystemMessage, setServiceHashtags, setSystemMessage } from '@/services/templates';
import {
  describeClearMessageError,
  describeServiceHashtagsError,
  describeTemplateWriteError,
} from '../errors';

// ---------------------------------------------------------------------------
// Both writes revalidatePath, and there is no row-patch alternative to weigh
// here the way songs/actions.ts has one: this screen renders ten rows with no
// paging, no filter and no cursor to lose, so a fresh render costs an operator
// nothing and is the only thing that can move a row between "the Station's own
// wording" and "the system default" — which is the state the screen exists to
// show.
// ---------------------------------------------------------------------------

async function requireAccessToken(): Promise<string> {
  const supabase = await createUserClient();
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) redirect('/login');
  return token;
}

/**
 * One row's state. `status: 'idle'` is what useActionState needs before
 * anything has been submitted — the actions themselves never return it.
 */
export type SystemMessageState =
  | { status: 'idle' }
  | { status: 'saved' }
  | { status: 'cleared' }
  | { status: 'error'; message: string };

/**
 * Gives one text this Station's own wording.
 *
 * The Station is posted (`companyId`) rather than inferred, as every other
 * per-Station write in this codebase does: `set_station_message_template`
 * (0113) re-checks `templates.manage` against exactly this Station before
 * writing, so naming one the caller does not hold the permission in is refused
 * at the door rather than trusted here.
 */
export async function saveSystemMessageAction(
  _prev: SystemMessageState,
  formData: FormData,
): Promise<SystemMessageState> {
  const parsed = systemMessageFormSchema.safeParse({
    companyId: formData.get('companyId'),
    key: formData.get('key'),
    body: formData.get('body'),
  });

  if (!parsed.success) {
    return { status: 'error', message: parsed.error.issues[0]?.message ?? 'Check the message.' };
  }

  const token = await requireAccessToken();

  try {
    await setSystemMessage(parsed.data, token);
    revalidatePath('/templates/messages');
    return { status: 'saved' };
  } catch (cause) {
    // The body is what a listener reads and can carry anything an operator
    // typed, so it is named here by KEY only — never logged.
    logger.error(
      { err: cause, companyId: parsed.data.companyId, key: parsed.data.key },
      'save a system message override failed',
    );
    return { status: 'error', message: describeTemplateWriteError(cause, await getTranslations('templates'), 'actionChangeThisText') };
  }
}

/**
 * Returns one text to the system default.
 *
 * Its own action and its own button, never an empty save (spec §5): a blank
 * body is refused by 0109's check constraint, by 0113's door and by
 * systemMessageFormSchema, so "clear" cannot be expressed as "set to nothing"
 * anywhere in this stack — and should not be, because the two are different
 * intentions. Saving an empty box is a mistake; clearing is a decision.
 */
export async function clearSystemMessageAction(
  _prev: SystemMessageState,
  formData: FormData,
): Promise<SystemMessageState> {
  const parsed = clearSystemMessageSchema.safeParse({
    companyId: formData.get('companyId'),
    key: formData.get('key'),
  });

  if (!parsed.success) {
    return {
      status: 'error',
      message: (await getTranslations('templates'))('thatTextCouldNotBeIdentified'),
    };
  }

  const token = await requireAccessToken();

  try {
    await clearSystemMessage(parsed.data, token);
    revalidatePath('/templates/messages');
    return { status: 'cleared' };
  } catch (cause) {
    logger.error(
      { err: cause, companyId: parsed.data.companyId, key: parsed.data.key },
      'clear a system message override failed',
    );
    return { status: 'error', message: describeClearMessageError(cause, await getTranslations('templates')) };
  }
}

/**
 * One state for the hashtag card's single form — no `cleared` arm, unlike
 * the system texts above: an empty field IS how a hashtag is cleared here
 * (0177's own rule), so clearing is just another save, never a second action.
 */
export type ServiceHashtagsState =
  | { status: 'idle' }
  | { status: 'saved' }
  | { status: 'error'; message: string };

/**
 * Saves both service hashtags in one call, through `set_service_hashtags`
 * (0177) — the same door for both fields, since the write is one row and one
 * function, not two.
 */
export async function saveServiceHashtagsAction(
  _prev: ServiceHashtagsState,
  formData: FormData,
): Promise<ServiceHashtagsState> {
  const parsed = serviceHashtagsFormSchema.safeParse({
    companyId: formData.get('companyId'),
    music: formData.get('music'),
    service: formData.get('service'),
  });

  if (!parsed.success) {
    return { status: 'error', message: parsed.error.issues[0]?.message ?? 'Check the hashtags.' };
  }

  const token = await requireAccessToken();

  try {
    await setServiceHashtags(parsed.data, token);
    revalidatePath('/templates/messages');
    return { status: 'saved' };
  } catch (cause) {
    logger.error(
      { err: cause, companyId: parsed.data.companyId },
      'save the service hashtags failed',
    );
    return {
      status: 'error',
      message: describeServiceHashtagsError(cause, await getTranslations('templates')),
    };
  }
}
