'use server';

import { getTranslations } from 'next-intl/server';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { createUserClient } from '@/lib/supabase/user-client';
import { logger } from '@/lib/logger';
import { saveStationEmailIdentity } from '@/services/company-profile';
import { describeEmailIdentityError } from './errors';

async function requireAccessToken(): Promise<string> {
  const supabase = await createUserClient();
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) redirect('/login');
  return token;
}

export type EmailIdentityState =
  | { status: 'idle' }
  | { status: 'saved' }
  | { status: 'error'; message: string };

/**
 * Sets who this Station's campaign e-mail comes from, from the Settings
 * dialog Block 29a opened on /app (station-email-tab.tsx).
 *
 * REVALIDATES RATHER THAN READING BACK, unlike admin/stations/actions.ts's
 * own writes. That file's header explains why IT cannot: its dialog lives
 * entirely in client state keyed off a snapshot read once for the page, and a
 * server re-render would close it under the operator. This tab has no such
 * snapshot to go stale -- StationEmailTab is mounted only while `tab ===
 * 'email'` (station-settings.tsx), so the values on screen after a save are
 * exactly what the operator just typed, and the NEXT mount (a fresh open, or
 * a fresh tab switch) reads `initial` from whatever this revalidation left in
 * `companies` -- the same contract templates/actions.ts's own
 * `registerTemplateAction` keeps for its screen.
 */
export async function saveStationEmailIdentityAction(
  _prev: EmailIdentityState,
  formData: FormData,
): Promise<EmailIdentityState> {
  const t = await getTranslations('app');
  const companyId = String(formData.get('companyId') ?? '');
  if (!companyId) return { status: 'error', message: t('checkTheForm') };

  const text = (name: string): string | null => String(formData.get(name) ?? '').trim() || null;

  const token = await requireAccessToken();

  try {
    await saveStationEmailIdentity(
      {
        companyId,
        fromName: text('fromName'),
        fromAddress: text('fromAddress'),
        replyTo: text('replyTo'),
      },
      token,
    );
    revalidatePath('/app');
    return { status: 'saved' };
  } catch (cause) {
    logger.error({ err: cause, companyId }, 'save station email identity failed');
    return {
      status: 'error',
      message: describeEmailIdentityError(cause, t, 'actionChangeWhoThisStationsMailComesFrom'),
    };
  }
}
