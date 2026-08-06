import { describe, expect, it } from 'vitest';
import { AVAILABLE_LOCALES, DEFAULT_LOCALE, isLocale, resolveLocale } from '@/i18n/locales';

describe('the resolution order', () => {
  it('prefers the profile, which follows the person between browsers', () => {
    expect(resolveLocale({ profile: 'pt', cookie: 'es', acceptLanguage: 'en-US' })).toBe('pt');
  });

  it('falls to the cookie, which is all anybody has before signing in', () => {
    expect(resolveLocale({ cookie: 'es', acceptLanguage: 'en-US' })).toBe('es');
  });

  it('falls to what the browser asks for', () => {
    expect(resolveLocale({ acceptLanguage: 'pt-BR,pt;q=0.9,en;q=0.8' })).toBe('pt');
  });

  it('reads a quality-ordered header rather than taking the first token', () => {
    // "French, or Spanish if you must." French is not offered, so the answer is
    // Spanish -- not English, and not the first tag in the list.
    expect(resolveLocale({ acceptLanguage: 'fr-FR,fr;q=0.9,es;q=0.7' })).toBe('es');
  });

  it('ends at English when nothing says otherwise', () => {
    expect(resolveLocale({})).toBe(DEFAULT_LOCALE);
    expect(resolveLocale({ acceptLanguage: 'ja-JP,ja;q=0.9' })).toBe('en');
  });

  it('ignores a value that is not one of the three', () => {
    // A cookie is client-writable, and a locale reaches a filename downstream.
    expect(resolveLocale({ profile: 'jp', cookie: 'zz' })).toBe('en');
  });

  it('knows what a locale is', () => {
    expect(isLocale('pt')).toBe(true);
    expect(isLocale('jp')).toBe(false);
    expect(isLocale(undefined)).toBe(false);
  });

  it('offers only English while the other catalogues do not exist', () => {
    // D4: the selector renders nothing until there is something to select, so
    // nobody ever picks "Português" and receives English.
    expect([...AVAILABLE_LOCALES]).toEqual(['en']);
  });
});
