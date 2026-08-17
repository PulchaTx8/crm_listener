'use client';

import { useTranslations } from 'next-intl';
import Link from 'next/link';
import type { Route } from 'next';
import { periodHref, withStationSearch } from './period';
import type { PeriodSelection } from './period';
import type { ViewableCompany } from '../inventory/station-access';

const ACTIVE_PILL = 'rounded-full bg-primary px-3 py-1 text-xs font-medium text-primary-foreground';
const INACTIVE_PILL =
  'rounded-full border px-3 py-1 text-xs font-medium text-muted-foreground hover:bg-accent';

/**
 * Block 28. Any set of Stations, replacing Block 8a's two-position
 * ConsolidatedToggle — which offered "this Station" and "all Stations" and
 * nothing between them, while the array behind it has travelled from the URL to
 * the RPC since 0118. Nothing below the URL changed to allow this; the control
 * was the only thing that could not say "these three".
 *
 * TWO THINGS ARE CARRIED FORWARD VERBATIM FROM THAT COMPONENT, because both are
 * load-bearing and neither is obvious:
 *
 * Whether more than one Station can be looked at together is a courtesy this
 * control offers, never the boundary D3 draws: `get_audience_dashboard` and its
 * two siblings re-check `reports.consolidated` for every id named regardless of
 * what this ever rendered. The eligible list is computed by the page, not this
 * component, because that needs a second `listCompanyAccess` call (for
 * `reports.consolidated` rather than the panel's own domain permission) that a
 * client component has no business making itself — the same division of labour
 * `getInventoryPermissions` already draws between a courtesy check and the write
 * RPC that re-asks the real question.
 *
 * And the pills are `<Link>`s, not checkboxes, built by the same `periodHref`
 * every other control in this block uses, so a chosen view is a URL somebody can
 * send exactly like a chosen period.
 */
export function StationSelection({
  eligible,
  base,
  period,
  stationSearch,
  singleCompanyId,
  viewable,
  consolidatedCompanyIds,
  selectedIds,
  complete,
}: {
  eligible: boolean;
  base: string;
  period: PeriodSelection;
  stationSearch?: string;
  /**
   * Where unselecting the LAST pill goes. See the `next` computation below: an
   * empty selection is not a selection, and this is what it falls back to.
   */
  singleCompanyId: string;
  /** Every Station this caller can view, for the names. */
  viewable: ViewableCompany[];
  /** Of those, the ones `reports.consolidated` reaches — the ones that get a pill. */
  consolidatedCompanyIds: string[];
  /** The selection the page actually resolved and read the panel with. */
  selectedIds: string[];
  /**
   * Whether `consolidatedCompanyIds` really is every Station the caller can
   * consolidate, or only the ones that survived a cap and a search box
   * (whole-branch review, Important B7).
   *
   * The page builds that array by intersecting two `listCompanyAccess` calls,
   * and BOTH are capped at fifty and BOTH are narrowed by the active Station
   * search term. So "All stations" could mean the alphabetically-first fifty,
   * or every Station whose name happens to contain "fm" — and the label said
   * "All stations" regardless, which is a claim about the caller's whole
   * relationship to the platform made from a filtered list. When this is false
   * the label names what it actually has, and the page shows the accompanying
   * caveat.
   */
  complete: boolean;
}) {
  const t = useTranslations('dashboards');
  if (!eligible) return null;

  const eligibleSet = new Set(consolidatedCompanyIds);
  // Ordered by `viewable` rather than by `consolidatedCompanyIds`, so these
  // pills sit in the same order as the single-Station pills the page renders
  // beside them. Two rows of the same names in two different orders is the
  // reading cost that makes an operator check whether they are the same list.
  const stations = viewable.filter((company) => eligibleSet.has(company.id));

  // One Station is not a selection either, and this is the second of the two
  // reasons this control can render nothing: `eligible` above is the page's
  // answer, this is the list's own.
  if (stations.length < 2) return null;

  const selected = new Set(selectedIds.filter((id) => eligibleSet.has(id)));
  const allSelected = stations.every((company) => selected.has(company.id));

  const hrefFor = (ids: string[]) =>
    withStationSearch(periodHref(base, period, ids), stationSearch) as Route;

  return (
    <div className="flex flex-col gap-1" data-testid="station-selection">
      <span className="text-xs text-muted-foreground">{t('selectStations')}</span>
      <div className="flex flex-wrap items-center gap-1 rounded-full border p-1">
        {stations.map((company) => {
          const isOn = selected.has(company.id);
          const next = isOn
            ? selectedIds.filter((id) => id !== company.id)
            : [...selectedIds, company.id];

          return (
            <Link
              key={company.id}
              // A SELECTION OF ZERO IS NOT A SELECTION. Unselecting the last
              // pill links to the caller's own single Station rather than to an
              // empty array: 0118 raises 22023 for an empty set, and a control
              // that can produce a broken URL is a control that will. The
              // fallback is `singleCompanyId` and not `company.id` — turning a
              // pill off must never read as turning it on.
              href={hrefFor(next.length > 0 ? next : [singleCompanyId])}
              aria-pressed={isOn}
              className={isOn ? ACTIVE_PILL : INACTIVE_PILL}
            >
              {company.name}
            </Link>
          );
        })}
        <Link
          href={hrefFor(stations.map((company) => company.id))}
          aria-current={allSelected ? 'page' : undefined}
          className={allSelected ? ACTIVE_PILL : INACTIVE_PILL}
          title={complete ? undefined : t('onlyTheStationsListedAbove')}
        >
          {complete ? t('allStations', { count: stations.length }) : t('stationsListed', { count: stations.length })}
        </Link>
      </div>
      <span className="text-xs text-muted-foreground" data-testid="stations-selected">
        {t('stationsSelected', { count: selectedIds.length })}
      </span>
    </div>
  );
}
