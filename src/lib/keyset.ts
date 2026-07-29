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

/** PostgREST needs values quoted so a comma or parenthesis inside one cannot end the clause. */
function quote(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * Builds the `.or(...)` argument that resumes after `cursor`.
 *
 * `nullsLast` must match the ordering actually applied to the query. When it is
 * true and the direction is ascending, a third arm is required: `col.gt.V` is
 * false for every NULL row, so without it the null region is unreachable and
 * every row with no value silently vanishes from the end of the result.
 */
export function keysetFilter(
  column: string,
  direction: SortDirection,
  cursor: Cursor,
  nullsLast: boolean,
): string {
  const id = quote(cursor.id);

  if (cursor.value === null) {
    // Already inside the null region: every remaining row has a null value, so
    // the id alone orders them.
    const op = direction === 'asc' ? 'gt' : 'lt';
    return `and(${column}.is.null,id.${op}.${id})`;
  }

  const value = quote(cursor.value);
  const op = direction === 'asc' ? 'gt' : 'lt';
  const arms = [`${column}.${op}.${value}`, `and(${column}.eq.${value},id.${op}.${id})`];

  if (nullsLast && direction === 'asc') arms.push(`${column}.is.null`);

  return arms.join(',');
}
