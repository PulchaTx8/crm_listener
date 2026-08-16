import { getTranslations } from 'next-intl/server';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { createUserClient } from '@/lib/supabase/user-client';
import { logger } from '@/lib/logger';
import { stationSwitchHref } from '@/lib/station-switch';
import { PageHeader } from '@/components/layout/app-shell';
import { Card, CardContent } from '@/components/ui/card';
import { decodeCursor } from '@/lib/keyset';
import { parseRecordParam, VENDOR_TABS } from '@/lib/record-params';
import {
  listVendorCities,
  listVendorsPage,
  VENDOR_SEARCH_MAX_LENGTH,
} from '@/services/vendors';
import type { VendorListPage } from '@/services/vendors';
import {
  getInventoryPermissions,
  listCompanyAccess,
  STATION_SEARCH_MAX_LENGTH,
} from '../station-access';
import type { SuspendedCompany, ViewableCompany } from '../station-access';
import { StationSearchForm } from '../station-search-form';
import { VendorsFilters } from './vendors-filters';
import { VendorsGrid } from './vendors-grid';
import { parseVendorCursor, parseVendorListState, vendorHref } from './list-params';
import type { VendorSearchParams } from './list-params';

/**
 * Block 24, item 7. Prize suppliers, third under Inventory after Stock and
 * Movements.
 *
 * THE SCREEN IS `/shows` WITH DIFFERENT COLUMNS, deliberately: the same Station
 * switcher, the same URL-driven filter bar, the same keyset paging and the same
 * record-as-a-modal. An operator who has registered a programme already knows how
 * to register a supplier, and a second layout for the same job would only be a
 * second thing to maintain.
 *
 * THE PERMISSIONS ARE THE INVENTORY ONES, and that is recorded rather than
 * accidental: `inventory.view` to read and `inventory.catalogue` to write — the
 * pair that already governs prizes and categories, which is what a vendor sits
 * beside. A `vendors.*` pair is not two rows in a table; it is a permissions
 * migration, the roles screen, every seeded role, PERMISSIONS.md and EVERY ROLE
 * A CUSTOMER HAS ALREADY CONFIGURED, none of which would grant it. Shipping this
 * screen behind a permission nobody holds would hide it from everyone. The
 * design spec's D6 carries the full reasoning, and Block 18's §5 made the same
 * argument for /shows.
 */
export const dynamic = 'force-dynamic';

export default async function VendorsPage({
  searchParams,
}: {
  searchParams: Promise<VendorSearchParams>;
}) {
  const t = await getTranslations('vendors');
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
    logger.error({ err: cause }, 'could not resolve vendor access');
    return <LoadError message={t('couldNotReadTheVendors')} />;
  }

  const first = viewable[0];
  // A Station search matching nothing is not the same as holding inventory.view
  // nowhere: handled first, so the search can always be undone.
  if (!first && stationSearch) return <NoStationMatch search={stationSearch} />;
  if (!first) redirect('/app');

  const selected = viewable.find((c) => c.id === params.companyId) ?? first;
  const state = parseVendorListState(params, selected.id);
  const cursorParam = parseVendorCursor(params);

  let page: VendorListPage;
  let cities: string[];
  try {
    [page, cities] = await Promise.all([
      listVendorsPage({
        companyId: state.companyId,
        search: state.search?.slice(0, VENDOR_SEARCH_MAX_LENGTH),
        city: state.city,
        sort: state.sort,
        direction: state.direction,
        cursor: cursorParam ? decodeCursor(cursorParam.value) : null,
        cursorSide: cursorParam?.side ?? 'after',
      }),
      listVendorCities(state.companyId),
    ]);
  } catch (cause) {
    logger.error({ err: cause, companyId: state.companyId }, 'could not read vendors');
    return <LoadError message={t('couldNotReadTheVendors')} />;
  }

  // `inventory.catalogue` decides whether the register button and the row menu
  // appear. A courtesy rather than the boundary: save_vendor and archive_vendor
  // each re-check it against auth.uid() before writing anything.
  const permissions = await getInventoryPermissions(supabase, selected.id);

  return (
    <>
      <PageHeader title={t('vendors')} description={t('vendorsDescription')} />

      {(capped || stationSearch) && (
        <div className="mb-4 flex flex-col gap-2">
          {capped && (
            <p className="text-xs text-muted-foreground">
              {t('showingOfTheStationsYouCanReach', { count: viewable.length + suspended.length })}
            </p>
          )}
          <StationSearchForm
            action="/inventory/vendors"
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
              href={stationSwitchHref('/inventory/vendors', company.id, stationSearch)}
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
              stopped, then fails has_permission unconditionally. Rendered
              disabled with the reason instead of silently vanishing. */}
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

      <VendorsFilters state={state} cities={cities} />

      <VendorsGrid
        initialRows={page.rows}
        initialTotal={page.total}
        state={state}
        previousHref={
          page.previousCursor
            ? vendorHref(state, { side: 'before', value: page.previousCursor })
            : null
        }
        nextHref={page.nextCursor ? vendorHref(state, { side: 'after', value: page.nextCursor }) : null}
        manage={permissions.catalogue}
        initialRecord={parseRecordParam(params as Record<string, string | undefined>, VENDOR_TABS)}
      />
    </>
  );
}

async function NoStationMatch({ search }: { search: string }) {
  const t = await getTranslations('vendors');
  return (
    <>
      <PageHeader title={t('vendors')} />
      <Card>
        <CardContent className="flex flex-col gap-3 pt-6">
          <p className="text-sm text-muted-foreground">{t('noStationMatches', { search })}</p>
          <Link
            href="/inventory/vendors"
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
  const t = await getTranslations('vendors');
  return (
    <>
      <PageHeader title={t('vendors')} />
      <Card>
        <CardContent className="pt-6">
          <p className="text-sm text-destructive">{message}</p>
        </CardContent>
      </Card>
    </>
  );
}
