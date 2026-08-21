import { bandsByMarker, isOvernight, type ScheduleRow } from './bands';

/**
 * Block 30e, item 18. Which bands of a Programme START on a given date.
 *
 * "Start" is the whole of it. `save_show` splits a band that crosses midnight
 * into a head and a tail on the next weekday, and the tail must NOT be offered
 * as a band of its own: an operator choosing Saturday is not choosing the
 * Friday-night programme's small hours, and offering it would hand back a window
 * beginning at 00:00 under a name they do not recognise. `toBands` already
 * resolves heads and tails into one band whose `days` are the days it STARTS on,
 * so this function is a filter over that answer rather than a second reading of
 * the same rows.
 *
 * Pure, and free of any timezone: which weekday a date falls on is a calendar
 * question. The two INSTANTS a band names are a Station question, and they live
 * beside the screen that asks it (participations/programme-window.ts).
 */
export interface ProgrammeBand {
  /** The `show_schedules.band` marker, which is what the URL carries. */
  marker: number;
  starts: string;
  ends: string;
  overnight: boolean;
  /** `10:00–12:30`, as the operator typed it. */
  label: string;
}

/** 1 = Monday … 7 = Sunday, from a `YYYY-MM-DD` read as a calendar date rather than an instant. */
function isoWeekday(day: string): number {
  const weekday = new Date(`${day}T00:00:00.000Z`).getUTCDay();
  return weekday === 0 ? 7 : weekday;
}

export function bandsOnDay(rows: ScheduleRow[], day: string): ProgrammeBand[] {
  const weekday = isoWeekday(day);

  return [...bandsByMarker(rows).entries()]
    .filter(([, band]) => band.days.includes(weekday))
    .map(([marker, band]) => ({
      marker,
      starts: band.starts,
      ends: band.ends,
      overnight: isOvernight(band),
      label: `${band.starts}\u2013${band.ends}`,
    }));
}
