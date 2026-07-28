import Link from 'next/link';
import { redirect } from 'next/navigation';
import { createUserClient } from '@/lib/supabase/user-client';
import { logger } from '@/lib/logger';
import { PageHeader } from '@/components/layout/app-shell';
import { Card, CardContent } from '@/components/ui/card';
import { listPrizeCategories, listPrizes } from '@/services/inventory';
import type { PrizeCategorySummary, PrizeSummary } from '@/services/inventory';
import { listViewableCompanies } from './station-access';
import type { ViewableCompany } from './station-access';
import { describeInventoryReadError } from './actions';
import { InventoryBrowser } from './inventory-browser';

// Renders from the caller's session cookies and a live per-Station permission
// check, so it can never be static.
export const dynamic = 'force-dynamic';

export default async function InventoryPage({
  searchParams,
}: {
  searchParams: Promise<{ companyId?: string }>;
}) {
  const params = await searchParams;
  const supabase = await createUserClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  let viewable: ViewableCompany[];
  try {
    viewable = await listViewableCompanies(supabase);
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
  if (!first) redirect('/app');

  // Next's searchParams arrives already percent-decoded (same as every other
  // ?param=-style value in this codebase). A stale or tampered companyId that
  // is not in `viewable` — access revoked since the link was generated, or a
  // hand-edited URL — falls back to the first Station this caller can
  // actually view rather than erroring.
  const selected = viewable.find((c) => c.id === params.companyId) ?? first;

  let categories: PrizeCategorySummary[];
  let prizes: PrizeSummary[];
  try {
    [categories, prizes] = await Promise.all([
      listPrizeCategories(selected.id),
      listPrizes(selected.id),
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

      {viewable.length > 1 && (
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
        </div>
      )}

      <InventoryBrowser prizes={prizes} categories={categories} />
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
