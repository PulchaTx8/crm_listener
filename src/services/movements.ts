import 'server-only';
import { createClient } from '@supabase/supabase-js';
import { getUserSupabaseConfig } from '@/lib/supabase/config';
import { InternalError, UnauthorizedError } from '@/lib/errors';
import { keysetPage } from '@/lib/keyset';
import type { Cursor } from '@/lib/keyset';
import type { Database } from '@/lib/supabase/database.types';
import type { InventoryBucket, InventoryMovementType } from '@/services/inventory';

function asCaller(accessToken: string) {
  return createClient<Database>(getUserSupabaseConfig().url, getUserSupabaseConfig().anonKey, {
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

export const MOVEMENT_PAGE_SIZE = 25;

export interface MovementRow {
  movementId: string;
  createdAt: string;
  movementType: InventoryMovementType;
  quantity: number;
  /** Null means "outside the Station" (0026's own column comment): a stock entry has no from, an exit no to. */
  fromBucket: InventoryBucket | null;
  toBucket: InventoryBucket | null;
  prizeId: string;
  prizeName: string;
  /**
   * Null means this movement names no promotion at all (a purchase entry or
   * a stock adjustment) -- never "not yours to see" (0096's header). The
   * generated Database type marks this column non-null; it is not, at
   * runtime, for that case.
   */
  promotionId: string | null;
  /**
   * Null for the SAME reason as promotionId when there is no promotion, OR
   * because the promotion is archived and this caller is not the
   * Organization's owner -- promotionArchived, below, is what tells those two
   * nulls apart. NEVER key an "(archived)" label off this being null alone.
   */
  promotionName: string | null;
  /** False, never null, when there is no promotion at all (0096's own guarantee). */
  promotionArchived: boolean;
  /** Null is the deadline sweep (0094, pg_cron, no auth.uid()) -- never a human. */
  actorId: string | null;
  /**
   * Null does NOT by itself mean "the clock did it": a human operator with no
   * display name on record also has a null actor_name. actorId is what
   * distinguishes the two (0096's header, restated here because a consumer
   * that keys its "(deadline)" label off actorName instead would be wrong for
   * a nameless human).
   */
  actorName: string | null;
  note: string | null;
}

export interface MovementListParams {
  companyId: string;
  type?: InventoryMovementType;
  prizeId?: string;
  promotionId?: string;
  from?: string;
  to?: string;
  cursor: Cursor | null;
  cursorSide: 'after' | 'before';
}

export interface MovementListPage {
  rows: MovementRow[];
  nextCursor: string | null;
  previousCursor: string | null;
  total: number;
}

/**
 * One keyset page of a Station's whole inventory ledger, newest first
 * (list_movements, 0096).
 *
 * Unlike listPickups' deadline_at, created_at is NOT NULL (0026) on every
 * row, so there is no terminal null region for the cursor to reach
 * separately -- `cursor.value` is always a real instant once `cursor` itself
 * is non-null, the same shape listParticipationsPage's own participated_at
 * cursor already has.
 */
export async function listMovements(
  params: MovementListParams,
  accessToken: string,
): Promise<MovementListPage> {
  const walkingBack = params.cursorSide === 'before' && params.cursor !== null;

  const { data, error } = await asCaller(accessToken).rpc('list_movements', {
    p_company_id: params.companyId,
    p_type: params.type,
    p_prize_id: params.prizeId,
    p_promotion_id: params.promotionId,
    p_from: params.from,
    p_to: params.to,
    p_cursor_at: params.cursor?.value ?? undefined,
    p_cursor_id: params.cursor?.id,
    p_walking_back: walkingBack,
    p_limit: MOVEMENT_PAGE_SIZE + 1,
  });

  if (error) throw mapMovementError(error.code, error.message);

  const fetched = data ?? [];

  const { rows: page, nextCursor, previousCursor } = keysetPage(fetched, {
    pageSize: MOVEMENT_PAGE_SIZE,
    walkingBack,
    hadCursor: params.cursor !== null,
    cursorFor: (row) => ({ value: row.created_at, id: row.movement_id }),
  });

  return {
    rows: page.map((row) => ({
      movementId: row.movement_id,
      createdAt: row.created_at,
      movementType: row.movement_type,
      quantity: row.quantity,
      fromBucket: row.from_bucket,
      toBucket: row.to_bucket,
      prizeId: row.prize_id,
      prizeName: row.prize_name,
      promotionId: row.promotion_id,
      promotionName: row.promotion_name,
      promotionArchived: row.promotion_archived,
      actorId: row.actor_id,
      actorName: row.actor_name,
      note: row.note,
    })),
    nextCursor,
    previousCursor,
    total: Number(fetched[0]?.total_count ?? 0),
  };
}

/**
 * list_movements (0096) raises exactly one code, read off its single `raise
 * exception`: `42501` when the caller lacks inventory.view at this Station.
 * Everything else falls to InternalError -- unlike services/winners.ts and
 * services/pickups.ts this function has no sibling RPC to share a five-code
 * mapper with, and claiming codes this function cannot actually raise would
 * be the same overclaim this block's reviews have already sent back once.
 */
function mapMovementError(code: string | undefined, message: string): Error {
  if (code === '42501') return new UnauthorizedError(message);
  return new InternalError(message);
}
