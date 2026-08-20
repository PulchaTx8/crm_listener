import { getTranslations } from 'next-intl/server';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { createUserClient } from '@/lib/supabase/user-client';
import { logger } from '@/lib/logger';
import { stationSwitchHref } from '@/lib/station-switch';
import { PageHeader } from '@/components/layout/app-shell';
import { Card, CardContent } from '@/components/ui/card';
import { decodeCursor } from '@/lib/keyset';
import { parseRecordParam, PROMOTION_TABS } from '@/lib/record-params';
import { listPromotionsPage, PROMOTION_SEARCH_MAX_LENGTH } from '@/services/promotions';
import type { PromotionListPage } from '@/services/promotions';
import { listShowOptions } from '@/services/shows';
import type { ShowOption } from '@/services/shows';
import { listCompanyAccess, STATION_SEARCH_MAX_LENGTH } from '../inventory/station-access';
import type { SuspendedCompany, ViewableCompany } from '../inventory/station-access';
import { StationSearchForm } from '../inventory/station-search-form';
import { getPromotionPowers } from './access';
import type { PromotionPowers } from './access';
import { describePromotionsReadError } from './errors';
import { promotionsHref, parsePromotionCursor, parsePromotionListState } from './list-params';
import type { PromotionSearchParams } from './list-params';
import { PromotionsFilters } from './promotions-filters';
import { PromotionsGrid } from './promotions-grid';

// Renders from the caller's session cookies and a live per-Station permission
// check, so it can never be static.
export const dynamic = 'force-dynamic';

export default async function PromotionsPage({
  searchParams,
}: {
  searchParams: Promise<PromotionSearchParams>;
}) {
  const t = await getTranslations('promotions');
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
    ({ viewable, suspended, capped } = await listCompanyAccess(
      supabase,
      'promotions.view',
      stationSearch,
    ));
  } catch (cause) {
    logger.error({ err: cause }, 'could not resolve promotions access');
    return <LoadError message={describePromotionsReadError(cause, await getTranslations('promotions'))} />;
  }

  const first = viewable[0];

  // A Station search that matches nothing leaves this caller with no Station to
  // show, which is not the same as holding promotions.view nowhere: the
  // redirect below would throw them off the screen with no way to clear the
  // search. Handled before it, so the search can always be undone.
  if (!first && stationSearch) return <NoStationMatch search={stationSearch} />;
  // A courtesy, not the boundary: every RPC re-checks has_permission itself,
  // and 0044's policies already filter to exactly the Stations resolved above.
  if (!first) redirect('/app');

  // A stale or tampered companyId that is not in `viewable` — access revoked
  // since the link was generated, or a hand-edited URL — falls back to the
  // first Station this caller can actually view rather than erroring.
  const selected = viewable.find((c) => c.id === params.companyId) ?? first;

  const state = parsePromotionListState(params, selected.id);
  const cursorParam = parsePromotionCursor(params);
  // An unreadable cursor means "start from the beginning", never an error page.
  const cursor = decodeCursor(cursorParam?.value);

  let powers: PromotionPowers;
  let page: PromotionListPage;
  let shows: ShowOption[];
  try {
    powers = await getPromotionPowers(supabase, selected.id);

    page = await listPromotionsPage({
      companyId: selected.id,
      // The same bound the service enforces on its own argument, imported
      // rather than copied so a URL parameter cannot drift the two apart.
      search: state.search?.slice(0, PROMOTION_SEARCH_MAX_LENGTH),
      situation: state.situation,
      startsFrom: state.startsFrom,
      startsTo: state.startsTo,
      // Asked for only when this caller can actually be shown one. For anybody
      // else the flag is a no-op in the service too, but not sending it keeps
      // the query and the checkbox saying the same thing.
      includeArchived: state.includeArchived && powers.seesArchived,
      sort: state.sort,
      direction: state.direction,
      cursor,
      cursorSide: cursorParam?.side ?? 'after',
    });

    // Item 17's combobox. Read here, off the same Station already resolved
    // above, and handed down through PromotionsGrid to both the record dialog
    // and the register form — neither re-resolves a Station of its own for it.
    shows = await listShowOptions(selected.id);
  } catch (cause) {
    logger.error({ err: cause, companyId: selected.id }, 'could not load the promotions list');
    return <LoadError message={describePromotionsReadError(cause, await getTranslations('promotions'))} />;
  }

  return (
    <>
      <PageHeader
        title={t('promotions')}
        description={t('promotionsDescription')}
      />

      {(capped || stationSearch) && (
        <div className="mb-4 flex flex-col gap-2">
          {capped && (
            <p className="text-xs text-muted-foreground">
              {t('showing')}{' '}{viewable.length + suspended.length} {t('ofTheStationsYouCanReach')}</p>
          )}
          <StationSearchForm
            action="/promotions"
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
              href={stationSwitchHref('/promotions', company.id, stationSearch)}
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

      <PromotionsFilters
        state={state}
        timeZone={selected.timezone}
        canSeeArchived={powers.seesArchived}
      />

      <PromotionsGrid
        initialRows={page.rows}
        initialTotal={page.total}
        state={state}
        timeZone={selected.timezone}
        shows={shows}
        previousHref={
          page.previousCursor
            ? promotionsHref(state, { side: 'before', value: page.previousCursor })
            : null
        }
        nextHref={
          page.nextCursor ? promotionsHref(state, { side: 'after', value: page.nextCursor }) : null
        }
        powers={powers}
        initialRecord={parseRecordParam(
          params as Record<string, string | undefined>,
          PROMOTION_TABS,
        )}
      />
    </>
  );
}

async function NoStationMatch({ search }: { search: string }) {
  const t = await getTranslations('promotions');
  return (
    <>
      <PageHeader title={t('promotions')} />
      <Card>
        <CardContent className="flex flex-col gap-3 pt-6">
          <p className="text-sm text-muted-foreground">
            {t('noStationYouCanReachMatches', { search })}
          </p>
          <Link href="/promotions" className="text-sm text-primary underline underline-offset-2">
            {t('clearTheStationSearch')}</Link>
        </CardContent>
      </Card>
    </>
  );
}

async function LoadError({ message }: { message: string }) {
  const t = await getTranslations('promotions');
  return (
    <>
      <PageHeader title={t('promotions')} />
      <Card>
        <CardContent className="pt-6">
          <p className="text-sm text-destructive">{message}</p>
        </CardContent>
      </Card>
    </>
  );
}
