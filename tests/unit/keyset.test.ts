import { describe, expect, it } from 'vitest';
import { decodeCursor, encodeCursor, keysetFilter, keysetPage } from '@/lib/keyset';

describe('cursor encoding', () => {
  it('round-trips a value and its tiebreak id', () => {
    const c = { value: '2026-07-28T12:00:00.000Z', id: 'aaaaaaaa-0000-0000-0000-000000000001' };
    expect(decodeCursor(encodeCursor(c))).toEqual(c);
  });

  it('round-trips a null value, which is how the null region is entered', () => {
    const c = { value: null, id: 'aaaaaaaa-0000-0000-0000-000000000002' };
    expect(decodeCursor(encodeCursor(c))).toEqual(c);
  });

  // Every one of these arrives from a URL, which is hostile input. None may throw:
  // an unreadable cursor means "start from the beginning", never a 500.
  it.each([
    [undefined, 'absent'],
    [null, 'null'],
    ['', 'empty'],
    ['not-base64!!', 'not base64'],
    [Buffer.from('{"nope":1}').toString('base64url'), 'wrong shape'],
    [Buffer.from('[]').toString('base64url'), 'not an object'],
    [Buffer.from('{"value":"a","id":123}').toString('base64url'), 'id not a string'],
  ] as Array<[string | null | undefined, string]>)('returns null for a %s cursor (%s)', (raw) => {
    expect(decodeCursor(raw as string | undefined)).toBeNull();
  });
});

describe('keysetFilter', () => {
  const cur = { value: 'M', id: 'bbbbbbbb-0000-0000-0000-000000000001' };
  const nullCur = { value: null, id: 'cccccccc-0000-0000-0000-000000000001' };

  // nullsLast decides which region is terminal, independent of direction: with
  // nulls last the null region trails the non-null region under BOTH asc and
  // desc, so the extra `col.is.null` arm is needed in both, not only ascending.
  describe('non-null region', () => {
    it('ascending, nulls first: strictly greater, or equal with a greater id, no null arm', () => {
      expect(keysetFilter('full_name', 'asc', cur, false)).toBe(
        'full_name.gt."M",and(full_name.eq."M",id.gt."bbbbbbbb-0000-0000-0000-000000000001")',
      );
    });

    it('descending, nulls first: strictly less, or equal with a lesser id, no null arm', () => {
      expect(keysetFilter('created_at', 'desc', cur, false)).toBe(
        'created_at.lt."M",and(created_at.eq."M",id.lt."bbbbbbbb-0000-0000-0000-000000000001")',
      );
    });

    // The bug this exists to prevent: ascending with nulls last, `col.gt.V` is false
    // for every null row, so without this arm the null region is never reached and
    // every listener without a name silently disappears from the last page.
    it('ascending, nulls last: reaches the trailing null region', () => {
      expect(keysetFilter('full_name', 'asc', cur, true)).toBe(
        'full_name.gt."M",and(full_name.eq."M",id.gt."bbbbbbbb-0000-0000-0000-000000000001"),full_name.is.null',
      );
    });

    // The same bug, descending: `col.lt.V` is equally false for every null row,
    // so nulls-last needs this arm regardless of which direction is sorted.
    it('descending, nulls last: reaches the trailing null region', () => {
      expect(keysetFilter('created_at', 'desc', cur, true)).toBe(
        'created_at.lt."M",and(created_at.eq."M",id.lt."bbbbbbbb-0000-0000-0000-000000000001"),created_at.is.null',
      );
    });
  });

  describe('null region', () => {
    it('ascending, nulls last: pages by id alone, the null region is terminal', () => {
      expect(keysetFilter('full_name', 'asc', nullCur, true)).toBe(
        'and(full_name.is.null,id.gt."cccccccc-0000-0000-0000-000000000001")',
      );
    });

    it('descending, nulls last: pages by id alone, the null region is terminal', () => {
      expect(keysetFilter('full_name', 'desc', nullCur, true)).toBe(
        'and(full_name.is.null,id.lt."cccccccc-0000-0000-0000-000000000001")',
      );
    });

    // The bug this exists to prevent: nulls first means the null region is NOT
    // terminal — the non-null region follows it. Without this arm, paging stops
    // the moment the null region is exhausted and every row with a value becomes
    // unreachable.
    it('ascending, nulls first: also reaches the non-null region that follows', () => {
      expect(keysetFilter('full_name', 'asc', nullCur, false)).toBe(
        'and(full_name.is.null,id.gt."cccccccc-0000-0000-0000-000000000001"),full_name.not.is.null',
      );
    });

    it('descending, nulls first: also reaches the non-null region that follows', () => {
      expect(keysetFilter('full_name', 'desc', nullCur, false)).toBe(
        'and(full_name.is.null,id.lt."cccccccc-0000-0000-0000-000000000001"),full_name.not.is.null',
      );
    });
  });
});

