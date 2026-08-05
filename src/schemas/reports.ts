import { z } from 'zod';
import {
  LISTING_TYPES,
  PANEL_TYPES,
  REPORT_FORMATS,
  REPORT_STATUSES,
  REPORT_TYPES,
} from '@/lib/reports/types';

/**
 * Block 8b. What a client may ask for, and what comes back.
 *
 * `.strict()` throughout, which 8a settled on and whose trap its own report
 * names: a schema that rejects unknown keys turns a database that is AHEAD of
 * the frontend into a parse error on the whole page rather than one missing
 * field. That is the right trade here for the same reason it was there -- a
 * filter key the server does not understand is a filter silently not applied,
 * and a report narrowed by a filter that did not run is wrong in a way nothing
 * on its face reveals -- but it makes the deploy ORDER load-bearing, and the
 * runbook says so.
 */

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD')
  .refine((value) => {
    // Date.parse accepts 2026-02-31 and rolls it to 3 March. A filter that
    // silently means a different day is worse than a refused one.
    const parts = value.split('-');
    const year = Number(parts[0]);
    const month = Number(parts[1]);
    const day = Number(parts[2]);
    const date = new Date(Date.UTC(year, month - 1, day));
    return (
      date.getUTCFullYear() === year &&
      date.getUTCMonth() === month - 1 &&
      date.getUTCDate() === day
    );
  }, 'not a real date');

/**
 * The window every dated listing shares. Half-open, from inclusive and to
 * exclusive, matching 0117 and every bound in this schema since Block 4.
 *
 * `from < to`, strictly. 8a's whole-branch review found parsePeriod comparing
 * `from > to` while 0117 refuses `p_to <= p_from`, so a caller who picked one
 * date in both inputs sailed past the client and was refused by the database.
 * Both bounds agree here from the start.
 */
const window = {
  from: isoDate.optional(),
  to: isoDate.optional(),
};

function refineWindow<T extends { from?: string; to?: string }>(schema: z.ZodType<T>) {
  return schema.refine(
    (value) => value.from === undefined || value.to === undefined || value.from < value.to,
    { message: 'the period must open before it closes' },
  );
}

const listenersFilters = refineWindow(
  z
    .object({
      ...window,
      situation: z.enum(['active', 'blocked', 'archived']).optional(),
      consent: z.boolean().optional(),
      age_min: z.number().int().min(0).max(150).optional(),
      age_max: z.number().int().min(0).max(150).optional(),
    })
    .strict(),
).refine(
  (value) => value.age_min === undefined || value.age_max === undefined || value.age_min <= value.age_max,
  { message: 'the age band must open before it closes' },
);

const participationsFilters = refineWindow(
  z
    .object({
      ...window,
      promotion_id: z.string().uuid().optional(),
      status: z.enum(['VALID', 'DUPLICATE', 'TOO_SOON', 'OVER_LIMIT']).optional(),
      source: z.enum(['MANUAL', 'IMPORT', 'WHATSAPP']).optional(),
    })
    .strict(),
);

const winnersFilters = refineWindow(
  z
    .object({
      ...window,
      promotion_id: z.string().uuid().optional(),
      status: z.enum(['AWAITING_PICKUP', 'DELIVERED', 'RETURNED', 'WRITTEN_OFF']).optional(),
    })
    .strict(),
);

const musicRequestsFilters = refineWindow(
  z
    .object({
      ...window,
      song_id: z.string().uuid().optional(),
      show_id: z.string().uuid().optional(),
      channel: z.enum(['MANUAL', 'IMPORT', 'WHATSAPP']).optional(),
    })
    .strict(),
);

const movementsFilters = refineWindow(
  z
    .object({
      ...window,
      prize_id: z.string().uuid().optional(),
      promotion_id: z.string().uuid().optional(),
      movement_type: z.string().min(1).max(40).optional(),
    })
    .strict(),
);

export const REPORT_FILTER_SCHEMAS = {
  LISTENERS: listenersFilters,
  PARTICIPATIONS: participationsFilters,
  WINNERS: winnersFilters,
  MUSIC_REQUESTS: musicRequestsFilters,
  MOVEMENTS: movementsFilters,
} as const;

const spreadsheetFormat = z.enum(['CSV', 'XLSX']);

/**
 * A discriminated union rather than one object with a loose `filters` bag: the
 * format constraint and the filter shape both depend on the type, and 0122
 * enforces the first with a CHECK. Two places, one rule -- but the CHECK's
 * message is a constraint name, and this one is a sentence.
 */
export const reportRequestSchema = z.discriminatedUnion('reportType', [
  z.object({
    reportType: z.literal('LISTENERS'),
    format: spreadsheetFormat,
    filters: listenersFilters,
  }),
  z.object({
    reportType: z.literal('PARTICIPATIONS'),
    format: spreadsheetFormat,
    filters: participationsFilters,
  }),
  z.object({
    reportType: z.literal('WINNERS'),
    format: spreadsheetFormat,
    filters: winnersFilters,
  }),
  z.object({
    reportType: z.literal('MUSIC_REQUESTS'),
    format: spreadsheetFormat,
    filters: musicRequestsFilters,
  }),
  z.object({
    reportType: z.literal('MOVEMENTS'),
    format: spreadsheetFormat,
    filters: movementsFilters,
  }),
  // A panel takes PDF and nothing else, and carries the period the screen was
  // showing rather than a filter set: its numbers are captured at request time
  // from the aggregate, so the "filter" is the aggregate's own argument shape.
  z.object({
    reportType: z.enum(PANEL_TYPES),
    format: z.literal('PDF'),
    filters: z
      .object({
        preset: z.enum(['current_month', 'previous_month', 'current_year', 'custom']),
        from: isoDate.nullable().optional(),
        to: isoDate.nullable().optional(),
      })
      .strict(),
  }),
]);

export type ReportRequest = z.infer<typeof reportRequestSchema>;

/** One run, as `/reports` renders it. */
export const reportRunSchema = z
  .object({
    id: z.string().uuid(),
    organization_id: z.string().uuid(),
    company_ids: z.array(z.string().uuid()).min(1),
    requested_by: z.string().uuid(),
    report_type: z.enum(REPORT_TYPES),
    format: z.enum(REPORT_FORMATS),
    filters: z.record(z.unknown()),
    status: z.enum(REPORT_STATUSES),
    storage_path: z.string().nullable(),
    row_count: z.number().int().nullable(),
    byte_size: z.number().int().nullable(),
    withheld: z.array(z.string()),
    attempts: z.number().int(),
    last_error: z.string().nullable(),
    requested_at: z.string(),
    started_at: z.string().nullable(),
    finished_at: z.string().nullable(),
    expires_at: z.string().nullable(),
  })
  // NOT .strict(): this one is read from our own table through select('...'),
  // and payload is deliberately not in the projection -- a panel's captured
  // aggregate can be tens of kilobytes and no screen renders it. Strictness
  // here would reject the row the moment a column is added to the projection.
  .passthrough();

export type ReportRun = z.infer<typeof reportRunSchema>;

/** The columns `/reports` reads. Payload is excluded on purpose; see above. */
export const REPORT_RUN_COLUMNS =
  'id, organization_id, company_ids, requested_by, report_type, format, filters, status, ' +
  'storage_path, row_count, byte_size, withheld, attempts, last_error, ' +
  'requested_at, started_at, finished_at, expires_at';

export const LISTING_TYPE_VALUES = LISTING_TYPES;
