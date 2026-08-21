import { describe, expect, it } from 'vitest';
import { bandsOnDay } from '@/lib/shows/programme-bands';
import { windowFor } from '@/app/(app)/participations/programme-window';
import type { ScheduleRow } from '@/lib/shows/bands';

/**
 * Block 30e, item 18. Which band of a Programme an operator may choose on a
 * date, and the two instants that band names in the STATION's zone.
 *
 * 2026-08-21 is a Friday, 2026-08-22 a Saturday and 2026-08-23 a Sunday.
 * America/Sao_Paulo has run at UTC−03:00 with no daylight saving since 2019, so
 * every instant below is the wall-clock plus three hours.
 */
const SAO_PAULO = 'America/Sao_Paulo';

/** Monday–Friday 10:00–12:30, and a Friday night that runs to 02:00 on Saturday. */
const ROWS: ScheduleRow[] = [
  { band: 1, weekday: 1, starts_at: '10:00:00', ends_at: '12:30:00' },
  { band: 1, weekday: 2, starts_at: '10:00:00', ends_at: '12:30:00' },
  { band: 1, weekday: 3, starts_at: '10:00:00', ends_at: '12:30:00' },
  { band: 1, weekday: 4, starts_at: '10:00:00', ends_at: '12:30:00' },
  { band: 1, weekday: 5, starts_at: '10:00:00', ends_at: '12:30:00' },
  { band: 2, weekday: 5, starts_at: '23:00:00', ends_at: '24:00:00' },
  { band: 2, weekday: 6, starts_at: '00:00:00', ends_at: '02:00:00' },
];

describe('the bands a Programme airs on a day', () => {
  it('offers the bands that START that day', () => {
    expect(bandsOnDay(ROWS, '2026-08-21').map((band) => band.label)).toEqual([
      '10:00–12:30',
      '23:00–02:00',
    ]);
  });

  it('offers nothing on a day the Programme does not air', () => {
    // Saturday carries the TAIL of Friday night's band, which is not a band an
    // operator may choose: choosing Saturday is not choosing the Friday-night
    // programme, and offering it would hand back a window starting at 00:00
    // under a name nobody recognises.
    expect(bandsOnDay(ROWS, '2026-08-22')).toEqual([]);
    expect(bandsOnDay(ROWS, '2026-08-23')).toEqual([]);
  });

  it('marks the band that runs past midnight, and keeps its marker', () => {
    const [, overnight] = bandsOnDay(ROWS, '2026-08-21');

    expect(overnight?.overnight).toBe(true);
    // The marker is what the URL carries, so it has to be the row's own.
    expect(overnight?.marker).toBe(2);
  });

  it('answers with nothing for a Programme with no schedule at all', () => {
    expect(bandsOnDay([], '2026-08-21')).toEqual([]);
  });
});

describe('the window a band names on a date', () => {
  it('is half-open, ending one millisecond before the band does', () => {
    const [morning] = bandsOnDay(ROWS, '2026-08-21');
    const window = windowFor(morning!, '2026-08-21', SAO_PAULO);

    expect(window?.from).toBe('2026-08-21T13:00:00.000Z');
    // 12:30 is 15:30Z; the last instant INSIDE the band is one millisecond
    // before, because list_participations compares `participated_at <= p_to`.
    // Two consecutive bands must never both claim the same minute.
    expect(window?.to).toBe('2026-08-21T15:29:59.999Z');
  });

  it('ends on the following day when the band runs past midnight', () => {
    const [, overnight] = bandsOnDay(ROWS, '2026-08-21');
    const window = windowFor(overnight!, '2026-08-21', SAO_PAULO);

    expect(window?.from).toBe('2026-08-22T02:00:00.000Z');
    expect(window?.to).toBe('2026-08-22T04:59:59.999Z');
  });

  it('reads the zone it is given rather than the machine it runs on', () => {
    const [morning] = bandsOnDay(ROWS, '2026-08-21');

    expect(windowFor(morning!, '2026-08-21', 'UTC')?.from).toBe('2026-08-21T10:00:00.000Z');
    expect(windowFor(morning!, '2026-08-21', 'Europe/Lisbon')?.from).toBe(
      '2026-08-21T09:00:00.000Z',
    );
  });
});
