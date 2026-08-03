import { afterAll, describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  admin,
  cleanupUsers,
  createPrizeAs,
  grantRoleWith,
  provisionCustomer,
  signInAs,
} from './harness';
import type { ProvisionedCustomer } from './harness';
import { runDrawAlgorithm, type DrawEntry, type DrawUnit } from '@/lib/draw/algorithm';
import { drainStorageErasures } from '@/lib/storage/erasure';
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
        .select('seed, algorithm_version, entry_count')
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
      });

      const winnerRows = await operatorClient
        .from('winners')
        .select('participation_id, member_id, awarded_rank')
        .eq('draw_id', drawId)
        .order('awarded_rank');
      expect(winnerRows.error).toBeNull();

      // In ORDER, by participation_id. A set comparison would pass while the
      // two implementations disagreed about which unit went to whom.
      expect((winnerRows.data ?? []).map((w) => w.participation_id)).toEqual(
        recomputed.winners.map((w) => w.entry.participationId),
      );
      // And the outcome is the shape the rule requires: three units awarded to
      // three DIFFERENT people, which is one person one prize falling out of
      // the walk rather than being enforced beside it.
      expect(winnerRows.data).toHaveLength(UNITS);
      const people = (winnerRows.data ?? []).map((w) => w.member_id);
      expect(new Set(people).size).toBe(people.length);
    });
  }
});

/**
 * A minimal drawn promotion: two listeners, one entry each, `units` linked.
 * Small on purpose — the cases below run it a dozen times, and what they are
 * testing is contention and grants, not the size of the hat.
 */
async function seedSmallPromotion(
  customer: ProvisionedCustomer,
  label: string,
  units: number,
): Promise<{ promotionId: string; promotionPrizeId: string; prizeId: string }> {
  const owner = await signInAs(customer.email, customer.password);
  const prizeId = await createPrizeAs(customer, `Prize ${label}`);

  await owner.rpc('record_stock_entry', {
    p_company_id: customer.companyId,
    p_prize_id: prizeId,
    p_type: 'MANUAL_ENTRY',
    p_quantity: units,
  });

  const promotion = await owner.rpc('create_promotion', {
    p_company_id: customer.companyId,
    p_name: `Promo ${label}`,
    p_starts_at: new Date(Date.now() - 30 * DAY).toISOString(),
    p_ends_at: new Date(Date.now() + DAY).toISOString(),
  });
  const promotionId = promotion.data as string;

  const link = await owner.rpc('link_prize_to_promotion', {
    p_promotion_id: promotionId,
    p_prize_id: prizeId,
    p_quantity: units,
  });
  const promotionPrizeId = link.data as string;

  for (let i = 0; i < 2; i += 1) {
    const member = await owner.rpc('create_member', {
      p_company_id: customer.companyId,
      p_full_name: `Listener ${i + 1} ${label}`,
    });
    await owner.rpc('record_participation', {
      p_promotion_id: promotionId,
      p_member_id: member.data as string,
      p_participated_at: new Date(Date.now() - (i + 1) * HOUR).toISOString(),
      p_source: 'MANUAL',
      p_answers: [],
    });
  }

  return { promotionId, promotionPrizeId, prizeId };
}

/**
 * THE BOUNDARY, per Block 5a's hardest lesson.
 *
 * That block shipped three tables carrying a comment about who could reach
 * them and no grant behind it. pgTAP runs as postgres and ignores ACLs
 * entirely, so every assertion stayed green while every write returned 42501
 * in production. 09_draws.test.sql asks the catalogue; these cases issue the
 * actual reads the application issues, over HTTP, as both roles that make them.
 */
