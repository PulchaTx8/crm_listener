import { describe, expect, it } from 'vitest';
import { decodeCursor } from '@/lib/keyset';
import {
  describeMovementActor,
  describeMovementPromotion,
  hasActiveMovementFilters,
  movementsHref,
  movementTypeFilter,
  parseMovementCursor,
  parseMovementListState,
} from '@/app/(app)/inventory/movements/list-params';

describe('parseMovementListState', () => {
  it('reads every filter off the URL', () => {
    expect(
      parseMovementListState(
        { type: 'MANUAL_ENTRY', prize: 'prize-1', promotion: 'promo-1' },
        'company-1',
      ),
    ).toEqual({
      companyId: 'company-1',
      stationSearch: undefined,
      type: 'MANUAL_ENTRY',
      prizeId: 'prize-1',
      promotionId: 'promo-1',
      from: undefined,
      to: undefined,
    });
  });

  // The exact contract this task's own brief names: only a real
  // inventory_movement_type value survives. Two assertions rather than one --
  // a real value passing through says nothing about whether an invalid one is
  // actually refused, and an implementation that let every string through
  // would still pass the first on its own.
  it('accepts a real inventory_movement_type value', () => {
    expect(parseMovementListState({ type: 'DELIVERY' }, 'company-1').type).toBe('DELIVERY');
  });

  // Hostile input, the same "widest reading, never an error page" contract
  // parseStatus (pickups/list-params.ts) and parseSource
  // (participations/list-params.ts) both carry for their own filters: a
  // hand-edited URL falls back to no type filter rather than throwing or
  // silently keeping whatever nonsense string was typed.
  it('falls back to no type filter for an unrecognised type', () => {
    expect(parseMovementListState({ type: 'NOT_A_REAL_TYPE' }, 'company-1').type).toBeUndefined();
  });

  it('falls back to no type filter when type is absent entirely', () => {
    expect(parseMovementListState({}, 'company-1').type).toBeUndefined();
  });

  it('trims blank prize/promotion filters to undefined rather than keeping empty strings', () => {
    const state = parseMovementListState({ prize: '   ', promotion: '  ' }, 'company-1');
    expect(state.prizeId).toBeUndefined();
    expect(state.promotionId).toBeUndefined();
  });
});

describe('parseMovementListState, the period filter', () => {
  it('reads a valid from/to pair, both ends included', () => {
    const state = parseMovementListState(
      { from: '2026-01-01T00:00:00.000Z', to: '2026-01-31T00:00:00.000Z' },
      'company-1',
    );
    expect(state.from).toBe('2026-01-01T00:00:00.000Z');
    expect(state.to).toBe('2026-01-31T00:00:00.000Z');
  });

  // The exact case this task's own brief names: list_movements (0096) applies
  // p_from/p_to as plain >=/<= bounds, so an inverted pair is not something
  // Postgres refuses -- it is a range that silently reads back zero rows with
  // nothing on the screen to say why. This asserts the LATER, invalid bound is
  // dropped rather than the whole period being reset, so "everything since X"
  // survives instead of vanishing along with the mistake -- and asserts the
  // `from` right beside it specifically so a fix that dropped BOTH bounds
  // (satisfying only "the to is gone") would still fail this.
  it('drops a to that falls before its own from, rather than sending an inverted range', () => {
    const state = parseMovementListState(
      { from: '2026-02-01T00:00:00.000Z', to: '2026-01-01T00:00:00.000Z' },
      'company-1',
    );
    expect(state.to).toBeUndefined();
    expect(state.from).toBe('2026-02-01T00:00:00.000Z');
  });

  it('keeps an equal from/to (a single day), which is not inverted', () => {
    const same = '2026-01-01T00:00:00.000Z';
    const state = parseMovementListState({ from: same, to: same }, 'company-1');
    expect(state.from).toBe(same);
    expect(state.to).toBe(same);
  });

  it('ignores an unparseable date rather than throwing', () => {
    expect(parseMovementListState({ from: 'not-a-date' }, 'company-1').from).toBeUndefined();
  });
});

