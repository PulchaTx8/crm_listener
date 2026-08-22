import { describe, expect, it } from 'vitest';
import { joinMonthDay, splitMonthDay } from '@/app/(app)/members/month-day-fields';

/**
 * Block 31a, D4. The two selects speak the `MM-DD` the URL has carried since
 * Block 30b — a change of control, not of vocabulary. A link pasted yesterday
 * means today what it meant then.
 */
describe('the month and day of a birthday filter', () => {
  it('splits what the URL carries', () => {
    expect(splitMonthDay('12-20')).toEqual({ month: '12', day: '20' });
    expect(splitMonthDay('01-05')).toEqual({ month: '01', day: '05' });
  });

  it('treats an absent or unreadable value as neither month nor day', () => {
    expect(splitMonthDay(undefined)).toEqual({ month: '', day: '' });
    expect(splitMonthDay('')).toEqual({ month: '', day: '' });
    // A hand-edited URL is hostile input, and the selects must open empty
    // rather than with a value no option holds.
    expect(splitMonthDay('nonsense')).toEqual({ month: '', day: '' });
    expect(splitMonthDay('12')).toEqual({ month: '', day: '' });
  });

  it('pads both halves, because the URL and birth_md are two digits each', () => {
    // 1 January is `01-01`, never `1-1`: `birth_md` is MMDD as a number and the
    // window compares against 101, not against 11.
    expect(joinMonthDay('1', '1')).toBe('01-01');
    expect(joinMonthDay('12', '20')).toBe('12-20');
  });

  it('answers undefined until BOTH halves are chosen', () => {
    // Half a date is not a bound. Sending `12-` would narrow the list by
    // something nobody asked for.
    expect(joinMonthDay('12', '')).toBeUndefined();
    expect(joinMonthDay('', '20')).toBeUndefined();
    expect(joinMonthDay('', '')).toBeUndefined();
  });

  it('round-trips every value the two selects can produce', () => {
    for (const month of ['01', '06', '12']) {
      for (const day of ['01', '09', '31']) {
        const joined = joinMonthDay(month, day);
        expect(joined).toBeDefined();
        expect(splitMonthDay(joined)).toEqual({ month, day });
      }
    }
  });
});
