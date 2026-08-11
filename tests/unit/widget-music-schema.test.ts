import { describe, expect, it } from 'vitest';
import { requestSongSchema, searchSchema } from '@/schemas/widget-music';

/**
 * Block 17b. What the widget's music panel is allowed to post.
 *
 * These bounds are not decoration: `query` becomes a Deezer request and a
 * rate-limit key, and `deezerTrackId` becomes an argument to a door that will
 * create a row in a Station's catalogue.
 */
describe('searchSchema', () => {
  it('refuses one character and accepts two', () => {
    expect(searchSchema.safeParse({ query: 'a' }).success).toBe(false);
    expect(searchSchema.safeParse({ query: 'ab' }).success).toBe(true);
  });

  it('trims before measuring, so three spaces are not a search', () => {
    expect(searchSchema.safeParse({ query: '   ' }).success).toBe(false);
    expect(searchSchema.parse({ query: '  sozinho  ' }).query).toBe('sozinho');
  });

  it('caps the length of a string that becomes a rate-limit key', () => {
    expect(searchSchema.safeParse({ query: 'x'.repeat(120) }).success).toBe(true);
    expect(searchSchema.safeParse({ query: 'x'.repeat(121) }).success).toBe(false);
  });

  it('refuses a field this product does not know', () => {
    expect(searchSchema.safeParse({ query: 'sozinho', limit: 500 }).success).toBe(false);
  });
});

describe('requestSongSchema', () => {
  it('takes the track id off a form as a string and yields a number', () => {
    const parsed = requestSongSchema.parse({ deezerTrackId: '3135556', note: '' });
    expect(parsed.deezerTrackId).toBe(3135556);
  });

  /**
   * `z.coerce.number()` reads like the same rule and is not: it accepts '1.5',
   * turns '' into 0 and ' 12 ' into 12. A Deezer id is a positive integer or it
   * is nothing — the same reasoning verifySchema gives for keeping a six-digit
   * code a string with a regex rather than a number.
   */
  it('refuses anything that is not a positive integer', () => {
    for (const deezerTrackId of ['0', '-3', '1.5', 'abc', '', ' 12 ', '01']) {
      expect(requestSongSchema.safeParse({ deezerTrackId, note: '' }).success).toBe(false);
    }
  });

  it('treats an empty note as no note rather than as an empty one', () => {
    expect(requestSongSchema.parse({ deezerTrackId: '1', note: '' }).note).toBeUndefined();
    expect(requestSongSchema.parse({ deezerTrackId: '1', note: '   ' }).note).toBeUndefined();
  });

  // 500 is music_requests_note_length (0167). Repeated here so a refusal from
  // the database is never the first news of it — the duplication publicKeySchema
  // already carries for 0159's key shape, and for the same reason.
  it('stops at the column ceiling of 500 characters', () => {
    expect(requestSongSchema.safeParse({ deezerTrackId: '1', note: 'x'.repeat(500) }).success).toBe(
      true,
    );
    expect(requestSongSchema.safeParse({ deezerTrackId: '1', note: 'x'.repeat(501) }).success).toBe(
      false,
    );
  });

  it('refuses a field this product does not know', () => {
    expect(
      requestSongSchema.safeParse({ deezerTrackId: '1', note: '', memberId: 'somebody-else' })
        .success,
    ).toBe(false);
  });
});
