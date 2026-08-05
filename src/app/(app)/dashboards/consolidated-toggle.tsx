'use client';

import Link from 'next/link';
import type { Route } from 'next';
import { periodHref, withStationSearch } from './period';
import type { PeriodSelection } from './period';

const ACTIVE_PILL = 'rounded-full bg-primary px-3 py-1 text-xs font-medium text-primary-foreground';
const INACTIVE_PILL = 'rounded-full px-3 py-1 text-xs font-medium text-muted-foreground hover:bg-accent';

/**
 * Whether more than one Station can be looked at together is a courtesy this
 * control offers, never the boundary D3 draws: `get_audience_dashboard` and
 * its two siblings re-check `reports.consolidated` for every id named
 * regardless of what this ever rendered. `eligible` is computed by the page,
 * not this component, because that needs a second `listCompanyAccess` call
 * (for `reports.consolidated` rather than the panel's own domain permission)
 * that a client component has no business making itself — the same division
 * of labour `getInventoryPermissions` already draws between a courtesy check
 * and the write RPC that re-asks the real question.
 *
 * Two links, not a checkbox: "this Station" and "all Stations" are the only
 * two selections this control makes, both plain `<Link>`s built by the same
 * `periodHref` every other control in this block uses, so a chosen view is a
 * URL somebody can send exactly like a chosen period.
 */
export function ConsolidatedToggle({
  eligible,
  base,
  period,
  stationSearch,
  active,
  singleCompanyId,
  consolidatedCompanyIds,
}: {
  eligible: boolean;
  base: string;
  period: PeriodSelection;
  stationSearch?: string;
  active: boolean;
  singleCompanyId: string;
  consolidatedCompanyIds: string[];
}) {
  if (!eligible) return null;

  const singleHref = withStationSearch(periodHref(base, period, [singleCompanyId]), stationSearch);
  const consolidatedHref = withStationSearch(
    periodHref(base, period, consolidatedCompanyIds),
    stationSearch,
  );

  return (
    <div
      className="inline-flex items-center gap-1 rounded-full border p-1"
      data-testid="consolidated-toggle"
    >
      <Link
        href={singleHref as Route}
        aria-current={!active ? 'page' : undefined}
        className={!active ? ACTIVE_PILL : INACTIVE_PILL}
      >
        This station
      </Link>
      <Link
        href={consolidatedHref as Route}
        aria-current={active ? 'page' : undefined}
        className={active ? ACTIVE_PILL : INACTIVE_PILL}
      >
        All stations ({consolidatedCompanyIds.length})
      </Link>
    </div>
  );
}
