import 'server-only';
import { createClient } from '@supabase/supabase-js';
import { getUserSupabaseConfig } from '@/lib/supabase/config';
import {
  BusinessRuleError,
  ConflictError,
  InternalError,
  NotFoundError,
  UnauthorizedError,
  ValidationError,
} from '@/lib/errors';
import { keysetPage } from '@/lib/keyset';
import type { Cursor } from '@/lib/keyset';
import type { Database } from '@/lib/supabase/database.types';

export type WinnerStatus = Database['public']['Enums']['winner_status'];

function asCaller(accessToken: string) {
  return createClient<Database>(getUserSupabaseConfig().url, getUserSupabaseConfig().anonKey, {
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

export const PICKUP_PAGE_SIZE = 25;

/** The one bound on a search term, the same ceiling every other list in this codebase enforces. */
export const PICKUP_SEARCH_MAX_LENGTH = 100;

export interface PickupRow {
  winnerId: string;
  memberId: string;
  /**
   * Null in two situations list_pickups (0095) does not tell apart, on
   * purpose: an anonymised listener, and a caller who holds promotions.view
   * but not members.view (Rule 2). The generated Database type marks this
   * column non-null -- `supabase gen types` does not carry a table-returning
   * function's own nullability through -- but the SQL comment and the CASE
   * expression that produces it (0095:147-148) are unambiguous that it is.
   */
  memberName: string | null;
  memberPhone: string | null;
  prizeId: string;
  prizeName: string;
  allowsReturnToStock: boolean;
  promotionId: string;
  promotionName: string;
  status: WinnerStatus;
  /** Null means this winner has no deadline at all (0095's own header, mirroring 0075). */
  deadlineAt: string | null;
}

export interface PickupListParams {
  companyId: string;
  status?: WinnerStatus;
  promotionId?: string;
  /** By listener name or phone. Requires members.view, and returns nothing without it (0095 Rule 3). */
  search?: string;
  cursor: Cursor | null;
  cursorSide: 'after' | 'before';
}

export interface PickupListPage {
  rows: PickupRow[];
  nextCursor: string | null;
  previousCursor: string | null;
  total: number;
}

/**
 * One keyset page of the pickups list: every winner across every promotion of
 * a Station, soonest deadline first.
 *
 * Notably absent from PickupRow: a draw's own status. list_pickups (0095)
 * excludes a winner whose draw was CANCELLED outright (its header's "fifth
 * fact, not a fifth rule"), so every row this function can return already
 * belongs to a draw that stands -- there is no CANCELLED case for a caller of
 * this function to represent. availableWinnerActions (Block 6d Task 12)
 * still requires a drawStatus argument; what value a screen built on this
 * page should pass it is Task 9's decision, not this function's.
 *
 * `cursor` is a decoded `Cursor`, never a raw string -- decodeCursor
 * (@/lib/keyset) has already rejected a non-uuid id before this function is
 * called, which is what keeps `p_cursor_id` from ever reaching Postgres as a
 * value that raises 22P02 (Block 6d's own fix to that door, `fix(keyset): a
 * cursor id that is not a uuid starts the list over`).
 */
export async function listPickups(
  params: PickupListParams,
  accessToken: string,
): Promise<PickupListPage> {
  const walkingBack = params.cursorSide === 'before' && params.cursor !== null;
  const term = params.search?.trim().slice(0, PICKUP_SEARCH_MAX_LENGTH) || undefined;

  const { data, error } = await asCaller(accessToken).rpc('list_pickups', {
    p_company_id: params.companyId,
    p_status: params.status,
    p_promotion_id: params.promotionId,
    p_search: term,
    // Unlike listParticipationsPage's participated_at, a null cursor.value
    // here does NOT only mean "no cursor" -- 0095's own header distinguishes
    // "no cursor at all" (p_cursor_id null) from "the cursor sits in the
    // terminal null-deadline region" (p_cursor_id set, p_cursor_at null).
    // `?? undefined` still gives the right answer in both cases, because
    // list_pickups' own p_cursor_at DEFAULTS to null in its signature -- an
    // omitted argument and an explicit null reach the SQL body identically,
    // so which one this line sends is never what tells the two cases apart.
    // p_cursor_id is: it is set whenever cursor is non-null (Cursor.id is
    // never null) and omitted only when cursor itself is null.
    p_cursor_at: params.cursor?.value ?? undefined,
    p_cursor_id: params.cursor?.id,
    p_walking_back: walkingBack,
    p_limit: PICKUP_PAGE_SIZE + 1,
  });

  if (error) throw mapPickupError(error.code, error.message);

  const fetched = data ?? [];

  const { rows: page, nextCursor, previousCursor } = keysetPage(fetched, {
    pageSize: PICKUP_PAGE_SIZE,
    walkingBack,
    hadCursor: params.cursor !== null,
    cursorFor: (row) => ({ value: row.deadline_at, id: row.winner_id }),
  });

  return {
    rows: page.map((row) => ({
      winnerId: row.winner_id,
      memberId: row.member_id,
      memberName: row.member_name,
      memberPhone: row.member_phone,
      prizeId: row.prize_id,
      prizeName: row.prize_name,
      allowsReturnToStock: row.allows_return_to_stock,
      promotionId: row.promotion_id,
      promotionName: row.promotion_name,
      status: row.status,
      deadlineAt: row.deadline_at,
    })),
    nextCursor,
    previousCursor,
    total: Number(fetched[0]?.total_count ?? 0),
  };
}

export interface ReopenPickupDeadlineInput {
  winnerId: string;
  deadlineAt: string;
  reason: string;
}

/**
 * Gives a listener who turned up late another chance: the unit goes back to
 * awaiting_pickup, the winner back to AWAITING_PICKUP, deadline_at forward to
 * `deadlineAt` (0093).
 *
 * Both arguments are required by reopen_pickup_deadline's own signature --
 * unlike deliverPrize's optional note, there is no reading of this RPC where
 * either could be left out, so neither is typed `?` here.
 */
export async function reopenPickupDeadline(
  accessToken: string,
  input: ReopenPickupDeadlineInput,
): Promise<void> {
  const { error } = await asCaller(accessToken).rpc('reopen_pickup_deadline', {
    p_winner_id: input.winnerId,
    p_deadline_at: input.deadlineAt,
    p_reason: input.reason,
  });
  if (error) throw mapPickupError(error.code, error.message);
}

/**
 * Shared by listPickups and reopenPickupDeadline, over the same five codes
 * services/winners.ts maps for its own siblings -- kept the same shape for
 * consistency, though only two are presently reachable through these two
 * functions:
 *
 * - `42501` is real for both: list_pickups refuses a caller without
 *   promotions.view (Rule 1), and reopen_pickup_deadline refuses both an
 *   unknown winner id AND a Station the caller holds nothing in with this
 *   SAME code, on purpose (0093's header) -- it does not raise P0002 for a
 *   missing id the way return_prize/write_off_prize do, because doing so
 *   would tell an unauthorised caller whether the id exists. A message
 *   reading "permission denied" for a typo is that door's deliberate shape,
 *   not a mapping bug.
 * - `22023` is real for reopen_pickup_deadline alone: a blank reason, a
 *   deadline at or before now, or a source winner that is not RETURN_PENDING
 *   (apply_winner_transition's own top guard, 0092).
 * - `P0002`, `23505` and `23514` are not raised by either function as read
 *   here -- list_pickups raises only 42501, and reopen_pickup_deadline's own
 *   existence check is folded into its 42501 above rather than left to
 *   apply_winner_transition's P0002. Mapped anyway, for the same reason
 *   mapParticipationError maps codes it has not yet seen a live path for:
 *   an unmapped code is a 500 for a refusal the schema already writes a
 *   sentence for.
 */
function mapPickupError(code: string | undefined, message: string): Error {
  if (code === '22023') return new ValidationError(message);
  if (code === '23514') return new BusinessRuleError(message);
  if (code === '23505') return new ConflictError(message);
  if (code === 'P0002') return new NotFoundError(message);
  if (code === '42501') return new UnauthorizedError(message);
  return new InternalError(message);
}
