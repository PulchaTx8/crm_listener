import { getTranslations } from 'next-intl/server';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { createUserClient } from '@/lib/supabase/user-client';
import { logger } from '@/lib/logger';
import { stationSwitchHref } from '@/lib/station-switch';
import { PageHeader } from '@/components/layout/app-shell';
import { Card, CardContent } from '@/components/ui/card';
import type { WinnerPowers } from '@/components/draws/winner-actions';
import { decodeCursor } from '@/lib/keyset';
import { listPickups } from '@/services/pickups';
import type { PickupListPage } from '@/services/pickups';
import { listPromotionsPage } from '@/services/promotions';
import { listCompanyAccess, STATION_SEARCH_MAX_LENGTH } from '../inventory/station-access';
import type { SuspendedCompany, ViewableCompany } from '../inventory/station-access';
import { StationSearchForm } from '../inventory/station-search-form';
import { canSearchPickupsByListener, getWinnerPowers } from './access';
import { pickupWinnerAction, reopenPickupAction } from './actions';
import { describePickupsReadError } from './errors';
import {
  ANY_STATUS,
  parsePickupCursor,
  parsePickupListState,
  pickupsHref,
  SEARCH_NOTE_ID,
} from './list-params';
import type { PickupSearchParams } from './list-params';
import { PickupsFilters } from './pickups-filters';
import type { PickupPromotionOption } from './pickups-filters';
import { PickupsGrid } from './pickups-grid';
import { ExportDialog } from '@/components/reports/export-dialog';
import { winnersReportFilters } from '@/lib/reports/list-filters';

// Renders from the caller's session cookies and a live per-Station permission
// check, so it can never be static.
export const dynamic = 'force-dynamic';

