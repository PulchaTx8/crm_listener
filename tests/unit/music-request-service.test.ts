import { describe, expect, it } from 'vitest';
import {
  REQUEST_PAGE_SIZE,
  requestReadLimit,
  requestUsesKeyset,
  toSongOption,
  totalFromRequestBatch,
} from '@/services/music';

/**
 * The pieces of services/music.ts that are actual logic rather than a
 * pass-through to an RPC: totalFromRequestBatch, toSongOption, and Block 22's
 * two paging decisions (requestUsesKeyset, requestReadLimit).
 *
 * Everything else in this module's requests surface is a thin
 * asCaller(...).rpc(...) wrapper — listMusicRequestsPage, createMusicRequest,
 * archiveMusicRequest, mergeMusicRecords, listMergeCandidates, and Block 22's
 * four writers (markMusicRequestRead, markMusicRequestPlayed,
 * cancelMusicRequest, revealRequestPhone) — and this codebase does not mock
 * @supabase/supabase-js in tests/unit (grep confirms it: only
 * @/lib/supabase/user-client — a much thinner, project-owned wrapper — is ever
 * mocked, for the createUserClient reads in music-song-embed.test.ts). Those
 * four are proved where their behaviour actually lives, in
 * supabase/tests/51_music_request_triage.test.sql. Every function pinned here
 * is exported specifically so it can be pinned without a database, the same
 * reasoning their own doc comments in services/music.ts give.
 */

describe('totalFromRequestBatch', () => {
  // The question Task 7's brief asked to be verified rather than assumed:
  // list_music_requests is `returns table`, built from `select ... from
  // visible f`, so a filtered set with nothing in it joins to ZERO output
  // rows — never one row carrying total_count = 0. There is no first row to
  // read a count off, and this is the function that decides what happens
  // then.
  it('is zero for an empty batch, not undefined and not a throw', () => {
    expect(totalFromRequestBatch([])).toBe(0);
  });

  it('reads the figure off the first row — every row in a real batch repeats it', () => {
    expect(totalFromRequestBatch([{ total_count: 7 }, { total_count: 7 }])).toBe(7);
  });

  it('coerces to a number, in case a bigint total ever arrives over the wire as a string', () => {
    expect(totalFromRequestBatch([{ total_count: '3' as unknown as number }])).toBe(3);
  });
});

describe('toSongOption', () => {
  // The exact defect music-song-embed.test.ts was written to catch for
  // listSongsPage/getSongById, reachable again here: PostgREST resolves a
  // to-one embed as a LEFT JOIN and returns null for it when the parent row
  // (the artist) is invisible under RLS — 0099's policy on artists withholds
  // an archived one from every caller, including the owner, while artist_id
  // on the song stays set. A bare `row.artists.name` throws on that row; this
  // function is what has to keep it to one blank cell instead of the whole
  // search failing.
  it('reports the artist name when the embed resolved', () => {
    const option = toSongOption({
      id: 'song-1',
      title: 'Sozinho',
      artists: { name: 'Caetano' },
      albums: { cover_md5: '2a0f6ac6bc05458fb072275653f01dd2' },
    });
    expect(option).toEqual({
      songId: 'song-1',
      title: 'Sozinho',
      artistName: 'Caetano',
      coverMd5: '2a0f6ac6bc05458fb072275653f01dd2',
    });
  });

  it('reports the artist as unreadable, not the song, when RLS hides the embed', () => {
    const option = toSongOption({
      id: 'song-2',
      title: 'A song whose artist RLS hides',
      artists: null,
      albums: null,
    });
    expect(option.artistName).toBeNull();
    expect(option.songId).toBe('song-2');
    expect(option.title).toBe('A song whose artist RLS hides');
  });

  // Block 13a. The album embed is null twice over — a song typed by hand has
  // no album at all, and an archived album is invisible while album_id still
  // names it. Both render as the fallback icon, which is the honest rendering
  // of both.
  it('leaves the cover null for a song with no readable album', () => {
    const option = toSongOption({
      id: 'song-3',
      title: 'Typed by hand',
      artists: { name: 'Someone' },
      albums: null,
    });
    expect(option.coverMd5).toBeNull();
  });
});

describe('what the requests list asks the database for', () => {
  it('sends one page plus one row when it is paging, and exactly the limit when it is not', () => {
    // The two numbers are different questions. Paging reads one row past the
    // page so keysetPage can tell there is a next one; a bounded batch has no
    // next page to detect, and reading N + 1 there would show the operator one
    // more row than they asked for.
    expect(requestReadLimit({ sort: 'requested', limit: undefined })).toBe(REQUEST_PAGE_SIZE + 1);
    expect(requestReadLimit({ sort: 'requested', limit: 10 })).toBe(10);
    expect(requestReadLimit({ sort: 'song', limit: undefined })).toBe(REQUEST_PAGE_SIZE);
    expect(requestReadLimit({ sort: 'song', limit: 10 })).toBe(10);
  });

  it('pages only for the ordering the cursor was built for', () => {
    expect(requestUsesKeyset({ sort: 'requested', limit: undefined })).toBe(true);
    expect(requestUsesKeyset({ sort: 'requested', limit: 10 })).toBe(false);
    expect(requestUsesKeyset({ sort: 'artist', limit: undefined })).toBe(false);
  });
});
