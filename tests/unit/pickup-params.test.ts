import { createTranslator } from 'next-intl';
import { describe, expect, it } from 'vitest';
import { decodeCursor } from '@/lib/keyset';
import {
  ANY_STATUS,
  describeDeadline,
  hasActivePickupFilters,
  parsePickupCursor,
  parsePickupListState,
  pickupsHref,
} from '@/app/(app)/pickups/list-params';
import en from '../../messages/en.json';

/**
 * The REAL English catalogue through next-intl's own formatter, so these
 * assertions pin what messages/en.json says as well as what describeDeadline
 * decides — the wording used to live in the function body, and moving it out
 * must not move it out of the test's reach.
 */
const t = createTranslator({ locale: 'en', messages: en, namespace: 'pickups' }) as unknown as (
  key: string,
  values?: Record<string, string | number | Date>,
) => string;

describe('parsePickupListState', () => {
  it('reads every filter off the URL', () => {
    expect(
      parsePickupListState(
        { promotion: 'promo-1', status: 'RETURN_PENDING', q: 'ana' },
        'company-1',
      ),
    ).toEqual({
      companyId: 'company-1',
      stationSearch: undefined,
      promotionId: 'promo-1',
      status: 'RETURN_PENDING',
      search: 'ana',
    });
  });

  // Hostile input, the same contract parseStatus in participations/list-params.ts
  // and parseRecordParam both carry: a hand-edited URL falls back to the
  // widest reading rather than throwing or silently picking an arbitrary
  // status.
  it('falls back to no status filter (ANY_STATUS) for an unrecognised status', () => {
    expect(parsePickupListState({ status: 'NOT_A_REAL_STATUS' }, 'company-1').status).toBe(
      ANY_STATUS,
    );
  });

  it('falls back to no status filter when status is absent entirely', () => {
    expect(parsePickupListState({}, 'company-1').status).toBe(ANY_STATUS);
  });

  it('trims blank filters to undefined rather than keeping empty strings', () => {
    const state = parsePickupListState({ promotion: '   ', q: '  ' }, 'company-1');
    expect(state.promotionId).toBeUndefined();
    expect(state.search).toBeUndefined();
  });
});

describe('parsePickupCursor', () => {
  it('reads an after cursor', () => {
    expect(parsePickupCursor({ after: 'abc' })).toEqual({ side: 'after', value: 'abc' });
  });

  it('reads a before cursor, and prefers it over an after on the same URL', () => {
    expect(parsePickupCursor({ after: 'abc', before: 'def' })).toEqual({
      side: 'before',
      value: 'def',
    });
  });

  it('is null when neither is present', () => {
    expect(parsePickupCursor({})).toBeNull();
  });

  // Task 7's contract: a hand-edited or stale `after` is not this function's
  // job to reject -- it hands the raw string on, and decodeCursor (@/lib/keyset)
  // is what turns a malformed one into "no cursor" rather than a 22P02 from
  // Postgres. Exercised here as the pair the pickups page.tsx actually calls,
  // not by re-testing decodeCursor's own unit tests (tests/unit/keyset-cursor.test.ts
  // already cover its id/base64/JSON edge cases in full).
  it('a malformed after cursor decodes to null rather than reaching Postgres', () => {
    const cursor = parsePickupCursor({ after: 'not-a-real-cursor' });
    expect(cursor).not.toBeNull();
    expect(decodeCursor(cursor?.value)).toBeNull();
  });
});

