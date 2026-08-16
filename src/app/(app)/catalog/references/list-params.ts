import type { MusicReferenceKind } from '@/schemas/music';
import type { SortDirection } from '@/lib/keyset';

/**
 * The References screen's URL contract — one screen, two routes (design spec
 * §2 D2). Modelled on music/artists/list-params.ts's own contract, narrower in
 * the same way that file is already narrow, and one step narrower still:
 * LABEL and GENRE rows are a name and a legacy id and nothing else (0100), so
 * `q` (a name search) is the whole filter, for the same reason
 * music/artists/list-params.ts gives for its own single filter, and there is
 * nothing to SORT by beyond that one column either — services/music.ts's own
 * ReferenceListParams carries a `direction` but no `sort` for the identical
 * reason.
 */

/**
 * The three kinds this screen renders. MusicReferenceKind also names ARTIST and
 * SHOW; neither reaches this screen — Artists has its own screen (it carries a
 * songs tab), and a programme is a record with a presenter and a schedule, so
 * Shows has one too.
 *
 * CATEGORY joined in Block 27 and cost this line, one entry below, three in
 * actions.ts and a page file — which is the return on 0100's one-trio-of-doors
 * shape and on D2's one-component-two-routes shape meeting each other.
 */
export type ReferenceScreenKind = Extract<MusicReferenceKind, 'LABEL' | 'GENRE' | 'CATEGORY'>;

const REFERENCE_SCREEN_PATHS: Record<ReferenceScreenKind, string> = {
  LABEL: '/catalog/labels',
  GENRE: '/catalog/genres',
  CATEGORY: '/catalog/categories',
};

/**
 * The one address each kind renders at. A shared component threading `kind`
 * everywhere already needs no second `basePath` prop beside it — this is the
 * one place that turns a kind into a route, the same shape REFERENCE_TABLES
 * (services/music.ts) turns a kind into a table name.
 */
export function referenceScreenPath(kind: ReferenceScreenKind): string {
  return REFERENCE_SCREEN_PATHS[kind];
}

export interface ReferenceSearchParams {
  companyId?: string;
  station?: string;
  q?: string;
  dir?: string;
  after?: string;
  before?: string;
}

export interface ReferenceListState {
  companyId: string;
  /**
   * A Station-name search, when the caller's Station list was capped and they
   * narrowed it. Carried by every link on this screen: dropping it would put
   * the Station list back to its capped first page, and a Station only
   * reachable THROUGH the search would fall out of it — silently moving the
   * caller to somebody else's catalogue on the next sort click. Same field,
   * same reasoning, as ArtistListState.stationSearch
   * (music/artists/list-params.ts).
   */
  stationSearch?: string;
  search?: string;
  direction: SortDirection;
}

export interface ReferenceCursor {
  side: 'after' | 'before';
  value: string;
}

/**
 * Every kind-specific string the screen renders, resolved ONCE by the page
 * (labels/page.tsx, genres/page.tsx — both Server Components with a
 * `getTranslations` in scope) and threaded down as plain data from there.
 *
 * NOT resolved inside reference-screen.tsx, references-grid.tsx or
 * reference-record-dialog.tsx themselves, even though each is a Client
 * Component that could call `useTranslations('music')` on its own: this
 * screen's kind is a RUNTIME value ('LABEL' | 'GENRE'), and
 * tests/unit/i18n/usage.test.ts can only verify a literal `t('key')` — a call
 * built from a variable (`t(someLookup[kind])`) is invisible to it, the same
 * trap this codebase already worked around once with ACTION_KEYS
 * (music/catalog/actions.ts, deleted in Task 5 -- carried into this screen's
 * own actions.ts before that deletion). A
 * plain string prop sidesteps the trap entirely: the only `t('key')` calls
 * for any of this copy are the literal ones inside the two page files, one
 * per kind, each checkable on its own.
 */
export interface ReferenceScreenCopy {
  title: string;
  description: string;
  createButton: string;
  createDialogTitle: string;
  archiveButton: string;
  archiveConfirmTitle: string;
  readOnlyNotice: string;
  emptyMessage: string;
  noMatchMessage: string;
  /** The pluralised noun PageControls appends to a number — "record label(s)" / "genre(s)" — with `count` already resolved against the page's own total, since that total is exactly what PageControls' own `total` prop repeats beside it. */
  countLabel: string;
  searchPlaceholder: string;
  searchAriaLabel: string;
}

/**
 * The only column either table has to sort by (0100: a name and a legacy id,
 * nothing else). Unlike ArtistSortKey's two values, there is no second one
 * this could ever take, so no `sort` field appears on ReferenceListState above
 * and `defaultDirectionFor` below takes no argument — there is no column to
 * decide a default FOR. Kept as a named export anyway, so a reader comparing
 * this file with music/artists/list-params.ts finds the same name meaning the
 * same thing rather than a silent omission.
 */
export const DEFAULT_REFERENCE_SORT = 'name';

/** Alphabetical: a label or genre list is browsed by name. */
export function defaultDirectionFor(): SortDirection {
  return 'asc';
}

/**
 * `companyId` is resolved by the page against the Stations the caller can
 * actually reach before it gets here, so this only carries it — a tampered
 * value falls back to the caller's first Station there, as it always has.
 */
export function parseReferenceListState(
  raw: ReferenceSearchParams,
  companyId: string,
): ReferenceListState {
  const direction: SortDirection = raw.dir === 'desc' ? 'desc' : defaultDirectionFor();

  return {
    companyId,
    stationSearch: raw.station?.trim() || undefined,
    search: raw.q?.trim() || undefined,
    direction,
  };
}

export function parseReferenceCursor(raw: ReferenceSearchParams): ReferenceCursor | null {
  if (raw.before) return { side: 'before', value: raw.before };
  if (raw.after) return { side: 'after', value: raw.after };
  return null;
}

export function hasActiveReferenceFilters(state: ReferenceListState): boolean {
  return Boolean(state.search);
}

/**
 * Omitting the cursor is how a filter or sort change resets paging, and it
 * must: a cursor is a position in one ordering of one result set.
 */
export function referenceHref(
  kind: ReferenceScreenKind,
  state: ReferenceListState,
  cursor?: ReferenceCursor | null,
): string {
  const query = new URLSearchParams();
  query.set('companyId', state.companyId);
  if (state.stationSearch) query.set('station', state.stationSearch);
  if (state.search) query.set('q', state.search);
  if (state.direction !== defaultDirectionFor()) query.set('dir', state.direction);
  if (cursor) query.set(cursor.side, cursor.value);
  return `${referenceScreenPath(kind)}?${query.toString()}`;
}

/** Clicking the Name column flips its direction — the only column, so there is no "start from that column's own natural direction" branch artistSortHref (music/artists/list-params.ts) needs for its second column. */
export function referenceSortHref(kind: ReferenceScreenKind, state: ReferenceListState): string {
  const direction: SortDirection = state.direction === 'asc' ? 'desc' : 'asc';
  return referenceHref(kind, { ...state, direction });
}
