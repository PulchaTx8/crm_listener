import { describe, expect, it } from 'vitest';
import { referenceFormSchema, songFormSchema } from '@/schemas/music';

const COMPANY = '00000000-0000-0000-0000-0000000000c1';
const ARTIST = '00000000-0000-0000-0000-0000000000a1';

describe('songFormSchema', () => {
  it('accepts a song with nothing but a title and an artist', () => {
    const parsed = songFormSchema.safeParse({
      companyId: COMPANY,
      title: 'Águas de Março',
      artistId: ARTIST,
    });
    expect(parsed.success).toBe(true);
  });

  it('refuses a song with no artist — the database would too, one round trip later', () => {
    const parsed = songFormSchema.safeParse({ companyId: COMPANY, title: 'No artist' });
    expect(parsed.success).toBe(false);
  });

  it('refuses a blank title rather than sending whitespace to be trimmed away', () => {
    const parsed = songFormSchema.safeParse({
      companyId: COMPANY,
      title: '   ',
      artistId: ARTIST,
    });
    expect(parsed.success).toBe(false);
  });

  it('refuses a fractional or zero duration', () => {
    for (const durationSeconds of [0, -1, 3.5]) {
      const parsed = songFormSchema.safeParse({
        companyId: COMPANY,
        title: 'Timed',
        artistId: ARTIST,
        durationSeconds,
      });
      expect(parsed.success).toBe(false);
    }
  });

  it('turns an empty optional into undefined rather than an empty string', () => {
    const parsed = songFormSchema.parse({
      companyId: COMPANY,
      title: 'Blank fields',
      artistId: ARTIST,
      labelId: '',
      internalCode: '',
      legacyId: '',
    });
    expect(parsed.labelId).toBeUndefined();
    expect(parsed.internalCode).toBeUndefined();
    expect(parsed.legacyId).toBeUndefined();
  });

  it('turns an empty label and an empty genre into undefined too — a uuid check runs before any transform could catch an empty string', () => {
    const parsed = songFormSchema.parse({
      companyId: COMPANY,
      title: 'Blank references',
      artistId: ARTIST,
      labelId: '',
      genreId: '',
    });
    expect(parsed.labelId).toBeUndefined();
    expect(parsed.genreId).toBeUndefined();
  });

  it('turns an empty nationality and an empty vocal into undefined rather than refusing an unrecognised enum value', () => {
    const parsed = songFormSchema.parse({
      companyId: COMPANY,
      title: 'Blank selects',
      artistId: ARTIST,
      nationality: '',
      vocal: '',
    });
    expect(parsed.nationality).toBeUndefined();
    expect(parsed.vocal).toBeUndefined();
  });

  it('accepts every vocal the enum carries, including the three §4.2 never named', () => {
    for (const vocal of ['MALE', 'FEMALE', 'DUO', 'GROUP', 'INSTRUMENTAL']) {
      const parsed = songFormSchema.safeParse({
        companyId: COMPANY,
        title: 'Sung',
        artistId: ARTIST,
        vocal,
      });
      expect(parsed.success).toBe(true);
    }
  });
});

describe('referenceFormSchema', () => {
  it('accepts the four kinds and refuses a fifth', () => {
    for (const kind of ['GENRE', 'LABEL', 'ARTIST', 'SHOW']) {
      expect(referenceFormSchema.safeParse({ companyId: COMPANY, kind, name: 'X' }).success).toBe(
        true,
      );
    }
    expect(
      referenceFormSchema.safeParse({ companyId: COMPANY, kind: 'SONG', name: 'X' }).success,
    ).toBe(false);
  });

  it('refuses a blank name', () => {
    expect(
      referenceFormSchema.safeParse({ companyId: COMPANY, kind: 'GENRE', name: '  ' }).success,
    ).toBe(false);
  });
});