describe('pickupsHref / parsePickupListState round trip', () => {
  it('survives a round trip through URLSearchParams', () => {
    const state = parsePickupListState(
      { promotion: 'promo-9', status: 'WRITTEN_OFF', q: 'listener name' },
      'company-9',
    );

    const href = pickupsHref(state);
    const query = new URLSearchParams(href.split('?')[1]);
    const raw = {
      companyId: query.get('companyId') ?? undefined,
      promotion: query.get('promotion') ?? undefined,
      status: query.get('status') ?? undefined,
      q: query.get('q') ?? undefined,
    };

    expect(parsePickupListState(raw, raw.companyId ?? 'company-9')).toEqual(state);
  });

  // ANY_STATUS is written as an ABSENCE, the same contract
  // participationsHref carries for its own default: a URL this function built
  // for "no status filter" and a hand-typed URL with no status parameter at
  // all must parse to the same state, or Clear Filters and a fresh visit to
  // the screen would silently disagree about what "no filter" looks like.
  it('omits status from the URL when it is ANY_STATUS, and reading it back agrees', () => {
    const state = parsePickupListState({}, 'company-1');
    const href = pickupsHref(state);
    expect(href).not.toContain('status=');

    const query = new URLSearchParams(href.split('?')[1]);
    expect(parsePickupListState({ companyId: query.get('companyId') ?? undefined }, 'company-1')).toEqual(
      state,
    );
  });

  it('carries a cursor onto the href when one is given', () => {
    const state = parsePickupListState({}, 'company-1');
    const href = pickupsHref(state, { side: 'after', value: 'xyz' });
    expect(href).toContain('after=xyz');
  });
});

describe('hasActivePickupFilters', () => {
  it('is false for the screen as it opens', () => {
    expect(hasActivePickupFilters(parsePickupListState({}, 'company-1'))).toBe(false);
  });

  it('is true once any filter narrows the list', () => {
    expect(
      hasActivePickupFilters(parsePickupListState({ status: 'DELIVERED' }, 'company-1')),
    ).toBe(true);
    expect(
      hasActivePickupFilters(parsePickupListState({ promotion: 'p1' }, 'company-1')),
    ).toBe(true);
    expect(hasActivePickupFilters(parsePickupListState({ q: 'ana' }, 'company-1'))).toBe(true);
  });
});

describe('describeDeadline', () => {
  // The case this screen exists for. Up to an hour passes between a deadline
  // expiring and sweep_pickup_deadlines (0094) running, and in that window the
  // row is still AWAITING_PICKUP with deadline_at already in the past. A
  // column that trusted the status before admitting that would tell the
  // operator a prize is fine for that whole hour -- this asserts the function
  // reads the DATE instead.
  it('renders an expired deadline as overdue even while the row is still AWAITING_PICKUP', () => {
    expect(describeDeadline(new Date(Date.now() - 86_400_000), 'AWAITING_PICKUP', t))
      .toMatch(/overdue/i);
  });

  it('renders an expired deadline as overdue for RETURN_PENDING too, the status the clock itself sets', () => {
    expect(describeDeadline(new Date(Date.now() - 3_600_000), 'RETURN_PENDING', t)).toMatch(
      /overdue/i,
    );
  });

  it('does not call a future deadline overdue', () => {
    const description = describeDeadline(new Date(Date.now() + 3_600_000), 'AWAITING_PICKUP', t);
    expect(description).not.toMatch(/overdue/i);
    expect(description).toMatch(/due/i);
  });

  it('reads "no deadline" for a winner whose prize sets none, rather than treating null as overdue', () => {
    expect(describeDeadline(null, 'AWAITING_PICKUP', t)).toBe('no deadline');
  });

  // A prize that has already left this list for good (winner-actions.tsx's
  // own three ways out) is not a clock the operator can still act on: showing
  // "overdue by 3 days" beside a Delivered badge would read as an alarm for a
  // matter the Status column already says is settled. Guards against a naive
  // implementation that computes overdue from the date alone with no regard
  // for status at all, which the brief's own wording ("regardless of status")
  // could otherwise be over-read to mean.
  it('does not call a resolved winner overdue, even with a deadline long past', () => {
    const longPast = new Date(Date.now() - 30 * 86_400_000);
    expect(describeDeadline(longPast, 'DELIVERED', t)).not.toMatch(/overdue/i);
    expect(describeDeadline(longPast, 'RETURNED', t)).not.toMatch(/overdue/i);
    expect(describeDeadline(longPast, 'WRITTEN_OFF', t)).not.toMatch(/overdue/i);
  });

  it('accepts the instant as a string, the shape a row actually carries over the wire', () => {
    expect(describeDeadline(new Date(Date.now() - 86_400_000).toISOString(), 'AWAITING_PICKUP', t))
      .toMatch(/overdue/i);
  });
});
