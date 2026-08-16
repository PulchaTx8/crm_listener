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
 * registered client reference, which is a function, not the array. Both reads
 * this parser makes off it — `.includes` and `[0]` — answer `undefined`, and
 * neither throws on the way. (Not every read: it is a function, so `.length`
 * answers 0, its arity. The two that matter here are the two that lie.) That
 * is what made the failure two-faced, and it is precisely why it survived
 * three blocks:
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
 * there is one idea here, not six. src/lib/promotion-situation.ts already
 * carries one screen's vocabulary on the same reasoning.
 *
 * The cost of that, so the next person weighs it rather than discovers it:
 * this file now grows with every screen, and adding a seventh means editing a
 * module that six other directories already import — a wider blast radius than
 * touching a tuple beside the screen it belongs to, and a merge point when two
 * blocks add a screen at once. The trade is deliberate: a wider blast radius on
 * a file whose whole job is this, against six copies of one idea drifting
 * apart, which is the failure that actually happened. If the list ever gets
 * long enough that this reads as a junk drawer, the answer is one module per
 * screen chosen deliberately and applied to all of them — never to some.
 *
 * `as const` on each, because every screen derives its union type from its own
 * tuple and a widened `string[]` would give the dialogs back an unchecked
 * string for a prop that decides which half of a form renders.
 */
/**
 * `participations` is last, and the position is load-bearing twice over:
 * parseRecordParam falls back to `tabs[0]` for an unknown `tab=`, so the first
 * element is the default a record opens on, and the dialog renders the strip in
 * this order. Appending rather than inserting also keeps
 * tests/e2e/promotions-flow.spec.ts's `tab=nonsense` case — which asserts the
 * fallback lands on `data` — meaning what it meant before.
 */
export const PROMOTION_TABS = ['data', 'whatsapp', 'quiz', 'prizes', 'participations'] as const;
export type PromotionTab = (typeof PROMOTION_TABS)[number];

/**
 * Five since Block 23, where the record had two: the record itself, and a
 * Movements tab where four forms sat above one undifferentiated ledger
 * (design spec §1). Split so each kind of movement reads on its own —
 * `entries` and `exits` appended after `data`, `reservations` after them,
 * and `movements` kept last and legal so a link already pointing at it still
 * resolves to what is now the unified Movimentação view (spec §7, D10)
 * rather than a tab that no longer exists.
 *
 * `data` stays first — the tab an unknown `tab=` falls back to and a record
 * opens on — so no existing link changes meaning. APPEND, never insert: the
 * comment above this tuple's siblings in this file states the same rule, and
 * PROMOTION_TABS's own comment explains exactly what inserting instead once
 * cost.
 */
export const PRIZE_TABS = ['data', 'entries', 'exits', 'reservations', 'movements'] as const;
export type PrizeTab = (typeof PRIZE_TABS)[number];

export const MEMBER_TABS = ['data', 'stations', 'consents', 'notes', 'blocks'] as const;
export type MemberTab = (typeof MEMBER_TABS)[number];

export const ROLE_TABS = ['data', 'powers'] as const;
export type RoleTab = (typeof ROLE_TABS)[number];

export const TEAM_TABS = ['person', 'access'] as const;
export type TeamTab = (typeof TEAM_TABS)[number];

/**
 * Block 16 split CUSTOMER_TABS in two, because the screen it belonged to was
 * showing one record where the platform has two. Its four tabs are shared out
 * below: `customer` and `owner` are facts about the GROUP, `stations` becomes a
 * screen of its own, and `keys` is a fact about a STATION.
 *
 * First element is the tab a record opens on and the fallback parseRecordParam
 * uses for an unknown `tab=`. APPEND, never insert: inserting changes where
 * every existing link lands.
 */
export const ORGANIZATION_TABS = ['data', 'owner', 'stations'] as const;
export type OrganizationTab = (typeof ORGANIZATION_TABS)[number];

/**
 * Fourth since Block 17a, which is the case this tuple's own header comment
 * predicted: `station-record-dialog.tsx`'s strip already maps over this array
 * rather than hard-coding three buttons, so adding the Widget tab cost an
 * entry and a label, not a rewrite.
 */
