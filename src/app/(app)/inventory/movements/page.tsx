import { getTranslations } from 'next-intl/server';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { createUserClient } from '@/lib/supabase/user-client';
import { logger } from '@/lib/logger';
import { stationSwitchHref } from '@/lib/station-switch';
import { PageHeader } from '@/components/layout/app-shell';
import { Card, CardContent } from '@/components/ui/card';
import { decodeCursor } from '@/lib/keyset';
import { listMovements } from '@/services/movements';
import type { MovementListPage } from '@/services/movements';
import { listPrizesPage } from '@/services/inventory';
import { listPromotionsPage } from '@/services/promotions';
import { listCompanyAccess, STATION_SEARCH_MAX_LENGTH } from '../station-access';
import type { SuspendedCompany, ViewableCompany } from '../station-access';
import { StationSearchForm } from '../station-search-form';
import { describeMovementsReadError } from './errors';
import {
  movementsHref,
  parseMovementCursor,
  parseMovementListState,
} from './list-params';
import type { MovementSearchParams } from './list-params';
import { MovementsFilters } from './movements-filters';
import type { MovementPrizeOption, MovementPromotionOption } from './movements-filters';
import { MovementsGrid } from './movements-grid';
import { ExportDialog } from '@/components/reports/export-dialog';
import { movementsReportFilters } from '@/lib/reports/list-filters';

// Renders from the caller's session cookies and a live per-Station permission
// check, so it can never be static.
export const dynamic = 'force-dynamic';

