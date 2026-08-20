import { describe, expect, it } from 'vitest';
import { birthdayCode, birthdayWindow } from '@/lib/members/birthday';

describe('birthdayCode', () => {
  it('reads MM-DD as the number the column holds', () => {
    expect(birthdayCode('12-31')).toBe(1231);
    expect(birthdayCode('01-05')).toBe(105);
    expect(birthdayCode('02-29')).toBe(229);
  });

  it('refuses anything that is not a real day, rather than guessing', () => {
    expect(birthdayCode('13-01')).toBeNull();
    expect(birthdayCode('00-10')).toBeNull();
    expect(birthdayCode('01-32')).toBeNull();
    expect(birthdayCode('1-5')).toBeNull();
    expect(birthdayCode('nonsense')).toBeNull();
    expect(birthdayCode(undefined)).toBeNull();
  });

  it('accepts 29 February, because the column stores a day and not a date', () => {
    expect(birthdayCode('02-29')).toBe(229);
  });

  it('accepts 31 of a 30-day month rather than validating a calendar it does not have', () => {
    // A hand-edited URL saying 04-31 is nobody's birthday, so it matches
    // nothing. Refusing it here would be a second calendar to keep correct.
    expect(birthdayCode('04-31')).toBe(431);
  });
});

describe('birthdayWindow', () => {
  it('is none when neither end is set', () => {
    expect(birthdayWindow(undefined, undefined)).toEqual({ kind: 'none' });
  });

  it('is open-ended when only one end is set', () => {
    expect(birthdayWindow('12-20', undefined)).toEqual({ kind: 'from', from: 1220 });
    expect(birthdayWindow(undefined, '01-05')).toEqual({ kind: 'to', to: 105 });
  });

  it('is a plain range when the days are in calendar order', () => {
    expect(birthdayWindow('03-01', '03-31')).toEqual({ kind: 'between', from: 301, to: 331 });
  });

  it('WRAPS when the end falls before the start — the end-of-year window', () => {
    expect(birthdayWindow('12-20', '01-05')).toEqual({ kind: 'wraps', from: 1220, to: 105 });
  });

  it('treats one day as a range of one, not as a wrap', () => {
    expect(birthdayWindow('07-04', '07-04')).toEqual({ kind: 'between', from: 704, to: 704 });
  });

  it('drops an unreadable end rather than filtering on a guess', () => {
    expect(birthdayWindow('13-01', '01-05')).toEqual({ kind: 'to', to: 105 });
    expect(birthdayWindow('12-20', 'nope')).toEqual({ kind: 'from', from: 1220 });
    expect(birthdayWindow('13-01', 'nope')).toEqual({ kind: 'none' });
  });
});
