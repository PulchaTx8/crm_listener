import { describe, expect, it } from 'vitest';
import { validateDrawRequest, type DrawUnitChoice } from '@/components/draws/run-draw-dialog';

/**
 * The run-draw dialog's own rules, tested as a pure function rather than
 * through the component: this project's unit tests run in vitest's `node`
 * environment with no DOM (vitest.config.ts), so there is no render to assert
 * against — the same reasoning tests/unit/promotion-record-dialog.test.ts
 * gives for its own shape.
 *
 * These rules are a COURTESY, never the boundary. apply_draw (0078) refuses a
 * shortfall with 22023 whatever this function returns, and it is the one that
 * counts: the balances can move between this dialog rendering and its Submit.
 */

function choice(over: Partial<DrawUnitChoice> = {}): DrawUnitChoice {
  return {
    promotionPrizeId: '11111111-0000-0000-0000-000000000001',
    prizeName: 'Bicycle',
    available: 3,
    requested: 3,
    ...over,
  };
}

describe('validateDrawRequest', () => {
  it('accepts a request for everything that is available', () => {
    const result = validateDrawRequest({ units: [choice()] });

    expect(result.ok).toBe(true);
    expect(result.ok && result.units).toEqual([
      { promotionPrizeId: '11111111-0000-0000-0000-000000000001', quantity: 3 },
    ]);
  });

  it('refuses more units than are available', () => {
    const result = validateDrawRequest({
      units: [choice({ available: 2, requested: 3 })],
    });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.message).toContain('Bicycle');
  });

  it('drops a prize the operator asked nothing of, rather than sending a zero', () => {
    // run_draw would refuse quantity 0 with 22023. A row left at zero is the
    // operator declining that prize, not asking for none of it.
    const result = validateDrawRequest({
      units: [
        choice({ requested: 0 }),
        choice({
          promotionPrizeId: '22222222-0000-0000-0000-000000000002',
          prizeName: 'Ticket',
          available: 2,
          requested: 1,
        }),
      ],
    });

    expect(result.ok).toBe(true);
    expect(result.ok && result.units).toEqual([
      { promotionPrizeId: '22222222-0000-0000-0000-000000000002', quantity: 1 },
    ]);
  });

  it('refuses a draw of nothing at all', () => {
    const result = validateDrawRequest({
      units: [choice({ requested: 0 })],
    });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.message).toMatch(/at least one unit/i);
  });

  it('refuses a fractional quantity rather than letting Postgres round it', () => {
    const result = validateDrawRequest({
      units: [choice({ requested: 1.5 })],
    });

    expect(result.ok).toBe(false);
  });

  it('sends nothing at all when every prize is taken in full', () => {
    // Null means "everything still linked" to run_draw (D8), and it is what the
    // dialog sends when the operator has not narrowed anything: the default
    // must not depend on the screen having read the balances correctly.
    const result = validateDrawRequest({
      units: [
        choice({ available: 3, requested: 3 }),
        choice({
          promotionPrizeId: '22222222-0000-0000-0000-000000000002',
          prizeName: 'Ticket',
          available: 2,
          requested: 2,
        }),
      ],
      allTaken: true,
    });

    expect(result.ok).toBe(true);
    expect(result.ok && result.units).toBeNull();
  });
});
