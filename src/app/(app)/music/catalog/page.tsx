import { getTranslations } from 'next-intl/server';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { createUserClient } from '@/lib/supabase/user-client';
import { logger } from '@/lib/logger';
import { stationSwitchHref } from '@/lib/station-switch';
import { PageHeader } from '@/components/layout/app-shell';
import { Card, CardContent } from '@/components/ui/card';
import { listMusicReferences } from '@/services/music';
import type { ReferenceSummary } from '@/services/music';
import { STATION_SEARCH_MAX_LENGTH, listCompanyAccess } from '../../inventory/station-access';
import { StationSearchForm } from '../../inventory/station-search-form';
import type { SuspendedCompany, ViewableCompany } from '../../inventory/station-access';
import { getMusicPermissions } from '../permissions';
import type { MusicPermissions } from '../permissions';
import { describeMusicReadError } from '../errors';
import { ReferenceTabs } from './reference-tabs';
import type { CatalogTab } from './reference-tabs';

// Renders from the caller's session cookies and a live per-Station permission
// check, so it can never be static.
export const dynamic = 'force-dynamic';

interface CatalogSearchParams {
  companyId?: string;
  station?: string;
  tab?: string;
}

/**
 * The legal values of this screen's own `?tab=` — NOT record-params.ts's
 * vocabulary, and deliberately not added there: see reference-tabs.tsx's
 * header for why nothing here opens a record, and why this three-element
 * array is a second, type-checked copy of CATALOG_TABS rather than an import
 * of it. `CatalogTab` (the type) is imported above; this array is the one
 * runtime check page.tsx needs before ReferenceTabs ever mounts.
 */
const CATALOG_TABS: readonly CatalogTab[] = ['labels', 'genres', 'shows'];

/** The tab an unknown or missing `?tab=` falls back to — first in CATALOG_TABS, kept as its own constant because noUncheckedIndexedAccess types `CATALOG_TABS[0]` as possibly undefined despite the array's fixed length. */
const DEFAULT_TAB: CatalogTab = 'labels';

/**
 * Everything arriving here is a URL query parameter, so everything is
 * hostile input — the same contract parseRecordParam (record-params.ts)
 * carries for its own, applied to one more parameter: an unknown or missing
 * `tab=` falls back to the first tab rather than an error page. A URL
 * somebody has been typing into is not an error page.
 */
function parseCatalogTab(raw: string | undefined): CatalogTab {
  const requested = raw?.trim();
  return requested && (CATALOG_TABS as readonly string[]).includes(requested)
    ? (requested as CatalogTab)
    : DEFAULT_TAB;
}

