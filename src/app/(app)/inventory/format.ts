import type { InventoryBucket, InventoryMovementType, PrizeBalance } from '@/services/inventory';

/**
 * Every live bucket, in the order the two screens display them.
 *
 * The values are CATALOGUE KEYS in the `inventory` namespace, not the words
 * themselves. A module body has no request behind it, so it has no language
 * either — every reader resolves them with a `t` it already holds.
 */
export const BUCKET_LABEL_KEYS: Record<InventoryBucket, string> = {
  available: 'available',
  reserved: 'reserved',
  linked: 'linked',
  awaiting_pickup: 'awaitingPickup',
  pending_return: 'pendingReturn',
  delivered: 'delivered',
  written_off: 'writtenOff',
};

/**
 * `from_bucket`/`to_bucket` are null to mean "outside the Station" (0026's own
 * column comment) — a stock entry has no `from`, an exit and a write-off have
 * no `to`. Naming that in the ledger, rather than leaving the cell blank, is
 * what makes "outside the Station" as legible as any real bucket.
 */
export function formatBucket(bucket: InventoryBucket | null, t: (key: string) => string): string {
  return t(bucket === null ? 'outsideTheStation' : BUCKET_LABEL_KEYS[bucket]);
}

/** Every movement type in 0026/0027/0028's vocabulary, spec §5. Keys, as above. */
export const MOVEMENT_TYPE_LABEL_KEYS: Record<InventoryMovementType, string> = {
  INITIAL_ENTRY: 'initialEntry',
  PURCHASE_ENTRY: 'purchase',
  MANUAL_ENTRY: 'manualEntry',
  MANUAL_EXIT: 'manualExit',
  ADJUSTMENT_POSITIVE: 'adjustmentIncrease',
  ADJUSTMENT_NEGATIVE: 'adjustmentDecrease',
  RESERVATION: 'reservation',
  RESERVATION_RELEASE: 'reservationRelease',
  PROMOTION_LINK: 'linkedToPromotion',
  PROMOTION_UNLINK: 'unlinkedFromPromotion',
  DRAW: 'draw',
  DRAW_CANCEL: 'drawCancelled',
  DELIVERY: 'deliveredToWinner',
  DELIVERY_CANCEL: 'deliveryUndone',
  RETURN_PENDING: 'pendingReturn',
  // The inverse of RETURN_PENDING (0091/0092): the deadline reopen moves a
  // unit from pending_return back to awaiting_pickup. This label was missing
  // from the day the enum value landed (0091, Block 6d Task 1) because the
  // generated types file this Record is checked against had not been
  // regenerated since; Task 8 regenerates it and tsc surfaces the gap.
  RETURN_PENDING_CANCEL: 'deadlineReopened',
  RETURN_TO_STOCK: 'returnedToStock',
  WRITE_OFF: 'writtenOff',
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
const PROMOTION_COUNTER_LABEL_KEYS: Record<string, string> = {
  drawn: 'drawn',
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
export function formatBucketName(bucket: string, t: (key: string) => string): string {
  const key =
    (BUCKET_LABEL_KEYS as Record<string, string>)[bucket] ?? PROMOTION_COUNTER_LABEL_KEYS[bucket];
  // The bare-string fallback stays untranslated on purpose: it is a value SQL
  // invented that no catalogue can have a word for, and `t` on an unknown key
  // renders the key rather than the value.
  return key ? t(key) : bucket;
}
