import { describe, expect, it } from 'vitest';
import { localeCookieUpdate } from '@/i18n/locales';

describe('keeping the cookie in step with the profile', () => {
  it('writes the profile choice into a browser that has not heard it', () => {
    expect(localeCookieUpdate({ profile: 'pt', cookie: null })).toBe('pt');
  });

  it('corrects a browser that disagrees', () => {
    // The profile is the choice that travels with the person; the cookie is
    // just this browser's memory of it, so the profile wins.
    expect(localeCookieUpdate({ profile: 'pt', cookie: 'es' })).toBe('pt');
  });

  it('writes nothing when they already agree', () => {
    // Rewriting an identical cookie would put a Set-Cookie on every response in
    // the product, for nothing.
    expect(localeCookieUpdate({ profile: 'pt', cookie: 'pt' })).toBeNull();
  });

  it('leaves the cookie alone when the person never chose', () => {
    // A null profile is not a preference for English: the cookie may hold a
    // choice made before signing in, and it outranks the browser header.
    expect(localeCookieUpdate({ profile: null, cookie: 'es' })).toBeNull();
    expect(localeCookieUpdate({ profile: null, cookie: null })).toBeNull();
  });

  it('ignores a profile value that is not a locale', () => {
    expect(localeCookieUpdate({ profile: 'jp', cookie: 'en' })).toBeNull();
  });
});