describe('the four new tables across the HTTP boundary', () => {
  it('answers the reads the application makes, as service_role and as a signed-in operator', async () => {
    const label = `boundary-${Date.now()}`;
    const customer = await provisionCustomer(label);
    const { promotionId } = await seedSmallPromotion(customer, label, 1);

    const operator = await grantRoleWith(customer, `boundary-${label}`, [
      'draws.execute',
      'draws.cancel',
      'promotions.view',
    ]);
    const operatorClient = await signInAs(operator.email, operator.password);

    const drawn = await operatorClient.rpc('run_draw', {
      p_promotion_id: promotionId,
      p_units: null,
    });
    expect(drawn.error).toBeNull();
    const drawId = drawn.data as string;

    // service_role holds no policy exemption it was not granted: BYPASSRLS is
    // not a grant, and this is the half Block 5a proved by omission.
    // draws keys on id; the three children key on draw_id. Asked separately
    // rather than through one loop over a union of table names, because that
    // union makes every column name legal on every table to the type checker
    // and a typo in one of them would compile.
    const adminDraw = await admin.from('draws').select('*').eq('id', drawId);
    expect(adminDraw.error, 'service_role read of draws').toBeNull();
    expect(adminDraw.data, 'service_role rows in draws').toHaveLength(1);

    const adminEntries = await admin.from('draw_entries').select('*').eq('draw_id', drawId);
    expect(adminEntries.error, 'service_role read of draw_entries').toBeNull();
    expect((adminEntries.data ?? []).length).toBeGreaterThan(0);

    const adminWinners = await admin.from('winners').select('*').eq('draw_id', drawId);
    expect(adminWinners.error, 'service_role read of winners').toBeNull();
    expect((adminWinners.data ?? []).length).toBeGreaterThan(0);

    const operatorDraw = await operatorClient.from('draws').select('*').eq('id', drawId);
    expect(operatorDraw.error).toBeNull();
    expect(operatorDraw.data).toHaveLength(1);

    for (const table of ['draw_entries', 'winners'] as const) {
      const result = await operatorClient.from(table).select('*').eq('draw_id', drawId);
      expect(result.error, `operator read of ${table}`).toBeNull();
      expect((result.data ?? []).length, `operator rows in ${table}`).toBeGreaterThan(0);
    }

    // And the two reads the screen actually calls.
    const list = await operatorClient.rpc('list_draws', { p_promotion_id: promotionId });
    expect(list.error).toBeNull();
    expect(list.data).toHaveLength(1);

    const detail = await operatorClient.rpc('get_draw', { p_draw_id: drawId });
    expect(detail.error).toBeNull();

    const cancelled = await operatorClient.rpc('cancel_draw', {
      p_draw_id: drawId,
      p_reason: 'proving the write door as well as the read doors',
    });
    expect(cancelled.error).toBeNull();
  });
});

/**
 * TWO DRAWS AT ONCE.
 *
 * One promotion, one unit, two run_draw calls in flight together. Exactly one
 * may win. Asserting the count alone could not tell "the lock worked" from
 * "the constraint caught what the lock should have prevented", so the outcome
 * PAIR is asserted too — one success and one refusal — the way
 * participations.test.ts does it.
 */
describe('two draws at once', () => {
  const ROUNDS = 12;

  it(`lets exactly one of two concurrent draws spend the unit, ${ROUNDS} times over`, async () => {
    const label = `race-${Date.now()}`;
    const customer = await provisionCustomer(label);
    const operator = await grantRoleWith(customer, `race-${label}`, [
      'draws.execute',
      'promotions.view',
    ]);
    const operatorClient = await signInAs(operator.email, operator.password);

    for (let round = 0; round < ROUNDS; round += 1) {
      const { promotionId, promotionPrizeId } = await seedSmallPromotion(
        customer,
        `${label}-${round}`,
        1,
      );

      const [first, second] = await Promise.all([
        operatorClient.rpc('run_draw', {
          p_promotion_id: promotionId,
          p_units: null,
        }),
        operatorClient.rpc('run_draw', {
          p_promotion_id: promotionId,
          p_units: null,
        }),
      ]);

      const succeeded = [first, second].filter((r) => r.error === null);
      const refused = [first, second].filter((r) => r.error !== null);

      expect(succeeded, `round ${round}: exactly one draw may succeed`).toHaveLength(1);
      expect(refused, `round ${round}: the other must be refused`).toHaveLength(1);

      // WHICH refusal, and this is the assertion that makes the case reach the
      // contested code at all. "One succeeded and one failed" holds whether the
      // FOR UPDATE on the promotion worked or the ledger's own sufficiency
      // check caught the loser several steps later -- so on its own it cannot
      // tell the lock working from the constraint cleaning up after it.
      //
      // With the lock, the loser is refused by apply_draw itself: it reads
      // linked - drawn AFTER the winner committed, sees nothing left, and says
      // so with 22023. Without it, both read the same balance, both pass that
      // check, and the loser gets 23514 from apply_inventory_movement instead.
      expect(
        refused[0]?.error?.code,
        `round ${round}: refused by the draw, not by the ledger`,
      ).toBe('22023');

      const balance = await admin
        .from('promotion_prize_balances')
        .select('linked, drawn')
        .eq('promotion_prize_id', promotionPrizeId)
        .single();
      expect(balance.data?.drawn, `round ${round}: one unit drawn`).toBe(1);
      expect(balance.data?.linked, `round ${round}: linked untouched`).toBe(1);

      const winners = await admin
        .from('winners')
        .select('id')
        .eq('draw_id', succeeded[0]?.data as string);
      expect(winners.data, `round ${round}: one winner`).toHaveLength(1);
    }
  });
});

