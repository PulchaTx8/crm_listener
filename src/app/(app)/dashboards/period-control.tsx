'use client';

import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { Route } from 'next';
import type { Period } from '@/schemas/dashboards';
import { exclusiveEnd, inclusiveEnd, periodHref, withStationSearch } from './period';
import type { PeriodPreset, PeriodSelection } from './period';

const PRESETS: readonly { preset: PeriodPreset; label: string }[] = [
  { preset: 'current_month', label: 'Current month' },
  { preset: 'previous_month', label: 'Previous month' },
  { preset: 'current_year', label: 'Current year' },
  { preset: 'custom', label: 'Custom range' },
];

const ACTIVE_PILL = 'rounded-full bg-primary px-3 py-1 text-xs font-medium text-primary-foreground';
const INACTIVE_PILL =
  'rounded-full border px-3 py-1 text-xs font-medium text-muted-foreground hover:bg-accent';

/**
 * The period control every dashboard page renders above its cards: the four
 * presets D5 names plus a custom range, each a plain `<Link>` built by
 * `periodHref` — a period is a URL somebody can send, not client-side state
 * that resets on refresh. `companyIds` and `stationSearch` travel with every
 * link for the reason `period.ts`'s own `withStationSearch` documents: this
 * is a control that changes the URL, and one that drops either would
 * reproduce the exact silent-wrong-Station defect `station-switch.ts` was
 * written to cure.
 *
 * The two date inputs are the one part that cannot be a static `<Link>` —
 * their value depends on what the visitor types — so they push their own URL
 * via the router, on the same `periodHref` the four presets use. Seeded from
 * `resolved` (the payload's OWN `period`, i.e. what SQL actually resolved),
 * not from `selection` (the URL's parsed intent, `null` for every non-custom
 * preset): switching from "current month" into "custom" starts the range at
 * that month's real bounds rather than a blank pair of inputs.
 *
 * THE `To` INPUT IS INCLUSIVE, and the conversion happens here (whole-branch
 * review, Important B4). Everything underneath — the URL, `parsePeriod`,
 * `resolve_dashboard_period`, every figure — is half-open with an EXCLUSIVE
 * `to`, which is right and matches 0040 and `situationOf()`. But a date picker
 * does not mean that to a person: an operator asking for August fills in
 * 2026-08-01 and 2026-08-31, and under a raw exclusive bound silently loses
 * the 31st from every number on the page. Worse, seeding straight from
 * `resolved.to` pre-filled 2026-09-01 when switching into Custom — correct,
 * unreadable as correct, and an open invitation to "fix" it to the 31st and
 * lose a day for real.
 *
 * So the input shows `inclusiveEnd(resolved.to)` and submits
 * `exclusiveEnd(typed)`, and `period.ts` owns both halves so the two can never
 * drift apart. The round trip is stable by construction: 2026-09-01 seeds
 * 2026-08-31, submitting sends 2026-09-01, and the next render seeds
 * 2026-08-31 again — no day is gained or lost by looking at the screen twice.
 */
export function PeriodControl({
  base,
  selection,
  resolved,
  companyIds,
  stationSearch,
}: {
  base: string;
  selection: PeriodSelection;
  resolved: Period;
  companyIds: string[];
  stationSearch?: string;
}) {
  const t = useTranslations('dashboards');
  const router = useRouter();
  const [from, setFrom] = useState(resolved.from);
  // `to` holds the INCLUSIVE last day the operator sees, never the exclusive
  // bound the URL carries. Every read of it converts on the way out.
  const [to, setTo] = useState(inclusiveEnd(resolved.to));

  // Re-synced from the payload rather than trusted from whatever the browser
  // last painted: a DIFFERENT control (a Station switch, the consolidated
  // toggle) can navigate while custom is already active, and this is what
  // keeps the two date inputs agreeing with the range that actually rendered
  // — the same reason members-filters.tsx resyncs its own date inputs from a
  // server-supplied prop instead of only from local state.
  useEffect(() => setFrom(resolved.from), [resolved.from]);
  useEffect(() => setTo(inclusiveEnd(resolved.to)), [resolved.to]);

  function hrefFor(next: PeriodSelection): string {
    return withStationSearch(periodHref(base, next, companyIds), stationSearch);
  }

  /** The one place the operator's inclusive last day becomes the URL's exclusive bound. */
  function customFor(nextFrom: string, nextInclusiveTo: string): PeriodSelection {
    return { preset: 'custom', from: nextFrom, to: exclusiveEnd(nextInclusiveTo) };
  }

  return (
    <div className="mb-6 flex flex-wrap items-center gap-2" data-testid="period-control">
      {PRESETS.map(({ preset, label }) => {
        const isActive = selection.preset === preset;
        const target: PeriodSelection =
          preset === 'custom' ? customFor(from, to) : { preset, from: null, to: null };
        return (
          <Link
            key={preset}
            href={hrefFor(target) as Route}
            aria-current={isActive ? 'page' : undefined}
            className={isActive ? ACTIVE_PILL : INACTIVE_PILL}
          >
            {label}
          </Link>
        );
      })}

      {selection.preset === 'custom' && (
        <div className="flex items-end gap-2">
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            <span>{t('from')}</span>
            <input
              type="date"
              value={from}
              onChange={(e) => {
                const next = e.target.value;
                setFrom(next);
                if (next && to) {
                  router.replace(hrefFor(customFor(next, to)) as Route);
                }
              }}
              className="h-9 rounded-md border border-input bg-background px-2 text-sm text-foreground"
              data-testid="period-from"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            {/* "To" means the last day INCLUDED, which is what a date picker
                means to the person filling it in. The exclusive bound the URL
                and the RPC use is one day later, and customFor is where the
                two meet. */}
            <span title={t('theLastDayIncludedInThe')}>To</span>
            <input
              type="date"
              value={to}
              onChange={(e) => {
                const next = e.target.value;
                setTo(next);
                if (from && next) {
                  router.replace(hrefFor(customFor(from, next)) as Route);
                }
              }}
              className="h-9 rounded-md border border-input bg-background px-2 text-sm text-foreground"
              data-testid="period-to"
            />
          </label>
        </div>
      )}
    </div>
  );
}