export default async function PickupsPage({
  searchParams,
}: {
  searchParams: Promise<PickupSearchParams>;
}) {
  const t = await getTranslations('pickups');
  const params = await searchParams;
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
    // promotions.view: the same permission list_pickups (0095, Rule 1) itself
    // gates on, so a Station this caller cannot reach here is a Station
    // list_pickups would refuse with 42501 anyway.
    ({ viewable, suspended, capped } = await listCompanyAccess(
      supabase,
      'promotions.view',
      stationSearch,
    ));
  } catch (cause) {
    logger.error({ err: cause }, 'could not resolve pickups access');
    return <LoadError message={describePickupsReadError(cause, await getTranslations('pickups'))} />;
  }

  const first = viewable[0];

  // A Station search that matches nothing leaves this caller with no Station
  // to show, which is not the same as holding promotions.view nowhere — the
  // redirect below would throw them off the screen with no way to clear the
  // search. Handled before it, so the search can always be undone (the same
  // ordering participations/page.tsx keeps for its own).
  if (!first && stationSearch) return <NoStationMatch search={stationSearch} />;
  // A courtesy, not the boundary: list_pickups re-checks promotions.view
  // itself.
  if (!first) redirect('/app');

  // A stale or tampered companyId that is not in `viewable` falls back to the
  // first Station this caller can actually view rather than erroring.
  const selected = viewable.find((c) => c.id === params.companyId) ?? first;

  const state = parsePickupListState(params, selected.id);
  const cursorParam = parsePickupCursor(params);
  // A bad cursor starts the list over rather than erroring — decodeCursor
  // (@/lib/keyset) returns null for it, the same contract every keyset screen
  // in this codebase shares since Block 6d closed the non-uuid-id door.
  const cursor = decodeCursor(cursorParam?.value);

  // Read here rather than inside the try below, because `redirect` works by
  // throwing and a catch would swallow it.
  const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
  if (sessionError || !sessionData.session) redirect('/login');
  const accessToken = sessionData.session.access_token;

  let canSearch: boolean;
  let winnerPowers: WinnerPowers;
  let page: PickupListPage;
  try {
    // Resolved BEFORE the list read, because its answer decides whether the
    // search term is sent at all — the same reasoning participations/page.tsx
    // gives for its own canSearchByListener. winnerPowers goes out beside it
    // for the same reason draws.execute does there: it decides nothing about
    // the read, only which buttons render, and both are single-predicate
    // fan-outs that cost one round trip together rather than two in
    // sequence.
    [canSearch, winnerPowers] = await Promise.all([
      canSearchPickupsByListener(supabase, selected.id),
      getWinnerPowers(supabase, selected.id),
    ]);

    const searchTerm = state.search;

    page = await listPickups(
      {
        companyId: selected.id,
        status: state.status === ANY_STATUS ? undefined : state.status,
        promotionId: state.promotionId,
        // Dropped rather than forwarded when this caller cannot search — the
        // alternative is exactly the empty list the note below exists to
        // prevent (list_pickups' own Rule 3 would answer nothing at all).
        search: canSearch ? searchTerm : undefined,
        cursor,
        cursorSide: cursorParam?.side ?? 'after',
      },
      accessToken,
    );
  } catch (cause) {
    logger.error({ err: cause, companyId: selected.id }, 'could not load the pickups list');
    return <LoadError message={describePickupsReadError(cause, await getTranslations('pickups'))} />;
  }

  // The promotion picker's options: ONE page of promotions by name, never the
  // whole Station — the same bound and the same reasoning
  // participations/page.tsx gives for its own promotion filter. A promotion
  // that will not load costs this screen a filter, not the list it came here
  // for, so its own failure is logged and swallowed rather than raised.
  let promotionOptions: PickupPromotionOption[] = [];
  let promotionsCapped = false;
  let promotionsError: string | null = null;
  try {
    const promotions = await listPromotionsPage({
      companyId: selected.id,
      sort: 'name',
      direction: 'asc',
      cursor: null,
      cursorSide: 'after',
    });
    promotionOptions = promotions.rows.map((promotion) => ({
      id: promotion.id,
      name: promotion.name,
    }));
    promotionsCapped = promotions.nextCursor !== null;
  } catch (cause) {
    logger.error(
      { err: cause, companyId: selected.id },
      'could not read the promotions for the pickups filter',
    );
    promotionsError = describePickupsReadError(cause, await getTranslations('pickups'), 'subjectThePromotionsInThisStation');
  }

  // A promotion filter pointing at something the picker did not offer — past
  // the cap, or a link from that promotion's own record — would otherwise
  // leave the control showing no selection at all, and the next change to any
  // other filter would silently drop the promotion the operator came here
  // for. Named off the rows already on this page when there is one to name it
  // from; when none of them belong to it, the option says what it is instead
  // of inventing a name.
  if (state.promotionId && !promotionOptions.some((p) => p.id === state.promotionId)) {
    promotionOptions.unshift({
      id: state.promotionId,
      name: page.rows.find((row) => row.promotionId === state.promotionId)?.promotionName
        ?? t('thePromotionThisListIsFilteredTo'),
    });
  }

  return (
    <>
      <PageHeader
        title={t('pickups')}
        description={t('pickupsDescription')}
        // Block 8b. The filters ALREADY on this screen, translated into the
        // report's vocabulary by list-filters.ts -- never a second set the
        // dialog asks for. The operator has expressed the question by
        // filtering; asking again in another vocabulary is how the file and
        // the screen come to disagree about what was exported.
        action={
          <ExportDialog
            reportType="WINNERS"
            companyIds={[selected.id]}
            filters={winnersReportFilters(state)}
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
            action="/pickups"
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
              href={stationSwitchHref('/pickups', company.id, stationSearch)}
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

      <PickupsFilters state={state} promotions={promotionOptions} canSearchByListener={canSearch} />

      {/*
        Unlike participations/page.tsx, there is no "showing only..." note
        here: this screen's default is ANY_STATUS — no narrowing at all — so
        there is nothing for a note to disclose about the default itself.
        Rendered only when one of the other two notes actually has something
        to say, so this wrapper is never an empty spacer on the screen's
        ordinary, unfiltered open.
      */}
      {(!canSearch || promotionsCapped || promotionsError) && (
        <div className="mt-3 flex flex-col gap-1.5">
          {!canSearch && (
            <p
              id={SEARCH_NOTE_ID}
              className="text-xs text-muted-foreground"
              data-testid="pickup-search-note"
            >
              {t('youCannotSearchByListenerAt')}{' '}
              {state.search
                ? t('yourSearchWasNotApplied', { term: state.search })
                : t('everyOtherFilterStillWorks')}
            </p>
          )}

          {promotionsCapped && (
            <p className="text-xs text-muted-foreground" data-testid="pickup-promotions-capped">
              {t('thePromotionPickerListsTheFirst')}</p>
          )}

          {promotionsError && (
            <p className="text-xs text-destructive" data-testid="pickup-promotions-error">
              {promotionsError}
            </p>
          )}
        </div>
      )}

      <PickupsGrid
        rows={page.rows}
        total={page.total}
        timeZone={selected.timezone}
        winnerPowers={winnerPowers}
        canFindListeners={canSearch}
        previousHref={
          page.previousCursor ? pickupsHref(state, { side: 'before', value: page.previousCursor }) : null
        }
        nextHref={page.nextCursor ? pickupsHref(state, { side: 'after', value: page.nextCursor }) : null}
        onWinnerAction={pickupWinnerAction}
        onReopen={reopenPickupAction}
      />
    </>
  );
}

async function NoStationMatch({ search }: { search: string }) {
  const t = await getTranslations('pickups');
  return (
    <>
      <PageHeader title={t('pickups')} />
      <Card>
        <CardContent className="flex flex-col gap-3 pt-6">
          <p className="text-sm text-muted-foreground">
            {t('noStationYouCanReachMatches', { search })}
          </p>
          <Link href="/pickups" className="text-sm text-primary underline underline-offset-2">
            {t('clearTheStationSearch')}</Link>
        </CardContent>
      </Card>
    </>
  );
}

async function LoadError({ message }: { message: string }) {
  const t = await getTranslations('pickups');
  return (
    <>
      <PageHeader title={t('pickups')} />
      <Card>
        <CardContent className="pt-6">
          <p className="text-sm text-destructive">{message}</p>
        </CardContent>
      </Card>
    </>
  );
}