/**
 * THE ERASURE, END TO END.
 *
 * anonymize_member clears the reference and queues the object; only the storage
 * API can delete the bytes, because removing a row from storage.objects takes
 * the metadata and leaves the file. So the claim this case makes is about the
 * FILE — asserting that a queue row was written would prove the mechanism ran
 * and say nothing about whether the promise was kept.
 */
describe('erasing a listener reaches their delivery receipt', () => {
  it('deletes the object from the bucket, not merely the row that points at it', async () => {
    const label = `erasure-${Date.now()}`;
    const customer = await provisionCustomer(label);
    const { promotionId } = await seedSmallPromotion(customer, label, 1);

    const operator = await grantRoleWith(customer, `erasure-${label}`, [
      'draws.execute',
      'promotions.view',
      'winners.deliver',
    ]);
    const operatorClient = await signInAs(operator.email, operator.password);

    const drawn = await operatorClient.rpc('run_draw', {
      p_promotion_id: promotionId,
      p_units: null,
    });
    expect(drawn.error).toBeNull();

    const winner = await admin
      .from('winners')
      .select('id, member_id')
      .eq('draw_id', drawn.data as string)
      .single();
    expect(winner.error).toBeNull();
    const winnerId = winner.data?.id as string;

    const delivered = await operatorClient.rpc('deliver_prize', { p_winner_id: winnerId });
    expect(delivered.error).toBeNull();

    // A real object, in the real bucket, at the path the policies expect.
    const path = `${customer.companyId}/${winnerId}/receipt.txt`;
    const uploaded = await admin.storage
      .from('delivery-receipts')
      .upload(path, new Blob(['a signature']), { contentType: 'text/plain' });
    expect(uploaded.error).toBeNull();

    const attached = await operatorClient.rpc('attach_delivery_receipt', {
      p_winner_id: winnerId,
      p_path: path,
    });
    expect(attached.error).toBeNull();

    // It is really there before the erasure, so "gone" afterwards means something.
    const before = await admin.storage.from('delivery-receipts').download(path);
    expect(before.error).toBeNull();

    const owner = await signInAs(customer.email, customer.password);
    const erased = await owner.rpc('anonymize_member', {
      p_member_id: winner.data?.member_id as string,
      p_reason: 'subject_request',
    });
    expect(erased.error).toBeNull();

    // The reference is gone immediately; the file is not, and that gap is
    // exactly why the queue exists.
    const cleared = await admin
      .from('winners')
      .select('receipt_path, receipt_erased_at')
      .eq('id', winnerId)
      .single();
    expect(cleared.data?.receipt_path).toBeNull();
    expect(cleared.data?.receipt_erased_at).not.toBeNull();

    const stillThere = await admin.storage.from('delivery-receipts').download(path);
    expect(stillThere.error, 'the file outlives the SQL, which is the whole point').toBeNull();

    const drained = await drainStorageErasures(admin);
    expect(drained.deleted).toBeGreaterThanOrEqual(1);
    expect(drained.failed).toBe(0);

    const afterwards = await admin.storage.from('delivery-receipts').download(path);
    expect(afterwards.error, 'the object is gone from the bucket').not.toBeNull();
  });
});

/**
 * THE BOUNDARY, for Block 6b's two tables and its bucket.
 *
 * 10_delivery.test.sql asks the catalogue whether the grants are there; this
 * issues the reads and writes the application issues, over HTTP, as both roles
 * that make them. pgTAP runs as postgres and cannot see a missing grant — and
 * on storage.objects it is blind twice over, because the policies are the only
 * thing standing between a private bucket and everybody.
 */
