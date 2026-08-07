import { describe, expect, it } from 'vitest';
import { coverUrl } from '@/lib/integrations/deezer/cover';

describe('coverUrl', () => {
  it('builds the CDN URL from the hash', () => {
    expect(coverUrl('2a0f6ac6bc05458fb072275653f01dd2', 56)).toBe(
      'https://cdn-images.dzcdn.net/images/cover/2a0f6ac6bc05458fb072275653f01dd2/56x56-000000-80-0-0.jpg',
    );
  });

  it('serves each size off the one hash', () => {
    const md5 = '2a0f6ac6bc05458fb072275653f01dd2';
    expect(coverUrl(md5, 250)).toContain('/250x250-');
    expect(coverUrl(md5, 500)).toContain('/500x500-');
  });

  it('answers null for a song with no album, so callers render the fallback', () => {
    expect(coverUrl(null, 250)).toBeNull();
    expect(coverUrl(undefined, 250)).toBeNull();
    expect(coverUrl('', 250)).toBeNull();
  });

  // 0136 constrains the column, but this module is also fed by live search
  // results that never touched the database — so the guard lives here too.
  it('refuses anything that is not a 32-character hex hash', () => {
    expect(coverUrl('../../etc/passwd', 250)).toBeNull();
    expect(coverUrl('2a0f6ac6bc05458fb072275653f01dd', 250)).toBeNull();
    expect(coverUrl('2A0F6AC6BC05458FB072275653F01DD2', 250)).toBeNull();
    expect(coverUrl('x'.repeat(32), 250)).toBeNull();
  });
});