describe('keysetPage', () => {
  const rows = (...ids: string[]) => ids.map((id) => ({ id, value: id }));
  const cursorFor = (row: { id: string; value: string }) => ({ value: row.value, id: row.id });
  const decode = (raw: string | null) => (raw === null ? null : decodeCursor(raw));

  it('first page, more to come: Next only', () => {
    const page = keysetPage(rows('a', 'b', 'c'), {
      pageSize: 2,
      walkingBack: false,
      hadCursor: false,
      cursorFor,
    });
    expect(page.rows.map((r) => r.id)).toEqual(['a', 'b']);
    expect(decode(page.nextCursor)).toEqual({ value: 'b', id: 'b' });
    expect(page.previousCursor).toBeNull();
  });

  it('first page, nothing beyond it: neither control', () => {
    const page = keysetPage(rows('a', 'b'), {
      pageSize: 2,
      walkingBack: false,
      hadCursor: false,
      cursorFor,
    });
    expect(page.nextCursor).toBeNull();
    expect(page.previousCursor).toBeNull();
  });

  // The over-fetched row is the answer to "is there more", never a row anyone
  // sees. Rendering it would show pageSize + 1 rows and then repeat the last
  // one at the top of the next page.
  it('never renders the row it over-fetched', () => {
    const page = keysetPage(rows('a', 'b', 'c'), {
      pageSize: 2,
      walkingBack: false,
      hadCursor: false,
      cursorFor,
    });
    expect(page.rows).toHaveLength(2);
    expect(page.rows.map((r) => r.id)).not.toContain('c');
  });

  it('a later page offers Previous even when nothing follows it', () => {
    const page = keysetPage(rows('c', 'd'), {
      pageSize: 2,
      walkingBack: false,
      hadCursor: true,
      cursorFor,
    });
    expect(page.nextCursor).toBeNull();
    expect(decode(page.previousCursor)).toEqual({ value: 'c', id: 'c' });
  });

  // Walking back reads the ordering in reverse, so the rows arrive backwards
  // and have to be turned around before anyone sees them.
  it('walking back: rows come out in display order, and Next always exists', () => {
    const page = keysetPage(rows('d', 'c', 'b'), {
      pageSize: 2,
      walkingBack: true,
      hadCursor: true,
      cursorFor,
    });
    expect(page.rows.map((r) => r.id)).toEqual(['c', 'd']);
    expect(decode(page.nextCursor)).toEqual({ value: 'd', id: 'd' });
    // The over-fetched 'b' proves a page still exists behind this one.
    expect(decode(page.previousCursor)).toEqual({ value: 'c', id: 'c' });
  });

  it('walking back onto the first page: Previous disappears', () => {
    const page = keysetPage(rows('b', 'a'), {
      pageSize: 2,
      walkingBack: true,
      hadCursor: true,
      cursorFor,
    });
    expect(page.rows.map((r) => r.id)).toEqual(['a', 'b']);
    expect(page.previousCursor).toBeNull();
    expect(decode(page.nextCursor)).toEqual({ value: 'b', id: 'b' });
  });

  it('no rows at all: no controls, and nothing thrown', () => {
    const page = keysetPage([], {
      pageSize: 2,
      walkingBack: false,
      hadCursor: true,
      cursorFor,
    });
    expect(page.rows).toEqual([]);
    expect(page.nextCursor).toBeNull();
    expect(page.previousCursor).toBeNull();
  });
});
