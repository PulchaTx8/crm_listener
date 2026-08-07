import { getTranslations } from 'next-intl/server';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { createUserClient } from '@/lib/supabase/user-client';
import { InternalError } from '@/lib/errors';
import { logger } from '@/lib/logger';
import { stationSwitchHref } from '@/lib/station-switch';
import { PageHeader } from '@/components/layout/app-shell';
import { Card, CardContent } from '@/components/ui/card';
import { decodeCursor } from '@/lib/keyset';
import { listMusicReferences, listMusicRequestsPage, SONG_SEARCH_MAX_LENGTH } from '@/services/music';
import type { ReferenceSummary, RequestListPage } from '@/services/music';
import { listCompanyAccess, STATION_SEARCH_MAX_LENGTH } from '../../inventory/station-access';
import { StationSearchForm } from '../../inventory/station-search-form';
import type { SuspendedCompany, ViewableCompany } from '../../inventory/station-access';
import { canSearchByListener } from '../../participations/access';
import { getMusicPermissions } from '../permissions';
import type { MusicPermissions } from '../permissions';
import { describeMusicReadError } from '../errors';
import { RequestsFilters } from './requests-filters';
import { RequestsGrid } from './requests-grid';
import { parseRequestCursor, parseRequestListParams, requestHref } from './list-params';
import type { MusicRequestSearchParams } from './list-params';
import type { UserClient } from '@/lib/supabase/user-client';
import { ExportDialog } from '@/components/reports/export-dialog';
import { musicRequestsReportFilters } from '@/lib/reports/list-filters';

// Renders from the caller's session cookies and a live per-Station permission
// check, so it can never be static.
export const dynamic = 'force-dynamic';

/**
 * Whether this caller may register a brand-new listener at this Station —
 * the second half of the manual form's "somebody new" branch. members.create
 * rather than any music code, on the identical asymmetry canSearchByListener
 * (participations/access.ts) already documents for members.view: it is a
 * different permission from music.request, and the form has to ask before it
 * offers the fields rather than after a submission is refused.
 *
 * Kept local rather than added to participations/access.ts: that module's
 * own two functions are both scoped to what the participations screen needs,
 * and this is a third, unrelated question that only this screen asks.
 */
async function canRegisterListenersHere(
  supabase: UserClient,
  companyId: string,
): Promise<boolean> {
  const { data, error } = await supabase.rpc('has_permission', {
    p_permission: 'members.create',
    p_company_id: companyId,
  });
  if (error) {
    throw new InternalError(
      `Could not check whether this caller may register listeners here: ${error.message}`,
    );
  }
  return data === true;
}

