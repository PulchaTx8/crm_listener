import { getTranslations } from 'next-intl/server';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import type { Route } from 'next';
import { createUserClient } from '@/lib/supabase/user-client';
import { logger } from '@/lib/logger';
import { stationSwitchHref } from '@/lib/station-switch';
import { PageHeader } from '@/components/layout/app-shell';
import { Card, CardContent } from '@/components/ui/card';
import { listMergeCandidates } from '@/services/music';
import type { MergeCandidate } from '@/services/music';
import { MUSIC_MERGE_KINDS } from '@/schemas/music';
import type { MusicMergeKind } from '@/schemas/music';
import { listCompanyAccess, STATION_SEARCH_MAX_LENGTH } from '../../inventory/station-access';
import { StationSearchForm } from '../../inventory/station-search-form';
import type { SuspendedCompany, ViewableCompany } from '../../inventory/station-access';
import { getMusicPermissions } from '../permissions';
import type { MusicPermissions } from '../permissions';
import { describeMusicReadError } from '../errors';
import { MergePanel } from './merge-panel';
import { maintenanceHref, parseMaintenanceParams } from './list-params';
import type { MaintenanceSearchParams } from './list-params';

// Renders from the caller's session cookies and a live per-Station permission
// check, so it can never be static.
export const dynamic = 'force-dynamic';

/**
 * Duplicated from merge-panel.tsx's own kind→label map rather than imported
 * from it — that file is 'use client', and importing a runtime value out of
 * a client module from this Server Component would arrive as an opaque
 * client reference rather than the map itself, the identical defect
 * reference-tabs.tsx's header documents at length for CatalogTab. Both maps
 * are exhaustive over MUSIC_MERGE_KINDS, so they cannot silently drift
 * apart: renaming a kind is a type error in both files at once.
 */
const KIND_LABELS: Record<MusicMergeKind, string> = {
  SONG: 'Songs',
  ARTIST: 'Artists',
  LABEL: 'Labels',
  GENRE: 'Genres',
  SHOW: 'Shows',
};

