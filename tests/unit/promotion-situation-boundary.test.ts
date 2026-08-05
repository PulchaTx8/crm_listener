import { describe, expect, it } from 'vitest';
import { situationOf } from '@/lib/promotion-situation';

/**
 * The pair to supabase/tests/20_dashboards.test.sql's promotion_is_live
 * assertions. The Promotions dashboard has to classify a promotion in SQL,
 * while the grid and the record dialog classify it here, so the rule exists
 * twice — accepted in the design spec's D11 on the condition that both copies
 * are proved at the SAME instants. These are those instants. If either file
 * changes alone, one of them fails.
 */
const STARTS = '2026-08-10T00:00:00.000Z';
const ENDS = '2026-08-20T00:00:00.000Z';

describe('the promotion window is half-open, in TypeScript as in SQL', () => {
  it('is live at the instant it starts', () => {
    expect(
      situationOf({ startsAt: STARTS, endsAt: ENDS, cancelledAt: null }, new Date(STARTS)),
    ).toBe('live');
  });

  it('is ended at the instant it ends, not a moment after', () => {
    expect(
      situationOf({ startsAt: STARTS, endsAt: ENDS, cancelledAt: null }, new Date(ENDS)),
    ).toBe('ended');
  });

  it('is cancelled regardless of where the clock is', () => {
    expect(
      situationOf(
        { startsAt: STARTS, endsAt: ENDS, cancelledAt: '2026-08-15T00:00:00.000Z' },
        new Date('2026-08-16T00:00:00.000Z'),
      ),
    ).toBe('cancelled');
  });
});
