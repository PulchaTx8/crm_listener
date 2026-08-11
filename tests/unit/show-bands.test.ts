import { describe, expect, it } from 'vitest';
import { isOvernight, toBands, type ScheduleRow } from '@/lib/shows/bands';

/**
 * Block 18. `save_show` does bands → rows; this does rows → bands, and the two
 * together are what lets an operator read back the schedule they typed.
 */
describe('toBands', () => {
  it('groups rows sharing a marker into one band, days ascending', () => {
    const rows: ScheduleRow[] = [
      { band: 1, weekday: 3, starts_at: '10:00:00', ends_at: '12:30:00' },
      { band: 1, weekday: 1, starts_at: '10:00:00', ends_at: '12:30:00' },
      { band: 1, weekday: 2, starts_at: '10:00:00', ends_at: '12:30:00' },
    ];

    expect(toBands(rows)).toEqual([{ days: [1, 2, 3], starts: '10:00', ends: '12:30' }]);
  });

  /**
   * The overnight case, read back. save_show wrote Saturday 23:00–24:00 and
   * Sunday 00:00–02:00 under one marker; the screen must show 23:00–02:00 on
   * Saturday, which is what the operator typed.
   */
  it('rejoins an overnight band into the hours the operator entered', () => {
    const rows: ScheduleRow[] = [
      { band: 1, weekday: 6, starts_at: '23:00:00', ends_at: '24:00:00' },
      { band: 1, weekday: 7, starts_at: '00:00:00', ends_at: '02:00:00' },
    ];

    expect(toBands(rows)).toEqual([{ days: [6], starts: '23:00', ends: '02:00' }]);
  });

  it('rejoins an overnight band that wraps from Sunday round to Monday', () => {
    const rows: ScheduleRow[] = [
      { band: 1, weekday: 7, starts_at: '23:00:00', ends_at: '24:00:00' },
      { band: 1, weekday: 1, starts_at: '00:00:00', ends_at: '02:00:00' },
    ];

    expect(toBands(rows)).toEqual([{ days: [7], starts: '23:00', ends: '02:00' }]);
  });

  it('rejoins a five-night overnight band into the five nights it started on', () => {
    const rows: ScheduleRow[] = [];
    for (const day of [1, 2, 3, 4, 5]) {
      rows.push({ band: 1, weekday: day, starts_at: '23:00:00', ends_at: '24:00:00' });
      rows.push({ band: 1, weekday: day + 1, starts_at: '00:00:00', ends_at: '02:00:00' });
    }

    expect(toBands(rows)).toEqual([{ days: [1, 2, 3, 4, 5], starts: '23:00', ends: '02:00' }]);
  });

  /**
   * THE MARKER IS WHY THIS FILE CAN BE WRITTEN AT ALL. Without it these two are
   * indistinguishable from one band on Monday and Friday, and the screen would
   * quietly merge two things the operator entered separately.
   */
  it('keeps two bands apart even when their hours are identical', () => {
    const rows: ScheduleRow[] = [
      { band: 1, weekday: 1, starts_at: '10:00:00', ends_at: '12:00:00' },
      { band: 2, weekday: 5, starts_at: '10:00:00', ends_at: '12:00:00' },
    ];

    expect(toBands(rows)).toHaveLength(2);
  });

  it('orders bands by their marker, so the screen lists them as they were added', () => {
    const rows: ScheduleRow[] = [
      { band: 2, weekday: 6, starts_at: '13:20:00', ends_at: '15:20:00' },
      { band: 1, weekday: 1, starts_at: '10:00:00', ends_at: '12:30:00' },
    ];

    expect(toBands(rows).map((b) => b.starts)).toEqual(['10:00', '13:20']);
  });

  it('answers with nothing for a programme that has no schedule yet', () => {
    expect(toBands([])).toEqual([]);
  });
});

describe('isOvernight', () => {
  it('knows an overnight band from an ordinary one', () => {
    expect(isOvernight({ days: [6], starts: '23:00', ends: '02:00' })).toBe(true);
    expect(isOvernight({ days: [1], starts: '10:00', ends: '12:30' })).toBe(false);
  });

  /** Equal hours are not a night that lasts a week; they are a mistake. */
  it('does not call a zero-length band overnight', () => {
    expect(isOvernight({ days: [1], starts: '10:00', ends: '10:00' })).toBe(false);
  });
});
