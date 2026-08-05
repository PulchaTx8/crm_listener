import { describe, expect, it } from 'vitest';
import {
  audienceDashboardSchema,
  promotionsDashboardSchema,
} from '@/schemas/dashboards';

/**
 * Spec §7 promised "the Zod payload schemas reject a malformed `jsonb`", and
 * until the whole-branch review (Important B9) `src/schemas/dashboards.ts` had
 * no test at all — the only layer of the D13 chain without one. Both ends were
 * covered (pgTAP proves 0118–0120 OMIT a withheld figure; the isolation suite
 * proves a real caller receives it that way; the e2e proves the screen renders
 * an em dash) and the piece in the middle, the one that decides what "omitted"
 * even means to TypeScript, was taken on trust.
 *
 * The cases below are the four ways this file could silently stop meaning what
 * its own header says. Each of them, if the schema drifted, would produce a
 * page that renders rather than a page that fails — which is precisely why the
 * gap mattered: nothing else in the chain would have noticed.
 */

/** A minimal, valid audience payload — the shape 0118 actually returns. */
function audiencePayload(overrides: Record<string, unknown> = {}) {
  return {
    period: {
      preset: 'custom',
      from: '2026-08-01',
      to: '2026-09-01',
      previous_from: '2026-07-01',
      previous_to: '2026-08-01',
    },
    stations: [
      {
        id: '00000000-0000-0000-0000-0000d8020001',
        name: 'Station SP',
        timezone: 'America/Sao_Paulo',
        from: '2026-08-01',
        to: '2026-09-01',
      },
    ],
    cards: {
      listeners: { current: 3, previous: 1 },
      new_listeners: { current: 2, previous: 1 },
      took_part: { current: 1, previous: 0 },
      barred: { current: 0, previous: 0 },
    },
    monthly: [{ month: '2026-08', count: 2 }],
    breakdowns: {
      blocks_by_kind: [
        { key: 'draw_ban', label: 'draw_ban', count: 0 },
        { key: 'suspension', label: 'suspension', count: 0 },
      ],
    },
    top: {
      discovery_source: [{ id: 'Instagram', label: 'Instagram', count: 2 }],
      first_contact_origin: [{ id: '', label: 'Not stated', count: 3 }],
    },
    withheld: [],
    ...overrides,
  };
}

describe('the dashboard payload schemas', () => {
  it('accepts the payload 0118 returns for a caller who may see everything', () => {
    expect(() => audienceDashboardSchema.parse(audiencePayload())).not.toThrow();
  });

  // D13's own mechanism: a withheld figure is an ABSENT key, because
  // jsonb_strip_nulls removed it. `.optional()` is the only correct mirror of
  // that, and this is the case proving the schema does not require the key.
  it('accepts an ABSENT took_part, because that is what withheld looks like', () => {
    const payload = audiencePayload();
    delete (payload.cards as Record<string, unknown>).took_part;

    const parsed = audienceDashboardSchema.parse({
      ...payload,
      withheld: [{ figure: 'took_part', needs: 'participations.view' }],
    });

    expect(parsed.cards.took_part).toBeUndefined();
    expect(parsed.withheld).toEqual([{ figure: 'took_part', needs: 'participations.view' }]);
  });

  // `.optional()`, NEVER `.nullable()` — the distinction the schema's own
  // header calls "the one thing here that must not move". A present-but-null
  // card is not something these functions can send, and accepting it would
  // mean the page had to decide what a null figure means, which is the exact
  // decision D13 removes: there is one representation of "not for you", and it
  // is the missing key.
  it('rejects a took_part that is present and null', () => {
    const payload = audiencePayload();
    (payload.cards as Record<string, unknown>).took_part = null;

    expect(() => audienceDashboardSchema.parse(payload)).toThrow();
  });

  // The `jsonb` arrives as `unknown`, and every number in it is a number only
  // because this file says so. A `previous` that came back as a string would
  // otherwise reach `card.previous.toLocaleString()` and render "1" beside a
  // real number with nothing on screen saying one of them was never counted.
  it('rejects a previous that arrived as a string rather than a number', () => {
    const payload = audiencePayload();
    const cards = payload.cards as Record<string, Record<string, unknown>>;
    cards.listeners!.previous = '1';

    expect(() => audienceDashboardSchema.parse(payload)).toThrow();
  });

  // `.strict()` on the three `cards` objects (whole-branch review, Important
  // B9). Zod's default is to STRIP an unknown key silently, which is the wrong
  // default on the one object where a key's ABSENCE is a claim: a migration
  // that misspelled `took_part` would leave the real figure missing —
  // rendering as "withheld", a permission claim that is false — while the
  // typo was quietly discarded. Nothing would fail; the page would just lie.
  it('rejects an unknown key in cards rather than stripping it', () => {
    expect(() =>
      audienceDashboardSchema.parse(
        audiencePayload({
          cards: { ...audiencePayload().cards, took_par: { current: 9, previous: 9 } },
        }),
      ),
    ).toThrow();
  });

  // The promotions panel is where D13 omits keys OUTSIDE `cards` too, and the
  // top-level `monthly` is the one 0120's header singles out: an empty
  // twelve-month chart reads as "nobody took part", the same false claim a
  // zero card would make. Absent must parse; an empty array is a DIFFERENT,
  // also-valid payload, and the schema has to keep them distinguishable.
  it('keeps an absent promotions monthly distinguishable from an empty one', () => {
    const base = {
      period: {
        preset: 'custom',
        from: '2026-08-01',
        to: '2026-09-01',
        previous_from: '2026-07-01',
        previous_to: '2026-08-01',
      },
      stations: [
        {
          id: '00000000-0000-0000-0000-0000d8020001',
          name: 'Station SP',
          timezone: 'America/Sao_Paulo',
          from: '2026-08-01',
          to: '2026-09-01',
        },
      ],
      cards: {
        live_now: { current: 1 },
        ended: { current: 2, previous: 0 },
        awarded: { current: 1, previous: 0 },
        overdue: { current: 1 },
      },
      breakdowns: { prize_cycle: [] },
      top: {},
      withheld: [
        { figure: 'participations', needs: 'participations.view' },
        { figure: 'monthly', needs: 'participations.view' },
      ],
    };

    expect(promotionsDashboardSchema.parse(base).monthly).toBeUndefined();
    expect(promotionsDashboardSchema.parse({ ...base, monthly: [] }).monthly).toEqual([]);
  });

  // Each Station's OWN resolved window (D5 as amended): the keys the screen's
  // mixed-period note reads. Without them it cannot tell a preset that
  // resolved two different calendar months from one that did not.
  it('requires each station to carry its own resolved from/to dates', () => {
    const payload = audiencePayload();
    const [station] = payload.stations as Record<string, unknown>[];
    delete station!.from;

    expect(() => audienceDashboardSchema.parse(payload)).toThrow();
  });
});
