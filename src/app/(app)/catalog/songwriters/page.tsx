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

/** This route's own kind. `genres/page.tsx` and `labels/page.tsx` are this file with KIND and copy swapped — D2's "thin page" half. */
const KIND = 'SONGWRITER' as const;

/**
 * Block 28. Songwriters — the people who WROTE this Station's songs, beside the
 * artist rather than instead of it: the artist is who PERFORMS the recording,
 * the songwriter is who wrote it, and the two are routinely different people.
 * Block 27 shipped this screen as Categories, on a reading of the owner's item
 * that the owner corrected.
 *
 * THE SCREEN IS `/catalog/genres` WITH DIFFERENT COPY, and that is the whole of
 * design D2 and D4. The Station switcher, the URL-driven filter bar, the keyset
 * paging, the record-as-a-modal, the pencil column and the actions dropdown all
 * come from ReferenceScreen; an operator who has registered a genre already
 * knows how to register a songwriter, and a second layout for the same job would
 * only be a second thing to maintain. The owner's item 1 asked for "the pattern
 * of the other screens", and this is literally that component.
 *
 * The kind-specific strings are resolved HERE, as twelve literal `t(...)` calls
 * with a quoted string each, rather than inside the shared components: this
 * screen's kind is a runtime value, and tests/unit/i18n/usage.test.ts can only
 * see a call whose argument is written out. ReferenceScreenCopy's own comment
 * sets that trap out at length — and this file has now paid a small instalment
 * of it, because the scanner reads comments too and a quoted example inside one
 * is indistinguishable from a real call.
 */
export const dynamic = 'force-dynamic';

export default async function SongwritersPage({
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
  // archive_music_reference and songwriters' own select policy (0205) each
  // re-check has_permission themselves before writing or reading anything.
  // This redirect only saves someone holding music.view nowhere a trip to a
  // screen that would otherwise have nothing to show.
  // A Station search that matches nothing leaves this caller with no Station
  // to show, which is not the same as holding music.view nowhere: the
  // redirect below would throw them off the screen with no way to clear the
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
    logger.error({ err: cause, companyId: selected.id }, 'could not load the songwriters list');
    return <LoadError message={describeMusicReadError(cause, t)} />;
  }

  const copy: ReferenceScreenCopy = {
    title: t('songwriters'),
    description: t('referenceSongwritersDescription'),
    createButton: t('registerSongwriter'),
    createDialogTitle: t('registerASongwriter'),
    archiveButton: t('archiveSongwriter'),
    archiveConfirmTitle: t('archiveThisSongwriterQuestion'),
    readOnlyNotice: t('youDoNotHoldMusicManageForThisRecord'),
    emptyMessage: t('noSongwritersAreRegisteredInThis'),
    noMatchMessage: t('noSongwriterMatchesTheseFilters'),
    countLabel: t('songwritersCountLabel', { count: page.total }),
    searchPlaceholder: t('songwriterName'),
    searchAriaLabel: t('searchSongwritersByName'),
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
      <PageHeader title={t('songwriters')} />
      <Card>
        <CardContent className="flex flex-col gap-3 pt-6">
          <p className="text-sm text-muted-foreground">
            {t('noStationYouCanReachMatches', { search })}
          </p>
          {/* typedRoutes cannot see a brand-new route's static literal until
              Next regenerates its route types (`next dev`/`next build`) — the
              same cast genres/page.tsx carries beside it, applied here for a
              route that is simply too new. */}
          <Link
            href={'/catalog/songwriters' as Route}
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
      <PageHeader title={t('songwriters')} />
      <Card>
        <CardContent className="pt-6">
          <p className="text-sm text-destructive">{message}</p>
        </CardContent>
      </Card>
    </>
  );
}
