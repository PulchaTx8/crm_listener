import { getTranslations } from 'next-intl/server';
import {
  PageControls,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import type { MovementRow } from '@/services/movements';
import { formatBucket, MOVEMENT_TYPE_LABELS } from '../format';
import { formatInstant } from '../../promotions/format';
import { describeMovementActor, describeMovementPromotion } from './list-params';

/** How many columns the empty-state row has to span. */
const COLUMN_COUNT = 8;

/**
 * The Station's whole stock ledger, one keyset page at a time — newest first,
 * the same ordering list_movements (0096) itself serves so a keyset cursor can
 * compare exactly the columns it orders by.
 *
 * No actions and no buttons anywhere on this screen (this task's own brief):
 * inventory_movements is append-only by grant — no role holds UPDATE or
 * DELETE on it — and a mistake is corrected by recording a new movement, the
 * way a bank statement is corrected by a reversal. Offering to edit or delete
 * a row here would be offering something the database refuses outright, so —
 * unlike pickups-grid.tsx and inventory-grid.tsx, which both patch a row in
 * place after their own actions succeed — this is a plain Server Component
 * with no client state at all: nothing on this screen ever changes a row.
 */
export async function MovementsGrid({
  rows,
  total,
  timeZone,
  previousHref,
  nextHref,
}: {
  rows: MovementRow[];
  total: number;
  /** The Station's own zone, so every date renders in the zone the movement actually happened in, not the server's. */
  timeZone: string;
  previousHref: string | null;
  nextHref: string | null;
}) {
  const t = await getTranslations('inventory');
  return (
    <div className="mt-4 rounded-lg border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t('date')}</TableHead>
            <TableHead>{t('type')}</TableHead>
            <TableHead>{t('prize')}</TableHead>
            <TableHead>{t('quantity')}</TableHead>
            <TableHead>{t('fromTo')}</TableHead>
            <TableHead>{t('promotion')}</TableHead>
            <TableHead>{t('actor')}</TableHead>
            <TableHead>{t('note')}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.length === 0 ? (
            <TableRow>
              <TableCell colSpan={COLUMN_COUNT} className="py-8 text-center text-muted-foreground">
                {t('noMovementMatchesTheseFilters')}</TableCell>
            </TableRow>
          ) : (
            rows.map((row) => (
              <TableRow key={row.movementId} data-testid="movement-row">
                <TableCell className="whitespace-nowrap text-sm">
                  {formatInstant(row.createdAt, timeZone)}
                </TableCell>
                <TableCell className="text-sm">{MOVEMENT_TYPE_LABELS[row.movementType]}</TableCell>
                <TableCell className="text-sm">{row.prizeName}</TableCell>
                <TableCell className="text-sm">
                  {row.quantity} {row.quantity === 1 ? 'unit' : 'units'}
                </TableCell>
                <TableCell className="whitespace-nowrap text-sm">
                  {formatBucket(row.fromBucket)} → {formatBucket(row.toBucket)}
                </TableCell>
                <TableCell className="text-sm">
                  {describeMovementPromotion(row.promotionId, row.promotionName, row.promotionArchived)}
                </TableCell>
                <TableCell className="text-sm" data-testid="movement-actor">
                  {describeMovementActor(row.actorId, row.actorName)}
                </TableCell>
                <TableCell className="text-sm">{row.note ?? '—'}</TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>

      {/*
        `total` is the count of rows matching the same filters, from the same
        query the rows themselves came from (list_movements' own total_count,
        computed off the identical CTE) — the same guarantee pickups-grid.tsx
        and inventory-grid.tsx both document for their own footer.
      */}
      <PageControls
        total={total}
        label={total === 1 ? 'movement' : 'movements'}
        previousHref={previousHref}
        nextHref={nextHref}
      />
    </div>
  );
}
