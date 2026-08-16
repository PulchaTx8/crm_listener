/**
 * Block 25, D1. Which theme a person sees, and how that is decided.
 *
 * Deliberately free of Next imports, exactly as `src/i18n/locales.ts` is. This
 * is the one piece of the resolution that can be asserted directly, and
 * everything above it — the middleware, the root layout, the Server Action — is
 * plumbing around these functions.
 */

/** What can be STORED. 'system' is not among them: NULL already says it (D6). */
export type Theme = 'light' | 'dark';

/** What can be CHOSEN. The extra member is the whole distance between the two guards. */
export type ThemeChoice = Theme | 'system';

/**
 * The order the menu renders.
 *
 * System first because it is the DEFAULT state, not because it is the safest: a
 * person who has never opened this menu is already on it, and a list whose first
 * row is the one they are on reads as a list rather than as a form they failed
 * to fill in.
 */
export const THEME_CHOICES = ['system', 'light', 'dark'] as const satisfies readonly ThemeChoice[];

/** Matches the check constraint in 0201. */
const STORABLE: readonly string[] = ['light', 'dark'];

export function isTheme(value: string | undefined | null): value is Theme {
  return typeof value === 'string' && STORABLE.includes(value);
}

export function isThemeChoice(value: string | undefined | null): value is ThemeChoice {
  return isTheme(value) || value === 'system';
}

/**
 * Profile, then cookie, then System.
 *
 * NULL IS THE ANSWER FOR SYSTEM, not a failure to answer. It is what stamps no
 * class on `<html>`, which is what lets the browser's own
 * `prefers-color-scheme` decide at first paint — the mechanism this whole design
 * turns on, and the reason there is no flash and no JavaScript anywhere in it.
 *
 * Every input is untrusted: the cookie is client-writable and the profile is a
 * column a future migration could widen. Anything that is not one of the two
 * storable themes is discarded rather than passed along — what this returns
 * becomes a class name on the document element.
 */
export function resolveTheme(input: {
  profile?: string | null;
  cookie?: string | null;
}): Theme | null {
  if (isTheme(input.profile)) return input.profile;
  if (isTheme(input.cookie)) return input.cookie;
  return null;
}

/**
 * What the browser's cookie should become: a theme to write, `'clear'` to remove
 * it, or null to leave it alone.
 *
 * The profile is the choice that travels with the person; the cookie is one
 * browser's memory of it. Returning null when they already agree is not an
 * optimisation — without it every response in the product carries a Set-Cookie
 * that changes nothing, which is the reasoning `localeCookieUpdate` records for
 * its own null.
 *
 * `'clear'` IS THE STATE THE LOCALE HAS NO USE FOR, and it is not symmetry for
 * its own sake. A locale cannot be un-chosen; a theme can, because System IS a
 * choice and it is stored as NULL. So `localeCookieUpdate`'s rule — "somebody
 * who never chose has no opinion to impose, and their cookie may well hold a
 * choice they made before signing in" — does not transfer: there is no way to
 * set a theme cookie while signed out, since the menu lives in the signed-in
 * shell and the public pages deliberately have no theme control at all (D8).
 *
 * So a NULL profile beside a cookie means exactly one thing — this person chose
 * System after having chosen something — and refusing to clear would leave their
 * other browser dark for ever, which is the choice failing to travel in
 * precisely the direction it was asked to.
 */
export function themeCookieUpdate(input: {
  profile?: string | null;
  cookie?: string | null;
}): Theme | 'clear' | null {
  // Junk collapses into this branch rather than getting one of its own:
  // profiles_theme_supported (0201) makes it unreachable, and "not a stored
  // theme" is System by definition.
  if (!isTheme(input.profile)) {
    return input.cookie ? 'clear' : null;
  }
  return input.cookie === input.profile ? null : input.profile;
}
