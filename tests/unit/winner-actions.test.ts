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

describe('availableWinnerActions', () => {
  it('offers handing over, returning and writing off a prize nobody has collected', () => {
    expect(
      availableWinnerActions({
        status: 'AWAITING_PICKUP',
        allowsReturnToStock: true,
        powers: ALL,
      }),
    ).toEqual(['deliver', 'return', 'write_off']);
  });

  it('never offers to undo a delivery that has not happened', () => {
    expect(
      availableWinnerActions({
        status: 'AWAITING_PICKUP',
        allowsReturnToStock: true,
        powers: ALL,
      }),
    ).not.toContain('cancel_delivery');
  });

  it('offers only the undo once the prize has been handed over', () => {
    expect(
      availableWinnerActions({ status: 'DELIVERED', allowsReturnToStock: true, powers: ALL }),
    ).toEqual(['cancel_delivery']);
  });

  it('offers nothing at all once a prize has gone back or been written off', () => {
    expect(
      availableWinnerActions({ status: 'RETURNED', allowsReturnToStock: true, powers: ALL }),
    ).toEqual([]);
    expect(
      availableWinnerActions({ status: 'WRITTEN_OFF', allowsReturnToStock: true, powers: ALL }),
    ).toEqual([]);
  });

  it('never offers a return for a prize registered as one that cannot go back', () => {
    // The RPC refuses this with a sentence naming the prize (0085). Not
    // offering it is the courtesy; the refusal is the rule.
    const actions = availableWinnerActions({
      status: 'AWAITING_PICKUP',
      allowsReturnToStock: false,
      powers: ALL,
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
      }),
    ).toEqual(['return', 'write_off']);

    expect(
      availableWinnerActions({
        status: 'AWAITING_PICKUP',
        allowsReturnToStock: true,
        powers: { ...ALL, return: false },
      }),
    ).toEqual(['deliver', 'write_off']);

    expect(
      availableWinnerActions({
        status: 'AWAITING_PICKUP',
        allowsReturnToStock: true,
        powers: { ...ALL, writeOff: false },
      }),
    ).toEqual(['deliver', 'return']);

    expect(
      availableWinnerActions({
        status: 'DELIVERED',
        allowsReturnToStock: true,
        powers: { ...ALL, deliverCancel: false },
      }),
    ).toEqual([]);
  });

  it('offers nothing to somebody holding no delivery permission at all', () => {
    expect(
      availableWinnerActions({
        status: 'AWAITING_PICKUP',
        allowsReturnToStock: true,
        powers: { deliver: false, deliverCancel: false, return: false, writeOff: false },
      }),
    ).toEqual([]);
  });

  it('offers nothing for SUPERSEDED, which is Block 6c’s word and not this block’s', () => {
    expect(
      availableWinnerActions({ status: 'SUPERSEDED', allowsReturnToStock: true, powers: ALL }),
    ).toEqual([]);
  });
});
