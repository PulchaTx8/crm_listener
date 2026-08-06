import { describe, expect, it } from 'vitest';
import {
  listenersReportFilters,
  movementsReportFilters,
  musicRequestsReportFilters,
  participationsReportFilters,
  winnersReportFilters,
} from '@/lib/reports/list-filters';
import { reportRequestSchema } from '@/schemas/reports';

/**
 * Block 8b. The test that keeps five screens and one schema in agreement.
 *
 * Each mount site translates its own filter state into the report's vocabulary.
 * A translation that emits a key the schema does not know is refused by
 * `.strict()` -- the operator sees "unrecognized key" and nothing points back at
 * the screen that sent it. Parsing every function's output through the REAL
 * schema is what makes that failure impossible to ship.
 *
 * `JSON.parse(JSON.stringify(...))` is not ceremony: the dialog serialises the
 * filters, and serialising is what drops the `undefined` values these functions
 * deliberately produce. Parsing the object directly would test something the
 * server never sees.
 */
const wire = (value: object) => JSON.parse(JSON.stringify(value)) as Record<string, unknown>;

describe('list state translated into report filters', () => {
  it('participations: keeps what the schema knows and drops what it does not', () => {
    const filters = wire(
      participationsReportFilters({
        promotionId: '11111111-1111-4111-8111-111111111111',
        status: 'VALID',
        source: 'WHATSAPP',
        from: '2026-08-01',
        to: '2026-09-01',
      }),
    );

    expect(
      reportRequestSchema.safeParse({ reportType: 'PARTICIPATIONS', format: 'CSV', filters })
        .success,
    ).toBe(true);
    expect(filters).toEqual({
      promotion_id: '11111111-1111-4111-8111-111111111111',
      status: 'VALID',
      source: 'WHATSAPP',
      from: '2026-08-01',
      to: '2026-09-01',
    });
  });

  it('participations: an "all" status from the screen becomes no filter at all', () => {
    // The screens spell "no filter" as a sentinel of their own. Passing that
    // sentinel through would filter on a status no row has, and the export
    // would come back empty with nothing explaining it.
    const filters = wire(participationsReportFilters({ status: 'ALL', source: 'ALL' }));
    expect(filters).toEqual({});
    expect(
      reportRequestSchema.safeParse({ reportType: 'PARTICIPATIONS', format: 'CSV', filters })
        .success,
    ).toBe(true);
  });

  it('winners: promotion and status survive, anything else does not', () => {
    const filters = wire(
      winnersReportFilters({
        promotionId: '22222222-2222-4222-8222-222222222222',
        status: 'AWAITING_PICKUP',
      }),
    );
    expect(
      reportRequestSchema.safeParse({ reportType: 'WINNERS', format: 'XLSX', filters }).success,
    ).toBe(true);
    expect(Object.keys(filters).sort()).toEqual(['promotion_id', 'status']);
  });

  it('movements: the type passes through unvalidated, by design', () => {
    const filters = wire(
      movementsReportFilters({ type: 'RESERVATION', prizeId: '33333333-3333-4333-8333-333333333333' }),
    );
    expect(
      reportRequestSchema.safeParse({ reportType: 'MOVEMENTS', format: 'CSV', filters }).success,
    ).toBe(true);
    expect(filters.movement_type).toBe('RESERVATION');
  });

  it('music requests: the search term is NOT carried into the export', () => {
    // Deliberate. 0107 refuses a search to a caller without members.view,
    // because searching a field you may not read is an oracle -- and a report
    // that silently dropped the search would be a different report from the one
    // on screen. Not offering it at all is the honest option.
    const filters = wire(
      musicRequestsReportFilters({ songId: '44444444-4444-4444-8444-444444444444', channel: 'MANUAL' }),
    );
    expect(filters).not.toHaveProperty('search');
    expect(filters).not.toHaveProperty('q');
    expect(
      reportRequestSchema.safeParse({ reportType: 'MUSIC_REQUESTS', format: 'CSV', filters })
        .success,
    ).toBe(true);
  });

  it('listeners: the situation and the age band survive', () => {
    const filters = wire(listenersReportFilters({ situation: 'blocked', ageMin: 18, ageMax: 30 }));
    expect(
      reportRequestSchema.safeParse({ reportType: 'LISTENERS', format: 'XLSX', filters }).success,
    ).toBe(true);
    expect(filters).toEqual({ situation: 'blocked', age_min: 18, age_max: 30 });
  });

  it('every translator produces an object the schema accepts when the screen is unfiltered', () => {
    const cases = [
      ['LISTENERS', listenersReportFilters({})],
      ['PARTICIPATIONS', participationsReportFilters({})],
      ['WINNERS', winnersReportFilters({})],
      ['MUSIC_REQUESTS', musicRequestsReportFilters({})],
      ['MOVEMENTS', movementsReportFilters({})],
    ] as const;

    for (const [reportType, filters] of cases) {
      const result = reportRequestSchema.safeParse({
        reportType,
        format: 'CSV',
        filters: wire(filters),
      });
      expect(result.success, `${reportType} with no filters`).toBe(true);
    }
  });
});
