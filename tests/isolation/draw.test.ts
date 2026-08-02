import { afterAll, describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { cleanupUsers, createPrizeAs, grantRoleWith, provisionCustomer, signInAs } from './harness';
import type { ProvisionedCustomer } from './harness';
import { runDrawAlgorithm, type DrawEntry, type DrawUnit } from '@/lib/draw/algorithm';
import type { Database } from '@/lib/supabase/database.types';

afterAll(cleanupUsers);

/**
 * THE TASK THE BLOCK'S AUDIT CLAIM RESTS ON.
 *
 * The draw runs in Postgres (apply_draw, 0078) and is recomputed here in
 * TypeScript (src/lib/draw/algorithm.ts) from nothing but the stored seed and
 * the frozen hat. The two are independent implementations of the same contract
 * (design spec 4.1) and this file is the only thing in the repository that
 * holds them to each other. If they ever disagree, "anybody holding the record
 * can recompute the winners" is false and no other test would notice.
 *
 * The operator driving every draw below holds draws.execute and promotions.view
 * and NOTHING ELSE -- in particular, not members.view. That is deliberate:
 * eligibility asks member_block_active (0076) rather than is_member_blocked,
 * precisely so that drawing does not silently require the permission for
 * reading the audience, and this is where that decoupling is proved across the
 * real HTTP boundary rather than in a pgTAP file running as postgres.
 */

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const LISTENERS = 12;
/** 6 listeners x 3 entries + 6 x 2 = 30 entries. Enough that agreement by chance is not plausible. */
const ENTRIES_BY_LISTENER = [3, 3, 3, 3, 3, 3, 2, 2, 2, 2, 2, 2];
const UNITS = 3;
const RUNNER_UPS = 4;

interface SeededDraw {
  drawId: string;
  promotionPrizeId: string;
  operatorClient: SupabaseClient<Database>;
}

/**
 * Builds a promotion with 30 valid entries across 12 listeners and 3 linked
 * units, then draws it as an operator who may draw and may do nothing else.
 *
 * Everything before the draw is fixture and runs as the owner, the convention
 * every other isolation file in this suite follows. The owner client is signed
 * in ONCE and reused: each signInAs is a real password verification, and doing
 * it per listener made this file take longer to authenticate than to test.
 */
async function seedAndDraw(customer: ProvisionedCustomer, label: string): Promise<SeededDraw> {
  const owner = await signInAs(customer.email, customer.password);

  const prizeId = await createPrizeAs(customer, `Prize ${label}`);

  const stock = await owner.rpc('record_stock_entry', {
    p_company_id: customer.companyId,
    p_prize_id: prizeId,
    p_type: 'MANUAL_ENTRY',
    p_quantity: UNITS,
  });
  expect(stock.error).toBeNull();

  const promotion = await owner.rpc('create_promotion', {
    p_company_id: customer.companyId,
    p_name: `Promo ${label}`,
    p_starts_at: new Date(Date.now() - 30 * DAY).toISOString(),
    p_ends_at: new Date(Date.now() + DAY).toISOString(),
    p_allow_multiple_entries: true,
    p_min_hours_between_entries: 1,
  });
  expect(promotion.error).toBeNull();
  const promotionId = promotion.data as string;

  const link = await owner.rpc('link_prize_to_promotion', {
    p_promotion_id: promotionId,
    p_prize_id: prizeId,
    p_quantity: UNITS,
  });
  expect(link.error).toBeNull();
  const promotionPrizeId = link.data as string;

  for (let i = 0; i < LISTENERS; i += 1) {
    const member = await owner.rpc('create_member', {
      p_company_id: customer.companyId,
      p_full_name: `Listener ${i + 1} ${label}`,
    });
    expect(member.error).toBeNull();
    const memberId = member.data as string;

    const entries = ENTRIES_BY_LISTENER[i] ?? 2;
    for (let k = 0; k < entries; k += 1) {
      // Spaced two hours apart, comfortably outside the one-hour minimum, so
      // every entry comes back VALID rather than TOO_SOON. The rule is measured
      // symmetrically around participated_at, so the spacing is what matters
      // and not the order they are written in.
      const participated = await owner.rpc('record_participation', {
        p_promotion_id: promotionId,
        p_member_id: memberId,
        p_participated_at: new Date(Date.now() - (2 + k * 2 + i * 24) * HOUR).toISOString(),
        p_source: 'MANUAL',
        p_answers: [],
      });
      expect(participated.error).toBeNull();
      expect(participated.data).toMatchObject({ status: 'VALID' });
    }
  }

  const operator = await grantRoleWith(customer, `draw-${label}`, [
    'draws.execute',
    'promotions.view',
  ]);
  const operatorClient = await signInAs(operator.email, operator.password);

  const drawn = await operatorClient.rpc('run_draw', {
    p_promotion_id: promotionId,
    p_units: null,
    p_runner_up_count: RUNNER_UPS,
  });
  expect(drawn.error).toBeNull();

  return { drawId: drawn.data as string, promotionPrizeId, operatorClient };
}

describe('the executor and the verifier agree', () => {
  // Three fresh promotions, so a single lucky seed cannot carry the claim.
  for (const round of [1, 2, 3]) {
    it(`recomputes the same winners and the same queue from the stored record (round ${round})`, async () => {
      const label = `draw-${round}-${Date.now()}`;
      const customer = await provisionCustomer(label);
      const { drawId, promotionPrizeId, operatorClient } = await seedAndDraw(customer, label);

      // Everything the verifier is allowed to know: the seed and the frozen hat.
      const draw = await operatorClient
        .from('draws')
        .select('seed, algorithm_version, entry_count, runner_up_count')
        .eq('id', drawId)
        .single();
      expect(draw.error).toBeNull();
      expect(draw.data?.seed).toMatch(/^[0-9a-f]{64}$/);
      expect(draw.data?.algorithm_version).toBe(1);
      expect(draw.data?.entry_count).toBe(30);

      const entryRows = await operatorClient
        .from('draw_entries')
        .select('participation_id, member_id, position')
        .eq('draw_id', drawId)
        .order('position');
      expect(entryRows.error).toBeNull();
      expect(entryRows.data).toHaveLength(30);
      expect(new Set((entryRows.data ?? []).map((e) => e.member_id)).size).toBe(LISTENERS);

      const entries: DrawEntry[] = (entryRows.data ?? []).map((row) => ({
        participationId: row.participation_id,
        memberId: row.member_id,
        position: row.position,
      }));

      // The unit sequence is derived from what the OPERATOR asked for -- one
      // link, three units -- and not read back off the winners. Reading it off
      // the winners would feed the executor's own answer into the verifier and
      // the comparison would prove nothing.
      const units: DrawUnit[] = Array.from({ length: UNITS }, (_, i) => ({
        promotionPrizeId,
        unitIndex: i + 1,
      }));

      const recomputed = runDrawAlgorithm({
        seed: draw.data?.seed ?? '',
        entries,
        units,
        runnerUpCount: RUNNER_UPS,
      });

      const winnerRows = await operatorClient
        .from('winners')
        .select('participation_id, member_id, awarded_rank')
        .eq('draw_id', drawId)
        .order('awarded_rank');
      expect(winnerRows.error).toBeNull();

      const queueRows = await operatorClient
        .from('draw_runners_up')
        .select('participation_id, member_id, position')
        .eq('draw_id', drawId)
        .order('position');
      expect(queueRows.error).toBeNull();

      // In ORDER, by participation_id. A set comparison would pass while the
      // two implementations disagreed about which unit went to whom.
      expect((winnerRows.data ?? []).map((w) => w.participation_id)).toEqual(
        recomputed.winners.map((w) => w.entry.participationId),
      );
      expect((queueRows.data ?? []).map((r) => r.participation_id)).toEqual(
        recomputed.runnersUp.map((r) => r.entry.participationId),
      );

      // And the outcome is the shape the rules require: three units awarded to
      // three different people (D2), a queue of four more, none of them
      // repeating a winner (D4).
      expect(winnerRows.data).toHaveLength(UNITS);
      expect(queueRows.data).toHaveLength(RUNNER_UPS);
      const people = [
        ...(winnerRows.data ?? []).map((w) => w.member_id),
        ...(queueRows.data ?? []).map((r) => r.member_id),
      ];
      expect(new Set(people).size).toBe(people.length);
    });
  }
});
