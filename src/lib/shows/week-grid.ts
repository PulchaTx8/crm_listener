import { bandsByMarker, isOvernight, type ScheduleRow } from './bands';

/**
 * Block 30e, item 12. Where each band sits on a week, computed with no browser,
 * no database and no clock.
 *
 * ALL DATE ARITHMETIC IS ON `YYYY-MM-DD` STRINGS, THROUGH UTC. A local
 * `new Date('2026-08-17')` is parsed as UTC midnight and then read back in the
 * machine's own zone, which anywhere west of Greenwich answers the 16th — a week
 * that starts on Sunday for half the world. Which DAY is today is a question
 * about the Station's zone and is answered by the screen, beside
 * `companies.timezone`; this module only walks a calendar, and a calendar has no
 * zone of its own.
 */

/** One column of the grid: a real date, and the ISO weekday `show_schedules` stores. */
export interface WeekDay {
  date: string;
  /** 1 = Monday … 7 = Sunday, matching `extract(isodow from …)`. */
  weekday: number;
}

/** One programme, with the schedule rows and the run bounds that decide where it is drawn. */
export interface GridShow {
  id: string;
  name: string;
  kind: string | null;
  startsOn: string | null;
  endsOn: string | null;
  schedules: ScheduleRow[];
}

/** One drawn rectangle: one `show_schedules` row on one date. */
export interface GridBlock {
  key: string;
  showId: string;
  showName: string;
  kind: string | null;
  date: string;
  /** Percentages of the day, so a column can be any height the layout wants. */
  topPercent: number;
  heightPercent: number;
  /**
   * The whole band as the operator typed it — `23:00–02:00` on BOTH halves of an
   * overnight band. The segment's own hours are this schema's bookkeeping, and
   * `src/lib/shows/bands.ts` says they must never reach a screen.
   */
  bandLabel: string;
  overnight: boolean;
}

const MINUTES_IN_DAY = 1440;
const MS_IN_DAY = 86_400_000;

function asUtc(date: string): Date {
  return new Date(`${date}T00:00:00.000Z`);
}

function asDate(at: Date): string {
  return at.toISOString().slice(0, 10);
}

/** 1 = Monday … 7 = Sunday. `getUTCDay` counts Sunday as 0, which is the other convention. */
function isoWeekday(date: string): number {
  const day = asUtc(date).getUTCDay();
  return day === 0 ? 7 : day;
}

export function isoWeekStart(date: string): string {
  return asDate(new Date(asUtc(date).getTime() - (isoWeekday(date) - 1) * MS_IN_DAY));
}

export function shiftWeek(monday: string, weeks: number): string {
  return asDate(new Date(asUtc(monday).getTime() + weeks * 7 * MS_IN_DAY));
}

export function weekDays(monday: string): WeekDay[] {
  return Array.from({ length: 7 }, (_, index) => {
    const date = asDate(new Date(asUtc(monday).getTime() + index * MS_IN_DAY));
    return { date, weekday: isoWeekday(date) };
  });
}

/** Postgres writes the end of a day as `24:00:00`, which is 1440 minutes and not zero. */
export function minutesOfClock(time: string): number {
  const [hours = '0', minutes = '0'] = time.split(':');
  return Number(hours) * 60 + Number(minutes);
}

/**
 * Whether a programme is on the air on a given DATE — the same rule
 * `shows_on_air` (0175) applies, deliberately: run bounds inclusive at both ends,
 * and the schedule consulted per weekday. It means the small hours of the morning
 * after a run's last day are not drawn, which is exactly what that function
 * answers too; one rule two readers share beats two that nearly agree.
 */
function running(show: GridShow, date: string): boolean {
  if (show.startsOn && show.startsOn > date) return false;
  if (show.endsOn && show.endsOn < date) return false;
  return true;
}

export function layOutWeek(shows: GridShow[], days: WeekDay[]): GridBlock[] {
  const blocks: GridBlock[] = [];

  for (const show of shows) {
    const bands = bandsByMarker(show.schedules);

    for (const day of days) {
      if (!running(show, day.date)) continue;

      for (const row of show.schedules) {
        if (row.weekday !== day.weekday) continue;

        // Not every marker reconstructs to a band: `bandsByMarker` skips one whose
        // rows are ALL tails (a 00:00 row with no head before it), which is a
        // schedule `save_show` does not write and a hand-edited table could. The
        // fallback below draws such a row with its own hours rather than dropping
        // it silently off the week — a missing programme reads as a schedule, and
        // a mislabelled one reads as a mistake.
        const band = bands.get(row.band);

        const start = minutesOfClock(row.starts_at);
        const end = minutesOfClock(row.ends_at);
        if (end <= start) continue;

        blocks.push({
          key: `${show.id}:${day.date}:${row.band}:${row.starts_at}`,
          showId: show.id,
          showName: show.name,
          kind: show.kind,
          date: day.date,
          topPercent: (start / MINUTES_IN_DAY) * 100,
          heightPercent: ((end - start) / MINUTES_IN_DAY) * 100,
          bandLabel: band
            ? `${band.starts}–${band.ends}`
            : `${row.starts_at.slice(0, 5)}–${row.ends_at.slice(0, 5)}`,
          overnight: band ? isOvernight(band) : false,
        });
      }
    }
  }

  // Deterministic, so two loads of one week paint the same picture: by day, then
  // by hour, then by name for two programmes starting on the same minute.
  return blocks.sort(
    (a, b) =>
      a.date.localeCompare(b.date) ||
      a.topPercent - b.topPercent ||
      a.showName.localeCompare(b.showName),
  );
}