describe('parseMovementCursor', () => {
  it('reads an after cursor', () => {
    expect(parseMovementCursor({ after: 'abc' })).toEqual({ side: 'after', value: 'abc' });
  });

  it('reads a before cursor, and prefers it over an after on the same URL', () => {
    expect(parseMovementCursor({ after: 'abc', before: 'def' })).toEqual({
      side: 'before',
      value: 'def',
    });
  });

  it('is null when neither is present', () => {
    expect(parseMovementCursor({})).toBeNull();
  });

  // The exact contract this task's own brief names: a malformed cursor yields
  // none. parseMovementCursor itself only carries the raw string on --
  // decodeCursor (@/lib/keyset) is what turns it into "no cursor" -- so this
  // exercises the pair the page actually calls, the same way
  // tests/unit/pickup-params.test.ts covers its own parsePickupCursor rather
  // than re-testing decodeCursor's own unit tests.
  it('a malformed after cursor decodes to null rather than reaching Postgres', () => {
    const cursor = parseMovementCursor({ after: 'not-a-real-cursor' });
    expect(cursor).not.toBeNull();
    expect(decodeCursor(cursor?.value)).toBeNull();
  });
});

describe('movementsHref / parseMovementListState round trip', () => {
  it('survives a round trip through URLSearchParams', () => {
    const state = parseMovementListState(
      { type: 'DELIVERY', prize: 'prize-9', promotion: 'promo-9' },
      'company-9',
    );

    const href = movementsHref(state);
    const query = new URLSearchParams(href.split('?')[1]);
    const raw = {
      companyId: query.get('companyId') ?? undefined,
      type: query.get('type') ?? undefined,
      prize: query.get('prize') ?? undefined,
      promotion: query.get('promotion') ?? undefined,
    };

    expect(parseMovementListState(raw, raw.companyId ?? 'company-9')).toEqual(state);
  });

  it('carries a cursor onto the href when one is given', () => {
    const state = parseMovementListState({}, 'company-1');
    const href = movementsHref(state, { side: 'after', value: 'xyz' });
    expect(href).toContain('after=xyz');
  });

  it('omits every filter from the href when none is set', () => {
    const state = parseMovementListState({}, 'company-1');
    const href = movementsHref(state);
    expect(href).not.toContain('type=');
    expect(href).not.toContain('prize=');
    expect(href).not.toContain('promotion=');
    expect(href).not.toContain('from=');
    expect(href).not.toContain('to=');
  });
});

describe('describeMovementActor', () => {
  // The one catalogue this function can reach, resolved the way a screen
  // would -- the same shape describeMovementPromotion's own tests use below.
  const t = (key: string) =>
    key === 'movementActorDeadline' ? '(deadline)' : key === 'unnamedOperator' ? 'Unnamed operator' : key;

  // The case this task exists for: the sweep (0094) runs under pg_cron with
  // no auth.uid(), so it leaves no actor at all.
  it('renders the deadline sweep as "(deadline)" when actorId is null', () => {
    expect(describeMovementActor(null, null, t)).toBe('(deadline)');
  });

  // The case review caught once already (Task 6's coalesce onto an email):
  // an actorId with no actorName is a real person with no display name on
  // record, not the clock. If this read actorName first (falling back to
  // "(deadline)" whenever the name were absent) this would wrongly return
  // "(deadline)" here instead of naming an unnamed operator.
  it('renders a human with no display name as an unnamed operator, never "(deadline)"', () => {
    const result = describeMovementActor('operator-1', null, t);
    expect(result).not.toBe('(deadline)');
    expect(result).toBe('Unnamed operator');
  });

  it('renders a named operator by name', () => {
    expect(describeMovementActor('operator-1', 'Ana Souza', t)).toBe('Ana Souza');
  });

  // The exact defect this task's brief warns against: keying the label off
  // actorName rather than actorId. A row where actorId is null (the clock)
  // but actorName is somehow non-null must STILL read "(deadline)" -- if the
  // implementation checked actorName first, this row would wrongly print the
  // name instead.
  it('keys off actorId alone: a null actorId still reads "(deadline)" even if actorName were somehow present', () => {
    expect(describeMovementActor(null, 'should never be shown', t)).toBe('(deadline)');
  });
});

