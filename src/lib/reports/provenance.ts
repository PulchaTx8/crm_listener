import {
  REPORT_COLUMNS,
  REPORT_TYPE_LABELS,
  WITHHELD_BY_PERMISSION,
  type ListingType,
  type ReportColumn,
  type ReportType,
} from './types';

/**
 * Block 8b, design D7. What a file says about itself.
 *
 * The rule 8a settled for a screen -- a figure the caller's permissions cannot
 * support is withheld and NAMED, never zeroed -- is more dangerous in a file,
 * not less. On a screen an omitted number is a blank that can be explained by
 * the page around it. In a spreadsheet:
 *
 *   - a MISSING column is indistinguishable from a column nobody asked for;
 *   - a PRESENT BUT EMPTY column looks like data. An empty `phone` column reads
 *     as "these listeners have no phone", which is a false statement about
 *     real people.
 *
 * So the columns are absent, and the file says which ones and why. Every
 * rendering of the block below carries the same lines in the same order, because
 * a CSV and an XLSX of the same run that describe themselves differently are two
 * documents, and somebody will eventually compare them.
 */

export interface ProvenanceInput {
  reportType: ReportType;
  stationNames: readonly string[];
  filters: Record<string, unknown>;
  requestedByLabel: string;
  requestedAt: string;
  rowCount: number;
  withheld: readonly string[];
}

export function provenanceLines(input: ProvenanceInput): string[] {
  const lines: string[] = [
    'PulchaTX report',
    `Report: ${REPORT_TYPE_LABELS[input.reportType]}`,
    `Stations: ${input.stationNames.join(', ')}`,
    `Filters: ${describeFilters(input.filters)}`,
    `Requested by: ${input.requestedByLabel}`,
    `Requested at: ${input.requestedAt}`,
    `Rows: ${input.rowCount}`,
  ];

  if (input.withheld.length === 0) {
    // Said explicitly, never left out. A file silent about withholding is
    // indistinguishable from one that quietly dropped a column -- which is the
    // whole failure this block is built to avoid, and staying silent when the
    // answer is "nothing" would leave the reader unable to tell the two files
    // apart.
    lines.push('Withheld columns: none — this file carries every column of this report.');
  } else {
    lines.push(
      `Withheld columns: ${input.withheld
        .map((key) => {
          const permission = WITHHELD_BY_PERMISSION[key];
          return permission ? `${key} (needs ${permission})` : key;
        })
        .join(', ')}`,
    );
    lines.push(
      'These columns are ABSENT from this file rather than empty. An empty column would ' +
        'read as an absence of data; this is an absence of permission.',
    );
  }

  return lines;
}

function describeFilters(filters: Record<string, unknown>): string {
  const entries = Object.entries(filters).filter(
    ([, value]) => value !== null && value !== undefined && value !== '',
  );
  if (entries.length === 0) return 'none';
  return entries.map(([key, value]) => `${key}=${String(value)}`).join('; ');
}

/**
 * The columns a file actually carries: the type's full list, minus whatever the
 * caller's permissions did not support.
 *
 * Filtering HERE rather than at the definition is what lets the provenance block
 * name the missing ones -- REPORT_COLUMNS stays complete, and the difference
 * between it and this is the story the file tells.
 */
export function visibleColumns(
  reportType: ListingType,
  withheld: readonly string[],
): ReportColumn[] {
  const hidden = new Set(withheld);
  return REPORT_COLUMNS[reportType].filter((column) => !hidden.has(column.key));
}
