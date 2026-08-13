import { describe, expect, it } from 'vitest';
import { artworkKey, artworkPublicUrl } from '@/lib/storage/artwork-keys';

const COMPANY = '11111111-1111-1111-1111-111111111111';
const RECORD = '22222222-2222-2222-2222-222222222222';

describe('artworkKey', () => {
  it('names the slot, the Station and the record, and nothing else', () => {
    expect(artworkKey('promotion-banners', COMPANY, RECORD)).toBe(
      `promotion-banners/${COMPANY}/${RECORD}`,
    );
  });

  it('carries no file extension, which is what makes a re-upload a replacement', () => {
    expect(artworkKey('prize-photos', COMPANY, RECORD)).not.toMatch(/\.(jpg|jpeg|png)$/);
  });

  it('puts the Station second, where the bucket policy reads it', () => {
    // may_write_artwork (0143) reads storage.foldername(name)[2] and asks
    // has_permission about it. A key that put the Station anywhere else would
    // pass that policy at the wrong Station or at none.
    expect(artworkKey('promotion-thumbs', COMPANY, RECORD).split('/')[1]).toBe(COMPANY);
  });

  it('gives a promotion two different keys for its two different pictures', () => {
    expect(artworkKey('promotion-thumbs', COMPANY, RECORD)).not.toBe(
      artworkKey('promotion-banners', COMPANY, RECORD),
    );
  });
});

describe('artworkKey for album covers', () => {
  /**
   * The company id is the SECOND segment because may_write_artwork (0143)
   * reads storage.foldername(name)[2] and decides from the path alone. Get
   * the order wrong and the policy asks has_permission about a slot name.
   */
  it('puts the Station second and the album third', () => {
    expect(artworkKey('album-covers', 'c0000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000002'))
      .toBe('album-covers/c0000000-0000-0000-0000-000000000001/a0000000-0000-0000-0000-000000000002');
  });

  /**
   * No extension, deliberately: that is what makes "uploading again replaces
   * the last one" structural rather than hopeful.
   */
  it('carries no file extension', () => {
    expect(artworkKey('album-covers', 'c1', 'a1')).not.toMatch(/\.(jpg|jpeg|png)$/);
  });
});

describe('artworkPublicUrl', () => {
  it('builds the public address with a version stamp', () => {
    expect(artworkPublicUrl('https://abc.supabase.co', 'prize-photos/a/b', 1754582400000)).toBe(
      'https://abc.supabase.co/storage/v1/object/public/artwork/prize-photos/a/b?v=1754582400000',
    );
  });

  it('tolerates the trailing slash a configured URL may carry', () => {
    // .env.hosted.local really does end in one, and two slashes in a storage
    // path is a 400 rather than a redirect.
    expect(artworkPublicUrl('https://abc.supabase.co/', 'prize-photos/a/b', 1)).toBe(
      'https://abc.supabase.co/storage/v1/object/public/artwork/prize-photos/a/b?v=1',
    );
  });

  it('keeps the local http origin intact', () => {
    // Development's Storage is http://127.0.0.1:54321. promotions_art_https
    // was relaxed for exactly this (0144); silently upgrading it here would
    // produce an address that resolves to nothing.
    expect(artworkPublicUrl('http://127.0.0.1:54321', 'promotion-banners/a/b', 7)).toBe(
      'http://127.0.0.1:54321/storage/v1/object/public/artwork/promotion-banners/a/b?v=7',
    );
  });

  it('changes on every upload, which is the whole reason for the stamp', () => {
    // The key is derived from the record, so the address is stable and the CDN
    // would go on serving the picture that was just replaced.
    const key = 'promotion-banners/a/b';
    expect(artworkPublicUrl('https://x.co', key, 1)).not.toBe(artworkPublicUrl('https://x.co', key, 2));
  });
});
