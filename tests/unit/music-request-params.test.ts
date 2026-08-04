import { describe, expect, it } from 'vitest';
import {
  parseRequestCursor,
  parseRequestListParams,
  requestHref,
} from '@/app/(app)/music/requests/list-params';

const COMPANY = '00000000-0000-0000-0000-0000000000c1';

describe('parseRequestListParams', () => {
  it('reads every filter off the URL', () => {
    expect(
      parseRequestListParams(
        { station: 'radio', q: 'ana', song: 'song-1', show: 'show-1', channel: 'IMPORT' },
        COMPANY,
      ),
    ).toEqual({
      companyId: COMPANY,
      stationSearch: 'radio',
      search: 'ana',
      songId: 'song-1',
      showId: 'show-1',
      channel: 'IMPORT',
    });
  });

  it('trims blank filters to undefined rather than keeping empty strings', () => {
    const state = parseRequestListParams({ station: '  ', q: '   ', song: ' ', show: ' ' }, COMPANY);
    expect(state.stationSearch).toBeUndefined();
    expect(state.search).toBeUndefined();
    expect(state.songId).toBeUndefined();
    expect(state.showId).toBeUndefined();
  });

  // Hostile input, the same contract parseStatus in participations/list-params.ts
  // and parseRecordParam both carry: a hand-edited URL narrows nothing rather
  // than throwing or silently picking one of the two real channels.
  it('falls back to no channel filter for an unrecognised channel', () => {
    expect(parseRequestListParams({ channel: 'WHATSAPP' }, COMPANY).channel).toBeUndefined();
    expect(parseRequestListParams({}, COMPANY).channel).toBeUndefined();
  });

  it('accepts each real channel', () => {
    expect(parseRequestListParams({ channel: 'MANUAL' }, COMPANY).channel).toBe('MANUAL');
    expect(parseRequestListParams({ channel: 'IMPORT' }, COMPANY).channel).toBe('IMPORT');
  });
});

describe('parseRequestCursor', () => {
  it('reads an after cursor', () => {
    expect(parseRequestCursor({ after: 'abc' })).toEqual({ side: 'after', value: 'abc' });
  });

  it('reads a before cursor, and prefers it over an after on the same URL', () => {
    expect(parseRequestCursor({ after: 'abc', before: 'def' })).toEqual({
      side: 'before',
      value: 'def',
    });
  });

  it('is null when neither is present', () => {
    expect(parseRequestCursor({})).toBeNull();
  });
});

describe('requestHref', () => {
  it('carries the Station and drops the filters that are absent', () => {
    const state = parseRequestListParams({}, COMPANY);
    expect(requestHref(state)).toBe(`/music/requests?companyId=${COMPANY}`);
  });

  it('carries the Station search, so a paging click cannot move the operator to another Station', () => {
    const state = parseRequestListParams({ station: 'radio' }, COMPANY);
    expect(requestHref(state)).toContain('station=radio');
  });

  it('carries a cursor onto the href when one is given', () => {
    const state = parseRequestListParams({}, COMPANY);
    expect(requestHref(state, { side: 'after', value: 'xyz' })).toContain('after=xyz');
  });

  it('survives a round trip through URLSearchParams', () => {
    const state = parseRequestListParams(
      { station: 'radio', q: 'ana', song: 'song-1', show: 'show-1', channel: 'MANUAL' },
      COMPANY,
    );
    const href = requestHref(state);
    const query = new URLSearchParams(href.split('?')[1]);
    const raw = {
      companyId: query.get('companyId') ?? undefined,
      station: query.get('station') ?? undefined,
      q: query.get('q') ?? undefined,
      song: query.get('song') ?? undefined,
      show: query.get('show') ?? undefined,
      channel: query.get('channel') ?? undefined,
    };
    expect(parseRequestListParams(raw, raw.companyId ?? COMPANY)).toEqual(state);
  });
});
