import { describe, expect, it } from 'vitest';
import { canSelectAll, stationPills } from '@/app/(app)/dashboards/station-pills';

/**
 * The one control the dashboards' top-left corner has, after the single-Station
 * switcher row was folded into "Stations shown".
 *
 * WHY THIS IS A PURE MODULE AND NOT A COMPONENT TEST: this project installs no
 * jsdom, for the reason place-map-geometry.ts already sets out. What is worth
 * proving is not that a row of links mounts; it is that no pill can ever build a
 * URL the RPC refuses — and every one of those decisions is arithmetic over three
 * arrays.
 */

const A = { id: 'a', name: 'Alpha' };
const B = { id: 'b', name: 'Bravo' };
const C = { id: 'c', name: 'Charlie' };

const by = (pills: ReturnType<typeof stationPills>, id: string) => {
  const pill = pills.find((candidate) => candidate.id === id);
  if (!pill) throw new Error(`no pill for ${id}`);
  return pill;
};

describe('stationPills, with two or more Stations the caller can consolidate', () => {
  const consolidatedIds = ['a', 'b'];

  it('adds a Station that is off, keeping the ones already on', () => {
    const pills = stationPills({
      stations: [A, B],
      consolidatedIds,
      selectedIds: ['a'],
      fallbackId: 'a',
    });
    expect(by(pills, 'b')).toMatchObject({ mode: 'toggle', selected: false });
    expect(by(pills, 'b').next.sort()).toEqual(['a', 'b']);
  });

  it('removes a Station that is on', () => {
    const pills = stationPills({
      stations: [A, B],
      consolidatedIds,
      selectedIds: ['a', 'b'],
      fallbackId: 'a',
    });
    expect(by(pills, 'b')).toMatchObject({ mode: 'toggle', selected: true });
    expect(by(pills, 'b').next).toEqual(['a']);
  });

  it('falls back to the caller’s own Station rather than to an empty selection', () => {
    // A SELECTION OF ZERO IS NOT A SELECTION: 0118 raises 22023 for an empty
    // set. And the fallback is the caller's Station, never the pill's own id —
    // turning a pill off must not read as turning it on.
    const pills = stationPills({
      stations: [A, B],
      consolidatedIds,
      selectedIds: ['b'],
      fallbackId: 'a',
    });
    expect(by(pills, 'b').next).toEqual(['a']);
  });

  it('never carries a Station the caller cannot consolidate into a multi-Station URL', () => {
    // THE TRAP THE MIXED ROW INTRODUCED. C is visible (members.view) but outside
    // reports.consolidated. Landing on it alone is legal; being swept into a
    // selection alongside A is what 0118 refuses with 42501. Adding B while C is
    // the current selection must therefore drop C, not append to it.
    const pills = stationPills({
      stations: [A, B, C],
      consolidatedIds,
      selectedIds: ['c'],
      fallbackId: 'a',
    });
    expect(by(pills, 'b').next).toEqual(['b']);
  });

  it('offers a Station outside reports.consolidated as a replacement, not as an addition', () => {
    const pills = stationPills({
      stations: [A, B, C],
      consolidatedIds,
      selectedIds: ['a', 'b'],
      fallbackId: 'a',
    });
    expect(by(pills, 'c')).toMatchObject({ mode: 'replace', selected: false });
    expect(by(pills, 'c').next).toEqual(['c']);
  });

  it('keeps the Stations in the order it was handed them', () => {
    // Two rows of the same names in two different orders is the reading cost
    // that makes an operator check whether they are the same list. There is only
    // one row now, and it follows `viewable`.
    const pills = stationPills({
      stations: [C, A, B],
      consolidatedIds,
      selectedIds: ['a'],
      fallbackId: 'a',
    });
    expect(pills.map((pill) => pill.id)).toEqual(['c', 'a', 'b']);
  });

  it('lights exactly the Stations whose figures are on the screen', () => {
    const pills = stationPills({
      stations: [A, B, C],
      consolidatedIds,
      selectedIds: ['a', 'b'],
      fallbackId: 'a',
    });
    expect(pills.filter((pill) => pill.selected).map((pill) => pill.id)).toEqual(['a', 'b']);
  });
});

describe('stationPills, with fewer than two Stations the caller can consolidate', () => {
  it('makes EVERY pill replace the selection, including the one consolidable Station', () => {
    // THE WEAK CALLER, and the reason this branch exists at all. With one
    // consolidable Station there is no set to build: a toggle on the only
    // eligible pill could only ever turn it off, and "off" is an empty
    // selection. Every pill here does what the old switcher row did.
    const pills = stationPills({
      stations: [A, B],
      consolidatedIds: ['a'],
      selectedIds: ['a'],
      fallbackId: 'a',
    });
    expect(pills.map((pill) => pill.mode)).toEqual(['replace', 'replace']);
    expect(by(pills, 'a').next).toEqual(['a']);
    expect(by(pills, 'b').next).toEqual(['b']);
  });

  it('still lights the Station being shown', () => {
    const pills = stationPills({
      stations: [A, B],
      consolidatedIds: ['a'],
      selectedIds: ['b'],
      fallbackId: 'a',
    });
    expect(by(pills, 'b').selected).toBe(true);
    expect(by(pills, 'a').selected).toBe(false);
  });

  it('offers the same replacements when the caller can consolidate nothing at all', () => {
    const pills = stationPills({
      stations: [A, B],
      consolidatedIds: [],
      selectedIds: ['a'],
      fallbackId: 'a',
    });
    expect(pills.map((pill) => pill.mode)).toEqual(['replace', 'replace']);
  });
});

describe('canSelectAll', () => {
  it('offers "All stations" only when there is a set to select', () => {
    // The chip links to every consolidable id at once. With one, that link is
    // just another single Station wearing a label that claims more; with none it
    // would be an empty array, which 0118 raises 22023 for.
    expect(canSelectAll(['a', 'b'])).toBe(true);
    expect(canSelectAll(['a'])).toBe(false);
    expect(canSelectAll([])).toBe(false);
  });
});