describe('block 6b across the HTTP boundary', () => {
  it('answers the delivery reads and writes as service_role and as a signed-in operator', async () => {
    const label = `deliv-boundary-${Date.now()}`;
    const customer = await provisionCustomer(label);
    const { promotionId } = await seedSmallPromotion(customer, label, 1);

    const operator = await grantRoleWith(customer, `deliv-${label}`, [
      'draws.execute',
      'promotions.view',
      'winners.deliver',
      'winners.deliver_cancel',
    ]);
    const operatorClient = await signInAs(operator.email, operator.password);

    const drawn = await operatorClient.rpc('run_draw', {
      p_promotion_id: promotionId,
      p_units: null,
    });
    expect(drawn.error).toBeNull();

    const winner = await admin
      .from('winners')
      .select('id')
      .eq('draw_id', drawn.data as string)
      .single();
    const winnerId = winner.data?.id as string;

    expect((await operatorClient.rpc('deliver_prize', { p_winner_id: winnerId })).error).toBeNull();

    // The operator writes a receipt through the bucket's own policy, on their
    // own token. The service key would bypass the policy and prove nothing.
    const path = `${customer.companyId}/${winnerId}/boundary.txt`;
    const uploaded = await operatorClient.storage
      .from('delivery-receipts')
      .upload(path, new Blob(['ok']), { contentType: 'text/plain' });
    expect(uploaded.error, 'an operator holding winners.deliver may write a receipt').toBeNull();

    expect(
      (await operatorClient.rpc('attach_delivery_receipt', { p_winner_id: winnerId, p_path: path }))
        .error,
    ).toBeNull();

    const signed = await operatorClient.storage.from('delivery-receipts').createSignedUrl(path, 60);
    expect(signed.error, 'and may read it back through a signed URL').toBeNull();

    // The history is what the screen shows; the queue is service_role's alone.
    const historyAsOperator = await operatorClient
      .from('winner_status_history')
      .select('from_status, to_status')
      .eq('winner_id', winnerId);
    expect(historyAsOperator.error).toBeNull();
    expect((historyAsOperator.data ?? []).length).toBeGreaterThan(0);

    const queueAsAdmin = await admin.from('storage_erasure_queue').select('id').limit(1);
    expect(queueAsAdmin.error, 'service_role may drain the erasure queue').toBeNull();

    const queueAsOperator = await operatorClient.from('storage_erasure_queue').select('id');
    // RLS on with no policy: an authenticated caller reads nothing, and that is
    // the whole design. Asserting emptiness rather than an error, because
    // PostgREST answers a policy-less table with zero rows, not a 403.
    expect(queueAsOperator.data ?? []).toHaveLength(0);
  });
});

/**
 * TWO OPERATORS, ONE WINNER.
 *
 * Same shape as the two-draws case above, and the same lesson: asserting that
 * one call failed is not enough. With the FOR UPDATE in apply_winner_transition
 * the loser is refused by the transition check with 22023; without it, both
 * read AWAITING_PICKUP, both pass, and the loser is caught by the ledger's own
 * sufficiency check with 23514 several steps later. Only the code tells those
 * apart.
 */
describe('two operators delivering one prize', () => {
  const ROUNDS = 12;

  it(`lets exactly one delivery win, ${ROUNDS} times over`, async () => {
    const label = `deliv-race-${Date.now()}`;
    const customer = await provisionCustomer(label);
    const operator = await grantRoleWith(customer, `deliv-race-${label}`, [
      'draws.execute',
      'promotions.view',
      'winners.deliver',
    ]);
    const operatorClient = await signInAs(operator.email, operator.password);

    for (let round = 0; round < ROUNDS; round += 1) {
      const { promotionId } = await seedSmallPromotion(customer, `${label}-${round}`, 1);
      const drawn = await operatorClient.rpc('run_draw', {
        p_promotion_id: promotionId,
        p_units: null,
      });
      const winner = await admin
        .from('winners')
        .select('id')
        .eq('draw_id', drawn.data as string)
        .single();
      const winnerId = winner.data?.id as string;

      const [first, second] = await Promise.all([
        operatorClient.rpc('deliver_prize', { p_winner_id: winnerId }),
        operatorClient.rpc('deliver_prize', { p_winner_id: winnerId }),
      ]);

      const succeeded = [first, second].filter((r) => r.error === null);
      const refused = [first, second].filter((r) => r.error !== null);

      expect(succeeded, `round ${round}: exactly one delivery may win`).toHaveLength(1);
      expect(refused, `round ${round}: the other must be refused`).toHaveLength(1);
      expect(
        refused[0]?.error?.code,
        `round ${round}: refused by the transition check, not by the ledger`,
      ).toBe('22023');

      const history = await admin
        .from('winner_status_history')
        .select('id')
        .eq('winner_id', winnerId);
      expect(history.data, `round ${round}: one transition, one history row`).toHaveLength(1);
    }
  });
});