export default async function CatalogPage({
  searchParams,
}: {
  searchParams: Promise<CatalogSearchParams>;
}) {
  const t = await getTranslations('music');
  const params = await searchParams;
  // The same bound listCompanyAccess enforces on its own argument, imported
  // rather than copied.
  const stationSearch = params.station?.trim().slice(0, STATION_SEARCH_MAX_LENGTH) || undefined;

  const supabase = await createUserClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  let viewable: ViewableCompany[];
  let suspended: SuspendedCompany[];
  let capped: boolean;
  try {
    ({ viewable, suspended, capped } = await listCompanyAccess(supabase, 'music.view', stationSearch));
  } catch (cause) {
    logger.error({ err: cause }, 'could not resolve music access');
    return <LoadError message={describeMusicReadError(cause)} />;
  }

  const first = viewable[0];

  // A courtesy, not the boundary: create_music_reference, update_music_reference
  // and archive_music_reference (actions.ts) each re-check has_permission
  // themselves before writing anything, and music_genres/record_labels/shows'
  // own select policies (0099) already filter to exactly the Stations
  // listCompanyAccess just resolved. This redirect only saves someone holding
  // music.view nowhere a trip to a screen that would otherwise have nothing
  // to show — indistinguishable, if rendered instead of redirected, from a
  // Station with an empty catalogue.
  // A Station search that matches nothing leaves this caller with no Station
  // to show, which is not the same as holding music.view nowhere: the
  // redirect above would throw them off the screen with no way to clear the
  // search. Handled before it, so the search can always be undone.
  if (!first && stationSearch) return <NoStationMatch search={stationSearch} />;
  if (!first) redirect('/app');

  // Next's searchParams arrives already percent-decoded (same as every other
  // ?param=-style value in this codebase). A stale or tampered companyId that
  // is not in `viewable` — access revoked since the link was generated, or a
  // hand-edited URL — falls back to the first Station this caller can
  // actually view rather than erroring.
  const selected = viewable.find((c) => c.id === params.companyId) ?? first;
  const tab = parseCatalogTab(params.tab);

  let labels: ReferenceSummary[];
  let genres: ReferenceSummary[];
  let shows: ReferenceSummary[];
  let permissions: MusicPermissions;
  try {
    // All three read whole, never paged: listMusicReferences (services/music.ts)
    // scopes to one Station's live rows via RLS and orders by name — these are
    // exactly the short lists a <select> is meant to show, not a grid.
    [labels, genres, shows, permissions] = await Promise.all([
      listMusicReferences(selected.id, 'LABEL'),
      listMusicReferences(selected.id, 'GENRE'),
      listMusicReferences(selected.id, 'SHOW'),
      getMusicPermissions(supabase, selected.id),
    ]);
  } catch (cause) {
    logger.error({ err: cause, companyId: selected.id }, 'could not load the catalogue');
    return <LoadError message={describeMusicReadError(cause)} />;
  }

  return (
    <>
      <PageHeader
        title={t('catalogue')}
        description="Labels, genres and shows — the short lists a song or a request is built from."
      />

      {(capped || stationSearch) && (
        <div className="mb-4 flex flex-col gap-2">
          {capped && (
            <p className="text-xs text-muted-foreground">
              {t('showing')}{' '}{viewable.length + suspended.length} {t('ofTheStationsYouCanReach')}</p>
          )}
          <StationSearchForm
            action="/music/catalog"
            value={stationSearch ?? ''}
            preserve={{}}
            label="Find a Station"
          />
        </div>
      )}

      {viewable.length + suspended.length > 1 && (
        <div className="mb-6 flex flex-wrap gap-2">
          {viewable.map((company) => (
            <Link
              key={company.id}
              // ReferenceTabs's own tab writes never touch this key at all —
              // they rewrite `tab` on the existing query string — so this link
              // is the only place on this screen that spells a Station switch.
              href={stationSwitchHref('/music/catalog', company.id, stationSearch)}
              aria-current={company.id === selected.id ? 'page' : undefined}
              className={
                company.id === selected.id
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
              unconditionally (has_company_access requires status =
              'active'). Rendered here, disabled, with the reason, instead of
              silently vanishing from the switcher with no explanation. */}
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

      <ReferenceTabs
        companyId={selected.id}
        manage={permissions.manage}
        initialTab={tab}
        labels={labels}
        genres={genres}
        shows={shows}
      />
    </>
  );
}

async function NoStationMatch({ search }: { search: string }) {
  const t = await getTranslations('music');
  return (
    <>
      <PageHeader title={t('catalogue')} />
      <Card>
        <CardContent className="flex flex-col gap-3 pt-6">
          <p className="text-sm text-muted-foreground">
            {t('noStationYouCanReachMatches', { search })}
          </p>
          <Link href="/music/catalog" className="text-sm text-primary underline underline-offset-2">
            {t('clearTheStationSearch')}</Link>
        </CardContent>
      </Card>
    </>
  );
}

async function LoadError({ message }: { message: string }) {
  const t = await getTranslations('music');
  return (
    <>
      <PageHeader title={t('catalogue')} />
      <Card>
        <CardContent className="pt-6">
          <p className="text-sm text-destructive">{message}</p>
        </CardContent>
      </Card>
    </>
  );
}
