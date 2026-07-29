import Link from 'next/link';
import { redirect } from 'next/navigation';
import { createUserClient } from '@/lib/supabase/user-client';
import { logger } from '@/lib/logger';
import { PageHeader } from '@/components/layout/app-shell';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { decodeCursor } from '@/lib/keyset';
import {
  PageControls,
  SortLink,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { listPrizeCategories, listPrizesPage, PRIZE_SEARCH_MAX_LENGTH } from '@/services/inventory';
import { STATION_SEARCH_MAX_LENGTH } from './station-access';
import { StationSearchForm } from './station-search-form';
import type { PrizeCategorySummary, PrizeListPage } from '@/services/inventory';
import { getInventoryPermissions, listCompanyAccess } from './station-access';
import type { InventoryPermissions, SuspendedCompany, ViewableCompany } from './station-access';
import { describeInventoryReadError } from './errors';
import { formatDate, physicalTotal } from './format';
import { InventoryFilters } from './inventory-filters';
import {
  hasActiveInventoryFilters,
  inventoryHref,
  inventorySortHref,
  parseInventoryCursor,
  parseInventoryListState,
} from './list-params';
import type { InventorySearchParams } from './list-params';
import { CategoryForm } from './category-form';
import { PrizeForm } from './prize-form';
import { ReconciliationPanel } from './reconciliation-panel';

// Renders from the caller's session cookies and a live per-Station permission
// check, so it can never be static.
export const dynamic = 'force-dynamic';

/** How many columns the empty-state row has to span. */
const COLUMN_COUNT = 11;

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

  const categoryNameById = new Map(categories.map((c) => [c.id, c.name]));
  const nameSorted = state.sort === 'name';
  const addedSorted = state.sort === 'created';
  const ariaSort = (sorted: boolean) =>
    sorted ? (state.direction === 'asc' ? 'ascending' : 'descending') : 'none';

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

      {/* Rendered only as a courtesy — see getInventoryPermissions'
          (station-access.ts) own comment for why this is not the boundary.
          create_prize_category and create_prize both re-check
          inventory.catalogue themselves before writing anything, so hiding
          these forms from someone who lacks it is convenience, not the
          refusal itself. */}
      {permissions.catalogue && (
        <div className="mb-6 grid gap-6 md:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle>Register a category</CardTitle>
            </CardHeader>
            <CardContent>
              <CategoryForm companyId={selected.id} />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Register a prize</CardTitle>
            </CardHeader>
            <CardContent>
              <PrizeForm companyId={selected.id} categories={categories} />
            </CardContent>
          </Card>
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

      <div className="mt-4 rounded-lg border">
        <Table>
          {/* Said once, where the numbers are read: BalanceStats carries the
              same sentence inline on the detail screen, and a column header
              has no room for it. */}
          <caption className="px-3 py-2 text-left text-xs text-muted-foreground">
            Delivered is a cumulative counter and sits outside physical stock, as does written
            off, which this table leaves to each prize&apos;s own screen.
          </caption>
          <TableHeader>
            <TableRow>
              <TableHead aria-sort={ariaSort(nameSorted)}>
                <SortLink
                  href={inventorySortHref(state, 'name')}
                  active={nameSorted}
                  direction={nameSorted ? state.direction : 'asc'}
                >
                  Prize
                </SortLink>
              </TableHead>
              <TableHead>Code</TableHead>
              <TableHead>Category</TableHead>
              <TableHead aria-sort={ariaSort(addedSorted)}>
                <SortLink
                  href={inventorySortHref(state, 'created')}
                  active={addedSorted}
                  direction={addedSorted ? state.direction : 'desc'}
                >
                  Added
                </SortLink>
              </TableHead>
              <TableHead className="text-right">In stock</TableHead>
              <TableHead className="text-right">Available</TableHead>
              <TableHead className="text-right">Reserved</TableHead>
              <TableHead className="text-right">Linked</TableHead>
              <TableHead className="text-right">Awaiting pickup</TableHead>
              <TableHead className="text-right">Pending return</TableHead>
              <TableHead className="text-right">Delivered</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {page.rows.length === 0 ? (
              <TableRow>
                {/* Two different facts, kept apart: the Station has no
                    catalogue yet, and nothing matches what was asked for. */}
                <TableCell colSpan={COLUMN_COUNT} className="text-sm text-muted-foreground">
                  {hasActiveInventoryFilters(state)
                    ? 'No prize matches these filters.'
                    : 'No prizes are registered in this Station yet.'}
                </TableCell>
              </TableRow>
            ) : (
              page.rows.map((prize) => (
                <TableRow key={prize.id} data-testid="prize-row">
                  <TableCell className="font-medium">
                    <Link
                      href={`/inventory/${prize.id}`}
                      className="ring-offset-background hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                    >
                      {prize.name}
                    </Link>
                  </TableCell>
                  <TableCell>{prize.internalCode ?? '—'}</TableCell>
                  <TableCell>
                    {categoryNameById.get(prize.categoryId ?? '') ?? 'Uncategorised'}
                  </TableCell>
                  <TableCell>{formatDate(prize.createdAt)}</TableCell>
                  <TableCell className="text-right font-semibold">
                    {physicalTotal(prize.balance)}
                  </TableCell>
                  <TableCell className="text-right">{prize.balance.available}</TableCell>
                  <TableCell className="text-right">{prize.balance.reserved}</TableCell>
                  <TableCell className="text-right">{prize.balance.linked}</TableCell>
                  <TableCell className="text-right">{prize.balance.awaitingPickup}</TableCell>
                  <TableCell className="text-right">{prize.balance.pendingReturn}</TableCell>
                  <TableCell className="text-right">{prize.balance.delivered}</TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>

        <PageControls
          total={page.total}
          label={page.total === 1 ? 'prize' : 'prizes'}
          previousHref={
            page.previousCursor
              ? inventoryHref(state, { side: 'before', value: page.previousCursor })
              : null
          }
          nextHref={
            page.nextCursor ? inventoryHref(state, { side: 'after', value: page.nextCursor }) : null
          }
        />
      </div>
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
