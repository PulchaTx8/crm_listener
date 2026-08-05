import { describe, expect, it } from 'vitest';
import { parsePeriod } from '@/app/(app)/dashboards/period';

describe('the period search params', () => {
  it('defaults to the current month when nothing is asked for', () => {
    expect(parsePeriod({})).toEqual({ preset: 'current_month', from: null, to: null });
  });

  it('keeps a known preset', () => {
    expect(parsePeriod({ preset: 'current_year' })).toEqual({
      preset: 'current_year', from: null, to: null,
    });
  });

  // A typo in a URL must not silently answer a different question. The database
  // refuses an unknown preset with 22023 (0117); this refuses it earlier, so the
  // screen can say so without a round trip.
  it('falls back to the current month for an unknown preset', () => {
    expect(parsePeriod({ preset: 'last_tuesday' })).toEqual({
      preset: 'current_month', from: null, to: null,
    });
  });

  it('keeps a custom range only when both bounds are real dates', () => {
    expect(parsePeriod({ preset: 'custom', from: '2026-08-01', to: '2026-09-01' })).toEqual({
      preset: 'custom', from: '2026-08-01', to: '2026-09-01',
    });
    expect(parsePeriod({ preset: 'custom', from: '2026-08-01' })).toEqual({
      preset: 'current_month', from: null, to: null,
    });
    expect(parsePeriod({ preset: 'custom', from: 'yesterday', to: 'today' })).toEqual({
      preset: 'current_month', from: null, to: null,
    });
  });

  it('refuses a range that ends before it starts', () => {
    expect(parsePeriod({ preset: 'custom', from: '2026-09-01', to: '2026-08-01' })).toEqual({
      preset: 'current_month', from: null, to: null,
    });
  });
});
