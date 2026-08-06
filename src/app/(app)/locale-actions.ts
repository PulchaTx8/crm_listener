'use server';

import { cookies } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { createUserClient } from '@/lib/supabase/user-client';
import { logger } from '@/lib/logger';
import { isAvailable } from '@/i18n/locales';

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
  // Refuse a language the product cannot render yet, however it was submitted.
  // The select only offers what AVAILABLE_LOCALES holds; a form post is not
  // obliged to agree with the select. isAvailable rather than isLocale, and the
  // same predicate the resolution uses -- a choice this accepted but resolution
  // would not is a cookie naming a catalogue that does not exist.
  const chosen = formData.get('locale');
  if (typeof chosen !== 'string' || !isAvailable(chosen)) return;

  const store = await cookies();
  store.set('locale', chosen, { path: '/', maxAge: 60 * 60 * 24 * 365, sameSite: 'lax' });

  try {
    const supabase = await createUserClient();
    const { data } = await supabase.auth.getUser();
    if (data.user) {
      // The row is READ BACK rather than trusted, and the .select() is what
      // does it. An error RESULT is not a throw, and RLS refuses by matching no
      // row rather than by failing -- so a policy that stopped this write would
      // return no error and no row, and checking only `error` would call that
      // success. (A missing column grant is the other failure and does raise:
      // 42501. Both are covered here, by different halves of this check.)
      const { data: updated, error } = await supabase
        .from('profiles')
        .update({ locale: chosen })
        .eq('id', data.user.id)
        .select('locale')
        .maybeSingle();
      if (error) throw new Error(error.message);
      if (updated?.locale !== chosen) throw new Error('the profile did not take the choice');
    }
  } catch (cause) {
    logger.error({ err: cause }, 'could not persist the locale choice to the profile');
  }

  revalidatePath('/', 'layout');
}
