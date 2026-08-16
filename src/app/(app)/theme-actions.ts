'use server';

import { cookies } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { createUserClient } from '@/lib/supabase/user-client';
import { logger } from '@/lib/logger';
import { isTheme, isThemeChoice, THEME_COOKIE } from '@/lib/theme/theme';

/**
 * Block 25. Records a theme choice in both places it has to live: the profile,
 * which follows the person to any browser, and the cookie, which is what the
 * middleware reads back on the very next request.
 *
 * THE COOKIE IS WRITTEN FIRST, and even when the profile write fails — the same
 * rule setLocaleAction states, for the same reason: somebody whose profile write
 * failed should still get the theme they just asked for in the browser they
 * asked for it in. What is lost in that case is the choice travelling with them,
 * which is the smaller half.
 *
 * SYSTEM IS A DELETION, not a value. `profiles.theme` has no 'system' — NULL
 * already says it (0201) — so choosing it removes the cookie and nulls the
 * column, and the absence of a class is what the renderer does with that.
 */
export async function setThemeAction(formData: FormData): Promise<void> {
  // Refuse anything that is not one of the three, however it was submitted. The
  // menu only offers what THEME_CHOICES holds; a form post is not obliged to
  // agree with the menu that rendered it, and what this accepts reaches a class
  // name on the document element.
  const chosen = formData.get('theme');
  if (typeof chosen !== 'string' || !isThemeChoice(chosen)) return;

  const store = await cookies();
  if (isTheme(chosen)) {
    store.set(THEME_COOKIE, chosen, {
      path: '/',
      maxAge: 60 * 60 * 24 * 365,
      sameSite: 'lax',
    });
  } else {
    store.delete(THEME_COOKIE);
  }

  try {
    const supabase = await createUserClient();
    const { data } = await supabase.auth.getUser();
    if (data.user) {
      // The row is READ BACK rather than trusted, and the .select() is what does
      // it. An error RESULT is not a throw, and RLS refuses by matching no row
      // rather than by failing -- so a policy that stopped this write would
      // return no error and no row, and checking only `error` would call that
      // success. (A missing column grant is the other failure and does raise:
      // 42501, which is what 0201's grant exists to prevent. Both are covered
      // here, by different halves of this check.)
      const stored = isTheme(chosen) ? chosen : null;
      const { data: updated, error } = await supabase
        .from('profiles')
        .update({ theme: stored })
        .eq('id', data.user.id)
        .select('theme')
        .maybeSingle();
      if (error) throw new Error(error.message);
      // `!== stored` covers the System case too: null must come back null, and a
      // policy that silently declined would come back undefined.
      if (updated?.theme !== stored) throw new Error('the profile did not take the choice');
    }
  } catch (cause) {
    logger.error({ err: cause }, 'could not persist the theme choice to the profile');
  }

  revalidatePath('/', 'layout');
}
