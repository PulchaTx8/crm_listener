import { fromZonedWallClock } from '../promotions/zone';
import type { ProgrammeBand } from '@/lib/shows/programme-bands';

/**
 * Block 30e, D8. The two instants a band names on a date, in the STATION's zone.
 *
 * HALF-OPEN, which is the rule `shows_on_air` (0175) states so that two
 * consecutive bands never both claim the same minute. `list_participations`
 * (0090) compares `participated_at <= p_to`, so the last instant inside a band is
 * one millisecond before its end — the same move `fromZonedDay(day, tz, true)`
 * already makes with `23:59:59.999`, made HERE rather than by changing a
 * predicate that the list, the draw hat (`collectDrawHat` calls the same RPC) and
 * the send-list filters all read through.
 *
 * It lives beside the screen rather than in `@/lib` because it is the one part of
 * this block that needs a Station's zone, and the zone module it needs is the one
 * the filter bar beside it already uses. A second conversion would be a second
 * way for two controls on one screen to disagree about which day something
 * happened — the reason that module exists at all.
 */
const ONE_MILLISECOND = 1;
const MS_IN_DAY = 86_400_000;

/** The next calendar day. UTC arithmetic on a date string, which has no zone of its own. */
function nextDay(day: string): string {
  return new Date(new Date(`${day}T00:00:00.000Z`).getTime() + MS_IN_DAY).toISOString().slice(0, 10);
}

export function windowFor(
  band: ProgrammeBand,
  day: string,
  timeZone: string,
): { from: string; to: string } | null {
  const from = fromZonedWallClock(`${day}T${band.starts}`, timeZone);
  // An overnight band ends on the day AFTER the one it started on, which is the
  // hour the operator typed and the day save_show wrote its tail on.
  const end = fromZonedWallClock(`${band.overnight ? nextDay(day) : day}T${band.ends}`, timeZone);
  if (!from || !end) return null;

  return { from, to: new Date(Date.parse(end) - ONE_MILLISECOND).toISOString() };
}
