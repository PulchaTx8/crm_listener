import Link from 'next/link';
import { redirect } from 'next/navigation';
import { createUserClient } from '@/lib/supabase/user-client';
import { logger } from '@/lib/logger';
import { PageHeader } from '@/components/layout/app-shell';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { decodeCursor } from '@/lib/keyset';
import { listPrizeCategories, listPrizesPage, PRIZE_SEARCH_MAX_LENGTH } from '@/services/inventory';
import { STATION_SEARCH_MAX_LENGTH } from './station-access';
import { StationSearchForm } from './station-search-form';
import type { PrizeCategorySummary, PrizeListPage } from '@/services/inventory';
import { getInventoryPermissions, listCompanyAccess } from './station-access';
import type { InventoryPermissions, SuspendedCompany, ViewableCompany } from './station-access';
import { describeInventoryReadError } from './errors';
import { InventoryFilters } from './inventory-filters';
import { InventoryGrid } from './inventory-grid';
import { PRIZE_TABS } from './prize-record-dialog';
import { parseRecordParam } from '@/lib/record-params';
import { inventoryHref, parseInventoryCursor, parseInventoryListState } from './list-params';
import type { InventorySearchParams } from './list-params';
import { ReconciliationPanel } from './reconciliation-panel';

// Renders from the caller's session cookies and a live per-Station permission
// check, so it can never be static.
export const dynamic = 'force-dynamic';

export default async function InventoryPage({
  searchParams,
}: {
  searchParams: Promise<InventorySearchParams>;
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
    ({ viewable, suspended, capped } = await listCompanyAccess(
      supabase,
      'inventory.view',
      stationSearch,
    ));
  } catch (cause) {
    logger.error({ err: cause }, 'could not resolve inventory access');
    return <LoadError message={describeInventoryReadError(cause)} />;
  }

  const first = viewable[0];

  // A courtesy, not the boundary: record_stock_entry, record_stock_exit,
  // adjust_stock, reserve_stock, release_reservation and reconcile_inventory
  // (0027/0028) each re-check has_permission themselves before writing or
  // reading anything, and prizes/inventory_balances/inventory_movements' own
  // select policies (0029) already filter to exactly the Stations
  // listViewableCompanies just resolved. This redirect only saves someone
  // holding inventory.view nowhere a trip to a screen that would otherwise
  // have nothing to show — indistinguishable, if rendered instead of
  // redirected, from a Station with no prizes in it.
  // A Station search that matches nothing leaves this caller with no Station
  // to show, which is not the same as holding inventory.view nowhere: the
  // redirect above would throw them off the screen with no way to clear the
  // search. Handled before it, so the search can always be undone.
  if (!first && stationSearch) return <NoStationMatch search={stationSearch} />;
  if (!first) redirect('/app');

  // Next's searchParams arrives already percent-decoded (same as every other
  // ?param=-style value in this codebase). A stale or tampered companyId that
  // is not in `viewable` — access revoked since the link was generated, or a
  // hand-edited URL — falls back to the first Station this caller can
  // actually view rather than erroring.
  const selected = viewable.find((c) => c.id === params.companyId) ?? first;

  const state = parseInventoryListState(params, selected.id);
  const cursorParam = parseInventoryCursor(params);
  // An unreadable cursor means "start from the beginning", never an error page.
  const cursor = decodeCursor(cursorParam?.value);

  let categories: PrizeCategorySummary[];
  let page: PrizeListPage;
  let permissions: InventoryPermissions;
  try {
    [categories, page, permissions] = await Promise.all([
      listPrizeCategories(selected.id),
      listPrizesPage({
        companyId: selected.id,
        // The same bound the service enforces on its own argument, imported
        // rather than copied so a URL parameter cannot drift the two apart.
        search: state.search?.slice(0, PRIZE_SEARCH_MAX_LENGTH),
        categoryId: state.categoryId,
        sort: state.sort,
        direction: state.direction,
        cursor,
        cursorSide: cursorParam?.side ?? 'after',
      }),
      getInventoryPermissions(supabase, selected.id),
    ]);
  } catch (cause) {
    logger.error({ err: cause, companyId: selected.id }, 'could not load the inventory list');
    return <LoadError message={describeInventoryReadError(cause)} />;
  }

  return (
    <>
      <PageHeader
        title="Inventory"
        description="Every prize in the Station, with its balance broken out by bucket."
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
            action="/inventory"
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
              href={{ pathname: '/inventory', query: { companyId: company.id } }}
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
          {/* A suspended Station passes the Company visibility policy — which
              deliberately keeps suspended Companies visible so the UI can
              explain why access stopped (the same reasoning /app's own
              Station cards carry) — then fails has_permission unconditionally
              (has_company_access requires status = 'active'). Rendered here,
              disabled, with the reason, instead of silently vanishing from the
              switcher with no explanation. */}
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

      <Card className="mb-6">
        <CardHeader>
          <CardTitle>Reconciliation</CardTitle>
        </CardHeader>
        <CardContent>
          <ReconciliationPanel companyId={selected.id} />
        </CardContent>
      </Card>

      <InventoryFilters state={state} categories={categories} />

      <InventoryGrid
        initialRows={page.rows}
        initialTotal={page.total}
        state={state}
        previousHref={
          page.previousCursor
            ? inventoryHref(state, { side: 'before', value: page.previousCursor })
            : null
        }
        nextHref={
          page.nextCursor ? inventoryHref(state, { side: 'after', value: page.nextCursor }) : null
        }
        categories={categories}
        powers={permissions}
        initialRecord={parseRecordParam(params as Record<string, string | undefined>, PRIZE_TABS)}
      />
    </>
  );
}

function NoStationMatch({ search }: { search: string }) {
  return (
    <>
      <PageHeader title="Inventory" />
      <Card>
        <CardContent className="flex flex-col gap-3 pt-6">
          <p className="text-sm text-muted-foreground">
            No Station you can reach matches “{search}”.
          </p>
          <Link href="/inventory" className="text-sm text-primary underline underline-offset-2">
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
      <PageHeader title="Inventory" />
      <Card>
        <CardContent className="pt-6">
          <p className="text-sm text-destructive">{message}</p>
        </CardContent>
      </Card>
    </>
  );
}
