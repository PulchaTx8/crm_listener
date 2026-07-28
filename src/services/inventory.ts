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
import type { Database } from '@/lib/supabase/database.types';
import type { PrizeFormInput } from '@/schemas/inventory';

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
  createdAt: string;
}

export interface ReconciliationRow {
  prizeId: string;
  prizeName: string;
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

/**
 * The inventory list: every live prize in the Station with its balance
 * broken out by bucket.
 */
export async function listPrizes(companyId: string): Promise<PrizeSummary[]> {
  const supabase = await createUserClient();

  const { data: prizes, error: prizesError } = await supabase
    .from('prizes')
    .select('id, name, category_id, internal_code, description, allows_return_to_stock')
    .eq('company_id', companyId)
    .is('deleted_at', null)
    .order('name');

  if (prizesError) throw new InternalError(`Could not read prizes: ${prizesError.message}`);

  const prizeIds = (prizes ?? []).map((p) => p.id);
  if (prizeIds.length === 0) return [];

  // Two reads rather than an embed — the same reasoning listRoles
  // (services/roles.ts) gives for role_permissions/company_memberships: a
  // prize that has never moved has no inventory_balances row at all, and
  // folding the balance into the prize read would need an outer join
  // PostgREST's embed syntax does not offer here.
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

  return (prizes ?? []).map((prize) => ({
    id: prize.id,
    name: prize.name,
    categoryId: prize.category_id,
    internalCode: prize.internal_code,
    description: prize.description,
    allowsReturnToStock: prize.allows_return_to_stock,
    balance: balanceByPrize.get(prize.id) ?? ZERO_BALANCE,
  }));
}

/** The movement history for a prize's detail screen, newest first. */
export async function getPrizeMovements(
  companyId: string,
  prizeId: string,
): Promise<MovementEntry[]> {
  const supabase = await createUserClient();
  const { data, error } = await supabase
    .from('inventory_movements')
    .select('id, movement_type, quantity, from_bucket, to_bucket, note, actor_id, created_at')
    .eq('company_id', companyId)
    .eq('prize_id', prizeId)
    .order('created_at', { ascending: false });

  // The ledger IS the feature on the prize detail screen ("why does this say
  // 47" is the question it exists to answer) — a discarded error here would
  // render a blank history that looks like an uneventful prize rather than a
  // failed read.
  if (error) throw new InternalError(`Could not read the movement history: ${error.message}`);

  return (data ?? []).map((row) => ({
    id: row.id,
    movementType: row.movement_type,
    quantity: row.quantity,
    fromBucket: row.from_bucket,
    toBucket: row.to_bucket,
    note: row.note,
    actorId: row.actor_id,
    createdAt: row.created_at,
  }));
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

/**
 * Replaces the prize's catalogue fields wholesale (update_prize's own
 * convention, 0027). The Organization and Company are resolved from the
 * prize row itself, never from a parameter — so no companyId is taken here.
 */
export async function updatePrize(
  prizeId: string,
  input: PrizeFormInput,
  accessToken: string,
): Promise<void> {
  const { error } = await asCaller(accessToken).rpc('update_prize', {
    p_prize_id: prizeId,
    p_name: input.name,
    p_category_id: input.categoryId,
    p_internal_code: input.internalCode,
    p_description: input.description,
    p_allows_return_to_stock: input.allowsReturnToStock,
  });
  if (error) throw mapInventoryError(error.code, error.message);
}

export async function archivePrize(prizeId: string, accessToken: string): Promise<void> {
  const { error } = await asCaller(accessToken).rpc('archive_prize', { p_prize_id: prizeId });
  if (error) throw mapInventoryError(error.code, error.message);
}

export interface StockEntryInput {
  companyId: string;
  prizeId: string;
  type: 'INITIAL_ENTRY' | 'PURCHASE_ENTRY' | 'MANUAL_ENTRY';
  quantity: number;
  note?: string;
  idempotencyKey?: string;
}

export async function recordStockEntry(
  input: StockEntryInput,
  accessToken: string,
): Promise<string> {
  const { data, error } = await asCaller(accessToken).rpc('record_stock_entry', {
    p_company_id: input.companyId,
    p_prize_id: input.prizeId,
    p_type: input.type,
    p_quantity: input.quantity,
    p_note: input.note,
    p_idempotency_key: input.idempotencyKey,
  });
  if (error) throw mapInventoryError(error.code, error.message);
  if (typeof data !== 'string') throw new InternalError('record_stock_entry returned no id');
  return data;
}

export interface StockExitInput {
  companyId: string;
  prizeId: string;
  quantity: number;
  note: string;
  idempotencyKey?: string;
}

export async function recordStockExit(input: StockExitInput, accessToken: string): Promise<string> {
  const { data, error } = await asCaller(accessToken).rpc('record_stock_exit', {
    p_company_id: input.companyId,
    p_prize_id: input.prizeId,
    p_quantity: input.quantity,
    p_note: input.note,
    p_idempotency_key: input.idempotencyKey,
  });
  if (error) throw mapInventoryError(error.code, error.message);
  if (typeof data !== 'string') throw new InternalError('record_stock_exit returned no id');
  return data;
}

export interface StockAdjustmentInput {
  companyId: string;
  prizeId: string;
  counted: number;
  note: string;
  idempotencyKey?: string;
}

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

export interface StockReservationInput {
  companyId: string;
  prizeId: string;
  quantity: number;
  note: string;
  idempotencyKey?: string;
}

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
  });
  if (error) throw mapInventoryError(error.code, error.message);
  if (typeof data !== 'string') throw new InternalError('reserve_stock returned no id');
  return data;
}

export async function releaseReservation(
  input: StockReservationInput,
  accessToken: string,
): Promise<string> {
  const { data, error } = await asCaller(accessToken).rpc('release_reservation', {
    p_company_id: input.companyId,
    p_prize_id: input.prizeId,
    p_quantity: input.quantity,
    p_note: input.note,
    p_idempotency_key: input.idempotencyKey,
  });
  if (error) throw mapInventoryError(error.code, error.message);
  if (typeof data !== 'string') throw new InternalError('release_reservation returned no id');
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
