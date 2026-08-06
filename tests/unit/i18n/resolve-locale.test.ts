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
  it('refuses a language whose catalogue is not there, whatever asked for it', () => {
    // The clamp itself, asserted against an explicit set rather than the
    // constant, so it keeps testing the MECHANISM after Block 12b opened the
    // constant to all three. `es` is a real locale and a real catalogue; what
    // makes it refused here is not being on offer.
    expect(resolveLocale({ profile: 'es', available: ['en'] })).toBe('en');
    expect(resolveLocale({ cookie: 'es', available: ['en'] })).toBe('en');
    expect(resolveLocale({ acceptLanguage: 'es-ES,es;q=0.9', available: ['en'] })).toBe('en');
  });

  it('answers a Brazilian browser in Portuguese now that pt.json exists', () => {
    // The other half of the same rule. Before 12b wrote the catalogue this had
    // to answer English; the constant is what changed, and nothing else.
    expect(resolveLocale({ acceptLanguage: 'pt-BR,pt;q=0.9,en;q=0.8' })).toBe('pt');
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

  it('offers exactly the three languages the product has catalogues for', () => {
    // catalogue.test.ts is the other half: it pins a file on disk for each of
    // these. Adding a fourth here without writing its catalogue fails there.
    expect([...AVAILABLE_LOCALES]).toEqual(['en', 'pt', 'es']);
  });

  it('can always fall back, because the default is itself available', () => {
    expect(isAvailable(DEFAULT_LOCALE)).toBe(true);
  });
});
