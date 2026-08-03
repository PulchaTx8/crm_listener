import { describe, expect, it } from 'vitest';
import { availableWinnerActions, type WinnerPowers } from '@/components/draws/winner-actions';

/**
 * Which buttons a winner's row offers.
 *
 * A COURTESY, never the boundary: deliver_prize, cancel_delivery, return_prize
 * and write_off_prize each re-check their own permission and their own
 * transition before writing anything (0084/0085), and a permission revoked
 * after this page rendered is still refused where it matters. What this
 * function buys is a screen that does not offer an operator something they will
 * be told off for pressing.
 *
 * Tested as a pure function because this project's unit tests run in vitest's
 * `node` environment with no DOM (vitest.config.ts).
 */

const ALL: WinnerPowers = { deliver: true, deliverCancel: true, return: true, writeOff: true };

// Every existing call below names a draw that stands, so the new field
// changes none of their meaning -- only Task 12's own cases below set it to
// CANCELLED.
const LIVE = 'COMPLETED' as const;

describe('availableWinnerActions', () => {
  it('offers handing over, returning and writing off a prize nobody has collected', () => {
    expect(
      availableWinnerActions({
        status: 'AWAITING_PICKUP',
        allowsReturnToStock: true,
        powers: ALL,
        drawStatus: LIVE,
      }),
    ).toEqual(['deliver', 'return', 'write_off']);
  });

  it('never offers to undo a delivery that has not happened', () => {
    expect(
      availableWinnerActions({
        status: 'AWAITING_PICKUP',
        allowsReturnToStock: true,
        powers: ALL,
        drawStatus: LIVE,
      }),
    ).not.toContain('cancel_delivery');
  });

  it('offers only the undo once the prize has been handed over', () => {
    expect(
      availableWinnerActions({
        status: 'DELIVERED',
        allowsReturnToStock: true,
        powers: ALL,
        drawStatus: LIVE,
      }),
    ).toEqual(['cancel_delivery']);
  });

  it('offers nothing at all once a prize has gone back or been written off', () => {
    expect(
      availableWinnerActions({
        status: 'RETURNED',
        allowsReturnToStock: true,
        powers: ALL,
        drawStatus: LIVE,
      }),
    ).toEqual([]);
    expect(
      availableWinnerActions({
        status: 'WRITTEN_OFF',
        allowsReturnToStock: true,
        powers: ALL,
        drawStatus: LIVE,
      }),
    ).toEqual([]);
  });

  it('never offers a return for a prize registered as one that cannot go back', () => {
    // The RPC refuses this with a sentence naming the prize (0085). Not
    // offering it is the courtesy; the refusal is the rule.
    const actions = availableWinnerActions({
      status: 'AWAITING_PICKUP',
      allowsReturnToStock: false,
      powers: ALL,
      drawStatus: LIVE,
    });

    expect(actions).not.toContain('return');
    expect(actions).toContain('write_off');
  });

  it('drops exactly the action whose permission is missing', () => {
    expect(
      availableWinnerActions({
        status: 'AWAITING_PICKUP',
        allowsReturnToStock: true,
        powers: { ...ALL, deliver: false },
        drawStatus: LIVE,
      }),
    ).toEqual(['return', 'write_off']);

    expect(
      availableWinnerActions({
        status: 'AWAITING_PICKUP',
        allowsReturnToStock: true,
        powers: { ...ALL, return: false },
        drawStatus: LIVE,
      }),
    ).toEqual(['deliver', 'write_off']);

    expect(
      availableWinnerActions({
        status: 'AWAITING_PICKUP',
        allowsReturnToStock: true,
        powers: { ...ALL, writeOff: false },
        drawStatus: LIVE,
      }),
    ).toEqual(['deliver', 'return']);

    expect(
      availableWinnerActions({
        status: 'DELIVERED',
        allowsReturnToStock: true,
        powers: { ...ALL, deliverCancel: false },
        drawStatus: LIVE,
      }),
    ).toEqual([]);
  });

  it('offers nothing to somebody holding no delivery permission at all', () => {
    expect(
      availableWinnerActions({
        status: 'AWAITING_PICKUP',
        allowsReturnToStock: true,
        powers: { deliver: false, deliverCancel: false, return: false, writeOff: false },
        drawStatus: LIVE,
      }),
    ).toEqual([]);
  });

  it('offers nothing for SUPERSEDED, which is Block 6c’s word and not this block’s', () => {
    expect(
      availableWinnerActions({
        status: 'SUPERSEDED',
        allowsReturnToStock: true,
        powers: ALL,
        drawStatus: LIVE,
      }),
    ).toEqual([]);
  });

  // ---------------------------------------------------------------------------
  // Block 6d, Task 12: cancel_draw (0079) leaves a cancelled draw's winners
  // AWAITING_PICKUP on purpose -- it has no vocabulary for "un-awarded" -- so a
  // winner's own status cannot tell a cancelled draw apart from a live one.
  // apply_winner_transition now refuses every transition on such a winner with
  // 22023 (the RPC is the boundary); this is the courtesy that keeps the
  // button from being there to press at all.
  it('offers nothing for a winner whose draw was cancelled, regardless of status or powers', () => {
    expect(
      availableWinnerActions({
        status: 'AWAITING_PICKUP',
        allowsReturnToStock: true,
        powers: ALL,
        drawStatus: 'CANCELLED',
      }),
    ).toEqual([]);

    expect(
      availableWinnerActions({
        status: 'DELIVERED',
        allowsReturnToStock: true,
        powers: ALL,
        drawStatus: 'CANCELLED',
      }),
    ).toEqual([]);
  });
});
