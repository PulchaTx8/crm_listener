import { describe, expect, it } from 'vitest';
import { mergeFormSchema, requestFormSchema, MUSIC_MERGE_KINDS } from '@/schemas/music';

describe('MUSIC_MERGE_KINDS', () => {
  // Pinned against 0105. The owner ruled for merge_shows on 2026-08-04 and
  // three shipped comments predicted the opposite — this is the line that
  // fails if somebody trusts one of them.
  it('is the five the database declares, shows included', () => {
    expect([...MUSIC_MERGE_KINDS]).toEqual(['SONG', 'ARTIST', 'LABEL', 'GENRE', 'SHOW']);
  });
});

describe('mergeFormSchema', () => {
  const winner = '11111111-1111-1111-1111-111111111111';
  const loser = '22222222-2222-2222-2222-222222222222';
  const company = '33333333-3333-3333-3333-333333333333';

  it('accepts a survivor, its losers and a reason', () => {
    const parsed = mergeFormSchema.parse({
      companyId: company,
      kind: 'SONG',
      winnerId: winner,
      loserIds: [loser],
      reason: 'same recording, typed twice',
    });
    expect(parsed.loserIds).toEqual([loser]);
  });

  // 0106 refuses all three of these too. Catching them here turns a round trip
  // into a field-level message — the reason schemas/music.ts exists at all.
  it('refuses a merge with no reason', () => {
    expect(() =>
      mergeFormSchema.parse({
        companyId: company, kind: 'SONG', winnerId: winner, loserIds: [loser], reason: '   ',
      }),
    ).toThrow();
  });

  it('refuses a merge that absorbs nobody', () => {
    expect(() =>
      mergeFormSchema.parse({
        companyId: company, kind: 'SONG', winnerId: winner, loserIds: [], reason: 'why',
      }),
    ).toThrow();
  });

  it('refuses a survivor that is also being absorbed', () => {
    expect(() =>
      mergeFormSchema.parse({
        companyId: company, kind: 'SONG', winnerId: winner, loserIds: [winner], reason: 'why',
      }),
    ).toThrow();
  });

  it('collapses a duplicate loser rather than sending it twice', () => {
    const parsed = mergeFormSchema.parse({
      companyId: company, kind: 'SONG', winnerId: winner, loserIds: [loser, loser], reason: 'why',
    });
    expect(parsed.loserIds).toEqual([loser]);
  });
});

describe('requestFormSchema', () => {
  const company = '33333333-3333-3333-3333-333333333333';
  const song = '44444444-4444-4444-4444-444444444444';

  it('accepts a listener already picked', () => {
    const parsed = requestFormSchema.parse({
      companyId: company, songId: song, memberId: '55555555-5555-5555-5555-555555555555',
    });
    expect(parsed.songId).toBe(song);
  });

  it('accepts a listener to be created from a name', () => {
    const parsed = requestFormSchema.parse({
      companyId: company, songId: song, fullName: 'Ana Ouvinte', phone: '+5511999990001',
    });
    expect(parsed.fullName).toBe('Ana Ouvinte');
  });

  // D5: every request belongs to a registered listener. Neither a picked id nor
  // the fields to register one means there is nobody to attach it to.
  it('refuses a request that names no listener at all', () => {
    expect(() => requestFormSchema.parse({ companyId: company, songId: song })).toThrow();
  });

  it('refuses a request with no song — never free text', () => {
    expect(() =>
      requestFormSchema.parse({ companyId: company, fullName: 'Ana' }),
    ).toThrow();
  });

  // Verifies the composition the task brief asked to check rather than assume:
  // an untouched <select> posts memberId as '', and optionalUuid's preprocess
  // (blankToUndefined) has to turn that into `undefined` BEFORE the uuid
  // format check runs, so the empty string never reaches z.string().uuid() —
  // which would reject '' outright — and the object-level .refine() sees
  // `undefined`, not ''. Boolean('') and Boolean(undefined) are both falsy, so
  // the refine's own truthiness check cannot distinguish the two cases; only a
  // parse that does not throw on the format check proves the preprocessing ran
  // first. Without it, this call would throw "Invalid uuid" on memberId
  // instead of succeeding — the wrong refusal, for the wrong field, even when
  // a name was given right beside it.
  it('accepts an empty-string memberId — what an untouched select posts — once a name is given', () => {
    const parsed = requestFormSchema.parse({
      companyId: company, songId: song, memberId: '', fullName: 'Ana Ouvinte',
    });
    expect(parsed.memberId).toBeUndefined();
    expect(parsed.fullName).toBe('Ana Ouvinte');
  });

  // The other half of the same composition: empty strings on BOTH sides must
  // still trip the refine (nobody named), not silently pass because '' preceded
  // undefined in some check order.
  it('refuses when both memberId and fullName arrive as empty strings', () => {
    expect(() =>
      requestFormSchema.parse({ companyId: company, songId: song, memberId: '', fullName: '' }),
    ).toThrow();
  });
});
