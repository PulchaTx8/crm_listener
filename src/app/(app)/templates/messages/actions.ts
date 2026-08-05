'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { createUserClient } from '@/lib/supabase/user-client';
import { logger } from '@/lib/logger';
import { clearSystemMessageSchema, systemMessageFormSchema } from '@/schemas/templates';
import { clearSystemMessage, setSystemMessage } from '@/services/templates';
import { describeClearMessageError, describeTemplateWriteError } from '../errors';

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
    return { status: 'error', message: describeTemplateWriteError(cause, 'change this text') };
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
      message: 'That text could not be identified. Refresh the page and try again.',
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
    return { status: 'error', message: describeClearMessageError(cause) };
  }
}
