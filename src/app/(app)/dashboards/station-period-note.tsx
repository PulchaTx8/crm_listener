import { getTranslations } from 'next-intl/server';
import type { Station } from '@/schemas/dashboards';
import { inclusiveEnd } from './period';

/**
 * The one sentence above the cards that says what the period actually was —
 * and, before the whole-branch review (Important A1), the one sentence on this
 * block that was not always true.
 *
 * All three pages used to print, unconditionally whenever two Stations did not
 * share a timezone: *"The period's dates are the same for all of them; the
 * instants they begin and end are not."* That is exactly right for a custom
 * range, where `p_from`/`p_to` travel as literal dates and every Station
 * converts the same pair at its own clock. It is FALSE for a preset. D5, as
 * the owner amended it on 2026-08-05, keeps presets resolving from `now()` at
 * each Station's own clock — deliberately, because a Station is not well
 * measured by a calendar it does not live in — and on the turn of a month a
 * Station at UTC+14 and one at UTC−3 therefore resolve **different calendar
 * months**. The screen was asserting a uniformity the query does not provide,
 * on the one day of the month it mattered.
 *
 * So the note now fires on the real condition, in this order:
 *
 * 1. The Stations resolved DIFFERENT windows — say so, and name which Station
 *    measured which. This is the case that used to be denied outright.
 * 2. They share a window but not a timezone — the original sentence, which is
 *    correct here and kept verbatim, `mixed-timezone-note` testid included.
 * 3. Neither — nothing to say, and nothing is rendered.
 *
 * Dates are shown with an INCLUSIVE last day (`inclusiveEnd`), the same
 * conversion `period-control.tsx` applies to its own `To` input: a payload's
 * `to` is exclusive, and "1 August to 1 September" printed under a heading
 * about August is its own small lie.
 */
export async function StationPeriodNote({ stations }: { stations: Station[] }) {
  const t = await getTranslations('dashboards');
  const windows = new Map<string, { from: string; to: string; names: string[] }>();
  for (const station of stations) {
    const key = `${station.from}|${station.to}`;
    const group = windows.get(key);
    if (group) group.names.push(station.name);
    else windows.set(key, { from: station.from, to: station.to, names: [station.name] });
  }

  if (windows.size > 1) {
    return (
      <p className="mb-4 text-xs text-muted-foreground" data-testid="mixed-period-note">
        {t('theseStationsDidNotMeasureThe')}{' '}
        {Array.from(windows.values())
          .map((group) => `${group.names.join(', ')} — ${group.from} to ${inclusiveEnd(group.to)}`)
          .join('; ')}
        . Every figure below is the sum of those windows, each measured where it happened.
      </p>
    );
  }

  const timezones = new Set(stations.map((station) => station.timezone));
  if (timezones.size > 1) {
    return (
      <p className="mb-4 text-xs text-muted-foreground" data-testid="mixed-timezone-note">
        {t('theseStationsDoNotShareA')}</p>
    );
  }

  return null;
}
