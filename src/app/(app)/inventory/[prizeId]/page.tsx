import Link from 'next/link';
import { redirect } from 'next/navigation';
import { createUserClient } from '@/lib/supabase/user-client';
import { logger } from '@/lib/logger';
import { PageHeader } from '@/components/layout/app-shell';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { getPrizeById, getPrizeMovements, listPrizeCategories } from '@/services/inventory';
import type { MovementEntry, PrizeCategorySummary, PrizeSummary } from '@/services/inventory';
import { getInventoryPermissions } from '../station-access';
import type { InventoryPermissions } from '../station-access';
import { describeInventoryReadError } from '../errors';
import { BalanceStats } from '../balance-stats';
import { formatBucket, formatDateTime, MOVEMENT_TYPE_LABELS } from '../format';
import { StockEntryForm } from '../stock-entry-form';
import { StockExitForm } from '../stock-exit-form';
import { AdjustmentForm } from '../adjustment-form';
import { ReleaseForm, ReserveForm } from '../reservation-forms';

// Renders from the caller's session cookies and a live per-Station permission
// check, so it can never be static.
export const dynamic = 'force-dynamic';

export default async function PrizeDetailPage({
  params,
}: {
  params: Promise<{ prizeId: string }>;
}) {
  const { prizeId } = await params;
  const supabase = await createUserClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  // Unlike /inventory, there is no separate has_permission check + redirect
  // gate here. A prize belongs to exactly one Company, and
  // prizes_select_inventory_view (0029) already filters ANY select on
  // `prizes` to a caller who holds inventory.view in that prize's Company —
  // so reading it at all already is the gate, not a courtesy in front of one.
  //
  // Until Block 3b this searched every Station the caller could view, calling
  // the list service once per Station and comparing ids: a 100,000-row scan to
  // open one card, and bounded only by a Station cap that could itself hide a
  // real prize. The read below asks the database for the one row instead.
  let found: { companyId: string; prize: PrizeSummary } | null;
  try {
    found = await getPrizeById(prizeId);
  } catch (cause) {
    logger.error({ err: cause, prizeId }, 'could not read the prize');
    return <LoadError message={describeInventoryReadError(cause)} />;
  }

  // Collapses two different facts — the prize was deleted, or it exists in a
  // Station this caller does not hold inventory.view in — into one honest
  // message. That is the safer default: it does not confirm to someone who
  // cannot see the prize that the id is real. There is no longer a third
  // fact to disclose: nothing here is capped, so "we did not look everywhere"
  // has stopped being a possible reason for landing on this page.
  if (!found) return <NotFound />;

  const { companyId, prize } = found;

  let categories: PrizeCategorySummary[];
  let movements: MovementEntry[];
  let permissions: InventoryPermissions;
  try {
    [categories, movements, permissions] = await Promise.all([
      listPrizeCategories(companyId),
      getPrizeMovements(companyId, prizeId),
      getInventoryPermissions(supabase, companyId),
    ]);
  } catch (cause) {
    logger.error({ err: cause, prizeId }, 'could not load the movement history');
    return <LoadError message={describeInventoryReadError(cause)} />;
  }

  const categoryName = categories.find((c) => c.id === prize.categoryId)?.name ?? 'Uncategorised';

  // "Who" — actor_id names a row in profiles, and shares_organization_with
  // (0020) lets anyone in the same Organization read it, the same join
  // team/page.tsx already does for its own member list. Kept separate from
  // the movements fetch above and never allowed to fail the whole page: the
  // ledger's quantities and buckets are the number that has to be right, and
  // a failed name lookup degrades to the raw user id rather than hiding the
  // movement that number came from.
  const actorIds = [
    ...new Set(movements.map((m) => m.actorId).filter((id): id is string => id !== null)),
  ];
  const { data: actors, error: actorsError } = actorIds.length
    ? await supabase.from('profiles').select('id, email, full_name').in('id', actorIds)
    : { data: [], error: null };
  if (actorsError) logger.error({ err: actorsError, prizeId }, 'could not load movement actors');
  const actorById = new Map((actors ?? []).map((a) => [a.id, a]));

  return (
    <>
      <PageHeader
        title={prize.name}
        description={`${categoryName}${prize.internalCode ? ` · ${prize.internalCode}` : ''}`}
        action={
          <Link href="/inventory" className="text-sm text-primary underline underline-offset-2">
            Back to inventory
          </Link>
        }
      />

      <div className="flex flex-col gap-6">
        <Card>
          <CardHeader>
            <CardTitle>Balance</CardTitle>
          </CardHeader>
          <CardContent>
            <BalanceStats balance={prize.balance} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Movement history</CardTitle>
          </CardHeader>
          <CardContent>
            {/* The ledger is the feature on this screen, not a debug view:
                "why does this say 47" is the question it exists to answer,
                so every row names the quantity, the bucket transition, who
                made it and why — newest first, as getPrizeMovements returns
                it. Zero rows here is what a prize that has never moved looks
                like, the same well-defined state as its all-zero balance
                above — not an error, and not rendered as one. */}
            {movements.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No movements recorded yet for this prize.
              </p>
            ) : (
              <div className="flex flex-col gap-3">
                {movements.map((movement) => {
                  const actor = movement.actorId ? actorById.get(movement.actorId) : undefined;
                  const actorLabel = movement.actorId
                    ? (actor?.full_name ?? actor?.email ?? movement.actorId)
                    : 'System';
                  return (
                    <div
                      key={movement.id}
                      data-testid="movement-row"
                      className="rounded-lg border p-4"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <span className="font-medium">
                          {MOVEMENT_TYPE_LABELS[movement.movementType]}
                        </span>
                        <span className="text-sm text-muted-foreground">
                          {formatDateTime(movement.createdAt)}
                        </span>
                      </div>
                      <p className="mt-1 text-sm">
                        {movement.quantity} unit(s), {formatBucket(movement.fromBucket)} →{' '}
                        {formatBucket(movement.toBucket)}
                      </p>
                      <p className="mt-1 text-sm text-muted-foreground">By {actorLabel}</p>
                      {movement.note ? <p className="mt-1 text-sm">{movement.note}</p> : null}
                    </div>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Each rendered only as a courtesy — record_stock_entry,
            record_stock_exit, adjust_stock, reserve_stock and
            release_reservation (0027) each re-check their own permission
            themselves before writing anything, so hiding a form from someone
            who lacks it is convenience, not the refusal itself. See
            getInventoryPermissions' (station-access.ts) own comment. */}
        {permissions.entry && (
          <Card>
            <CardHeader>
              <CardTitle>Add stock</CardTitle>
            </CardHeader>
            <CardContent>
              <StockEntryForm companyId={companyId} prizeId={prizeId} />
            </CardContent>
          </Card>
        )}

        {permissions.exit && (
          <Card>
            <CardHeader>
              <CardTitle>Record a manual exit</CardTitle>
            </CardHeader>
            <CardContent>
              <StockExitForm companyId={companyId} prizeId={prizeId} />
            </CardContent>
          </Card>
        )}

        {permissions.adjust && (
          <Card>
            <CardHeader>
              <CardTitle>Adjust to a counted figure</CardTitle>
            </CardHeader>
            <CardContent>
              <AdjustmentForm companyId={companyId} prizeId={prizeId} balance={prize.balance} />
            </CardContent>
          </Card>
        )}

        {permissions.reserve && (
          <Card>
            <CardHeader>
              <CardTitle>Reserve stock</CardTitle>
            </CardHeader>
            <CardContent>
              <ReserveForm companyId={companyId} prizeId={prizeId} />
            </CardContent>
          </Card>
        )}

        {permissions.reserve && (
          <Card>
            <CardHeader>
              <CardTitle>Release a reservation</CardTitle>
            </CardHeader>
            <CardContent>
              <ReleaseForm companyId={companyId} prizeId={prizeId} />
            </CardContent>
          </Card>
        )}
      </div>
    </>
  );
}

function LoadError({ message }: { message: string }) {
  return (
    <>
      <PageHeader
        title="Prize"
        action={
          <Link href="/inventory" className="text-sm text-primary underline underline-offset-2">
            Back to inventory
          </Link>
        }
      />
      <Card>
        <CardContent className="pt-6">
          <p className="text-sm text-destructive">{message}</p>
        </CardContent>
      </Card>
    </>
  );
}

function NotFound() {
  return (
    <>
      <PageHeader title="Prize not found" />
      <Card>
        <CardContent className="flex flex-col gap-3 pt-6">
          <p className="text-sm text-muted-foreground">
            This prize does not exist, or you do not have permission to view it in this Station.
          </p>
          <Link href="/inventory" className="text-sm text-primary underline underline-offset-2">
            Back to inventory
          </Link>
        </CardContent>
      </Card>
    </>
  );
}
