/**
 * The address of an open record: `?record=<id>&tab=<slug>`, alongside whatever
 * the list already has in its query string.
 *
 * A query parameter rather than a path segment, because the list's own state —
 * filters, sort, cursor — has to survive underneath it untouched. The record
 * opens OVER the list, and the URL says exactly that.
 *
 * This is the only module that knows how a record's address is spelled.
 * Everything else passes the pieces around.
 */

export interface RecordParam {
  recordId: string | null;
  /** Null only when no record is open — an open record always resolves to a tab. */
  tab: string | null;
}

/**
 * Everything arriving here is a URL query parameter, so everything is hostile
 * input. Nothing throws: an unknown tab falls back to the first rather than
 * rendering an empty dialog, and a tab with no record is not a record. A URL
 * somebody has been typing into is not an error page — the same contract
 * decodeCursor (src/lib/keyset.ts) carries for its own hostile input.
 */
export function parseRecordParam(
  raw: Record<string, string | undefined>,
  tabs: readonly string[],
): RecordParam {
  const recordId = raw.record?.trim() || null;
  if (!recordId) return { recordId: null, tab: null };

  const requested = raw.tab?.trim();
  const tab = requested && tabs.includes(requested) ? requested : (tabs[0] ?? null);
  return { recordId, tab };
}

/**
 * Rewrites the query string for an open — or closed — record, leaving every
 * other parameter exactly where it was.
 *
 * `set`, never `append`: appending would leave both the old record and the new
 * one in the query, and whichever the reader happened to take first would win,
 * silently and inconsistently between the server's parse and the browser's.
 */
export function withRecord(
  currentSearch: string,
  recordId: string | null,
  tab: string | null,
): string {
  const query = new URLSearchParams(currentSearch);

  if (recordId) {
    query.set('record', recordId);
    if (tab) query.set('tab', tab);
    // A new open naming no tab must not inherit the tab of the record that was
    // open before it.
    else query.delete('tab');
  } else {
    query.delete('record');
    query.delete('tab');
  }

  return query.toString();
}
