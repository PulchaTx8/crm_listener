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
import { describeMaintenanceReadError, describeMusicReadError } from '../errors';
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
    return <LoadError message={describeMusicReadError(cause)} />;
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
  // permission boundary (music.merge) is written in SQL rather than
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
    // Not describeMusicReadError: listMergeCandidates is gated on
    // music.merge, not music.view like every other read that describer
    // serves, so its fixed "...view the music catalogue..." sentence would
    // misname the permission a 403 here is actually about (Task 7's review,
    // verified against 0108 — see describeMaintenanceReadError's own
    // comment in ../errors.ts).
    return <LoadError message={describeMaintenanceReadError(cause)} />;
  }

  return (
    <>
      <PageHeader
        title="Maintenance"
        description="Find duplicates, name the one that stays, and merge. This is the only irreversible action in the music catalogue."
      />

      {(capped || stationSearch) && (
        <div className="mb-4 flex flex-col gap-2">
          {capped && (
            <p className="text-xs text-muted-foreground">
              Showing {viewable.length + suspended.length} of the Stations you can reach. Search
              by name to reach one that is not listed.
            </p>
          )}
          <StationSearchForm
            action="/music/maintenance"
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
              title="Suspended — no data is available while the subscription is inactive."
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
      <div aria-label="Record kind" className="mb-4 flex gap-1 border-b">
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

      {/* Keyed on the kind: a clean remount between panels means the
          staging area of a Songs merge can never bleed into an Artists
          one after a tab switch — the same reasoning ReferenceTabs' own
          header gives for keying its panel on `tab`. */}
      <MergePanel key={state.kind} state={state} candidates={candidates} canMerge={permissions.merge} />
    </>
  );
}

function NoStationMatch({ search }: { search: string }) {
  return (
    <>
      <PageHeader title="Maintenance" />
      <Card>
        <CardContent className="flex flex-col gap-3 pt-6">
          <p className="text-sm text-muted-foreground">
            No Station you can reach matches “{search}”.
          </p>
          <Link href="/music/maintenance" className="text-sm text-primary underline underline-offset-2">
            Clear the Station search
          </Link>
        </CardContent>
      </Card>
    </>
  );
}

function LoadError({ message }: { message: string }) {
  return (
    <>
      <PageHeader title="Maintenance" />
      <Card>
        <CardContent className="pt-6">
          <p className="text-sm text-destructive">{message}</p>
        </CardContent>
      </Card>
    </>
  );
}
