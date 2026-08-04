import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SONG_SORT,
  hasActiveSongFilters,
  parseSongCursor,
  parseSongListState,
  songHref,
  songSortHref,
} from '@/app/(app)/music/songs/list-params';

const COMPANY = '00000000-0000-0000-0000-0000000000c1';

describe('parseSongListState', () => {
  it('defaults to title, ascending — a catalogue is browsed alphabetically', () => {
    const state = parseSongListState({}, COMPANY);
    expect(state.sort).toBe('title');
    expect(state.direction).toBe('asc');
  });

  it('flips created to descending, because recency reads newest first', () => {
    const state = parseSongListState({ sort: 'created' }, COMPANY);
    expect(state.direction).toBe('desc');
  });

  it('ignores a sort key it does not know rather than erroring', () => {
    expect(parseSongListState({ sort: 'nonsense' }, COMPANY).sort).toBe(DEFAULT_SONG_SORT);
  });

  it('treats a whitespace-only search as no search', () => {
    expect(parseSongListState({ q: '   ' }, COMPANY).search).toBeUndefined();
  });
});

describe('songHref', () => {
  it('carries the Station and drops the defaults', () => {
    const state = parseSongListState({}, COMPANY);
    expect(songHref(state)).toBe(`/music/songs?companyId=${COMPANY}`);
  });

  it('drops the cursor when the sort changes, because a cursor is a position in one ordering', () => {
    const state = parseSongListState({ q: 'elis', after: 'abc' }, COMPANY);
    expect(songSortHref(state, 'created')).not.toContain('after=');
    expect(songSortHref(state, 'created')).toContain('q=elis');
  });

  it('carries the Station search, so a sort click cannot move the operator to another Station', () => {
    const state = parseSongListState({ station: 'radio' }, COMPANY);
    expect(songHref(state)).toContain('station=radio');
  });
});

describe('parseSongCursor', () => {
  it('prefers before over after, so walking back wins a malformed pair', () => {
    expect(parseSongCursor({ before: 'b', after: 'a' })).toEqual({ side: 'before', value: 'b' });
  });

  it('is null when neither is present', () => {
    expect(parseSongCursor({})).toBeNull();
  });
});

describe('hasActiveSongFilters', () => {
  it('does not count the Station selection as a filter', () => {
    expect(hasActiveSongFilters(parseSongListState({}, COMPANY))).toBe(false);
    expect(hasActiveSongFilters(parseSongListState({ q: 'x' }, COMPANY))).toBe(true);
    expect(hasActiveSongFilters(parseSongListState({ artist: 'x' }, COMPANY))).toBe(true);
  });
});
