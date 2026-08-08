import { describe, expect, it } from 'vitest';
import {
  BRANDING_BUCKET,
  LOGIN_HERO_KEY,
  loginHeroPublicUrl,
  versionStampFrom,
} from '@/lib/branding/login-hero';

describe('loginHeroPublicUrl', () => {
  it('builds the public address with a version stamp', () => {
    expect(loginHeroPublicUrl('https://abc.supabase.co', '036495e6')).toBe(
      'https://abc.supabase.co/storage/v1/object/public/branding/login-hero.png?v=036495e6',
    );
  });

  it('STILL BUILDS AN ADDRESS WITH NO STAMP AT ALL', () => {
    // The defect this module was rewritten for. The stamp is a cache
    // optimisation; the picture is the feature. The first version returned null
    // when it could not obtain a stamp, which took the picture off the hosted
    // sign-in screen entirely while the object sat there serving 200.
    expect(loginHeroPublicUrl('https://abc.supabase.co', null)).toBe(
      'https://abc.supabase.co/storage/v1/object/public/branding/login-hero.png',
    );
  });

  it('tolerates the trailing slash a configured URL may carry', () => {
    // .env.hosted.local really does end in one, and two slashes in a storage
    // path is a 400 rather than a redirect. artwork-keys.ts carries the same
    // guard for the same reason.
    expect(loginHeroPublicUrl('https://abc.supabase.co/', '1')).toBe(
      'https://abc.supabase.co/storage/v1/object/public/branding/login-hero.png?v=1',
    );
  });

  it('keeps the local http origin intact', () => {
    // Development's Storage is http://127.0.0.1:54321, and the e2e suite reads
    // the picture from there.
    expect(loginHeroPublicUrl('http://127.0.0.1:54321', '7')).toBe(
      'http://127.0.0.1:54321/storage/v1/object/public/branding/login-hero.png?v=7',
    );
  });

  it('escapes a stamp that is not already URL-safe', () => {
    // A weak ETag is delivered as W/"abc", and Storage's multipart form carries
    // a dash. Neither may be pasted into a query string unexamined.
    expect(loginHeroPublicUrl('https://x.co', 'W/abc def')).toContain('?v=W%2Fabc%20def');
  });

  it('changes when the object is replaced, which is the whole reason for the stamp', () => {
    expect(loginHeroPublicUrl('https://x.co', '1')).not.toBe(loginHeroPublicUrl('https://x.co', '2'));
  });

  it('addresses the public endpoint, which is the one that consults no policy', () => {
    // /object/public/ is what `public = true` on the bucket buys, and it is now
    // the ONLY thing this feature depends on — no RLS policy, no key, no
    // migration having run. /object/ or /object/sign/ would need a session or a
    // signature, and the reader of this screen has neither.
    expect(loginHeroPublicUrl('https://x.co', null)).toContain('/storage/v1/object/public/');
  });

  it('names the bucket and key the migration and the seed script agree on', () => {
    // 0146_branding_bucket.sql creates 'branding'; scripts/seed-branding.mjs
    // uploads 'login-hero.png'. Three files have to say the same two words.
    expect(BRANDING_BUCKET).toBe('branding');
    expect(LOGIN_HERO_KEY).toBe('login-hero.png');
  });
});

describe('versionStampFrom', () => {
  const headers = (init: Record<string, string>) => new Headers(init);

  it('prefers the ETag, which Storage derives from the bytes', () => {
    // Measured against the hosted project:
    //   ETag: "036495e643aa359b34f3deb9989ee81c-1"
    expect(versionStampFrom(headers({ etag: '"036495e643aa359b34f3deb9989ee81c-1"' }))).toBe(
      '036495e643aa359b34f3deb9989ee81c-1',
    );
  });

  it('strips the quotes an ETag is delivered inside', () => {
    expect(versionStampFrom(headers({ etag: '"abc"' }))).not.toContain('"');
  });

  it('falls back to Last-Modified, reduced to epoch milliseconds', () => {
    expect(versionStampFrom(headers({ 'last-modified': 'Sat, 08 Aug 2026 09:51:30 GMT' }))).toBe(
      String(Date.parse('Sat, 08 Aug 2026 09:51:30 GMT')),
    );
  });

  it('answers null when the response carries neither', () => {
    // Not an error, and not a substitute value: the caller renders the picture
    // unstamped rather than not at all. A made-up stamp — Date.now(), say —
    // would change on every render and defeat caching entirely.
    expect(versionStampFrom(headers({}))).toBeNull();
  });

  it('answers null rather than NaN for a Last-Modified it cannot parse', () => {
    expect(versionStampFrom(headers({ 'last-modified': 'not a date' }))).toBeNull();
  });
});
