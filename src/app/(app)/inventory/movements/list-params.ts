import type { InventoryMovementType } from '@/services/inventory';
import type { MovementRow } from '@/services/movements';
import { MOVEMENT_TYPE_LABEL_KEYS } from '../format';

/**
 * The movements screen's URL contract, the same reason every other list
 * screen in this codebase has one (pickups/list-params.ts, inventory/list-
 * params.ts): the Server Component that reads it, the filter bar that writes
 * it and the paging links that rewrite parts of it all have to agree.
 *
 * A type-only import of InventoryMovementType from `@/services/inventory`,
 * which is `server-only`: a type is erased at build time, so movements-filters.tsx
 * — a client component — can import this module without pulling the service
 * across the boundary, the same reasoning pickups/list-params.ts gives for its
 * own type-only import of WinnerStatus. `MOVEMENT_TYPE_LABEL_KEYS` (../format) is
 * a VALUE, not a type, but format.ts carries no `server-only` marker of its
 * own — prize-record-dialog.tsx, a client component, already imports it
 * directly — so it crosses the boundary fine.
 */

export interface MovementSearchParams {
  companyId?: string;
  station?: string;
  type?: string;
  prize?: string;
  promotion?: string;
  from?: string;
  to?: string;
  after?: string;
  before?: string;
}

/**
 * Every real movement type, in the order MOVEMENT_TYPE_LABEL_KEYS (../format)
 * declares them. Derived from that Record's own keys rather than listed a
 * second time: MOVEMENT_TYPE_LABEL_KEYS is a Record<InventoryMovementType,
 * string>, which the compiler already refuses to leave incomplete or widen
 * with an extra key, and Object.keys over a string-keyed object literal
 * preserves declaration order. PICKUP_STATUSES and SOURCE_ORDER (the two
 * closest siblings) are hand-written literals instead, because neither of
 * them already had a same-shaped Record to derive from without inventing
 * one — this one does, so a second, hand-copied list of the same eighteen
 * strings (with its own chance to silently miss the next one the enum
 * grows) is exactly the drift this avoids.
 */
export const MOVEMENT_TYPES: readonly InventoryMovementType[] = Object.keys(
  MOVEMENT_TYPE_LABEL_KEYS,
) as InventoryMovementType[];

export interface MovementListState {
  companyId: string;
  /** A Station-name search, carried by every link for the reason inventory/list-params.ts gives. */
  stationSearch?: string;
  type?: InventoryMovementType;
  prizeId?: string;
  promotionId?: string;
  /** Instants, converted from the operator's calendar days in the Station's zone. */
  from?: string;
  to?: string;
}

export interface MovementCursor {
  side: 'after' | 'before';
  value: string;
}

/**
 * There is no sort key and no direction in this URL, and that absence is
 * deliberate rather than an omission — the same reasoning pickups/list-params.ts
 * and participations/list-params.ts both state for their own screens.
 * listMovements orders by (created_at, movement_id) descending, fixed,
 * because that is exactly what list_movements (0096) itself is written to
 * serve and a keyset cursor must compare precisely the columns it orders by.
 */

/** Anything unrecognised is ignored rather than refused — a hand-edited URL should not be an error page. */
function parseType(raw: string | undefined): InventoryMovementType | undefined {
  const value = raw?.trim();
  return MOVEMENT_TYPES.find((type) => type === value);
}

/**
 * Turns a type `<select>`'s raw value into what `getPrizeMovements`'s own
 * `types` parameter (services/inventory.ts) wants for the Movimentação tab
 * (Block 23, Task 8): `undefined` for the "every kind" option, never `[]`.
 * list_movements' own comment on `p_types` (0196) draws this distinction on
 * purpose — `null` means no filter, an EMPTY ARRAY matches nothing — so a
 * control whose "nothing chosen" state got mapped to `[]` here would render
 * Movimentação as though the prize had no history at all, not as the
 * unfiltered view it is supposed to fall back to.
 *
 * Built on `parseType` above rather than a second reading of MOVEMENT_TYPES:
 * the standalone screen's own type filter still narrows with the scalar
 * `p_type` (services/movements.ts), because `list_movements` has carried
 * both since 0196 and a single selection has no need of the plural form —
 * this helper exists only for the caller that has to hand that same single
 * selection to the array-shaped parameter instead.
 */
export function movementTypeFilter(raw: string): InventoryMovementType[] | undefined {
  const type = parseType(raw);
  return type ? [type] : undefined;
}

/** Anything unparseable is ignored rather than refused, the same contract parseInstant in participations/list-params.ts carries for its own filter. */
function parseInstant(raw: string | undefined): string | undefined {
  const value = raw?.trim();
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : new Date(parsed).toISOString();
}

