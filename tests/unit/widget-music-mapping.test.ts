import { describe, expect, it } from 'vitest';
import type { DeezerTrack } from '@/lib/integrations/deezer/transport';
import { deezerRefusal, recordRefusal, toWidgetTrack } from '@/lib/widget/music-mapping';

const TRACK: DeezerTrack = {
  id: 921568,
  title: 'Sozinho (Ao Vivo)',
  artistName: 'Caetano Veloso',
  albumId: 103763,
  albumTitle: 'Prenda Minha',
  coverMd5: '2a0f6ac6bc05458fb072275653f01dd2',
  durationSeconds: 191,
  isrc: 'BRPGD9800678',
  previewUrl: 'https://cdnt-preview.dzcdn.net/api/1/1/x.mp3?hdnea=exp=1786000000~hmac=deadbeef',
};

describe('toWidgetTrack', () => {
  /**
   * The guarantee this file exists for. transport.ts states that the preview URL
   * is signed and short-lived and must not reach a column, a cache or a form
   * field — and a server action's return value is serialised into the page.
   */
  it('never carries the signed preview url to the browser', () => {
    const mapped = toWidgetTrack(TRACK);

    expect(JSON.stringify(mapped)).not.toContain('hdnea');
    expect(JSON.stringify(mapped)).not.toContain('cdnt-preview');
    expect('previewUrl' in mapped).toBe(false);
  });

  it('drops the ISRC and the album id, which the browser has no use for', () => {
    const mapped = toWidgetTrack(TRACK);

    expect(Object.keys(mapped).sort()).toEqual([
      'albumTitle',
      'artistName',
      'coverMd5',
      'durationSeconds',
      'id',
      'title',
    ]);
  });

  it('keeps what the panel actually shows', () => {
    expect(toWidgetTrack(TRACK)).toEqual({
      id: 921568,
      title: 'Sozinho (Ao Vivo)',
      artistName: 'Caetano Veloso',
      albumTitle: 'Prenda Minha',
      coverMd5: '2a0f6ac6bc05458fb072275653f01dd2',
      durationSeconds: 191,
    });
  });
});

describe('recordRefusal', () => {
  it('passes through the reasons the panel has a sentence for', () => {
    expect(recordRefusal('cooldown')).toBe('cooldown');
    expect(recordRefusal('listener_anonymized')).toBe('listener_anonymized');
    expect(recordRefusal('unknown_installation')).toBe('unknown_installation');
  });

  /**
   * Both halves of unknown_listener — another Station's listener, and one that
   * does not exist — are the same fact to a visitor, and neither is actionable.
   * Identifying again is.
   */
  it('turns unknown_listener into no_session, which is the thing they can act on', () => {
    expect(recordRefusal('unknown_listener')).toBe('no_session');
  });

  /**
   * A reason with no message renders as nothing at all: the box simply does
   * nothing when submitted, which is worse than an error.
   */
  it('turns a reason it does not know into failed rather than passing it on', () => {
    expect(recordRefusal('something_a_later_migration_invented')).toBe('failed');
    expect(recordRefusal(null)).toBe('failed');
    expect(recordRefusal('')).toBe('failed');
  });
});

describe('deezerRefusal', () => {
  it('separates "wait a moment" from "something is wrong at our end"', () => {
    expect(deezerRefusal('quota')).toBe('deezer_quota');
    expect(deezerRefusal('network')).toBe('deezer_unavailable');
    expect(deezerRefusal('malformed')).toBe('deezer_unavailable');
    expect(deezerRefusal('not-found')).toBe('deezer_unavailable');
  });
});
