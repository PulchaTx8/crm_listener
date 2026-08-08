import { describe, expect, it } from 'vitest';
import { BRANDING_BUCKET, LOGIN_HERO_KEY, loginHeroPublicUrl } from '@/lib/branding/login-hero';

describe('loginHeroPublicUrl', () => {
  it('builds the public address with a version stamp', () => {
    expect(loginHeroPublicUrl('https://abc.supabase.co', 1754582400000)).toBe(
      'https://abc.supabase.co/storage/v1/object/public/branding/login-hero.png?v=1754582400000',
    );
  });

  it('tolerates the trailing slash a configured URL may carry', () => {
    // .env.hosted.local really does end in one, and two slashes in a storage
    // path is a 400 rather than a redirect. artwork-keys.ts carries the same
    // guard for the same reason.
    expect(loginHeroPublicUrl('https://abc.supabase.co/', 1)).toBe(
      'https://abc.supabase.co/storage/v1/object/public/branding/login-hero.png?v=1',
    );
  });

  it('keeps the local http origin intact', () => {
    // Development's Storage is http://127.0.0.1:54321, and the e2e suite reads
    // the picture from there.
    expect(loginHeroPublicUrl('http://127.0.0.1:54321', 7)).toBe(
      'http://127.0.0.1:54321/storage/v1/object/public/branding/login-hero.png?v=7',
    );
  });

  it('changes when the object is replaced, which is the whole reason for the stamp', () => {
    // The key is a constant, so the address never changes on its own and the
    // browser goes on serving the picture that was just replaced.
    expect(loginHeroPublicUrl('https://x.co', 1)).not.toBe(loginHeroPublicUrl('https://x.co', 2));
  });

  it('addresses the public endpoint, which is the one that consults no policy', () => {
    // /object/public/ is what `public = true` on the bucket buys. /object/ or
    // /object/sign/ would need a session or a signature, and the reader of this
    // screen has neither.
    expect(loginHeroPublicUrl('https://x.co', 1)).toContain('/storage/v1/object/public/');
  });

  it('names the bucket and key the migration and the seed script agree on', () => {
    // 0146_branding_bucket.sql creates 'branding'; scripts/seed-branding.mjs
    // uploads 'login-hero.png'. Three files have to say the same two words.
    expect(BRANDING_BUCKET).toBe('branding');
    expect(LOGIN_HERO_KEY).toBe('login-hero.png');
  });
});
