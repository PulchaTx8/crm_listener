import { describe, expect, it } from 'vitest';
// The real conversion the form's hidden `requestedAt` field runs through
// (record-request-form.tsx), imported rather than hand-copying its output as
// a literal — see requestFormSchema.requestedAt's own test below for why.
import { fromZonedWallClock } from '@/app/(app)/promotions/zone';
import { referenceFormSchema, requestFormSchema, songFormSchema } from '@/schemas/music';

const COMPANY = '00000000-0000-0000-0000-0000000000c1';
const ARTIST = '00000000-0000-0000-0000-0000000000a1';
const SONG = '00000000-0000-0000-0000-000000000501';
const MEMBER = '00000000-0000-0000-0000-000000000601';

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

describe('requestFormSchema.requestedAt', () => {
  // The guard Task 7's review flagged as missing: before this, requestedAt
  // ran through optionalText alone — a trim and a length cap, no format
  // check — so a value that could not be read as a date would sail past this
  // schema untouched and reach create_music_request's own `timestamptz`
  // cast, which answers with an opaque internal error rather than a
  // field-level message. This is the test that would have failed against
  // the old schema: optionalText(40).safeParse('not a date') succeeds.
  it('refuses a string that is not a real instant, rather than sending it on to Postgres', () => {
    const parsed = requestFormSchema.safeParse({
      companyId: COMPANY,
      songId: SONG,
      memberId: MEMBER,
      requestedAt: 'not a date',
    });
    expect(parsed.success).toBe(false);
  });

  // A hand-written literal in the exact SHAPE fromZonedWallClock produces —
  // useful as a format check on its own, but the pairing between this
  // schema and that function is a coincidence until the next test proves it
  // with the real function.
  it('accepts a hand-written instant in the shape fromZonedWallClock produces', () => {
    const parsed = requestFormSchema.safeParse({
      companyId: COMPANY,
      songId: SONG,
      memberId: MEMBER,
      requestedAt: '2026-08-04T15:04:05.123Z',
    });
    expect(parsed.success).toBe(true);
  });

  // The fact, not the coincidence: feeds fromZonedWallClock's ACTUAL output
  // for a datetime-local value into this schema. This is the test that
  // fails the day somebody "simplifies" record-request-form.tsx by giving
  // the visible datetime-local input its own `name="requestedAt"` and
  // dropping the hidden, converted field — a raw datetime-local value
  // ("2026-08-04T15:04", no seconds, no 'Z') is exactly what the previous
  // test's hand-written literal cannot catch, because nobody wrote that
  // failure into the literal.
  it('accepts what fromZonedWallClock actually returns for a datetime-local value', () => {
    const instant = fromZonedWallClock('2026-08-04T15:04', 'America/Sao_Paulo');
    expect(instant).toBeDefined();

    const parsed = requestFormSchema.safeParse({
      companyId: COMPANY,
      songId: SONG,
      memberId: MEMBER,
      requestedAt: instant,
    });
    expect(parsed.success).toBe(true);
  });

  // Blank means "now" (0107's own coalesce) and must turn into undefined
  // rather than being refused as an unreadable date — the same emptiness
  // rule optionalText already gives every other optional field on this
  // schema.
  it('turns a blank value into undefined rather than refusing it', () => {
    const parsed = requestFormSchema.parse({
      companyId: COMPANY,
      songId: SONG,
      memberId: MEMBER,
      requestedAt: '',
    });
    expect(parsed.requestedAt).toBeUndefined();
  });

  // A date with no time zone designator is exactly the hand-crafted or
  // copy-pasted shape this guard exists to catch: `new Date(...)` would
  // happily parse it in Node's own process zone rather than refusing it,
  // which is the silent-wrong-instant failure this field must not have.
  it('refuses an instant with no timezone designator', () => {
    const parsed = requestFormSchema.safeParse({
      companyId: COMPANY,
      songId: SONG,
      memberId: MEMBER,
      requestedAt: '2026-08-04T15:04:05',
    });
    expect(parsed.success).toBe(false);
  });
});