describe('describeMovementPromotion', () => {
  // The one catalogue key this function can reach, resolved the way a screen
  // would. Asserting on the ENGLISH sentence rather than on the key keeps
  // these tests reading as statements about what an operator sees.
  const t = (key: string) => (key === 'archivedPromotion' ? '(archived promotion)' : key);

  it('renders "—" for a movement naming no promotion at all', () => {
    expect(describeMovementPromotion(null, null, false, t)).toBe('—');
  });

  it('renders the promotion name when one is visible', () => {
    expect(describeMovementPromotion('promo-1', 'Summer Giveaway', false, t)).toBe(
      'Summer Giveaway',
    );
  });

  it('renders "(archived promotion)" when the name was withheld for being archived', () => {
    expect(describeMovementPromotion('promo-1', null, true, t)).toBe('(archived promotion)');
  });

  // Keyed off promotionArchived, never off promotionName being null: a row
  // where the archived flag is true must read "(archived promotion)" even if
  // a name were somehow present, the same discipline describeMovementActor
  // keeps for actorId. An implementation that checked `promotionName === null`
  // instead would still pass the case above, but would wrongly print the
  // name here.
  it('keys off promotionArchived alone, not off the name being null', () => {
    expect(describeMovementPromotion('promo-1', 'should not show', true, t)).toBe(
      '(archived promotion)',
    );
  });
});

// Block 23, Task 8: the Movimentação tab's own type filter hands a single
// selection to getPrizeMovements' array-shaped `types` parameter. list_movements'
// own comment on `p_types` (0196) draws a hard line between the two ways to say
// "nothing selected": `null`/`undefined` means no filter, an EMPTY ARRAY matches
// NOTHING. This is the exact case a naive `selected ? [selected] : []` would get
// backwards.
describe('movementTypeFilter', () => {
  it('wraps a real movement type in a one-element array', () => {
    expect(movementTypeFilter('DELIVERY')).toEqual(['DELIVERY']);
  });

  // The case this function exists for: "no kind chosen" must reach
  // getPrizeMovements as undefined (no filter), never as [] (matches nothing).
  it('maps the empty selection to undefined, never to an empty array', () => {
    expect(movementTypeFilter('')).toBeUndefined();
  });

  // Hostile input gets the same "widest reading" contract every other parser in
  // this file carries: a value that is not a real inventory_movement_type is
  // read as no filter, not as a filter matching nothing.
  it('falls back to undefined for an unrecognised type, not to an empty array', () => {
    expect(movementTypeFilter('NOT_A_REAL_TYPE')).toBeUndefined();
  });
});

describe('hasActiveMovementFilters', () => {
  it('is false for the screen as it opens', () => {
    expect(hasActiveMovementFilters(parseMovementListState({}, 'company-1'))).toBe(false);
  });

  it('is true once any one filter narrows the list', () => {
    expect(
      hasActiveMovementFilters(parseMovementListState({ type: 'DELIVERY' }, 'company-1')),
    ).toBe(true);
    expect(
      hasActiveMovementFilters(parseMovementListState({ prize: 'p1' }, 'company-1')),
    ).toBe(true);
    expect(
      hasActiveMovementFilters(parseMovementListState({ promotion: 'p1' }, 'company-1')),
    ).toBe(true);
    expect(
      hasActiveMovementFilters(
        parseMovementListState({ from: '2026-01-01T00:00:00.000Z' }, 'company-1'),
      ),
    ).toBe(true);
    expect(
      hasActiveMovementFilters(
        parseMovementListState({ to: '2026-01-01T00:00:00.000Z' }, 'company-1'),
      ),
    ).toBe(true);
  });
});
