import { getTranslations } from 'next-intl/server';
import Link from 'next/link';
import { PageHeader } from '@/components/layout/app-shell';
import { stationSwitchHref } from '@/lib/station-switch';
import type { ReferenceSummary } from '@/services/music';
import { StationSearchForm } from '../../inventory/station-search-form';
import type { SuspendedCompany, ViewableCompany } from '../../inventory/station-access';
import { referenceScreenPath } from './list-params';
import type { ReferenceListState, ReferenceScreenCopy, ReferenceScreenKind } from './list-params';
import { ReferencesFilters } from './references-filters';
import { ReferencesGrid } from './references-grid';

/**
 * D2 (design spec §2): the ONE component both `/catalog/labels` and
 * `/catalog/genres` render. `labels/page.tsx` and `genres/page.tsx` do the
 * work only a Server Component can — resolving the caller, the Station and the
 * page of rows — and hand everything else here as plain data: PageHeader, the
 * Station switcher, the search form, the filters and the grid (which carries
 * the Cadastrar button and its popup — see references-grid.tsx's own header
 * for why it lives there rather than here).
 *
 * A Server Component, not a Client one, and deliberately: StationSearchForm
 * (../../inventory/station-search-form.tsx) is itself an async Server
 * Component that calls `getTranslations` — Next refuses to render a Server
 * Component instantiated directly inside a 'use client' module, so this file
 * has to stay one too. Its own generic copy (Station switcher, capped notice)
 * is resolved here with a literal `getTranslations('music')`, the same
 * pattern music/artists/page.tsx uses for the identical JSX; only the
 * kind-specific strings arrive as `copy`, a plain prop the two page files
 * build with their own literal `t(...)` calls, one quoted string per key — see list-params.ts's
 * ReferenceScreenCopy for why that split exists.
 */
export async function ReferenceScreen({
  kind,
  copy,
  stationSearch,
  viewable,
  suspended,
  capped,
  state,
  rows,
  total,
  previousHref,
  nextHref,
  manage,
}: {
  kind: ReferenceScreenKind;
  copy: ReferenceScreenCopy;
  stationSearch?: string;
  viewable: ViewableCompany[];
  suspended: SuspendedCompany[];
  capped: boolean;
  state: ReferenceListState;
  rows: ReferenceSummary[];
  total: number;
  previousHref: string | null;
  nextHref: string | null;
  /** Whether the caller holds music.manage at this Station — a courtesy gate; every write re-checks it itself. */
  manage: boolean;
}) {
  const t = await getTranslations('music');
  const path = referenceScreenPath(kind);

  return (
    <>
      <PageHeader title={copy.title} description={copy.description} />

      {(capped || stationSearch) && (
        <div className="mb-4 flex flex-col gap-2">
          {capped && (
            <p className="text-xs text-muted-foreground">
              {t('showing')} {viewable.length + suspended.length} {t('ofTheStationsYouCanReach')}
            </p>
          )}
          <StationSearchForm
            action={path}
            value={stationSearch ?? ''}
            preserve={{}}
            label={t('findAStation')}
          />
        </div>
      )}

      {viewable.length + suspended.length > 1 && (
        <div className="mb-6 flex flex-wrap gap-2">
          {viewable.map((company) => (
            <Link
              key={company.id}
              href={stationSwitchHref(path, company.id, stationSearch)}
              aria-current={company.id === state.companyId ? 'page' : undefined}
              className={
                company.id === state.companyId
                  ? 'rounded-full bg-primary px-3 py-1 text-xs font-medium text-primary-foreground'
                  : 'rounded-full border px-3 py-1 text-xs font-medium text-muted-foreground hover:bg-accent'
              }
            >
              {company.name}
            </Link>
          ))}
          {/* A suspended Station passes the Company visibility policy — which
              deliberately keeps suspended Companies visible so the UI can
              explain why access stopped — then fails has_permission
              unconditionally. Rendered here, disabled, with the reason,
              instead of silently vanishing from the switcher with no
              explanation. */}
          {suspended.map((company) => (
            <span
              key={company.id}
              title={t('suspendedNoDataIsAvailableWhile')}
              className="rounded-full border border-dashed px-3 py-1 text-xs font-medium text-muted-foreground"
            >
              {company.name} (suspended)
            </span>
          ))}
        </div>
      )}

      <ReferencesFilters kind={kind} state={state} copy={copy} />

      <ReferencesGrid
        kind={kind}
        rows={rows}
        total={total}
        state={state}
        previousHref={previousHref}
        nextHref={nextHref}
        manage={manage}
        copy={copy}
      />
    </>
  );
}
