import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  DRAW_ALGORITHM_VERSION,
  runDrawAlgorithm,
  type DrawEntry,
  type DrawUnit,
} from '@/lib/draw/algorithm';

/**
 * The draw's contract (design spec 4.1), written here as a pure function so it
 * can be run a thousand times a second with no database.
 *
 * This file tests the VERIFIER. It is deliberately a second implementation of a
 * rule that also lives in plpgsql (0077), and everywhere else this project
 * insists a rule has exactly one home. Here two independent implementations are
 * the point: a verifier that shared code with the executor would prove only
 * that the code equals itself. tests/isolation/draw.test.ts is what holds the
 * two to each other; nothing in THIS file can catch a disagreement.
 */

const SEED_A = 'a'.repeat(64);
const SEED_B = 'b'.repeat(64);

/** Entries whose participation ids are stable across runs, so a failure is reproducible. */
function entries(count: number, listeners = count): DrawEntry[] {
  return Array.from({ length: count }, (_, i) => ({
    participationId: `00000000-0000-0000-0000-${String(i + 1).padStart(12, '0')}`,
    memberId: `11111111-0000-0000-0000-${String((i % listeners) + 1).padStart(12, '0')}`,
    position: i + 1,
  }));
}

function units(count: number, prizeId = 'aaaaaaaa-0000-0000-0000-000000000001'): DrawUnit[] {
  return Array.from({ length: count }, (_, i) => ({
    promotionPrizeId: prizeId,
    unitIndex: i + 1,
  }));
}

