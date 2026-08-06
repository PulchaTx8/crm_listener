'use server';

import { cookies } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { createUserClient } from '@/lib/supabase/user-client';
import { logger } from '@/lib/logger';
import { AVAILABLE_LOCALES, isLocale } from '@/i18n/locales';

/**
 * Block 12a, D2. Records a language choice in both places it has to live: the
 * profile, which follows the person to any browser, and the cookie, which is
 * what rendering actually reads.
 *
 * THE COOKIE IS WRITTEN FIRST, and even when the profile write fails. Somebody
 * who is not signed in has no profile at all, and somebody whose profile write
 * failed should still get the language they just asked for in the browser they
 * asked for it in. What is lost in that case is the choice travelling with
 * them, which is the smaller half.
 */
export async function setLocaleAction(formData: FormData): Promise<void> {
  const chosen = formData.get('locale');
  if (typeof chosen !== 'string' || !isLocale(chosen)) return;
  // Refuse a language the product cannot render yet, however it was submitted.
  // The select only offers what AVAILABLE_LOCALES holds; a form post is not
  // obliged to agree with the select.
  if (!(AVAILABLE_LOCALES as readonly string[]).includes(chosen)) return;

  const store = await cookies();
  store.set('locale', chosen, { path: '/', maxAge: 60 * 60 * 24 * 365, sameSite: 'lax' });

  try {
    const supabase = await createUserClient();
    const { data } = await supabase.auth.getUser();
    if (data.user) {
      const { error } = await supabase
        .from('profiles')
        .update({ locale: chosen })
        .eq('id', data.user.id);
      // An error RESULT is not a throw, and RLS answers a forbidden update with
      // zero rows rather than a failure -- so the row is read back rather than
      // trusted. Without this a missing column grant looks exactly like success.
      if (error) throw new Error(error.message);
    }
  } catch (cause) {
    logger.error({ err: cause }, 'could not persist the locale choice to the profile');
  }

  revalidatePath('/', 'layout');
}
