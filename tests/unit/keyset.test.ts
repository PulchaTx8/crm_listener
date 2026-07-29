import { describe, expect, it } from 'vitest';
import { decodeCursor, encodeCursor, keysetFilter } from '@/lib/keyset';

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

  it('ascending: strictly greater, or equal with a greater id', () => {
    expect(keysetFilter('full_name', 'asc', cur, false)).toBe(
      'full_name.gt."M",and(full_name.eq."M",id.gt."bbbbbbbb-0000-0000-0000-000000000001")',
    );
  });

  it('descending: strictly less, or equal with a lesser id', () => {
    expect(keysetFilter('created_at', 'desc', cur, false)).toBe(
      'created_at.lt."M",and(created_at.eq."M",id.lt."bbbbbbbb-0000-0000-0000-000000000001")',
    );
  });

  // The bug this exists to prevent: ascending with nulls last, `col.gt.V` is false
  // for every null row, so without this arm the null region is never reached and
  // every listener without a name silently disappears from the last page.
  it('ascending with nulls last reaches the null region', () => {
    expect(keysetFilter('full_name', 'asc', cur, true)).toBe(
      'full_name.gt."M",and(full_name.eq."M",id.gt."bbbbbbbb-0000-0000-0000-000000000001"),full_name.is.null',
    );
  });

  it('inside the null region, pages by id alone', () => {
    const nullCur = { value: null, id: 'cccccccc-0000-0000-0000-000000000001' };
    expect(keysetFilter('full_name', 'asc', nullCur, true)).toBe(
      'and(full_name.is.null,id.gt."cccccccc-0000-0000-0000-000000000001")',
    );
  });
});
