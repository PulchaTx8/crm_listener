import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/supabase/database.types';
import { provenanceLines, visibleColumns } from './provenance';
import { createCsvWriter, createXlsxWriter, type ReportWriter } from './writers';
import {
  FORMAT_CONTENT_TYPES,
  FORMAT_EXTENSIONS,
  isPanelType,
  REPORT_PAGE_SIZE,
  REPORT_ROW_CEILING,
  type ListingType,
  type ReportPageRow,
} from './types';

type ServiceClient = SupabaseClient<Database>;

/** One run row, as the worker reads it. */
export interface ClaimedRun {
  id: string;
  organization_id: string;
  company_ids: string[];
  requested_by: string;
  report_type: string;
  format: 'CSV' | 'XLSX' | 'PDF';
  filters: Record<string, unknown>;
  payload: unknown;
  requested_at: string;
}

export interface GeneratedReport {
  rowCount: number;
  byteSize: number;
  withheld: string[];
  storagePath: string;
}

export const REPORT_BUCKET = 'reports';

/**
 * Block 8b. One run, from first page to uploaded object.
 *
 * The caller (drain.ts) has already claimed the run, so this either returns a
 * finished file or throws -- there is no third outcome, and no partial upload:
 * the bytes are assembled before anything reaches storage, so a page that
 * raises halfway leaves nothing behind to be signed later.
 */
export async function generateReportRun(
  supabase: ServiceClient,
  run: ClaimedRun,
): Promise<GeneratedReport> {
  const body = isPanelType(run.report_type as never)
    ? await renderPanel(supabase, run)
    : await renderListing(supabase, run);

  // {company_id}/{run_id}.{ext}. The first segment is for a human reading the
  // bucket during an incident; the permission is carried by the run row, which
  // 0123's policy reaches.
  const storagePath = `${run.company_ids[0]}/${run.id}.${FORMAT_EXTENSIONS[run.format]}`;

  const upload = await supabase.storage
    .from(REPORT_BUCKET)
    .upload(storagePath, body.bytes, {
      contentType: FORMAT_CONTENT_TYPES[run.format],
      // upsert false, deliberately. A second write to the same path means the
      // run was claimed twice -- which `for update skip locked` is supposed to
      // make impossible -- and that must fail loudly rather than overwrite.
      upsert: false,
    });

  if (upload.error) {
    throw new Error(`upload failed: ${upload.error.message}`);
  }

  return {
    rowCount: body.rowCount,
    byteSize: body.bytes.byteLength,
    withheld: body.withheld,
    storagePath,
  };
}

interface RenderedBody {
  bytes: Buffer;
  rowCount: number;
  withheld: string[];
}

async function renderListing(supabase: ServiceClient, run: ClaimedRun): Promise<RenderedBody> {
  const reportType = run.report_type as ListingType;
  const writer: ReportWriter = run.format === 'XLSX' ? createXlsxWriter() : createCsvWriter();

  let cursorAt: string | null = null;
  let cursorId: string | null = null;
  let rowCount = 0;
  let withheld: string[] = [];
  let started = false;
  let columns = visibleColumns(reportType, []);

  for (;;) {
    const page = await fetchPage(supabase, run, cursorAt, cursorId);

    if (!started) {
      // The first page carries the answers the whole file depends on:
      // total_count for the ceiling, and the withheld set for the shape. Both
      // ride back from the same CTE the rows come from, so neither can
      // disagree with the rows below it.
      const first = page[0];
      const total = first?.total_count ?? 0;
      if (total > REPORT_ROW_CEILING) {
        throw new Error(
          `this report would have ${total} rows, above the limit of ${REPORT_ROW_CEILING} — narrow the filter`,
        );
      }
      // An empty result withholds nothing, and that is the truthful answer:
      // there are no columns to have withheld. The provenance block then says
      // "none", which is what a reader of an empty export needs to know.
      withheld = first?.withheld ?? [];
      columns = visibleColumns(reportType, withheld);

      writer.writeProvenance(
        provenanceLines({
          reportType: reportType,
          stationNames: await stationNames(supabase, run.company_ids),
          filters: run.filters,
          requestedByLabel: await requesterLabel(supabase, run.requested_by),
          requestedAt: run.requested_at,
          rowCount: total,
          withheld,
        }),
      );
      writer.writeHeader(columns);
      started = true;
    }

    for (const row of page) {
      writer.writeRow(columns, row.row_data);
      rowCount += 1;
    }

    // A short page is the last page. Asking again to see an empty one would
    // double the round trips for every report in the system.
    const last = page[page.length - 1];
    if (page.length < REPORT_PAGE_SIZE || !last) break;

    cursorAt = last.sort_at;
    cursorId = last.sort_id;
  }

  return { bytes: await writer.finish(), rowCount, withheld };
}

