import { quoteForOrFilter } from '@/lib/postgrest';

/**
 * Keyset (cursor) pagination. Unlike OFFSET, the cost does not grow with depth:
 * the database seeks straight to the cursor's position in the index instead of
 * counting and discarding every row before it.
 *
 * The price is that you cannot jump to page 37 — only forward and back — which
 * is why this product's list footers show Previous/Next rather than page numbers.
 */

export type SortDirection = 'asc' | 'desc';

export interface Cursor {
  /** The sort column's value on the last row of the page just shown. */
  value: string | null;
  /** That row's id. The tiebreak — without it, rows with equal values are skipped or repeated. */
  id: string;
}

export function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify({ value: cursor.value, id: cursor.id })).toString('base64url');
}

/** Returns null for anything unreadable. A bad cursor means "start over", never an error page. */
export function decodeCursor(raw: string | undefined | null): Cursor | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    const { value, id } = parsed as Record<string, unknown>;
    if (typeof id !== 'string' || id.length === 0) return null;
    if (value !== null && typeof value !== 'string') return null;
    return { value, id };
  } catch {
    return null;
  }
}

/**
 * Builds the `.or(...)` argument that resumes after `cursor`.
 *
 * `nullsLast` must match the ordering actually applied to the query, and it
 * decides which region is terminal — independent of `direction`. With nulls
 * last, the null region follows the non-null region under both `asc` and
 * `desc`; with nulls first, it precedes it, under both directions too.
 *
 * Whichever region lies ahead of the cursor but isn't the one it is currently
 * in needs its own arm, because Postgres's three-valued logic makes the plain
 * comparison blind to it:
 * - From the non-null region, reaching a trailing null region needs
 *   `col.is.null` — `col.gt.V`/`col.lt.V` is false for every NULL row, so
 *   without that arm the null region is unreachable and every row with no
 *   value silently vanishes from the result.
 * - From the null region, reaching a trailing non-null region needs
 *   `col.not.is.null` — omitting it stops paging the moment the null region
 *   is exhausted and makes every row that does have a value unreachable.
 */
export function keysetFilter(
  column: string,
  direction: SortDirection,
  cursor: Cursor,
  nullsLast: boolean,
): string {
  const id = quoteForOrFilter(cursor.id);
  const op = direction === 'asc' ? 'gt' : 'lt';

  if (cursor.value === null) {
    // Inside the null region: every row here has a null value, so id alone
    // orders them. This region is terminal only when nulls sort last — when
    // they sort first, the non-null region follows and must stay reachable.
    const arms = [`and(${column}.is.null,id.${op}.${id})`];
    if (!nullsLast) arms.push(`${column}.not.is.null`);
    return arms.join(',');
  }

  const value = quoteForOrFilter(cursor.value);
  const arms = [`${column}.${op}.${value}`, `and(${column}.eq.${value},id.${op}.${id})`];

  // The null region trails the non-null region only when nulls sort last —
  // true for both asc and desc, since NULLS LAST/FIRST is independent of the
  // sort direction.
  if (nullsLast) arms.push(`${column}.is.null`);

  return arms.join(',');
}
