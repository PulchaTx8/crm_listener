import { getTranslations } from 'next-intl/server';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { createUserClient } from '@/lib/supabase/user-client';
import { logger } from '@/lib/logger';
import { stationSwitchHref } from '@/lib/station-switch';
import { PageHeader } from '@/components/layout/app-shell';
import { Card, CardContent } from '@/components/ui/card';
import { decodeCursor } from '@/lib/keyset';
import { parseRecordParam, PRIZE_CATEGORY_TABS } from '@/lib/record-params';
import { listPrizeCategoriesPage, PRIZE_CATEGORY_SEARCH_MAX_LENGTH } from '@/services/inventory';
import type { PrizeCategoryListPage } from '@/services/inventory';
import {
  getInventoryPermissions,
  listCompanyAccess,
  STATION_SEARCH_MAX_LENGTH,
} from '../station-access';
import type { SuspendedCompany, ViewableCompany } from '../station-access';
import { StationSearchForm } from '../station-search-form';
import { CategoriesFilters } from './categories-filters';
import { CategoriesGrid } from './categories-grid';
import {
  parsePrizeCategoryCursor,
  parsePrizeCategoryListState,
  prizeCategoryHref,
} from './list-params';
import type { PrizeCategorySearchParams } from './list-params';

/**
 * Block 26. Prize categories, second under Inventory — directly below Stock,
 * because it is what a prize's first field points at.
 *
 * THE SCREEN IS `/inventory/vendors` WITH DIFFERENT COLUMNS, deliberately: the
 * same Station switcher, the same URL-driven filter bar, the same keyset paging
 * and the same record-as-a-modal. An operator who has registered a supplier
 * already knows how to register a category, and a second layout for the same job
 * would only be a second thing to maintain.
 *
 * IT REPLACES A BUTTON. Until this block a category was registered from a dialog
 * on the Stock screen, which could create one and nothing else: no list, no
 * rename, no way to retire one. A label an operator can only ever add is a label
 * that accumulates, and every one of them is a filter option on the screen next
 * door.
 *
 * THE PERMISSIONS ARE THE INVENTORY ONES: `inventory.view` to read and
 * `inventory.catalogue` to write — the pair that already governs prizes and
 * vendors. A `categories.*` pair would be a permissions migration plus every role
 * a customer has already configured, none of which would grant it. `0199` records
 * the same reasoning for vendors, and Block 18's §5 for /shows.
 */
export const dynamic = 'force-dynamic';

export default async function PrizeCategoriesPage({
  searchParams,
}: {
  searchParams: Promise<PrizeCategorySearchParams>;
}) {
  const t = await getTranslations('prizeCategories');
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
    ({ viewable, suspended, capped } = await listCompanyAccess(
      supabase,
      'inventory.view',
      stationSearch,
    ));
  } catch (cause) {
    logger.error({ err: cause }, 'could not resolve prize category access');
    return <LoadError message={t('couldNotReadTheCategories')} />;
  }

  const first = viewable[0];
  // A Station search matching nothing is not the same as holding inventory.view
  // nowhere: handled first, so the search can always be undone.
  if (!first && stationSearch) return <NoStationMatch search={stationSearch} />;
  if (!first) redirect('/app');

  const selected = viewable.find((c) => c.id === params.companyId) ?? first;
  const state = parsePrizeCategoryListState(params, selected.id);
  const cursorParam = parsePrizeCategoryCursor(params);

  let page: PrizeCategoryListPage;
  try {
    page = await listPrizeCategoriesPage({
      companyId: state.companyId,
      // The same bound the service enforces on its own argument, imported rather
      // than copied so a URL parameter cannot drift the two apart.
      search: state.search?.slice(0, PRIZE_CATEGORY_SEARCH_MAX_LENGTH),
      sort: state.sort,
      direction: state.direction,
      cursor: cursorParam ? decodeCursor(cursorParam.value) : null,
      cursorSide: cursorParam?.side ?? 'after',
    });
  } catch (cause) {
    logger.error({ err: cause, companyId: state.companyId }, 'could not read prize categories');
    return <LoadError message={t('couldNotReadTheCategories')} />;
  }

  // `inventory.catalogue` decides whether the register button and the row menu
  // appear. A courtesy rather than the boundary: save_prize_category and
  // archive_prize_category each re-check it against auth.uid() before writing.
  const permissions = await getInventoryPermissions(supabase, selected.id);

  return (
    <>
      <PageHeader title={t('categories')} description={t('categoriesDescription')} />

      {(capped || stationSearch) && (
        <div className="mb-4 flex flex-col gap-2">
          {capped && (
            <p className="text-xs text-muted-foreground">
              {t('showingOfTheStationsYouCanReach', { count: viewable.length + suspended.length })}
            </p>
          )}
          <StationSearchForm
            action="/inventory/categories"
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
              href={stationSwitchHref('/inventory/categories', company.id, stationSearch)}
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
          {/* A suspended Station stays visible so the UI can explain why access
              stopped, then fails has_permission unconditionally. Rendered disabled
              with the reason instead of silently vanishing. */}
          {suspended.map((company) => (
            <span
              key={company.id}
              title={t('suspendedNoDataIsAvailable')}
              className="rounded-full border border-dashed px-3 py-1 text-xs font-medium text-muted-foreground"
            >
              {company.name}
            </span>
          ))}
        </div>
      )}

      <CategoriesFilters state={state} />

      <CategoriesGrid
        initialRows={page.rows}
        initialTotal={page.total}
        state={state}
        previousHref={
          page.previousCursor
            ? prizeCategoryHref(state, { side: 'before', value: page.previousCursor })
            : null
        }
        nextHref={
          page.nextCursor
            ? prizeCategoryHref(state, { side: 'after', value: page.nextCursor })
            : null
        }
        manage={permissions.catalogue}
        initialRecord={parseRecordParam(
          params as Record<string, string | undefined>,
          PRIZE_CATEGORY_TABS,
        )}
      />
    </>
  );
}

async function NoStationMatch({ search }: { search: string }) {
  const t = await getTranslations('prizeCategories');
  return (
    <>
      <PageHeader title={t('categories')} />
      <Card>
        <CardContent className="flex flex-col gap-3 pt-6">
          <p className="text-sm text-muted-foreground">{t('noStationMatches', { search })}</p>
          <Link
            href="/inventory/categories"
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
  const t = await getTranslations('prizeCategories');
  return (
    <>
      <PageHeader title={t('categories')} />
      <Card>
        <CardContent className="pt-6">
          <p className="text-sm text-destructive">{message}</p>
        </CardContent>
      </Card>
    </>
  );
}