export default async function MovementsPage({
  searchParams,
}: {
  searchParams: Promise<MovementSearchParams>;
}) {
  const t = await getTranslations('inventory');
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
    // inventory.view: the same permission list_movements (0096) itself gates
    // on — this screen is the Station's whole ledger, not a per-prize one, so
    // it asks the same question inventory/page.tsx already asks for the
    // catalogue beside it.
    ({ viewable, suspended, capped } = await listCompanyAccess(
      supabase,
      'inventory.view',
      stationSearch,
    ));
  } catch (cause) {
    logger.error({ err: cause }, 'could not resolve movements access');
    return <LoadError message={describeMovementsReadError(cause, t)} />;
  }

  const first = viewable[0];

  // A Station search that matches nothing leaves this caller with no Station
  // to show, which is not the same as holding inventory.view nowhere — the
  // redirect below would throw them off the screen with no way to clear the
  // search. Handled before it, so the search can always be undone (the same
  // ordering pickups/page.tsx and inventory/page.tsx both keep for their own).
  if (!first && stationSearch) return <NoStationMatch search={stationSearch} />;
  // A courtesy, not the boundary: list_movements re-checks inventory.view itself.
  if (!first) redirect('/app');

  // A stale or tampered companyId that is not in `viewable` falls back to the
  // first Station this caller can actually view rather than erroring.
  const selected = viewable.find((c) => c.id === params.companyId) ?? first;

  const state = parseMovementListState(params, selected.id);
  const cursorParam = parseMovementCursor(params);
  // A bad cursor starts the list over rather than erroring — decodeCursor
  // (@/lib/keyset) returns null for it, the same contract every keyset screen
  // in this codebase shares.
  const cursor = decodeCursor(cursorParam?.value);

  // Read here rather than inside the try below, because `redirect` works by
  // throwing and a catch would swallow it.
  const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
  if (sessionError || !sessionData.session) redirect('/login');
  const accessToken = sessionData.session.access_token;

  let page: MovementListPage;
  try {
    page = await listMovements(
      {
        companyId: selected.id,
        type: state.type,
        prizeId: state.prizeId,
        promotionId: state.promotionId,
        from: state.from,
        to: state.to,
        cursor,
        cursorSide: cursorParam?.side ?? 'after',
      },
      accessToken,
    );
  } catch (cause) {
    logger.error({ err: cause, companyId: selected.id }, 'could not load the movements list');
    return <LoadError message={describeMovementsReadError(cause, t)} />;
  }

  // The prize picker's options: ONE page of prizes by name, never the whole
  // catalogue — the same bound and the same reasoning pickups/page.tsx gives
  // for its own promotion filter. A prize list that will not load costs this
  // screen a filter, not the ledger it came here for, so its own failure is
  // logged and swallowed rather than raised.
  let prizeOptions: MovementPrizeOption[] = [];
  let prizesCapped = false;
  let prizesError: string | null = null;
  try {
    const prizes = await listPrizesPage({
      companyId: selected.id,
      sort: 'name',
      direction: 'asc',
      cursor: null,
      cursorSide: 'after',
    });
    prizeOptions = prizes.rows.map((prize) => ({ id: prize.id, name: prize.name }));
    prizesCapped = prizes.nextCursor !== null;
  } catch (cause) {
    logger.error(
      { err: cause, companyId: selected.id },
      'could not read the prizes for the movements filter',
    );
    prizesError = describeMovementsReadError(cause, t, 'thePrizesInThisStation');
  }

  // A prize filter pointing at something the picker did not offer — past the
  // cap, or a link from that prize's own record — would otherwise leave the
  // control showing no selection at all, and the next change to any other
  // filter would silently drop the prize the operator came here for. Named
  // off the rows already on this page when there is one to name it from; when
  // none of them belong to it, the option says what it is instead of
  // inventing a name — the same reasoning pickups/page.tsx gives for its own
  // promotion picker.
  if (state.prizeId && !prizeOptions.some((p) => p.id === state.prizeId)) {
    prizeOptions.unshift({
      id: state.prizeId,
      name:
        page.rows.find((row) => row.prizeId === state.prizeId)?.prizeName ??
        t('thePrizeThisListIsFilteredTo'),
    });
  }

  // The promotion picker's options, the same shape and the same reasoning as
  // the prize picker just above.
  let promotionOptions: MovementPromotionOption[] = [];
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
      'could not read the promotions for the movements filter',
    );
    promotionsError = describeMovementsReadError(cause, t, 'thePromotionsInThisStation');
  }

  if (state.promotionId && !promotionOptions.some((p) => p.id === state.promotionId)) {
    promotionOptions.unshift({
      id: state.promotionId,
      name:
        page.rows.find((row) => row.promotionId === state.promotionId)?.promotionName ??
        t('thePromotionThisListIsFilteredTo'),
    });
  }

  return (
    <>
      <PageHeader
        title={t('movements')}
        description={t('movementsDescription')}
        // Block 8b. The filters ALREADY on this screen, translated into the
        // report's vocabulary by list-filters.ts -- never a second set the
        // dialog asks for. The operator has expressed the question by
        // filtering; asking again in another vocabulary is how the file and
        // the screen come to disagree about what was exported.
        action={
          <ExportDialog
            reportType="MOVEMENTS"
            companyIds={[selected.id]}
            filters={movementsReportFilters(state)}
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
            action="/inventory/movements"
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
              href={stationSwitchHref('/inventory/movements', company.id, stationSearch)}
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

      <MovementsFilters
        state={state}
        prizes={prizeOptions}
        promotions={promotionOptions}
        timeZone={selected.timezone}
      />

      {(prizesCapped || prizesError || promotionsCapped || promotionsError) && (
        <div className="mt-3 flex flex-col gap-1.5">
          {prizesCapped && (
            <p className="text-xs text-muted-foreground" data-testid="movement-prizes-capped">
              {t('thePrizePickerListsTheFirst')}</p>
          )}

          {prizesError && (
            <p className="text-xs text-destructive" data-testid="movement-prizes-error">
              {prizesError}
            </p>
          )}

          {promotionsCapped && (
            <p className="text-xs text-muted-foreground" data-testid="movement-promotions-capped">
              {t('thePromotionPickerListsTheFirst')}</p>
          )}

          {promotionsError && (
            <p className="text-xs text-destructive" data-testid="movement-promotions-error">
              {promotionsError}
            </p>
          )}
        </div>
      )}

      <MovementsGrid
        rows={page.rows}
        total={page.total}
        timeZone={selected.timezone}
        previousHref={
          page.previousCursor
            ? movementsHref(state, { side: 'before', value: page.previousCursor })
            : null
        }
        nextHref={
          page.nextCursor ? movementsHref(state, { side: 'after', value: page.nextCursor }) : null
        }
      />
    </>
  );
}

async function NoStationMatch({ search }: { search: string }) {
  const t = await getTranslations('inventory');
  return (
    <>
      <PageHeader title={t('movements')} />
      <Card>
        <CardContent className="flex flex-col gap-3 pt-6">
          <p className="text-sm text-muted-foreground">
            {t('noStationYouCanReachMatches', { search })}
          </p>
          <Link href="/inventory/movements" className="text-sm text-primary underline underline-offset-2">
            {t('clearTheStationSearch')}</Link>
        </CardContent>
      </Card>
    </>
  );
}

async function LoadError({ message }: { message: string }) {
  const t = await getTranslations('inventory');
  return (
    <>
      <PageHeader title={t('movements')} />
      <Card>
        <CardContent className="pt-6">
          <p className="text-sm text-destructive">{message}</p>
        </CardContent>
      </Card>
    </>
  );
}
