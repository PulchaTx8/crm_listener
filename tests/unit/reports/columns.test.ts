import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LISTING_TYPES, REPORT_COLUMNS, type ListingType } from '@/lib/reports/types';
import { reportRequestSchema } from '@/schemas/reports';

/**
 * Block 8b. The one test that holds TypeScript and SQL in agreement.
 *
 * REPORT_COLUMNS decides the order and the headings of every spreadsheet this
 * block writes; the `jsonb_build_object` calls in 0124 and 0125 decide which
 * keys exist. A key in the first that the second does not produce becomes a
 * COLUMN OF BLANKS -- and a blank column is the one thing design D7 forbids,
 * because it is a statement about the data rather than about the query.
 *
 * Nothing else in the repository can catch that: the SQL compiles, the TypeScript
 * compiles, the export succeeds, and the file is quietly wrong.
 *
 * So this parses the migrations. Reading SQL with a regular expression is
 * usually a bad idea and is the right one here: the alternative is a live
 * database in a unit test, and the shape being matched -- a quoted key followed
 * by a comma inside jsonb_build_object -- is stable in a file this block owns.
 */

const MIGRATIONS = join(process.cwd(), 'supabase', 'migrations');

const SOURCE_FILES: Record<ListingType, string> = {
  LISTENERS: '0124_report_pages_a.sql',
  PARTICIPATIONS: '0124_report_pages_a.sql',
  WINNERS: '0125_report_pages_b.sql',
  MUSIC_REQUESTS: '0125_report_pages_b.sql',
  MOVEMENTS: '0125_report_pages_b.sql',
};

const FUNCTION_NAMES: Record<ListingType, string> = {
  LISTENERS: 'report_page_listeners',
  PARTICIPATIONS: 'report_page_participations',
  WINNERS: 'report_page_winners',
  MUSIC_REQUESTS: 'report_page_music_requests',
  MOVEMENTS: 'report_page_movements',
};

/** Every `'key',` appearing inside the function's jsonb_build_object calls. */
function keysProducedBy(type: ListingType): Set<string> {
  const sql = readFileSync(join(MIGRATIONS, SOURCE_FILES[type]), 'utf8');

  const start = sql.indexOf(`create function public.${FUNCTION_NAMES[type]}(`);
  expect(start, `${FUNCTION_NAMES[type]} is defined in ${SOURCE_FILES[type]}`).toBeGreaterThan(-1);

  // Up to the comment that closes every one of these functions.
  const end = sql.indexOf(`comment on function public.${FUNCTION_NAMES[type]}`, start);
  const body = sql.slice(start, end === -1 ? undefined : end);

  const keys = new Set<string>();
  for (const block of buildObjectBlocks(body)) {
    for (const match of block.matchAll(/'([a-z_]+)'\s*,/g)) {
      if (match[1]) keys.add(match[1]);
    }
  }
  return keys;
}

/**
 * Every jsonb_build_object(...) call in the body, matched by BALANCING
 * PARENTHESES rather than by a lazy regex.
 *
 * The lazy version was written first and was wrong in a way worth recording,
 * because it failed in the safe direction and could easily have been "fixed" by
 * deleting the assertion. It looked for the closing paren followed by a comma or
 * `||`, which misses the SECOND build in every page function that has one -- the
 * conditional `case when v_names then jsonb_build_object(...) else '{}' end`
 * that carries exactly the identity columns. So the test reported `name` and
 * `phone` as unbuilt in three reports where the SQL builds them perfectly well.
 */
function buildObjectBlocks(body: string): string[] {
  const blocks: string[] = [];
  const marker = 'jsonb_build_object(';

  for (let index = body.indexOf(marker); index !== -1; index = body.indexOf(marker, index + 1)) {
    let depth = 0;
    let cursor = index + marker.length - 1;
    for (; cursor < body.length; cursor += 1) {
      const character = body[cursor];
      if (character === '(') depth += 1;
      else if (character === ')') {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    blocks.push(body.slice(index + marker.length, cursor));
  }

  return blocks;
}

describe('report columns and the SQL that fills them', () => {
  it.each(LISTING_TYPES)('%s: every declared column is a key the SQL produces', (type) => {
    const produced = keysProducedBy(type);
    const declared = REPORT_COLUMNS[type].map((column) => column.key);

    // The direction that matters. A declared key the SQL never builds is a
    // column of blanks in a real export.
    const missing = declared.filter((key) => !produced.has(key));
    expect(missing, `${type} declares keys 0124/0125 do not build`).toEqual([]);
  });

  it.each(LISTING_TYPES)('%s: no column is declared twice', (type) => {
    const keys = REPORT_COLUMNS[type].map((column) => column.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it.each(LISTING_TYPES)('%s: every column has a heading a human can read', (type) => {
    for (const column of REPORT_COLUMNS[type]) {
      expect(column.header.length).toBeGreaterThan(0);
      expect(column.header).not.toBe(column.key);
    }
  });

  it('carries no full CPF column anywhere, because none exists to carry', () => {
    for (const type of LISTING_TYPES) {
      const keys = REPORT_COLUMNS[type].map((column) => column.key);
      expect(keys).not.toContain('cpf');
      expect(keys).not.toContain('cpf_hash');
    }
  });
});

describe('the request schema', () => {
  it('refuses a listing in PDF and a panel in CSV', () => {
    expect(
      reportRequestSchema.safeParse({ reportType: 'LISTENERS', format: 'PDF', filters: {} })
        .success,
    ).toBe(false);
    expect(
      reportRequestSchema.safeParse({
        reportType: 'AUDIENCE_PANEL',
        format: 'CSV',
        filters: { preset: 'current_month' },
      }).success,
    ).toBe(false);
  });

  it('accepts the pairings that 0122 also allows', () => {
    expect(
      reportRequestSchema.safeParse({ reportType: 'LISTENERS', format: 'CSV', filters: {} })
        .success,
    ).toBe(true);
    expect(
      reportRequestSchema.safeParse({
        reportType: 'AUDIENCE_PANEL',
        format: 'PDF',
        filters: { preset: 'current_month' },
      }).success,
    ).toBe(true);
  });

  it('refuses an unknown filter key rather than dropping it', () => {
    // A filter silently not applied produces a report narrowed by nothing,
    // which is wrong in a way nothing on its face reveals.
    const result = reportRequestSchema.safeParse({
      reportType: 'LISTENERS',
      format: 'CSV',
      filters: { situacao: 'ativo' },
    });
    expect(result.success).toBe(false);
  });

  it('refuses a window that does not open before it closes', () => {
    // Both bounds agree with 0117, which refuses p_to <= p_from. 8a shipped a
    // version where the client compared `from > to` and the database refused
    // `<=`, so one date in both inputs passed the client and failed the call.
    expect(
      reportRequestSchema.safeParse({
        reportType: 'LISTENERS',
        format: 'CSV',
        filters: { from: '2026-08-01', to: '2026-08-01' },
      }).success,
    ).toBe(false);
  });

  it('refuses a date that is well-formed but not real', () => {
    expect(
      reportRequestSchema.safeParse({
        reportType: 'LISTENERS',
        format: 'CSV',
        filters: { from: '2026-02-31' },
      }).success,
    ).toBe(false);
  });
});