/**
 * THE ROUND, END TO END — Block 6c.
 *
 * Everything the participants screen does, over HTTP, as the operator who does
 * it: read the list filtered to the people who answered the quiz correctly,
 * hand those ids to `run_draw`, and then do it again — proving that the winner
 * of the first round is gone from the second, and that naming them anyway is
 * refused rather than quietly dropped.
 *
 * The two halves have to be one case. Proving the list excludes a past winner
 * and separately proving `run_draw` refuses one would leave the thing that
 * matters untested: that they are the SAME definition (0076), so the set the
 * operator sees and the set the database accepts cannot drift.
 *
 * The operator holds participations.view, promotions.view and draws.execute,
 * and NOT members.view — which is how this also pins the branch inside
 * `list_participations` (0090) that lists every row while withholding the three
 * listener fields.
 */
interface QuizPromotion {
  promotionId: string;
  promotionPrizeId: string;
  questionId: string;
  rightOptionId: string;
  wrongOptionId: string;
  /** The participation ids of the listeners who got it right, and of those who did not. */
  right: string[];
  wrong: string[];
}

/**
 * A promotion asking ONE quiz question, with `right` listeners answering it
 * correctly and `wrong` listeners not, one entry each, and `units` linked.
 */
async function seedQuizPromotion(
  customer: ProvisionedCustomer,
  label: string,
  counts: { right: number; wrong: number; units: number },
): Promise<QuizPromotion> {
  const owner = await signInAs(customer.email, customer.password);
  const prizeId = await createPrizeAs(customer, `Prize ${label}`);

  expect(
    (
      await owner.rpc('record_stock_entry', {
        p_company_id: customer.companyId,
        p_prize_id: prizeId,
        p_type: 'MANUAL_ENTRY',
        p_quantity: counts.units,
      })
    ).error,
  ).toBeNull();

  const promotion = await owner.rpc('create_promotion', {
    p_company_id: customer.companyId,
    p_name: `Promo ${label}`,
    p_starts_at: new Date(Date.now() - 30 * DAY).toISOString(),
    p_ends_at: new Date(Date.now() + DAY).toISOString(),
  });
  expect(promotion.error).toBeNull();
  const promotionId = promotion.data as string;

  const link = await owner.rpc('link_prize_to_promotion', {
    p_promotion_id: promotionId,
    p_prize_id: prizeId,
    p_quantity: counts.units,
  });
  expect(link.error).toBeNull();
  const promotionPrizeId = link.data as string;

  // A QUIZ, because that is the only kind with a right answer:
  // promotion_participation_correctness (0089) answers true for everybody on a
  // poll, and the difference between the two is the whole of these cases.
  // menu_title and button_label are not decoration — promotion_questions_list_fields
  // (0041) refuses anything carrying options without them.
  const question = await owner.rpc('save_promotion_question', {
    p_promotion_id: promotionId,
    p_kind: 'QUIZ',
    p_prompt: `Which one, ${label}?`,
    p_menu_title: 'Answer',
    p_button_label: 'Choose',
    p_options: [
      { label: 'The right one', is_correct: true },
      { label: 'The other one', is_correct: false },
    ],
  });
  expect(question.error).toBeNull();
  const questionId = question.data as string;

  const options = await owner
    .from('promotion_question_options')
    .select('id, is_correct')
    .eq('question_id', questionId);
  expect(options.error).toBeNull();
  const rightOptionId = (options.data ?? []).find((o) => o.is_correct)?.id as string;
  const wrongOptionId = (options.data ?? []).find((o) => !o.is_correct)?.id as string;
  expect(rightOptionId).toBeTruthy();
  expect(wrongOptionId).toBeTruthy();

  const right: string[] = [];
  const wrong: string[] = [];
  const people = [
    ...Array.from({ length: counts.right }, (_, i) => ({ correct: true, i })),
    ...Array.from({ length: counts.wrong }, (_, i) => ({ correct: false, i: counts.right + i })),
  ];

  for (const person of people) {
    const member = await owner.rpc('create_member', {
      p_company_id: customer.companyId,
      p_full_name: `${person.correct ? 'Right' : 'Wrong'} ${person.i + 1} ${label}`,
    });
    expect(member.error).toBeNull();

    const recorded = await owner.rpc('record_participation', {
      p_promotion_id: promotionId,
      p_member_id: member.data as string,
      p_participated_at: new Date(Date.now() - (person.i + 1) * HOUR).toISOString(),
      p_source: 'MANUAL',
      p_answers: [
        { question_id: questionId, option_id: person.correct ? rightOptionId : wrongOptionId },
      ],
    });
    expect(recorded.error).toBeNull();
    const participationId = (recorded.data as { participation_id: string }).participation_id;
    (person.correct ? right : wrong).push(participationId);
  }

  return { promotionId, promotionPrizeId, questionId, rightOptionId, wrongOptionId, right, wrong };
}

