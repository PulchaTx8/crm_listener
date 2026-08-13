import { getTranslations } from 'next-intl/server';
import Link from 'next/link';
import type { Route } from 'next';
import { redirect } from 'next/navigation';
import { createUserClient } from '@/lib/supabase/user-client';
import { logger } from '@/lib/logger';
import { PageHeader } from '@/components/layout/app-shell';
import { Card, CardContent } from '@/components/ui/card';
import { decodeCursor } from '@/lib/keyset';
import { listMusicReferencesPage, SONG_SEARCH_MAX_LENGTH } from '@/services/music';
import type { ReferenceListPage } from '@/services/music';
import { STATION_SEARCH_MAX_LENGTH, listCompanyAccess } from '../../inventory/station-access';
import type { SuspendedCompany, ViewableCompany } from '../../inventory/station-access';
import { getMusicPermissions } from '../../music/permissions';
import type { MusicPermissions } from '../../music/permissions';
import { describeMusicReadError } from '../../music/errors';
import { ReferenceScreen } from '../references/reference-screen';
import { parseReferenceCursor, parseReferenceListState, referenceHref } from '../references/list-params';
import type { ReferenceScreenCopy, ReferenceSearchParams } from '../references/list-params';

/** This route's own kind. genres/page.tsx is this file with KIND and copy swapped — D2's "thin page" half. */
const KIND = 'LABEL' as const;

// Renders from the caller's session cookies and a live per-Station permission
// check, so it can never be static.
export const dynamic = 'force-dynamic';

export default async function LabelsPage({
  searchParams,
}: {
  searchParams: Promise<ReferenceSearchParams>;
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
    return <LoadError message={describeMusicReadError(cause, t)} />;
  }

  const first = viewable[0];

  // A courtesy, not the boundary: create_music_reference, update_music_reference,
  // archive_music_reference and record_labels' own select policy (0099) each
  // re-check has_permission themselves before writing or reading anything.
  // This redirect only saves someone holding music.view nowhere a trip to a
  // screen that would otherwise have nothing to show.
  // A Station search that matches nothing leaves this caller with no Station
  // to show, which is not the same as holding music.view nowhere: the
  // redirect above would throw them off the screen with no way to clear the
  // search. Handled before it, so the search can always be undone.
  if (!first && stationSearch) return <NoStationMatch search={stationSearch} />;
  if (!first) redirect('/app');

  // A stale or tampered companyId that is not in `viewable` — access revoked
  // since the link was generated, or a hand-edited URL — falls back to the
  // first Station this caller can actually view rather than erroring.
  const selected = viewable.find((c) => c.id === params.companyId) ?? first;

  const state = parseReferenceListState(params, selected.id);
  const cursorParam = parseReferenceCursor(params);
  // An unreadable cursor means "start from the beginning", never an error page.
  const cursor = decodeCursor(cursorParam?.value);

  let page: ReferenceListPage;
  let permissions: MusicPermissions;
  try {
    [page, permissions] = await Promise.all([
      listMusicReferencesPage({
        companyId: selected.id,
        kind: KIND,
        // The same bound the service enforces on its own argument, imported
        // rather than copied so a URL parameter cannot drift the two apart.
        search: state.search?.slice(0, SONG_SEARCH_MAX_LENGTH),
        direction: state.direction,
        cursor,
        cursorSide: cursorParam?.side ?? 'after',
      }),
      getMusicPermissions(supabase, selected.id),
    ]);
  } catch (cause) {
    logger.error({ err: cause, companyId: selected.id }, 'could not load the record labels list');
    return <LoadError message={describeMusicReadError(cause, t)} />;
  }

  const copy: ReferenceScreenCopy = {
    title: t('labels'),
    description: t('referenceLabelsDescription'),
    createButton: t('registerLabel'),
    createDialogTitle: t('registerALabel'),
    archiveButton: t('archiveLabel'),
    archiveConfirmTitle: t('archiveThisLabelQuestion'),
    readOnlyNotice: t('youDoNotHoldMusicManageForThisRecord'),
    emptyMessage: t('noLabelsAreRegisteredInThis'),
    noMatchMessage: t('noLabelMatchesTheseFilters'),
    countLabel: t('labelsCountLabel', { count: page.total }),
    searchPlaceholder: t('labelName'),
    searchAriaLabel: t('searchLabelsByName'),
  };

  return (
    <ReferenceScreen
      kind={KIND}
      copy={copy}
      stationSearch={stationSearch}
      viewable={viewable}
      suspended={suspended}
      capped={capped}
      state={state}
      rows={page.rows}
      total={page.total}
      previousHref={page.previousCursor ? referenceHref(KIND, state, { side: 'before', value: page.previousCursor }) : null}
      nextHref={page.nextCursor ? referenceHref(KIND, state, { side: 'after', value: page.nextCursor }) : null}
      manage={permissions.manage}
    />
  );
}

async function NoStationMatch({ search }: { search: string }) {
  const t = await getTranslations('music');
  return (
    <>
      <PageHeader title={t('labels')} />
      <Card>
        <CardContent className="flex flex-col gap-3 pt-6">
          <p className="text-sm text-muted-foreground">
            {t('noStationYouCanReachMatches', { search })}
          </p>
          {/* typedRoutes cannot see a brand-new route's static literal until
              Next regenerates its route types (`next dev`/`next build`) — the
              same cast the rest of this codebase uses for a href assembled at
              runtime, applied here for a route that is simply too new. */}
          <Link
            href={'/catalog/labels' as Route}
            className="text-sm text-primary underline underline-offset-2"
          >
            {t('clearTheStationSearch')}
          </Link>
        </CardContent>
      </Card>
    </>
  );
}

async function LoadError({ message }: { message: string }) {
  const t = await getTranslations('music');
  return (
    <>
      <PageHeader title={t('labels')} />
      <Card>
        <CardContent className="pt-6">
          <p className="text-sm text-destructive">{message}</p>
        </CardContent>
      </Card>
    </>
  );
}