export const STATION_TABS = ['data', 'whatsapp', 'keys', 'widget'] as const;
export type StationTab = (typeof STATION_TABS)[number];

/**
 * Three since Block 27, two since Block 13a, one in Block 7.
 * song-record-dialog.tsx's tab strip maps over this tuple rather than
 * hard-coding names — its own comment predicted the second addition, and the
 * third has now cost an entry and a label as well.
 *
 * APPENDED, never inserted: `data` must stay the tab a record opens on and the
 * one an unknown `?tab=` falls back to. PROMOTION_TABS' comment above records
 * what inserting instead once cost.
 */
export const SONG_TABS = ['data', 'deezer', 'integration'] as const;
export type SongTab = (typeof SONG_TABS)[number];

/**
 * An artist's record opens on its own fields and offers what the artist is
 * FOR: the songs registered under them. One read per opening feeds both, the
 * shape every other record dialog in this codebase uses.
 */
export const ARTIST_TABS = ['data', 'songs'] as const;
export type ArtistTab = (typeof ARTIST_TABS)[number];

/**
 * One, and that is not an oversight waiting to be corrected: a programme is its
 * fields and its schedule, and the schedule is part of the same form rather than
 * a second section — splitting it would hide half of what an operator is about
 * to save behind a tab.
 *
 * Declared as a tuple anyway, rather than the screen passing `['data']` inline,
 * because `useRecordDialog` keeps this array in a dependency list: a literal
 * rebuilt on every render re-subscribes its popstate listener on every render.
 */
export const SHOW_TABS = ['data'] as const;
export type ShowTab = (typeof SHOW_TABS)[number];

/**
 * One, the same reasoning SHOW_TABS gives for its own: an album's record is
 * its fields and its picture, not fields plus a second section. There is no
 * songs tab the way an artist's record has one (ARTIST_TABS above) -- the
 * songs naming an album are reached from the Songs screen, not from here --
 * and catalog/albums does not share catalog/references' component set
 * either (design spec §2 D3), so this is its own tuple rather than a branch
 * of ReferenceScreenKind.
 *
 * Declared as a tuple rather than the screen passing `['data']` inline, for
 * the same reason SHOW_TABS is: useRecordDialog keeps this array in a
 * dependency list, and a literal rebuilt on every render would resubscribe
 * its popstate listener on every render.
 */
export const ALBUM_TABS = ['data'] as const;
export type AlbumTab = (typeof ALBUM_TABS)[number];

/**
 * One, the same reasoning SHOW_TABS and ALBUM_TABS give for theirs: a supplier's
 * record is who they are, how to reach them and where they are — three groups of
 * one form, not three sections behind tabs. Splitting them would hide two thirds
 * of what an operator is about to save.
 *
 * "What we bought from them" is a real second thing a vendor's record could
 * eventually show, and it is deliberately not here: it is a filter over
 * `/inventory/movements`, which `list_movements` can express as of Block 24 now
 * that `vendor_name` is on the row. A tab would be a second, narrower copy of
 * that screen.
 *
 * Declared as a tuple rather than the screen passing `['data']` inline, because
 * `useRecordDialog` keeps this array in a dependency list: a literal rebuilt on
 * every render re-subscribes its popstate listener on every render.
 */
export const VENDOR_TABS = ['data'] as const;
export type VendorTab = (typeof VENDOR_TABS)[number];

/**
 * One, and the least arguable of the three single-tab tuples here: a prize
 * category is a name. Not even a second field to hide behind a tab.
 *
 * "The prizes wearing this label" is the one thing a second tab could show, and
 * it is deliberately not here: the Stock screen's own category filter already IS
 * that list, with the columns and the paging a prize list needs, and a tab would
 * be a second, narrower copy of it. The row's Prizes column links there instead.
 *
 * Declared as a tuple rather than the screen passing `['data']` inline, for the
 * same reason SHOW_TABS, ALBUM_TABS and VENDOR_TABS are: `useRecordDialog` keeps
 * this array in a dependency list, and a literal rebuilt on every render would
 * re-subscribe its popstate listener on every render.
 */
export const PRIZE_CATEGORY_TABS = ['data'] as const;
export type PrizeCategoryTab = (typeof PRIZE_CATEGORY_TABS)[number];

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
