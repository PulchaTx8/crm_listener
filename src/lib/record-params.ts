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

/**
 * The tab vocabulary of every screen that opens a record — the legal values of
 * `tab=`, which is half of what "how a record's address is spelled" means.
 *
 * These lived in each screen's record dialog until Block 4b, and that WAS the
 * defect. Every one of those modules opens with 'use client', so the six page
 * components — Server Components, all of them — were importing a value across
 * the boundary and receiving what React hands back for a client export: a
 * registered client reference, which is a function, not the array. Every
 * property read off it answers `undefined`, which made the failure two-faced
 * and is precisely why it survived three blocks:
 *
 *   - `?record=<id>&tab=<slug>` reached `tabs.includes(requested)`, called
 *     `undefined`, and threw `TypeError: tabs.includes is not a function`
 *     during the server render. The screen came back as an error boundary.
 *   - `?record=<id>` alone short-circuited before that, took `tabs[0] ?? null`,
 *     read `undefined` and returned a null tab — no error, and no validation
 *     either. It looked like it worked only because useRecordDialog re-derives
 *     the tab in the browser from the real tuple.
 *
 * So the loud half was broken on all six screens from Block 3c until this
 * commit, and the quiet half had silently stopped doing its job. Nothing caught
 * either, because every test opened records by clicking a row, and the two that
 * did use an address used the quiet form.
 *
 * Here rather than in six neutral modules, one beside each screen: the comment
 * above says this module is the only one that knows how a record's address is
 * spelled, and six new files would be six more that know it — kept uniform
 * across six directories by hand, which is the drift this defect grew out of.
 * The screens are all a page, a grid and a dialog reading the same tuple, so
 * there is one idea here, not six.
 *
 * `as const` on each, because every screen derives its union type from its own
 * tuple and a widened `string[]` would give the dialogs back an unchecked
 * string for a prop that decides which half of a form renders.
 */
export const PROMOTION_TABS = ['data', 'whatsapp', 'quiz', 'prizes'] as const;
export type PromotionTab = (typeof PROMOTION_TABS)[number];

export const PRIZE_TABS = ['data', 'movements'] as const;
export type PrizeTab = (typeof PRIZE_TABS)[number];

export const MEMBER_TABS = ['data', 'stations', 'consents', 'notes', 'blocks'] as const;
export type MemberTab = (typeof MEMBER_TABS)[number];

export const ROLE_TABS = ['data', 'powers'] as const;
export type RoleTab = (typeof ROLE_TABS)[number];

export const TEAM_TABS = ['person', 'access'] as const;
export type TeamTab = (typeof TEAM_TABS)[number];

export const CUSTOMER_TABS = ['customer', 'stations', 'owner'] as const;
export type CustomerTab = (typeof CUSTOMER_TABS)[number];

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
