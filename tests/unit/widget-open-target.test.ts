import { describe, expect, it } from 'vitest';
import { parseOpenTarget } from '@/lib/widget/open-target';

const VALID_UUID = '5b1c9c2e-3f2a-4a8b-9e3d-9c1a2b3c4d5e';

describe('parseOpenTarget', () => {
  it('opens the song panel for open=music', () => {
    expect(parseOpenTarget('music', undefined)).toEqual({ kind: 'music' });
  });

  it('opens a promotion panel for open=promotion with a UUID-shaped id', () => {
    expect(parseOpenTarget('promotion', VALID_UUID)).toEqual({
      kind: 'promotion',
      id: VALID_UUID,
    });
  });

  it('falls back to the menu when open is absent', () => {
    expect(parseOpenTarget(undefined, undefined)).toEqual({ kind: 'menu' });
  });

  it('falls back to the menu for a value this page does not know', () => {
    expect(parseOpenTarget('something-else', undefined)).toEqual({ kind: 'menu' });
  });

  it('falls back to the menu for open=promotion with no id', () => {
    expect(parseOpenTarget('promotion', undefined)).toEqual({ kind: 'menu' });
  });

  it('falls back to the menu for open=promotion with a malformed id', () => {
    expect(parseOpenTarget('promotion', 'not-a-uuid')).toEqual({ kind: 'menu' });
    expect(parseOpenTarget('promotion', '')).toEqual({ kind: 'menu' });
    expect(parseOpenTarget('promotion', '12345')).toEqual({ kind: 'menu' });
  });

  /**
   * Next does not promise a repeated query key collapses to a single string --
   * `?id=a&id=b` reaches a Server Component's `searchParams` as an array --
   * and an array is not the shape either parameter is ever meant to carry.
   */
  it('falls back to the menu when open or id arrives as an array', () => {
    expect(parseOpenTarget(['music', 'promotion'], undefined)).toEqual({ kind: 'menu' });
    expect(parseOpenTarget('promotion', [VALID_UUID, VALID_UUID])).toEqual({ kind: 'menu' });
  });

  it('music wins even if an id is also present, and the id is ignored', () => {
    expect(parseOpenTarget('music', VALID_UUID)).toEqual({ kind: 'music' });
  });
});
