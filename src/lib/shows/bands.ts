/**
 * Block 18. The band a schedule was typed as, read back out of its rows.
 *
 * `save_show` (0175) does bands → rows: it expands the days and splits a band
 * that crosses midnight into two, so that every row satisfies
 * `ends_at > starts_at` and every future filter can compare a column against a
 * weekday without remembering that 23:00–02:00 ends before it starts.
 *
 * This is the other direction, and it exists so the operator reads back the
 * schedule they wrote rather than the shape the database found convenient.
 * Pure, so it can be tested without a browser or a database.
 */

/** One band, exactly as the schedule editor holds it. */
export interface Band {
  /** ISO weekdays the band STARTS on: 1 = Monday … 7 = Sunday. */
  days: number[];
  /** `HH:MM`. */
  starts: string;
  /** `HH:MM`. May be earlier than `starts`, which is the overnight case. */
  ends: string;
}

/** One row of `show_schedules`, as PostgREST returns it. */
export interface ScheduleRow {
  band: number;
  weekday: number;
  /** Postgres `time`, which arrives as `HH:MM:SS`. */
  starts_at: string;
  ends_at: string;
}

/** Postgres gives `HH:MM:SS`; the form holds `HH:MM`. */
function toClock(value: string): string {
  return value.slice(0, 5);
}

/** 7 → 1, so a Sunday night runs into Monday morning. */
function nextWeekday(weekday: number): number {
  return weekday === 7 ? 1 : weekday + 1;
}

/**
 * The bands of a schedule, keyed by the marker their rows carry.
 *
 * The reconstruction lives HERE rather than inside `toBands` because two callers
 * need two shapes of the same answer: the record dialog wants the bands in
 * order, and Block 30e's week grid wants the band a given ROW belongs to, so it
 * can label an overnight tail with the hours the operator typed instead of with
 * the 00:00 this schema splits at. A second reconstruction beside the first
 * would be a second thing to keep in step with `save_show`.
 */
export function bandsByMarker(rows: ScheduleRow[]): Map<number, Band> {
  const byMarker = new Map<number, ScheduleRow[]>();
  for (const row of rows) {
    const group = byMarker.get(row.band);
    if (group) group.push(row);
    else byMarker.set(row.band, [row]);
  }

  const bands = new Map<number, Band>();

  // Ordered by marker, so the screen lists bands in the order they were added.
  // A Map keeps insertion order, which is what makes `toBands` below a
  // projection of this one rather than a second sort.
  for (const marker of [...byMarker.keys()].sort((a, b) => a - b)) {
    const group = byMarker.get(marker) ?? [];

    /**
     * THE TAILS OF AN OVERNIGHT BAND, identified rather than assumed: a row
     * starting at midnight whose SAME marker also holds a row on the previous
     * weekday ending at 24:00. Both halves are needed to call it one — a
     * programme that genuinely runs 00:00–02:00 on Sunday and nothing on
     * Saturday is not an overnight band, and must not be shown as one.
     */
    const heads = group.filter((row) => row.ends_at.startsWith('24:00'));
    const tails = new Set(
      group
        .filter(
          (row) =>
            row.starts_at.startsWith('00:00') &&
            heads.some((head) => nextWeekday(head.weekday) === row.weekday),
        )
        .map((row) => row.weekday),
    );

    const starting = group.filter((row) => !tails.has(row.weekday) || !row.starts_at.startsWith('00:00'));
    if (starting.length === 0) continue;

    const first = starting[0];
    if (first === undefined) continue;

    // The end an overnight band is shown with is its TAIL's end, which is the
    // hour the operator typed; the head's 24:00 is this schema's own bookkeeping
    // and must never reach a screen.
    const overnightTail = group.find(
      (row) => row.starts_at.startsWith('00:00') && tails.has(row.weekday),
    );

    bands.set(marker, {
      days: starting.map((row) => row.weekday).sort((a, b) => a - b),
      starts: toClock(first.starts_at),
      ends: toClock(overnightTail ? overnightTail.ends_at : first.ends_at),
    });
  }

  return bands;
}

/** The same bands as a list, in marker order — the shape the schedule editor holds. */
export function toBands(rows: ScheduleRow[]): Band[] {
  return [...bandsByMarker(rows).values()];
}

/**
 * Whether a band runs past midnight — the case `save_show` splits on write.
 *
 * Equal hours are NOT overnight: a band from 10:00 to 10:00 is a mistake, and
 * calling it a night that lasts a week would hide the mistake behind a feature.
 */
export function isOvernight(band: Band): boolean {
  return band.ends < band.starts;
}
