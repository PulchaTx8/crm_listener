import { describe, expect, it } from 'vitest';
import {
  isTheme,
  isThemeChoice,
  resolveTheme,
  themeCookieUpdate,
  THEME_CHOICES,
} from '@/lib/theme/theme';

/**
 * Block 25. The resolution, asserted directly — which is the whole reason
 * `src/lib/theme/theme.ts` is free of Next imports, exactly as
 * `src/i18n/locales.ts` is. Everything above these functions (the middleware,
 * the layout, the Server Action) is plumbing around them.
 */

describe('the theme vocabulary', () => {
  // The order the menu renders. System first because it is the DEFAULT state —
  // a person who has never opened this menu is already on it.
  it('offers System first', () => {
    expect(THEME_CHOICES).toEqual(['system', 'light', 'dark']);
  });

  // Every input is untrusted: the cookie is client-writable and a form post is
  // not obliged to agree with the menu that rendered.
  it('refuses anything that is not a theme', () => {
    for (const junk of ['', 'SYSTEM', 'Dark', 'darkmode', '../etc', null, undefined]) {
      expect(isTheme(junk as string | null), String(junk)).toBe(false);
      expect(isThemeChoice(junk as string | null), String(junk)).toBe(false);
    }
  });

  // The distance between the two guards is the point: 'system' is a choice a
  // person may MAKE and is not a value the database stores, because NULL already
  // says it.
  it('tells a storable theme from a choosable one', () => {
    expect(isTheme('system')).toBe(false);
    expect(isThemeChoice('system')).toBe(true);
    for (const theme of ['light', 'dark']) {
      expect(isTheme(theme)).toBe(true);
      expect(isThemeChoice(theme)).toBe(true);
    }
  });
});

describe('resolveTheme', () => {
  /**
   * NULL IS THE ANSWER FOR SYSTEM, not a failure to answer. It is what stamps no
   * class on <html>, which is what lets the browser's own prefers-color-scheme
   * decide at first paint — the mechanism D1 turns on.
   */
  it('answers null when nobody has chosen', () => {
    expect(resolveTheme({})).toBeNull();
    expect(resolveTheme({ profile: null, cookie: null })).toBeNull();
  });

  it('prefers the profile, which follows the person between browsers', () => {
    expect(resolveTheme({ profile: 'dark', cookie: 'light' })).toBe('dark');
    expect(resolveTheme({ profile: 'light', cookie: 'dark' })).toBe('light');
  });

  it('falls to the cookie for somebody with no profile choice', () => {
    expect(resolveTheme({ profile: null, cookie: 'dark' })).toBe('dark');
  });

  /**
   * A COOKIE OF 'system' IS NOT NOTHING, and this is the case a naive
   * implementation gets wrong. Somebody who chose System while signed out holds
   * `theme=system`; that is an ANSWER — do not stamp — rather than an absence to
   * fall through. Both roads reach null here, so the assertion is about the
   * value being recognised rather than discarded as junk.
   */
  it('reads a cookie of system as System rather than as junk', () => {
    expect(resolveTheme({ cookie: 'system' })).toBeNull();
  });

  it('discards junk in either input rather than passing it on', () => {
    expect(resolveTheme({ profile: 'neon', cookie: 'dark' })).toBe('dark');
    expect(resolveTheme({ profile: null, cookie: 'neon' })).toBeNull();
  });
});

/**
 * The sibling of `localeCookieUpdate`, and it needs one state that function has
 * no use for.
 *
 * A locale cannot be un-chosen: `profiles.locale` going from 'pt' to NULL is not
 * something any screen can ask for. A theme can — System is a choice, and it is
 * stored as NULL. So "the profile says System" has to be able to CLEAR a browser
 * still holding 'dark', or the choice would fail to travel in exactly the
 * direction the owner asked it to travel.
 */
describe('themeCookieUpdate', () => {
  it('writes the profile onto a browser that disagrees', () => {
    expect(themeCookieUpdate({ profile: 'dark', cookie: 'light' })).toBe('dark');
    expect(themeCookieUpdate({ profile: 'dark', cookie: undefined })).toBe('dark');
  });

  // Not an optimisation: without it every response in the product carries a
  // Set-Cookie that changes nothing — the reasoning localeCookieUpdate records.
  it('leaves a browser that already agrees alone', () => {
    expect(themeCookieUpdate({ profile: 'dark', cookie: 'dark' })).toBeNull();
  });

  it('clears a stale cookie when the profile chose System', () => {
    expect(themeCookieUpdate({ profile: null, cookie: 'dark' })).toBe('clear');
    expect(themeCookieUpdate({ profile: null, cookie: 'system' })).toBe('clear');
  });

  /**
   * A NULL profile only clears a cookie that EXISTS; with no cookie there is
   * nothing to say, and a Set-Cookie that changes nothing on every response is
   * what this whole function exists to avoid.
   *
   * THIS IS WHERE THE THEME PARTS COMPANY WITH THE LOCALE, and the reason is
   * worth stating because the two functions otherwise read alike.
   * `localeCookieUpdate` refuses to let a NULL profile touch the cookie at all:
   * "somebody who never chose has no opinion to impose, and their cookie may
   * well hold a choice they made before signing in."
   *
   * That reasoning does not reach here, because there is no way to set a THEME
   * cookie while signed out: the menu lives in the signed-in shell, and the
   * public pages deliberately have no theme control at all (D8). So a NULL
   * profile beside a cookie means exactly one thing — this person chose System
   * after having chosen something — and refusing to clear would leave the other
   * browser dark for ever, which is the choice failing to travel in precisely
   * the direction the owner asked it to.
   */
  it('says nothing when the profile is null and the browser holds nothing', () => {
    expect(themeCookieUpdate({ profile: null, cookie: undefined })).toBeNull();
    expect(themeCookieUpdate({ profile: null, cookie: null })).toBeNull();
  });

  /**
   * Unreachable through the database — `profiles_theme_supported` refuses
   * anything but the two — so this pins a collapse rather than a branch: junk is
   * not a stored theme, "no stored theme" is System, and System clears. Asserted
   * so that a future reader does not add a third branch for it.
   */
  it('collapses a junk profile into the System branch rather than writing it', () => {
    expect(themeCookieUpdate({ profile: 'neon', cookie: 'dark' })).toBe('clear');
  });
});