export default async function RequestsPage({
  searchParams,
}: {
  searchParams: Promise<MusicRequestSearchParams>;
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
    return <LoadError message={describeMusicReadError(cause, await getTranslations('music'))} />;
  }

  const first = viewable[0];

  // A Station search that matches nothing leaves this caller with no Station
  // to show, which is not the same as holding music.view nowhere: the
  // redirect below would throw them off the screen with no way to clear the
  // search. Handled before it, so the search can always be undone.
  if (!first && stationSearch) return <NoStationMatch search={stationSearch} />;
  // A courtesy, not the boundary: list_music_requests, create_music_request
  // and archive_music_request each re-check their own permission before
  // reading or writing anything (0107).
  if (!first) redirect('/app');

  // A stale or tampered companyId that is not in `viewable` — access revoked
  // since the link was generated, or a hand-edited URL — falls back to the
  // first Station this caller can actually view rather than erroring.
  const selected = viewable.find((c) => c.id === params.companyId) ?? first;

  const state = parseRequestListParams(params, selected.id);
  const cursorParam = parseRequestCursor(params);
  // An unreadable cursor means "start from the beginning", never an error page.
  const cursor = decodeCursor(cursorParam?.value);

  // Read here rather than inside the try below, because `redirect` works by
  // throwing and a catch would swallow it — the same placement
  // participations/page.tsx uses for its own session read. Needed because
  // listMusicRequestsPage reads through the caller's token rather than
  // createUserClient() — list_music_requests is SECURITY DEFINER, so its
  // permission boundary is written in SQL rather than enforced by RLS.
  const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
  if (sessionError || !sessionData.session) redirect('/login');
  const accessToken = sessionData.session.access_token;

  let shows: ReferenceSummary[];
  let page: RequestListPage;
  let permissions: MusicPermissions;
  let canSearch: boolean;
  let canRegister: boolean;
  try {
    // canSearch decides whether the listener search term is sent at all —
    // resolved before the list read, the same ordering participations/page.tsx
    // uses for the identical reason: without members.view the search matches
    // nothing (0107's RULE 3), and sending the term anyway would render an
    // empty page indistinguishable from "no request matched".
    [shows, permissions, canSearch, canRegister] = await Promise.all([
      listMusicReferences(selected.id, 'SHOW'),
      getMusicPermissions(supabase, selected.id),
      canSearchByListener(supabase, selected.id),
      canRegisterListenersHere(supabase, selected.id),
    ]);

    page = await listMusicRequestsPage(
      {
        companyId: selected.id,
        songId: state.songId,
        showId: state.showId,
        channel: state.channel,
        // The same bound the service enforces on its own argument, imported
        // rather than copied so a URL parameter cannot drift the two apart.
        // Dropped rather than forwarded when this caller cannot search, for
        // the reason above.
        search: canSearch ? state.search?.slice(0, SONG_SEARCH_MAX_LENGTH) : undefined,
        cursor,
        cursorSide: cursorParam?.side ?? 'after',
      },
      accessToken,
    );
  } catch (cause) {
    logger.error({ err: cause, companyId: selected.id }, 'could not load the requests list');
    return <LoadError message={describeMusicReadError(cause, await getTranslations('music'))} />;
  }

  return (
    <>
      <PageHeader
        title={t('requests')}
        description={t('requestsDescription')}
        // Block 8b. The filters ALREADY on this screen, translated into the
        // report's vocabulary by list-filters.ts -- never a second set the
        // dialog asks for. The operator has expressed the question by
        // filtering; asking again in another vocabulary is how the file and
        // the screen come to disagree about what was exported.
        action={
          <ExportDialog
            reportType="MUSIC_REQUESTS"
            companyIds={[selected.id]}
            filters={musicRequestsReportFilters(state)}
          />
        }
      />

      {(capped || stationSearch) && (
        <div className="mb-4 flex flex-col gap-2">
          {capped && (
            <p className="text-xs text-muted-foreground">
              {t('showing')}{' '}{viewable.length + suspended.length} {t('ofTheStationsYouCanReach')}</p>
          )}
          <StationSearchForm
            action="/music/requests"
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
              href={stationSwitchHref('/music/requests', company.id, stationSearch)}
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

      <RequestsFilters state={state} shows={shows} canSearchByListener={canSearch} />

      <RequestsGrid
        rows={page.rows}
        total={page.total}
        previousHref={
          page.previousCursor ? requestHref(state, { side: 'before', value: page.previousCursor }) : null
        }
        nextHref={page.nextCursor ? requestHref(state, { side: 'after', value: page.nextCursor }) : null}
        companyId={selected.id}
        timeZone={selected.timezone}
        shows={shows}
        canRequest={permissions.request}
        canFindListeners={canSearch}
        canRegisterListeners={canRegister}
      />
    </>
  );
}

async function NoStationMatch({ search }: { search: string }) {
  const t = await getTranslations('music');
  return (
    <>
      <PageHeader title={t('requests')} />
      <Card>
        <CardContent className="flex flex-col gap-3 pt-6">
          <p className="text-sm text-muted-foreground">
            {t('noStationYouCanReachMatches', { search })}
          </p>
          <Link href="/music/requests" className="text-sm text-primary underline underline-offset-2">
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
      <PageHeader title={t('requests')} />
      <Card>
        <CardContent className="pt-6">
          <p className="text-sm text-destructive">{message}</p>
        </CardContent>
      </Card>
    </>
  );
}
