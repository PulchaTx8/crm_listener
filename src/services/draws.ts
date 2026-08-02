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
import type { Database } from '@/lib/supabase/database.types';

/**
 * A client bound to the caller's JWT, the reason services/promotions.ts gives
 * for its own: run_draw, cancel_draw, list_draws and get_draw each re-check
 * the caller's permission against auth.uid() inside a SECURITY DEFINER body,
 * so calling one with the service key would defeat the check it exists to make.
 */
function asCaller(accessToken: string) {
  const { url, anonKey } = getUserSupabaseConfig();
  return createClient<Database>(url, anonKey, {
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

/** The default the button offers, and the default run_draw itself carries (D4). */
export const DEFAULT_RUNNER_UP_COUNT = 3;

export interface DrawSummary {
  id: string;
  drawnAt: string;
  status: 'COMPLETED' | 'CANCELLED';
  entryCount: number;
  runnerUpCount: number;
  algorithmVersion: number;
  seed: string;
  winnerCount: number;
  cancelledAt: string | null;
  cancellationReason: string | null;
}

export interface DrawWinner {
  id: string;
  awardedRank: number;
  memberId: string;
  /** Null when the caller does not hold members.view — see `showsNames`. */
  memberName: string | null;
  participationId: string;
  promotionPrizeId: string;
  prizeName: string;
  deadlineAt: string | null;
  status: string;
}

export interface DrawRunnerUp {
  position: number;
  memberId: string;
  memberName: string | null;
  participationId: string;
}

export interface DrawDetail {
  id: string;
  promotionId: string;
  seed: string;
  algorithmVersion: number;
  entryCount: number;
  runnerUpCount: number;
  status: 'COMPLETED' | 'CANCELLED';
  drawnAt: string;
  cancelledAt: string | null;
  cancellationReason: string | null;
  /**
   * Whether the caller may see listeners' names at all. Carried from the RPC
   * rather than inferred from a null name, so the screen can say "not visible
   * to you" instead of rendering a blank that reads as missing data.
   */
  showsNames: boolean;
  winners: DrawWinner[];
  runnersUp: DrawRunnerUp[];
}

export interface DrawUnitRequest {
  promotionPrizeId: string;
  quantity: number;
}

/**
 * The codes 0078/0079/0080 raise, mapped the way services/promotions.ts maps
 * the same set. `22023` is every refusal those functions make with a sentence
 * — not enough units, nobody eligible, a cancelled promotion, a blank
 * cancellation reason, a draw already cancelled, a prize already handed over.
 * `23514` is the ledger's own sufficiency check underneath.
 */
function mapDrawError(code: string | undefined, message: string): Error {
  if (code === '22023') return new ValidationError(message);
  if (code === '23514') return new BusinessRuleError(message);
  if (code === '23505') return new ConflictError(message);
  if (code === '23P01') return new ConflictError(message);
  if (code === 'P0002') return new NotFoundError(message);
  if (code === '42501') return new UnauthorizedError(message);
  return new InternalError(message);
}

export async function runDraw(
  accessToken: string,
  input: {
    promotionId: string;
    units: DrawUnitRequest[] | null;
    runnerUpCount: number;
  },
): Promise<string> {
  const { data, error } = await asCaller(accessToken).rpc('run_draw', {
    p_promotion_id: input.promotionId,
    // Null and an empty list mean the same thing to run_draw — every unit still
    // available on every live link (D8) — and the screen sends null for it, so
    // an empty array from a form that rendered no rows cannot read as "draw
    // everything" by accident somewhere else later.
    p_units: input.units && input.units.length > 0
      ? input.units.map((unit) => ({
          promotion_prize_id: unit.promotionPrizeId,
          quantity: unit.quantity,
        }))
      : null,
    p_runner_up_count: input.runnerUpCount,
  });

  if (error) throw mapDrawError(error.code, error.message);
  if (!data) throw new InternalError('The draw ran but returned no id.');
  return data as string;
}

export async function cancelDraw(
  accessToken: string,
  input: { drawId: string; reason: string },
): Promise<void> {
  const { error } = await asCaller(accessToken).rpc('cancel_draw', {
    p_draw_id: input.drawId,
    p_reason: input.reason,
  });

  if (error) throw mapDrawError(error.code, error.message);
}

export async function listDraws(
  accessToken: string,
  promotionId: string,
): Promise<DrawSummary[]> {
  const { data, error } = await asCaller(accessToken).rpc('list_draws', {
    p_promotion_id: promotionId,
  });

  if (error) throw mapDrawError(error.code, error.message);

  return (data ?? []).map((row) => ({
    id: row.id,
    drawnAt: row.drawn_at,
    status: row.status,
    entryCount: row.entry_count,
    runnerUpCount: row.runner_up_count,
    algorithmVersion: row.algorithm_version,
    seed: row.seed,
    winnerCount: row.winner_count,
    cancelledAt: row.cancelled_at,
    cancellationReason: row.cancellation_reason,
  }));
}

export async function getDraw(accessToken: string, drawId: string): Promise<DrawDetail> {
  const { data, error } = await asCaller(accessToken).rpc('get_draw', {
    p_draw_id: drawId,
  });

  if (error) throw mapDrawError(error.code, error.message);
  if (!data) throw new NotFoundError('That draw could not be found.');

  const body = data as Record<string, unknown>;
  const winners = (body.winners ?? []) as Record<string, unknown>[];
  const runnersUp = (body.runners_up ?? []) as Record<string, unknown>[];

  return {
    id: String(body.id),
    promotionId: String(body.promotion_id),
    seed: String(body.seed),
    algorithmVersion: Number(body.algorithm_version),
    entryCount: Number(body.entry_count),
    runnerUpCount: Number(body.runner_up_count),
    status: body.status as 'COMPLETED' | 'CANCELLED',
    drawnAt: String(body.drawn_at),
    cancelledAt: (body.cancelled_at as string | null) ?? null,
    cancellationReason: (body.cancellation_reason as string | null) ?? null,
    showsNames: body.shows_names === true,
    winners: winners.map((w) => ({
      id: String(w.id),
      awardedRank: Number(w.awarded_rank),
      memberId: String(w.member_id),
      memberName: (w.member_name as string | null) ?? null,
      participationId: String(w.participation_id),
      promotionPrizeId: String(w.promotion_prize_id),
      prizeName: String(w.prize_name),
      deadlineAt: (w.deadline_at as string | null) ?? null,
      status: String(w.status),
    })),
    runnersUp: runnersUp.map((r) => ({
      position: Number(r.position),
      memberId: String(r.member_id),
      memberName: (r.member_name as string | null) ?? null,
      participationId: String(r.participation_id),
    })),
  };
}
