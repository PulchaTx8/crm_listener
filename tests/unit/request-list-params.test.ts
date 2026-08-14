import { describe, expect, it } from 'vitest';
import {
  DEFAULT_REQUEST_SORT,
  parseRequestLimit,
  parseRequestListParams,
  requestHref,
} from '@/app/(app)/music/requests/list-params';
import { REQUEST_LIMIT_MAX, REQUEST_LIMIT_MIN } from '@/schemas/music';

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

  it('accepts every status the enum offers, not only the first one a test happens to reach', () => {
    // READ and CANCELLED for the read filter, CANCELLED for the play filter —
    // the earlier test above only ever exercised UNREAD/PLAYED.
    const read = parseRequestListParams({ read: 'READ' }, COMPANY);
    expect(read.readStatus).toBe('READ');
    const cancelled = parseRequestListParams({ read: 'CANCELLED', play: 'CANCELLED' }, COMPANY);
    expect(cancelled.readStatus).toBe('CANCELLED');
    expect(cancelled.playStatus).toBe('CANCELLED');
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

  it('stays inside the enforced range for hostile input, one input at a time', () => {
    // A negative number is out of range on the low side, same as 0 above —
    // clamped up to the minimum, not passed through negative.
    expect(parseRequestLimit('-5')).toBe(REQUEST_LIMIT_MIN);
    // Number('Infinity') is a real, non-finite JS number. Number.isFinite
    // rejects it the same way it would reject NaN, so this reads as "no
    // limit was typed" rather than as an unbounded read.
    expect(parseRequestLimit('Infinity')).toBeUndefined();
    // Number('NaN') is NaN, also caught by the finite check.
    expect(parseRequestLimit('NaN')).toBeUndefined();
    // Number() reads a hex literal — this parses to 16, which is inside
    // [REQUEST_LIMIT_MIN, REQUEST_LIMIT_MAX], so it is returned as-is rather
    // than clamped or rejected. Surprising, but bounded: 16 rows is still a
    // safe answer to send to the RPC.
    expect(parseRequestLimit('0x10')).toBe(16);
    // Number() also reads exponent notation — 1e9 is finite but far past the
    // top of the range, so it clamps down to the maximum exactly like 9999
    // does above.
    expect(parseRequestLimit('1e9')).toBe(REQUEST_LIMIT_MAX);
    // Whitespace-only trims down to the empty string, which is the same
    // "nothing was typed" case '' already covers above.
    expect(parseRequestLimit(' ')).toBeUndefined();
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
