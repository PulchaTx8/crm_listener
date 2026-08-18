'use server';

import { getTranslations } from 'next-intl/server';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { createUserClient } from '@/lib/supabase/user-client';
import { logger } from '@/lib/logger';
import { stationEmailIdentitySchema } from '@/schemas/stations';
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
 * PARSED WITH ZOD, the shape every action in this codebase's own reference
 * (templates/actions.ts's `registerTemplateAction`) takes before it
 * delegates -- `stationEmailIdentitySchema` (schemas/stations.ts) is what
 * lets '' through for `fromAddress` and `replyTo` as a deliberate clear
 * rather than a bad e-mail, and refuses anything else that is not one. A
 * parse failure reports the same `checkTheForm` sentence a missing companyId
 * used to: neither is a case the form itself can reach, since the browser's
 * own `type="email"` inputs and the hidden companyId already agree with what
 * this schema wants.
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

  const parsed = stationEmailIdentitySchema.safeParse({
    companyId: formData.get('companyId'),
    fromName: formData.get('fromName'),
    fromAddress: formData.get('fromAddress'),
    replyTo: formData.get('replyTo'),
  });
  if (!parsed.success) return { status: 'error', message: t('checkTheForm') };

  const { companyId } = parsed.data;
  const token = await requireAccessToken();

  try {
    await saveStationEmailIdentity(
      {
        companyId,
        // '' is the schema's own spelling of "clear this field" -- the same
        // meaning `|| null` gives it here that a blank has always had for
        // this service's other writers (updateCompanyProfile's own `text()`).
        fromName: parsed.data.fromName || null,
        fromAddress: parsed.data.fromAddress || null,
        replyTo: parsed.data.replyTo || null,
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
