import { createHash } from 'node:crypto';

/**
 * Version 1 of the draw's contract, stated in the design spec 4.1.
 *
 * THIS IS THE VERIFIER, and it is deliberately a SECOND implementation of a
 * rule that also lives in plpgsql (`apply_draw`, 0077). Everywhere else this
 * project insists a rule has exactly one home; here two independent
 * implementations are the point, because a verifier that shared code with the
 * executor would prove only that the code equals itself.
 *
 * What holds them together is `tests/isolation/draw.test.ts`, which runs a real
 * draw in Postgres and recomputes it here from nothing but the stored seed and
 * the frozen hat. If the two ever disagree, "anybody holding the record can
 * recompute the winners" is false and nothing else in the suite would notice.
 *
 * Reads no clock and no environment: given the same arguments it returns the
 * same answer forever, which is what makes a draw from August checkable in
 * March.
 */
export const DRAW_ALGORITHM_VERSION = 1;

export interface DrawEntry {
  participationId: string;
  memberId: string;
  /** 1..N, the frozen order. Ties in the ranking value are broken by it. */
  position: number;
}

export interface DrawUnit {
  promotionPrizeId: string;
  unitIndex: number;
}

export interface DrawOutcome {
  winners: { unit: DrawUnit; entry: DrawEntry; awardedRank: number }[];
}

/**
 * The ranking value: sha256 over `seed:participation_id`, UTF-8.
 *
 * Compared as BYTES, not as a hex string. The SQL side orders by the `bytea`
 * that `sha256()` returns, and a hex string sorts the same way only by
 * accident of the alphabet — pinning it to bytes on both sides removes the
 * accident.
 */
function rank(seed: string, participationId: string): Buffer {
  return createHash('sha256').update(`${seed}:${participationId}`, 'utf8').digest();
}

export function runDrawAlgorithm(input: {
  seed: string;
  entries: DrawEntry[];
  units: DrawUnit[];
}): DrawOutcome {
  const { seed, entries, units } = input;

  // Sort a COPY. Mutating the caller's array would reorder the hat that the
  // caller is about to compare against, which is the one thing this function
  // exists to make possible.
  const ordered = entries
    .map((entry) => ({ entry, key: rank(seed, entry.participationId) }))
    .sort((a, b) => Buffer.compare(a.key, b.key) || a.entry.position - b.entry.position)
    .map(({ entry }) => entry);

  const winners: DrawOutcome['winners'] = [];

  // One walk. The awarded set is what makes "one person, one prize" fall out of
  // it rather than being enforced beside it: the first time a listener appears
  // in rank order is the only time they can be taken.
  const awarded = new Set<string>();
  let cursor = 0;

  const takeNext = (): DrawEntry | undefined => {
    while (cursor < ordered.length) {
      const entry = ordered[cursor];
      cursor += 1;
      if (entry && !awarded.has(entry.memberId)) {
        awarded.add(entry.memberId);
        return entry;
      }
    }
    return undefined;
  };

  for (const unit of units) {
    const entry = takeNext();
    // The hat ran out. Award fewer prizes and say so, which is not an error
    // (spec 7): the draw records entry_count and the caller can see the gap.
    if (!entry) break;
    winners.push({ unit, entry, awardedRank: winners.length + 1 });
  }

  return { winners };
}
