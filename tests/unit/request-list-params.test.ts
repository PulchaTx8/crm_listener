import { describe, expect, it } from 'vitest';
import {
  DEFAULT_REQUEST_SORT,
  parseRequestLimit,
  parseRequestListParams,
  requestHref,
} from '@/app/(app)/music/requests/list-params';

const COMPANY = '00000000-0000-0000-0000-0000000022c1';

describe('the requests screen URL contract', () => {
  it('reads the two status filters and the ordering', () => {
    const state = parseRequestListParams(
      { read: 'UNREAD', play: 'PLAYED', sort: 'artist' },
      COMPANY,
    );
    expect(state.readStatus).toBe('UNREAD');
    expect(state.playStatus).toBe('PLAYED');
    expect(state.sort).toBe('artist');
  });

  it('ignores values that are not one of the offered ones rather than erroring', () => {
    // A hand-edited URL narrows nothing; it never produces an error page. The
    // same tolerance parseChannel has had since Block 7b.
    const state = parseRequestListParams({ read: 'MAYBE', sort: 'colour' }, COMPANY);
    expect(state.readStatus).toBeUndefined();
    expect(state.sort).toBe(DEFAULT_REQUEST_SORT);
  });

  it('clamps the limit to the range the database also enforces', () => {
    expect(parseRequestLimit('10')).toBe(10);
    expect(parseRequestLimit('0')).toBe(1);
    expect(parseRequestLimit('9999')).toBe(200);
    expect(parseRequestLimit('ten')).toBeUndefined();
    expect(parseRequestLimit('')).toBeUndefined();
    expect(parseRequestLimit(undefined)).toBeUndefined();
    // A fraction is a typo, not a request for two and a half rows.
    expect(parseRequestLimit('2.5')).toBe(2);
  });

  it('carries every filter into the href, and drops the cursor when one changes', () => {
    const href = requestHref({
      companyId: COMPANY,
      readStatus: 'UNREAD',
      playStatus: 'NOT_PLAYED',
      sort: 'song',
      limit: 10,
    });
    expect(href).toContain('read=UNREAD');
    expect(href).toContain('play=NOT_PLAYED');
    expect(href).toContain('sort=song');
    expect(href).toContain('limit=10');
    // A cursor is a position in ONE ordering of ONE result set. Carrying it
    // across a filter change is how a list opens on page four of a question
    // nobody asked.
    expect(href).not.toContain('after=');
  });

  it('leaves the default ordering out of the URL', () => {
    // So a shared link reads as the screen's own address rather than as a
    // configuration, and so "no sort parameter" and "sort=requested" cannot
    // become two different-looking URLs for one screen.
    expect(requestHref({ companyId: COMPANY, sort: 'requested' })).not.toContain('sort=');
  });
});
