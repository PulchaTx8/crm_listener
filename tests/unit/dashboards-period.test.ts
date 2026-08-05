import { describe, expect, it } from 'vitest';
import { exclusiveEnd, inclusiveEnd, parsePeriod } from '@/app/(app)/dashboards/period';

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

  // Whole-branch review, Important B3. `to` is EXCLUSIVE, so from === to is a
  // period of zero length and 0117:91 refuses it with 22023 (`p_to <=
  // p_from`) exactly as it refuses a reversed one. This parser compared
  // `from > to`, so the one URL an operator produces by picking the same date
  // twice passed straight through and threw at the database — replacing the
  // whole page with "That period is not valid." for input this file's own
  // contract promises to repair silently.
  it('refuses a range that ends where it starts, because the end is exclusive', () => {
    expect(parsePeriod({ preset: 'custom', from: '2026-08-01', to: '2026-08-01' })).toEqual({
      preset: 'current_month', from: null, to: null,
    });
  });
});

/**
 * Whole-branch review, Important B4. The control shows the operator an
 * INCLUSIVE last day and the URL carries the exclusive bound everything
 * underneath agrees on; these two are the whole of that conversion, and the
 * property that matters is that composing them changes nothing.
 */
describe('the inclusive/exclusive end of a custom range', () => {
  it('shows the last day a period includes, not the day after it', () => {
    expect(inclusiveEnd('2026-09-01')).toBe('2026-08-31');
    expect(exclusiveEnd('2026-08-31')).toBe('2026-09-01');
  });

  it('crosses a month, a year and a leap day without losing one', () => {
    expect(inclusiveEnd('2027-01-01')).toBe('2026-12-31');
    expect(exclusiveEnd('2026-12-31')).toBe('2027-01-01');
    expect(inclusiveEnd('2028-03-01')).toBe('2028-02-29');
    expect(exclusiveEnd('2028-02-29')).toBe('2028-03-01');
  });

  // The round trip the control performs on every render: seed from the
  // payload, show, submit, seed again. If this ever drifts, an operator loses
  // or gains a day simply by looking at the screen twice.
  it('round-trips, so seeding twice cannot move the period', () => {
    for (const exclusive of ['2026-09-01', '2026-01-01', '2028-03-01', '2026-08-02']) {
      expect(exclusiveEnd(inclusiveEnd(exclusive))).toBe(exclusive);
    }
  });

  // A single-day period: the inclusive form an operator types is from === to,
  // which becomes a legal one-day exclusive range rather than the zero-length
  // one parsePeriod above refuses.
  it('turns a single day into a one-day range, not an empty one', () => {
    const from = '2026-08-15';
    const to = exclusiveEnd('2026-08-15');
    expect(to).toBe('2026-08-16');
    expect(parsePeriod({ preset: 'custom', from, to })).toEqual({ preset: 'custom', from, to });
  });

  // Not a real date: handed back untouched, so parsePeriod does the refusing
  // rather than this quietly inventing a different day.
  it('leaves an impossible date alone for parsePeriod to refuse', () => {
    expect(inclusiveEnd('2026-02-31')).toBe('2026-02-31');
    expect(exclusiveEnd('not-a-date')).toBe('not-a-date');
  });
});
