/**
 * Block 8b. CSV, and the two escapes that matter.
 *
 * RFC 4180 quoting is the ordinary one. The other is not ordinary and is the
 * reason this file has tests of its own.
 */

/** RFC 4180: quote when the value holds a delimiter, a quote, or a newline. */
const NEEDS_QUOTING = /[",\r\n]/;

/**
 * The first characters Excel, LibreOffice and Google Sheets treat as the start
 * of a FORMULA rather than of text.
 *
 * This is not theoretical here. A listener's name reaches this system through
 * the WhatsApp ingestion path (Block 5), where it is whatever the person on the
 * other end typed; these files are then opened, by people who did not generate
 * them, in an application that will evaluate `=HYPERLINK(...)` or
 * `=cmd|'/c calc'!A1` on open. The value is prefixed with a single quote, which
 * every spreadsheet reads as "the rest is text" and which survives a round trip
 * through the same tools.
 *
 * Tab and carriage return are included because Excel strips leading whitespace
 * before deciding, so " =1+1" is still a formula to it.
 */
const FORMULA_LEAD = /^[\s]*[=+\-@\t\r]/;

export function escapeCsvValue(value: unknown): string {
  if (value === null || value === undefined) return '';

  // Booleans and numbers go out unquoted and unprefixed: neither can carry a
  // delimiter and neither is attacker-controlled.
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';

  let text = typeof value === 'string' ? value : JSON.stringify(value);

  if (FORMULA_LEAD.test(text)) text = `'${text}`;

  if (NEEDS_QUOTING.test(text)) {
    return `"${text.replaceAll('"', '""')}"`;
  }
  return text;
}

export function csvRow(values: readonly unknown[]): string {
  return values.map(escapeCsvValue).join(',');
}

/**
 * A comment line for the provenance block. `#` is not part of RFC 4180 and no
 * spreadsheet skips it -- these lines land as a first column, which is exactly
 * what is wanted: the provenance must be visible to somebody who opens the file
 * in Excel, not only to somebody who reads it in a text editor.
 */
export function csvComment(line: string): string {
  return csvRow([`# ${line}`]);
}

/**
 * The BOM. Excel on Windows reads a CSV as the system codepage unless the file
 * opens with one, which turns every accented listener name into mojibake -- and
 * this application's audience is Brazilian.
 */
export const UTF8_BOM = '﻿';