describe('runDrawAlgorithm', () => {
  it('is the first version of the contract', () => {
    expect(DRAW_ALGORITHM_VERSION).toBe(1);
  });

  it('gives the same winners for the same seed and the same hat', () => {
    const hat = entries(50);
    const first = runDrawAlgorithm({ seed: SEED_A, entries: hat, units: units(3), runnerUpCount: 3 });
    const second = runDrawAlgorithm({ seed: SEED_A, entries: hat, units: units(3), runnerUpCount: 3 });

    expect(first.winners.map((w) => w.entry.participationId)).toEqual(
      second.winners.map((w) => w.entry.participationId),
    );
    expect(first.runnersUp.map((r) => r.entry.participationId)).toEqual(
      second.runnersUp.map((r) => r.entry.participationId),
    );
  });

  it('gives a different order for a different seed', () => {
    // 50 entries, 3 units: the chance the two seeds agree on all three winners
    // by accident is about 1 in 117,600.
    const hat = entries(50);
    const a = runDrawAlgorithm({ seed: SEED_A, entries: hat, units: units(3), runnerUpCount: 0 });
    const b = runDrawAlgorithm({ seed: SEED_B, entries: hat, units: units(3), runnerUpCount: 0 });

    expect(a.winners.map((w) => w.entry.participationId)).not.toEqual(
      b.winners.map((w) => w.entry.participationId),
    );
  });

  it('never awards one listener two units, however many entries they hold', () => {
    // Three entries, all the same listener, three units on offer. D2: one prize.
    const hat: DrawEntry[] = [
      { participationId: 'p-1', memberId: 'm-1', position: 1 },
      { participationId: 'p-2', memberId: 'm-1', position: 2 },
      { participationId: 'p-3', memberId: 'm-1', position: 3 },
    ];

    const outcome = runDrawAlgorithm({ seed: SEED_A, entries: hat, units: units(3), runnerUpCount: 2 });

    expect(outcome.winners).toHaveLength(1);
    expect(outcome.winners[0]?.entry.memberId).toBe('m-1');
    // And the same rule empties the runner-up queue: there is nobody else.
    expect(outcome.runnersUp).toHaveLength(0);
  });

  it('awards what it can when the hat is smaller than the units asked for', () => {
    const hat = entries(2, 2);
    const outcome = runDrawAlgorithm({ seed: SEED_A, entries: hat, units: units(3), runnerUpCount: 0 });

    expect(outcome.winners).toHaveLength(2);
    expect(outcome.winners.map((w) => w.awardedRank)).toEqual([1, 2]);
  });

  it('numbers awarded_rank by the unit sequence, not by the entry order', () => {
    const hat = entries(10, 10);
    const twoPrizes: DrawUnit[] = [
      { promotionPrizeId: 'aaaaaaaa-0000-0000-0000-000000000001', unitIndex: 1 },
      { promotionPrizeId: 'bbbbbbbb-0000-0000-0000-000000000002', unitIndex: 1 },
      { promotionPrizeId: 'bbbbbbbb-0000-0000-0000-000000000002', unitIndex: 2 },
    ];

    const outcome = runDrawAlgorithm({ seed: SEED_A, entries: hat, units: twoPrizes, runnerUpCount: 0 });

    expect(outcome.winners.map((w) => w.awardedRank)).toEqual([1, 2, 3]);
    expect(outcome.winners.map((w) => w.unit)).toEqual(twoPrizes);
  });

  it('continues the same walk for the runners-up, without repeating a listener', () => {
    const hat = entries(20, 20);
    const outcome = runDrawAlgorithm({ seed: SEED_A, entries: hat, units: units(2), runnerUpCount: 3 });

    expect(outcome.runnersUp.map((r) => r.position)).toEqual([1, 2, 3]);

    const awarded = outcome.winners.map((w) => w.entry.memberId);
    const queued = outcome.runnersUp.map((r) => r.entry.memberId);
    expect(new Set([...awarded, ...queued]).size).toBe(awarded.length + queued.length);
  });

  it('runs the runners-up off the same ordering the winners came from', () => {
    // The queue is the CONTINUATION of the walk: drawing 2 winners + 3
    // runners-up must give the same five names, in the same order, as drawing
    // 5 winners would. This is what "one queue for the draw" (D4) means.
    const hat = entries(20, 20);
    const withQueue = runDrawAlgorithm({ seed: SEED_A, entries: hat, units: units(2), runnerUpCount: 3 });
    const asWinners = runDrawAlgorithm({ seed: SEED_A, entries: hat, units: units(5), runnerUpCount: 0 });

    expect([
      ...withQueue.winners.map((w) => w.entry.participationId),
      ...withQueue.runnersUp.map((r) => r.entry.participationId),
    ]).toEqual(asWinners.winners.map((w) => w.entry.participationId));
  });

  it('yields no runners-up when none were asked for', () => {
    const outcome = runDrawAlgorithm({
      seed: SEED_A,
      entries: entries(10, 10),
      units: units(1),
      runnerUpCount: 0,
    });

    expect(outcome.runnersUp).toEqual([]);
  });

  it('stops the queue when the hat runs out rather than padding it', () => {
    const outcome = runDrawAlgorithm({
      seed: SEED_A,
      entries: entries(3, 3),
      units: units(1),
      runnerUpCount: 10,
    });

    expect(outcome.runnersUp).toHaveLength(2);
  });

  it('does not mutate the caller’s array', () => {
    const hat = entries(10, 10);
    const before = hat.map((e) => e.participationId);

    runDrawAlgorithm({ seed: SEED_A, entries: hat, units: units(3), runnerUpCount: 2 });

    expect(hat.map((e) => e.participationId)).toEqual(before);
  });

  it('breaks a tie in the ranking value by the frozen position', () => {
    // A real sha256 collision cannot be constructed here, so this asserts the
    // rule where it is observable instead: two entries with the SAME
    // participation id hash identically, and the walk must then take the lower
    // position first. Duplicate participation ids cannot occur in a real hat
    // (draw_entries has unique (draw_id, participation_id)) -- this is a
    // direct test of the comparator, and it is deliberately artificial rather
    // than a faked collision.
    const tied: DrawEntry[] = [
      { participationId: 'same', memberId: 'm-2', position: 7 },
      { participationId: 'same', memberId: 'm-1', position: 4 },
    ];

    const outcome = runDrawAlgorithm({ seed: SEED_A, entries: tied, units: units(1), runnerUpCount: 1 });

    expect(outcome.winners[0]?.entry.position).toBe(4);
    expect(outcome.runnersUp[0]?.entry.position).toBe(7);
  });

  it('ranks by sha256(seed:participation_id) ascending, as the spec states it', () => {
    // The contract restated independently of the implementation: whatever the
    // function returns must be the entry with the smallest digest. Pins the
    // separator and the input encoding, which is where the SQL side is most
    // likely to drift (isolation test, Task 5).
    const hat = entries(25, 25);
    const outcome = runDrawAlgorithm({ seed: SEED_A, entries: hat, units: units(1), runnerUpCount: 0 });

    const smallest = hat
      .map((e) => ({
        e,
        digest: createHash('sha256').update(`${SEED_A}:${e.participationId}`, 'utf8').digest('hex'),
      }))
      .sort((x, y) => x.digest.localeCompare(y.digest))[0];

    expect(outcome.winners[0]?.entry.participationId).toBe(smallest?.e.participationId);
  });

  it('awards nothing when there are no units', () => {
    const outcome = runDrawAlgorithm({
      seed: SEED_A,
      entries: entries(10, 10),
      units: [],
      runnerUpCount: 2,
    });

    expect(outcome.winners).toEqual([]);
    expect(outcome.runnersUp).toHaveLength(2);
  });
});