describe('a whole round, filtered and drawn from the list', () => {
  it('draws the ids the list gave, and refuses them again in the next round', async () => {
    const label = `round-${Date.now()}`;
    const customer = await provisionCustomer(label);
    const promotion = await seedQuizPromotion(customer, label, { right: 3, wrong: 2, units: 2 });

    const operator = await grantRoleWith(customer, `round-${label}`, [
      'draws.execute',
      'promotions.view',
      'participations.view',
    ]);
    const client = await signInAs(operator.email, operator.password);

    // ---- the list, filtered the way the screen filters it -------------------
    const listed = await client.rpc('list_participations', {
      p_company_id: customer.companyId,
      p_promotion_id: promotion.promotionId,
      p_status: 'VALID',
      p_answered_correctly: true,
      p_limit: 50,
    });
    expect(listed.error).toBeNull();
    const firstHat = (listed.data ?? []).map((row) => row.id);
    expect([...firstHat].sort()).toEqual([...promotion.right].sort());
    expect((listed.data ?? []).every((row) => row.already_won === false)).toBe(true);
    // The rows list and the listener fields are withheld: this operator holds
    // participations.view and not members.view.
    expect((listed.data ?? []).every((row) => row.listener_name === null)).toBe(true);

    // ---- round one ----------------------------------------------------------
    // ONE of the two linked units, because the point of this case is the second
    // round: a null p_units means every unit still available (D8), which would
    // spend both here and leave nothing to draw again.
    const oneUnit = [{ promotion_prize_id: promotion.promotionPrizeId, quantity: 1 }];
    const first = await client.rpc('run_draw', {
      p_promotion_id: promotion.promotionId,
      p_units: oneUnit,
      p_participation_ids: firstHat,
    });
    expect(first.error).toBeNull();

    const firstDraw = await admin
      .from('draws')
      .select('entry_count, offered_count, included_wrong_answers')
      .eq('id', first.data as string)
      .single();
    // Three offered, three in the hat, nothing wrong among them — which is why
    // draws.execute alone got this far.
    expect(firstDraw.data?.offered_count).toBe(3);
    expect(firstDraw.data?.entry_count).toBe(3);
    expect(firstDraw.data?.included_wrong_answers).toBe(false);

    const firstWinner = await admin
      .from('winners')
      .select('participation_id')
      .eq('draw_id', first.data as string)
      .single();
    expect(firstWinner.error).toBeNull();
    const wonParticipation = firstWinner.data?.participation_id as string;
    expect(firstHat).toContain(wonParticipation);

    // ---- the list has moved, and says so -------------------------------------
    const relisted = await client.rpc('list_participations', {
      p_company_id: customer.companyId,
      p_promotion_id: promotion.promotionId,
      p_status: 'VALID',
      p_answered_correctly: true,
      p_limit: 50,
    });
    expect(relisted.error).toBeNull();
    const wonRow = (relisted.data ?? []).find((row) => row.id === wonParticipation);
    expect(wonRow?.already_won, 'the winner is marked, not hidden').toBe(true);
    expect(
      (relisted.data ?? []).filter((row) => row.already_won).length,
      'and nobody else moved',
    ).toBe(1);

    // ---- naming them again is REFUSED, not silently dropped ------------------
    const stale = await client.rpc('run_draw', {
      p_promotion_id: promotion.promotionId,
      p_units: oneUnit,
      p_participation_ids: firstHat,
    });
    expect(stale.error?.code, 'a hat holding a past winner refuses the draw').toBe('22023');
    expect(stale.error?.message).toMatch(/1 of the 3/);

    // ---- round two, over what is left ----------------------------------------
    const secondHat = firstHat.filter((id) => id !== wonParticipation);
    const second = await client.rpc('run_draw', {
      p_promotion_id: promotion.promotionId,
      p_units: oneUnit,
      p_participation_ids: secondHat,
    });
    expect(second.error).toBeNull();

    const secondWinner = await admin
      .from('winners')
      .select('participation_id')
      .eq('draw_id', second.data as string)
      .single();
    expect(secondHat).toContain(secondWinner.data?.participation_id);
    expect(secondWinner.data?.participation_id).not.toBe(wonParticipation);
  });
});

