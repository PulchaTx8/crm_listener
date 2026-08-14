import { describe, expect, it } from 'vitest';
import { isMovementFilterApplied } from '@/app/(app)/inventory/prize-record-dialog';

/**
 * Fix-round finding C: the Movimentação tab's empty-state message used to be
 * chosen from `filtered !== null` — "has Consultar been clicked" — rather
 * than from whether a filter was genuinely set, so an operator who filters,
 * clears all three fields and presses Consultar again read "no movement
 * matches these filters" on a prize that simply has no history. This tests
 * the corrected derivation directly, as a pure function, since
 * prize-record-dialog.tsx has no render to assert against in vitest's `node`
 * environment (vitest.config.ts) — the same reasoning
 * promotion-record-dialog.test.ts gives for testing its own extracted
 * function the same way.
 */
describe('isMovementFilterApplied', () => {
  // THE CASE THIS FIX EXISTS FOR: a Consultar submission with every field
  // blank must read as unfiltered, not as "Consultar was pressed".
  it('is false when Consultar is pressed with all three fields empty', () => {
    expect(isMovementFilterApplied(undefined, undefined, undefined)).toBe(false);
  });

  it('is true when a type is chosen, with no period', () => {
    expect(isMovementFilterApplied(['PURCHASE_ENTRY'], undefined, undefined)).toBe(true);
  });

  it('is true when only a From date is set', () => {
    expect(isMovementFilterApplied(undefined, '2026-01-01T00:00:00.000Z', undefined)).toBe(true);
  });

  it('is true when only a To date is set', () => {
    expect(isMovementFilterApplied(undefined, undefined, '2026-01-31T23:59:59.999Z')).toBe(true);
  });

  it('is true when every field carries something', () => {
    expect(
      isMovementFilterApplied(['RESERVATION'], '2026-01-01T00:00:00.000Z', '2026-01-31T23:59:59.999Z'),
    ).toBe(true);
  });
});
