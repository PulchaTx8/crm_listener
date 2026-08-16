import { describe, expect, it } from 'vitest';
import { actionLabelKey, describeActor } from '@/app/(app)/inventory/movement-history';
import type { MovementEntry } from '@/services/inventory';

/**
 * A translator stub that returns the key itself, so an assertion against a
 * key name doubles as an assertion that describeActor actually called `t`
 * (a hard-coded English fallback would fail these the same way it would fail
 * tests/unit/i18n/usage.test.ts's own AST check on the real component).
 */
const t = (key: string) => key;

function baseMovement(overrides: Partial<MovementEntry> = {}): MovementEntry {
  return {
    id: 'movement-1',
    movementType: 'MANUAL_ENTRY',
    quantity: 10,
    fromBucket: null,
    toBucket: 'available',
    note: null,
    actorId: 'operator-1',
    actorName: 'Ana Souza',
    createdAt: '2026-08-01T12:00:00Z',
    invoiceNumber: null,
    unitAmount: null,
    totalAmount: null,
    reservedForShowId: null,
    showName: null,
    vendorId: null,
    vendorName: null,
    reversesMovementId: null,
    reversedAt: null,
    reversalId: null,
    remainingQuantity: null,
    ...overrides,
  };
}

describe('describeActor', () => {
  // The whole reason MovementEntry's own actorName carries a header comment:
  // actorId === null must never be read as "unnamed" — it is the automated
  // case, the deadline sweep, and crediting a machine with anonymity rather
  // than naming what it was is the exact confusion D11 exists to prevent.
  it('reads a null actorId as the automated case, regardless of actorName', () => {
    expect(describeActor(baseMovement({ actorId: null, actorName: null }), t)).toBe(
      'movementActorDeadline',
    );
  });

  // The defect this discipline specifically guards against: keying off
  // actorName instead of actorId. If describeActor read actorName first, an
  // actorId present with actorName also somehow null would collapse onto the
  // same branch as the true automated case above -- this assertion is what
  // catches that.
  it('is a real operator with no display name when actorId is present and actorName is null', () => {
    expect(describeActor(baseMovement({ actorId: 'operator-2', actorName: null }), t)).toBe(
      'unnamedOperator',
    );
  });

  it('renders the operator\'s own name when both are present', () => {
    expect(describeActor(baseMovement({ actorId: 'operator-1', actorName: 'Ana Souza' }), t)).toBe(
      'Ana Souza',
    );
  });
});

describe('actionLabelKey', () => {
  it('offers Arquivar on an unreversed entry', () => {
    expect(actionLabelKey(baseMovement({ movementType: 'MANUAL_ENTRY', reversedAt: null }))).toBe(
      'archiveMovement',
    );
  });

  it('offers Arquivar on an unreversed exit', () => {
    expect(actionLabelKey(baseMovement({ movementType: 'MANUAL_EXIT', reversedAt: null }))).toBe(
      'archiveMovement',
    );
  });

  it('offers nothing on an entry already reversed', () => {
    expect(
      actionLabelKey(baseMovement({ movementType: 'PURCHASE_ENTRY', reversedAt: '2026-08-02T09:00:00Z' })),
    ).toBeNull();
  });

  it('offers Liberar on a reservation with quantity remaining', () => {
    expect(
      actionLabelKey(
        baseMovement({ movementType: 'RESERVATION', quantity: 5, remainingQuantity: 2 }),
      ),
    ).toBe('releaseThisReservation');
  });

  // Fully released: nothing left for the door to release, so the database
  // would refuse it -- the same "withhold the button it would refuse" rule
  // Task 6's own brief cites for the entry/exit Arquivar action.
  it('offers nothing on a reservation with nothing left to release', () => {
    expect(
      actionLabelKey(baseMovement({ movementType: 'RESERVATION', quantity: 5, remainingQuantity: 0 })),
    ).toBeNull();
  });

  // D6: undone on the promotion's own screen, never through this door --
  // whatever `onReverse` this row's caller holds, it must never be offered
  // here.
  it('offers nothing on a promotion link', () => {
    expect(actionLabelKey(baseMovement({ movementType: 'PROMOTION_LINK' }))).toBeNull();
  });

  it('offers nothing on a promotion unlink', () => {
    expect(actionLabelKey(baseMovement({ movementType: 'PROMOTION_UNLINK' }))).toBeNull();
  });

  // A kind this door was never going to touch (reverse_movement, 0195,
  // refuses anything but an entry or an exit) -- a draw is undone by its own
  // screen's own door, never by Arquivar.
  it('offers nothing on a kind reverse_movement does not accept', () => {
    expect(actionLabelKey(baseMovement({ movementType: 'DRAW' }))).toBeNull();
    expect(actionLabelKey(baseMovement({ movementType: 'ADJUSTMENT_POSITIVE' }))).toBeNull();
  });

  // A reversal row is itself an entry/exit type movement (reversing an entry
  // writes a MANUAL_EXIT, and vice versa) and reversing a reversal is a door
  // the spec explicitly permits (0195's own header) -- so a reversal that has
  // not itself been reversed again must still offer Arquivar.
  it('offers Arquivar on a reversal row that has not itself been reversed', () => {
    expect(
      actionLabelKey(
        baseMovement({ movementType: 'MANUAL_EXIT', reversesMovementId: 'movement-0', reversedAt: null }),
      ),
    ).toBe('archiveMovement');
  });
});
