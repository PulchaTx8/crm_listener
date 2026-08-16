import 'server-only';
import { createClient } from '@supabase/supabase-js';
import { createUserClient } from '@/lib/supabase/user-client';
import { getUserSupabaseConfig } from '@/lib/supabase/config';
import {
  BusinessRuleError,
  ConflictError,
  InternalError,
  NotFoundError,
  UnauthorizedError,
  ValidationError,
} from '@/lib/errors';
import { keysetFilter, keysetPage } from '@/lib/keyset';
import type { Cursor, SortDirection } from '@/lib/keyset';
import { escapeLikePattern, quoteForOrFilter } from '@/lib/postgrest';
import { describeArtworkRejection } from '@/lib/security/artwork';
import { readImageDimensions } from '@/lib/security/image-dimensions';
import { ARTWORK_BUCKET, artworkKey, artworkPublicUrl } from '@/lib/storage/artwork-keys';
import type { Database } from '@/lib/supabase/database.types';
import { UNCATEGORISED_FILTER } from '@/schemas/inventory';
import type { MovementFormInput, PrizeFormInput, PrizeUpdateInput } from '@/schemas/inventory';

export type InventoryBucket = Database['public']['Enums']['inventory_bucket'];
export type InventoryMovementType = Database['public']['Enums']['inventory_movement_type'];

/**
 * A client bound to the caller's JWT. Every RPC in 0027/0028 re-checks
 * has_permission against auth.uid(), so calling one of them with the service
 * key would defeat the check it exists to make — the same reasoning
 * services/roles.ts gives for its own asCaller.
 */
