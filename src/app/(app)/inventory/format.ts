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
  DELIVERY_CANCEL: 'Delivery undone',
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
 * The two counter names on promotion_prize_balances, which reconcile_inventory
 * (0048) emits in the very same `bucket` column as the enum above. Kept apart
 * from BUCKET_LABELS rather than merged into it because that table is keyed by
 * public.inventory_bucket and `drawn` is not a member of it — widening the type
 * to fit one string would make BUCKET_LABELS lie to formatBucket, which really
 * does only ever receive the enum.
 *
 * `linked` is deliberately absent: it is already in BUCKET_LABELS and reads the
 * same way in both places. The two figures are NOT the same quantity — the
 * per-promotion one counts units committed to a promotion and is not
 * decremented by a draw (0045) — but the Promotion column beside it is what
 * tells the reader which is which, not a second spelling of the word.
 */
const PROMOTION_COUNTER_LABELS: Record<string, string> = {
  drawn: 'Drawn',
};

/**
 * reconcile_inventory (0048) returns `bucket` as plain `text` carrying TWO
 * vocabularies, which is why it cannot be typed against the enum. On a
 * per-prize row it is a public.inventory_bucket value cast to text, exactly as
 * 0028 returned it. On a per-promotion row it is one of the counter names on
 * promotion_prize_balances: `linked`, which happens to spell an enum value too,
 * and `drawn`, which is not a bucket and is not going to become one.
 *
 * Never NULL on either kind, unlike inventory_movements.from_bucket/to_bucket:
 * reconciliation only ever reports a figure it actually compared.
 *
 * So the lookup tries the enum's labels first and the counter names second. The
 * bare-string fallback stays, but it is no longer the "in case a future bucket
 * is added here first" guard this comment used to claim: before 0048 it was
 * hypothetical, and between 0048 and PROMOTION_COUNTER_LABELS it was the
 * shipped rendering path for every `drawn` row on the screen.
 */
export function formatBucketName(bucket: string): string {
  return (
    (BUCKET_LABELS as Record<string, string>)[bucket] ??
    PROMOTION_COUNTER_LABELS[bucket] ??
    bucket
  );
}
