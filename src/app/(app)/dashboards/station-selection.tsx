'use client';

import { useTranslations } from 'next-intl';
import Link from 'next/link';
import type { Route } from 'next';
import { periodHref, withStationSearch } from './period';
import type { PeriodSelection } from './period';
import { canSelectAll, stationPills } from './station-pills';
import type { SuspendedCompany, ViewableCompany } from '../inventory/station-access';

const ACTIVE_PILL = 'rounded-full bg-primary px-3 py-1 text-xs font-medium text-primary-foreground';
const INACTIVE_PILL =
  'rounded-full border px-3 py-1 text-xs font-medium text-muted-foreground hover:bg-accent';
/**
 * A pill that REPLACES the selection sitting next to pills that add to it. Only
 * ever used when the row holds both kinds — see the `mixed` computation below.
 */
const REPLACE_PILL =
  'rounded-full border border-dotted px-3 py-1 text-xs font-medium text-muted-foreground hover:bg-accent';

/**
 * Block 28. Any set of Stations, replacing Block 8a's two-position
 * ConsolidatedToggle — which offered "this Station" and "all Stations" and
 * nothing between them, while the array behind it has travelled from the URL to
 * the RPC since 0118. Nothing below the URL changed to allow this; the control
 * was the only thing that could not say "these three".
 *
 * THE ONLY STATION CONTROL ON THESE THREE SCREENS. It used to be the second of
 * two: a switcher row rendered every Station's name as a pill that REPLACED the
 * selection, and this one rendered a second pill per Station that added to it.
 * Two rows of the same names doing two different things is a reading cost paid
 * on every visit for a distinction that matters on almost none of them, so the
 * switcher was folded in here — which is what `mode` on each pill now carries.
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
 *
 * WHICH URL EACH PILL BUILDS LIVES IN ./station-pills, not here: this project
 * installs no jsdom, and the two ways a pill can build a URL the RPC refuses are
 * worth a test even though a row of links is not.
 */
export function StationSelection({
  base,
  period,
  stationSearch,
  singleCompanyId,
  viewable,
  suspended,
  consolidatedCompanyIds,
  selectedIds,
  complete,
}: {
  base: string;
  period: PeriodSelection;
  stationSearch?: string;
  /**
   * Where unselecting the LAST pill goes. See `stationPills`: an empty selection
   * is not a selection, and this is what it falls back to.
   */
  singleCompanyId: string;
  /** Every Station this caller can view — all of them get a pill now. */
  viewable: ViewableCompany[];
  /** Named but not clickable, since no data exists to show for them. */
  suspended: SuspendedCompany[];
  /** Of `viewable`, the ones `reports.consolidated` reaches. */
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

  // Nothing to choose between. The pages guard this too; this is the list's own
  // answer, and it is the one that survives a caller reaching the component
  // some other way.
  if (viewable.length + suspended.length < 2) return null;

  const multi = canSelectAll(consolidatedCompanyIds);
  const pills = stationPills({
    stations: viewable,
    consolidatedIds: consolidatedCompanyIds,
    selectedIds,
    fallbackId: singleCompanyId,
  });
  // WHETHER THE ROW HOLDS BOTH KINDS AT ONCE. With every pill replacing (a
  // caller who can consolidate fewer than two Stations) there is nothing to
  // contrast with and the old switcher's plain styling is exactly right; with
  // every pill toggling, likewise. It is only the mixed row where a click can
  // mean two things, and a difference that silent is the trap worth marking.
  const mixed = multi && pills.some((pill) => pill.mode === 'replace');

  const names = new Map(viewable.map((company) => [company.id, company.name]));
  const hrefFor = (ids: string[]) =>
    withStationSearch(periodHref(base, period, ids), stationSearch) as Route;

  return (
    <div className="flex flex-col gap-1" data-testid="station-selection">
      <span className="text-xs text-muted-foreground">{t('selectStations')}</span>
      <div className="flex flex-wrap items-center gap-1 rounded-full border p-1">
        {pills.map((pill) => {
          const replaces = pill.mode === 'replace';
          return (
            <Link
              key={pill.id}
              href={hrefFor(pill.next)}
              // A toggle is pressed or not; a replacement is the current page or
              // not. Two different questions, and assistive technology answers
              // them with two different attributes.
              aria-pressed={replaces ? undefined : pill.selected}
              aria-current={replaces && pill.selected ? 'page' : undefined}
              className={
                pill.selected ? ACTIVE_PILL : mixed && replaces ? REPLACE_PILL : INACTIVE_PILL
              }
              title={mixed && replaces ? t('thisStationCannotBeShownAlongside') : undefined}
            >
              {names.get(pill.id)}
            </Link>
          );
        })}

        {suspended.map((company) => (
          <span
            key={company.id}
            title={t('suspendedNoDataIsAvailableWhile')}
            className="rounded-full border border-dashed px-3 py-1 text-xs font-medium text-muted-foreground"
          >
            {company.name} (suspended)
          </span>
        ))}

        {/* ONLY WHEN THERE IS A SET TO SELECT. With one consolidable Station the
            chip is a second pill for that Station wearing a label claiming more
            than it delivers; with none it would link to an empty array, which
            0118 raises 22023 for. */}
        {multi && (
          <Link
            href={hrefFor(consolidatedCompanyIds)}
            aria-current={
              consolidatedCompanyIds.every((id) => selectedIds.includes(id)) ? 'page' : undefined
            }
            className={
              consolidatedCompanyIds.every((id) => selectedIds.includes(id))
                ? ACTIVE_PILL
                : INACTIVE_PILL
            }
            title={complete ? undefined : t('onlyTheStationsListedAbove')}
          >
            {complete
              ? t('allStations', { count: consolidatedCompanyIds.length })
              : t('stationsListed', { count: consolidatedCompanyIds.length })}
          </Link>
        )}
      </div>

      {/* Only where a count is news. Where every pill replaces, this could only
          ever read "1 station". */}
      {multi && (
        <span className="text-xs text-muted-foreground" data-testid="stations-selected">
          {t('stationsSelected', { count: selectedIds.length })}
        </span>
      )}
    </div>
  );
}
