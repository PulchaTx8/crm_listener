/**
 * What the promotions list and the promotion record both call the state a
 * promotion is in.
 *
 * Pure, and deliberately NOT in services/promotions.ts: that module is
 * `server-only`, and both the grid and the record dialog are client components
 * that need this rule. Two copies of it — one for the server's query and one
 * for the browser's badge — is exactly how a row would come back from a filter
 * for "Live" and then render as "Ended".
 */
export type PromotionSituation = 'scheduled' | 'live' | 'ended' | 'cancelled';

/**
 * A SECOND COPY of this rule lives in SQL, in
 * supabase/migrations/0120_promotions_dashboard.sql's promotion_is_live: the
 * Promotions dashboard aggregates in the database and cannot call this, exactly
 * as this cannot call that. Design spec D11 accepts the duplication only
 * because both are pinned at the same boundary instants — here by
 * tests/unit/promotion-situation-boundary.test.ts and there by
 * supabase/tests/20_dashboards.test.sql. Change this rule and change both.
 */
export function situationOf(
  row: { startsAt: string; endsAt: string; cancelledAt: string | null },
  now: Date = new Date(),
): PromotionSituation {
  if (row.cancelledAt !== null) return 'cancelled';
  const at = now.getTime();
  if (at < Date.parse(row.startsAt)) return 'scheduled';
  // The window is half-open, matching the exclusion constraint in 0040: a
  // promotion is over at the instant it ends, not a moment after.
  if (at >= Date.parse(row.endsAt)) return 'ended';
  return 'live';
}