async function fetchPage(
  supabase: ServiceClient,
  run: ClaimedRun,
  cursorAt: string | null,
  cursorId: string | null,
): Promise<ReportPageRow[]> {
  const { data, error } = await supabase.rpc('report_page', {
    // The identity the worker does not have, carried explicitly. 0121 exists
    // for this argument: the check runs against the person who ASKED, on every
    // page, so a permission revoked mid-file closes the door mid-file.
    p_user_id: run.requested_by,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    p_report_type: run.report_type as any,
    p_company_ids: run.company_ids,
    // `filters` is jsonb on both sides; the generated Json type does not admit
    // an open Record, and widening our own type to Json would push the cast
    // into every caller instead.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    p_filters: run.filters as any,
    p_cursor_at: cursorAt ?? undefined,
    p_cursor_id: cursorId ?? undefined,
    p_limit: REPORT_PAGE_SIZE,
  });

  if (error) {
    // 42501 here is not a bug: it is a permission revoked between the request
    // and this page. The run fails and says so, which is the designed outcome.
    throw new Error(`${error.code ?? 'error'}: ${error.message}`);
  }

  return (data ?? []) as unknown as ReportPageRow[];
}

async function renderPanel(supabase: ServiceClient, run: ClaimedRun): Promise<RenderedBody> {
  const { renderPanelPdf } = await import('./pdf');
  const bytes = await renderPanelPdf({
    reportType: run.report_type as never,
    payload: run.payload,
    stationNames: await stationNames(supabase, run.company_ids),
    filters: run.filters,
    requestedByLabel: await requesterLabel(supabase, run.requested_by),
    requestedAt: run.requested_at,
  });

  // A panel has no rows. Recording 0 rather than the number of cards keeps
  // row_count meaning one thing across the whole table.
  return { bytes, rowCount: 0, withheld: extractWithheld(run.payload) };
}

/**
 * A panel's withheld set is NOT the shape a listing's is. 8a ships
 * `{ figure, needs }` objects (schemas/dashboards.ts, withheldSchema) where a
 * listing page function returns bare column names, and report_runs.withheld is
 * text[]. The figure name is what goes in; `needs` is already rendered into the
 * PDF footer, so nothing is lost.
 */
function extractWithheld(payload: unknown): string[] {
  if (payload && typeof payload === 'object' && 'withheld' in payload) {
    const value = (payload as { withheld: unknown }).withheld;
    if (Array.isArray(value)) {
      return value
        .map((item) => {
          if (typeof item === 'string') return item;
          if (item && typeof item === 'object' && 'figure' in item) {
            const figure = (item as { figure: unknown }).figure;
            return typeof figure === 'string' ? figure : null;
          }
          return null;
        })
        .filter((item): item is string => item !== null);
    }
  }
  return [];
}

async function stationNames(supabase: ServiceClient, companyIds: string[]): Promise<string[]> {
  const { data } = await supabase.from('companies').select('id, name').in('id', companyIds);
  const byId = new Map((data ?? []).map((row) => [row.id, row.name]));
  // Falling back to the id rather than dropping the Station: a provenance block
  // that silently lists fewer Stations than the report covers is the same class
  // of lie the withheld contract exists to prevent.
  return companyIds.map((id) => byId.get(id) ?? id);
}

async function requesterLabel(supabase: ServiceClient, userId: string): Promise<string> {
  const { data } = await supabase
    .from('profiles')
    .select('full_name')
    .eq('id', userId)
    .maybeSingle();
  // full_name is nullable in production (0003), and an e-mail is deliberately
  // not used as the fallback -- 0096 removed exactly that coalesce in review.
  // The id is not friendly, but it is true and it resolves to one person.
  return data?.full_name ?? userId;
}
