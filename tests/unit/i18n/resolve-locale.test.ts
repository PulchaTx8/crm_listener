import { describe, expect, it } from 'vitest';
import {
  AVAILABLE_LOCALES,
  DEFAULT_LOCALE,
  SUPPORTED_LOCALES,
  isAvailable,
  isLocale,
  resolveLocale,
} from '@/i18n/locales';

// The order is only observable when there is more than one answer to choose
// between, and Block 12a ships one catalogue. These cases pass the full set
// explicitly; the block below then pins what happens with the real one.
const ALL = [...SUPPORTED_LOCALES];

describe('the resolution order', () => {
  it('prefers the profile, which follows the person between browsers', () => {
    expect(resolveLocale({ profile: 'pt', cookie: 'es', acceptLanguage: 'en-US', available: ALL })).toBe('pt');
  });

  it('falls to the cookie, which is all anybody has before signing in', () => {
    expect(resolveLocale({ cookie: 'es', acceptLanguage: 'en-US', available: ALL })).toBe('es');
  });

  it('falls to what the browser asks for', () => {
    expect(resolveLocale({ acceptLanguage: 'pt-BR,pt;q=0.9,en;q=0.8', available: ALL })).toBe('pt');
  });

  it('reads a quality-ordered header rather than taking the first token', () => {
    // "French, or Spanish if you must." French is not offered, so the answer is
    // Spanish -- not English, and not the first tag in the list.
    expect(resolveLocale({ acceptLanguage: 'fr-FR,fr;q=0.9,es;q=0.7', available: ALL })).toBe('es');
  });

  it('ends at English when nothing says otherwise', () => {
    expect(resolveLocale({ available: ALL })).toBe(DEFAULT_LOCALE);
    expect(resolveLocale({ acceptLanguage: 'ja-JP,ja;q=0.9', available: ALL })).toBe('en');
  });

  it('ignores a value that is not one of the three', () => {
    // A cookie is client-writable, and a locale reaches a filename downstream.
    expect(resolveLocale({ profile: 'jp', cookie: 'zz', available: ALL })).toBe('en');
  });

  it('knows what a locale is', () => {
    expect(isLocale('pt')).toBe(true);
    expect(isLocale('jp')).toBe(false);
    expect(isLocale(undefined)).toBe(false);
  });
});

describe('and it never names a catalogue that does not exist', () => {
  // The failure this guards is not a wrong language on screen. resolveLocale's
  // answer becomes a filename in src/i18n/request.ts, so an answer of `pt`
  // while messages/pt.json is unwritten is a crashed render -- on every route,
  // public ones included, for every visitor whose browser prefers Portuguese.
  it('answers a Brazilian browser in English while pt is unwritten', () => {
    expect(resolveLocale({ acceptLanguage: 'pt-BR,pt;q=0.9,en;q=0.8' })).toBe('en');
  });

  it('ignores a supported-but-unavailable cookie, which anyone can write', () => {
    expect(resolveLocale({ cookie: 'pt' })).toBe('en');
    expect(resolveLocale({ cookie: 'es' })).toBe('en');
  });

  it('ignores a profile holding a language that cannot be rendered yet', () => {
    // Reachable today by writing profiles.locale directly, and normal the day
    // Block 12b opens the constant without shipping every catalogue at once.
    expect(resolveLocale({ profile: 'pt' })).toBe('en');
  });

  it('answers only with something AVAILABLE_LOCALES holds, whatever it is given', () => {
    const headers = [
      'pt-BR,pt;q=0.9,en;q=0.8',
      'es-ES,es;q=0.9',
      'fr-FR,fr;q=0.9,pt;q=0.7',
      'ja-JP,ja;q=0.9',
      '',
      'pt;q=x',
    ];
    for (const acceptLanguage of headers) {
      for (const profile of [...ALL, 'jp', null]) {
        for (const cookie of [...ALL, 'zz', null]) {
          const answer = resolveLocale({ profile, cookie, acceptLanguage });
          expect(isAvailable(answer), `${profile}/${cookie}/${acceptLanguage} -> ${answer}`).toBe(true);
        }
      }
    }
  });

  it('offers only English while the other catalogues do not exist', () => {
    // D4: the selector renders nothing until there is something to select, so
    // nobody ever picks "Português" and receives English.
    expect([...AVAILABLE_LOCALES]).toEqual(['en']);
  });

  it('can always fall back, because the default is itself available', () => {
    expect(isAvailable(DEFAULT_LOCALE)).toBe(true);
  });
});
