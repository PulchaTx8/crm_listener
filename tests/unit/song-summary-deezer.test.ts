import { describe, expect, it } from 'vitest';
import { toSongSummary } from '@/services/music';

/** The columns SONG_COLUMNS selects, as PostgREST hands them back. */
const base = {
  id: 's1',
  title: 'Sozinho',
  artist_id: 'a1',
  label_id: null,
  genre_id: null,
  nationality: null,
  vocal: null,
  duration_seconds: 191,
  internal_code: null,
  legacy_id: null,
  created_at: '2026-08-07T00:00:00Z',
  album_id: null,
  deezer_track_id: null,
  isrc: null,
  artists: { name: 'Caetano Veloso' },
  record_labels: null,
  music_genres: null,
  albums: null,
};

describe('toSongSummary', () => {
  it('carries the album title and cover through the embed', () => {
    const row = {
      ...base,
      album_id: 'al1',
      deezer_track_id: 921568,
      isrc: 'BRPGD9800678',
      albums: { title: 'Prenda Minha', cover_md5: '2a0f6ac6bc05458fb072275653f01dd2' },
    };

    expect(toSongSummary(row as never)).toMatchObject({
      albumId: 'al1',
      albumTitle: 'Prenda Minha',
      coverMd5: '2a0f6ac6bc05458fb072275653f01dd2',
      deezerTrackId: 921568,
      isrc: 'BRPGD9800678',
    });
  });

  /**
   * The one that matters. 0099-style policies hide an archived row, and
   * PostgREST resolves a to-one embed as a LEFT JOIN — so `albums` comes back
   * null while `album_id` still names it. That is not the same fact as the
   * column being null, and SONG_COLUMNS' own comment records what it cost when
   * the distinction was got wrong for artists: a TypeError inside
   * listSongsPage, and the whole Station's Songs screen rendering its load
   * error with no way back through the UI.
   */
  it('survives an album RLS hides, exactly as it does for an archived artist', () => {
    const row = { ...base, album_id: 'al1', albums: null };

    const summary = toSongSummary(row as never);
    expect(summary.albumId).toBe('al1');
    expect(summary.albumTitle).toBeNull();
    expect(summary.coverMd5).toBeNull();
  });

  it('leaves a hand-typed song with no album and no cover', () => {
    const summary = toSongSummary(base as never);
    expect(summary.albumId).toBeNull();
    expect(summary.coverMd5).toBeNull();
    expect(summary.deezerTrackId).toBeNull();
    expect(summary.isrc).toBeNull();
  });

  it('carries a cover on an album that has none, without inventing one', () => {
    const row = { ...base, album_id: 'al1', albums: { title: 'Bootleg', cover_md5: null } };

    expect(toSongSummary(row as never)).toMatchObject({
      albumTitle: 'Bootleg',
      coverMd5: null,
    });
  });
});
