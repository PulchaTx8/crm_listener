import { describe, expect, it } from 'vitest';
import { musicRequestSchema, normaliseSong, songIntakeSchema } from '@/schemas/api';

describe('songIntakeSchema', () => {
  it('accepts a minimal body', () => {
    expect(songIntakeSchema.safeParse({ title: 'A Song', artist: 'An Artist' }).success).toBe(true);
  });

  it('refuses an unknown field rather than ignoring it', () => {
    // For an automation a mistyped field name must fail on the first test run,
    // not disappear for six months.
    const parsed = songIntakeSchema.safeParse({
      title: 'A Song',
      artist: 'An Artist',
      titel: 'typo',
    });
    expect(parsed.success).toBe(false);
  });

  it('refuses a malformed ISRC', () => {
    expect(
      songIntakeSchema.safeParse({ title: 'A', artist: 'B', isrc: 'nope' }).success,
    ).toBe(false);
  });

  it('accepts a lowercase ISRC, which the database folds', () => {
    expect(
      songIntakeSchema.safeParse({ title: 'A', artist: 'B', isrc: 'gbduw0000059' }).success,
    ).toBe(true);
  });

  it('refuses a cover hash that is not an md5', () => {
    // albums.cover_md5 has a CHECK (0136) and coverUrl refuses anything else. A
    // bad hash refused here names the field; refused at insert it names a
    // constraint.
    const parsed = songIntakeSchema.safeParse({
      title: 'A',
      artist: 'B',
      album: { title: 'An Album', cover_md5: 'not-a-hash' },
    });
    expect(parsed.success).toBe(false);
  });
});

describe('the deezer object', () => {
  it('tolerates fields nobody here knows about', () => {
    // Deliberate exception to strictness: it is a third party's object and
    // Deezer may add to it. The integration must not break the day it does.
    const parsed = musicRequestSchema.safeParse({
      listener: { phone: '+5511999990001', name: 'Maria' },
      song: {
        deezer: {
          id: 3135556,
          title: 'Harder, Better, Faster, Stronger',
          duration: 224,
          artist: { name: 'Daft Punk' },
          album: { id: 302127, title: 'Discovery', md5_image: 'a'.repeat(32) },
          rank: 952814,
          preview: 'https://example.test/x.mp3',
          explicit_lyrics: false,
          something_deezer_added_last_tuesday: true,
        },
      },
    });
    expect(parsed.success).toBe(true);
  });

  it('still refuses an unknown field OUTSIDE the deezer object', () => {
    const parsed = musicRequestSchema.safeParse({
      listener: { phone: '+5511999990001', name: 'Maria' },
      song: { title: 'A', artist: 'B' },
      shwo: 'typo',
    });
    expect(parsed.success).toBe(false);
  });
});

describe('normaliseSong', () => {
  it('reads the flat fields when no deezer object is present', () => {
    const flat = normaliseSong({ title: 'A Song', artist: 'An Artist' });
    expect(flat.title).toBe('A Song');
    expect(flat.artistName).toBe('An Artist');
    expect(flat.deezerTrackId).toBeNull();
  });

  it('unpacks the deezer object into the flat shape', () => {
    const from = normaliseSong({
      deezer: {
        id: 3135556,
        title: 'Harder, Better, Faster, Stronger',
        duration: 224,
        artist: { name: 'Daft Punk' },
        album: { id: 302127, title: 'Discovery', md5_image: 'b'.repeat(32) },
      },
    });
    expect(from.title).toBe('Harder, Better, Faster, Stronger');
    expect(from.artistName).toBe('Daft Punk');
    expect(from.deezerTrackId).toBe(3135556);
    expect(from.deezerAlbumId).toBe(302127);
    expect(from.albumTitle).toBe('Discovery');
    expect(from.durationSeconds).toBe(224);
    expect(from.coverMd5).toBe('b'.repeat(32));
  });

  it('lets an explicit flat field win over the deezer object', () => {
    // Whoever was explicit meant it -- the instinct registerFromDeezerAction
    // follows when it reads every reference out of the form rather than out of
    // the payload the dialog was opened with.
    const merged = normaliseSong({
      title: 'The Title The Operator Wants',
      deezer: {
        id: 3135556,
        title: 'Harder, Better, Faster, Stronger',
        artist: { name: 'Daft Punk' },
      },
    });
    expect(merged.title).toBe('The Title The Operator Wants');
    expect(merged.artistName).toBe('Daft Punk');
  });

  it('carries no label or genre from a search result, because Deezer sends none', () => {
    // Verified against a live /search payload on 2026-08-09: the album object
    // there holds id, title, cover URLs and md5_image, and nothing else. This is
    // what makes the server-side /album/{id} call (design D7) necessary.
    const from = normaliseSong({
      deezer: {
        id: 3135556,
        title: 'Harder, Better, Faster, Stronger',
        artist: { name: 'Daft Punk' },
        album: { id: 302127, title: 'Discovery', md5_image: 'c'.repeat(32) },
      },
    });
    expect(from.labelName).toBeNull();
    expect(from.genreName).toBeNull();
    expect(from.releaseDate).toBeNull();
    expect(from.upc).toBeNull();
  });
});
