import { describe, expect, it } from 'vitest';
import {
  isoWeekStart,
  layOutWeek,
  minutesOfClock,
  shiftWeek,
  weekDays,
  type GridShow,
} from '@/lib/shows/week-grid';

/**
 * Block 30e, item 12. The grid's arithmetic, checked without a browser, a
 * database or a clock — which is the whole reason the module is pure.
 *
 * 2026-08-17 is a Monday and 2026-08-23 the Sunday that closes its week.
 */
const MONDAY = '2026-08-17';

function show(over: Partial<GridShow> = {}): GridShow {
  return {
    id: 'show-1',
    name: 'Manhã Total',
    kind: 'MUSICAL',
    startsOn: null,
    endsOn: null,
    schedules: [],
    ...over,
  };
}

describe('the week the grid draws', () => {
  it('starts on Monday whichever day of the week it is handed', () => {
    expect(isoWeekStart('2026-08-17')).toBe('2026-08-17');
    expect(isoWeekStart('2026-08-19')).toBe('2026-08-17');
    // Sunday belongs to the week that started, not to the one about to.
    expect(isoWeekStart('2026-08-23')).toBe('2026-08-17');
    expect(isoWeekStart('2026-08-24')).toBe('2026-08-24');
  });

  it('walks whole weeks in both directions, across a month boundary', () => {
    expect(shiftWeek(MONDAY, 1)).toBe('2026-08-24');
    expect(shiftWeek(MONDAY, -1)).toBe('2026-08-10');
    expect(shiftWeek('2026-08-31', 1)).toBe('2026-09-07');
  });

  it('numbers its days the way the schema does', () => {
    const days = weekDays(MONDAY);

    expect(days).toHaveLength(7);
    expect(days[0]).toEqual({ date: '2026-08-17', weekday: 1 });
    expect(days[6]).toEqual({ date: '2026-08-23', weekday: 7 });
  });

  it('reads the end-of-day the schema writes as the end of the day', () => {
    expect(minutesOfClock('00:00:00')).toBe(0);
    expect(minutesOfClock('10:30:00')).toBe(630);
    expect(minutesOfClock('24:00:00')).toBe(1440);
  });
});

describe('laying a programme over the week', () => {
  const days = weekDays(MONDAY);

  it('positions a band at its own hours', () => {
    const blocks = layOutWeek(
      [show({ schedules: [{ band: 1, weekday: 1, starts_at: '10:00:00', ends_at: '12:30:00' }] })],
      days,
    );

    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.date).toBe('2026-08-17');
    expect(blocks[0]?.topPercent).toBeCloseTo((600 / 1440) * 100, 6);
    expect(blocks[0]?.heightPercent).toBeCloseTo((150 / 1440) * 100, 6);
    expect(blocks[0]?.bandLabel).toBe('10:00–12:30');
    expect(blocks[0]?.overnight).toBe(false);
  });

  it('draws two blocks on a day that carries two bands', () => {
    const blocks = layOutWeek(
      [
        show({
          schedules: [
            { band: 1, weekday: 2, starts_at: '10:00:00', ends_at: '12:30:00' },
            { band: 2, weekday: 2, starts_at: '13:20:00', ends_at: '15:20:00' },
          ],
        }),
      ],
      days,
    );

    expect(blocks.map((block) => [block.date, block.bandLabel])).toEqual([
      ['2026-08-18', '10:00–12:30'],
      ['2026-08-18', '13:20–15:20'],
    ]);
  });

  it('draws an overnight band as two blocks, both labelled with the hours typed', () => {
    const blocks = layOutWeek(
      [
        show({
          schedules: [
            { band: 1, weekday: 5, starts_at: '23:00:00', ends_at: '24:00:00' },
            { band: 1, weekday: 6, starts_at: '00:00:00', ends_at: '02:00:00' },
          ],
        }),
      ],
      days,
    );

    expect(blocks).toHaveLength(2);
    // Friday night, from 23:00 to the foot of the column.
    expect(blocks[0]?.date).toBe('2026-08-21');
    expect(blocks[0]?.topPercent).toBeCloseTo((1380 / 1440) * 100, 6);
    expect(blocks[0]?.heightPercent).toBeCloseTo((60 / 1440) * 100, 6);
    // Saturday morning, from the head of the column to 02:00.
    expect(blocks[1]?.date).toBe('2026-08-22');
    expect(blocks[1]?.topPercent).toBe(0);
    // The label is the band, never the segment: 00:00–02:00 would read as a
    // different programme from the one that started the night before.
    expect(blocks.map((block) => block.bandLabel)).toEqual(['23:00–02:00', '23:00–02:00']);
    expect(blocks.every((block) => block.overnight)).toBe(true);
  });

  it('draws nothing before the run starts', () => {
    const blocks = layOutWeek(
      [
        show({
          startsOn: '2026-08-20',
          schedules: [
            { band: 1, weekday: 1, starts_at: '08:00:00', ends_at: '09:00:00' },
            { band: 1, weekday: 4, starts_at: '08:00:00', ends_at: '09:00:00' },
          ],
        }),
      ],
      days,
    );

    // Monday the 17th is before the run; Thursday the 20th is its first day.
    expect(blocks.map((block) => block.date)).toEqual(['2026-08-20']);
  });

  it('draws nothing after the run ends, and still draws the week it ended in', () => {
    const blocks = layOutWeek(
      [
        show({
          endsOn: '2026-08-19',
          schedules: [
            { band: 1, weekday: 2, starts_at: '08:00:00', ends_at: '09:00:00' },
            { band: 1, weekday: 3, starts_at: '08:00:00', ends_at: '09:00:00' },
            { band: 1, weekday: 4, starts_at: '08:00:00', ends_at: '09:00:00' },
          ],
        }),
      ],
      days,
    );

    // Tuesday and Wednesday aired; Thursday is past the end.
    expect(blocks.map((block) => block.date)).toEqual(['2026-08-18', '2026-08-19']);
  });

  it('orders blocks by day and then by hour, so two renders paint the same picture', () => {
    const blocks = layOutWeek(
      [
        show({
          id: 'b',
          name: 'Tarde',
          schedules: [{ band: 1, weekday: 2, starts_at: '14:00:00', ends_at: '15:00:00' }],
        }),
        show({
          id: 'a',
          name: 'Manhã',
          schedules: [{ band: 1, weekday: 2, starts_at: '08:00:00', ends_at: '09:00:00' }],
        }),
      ],
      days,
    );

    expect(blocks.map((block) => block.showName)).toEqual(['Manhã', 'Tarde']);
  });

  it('draws nothing for a programme with no schedule at all', () => {
    expect(layOutWeek([show()], days)).toEqual([]);
  });
});
