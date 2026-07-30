import { describe, expect, it } from 'vitest';
import { applyRowPatch } from '@/lib/row-patch';

const rows = [
  { id: 'a', name: 'Ana' },
  { id: 'b', name: 'Bruno' },
  { id: 'c', name: 'Carla' },
];
const state = { rows, total: 3 };

describe('applyRowPatch', () => {
  // The rule the whole pattern rests on: the operator's place in the list is
  // worth more than the list being re-sorted under them mid-edit.
  it('a saved row keeps its position even when the new value would sort elsewhere', () => {
    const next = applyRowPatch(state, { kind: 'save', row: { id: 'a', name: 'Zoe' } });
    expect(next.rows.map((r) => r.id)).toEqual(['a', 'b', 'c']);
    expect(next.rows[0]).toEqual({ id: 'a', name: 'Zoe' });
    expect(next.total).toBe(3);
  });

  // Opened from a pasted link while the grid shows some other page: there is
  // nothing to patch, and nothing about the count changed either.
  it('saving a row that is not on this page changes nothing', () => {
    const next = applyRowPatch(state, { kind: 'save', row: { id: 'zz', name: 'Ghost' } });
    expect(next.rows).toEqual(rows);
    expect(next.total).toBe(3);
  });

  it('removing takes the row out and drops the total by one', () => {
    const next = applyRowPatch(state, { kind: 'remove', id: 'b' });
    expect(next.rows.map((r) => r.id)).toEqual(['a', 'c']);
    expect(next.total).toBe(2);
  });

  it('removing a row that is not here leaves the total alone', () => {
    const next = applyRowPatch(state, { kind: 'remove', id: 'zz' });
    expect(next.rows).toEqual(rows);
    expect(next.total).toBe(3);
  });

  it('creating puts the row on top and raises the total by one', () => {
    const next = applyRowPatch(state, { kind: 'create', row: { id: 'd', name: 'Diego' } });
    expect(next.rows.map((r) => r.id)).toEqual(['d', 'a', 'b', 'c']);
    expect(next.total).toBe(4);
  });

  // The audience screen shows no total under its rules-consent filter (Block
  // 3b), and "not counted" has to survive every patch rather than quietly
  // becoming a number that would be wrong.
  it('leaves a null total null', () => {
    expect(applyRowPatch({ rows, total: null }, { kind: 'remove', id: 'a' }).total).toBeNull();
    expect(
      applyRowPatch({ rows, total: null }, { kind: 'create', row: { id: 'd', name: 'D' } }).total,
    ).toBeNull();
  });

  it('never mutates the array it was given', () => {
    applyRowPatch(state, { kind: 'remove', id: 'a' });
    applyRowPatch(state, { kind: 'save', row: { id: 'a', name: 'Zoe' } });
    expect(rows.map((r) => r.name)).toEqual(['Ana', 'Bruno', 'Carla']);
  });
});