export default async function MaintenancePage({
  searchParams,
}: {
  searchParams: Promise<MaintenanceSearchParams>;
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
    // Resolved on music.view, not music.merge: this is the same Station
    // list every other music screen offers, and a caller who can see the
    // catalogue but not merge it still needs to reach this screen to learn
    // that — MergePanel's own `canMerge` prop is what renders it read-only,
    // not a narrower Station list here.
    ({ viewable, suspended, capped } = await listCompanyAccess(supabase, 'music.view', stationSearch));
  } catch (cause) {
    logger.error({ err: cause }, 'could not resolve music access');
    return <LoadError message={describeMusicReadError(cause, await getTranslations('music'))} />;
  }

  const first = viewable[0];

  // A Station search that matches nothing leaves this caller with no Station
  // to show, which is not the same as holding music.view nowhere: the
  // redirect below would throw them off the screen with no way to clear the
  // search. Handled before it, so the search can always be undone.
  if (!first && stationSearch) return <NoStationMatch search={stationSearch} />;
  // A courtesy, not the boundary: list_merge_candidates and every merge door
  // re-check their own permission before reading or writing anything.
  if (!first) redirect('/app');

  // A stale or tampered companyId that is not in `viewable` — access revoked
  // since the link was generated, or a hand-edited URL — falls back to the
  // first Station this caller can actually view rather than erroring.
  const selected = viewable.find((c) => c.id === params.companyId) ?? first;
  const state = parseMaintenanceParams(params, selected.id);

  // Read here rather than inside the try below, because `redirect` works by
  // throwing and a catch would swallow it — the same placement
  // requests/page.tsx uses for its own session read. Needed because
  // listMergeCandidates reads through the caller's token rather than
  // createUserClient() — list_merge_candidates is SECURITY DEFINER, so its
  // permission boundary (music.view, as of Task 9's fix round — see 0108's
  // own comment for why the read is gated on the same code as every other
  // music read rather than on music.merge) is written in SQL rather than
  // enforced by RLS.
  const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
  if (sessionError || !sessionData.session) redirect('/login');
  const accessToken = sessionData.session.access_token;

  let candidates: MergeCandidate[];
  let permissions: MusicPermissions;
  try {
    [candidates, permissions] = await Promise.all([
      listMergeCandidates(selected.id, state.kind, state.search, accessToken),
      getMusicPermissions(supabase, selected.id),
    ]);
  } catch (cause) {
    logger.error({ err: cause, companyId: selected.id, kind: state.kind }, 'could not load merge candidates');
    // describeMusicReadError, not a Maintenance-specific describer:
    // list_merge_candidates is gated on music.view (0108, corrected in
    // Task 9's fix round — it originally checked music.merge, which made
    // `permissions.merge === false` and "this read already threw" the same
    // event, so the read-only branch below could never run). Now that its
    // 42501 really is about music.view, describeMusicReadError's own
    // "...view the music catalogue..." sentence is the right one — a
    // Maintenance-specific wording (Task 9's first pass added one) would be
    // wrong in the opposite direction now.
    return <LoadError message={describeMusicReadError(cause, await getTranslations('music'))} />;
  }

  return (
    <>
      <PageHeader
        title={t('maintenance')}
        description={t('maintenanceDescription')}
      />

      {(capped || stationSearch) && (
        <div className="mb-4 flex flex-col gap-2">
          {capped && (
            <p className="text-xs text-muted-foreground">
              {t('showing')}{' '}{viewable.length + suspended.length} {t('ofTheStationsYouCanReach')}</p>
          )}
          <StationSearchForm
            action="/music/maintenance"
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
              href={stationSwitchHref('/music/maintenance', company.id, stationSearch)}
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

      {/* Real navigations, not a client-side tab swap like ReferenceTabs
          (catalog/reference-tabs.tsx): each kind reads a different table
          through listMergeCandidates, so there is no already-loaded panel
          to swap to — unlike the Catalog screen's three short lists, which
          are all read once up front. Every link here is built by spreading
          the WHOLE current state (maintenanceHref) and overriding only
          `kind`, so a kind switch can never silently drop the Station
          search or the operator's own candidate search — the fix for the
          gap docs/block-7a-report.md records against the Catalog screen's
          own tabs, which only carried `tab=` through a client-side history
          write and dropped it on a real Station-switch navigation. */}
      <div aria-label={t('recordKind')} className="mb-4 flex gap-1 border-b">
        {MUSIC_MERGE_KINDS.map((kind) => (
          <Link
            key={kind}
            href={maintenanceHref({ ...state, kind }) as Route}
            aria-current={kind === state.kind ? 'page' : undefined}
            data-testid={`maintenance-tab-${kind.toLowerCase()}`}
            className={
              kind === state.kind
                ? 'border-b-2 border-primary px-4 py-2 text-sm font-medium'
                : 'border-b-2 border-transparent px-4 py-2 text-sm text-muted-foreground hover:text-foreground'
            }
          >
            {KIND_LABELS[kind]}
          </Link>
        ))}
      </div>

      {/* Keyed on Station AND kind, not kind alone — fix round 1, Critical 2.
          The Company switcher above is a <Link> to this same route, a soft
          client-side navigation exactly like the kind tabs; keying only on
          `kind` remounted MergePanel on a kind switch but NOT on a Station
          switch, so a staged basket (React state local to the old mount —
          §5.1) survived across it. On screen that read as: Station B
          highlighted, Station B's candidate list with nothing ticked, and a
          staging panel still holding Station A's rows with a survivor
          already named — confirmable, because the doors take only
          winnerId/loserIds/reason and derive the Station from the winner
          row, never from anything this screen posts. With duplicate titles
          across Stations (the ordinary case for a group under one
          Organization), that is a real, irreversible cross-Station merge
          waiting on one confirm click. Both fields together is what makes a
          clean remount — the same reasoning ReferenceTabs' own header gives
          for keying its panel on `tab` alone, extended to the one axis this
          screen has that ReferenceTabs does not: more than one Station. */}
      <MergePanel
        key={`${state.companyId}:${state.kind}`}
        state={state}
        candidates={candidates}
        canMerge={permissions.merge}
      />
    </>
  );
}

async function NoStationMatch({ search }: { search: string }) {
  const t = await getTranslations('music');
  return (
    <>
      <PageHeader title={t('maintenance')} />
      <Card>
        <CardContent className="flex flex-col gap-3 pt-6">
          <p className="text-sm text-muted-foreground">
            {t('noStationYouCanReachMatches', { search })}
          </p>
          <Link href="/music/maintenance" className="text-sm text-primary underline underline-offset-2">
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
      <PageHeader title={t('maintenance')} />
      <Card>
        <CardContent className="pt-6">
          <p className="text-sm text-destructive">{message}</p>
        </CardContent>
      </Card>
    </>
  );
}
