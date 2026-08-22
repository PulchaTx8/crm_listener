import { describe, expect, it, vi } from 'vitest';
import { isExcludedRecording, isExcludedTitle } from '@/lib/integrations/deezer/transport';
import { createDeezerClient } from '@/lib/integrations/deezer/client';
import { FakeDeezerTransport } from '@/lib/integrations/deezer/fake';
import type { DeezerTrack } from '@/lib/integrations/deezer/transport';

/**
 * Block 24, item 1. A radio's catalogue is the recordings it plays, and a search
 * for "Garota de Ipanema" that answers with four karaoke backing tracks and two
 * covers is a search the operator has to read past every time.
 *
 * THE BARE WORD "cover" IS NOT A TERM, and the tests below are mostly about
 * that. The owner's list gave five: `karaoke`, `cover)`, `(cover`, `Cover]` and
 * `[Cover` — four of them carrying a bracket, because that is how a cover
 * announces itself in a title. Excluding the bare word would take
 * "Undercover", "Cover Me" and "Discovery" with it.
 */
describe('isExcludedTitle', () => {
  it('excludes a karaoke version whatever the case', () => {
    expect(isExcludedTitle('Garota de Ipanema (Karaoke Version)')).toBe(true);
    expect(isExcludedTitle('KARAOKE - Evidências')).toBe(true);
    expect(isExcludedTitle('karaoke')).toBe(true);
  });

  it('excludes each of the four bracketed cover forms', () => {
    expect(isExcludedTitle('Yesterday (Cover)')).toBe(true);
    expect(isExcludedTitle('Yesterday [Cover]')).toBe(true);
    // The opening halves on their own, which is what a title carrying more
    // inside the brackets looks like.
    expect(isExcludedTitle('Yesterday (Cover by Someone)')).toBe(true);
    expect(isExcludedTitle('Yesterday [Cover Version]')).toBe(true);
    // And the closing halves, for a title whose bracket opened earlier.
    expect(isExcludedTitle('Yesterday (Acoustic Cover)')).toBe(true);
    expect(isExcludedTitle('Yesterday [Live Cover]')).toBe(true);
  });

  it('is case-insensitive on every term', () => {
    expect(isExcludedTitle('Yesterday (COVER)')).toBe(true);
    expect(isExcludedTitle('Yesterday [cover]')).toBe(true);
    expect(isExcludedTitle('Yesterday (cOvEr)')).toBe(true);
  });

  // The whole reason the terms carry brackets. Each of these is a real
  // recording a Station would want to register.
  it('keeps titles that merely contain the letters of a term', () => {
    for (const title of [
      'Discovery',
      'Undercover',
      'Cover Me',
      'Coverage',
      'Recovering',
      'Covered in Rain',
      'Karaoké',
    ]) {
      expect(isExcludedTitle(title), title).toBe(false);
    }
  });

  it('keeps an empty title rather than treating absence as a match', () => {
    expect(isExcludedTitle('')).toBe(false);
  });
});

/**
 * Block 31a, D9. The owner reported covers still being offered, and the reason
 * was not a gap in the term list above: Deezer carries a `version` field beside
 * `title`, and `toTrack` never read it. A recording whose title is clean and
 * whose version says "(Cover Version)" arrived looking like the original.
 */
describe('isExcludedRecording', () => {
  it('excludes a cover Deezer marks only in the version field', () => {
    expect(isExcludedRecording('Evidências', '(Cover Version)')).toBe(true);
    // Unbracketed too: in that field the phrase stands alone.
    expect(isExcludedRecording('Evidências', 'Cover Version')).toBe(true);
    expect(isExcludedRecording('Evidências', 'COVER VERSION')).toBe(true);
  });

  it('keeps a version that is not a cover', () => {
    expect(isExcludedRecording('Evidências', '(Live)')).toBe(false);
    expect(isExcludedRecording('Evidências', 'Radio Edit')).toBe(false);
    expect(isExcludedRecording('Evidências', 'Ao Vivo')).toBe(false);
    expect(isExcludedRecording('Evidências', null)).toBe(false);
  });

  it('still judges the title, which is where Block 24 found them', () => {
    expect(isExcludedRecording('Evidências (Karaoke)', null)).toBe(true);
    expect(isExcludedRecording('Yesterday (Cover)', null)).toBe(true);
    expect(isExcludedRecording('Yesterday (Cover)', '(Live)')).toBe(true);
  });

  it('does not take the recordings whose names merely contain the letters', () => {
    // `cover version` is two words, so it cannot sit inside any of these — which
    // is why it is the one term that needs no bracket.
    for (const title of ['Discovery', 'Undercover', 'Cover Me', 'Coverage']) {
      expect(isExcludedRecording(title, null), title).toBe(false);
      expect(isExcludedRecording(title, 'Radio Edit'), title).toBe(false);
    }
  });
});

function track(id: number, title: string): DeezerTrack {
  return {
    id,
    title,
    artistName: 'Someone',
    albumId: 1,
    albumTitle: 'An album',
    coverMd5: null,
    durationSeconds: 200,
    isrc: null,
    previewUrl: null,
    version: null,
  };
}

function searchAnswering(titles: string[]) {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({
      data: titles.map((title, index) => ({
        id: index + 1,
        title,
        artist: { name: 'Someone' },
        album: { id: 1, title: 'An album', md5_image: null },
        duration: 200,
      })),
    }),
  } as unknown as Response);
}

describe('the Deezer search, filtered', () => {
  it('drops excluded titles from what the search returns', async () => {
    const fetchImpl = searchAnswering([
      'Evidências',
      'Evidências (Karaoke Version)',
      'Evidências (Cover)',
      'Evidências [Cover]',
      'Undercover',
    ]);

    const result = await createDeezerClient({ fetchImpl }).search({ track: 'Evidências' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.map((t) => t.title)).toEqual(['Evidências', 'Undercover']);
  });

  /**
   * D1. A recording already registered in a Station's catalogue is fetched by
   * id — by the widget's song request, among others — and filtering there would
   * make an existing row unresolvable. The search is a list to choose from; the
   * lookup is an answer about one thing that already exists.
   */
  it('does not filter a track fetched by id', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        id: 7,
        title: 'Evidências (Karaoke Version)',
        artist: { name: 'Someone' },
        album: { id: 1, title: 'An album', md5_image: null },
        duration: 200,
      }),
    } as unknown as Response);

    const result = await createDeezerClient({ fetchImpl }).track(7);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.title).toBe('Evidências (Karaoke Version)');
  });
});

describe('the fake transport', () => {
  // It filters too, so tests/e2e/deezer.spec.ts exercises the same rule the
  // real client applies rather than a screen with no filter behind it.
  it('applies the same filter as the real client', async () => {
    const fake = new FakeDeezerTransport([
      track(1, 'Evidências'),
      track(2, 'Evidências (Karaoke)'),
    ]);

    const result = await fake.search({ track: 'Evidências' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.map((t) => t.title)).toEqual(['Evidências']);
  });

  // The pairing Block 17b's D4 relies on: the widget resolves by id what the
  // search offered. A fake that filtered its lookup as well as its search would
  // break that pairing for any fixture carrying an excluded title.
  it('still resolves an excluded title by id', async () => {
    const fake = new FakeDeezerTransport([track(2, 'Evidências (Karaoke)')]);

    const result = await fake.track(2);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.title).toBe('Evidências (Karaoke)');
  });
});
