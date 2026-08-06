import { PassThrough } from 'node:stream';
import { csvComment, csvRow, UTF8_BOM } from './csv';
import type { ReportColumn } from './types';

/**
 * Block 8b. One interface, two spreadsheet writers, so `generate.ts` walks the
 * page loop once and does not branch on format anywhere inside it.
 *
 * Both accumulate the finished bytes, because the Supabase storage client takes
 * a body rather than a stream, and a report at the 50 000-row ceiling is a few
 * megabytes -- the ceiling is what makes that a defensible choice rather than a
 * gamble. The XLSX writer still uses the STREAMING workbook writer underneath:
 * that is not about the final buffer, it is about never holding fifty thousand
 * cell objects in the heap at once, which is what the ordinary Workbook does.
 */
export interface ReportWriter {
  writeProvenance(lines: readonly string[]): void;
  writeHeader(columns: readonly ReportColumn[]): void;
  writeRow(columns: readonly ReportColumn[], row: Record<string, unknown>): void;
  finish(): Promise<Buffer>;
}

export function createCsvWriter(): ReportWriter {
  const parts: string[] = [UTF8_BOM];

  return {
    writeProvenance(lines) {
      for (const line of lines) parts.push(csvComment(line), '\r\n');
      // A blank line between the block and the header, so a reader who scrolls
      // past the provenance can see where the data starts.
      parts.push('\r\n');
    },
    writeHeader(columns) {
      parts.push(csvRow(columns.map((column) => column.header)), '\r\n');
    },
    writeRow(columns, row) {
      parts.push(csvRow(columns.map((column) => row[column.key])), '\r\n');
    },
    async finish() {
      return Buffer.from(parts.join(''), 'utf8');
    },
  };
}

export function createXlsxWriter(): ReportWriter {
  // Required lazily. exceljs pulls in a large dependency tree, and the CSV path
  // -- which is most exports -- should not pay for it.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const ExcelJS = require('exceljs') as typeof import('exceljs');

  const sink = new PassThrough();
  const chunks: Buffer[] = [];
  sink.on('data', (chunk: Buffer) => chunks.push(chunk));
  const drained = new Promise<void>((resolve, reject) => {
    sink.on('end', () => resolve());
    sink.on('error', reject);
  });

  const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({ stream: sink, useSharedStrings: false });
  // The provenance gets a sheet of its own rather than rows above the data: a
  // spreadsheet's first row is its header to every tool that reads one, and
  // comment rows above it break sorting, filtering and every import.
  const provenance = workbook.addWorksheet('Provenance');
  const sheet = workbook.addWorksheet('Rows');

  return {
    writeProvenance(lines) {
      for (const line of lines) provenance.addRow([line]).commit();
    },
    writeHeader(columns) {
      const header = sheet.addRow(columns.map((column) => column.header));
      header.font = { bold: true };
      header.commit();
    },
    writeRow(columns, row) {
      // No formula-lead escaping here, unlike the CSV writer, and the asymmetry
      // is real rather than an oversight: exceljs writes a plain string as a
      // string cell, and a string cell holding "=1+1" is the text "=1+1". Only
      // a { formula } object becomes a formula, and nothing below builds one.
      // CSV has no such distinction, which is why it needs the prefix.
      sheet
        .addRow(
          columns.map((column) => {
            const value = row[column.key];
            if (value === null || value === undefined) return null;
            if (typeof value === 'boolean' || typeof value === 'number') return value;
            if (typeof value === 'string') return value;
            return JSON.stringify(value);
          }),
        )
        .commit();
    },
    async finish() {
      provenance.commit();
      sheet.commit();
      await workbook.commit();
      await drained;
      return Buffer.concat(chunks);
    },
  };
}
