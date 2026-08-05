import { describe, expect, it } from 'vitest';
import { csvComment, csvRow, escapeCsvValue } from '@/lib/reports/csv';

describe('CSV escaping', () => {
  it('quotes a value holding the delimiter, a quote or a newline', () => {
    expect(escapeCsvValue('Smith, John')).toBe('"Smith, John"');
    expect(escapeCsvValue('he said "no"')).toBe('"he said ""no"""');
    expect(escapeCsvValue('line one\nline two')).toBe('"line one\nline two"');
    expect(escapeCsvValue('plain')).toBe('plain');
  });

  it('writes null and undefined as an empty field, never the word', () => {
    expect(escapeCsvValue(null)).toBe('');
    expect(escapeCsvValue(undefined)).toBe('');
    // The string "null" in a phone column is a value somebody will try to call.
    expect(escapeCsvValue('null')).toBe('null');
  });

  it('writes booleans and numbers without quoting them', () => {
    expect(escapeCsvValue(true)).toBe('true');
    expect(escapeCsvValue(false)).toBe('false');
    expect(escapeCsvValue(42)).toBe('42');
    // Infinity and NaN have no CSV spelling that round-trips; an empty field is
    // honest, where "Infinity" would be read back as text.
    expect(escapeCsvValue(Number.NaN)).toBe('');
  });

  /**
   * The assertion this file exists for.
   *
   * A listener's name reaches this system through the WhatsApp ingestion path,
   * where it is whatever the person on the other end typed. These files are
   * opened in Excel by people who did not generate them, and Excel evaluates a
   * cell beginning `=`, `+`, `-` or `@` as a formula.
   */
  it('defuses a value that a spreadsheet would evaluate as a formula', () => {
    expect(escapeCsvValue('=1+1')).toBe("'=1+1");
    expect(escapeCsvValue('+1234')).toBe("'+1234");
    expect(escapeCsvValue('-1+1')).toBe("'-1+1");
    expect(escapeCsvValue('@SUM(A1:A9)')).toBe("'@SUM(A1:A9)");
    // Excel strips leading whitespace before deciding, so a leading space does
    // not make it safe.
    expect(escapeCsvValue(' =1+1')).toBe("' =1+1");
    // And the prefix survives alongside RFC 4180 quoting when both apply.
    expect(escapeCsvValue('=HYPERLINK("http://x","a"),b')).toBe(
      '"\'=HYPERLINK(""http://x"",""a""),b"',
    );
  });

  it('does not prefix an ordinary value that merely contains an operator', () => {
    expect(escapeCsvValue('Jean-Paul')).toBe('Jean-Paul');
    expect(escapeCsvValue('a@b.com')).toBe('a@b.com');
  });

  it('joins a row and marks a comment line', () => {
    expect(csvRow(['a', 'b,c', null])).toBe('a,"b,c",');
    expect(csvComment('Report: Listeners')).toBe('# Report: Listeners');
  });
});