/**
 * A `to` before its own `from` is not a range list_movements (0096) refuses —
 * p_from/p_to are plain >=/<= bounds applied independently — so an inverted
 * pair would silently read back zero rows with nothing on the screen to say
 * why. The LATER bound (`to`) is what gets dropped rather than the whole
 * period being reset: it keeps the operator's more likely intent — "everything
 * since X" — readable instead of vanishing along with the mistake, the same
 * "widest reading, never an error page" contract parseType above and
 * parseStatus (pickups/list-params.ts) both carry for their own hostile
 * input. Equal bounds (a single day) are not inverted and both survive.
 */
function parsePeriod(
  rawFrom: string | undefined,
  rawTo: string | undefined,
): { from: string | undefined; to: string | undefined } {
  const from = parseInstant(rawFrom);
  const to = parseInstant(rawTo);
  if (from !== undefined && to !== undefined && to < from) return { from, to: undefined };
  return { from, to };
}

export function parseMovementListState(
  raw: MovementSearchParams,
  companyId: string,
): MovementListState {
  const { from, to } = parsePeriod(raw.from, raw.to);
  return {
    companyId,
    stationSearch: raw.station?.trim() || undefined,
    type: parseType(raw.type),
    prizeId: raw.prize?.trim() || undefined,
    promotionId: raw.promotion?.trim() || undefined,
    from,
    to,
  };
}

export function parseMovementCursor(raw: MovementSearchParams): MovementCursor | null {
  if (raw.before) return { side: 'before', value: raw.before };
  if (raw.after) return { side: 'after', value: raw.after };
  return null;
}

/** Whether any filter narrows this screen away from how it opens. */
export function hasActiveMovementFilters(state: MovementListState): boolean {
  return Boolean(
    state.type || state.prizeId || state.promotionId || state.from || state.to,
  );
}

/**
 * Omitting the cursor is how a filter change resets paging, and it must: a
 * cursor is a position in one ordering of one result set — the same rule
 * pickupsHref and participationsHref both carry.
 */
export function movementsHref(state: MovementListState, cursor?: MovementCursor | null): string {
  const query = new URLSearchParams();
  query.set('companyId', state.companyId);
  if (state.stationSearch) query.set('station', state.stationSearch);
  if (state.type) query.set('type', state.type);
  if (state.prizeId) query.set('prize', state.prizeId);
  if (state.promotionId) query.set('promotion', state.promotionId);
  if (state.from) query.set('from', state.from);
  if (state.to) query.set('to', state.to);
  if (cursor) query.set(cursor.side, cursor.value);
  return `/inventory/movements?${query.toString()}`;
}

/**
 * The whole reason this task exists (its own brief, restated at the one place
 * it is decided): `actorId` and `actorName` are BOTH nullable, and their
 * nulls mean different things — only one of them is the clock.
 *
 * `actorId === null` is the deadline sweep (0094): it runs under pg_cron with
 * no `auth.uid()`, so a movement it makes carries no actor at all. Rendered
 * "(deadline)".
 *
 * `actorId` present with `actorName === null` is a real person who simply has
 * no display name on record (profiles.full_name is nullable, 0003) —
 * rendering that row as "(deadline)" would credit a machine for something a
 * person did. Rendered as an unnamed operator instead.
 *
 * Task 6 briefly coalesced this second case onto the operator's own email
 * address; review had it removed (services/movements.ts's own header on
 * list_movements, 0096), because the row already carries the one bit that
 * settles this — `actorId` — and the coalesce put a colleague's email in
 * front of everyone holding inventory.view, with no permission or owner
 * ruling behind that disclosure. This function reads `actorId` FIRST and
 * decides its branch from that alone; `actorName` is read only inside the
 * branch already reached, never to choose between the two — see
 * tests/unit/movement-params.test.ts for the case that catches an
 * implementation which keys off `actorName` instead.
 */
export function describeMovementActor(
  actorId: MovementRow['actorId'],
  actorName: MovementRow['actorName'],
  t: (key: string) => string,
): string {
  if (actorId === null) return t('movementActorDeadline');
  return actorName ?? t('unnamedOperator');
}

/**
 * `promotionId === null` is a movement naming no promotion at all — a
 * purchase entry or a stock adjustment — never "not yours to see"
 * (services/movements.ts's own header on `promotionId`).
 *
 * `promotionArchived` is the bit that tells the OTHER two nulls (no promotion
 * at all vs. an archived one this caller may not be told the name of) apart,
 * and this reads that flag rather than testing `promotionName === null`
 * directly — the identical discipline describeMovementActor keeps for the
 * actor columns, applied here even though today the two conditions never
 * actually disagree (list_movements' own contract guarantees a null name
 * exactly when promotionArchived is true, for a row that has a promotion at
 * all).
 */
export function describeMovementPromotion(
  promotionId: MovementRow['promotionId'],
  promotionName: MovementRow['promotionName'],
  promotionArchived: MovementRow['promotionArchived'],
  t: (key: string) => string,
): string {
  if (promotionId === null) return '—';
  if (promotionArchived) return t('archivedPromotion');
  return promotionName ?? '—';
}