function asCaller(accessToken: string) {
  const { url, anonKey } = getUserSupabaseConfig();
  return createClient<Database>(url, anonKey, {
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

export interface PrizeCategorySummary {
  id: string;
  name: string;
}

export interface PrizeBalance {
  available: number;
  reserved: number;
  linked: number;
  awaitingPickup: number;
  pendingReturn: number;
  delivered: number;
  writtenOff: number;
}

// A prize that has never had a movement has no inventory_balances row at
// all (apply_inventory_movement creates it lazily, on the first movement —
// 0027). Zero in every bucket is the correct figure for that prize, not a
// placeholder for a read that failed — a genuinely failed read throws,
// below, rather than falling through to this.
const ZERO_BALANCE: PrizeBalance = {
  available: 0,
  reserved: 0,
  linked: 0,
  awaitingPickup: 0,
  pendingReturn: 0,
  delivered: 0,
  writtenOff: 0,
};

export interface PrizeSummary {
  id: string;
  name: string;
  categoryId: string | null;
  internalCode: string | null;
  description: string | null;
  allowsReturnToStock: boolean;
  /**
   * The picture that identifies this prize on the stock list and its record
   * (Block 14). Internal: nothing sends it anywhere, which is why it is held to
   * the thumb's tighter limits rather than to Meta's.
   */
  photoUrl: string | null;
  /** When the prize was registered — the inventory table's "Added" column and its second sort. */
  createdAt: string;
  balance: PrizeBalance;
}

export interface MovementEntry {
  id: string;
  movementType: InventoryMovementType;
  quantity: number;
  fromBucket: InventoryBucket | null;
  toBucket: InventoryBucket | null;
  note: string | null;
  actorId: string | null;
  /**
   * Null does NOT by itself mean "the clock did it" (list_movements' own
   * header, 0096): a human operator with no display name on record also has
   * a null actorName, and actorId is what tells the two apart -- the same
   * discipline services/movements.ts's describeMovementActor already keys
   * on for the standalone screen.
   */
  actorName: string | null;
  createdAt: string;
  // Block 23, Task 1's five columns (0193), projected straight through by
  // list_movements (0196) -- none of the five below are computed.
  /** The supplier invoice this entry came in on (design D3). Null on anything but an entry. */
  invoiceNumber: string | null;
  unitAmount: number | null;
  totalAmount: number | null;
  /** The programme this reservation is held for (design D7). Null on anything but a reservation naming one. */
  reservedForShowId: string | null;
  /** reservedForShowId's own name, resolved by list_movements (0196) -- never stored. */
  showName: string | null;
  /**
   * Block 24, item 8. Who this stock came in from. Null on anything but an
   * entry, and null on an entry that named nobody — a barter from a listener, or
   * any entry recorded before that block.
   */
  vendorId: string | null;
  /**
   * vendorId's own name, resolved by list_movements (0200) -- never stored. It
   * survives the supplier being archived, because that join is deliberately
   * unfiltered by deleted_at: a purchase outlives the relationship.
   */
  vendorName: string | null;
  /** The movement this one undoes (0193). Null except on a reversal or a reservation release. */
  reversesMovementId: string | null;
  /**
   * Block 23, Task 4: two more values list_movements (0196) DERIVES from a
   * left join lateral onto the row whose reverses_movement_id names this
   * one, rather than storing -- 0193's own header states why ("The original
   * is never updated -- it cannot be, and does not need to be"). Null on a
   * row that has not been reversed, and on a reversal or a release, neither
   * of which reverse_movement (0195) can itself undo.
   */
  reversedAt: string | null;
  reversalId: string | null;
  /**
   * A RESERVATION's own quantity minus every RESERVATION_RELEASE pointing at
   * it -- derived by list_movements (0196), never stored. Null on every
   * movement type but RESERVATION.
   */
  remainingQuantity: number | null;
}

export interface ReconciliationRow {
  prizeId: string;
  prizeName: string;
  /** Null on a per-prize row. Non-null names the promotion link the figure belongs to. */
  promotionPrizeId: string | null;
  /** Null on a per-prize row, for the same reason. */
  promotionName: string | null;
  bucket: string;
  stored: number;
  computed: number;
}

/** Reference data for the registration form. RLS gates it on inventory.view. */
export async function listPrizeCategories(companyId: string): Promise<PrizeCategorySummary[]> {
  const supabase = await createUserClient();
  const { data, error } = await supabase
    .from('prize_categories')
    .select('id, name')
    .eq('company_id', companyId)
    .is('deleted_at', null)
    .order('name');

  if (error) throw new InternalError(`Could not read prize categories: ${error.message}`);
  return data ?? [];
}

/** One page of prizes. The audience list's PAGE_SIZE, for the same reason: it is what a person can scan. */
const PRIZE_PAGE_SIZE = 50;

/** The columns the inventory table renders. One constant, because the row read and the count read must agree. */
const PRIZE_COLUMNS =
  'id, name, category_id, internal_code, description, allows_return_to_stock, photo_url, created_at';

/** The one bound on a search term, exported so the page enforces the same number rather than a copy of it. */
export const PRIZE_SEARCH_MAX_LENGTH = 100;

export type PrizeSortKey = 'name' | 'created';

export interface PrizeListParams {
  companyId: string;
  search?: string;
  /** A category id, or UNCATEGORISED_FILTER. Anything else is ignored rather than refused. */
  categoryId?: string;
  sort: PrizeSortKey;
  direction: SortDirection;
  cursor: Cursor | null;
  cursorSide: 'after' | 'before';
}

export interface PrizeListPage {
  rows: PrizeSummary[];
  nextCursor: string | null;
  previousCursor: string | null;
  /** Always exact: one Station's catalogue, cut by RLS before it touches disk. */
  total: number;
}

/**
 * The inventory list, one keyset page at a time (Block 3b).
 *
 * What it replaces read EVERY prize in the Station and shipped the lot to the
 * browser, which filtered them in a `useMemo`; at ten thousand prizes the
 * screen did not open. Search and the category filter are now conditions
 * Postgres evaluates, and the balances read below covers the page rather than
 * the catalogue.
 *
 * There is deliberately no archived-prizes filter, though the plan's Task 5
 * and spec §6 both list one. It cannot be built from here: prizes' own select
 * policy (0029) is `deleted_at is null and has_permission('inventory.view',
 * company_id)`, so an archived prize is not hidden by this query — it is
 * unreadable through RLS entirely, for every caller. Offering the filter
 * would mean widening that policy, which is a visibility decision rather than
 * a listing one. Recorded in the block report instead of quietly dropped.
 */
export async function listPrizesPage(params: PrizeListParams): Promise<PrizeListPage> {
  const supabase = await createUserClient();

  const column = params.sort === 'name' ? 'name' : 'created_at';
  // Neither sort column is nullable (0025), so no null region exists on
  // either — unlike the audience list, where full_name is.
  const walkingBack = params.cursorSide === 'before' && params.cursor !== null;
  const ascending = walkingBack ? params.direction === 'desc' : params.direction === 'asc';
  const readDirection: SortDirection = ascending ? 'asc' : 'desc';

  const build = (options?: { count: 'exact'; head: true }) => {
    let q = supabase
      .from('prizes')
      .select(PRIZE_COLUMNS, options)
      .eq('company_id', params.companyId)
      .is('deleted_at', null);

    if (params.categoryId === UNCATEGORISED_FILTER) {
      q = q.is('category_id', null);
    } else if (params.categoryId) {
      q = q.eq('category_id', params.categoryId);
    }

    const term = params.search?.trim().slice(0, PRIZE_SEARCH_MAX_LENGTH);
    if (term) {
      // escapeLikePattern before the wildcard markers, so only what the
      // caller typed is escaped — never the markers this adds itself.
      const wildcard = quoteForOrFilter(`%${escapeLikePattern(term)}%`);
      q = q.or(`name.ilike.${wildcard},internal_code.ilike.${wildcard}`);
    }

    return q;
  };

  let query = build().order(column, { ascending });
  if (params.cursor) {
    // nullsLast is false because neither sort column is nullable: there is no
    // null region for a cursor to cross into.
    query = query.or(keysetFilter(column, readDirection, params.cursor, false));
  }
  query = query.order('id', { ascending });

  const { data, error } = await query.limit(PRIZE_PAGE_SIZE + 1);
  if (error) throw new InternalError(`Could not read prizes: ${error.message}`);

  const { rows: page, nextCursor, previousCursor } = keysetPage(data ?? [], {
    pageSize: PRIZE_PAGE_SIZE,
    walkingBack,
    hadCursor: params.cursor !== null,
    cursorFor: (row) => ({
      value: params.sort === 'name' ? row.name : row.created_at,
      id: row.id,
    }),
  });

  const { count, error: countError } = await build({ count: 'exact', head: true });
  if (countError) throw new InternalError(`Could not count prizes: ${countError.message}`);

  return {
    rows: await withBalances(supabase, params.companyId, page),
    nextCursor,
    previousCursor,
    total: count ?? 0,
  };
}

/** One prize, read by id. RLS decides whether it exists for this caller — see getPrizeById. */
type PrizeRecord = {
  id: string;
  name: string;
  category_id: string | null;
  internal_code: string | null;
  description: string | null;
  allows_return_to_stock: boolean;
  photo_url: string | null;
  created_at: string;
};

/**
 * Attaches each prize's balance. Two reads rather than an embed — the same
 * reasoning listRoles (services/roles.ts) gives for
 * role_permissions/company_memberships: a prize that has never moved has no
 * inventory_balances row at all, and folding the balance into the prize read
 * would need an outer join PostgREST's embed syntax does not offer here.
 *
 * Scoped to the prizes handed to it, which since Block 3b is one page rather
 * than the whole catalogue.
 */
async function withBalances(
  supabase: Awaited<ReturnType<typeof createUserClient>>,
  companyId: string,
  prizes: readonly PrizeRecord[],
): Promise<PrizeSummary[]> {
  const prizeIds = prizes.map((p) => p.id);
  if (prizeIds.length === 0) return [];

  const { data: balances, error: balancesError } = await supabase
    .from('inventory_balances')
    .select(
      'prize_id, available, reserved, linked, awaiting_pickup, pending_return, delivered, written_off',
    )
    .eq('company_id', companyId)
    .in('prize_id', prizeIds);

  // Discarding this would render every prize with an all-zero balance —
  // indistinguishable from a prize that has genuinely never moved, and
  // exactly the failure this block's spec exists to rule out: the number on
  // the screen would look like the truth while actually meaning "the read
  // failed."
  if (balancesError) {
    throw new InternalError(`Could not read stock balances: ${balancesError.message}`);
  }

  const balanceByPrize = new Map<string, PrizeBalance>();
  for (const row of balances ?? []) {
    balanceByPrize.set(row.prize_id, {
      available: row.available,
      reserved: row.reserved,
      linked: row.linked,
      awaitingPickup: row.awaiting_pickup,
      pendingReturn: row.pending_return,
      delivered: row.delivered,
      writtenOff: row.written_off,
    });
  }

  return prizes.map((prize) => ({
    id: prize.id,
    name: prize.name,
    categoryId: prize.category_id,
    internalCode: prize.internal_code,
    description: prize.description,
    allowsReturnToStock: prize.allows_return_to_stock,
    photoUrl: prize.photo_url,
    createdAt: prize.created_at,
    balance: balanceByPrize.get(prize.id) ?? ZERO_BALANCE,
  }));
}

/**
 * One prize, and the Station it belongs to, by id.
 *
 * What this replaces looped the whole list service over every Station the
 * caller could view, comparing ids — at 2,000 prizes per Station and fifty
 * Stations, a 100,000-row scan to open one card. RLS already scopes `prizes`
 * to the Stations the caller holds inventory.view in (0029), so a prize at an
 * unreachable Station comes back as null here: the same outcome the loop
 * produced, without the scan and without a cap that could hide a real prize
 * behind "we only checked the first fifty Stations".
 */
export async function getPrizeById(
  prizeId: string,
): Promise<{ companyId: string; prize: PrizeSummary } | null> {
  const supabase = await createUserClient();
  const { data, error } = await supabase
    .from('prizes')
    .select(`${PRIZE_COLUMNS}, company_id`)
    .eq('id', prizeId)
    .is('deleted_at', null)
    .maybeSingle();

  if (error) throw new InternalError(`Could not read the prize: ${error.message}`);
  if (!data) return null;

  const [prize] = await withBalances(supabase, data.company_id, [data]);
  return prize ? { companyId: data.company_id, prize } : null;
}

/** The movement history for a prize's detail screen, newest first. */
/**
 * Replaces a prize's catalogue fields wholesale — update_prize (0027) sets
 * every column it takes on every call, so a partial input blanks what it omits.
 * Gated in the database on inventory.catalogue at the prize's own Company,
 * which this never passes: the RPC reads it off the prize row.
 */
export async function updatePrize(input: PrizeUpdateInput, accessToken: string): Promise<void> {
  const { error } = await asCaller(accessToken).rpc('update_prize', {
    p_prize_id: input.prizeId,
    p_name: input.name,
    p_category_id: input.categoryId,
    p_internal_code: input.internalCode,
    p_description: input.description,
    p_allows_return_to_stock: input.allowsReturnToStock,
  });
  if (error) throw mapInventoryError(error.code, error.message);
}

/**
 * Archives a prize. Irreversible from this app, and not by oversight:
 * prizes_select_inventory_view (0029) is `deleted_at is null and
 * has_permission(...)`, so an archived prize is unreadable through RLS for
 * every caller, including the owner and the platform admin. Nothing here can
 * list it, show it or restore it afterwards — which is why the screen that
 * calls this says so before asking for confirmation.
 */
export async function archivePrize(prizeId: string, accessToken: string): Promise<void> {
  const { error } = await asCaller(accessToken).rpc('archive_prize', { p_prize_id: prizeId });
  if (error) throw mapInventoryError(error.code, error.message);
}

/**
 * A generous single page rather than a paginated read: a prize's own history
 * is bounded in a way a Station's whole ledger is not (services/movements.ts's
 * own MOVEMENT_PAGE_SIZE of 25 is a screen's worth for exactly the opposite
 * reason), and the record dialog has always fetched one prize's whole history
 * in the one round trip its own comment describes (record.ts).
 *
 * This is a cap on ONE call, not on the prize's whole history: `types`
 * below lets a caller narrow to one kind first and get its own 500 of THAT
 * kind, rather than 500 of every kind with a tab's own rows sliced out of
 * whatever survived the cap (fix round 1, I3 — a prize with 500 recent
 * DRAW/DELIVERY movements was making the Entradas tab render empty while
 * entries plainly existed).
 */
const PRIZE_MOVEMENTS_LIMIT = 500;

export interface PrizeMovementsPage {
  movements: MovementEntry[];
  /**
   * list_movements' own total_count (0096/0196), computed from the SAME
   * filtered set the rows come from, so a page and its count cannot narrow
   * differently. What lets a screen say "there are more than the 500 shown"
   * instead of silently rendering a capped read as if it were complete (fix
   * round 1, I3).
   */
  totalCount: number;
}

/**
 * One prize's movement history, scoped by prize_id rather than a second read
 * path of its own, and optionally narrowed to one or more kinds — Tasks 5–8
 * pass `types` so each of the Entradas/Saídas/Reservas/Movimentação tabs
 * asks for its own group of kinds and gets its own PRIZE_MOVEMENTS_LIMIT,
 * rather than every tab slicing one shared, capped array (fix round 1, I3).
 *
 * Through list_movements (0096, widened 0196 for Block 23) rather than a
 * plain table select — the module's OTHER RPC read, reconcileInventory
 * below, already establishes the convention: reversed_at/reversal_id/
 * remaining_quantity/show_name are computed there, by a left join lateral and
 * a correlated sum, and reimplementing that arithmetic here would be a
 * second mechanism that can drift, exactly what 0193's own header warns
 * reverses_movement_id itself was designed to avoid. Read through asCaller,
 * like every RPC call in this file: list_movements is SECURITY DEFINER and
 * re-checks has_permission against auth.uid() in its own body, so the
 * caller's token has to travel, not the cookie session createUserClient()
 * carries for a plain select.
 *
 * `from`/`to` (Block 23, Task 8): the Movimentação tab's own De/Até, forwarded
 * to `p_from`/`p_to` — parameters list_movements has carried since 0096, never
 * exercised from this side of the call until now because no caller before
 * Task 8 needed a per-prize read narrowed by period. Instants, the same shape
 * services/movements.ts's own `listMovements` already sends the standalone
 * screen's identical p_from/p_to.
 */
export async function getPrizeMovements(
  companyId: string,
  prizeId: string,
  accessToken: string,
  types?: InventoryMovementType[],
  from?: string,
  to?: string,
): Promise<PrizeMovementsPage> {
  const { data, error } = await asCaller(accessToken).rpc('list_movements', {
    p_company_id: companyId,
    p_prize_id: prizeId,
    p_limit: PRIZE_MOVEMENTS_LIMIT,
    p_types: types,
    p_from: from,
    p_to: to,
  });

  // The ledger IS the feature on the prize detail screen ("why does this say
  // 47" is the question it exists to answer) — a discarded error here would
  // render a blank history that looks like an uneventful prize rather than a
  // failed read. Routed through mapInventoryError (fix round 1, I2) rather
  // than a raw InternalError: this used to be a plain table select, where a
  // caller who had lost inventory.view simply saw RLS return zero rows —
  // now it is a SECURITY DEFINER RPC that RAISES 42501 for exactly that
  // caller, and mapInventoryError already turns that into the
  // UnauthorizedError this deserves instead of a generic 500 that hides
  // which of the two actually happened.
  if (error) throw mapInventoryError(error.code, error.message);

  const rows = data ?? [];
  return {
    movements: rows.map((row) => ({
      id: row.movement_id,
      movementType: row.movement_type,
      quantity: row.quantity,
      fromBucket: row.from_bucket,
      toBucket: row.to_bucket,
      note: row.note,
      actorId: row.actor_id,
      actorName: row.actor_name,
      createdAt: row.created_at,
      invoiceNumber: row.invoice_number,
      unitAmount: row.unit_amount,
      totalAmount: row.total_amount,
      reservedForShowId: row.reserved_for_show_id,
      showName: row.show_name,
      vendorId: row.vendor_id,
      vendorName: row.vendor_name,
      reversesMovementId: row.reverses_movement_id,
      reversedAt: row.reversed_at,
      reversalId: row.reversal_id,
      remainingQuantity: row.remaining_quantity,
    })),
    // The same fallback services/movements.ts's own listMovements uses for
    // the identical shape: no rows means no total_count to read off any of
    // them, and zero is the honest reading of an empty filtered set.
    totalCount: rows[0]?.total_count ?? 0,
  };
}

export async function createPrizeCategory(
  companyId: string,
  name: string,
  accessToken: string,
): Promise<string> {
  const { data, error } = await asCaller(accessToken).rpc('create_prize_category', {
    p_company_id: companyId,
    p_name: name,
  });
  if (error) throw mapInventoryError(error.code, error.message);
  if (typeof data !== 'string') throw new InternalError('create_prize_category returned no id');
  return data;
}

export async function createPrize(input: PrizeFormInput, accessToken: string): Promise<string> {
  const { data, error } = await asCaller(accessToken).rpc('create_prize', {
    p_company_id: input.companyId,
    p_name: input.name,
    p_category_id: input.categoryId,
    p_internal_code: input.internalCode,
    p_description: input.description,
    p_allows_return_to_stock: input.allowsReturnToStock,
  });
  if (error) throw mapInventoryError(error.code, error.message);
  if (typeof data !== 'string') throw new InternalError('create_prize returned no id');
  return data;
}

// update_prize and archive_prize (0027) are RPC-only for now: no screen
// calls either one yet (branch review, Minor). Deleted rather than kept as
// unwired wrappers — shipped surface with no caller is debt either way, and
// building the edit/archive screens they would front is out of this fix's
// scope. Both RPCs remain fully callable directly (psql, a future screen, or
// a script) without a TypeScript wrapper; nothing here removes them from the
// database.

// Derived from movementFormSchema's discriminated union rather than
// hand-written, so a field renamed on one side breaks the build on the
// other instead of only surfacing at runtime — the seam Task 7's review
// flagged: this field used to be named `type` here while the schema (and
// record_stock_entry's own `p_type` parameter) called it `entryType`, and
// nothing but a form author's care kept a hand-mapping between the two
// honest. `kind` rides along unused by the RPC call below, the same as it
// does on every other Stock*Input type in this file.
export type StockEntryInput = Extract<MovementFormInput, { kind: 'entry' }>;

export async function recordStockEntry(
  input: StockEntryInput,
  accessToken: string,
): Promise<string> {
  const { data, error } = await asCaller(accessToken).rpc('record_stock_entry', {
    p_company_id: input.companyId,
    p_prize_id: input.prizeId,
    p_type: input.entryType,
    p_quantity: input.quantity,
    p_note: input.note,
    p_idempotency_key: input.idempotencyKey,
    p_invoice_number: input.invoiceNumber,
    p_unit_amount: input.unitAmount,
    p_total_amount: input.totalAmount,
    // Block 24, item 8. Beside the invoice, which is where the paperwork puts
    // it. Undefined when nothing was chosen, which PostgREST omits and the
    // function's own `default null` answers.
    p_vendor_id: input.vendorId,
  });
  if (error) throw mapInventoryError(error.code, error.message);
  if (typeof data !== 'string') throw new InternalError('record_stock_entry returned no id');
  return data;
}

export type StockExitInput = Extract<MovementFormInput, { kind: 'exit' }>;

export async function recordStockExit(input: StockExitInput, accessToken: string): Promise<string> {
  const { data, error } = await asCaller(accessToken).rpc('record_stock_exit', {
    p_company_id: input.companyId,
    p_prize_id: input.prizeId,
    p_quantity: input.quantity,
    p_note: input.note,
    p_idempotency_key: input.idempotencyKey,
    p_type: input.type,
  });
  if (error) throw mapInventoryError(error.code, error.message);
  if (typeof data !== 'string') throw new InternalError('record_stock_exit returned no id');
  return data;
}

export type StockAdjustmentInput = Extract<MovementFormInput, { kind: 'adjustment' }>;

/**
 * Returns the new movement's id, or null when the counted figure matched
 * what was already booked. adjust_stock (0027) returns NULL specifically for
 * that case — "an adjustment of zero is not an event worth a ledger row" —
 * and its own comment is explicit that this is a well-defined success, not a
 * failure: "every failure path raises, so NULL never means an error."
 *
 * supabase gen types has no way to know a `returns uuid` function can come
 * back NULL (Postgres's function metadata does not record result
 * nullability), so the generated Args/Returns type for this call is a bare
 * `string`. Widening the local binding to `string | null` is what actually
 * lets this function tell a real id apart from the no-op, rather than
 * letting the generated type's optimism paper over it.
 */
export async function adjustStock(
  input: StockAdjustmentInput,
  accessToken: string,
): Promise<string | null> {
  const { data, error } = await asCaller(accessToken).rpc('adjust_stock', {
    p_company_id: input.companyId,
    p_prize_id: input.prizeId,
    p_counted: input.counted,
    p_note: input.note,
    p_idempotency_key: input.idempotencyKey,
  });
  if (error) throw mapInventoryError(error.code, error.message);
  const movementId: string | null = data;
  return movementId;
}

export type StockReservationInput = Extract<MovementFormInput, { kind: 'reserve' }>;
export type StockReservationReleaseInput = Extract<MovementFormInput, { kind: 'release' }>;

export async function reserveStock(
  input: StockReservationInput,
  accessToken: string,
): Promise<string> {
  const { data, error } = await asCaller(accessToken).rpc('reserve_stock', {
    p_company_id: input.companyId,
    p_prize_id: input.prizeId,
    p_quantity: input.quantity,
    p_note: input.note,
    p_idempotency_key: input.idempotencyKey,
    p_show_id: input.showId,
  });
  if (error) throw mapInventoryError(error.code, error.message);
  if (typeof data !== 'string') throw new InternalError('reserve_stock returned no id');
  return data;
}

export async function releaseReservation(
  input: StockReservationReleaseInput,
  accessToken: string,
): Promise<string> {
  const { data, error } = await asCaller(accessToken).rpc('release_reservation', {
    p_company_id: input.companyId,
    p_prize_id: input.prizeId,
    p_quantity: input.quantity,
    p_note: input.note,
    p_idempotency_key: input.idempotencyKey,
    p_reservation_id: input.reservationId,
  });
  if (error) throw mapInventoryError(error.code, error.message);
  if (typeof data !== 'string') throw new InternalError('release_reservation returned no id');
  return data;
}

/**
 * Archives a stock entry or exit by writing its opposite (design D1, 0195) —
 * the ledger is append-only, so a correction is a second movement, never an
 * edit. `note` is the operator's own, not invented here: fix round 1 (I1)
 * removed an earlier version of this function that supplied a fixed English
 * string ('Archived by the operator') on the caller's behalf. This ledger's
 * own note column is rendered raw on screen (prize-record-dialog.tsx,
 * movements-grid.tsx) and the row that carries it can never be edited or
 * deleted (0026's own grant), so a hard-coded note would have put an
 * English sentence into a Portuguese- or Spanish-speaking Station's history
 * permanently — no later translation pass can reach a row already written.
 * reverse_movement's own p_note is mandatory with no default (0195's own
 * header explains why: every sibling exit door demands a reason), so this
 * wrapper's signature says so too, exactly as record_stock_exit/reserve_stock
 * /release_reservation's own Stock*Input types already require `note`.
 * Task 6's Arquivar dialog collects it as a required field.
 */
export async function reverseMovement(
  movementId: string,
  note: string,
  accessToken: string,
): Promise<string> {
  const { data, error } = await asCaller(accessToken).rpc('reverse_movement', {
    p_movement_id: movementId,
    p_note: note,
  });
  if (error) throw mapInventoryError(error.code, error.message);
  if (typeof data !== 'string') throw new InternalError('reverse_movement returned no id');
  return data;
}

/**
 * Reads through the RPC rather than a table select, so it must go through
 * asCaller like every write above: reconcile_inventory (0028) re-checks
 * has_permission('inventory.view', ...) against auth.uid() in its own body,
 * the same as every mutating RPC in 0027, even though it performs no write
 * of its own — it is SECURITY DEFINER and would otherwise run past RLS
 * entirely with no check standing in for it.
 */
export async function reconcileInventory(
  companyId: string,
  accessToken: string,
): Promise<ReconciliationRow[]> {
  const { data, error } = await asCaller(accessToken).rpc('reconcile_inventory', {
    p_company_id: companyId,
  });
  if (error) throw mapInventoryError(error.code, error.message);

  return (data ?? []).map((row) => ({
    prizeId: row.prize_id,
    prizeName: row.prize_name,
    promotionPrizeId: row.promotion_prize_id,
    promotionName: row.promotion_name,
    bucket: row.bucket,
    stored: row.stored,
    computed: row.computed,
  }));
}

/**
 * The error taxonomy in lib/errors.ts exists so a caller can tell these
 * apart; collapsing them into one class throws that away, the same warning
 * services/roles.ts's mapRoleError carries.
 *
 * - `23514` is the bucket-floor refusal apply_inventory_movement raises
 *   itself, before the CHECK constraint of the same SQLSTATE ever would —
 *   its message names the available count ("only 5 unit(s) are in
 *   available, and 10 were requested"), which is exactly what the screen
 *   needs to say, so it passes straight through as a BusinessRuleError
 *   rather than being replaced with something generic.
 * - `23503` is archive_prize's refusal while physical stock remains; its
 *   message names the count the same way ("this prize still has N unit(s)
 *   in stock; move them out first").
 * - `P0002` is every "not found" raise across 0027/0028 — a stale Station,
 *   prize or category id. Not a permission refusal: the row is simply gone,
 *   and telling someone they lack permission when the record no longer
 *   exists sends them to fix the wrong thing.
 * - `42501` is has_permission failing inside a SECURITY DEFINER body —
 *   every RPC in 0027/0028 raises this with the same shape, having already
 *   written a RAISE LOG line server-side.
 * - `22023` is every validation raise: a non-positive or fractional
 *   quantity, an entry type outside the three record_stock_entry accepts, a
 *   missing mandatory note, or a negative counted figure. schemas/inventory.ts
 *   catches all of these before a request is ever sent; this mapping is what
 *   still applies if a caller bypasses the form.
 * - `23505` is a duplicate category name or internal_code, both already
 *   rewritten by the RPC itself to name the value ("a category named ...
 *   already exists in this station").
 * - Anything else is ours, not the caller's. Labelling an unexpected
 *   database fault a refusal hides a real fault behind a plausible-looking
 *   permission or business-rule message.
 */
function mapInventoryError(code: string | undefined, message: string): Error {
  if (code === '23514') return new BusinessRuleError(message);
  if (code === '23503') return new BusinessRuleError(message);
  if (code === '23505') return new ConflictError(message);
  if (code === '22023') return new ValidationError(message);
  if (code === 'P0002') return new NotFoundError(message);
  if (code === '42501') return new UnauthorizedError(message);
  return new InternalError(message);
}

// ---------------------------------------------------------------------------
// The prize's photograph (Block 14).

/**
 * Uploads the object and then files it, IN THAT ORDER, so the row can never
 * point at bytes that failed to arrive — that is a broken image on every screen
 * that names the prize. A failed RPC leaves an object at a key derived from this
 * prize: unreferenced, harmless, and overwritten by the next upload, because
 * the key never changes.
 *
 * On the CALLER's token rather than the service key. The bucket policy in 0143
 * checks inventory.catalogue against the Station in the path, and the service
 * key would bypass the policy this block wrote and leave it proved by nothing.
 *
 * Validated as a `thumb`: a prize photograph identifies a row on a list and is
 * held to the tighter of the two pixel ceilings. Nothing here sends it to
 * WhatsApp, so none of Meta's rules decide anything about it — only the format
 * and byte limits, which the bucket shares with the banner.
 */
export async function uploadPrizePhoto(
  accessToken: string,
  input: { companyId: string; prizeId: string; file: File },
): Promise<string> {
  const bytes = new Uint8Array(await input.file.arrayBuffer());
  const rejection = describeArtworkRejection(
    'thumb',
    { type: input.file.type, size: input.file.size },
    readImageDimensions(bytes),
  );
  // The bucket refuses the type and the size as well (0143). This is here so
  // the failure is a sentence rather than a Storage error, so the pixel ceiling
  // — which no bucket can express — is enforced somewhere a client cannot
  // reach, and so nothing is uploaded first.
  if (rejection) throw new ValidationError(rejection);

  const key = artworkKey('prize-photos', input.companyId, input.prizeId);

  const uploaded = await asCaller(accessToken)
    .storage.from(ARTWORK_BUCKET)
    .upload(key, input.file, {
      // NOT optional: the key carries no extension, so an object uploaded with
      // no content type is served back as application/octet-stream.
      contentType: input.file.type,
      // The whole point of a key derived from the record. Without this the
      // SECOND upload for a prize fails instead of replacing the first.
      upsert: true,
    });
  if (uploaded.error) {
    throw new InternalError(`Could not upload the photograph: ${uploaded.error.message}`);
  }

  const url = artworkPublicUrl(getUserSupabaseConfig().url, key, Date.now());
  const { error } = await asCaller(accessToken).rpc('set_prize_photo', {
    p_prize_id: input.prizeId,
    p_url: url,
  });
  if (error) throw mapInventoryError(error.code, error.message);
  return url;
}

/**
 * Clears the column and queues the object, in one transaction (0145).
 *
 * NOTHING HERE DELETES ANYTHING: the bucket has no delete policy for
 * `authenticated`, deliberately, and the worker drains the queue through
 * service_role. p_url is OMITTED rather than sent as null — 0145 gives it
 * `default null` precisely so clearing needs no cast.
 */
export async function clearPrizePhoto(accessToken: string, prizeId: string): Promise<void> {
  const { error } = await asCaller(accessToken).rpc('set_prize_photo', {
    p_prize_id: prizeId,
  });
  if (error) throw mapInventoryError(error.code, error.message);
}
