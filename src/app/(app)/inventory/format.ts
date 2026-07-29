import type { InventoryBucket, InventoryMovementType, PrizeBalance } from '@/services/inventory';

/** Every live bucket, in the order the two screens display them. */
export const BUCKET_LABELS: Record<InventoryBucket, string> = {
  available: 'Available',
  reserved: 'Reserved',
  linked: 'Linked',
  awaiting_pickup: 'Awaiting pickup',
  pending_return: 'Pending return',
  delivered: 'Delivered',
  written_off: 'Written off',
};

/**
 * `from_bucket`/`to_bucket` are null to mean "outside the Station" (0026's own
 * column comment) — a stock entry has no `from`, an exit and a write-off have
 * no `to`. Naming that in the ledger, rather than leaving the cell blank, is
 * what makes "outside the Station" as legible as any real bucket.
 */
export function formatBucket(bucket: InventoryBucket | null): string {
  return bucket === null ? 'outside the Station' : BUCKET_LABELS[bucket];
}

/** Every movement type in 0026/0027/0028's vocabulary, spec §5. */
export const MOVEMENT_TYPE_LABELS: Record<InventoryMovementType, string> = {
  INITIAL_ENTRY: 'Initial entry',
  PURCHASE_ENTRY: 'Purchase',
  MANUAL_ENTRY: 'Manual entry',
  MANUAL_EXIT: 'Manual exit',
  ADJUSTMENT_POSITIVE: 'Adjustment (increase)',
  ADJUSTMENT_NEGATIVE: 'Adjustment (decrease)',
  RESERVATION: 'Reservation',
  RESERVATION_RELEASE: 'Reservation release',
  PROMOTION_LINK: 'Linked to promotion',
  PROMOTION_UNLINK: 'Unlinked from promotion',
  DRAW: 'Draw',
  DRAW_CANCEL: 'Draw cancelled',
  DELIVERY: 'Delivered to winner',
  RETURN_PENDING: 'Pending return',
  RETURN_TO_STOCK: 'Returned to stock',
  WRITE_OFF: 'Written off',
};

/**
 * available + reserved + linked + awaiting_pickup + pending_return — the five
 * buckets a unit occupies while still physically in the Station (design
 * spec §4's equation). `delivered` and `written_off` are cumulative counters
 * that live on the same balance row for reconciliation's sake and must never
 * be folded into this sum — kept as a single function so the list screen and
 * the detail screen cannot silently compute two different totals.
 */
export function physicalTotal(balance: PrizeBalance): number {
  return (
    balance.available +
    balance.reserved +
    balance.linked +
    balance.awaitingPickup +
    balance.pendingReturn
  );
}

export function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
}

/**
 * The day alone, for the inventory table's "Added" column. Like formatDateTime
 * above it renders in the RUNTIME's zone, and both callers are Server
 * Components, so that runtime is the server rather than the viewer's browser —
 * the same disclosed gap members/format.ts carries for its own formatDate.
 */
export function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-GB', { dateStyle: 'medium' });
}

/**
 * reconcile_inventory (0028) returns `bucket` as plain `text`, cast from the
 * enum at the very end of its own query — never NULL, unlike
 * inventory_movements.from_bucket/to_bucket, since reconciliation compares
 * real buckets only. BUCKET_LABELS is keyed by the enum itself, so this casts
 * to look a row's bucket text up in that same table, falling back to the raw
 * string rather than throwing if a future bucket is ever added here first.
 */
export function formatBucketName(bucket: string): string {
  return (BUCKET_LABELS as Record<string, string>)[bucket] ?? bucket;
}