/**
 * THE PERMISSION, DERIVED FROM THE HAT RATHER THAN CLAIMED BY THE CALLER.
 *
 * `run_draw` takes no "include wrong answers" flag: it looks at what is in the
 * hat and asks for the permission when the hat needs it (D7). So the two calls
 * below send the SAME ids and differ only in what the operator holds, which is
 * the only shape that can tell a real gate from a decorative one.
 */
describe('drawing among people who answered wrongly', () => {
  it('refuses without draws.include_wrong_answers and allows with it', async () => {
    const label = `wrong-${Date.now()}`;
    const customer = await provisionCustomer(label);
    const promotion = await seedQuizPromotion(customer, label, { right: 2, wrong: 2, units: 2 });
    // Everybody, which on a promotion with a quiz is exactly the hat that needs
    // the permission.
    const everybody = [...promotion.right, ...promotion.wrong];

    const plain = await grantRoleWith(customer, `plain-${label}`, [
      'draws.execute',
      'promotions.view',
    ]);
    const plainClient = await signInAs(plain.email, plain.password);

    const refused = await plainClient.rpc('run_draw', {
      p_promotion_id: promotion.promotionId,
      p_units: null,
      p_participation_ids: everybody,
    });
    expect(refused.error?.code, 'draws.execute alone is not enough for this hat').toBe('42501');

    // Nothing was drawn, which is what makes the refusal a refusal rather than
    // a message printed after the fact.
    const nothing = await admin
      .from('draws')
      .select('id')
      .eq('promotion_id', promotion.promotionId);
    expect(nothing.data ?? []).toHaveLength(0);

    const empowered = await grantRoleWith(customer, `wide-${label}`, [
      'draws.execute',
      'promotions.view',
      'draws.include_wrong_answers',
    ]);
    const empoweredClient = await signInAs(empowered.email, empowered.password);

    const allowed = await empoweredClient.rpc('run_draw', {
      p_promotion_id: promotion.promotionId,
      p_units: null,
      p_participation_ids: everybody,
    });
    expect(allowed.error, 'the same hat, drawn by somebody who may').toBeNull();

    const drawn = await admin
      .from('draws')
      .select('entry_count, offered_count, included_wrong_answers')
      .eq('id', allowed.data as string)
      .single();
    expect(drawn.data?.entry_count).toBe(4);
    expect(drawn.data?.offered_count).toBe(4);
    expect(
      drawn.data?.included_wrong_answers,
      'the draw records that it reached past the right answers',
    ).toBe(true);
  });

  it('needs no such permission where there is nothing to be right about', async () => {
    const label = `noquiz-${Date.now()}`;
    const customer = await provisionCustomer(label);
    const { promotionId } = await seedSmallPromotion(customer, label, 1);

    const plain = await grantRoleWith(customer, `noquiz-${label}`, [
      'draws.execute',
      'promotions.view',
      'participations.view',
    ]);
    const client = await signInAs(plain.email, plain.password);

    const listed = await client.rpc('list_participations', {
      p_company_id: customer.companyId,
      p_promotion_id: promotionId,
      p_status: 'VALID',
      p_limit: 50,
    });
    expect(listed.error).toBeNull();
    const hat = (listed.data ?? []).map((row) => row.id);
    expect(hat).toHaveLength(2);

    const drawn = await client.rpc('run_draw', {
      p_promotion_id: promotionId,
      p_units: null,
      p_participation_ids: hat,
    });
    expect(drawn.error, 'a promotion with no quiz asks nothing extra of anybody').toBeNull();

    const record = await admin
      .from('draws')
      .select('included_wrong_answers')
      .eq('id', drawn.data as string)
      .single();
    expect(record.data?.included_wrong_answers).toBe(false);
  });
});
