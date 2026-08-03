import { describe, expect, it } from 'vitest';
import { decodeCursor, encodeCursor } from '@/lib/keyset';

describe('decodeCursor', () => {
  it('round-trips a real cursor', () => {
    const cursor = { value: '2026-08-03T10:00:00Z', id: '3f2504e0-4f89-11d3-9a0c-0305e82c3301' };
    expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor);
  });

  it('round-trips a cursor whose sort value is null', () => {
    const cursor = { value: null, id: '3f2504e0-4f89-11d3-9a0c-0305e82c3301' };
    expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor);
  });

  // The hole this closes. `{"value":null,"id":"abc"}` parsed perfectly, reached
  // Postgres as id.lt."abc" and came back 22P02 -- which at least one screen
  // rendered verbatim, showing a listener raw database text.
  it('refuses an id that is not a uuid', () => {
    const forged = Buffer.from(JSON.stringify({ value: null, id: 'abc' })).toString('base64url');
    expect(decodeCursor(forged)).toBeNull();
  });

  it('refuses a uuid-shaped string with the wrong length', () => {
    const forged = Buffer.from(
      JSON.stringify({ value: null, id: '3f2504e0-4f89-11d3-9a0c-0305e82c33' }),
    ).toString('base64url');
    expect(decodeCursor(forged)).toBeNull();
  });

  it('still returns null for junk, as it always did', () => {
    expect(decodeCursor('not base64 at all!!')).toBeNull();
    expect(decodeCursor('')).toBeNull();
    expect(decodeCursor(undefined)).toBeNull();
  });
});
