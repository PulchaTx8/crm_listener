import type { Slice } from '@/schemas/dashboards';

/**
 * Charts print operator English, not enum codes — and this is where the two
 * meet (whole-branch review, Important B2).
 *
 * Five of this block's breakdowns carry a `key` that is a raw Postgres enum
 * value, and 0118–0120 set `label` to the same string, so the charts drew
 * `TOO_SOON`, `OVER_LIMIT`, `AWAITING_PICKUP`, `draw_ban`, `INSTRUMENTAL`
 * beside a `Not stated` bucket that had been given a human label all along.
 * One chart, two vocabularies, and the mixed one is the tell: nobody chose
 * SCREAMING_SNAKE_CASE as a label, it just leaked.
 *
 * The fix is CLIENT-SIDE on purpose, and that is what the payload's own split
 * between `key` and `label` is for. The database has no business holding the
 * English an operator reads; four Records in this codebase already do, each
 * beside the screen that owns the vocabulary, each with a comment explaining
 * its wording:
 *
 *   - `@/lib/participation-status`         STATUS_LABELS  (participation_status)
 *   - `@/app/(app)/pickups/list-params`    STATUS_LABELS  (winner_status)
 *   - `@/app/(app)/members/format`         BLOCK_KIND_LABELS (member_block_kind)
 *   - `@/app/(app)/music/format`           NATIONALITY_LABELS, VOCAL_LABELS
 *
 * Reusing them rather than writing a fifth is the whole point: "Came back too
 * soon" appears on the participations grid and now on the promotions
 * dashboard, from one string. A dashboard that invented its own wording would
 * be the second place to change when the vocabulary moves, and the one nobody
 * remembers.
 *
 * A `key` the map does not know keeps whatever label the payload sent, so a
 * bucket like `NOT_STATED` (already "Not stated" from SQL) passes through
 * untouched, and a value added to an enum tomorrow renders its raw code rather
 * than vanishing or throwing.
 */
export function withOperatorLabels(
  slices: Slice[],
  labels: Readonly<Record<string, string>>,
): Slice[] {
  return slices.map((slice) => {
    const label = slice.key === undefined ? undefined : labels[slice.key];
    return label === undefined ? slice : { ...slice, label };
  });
}
