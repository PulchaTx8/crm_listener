import { describe, expect, it } from 'vitest';
import {
  IMPORT_ROWS_BODY_LIMIT_BYTES,
  decodeImportFile,
  importRowsPayloadBytes,
  normalizeHeader,
  parseFile,
  readDelimited,
  toInstant,
  type ParsedRow,
} from '@/app/(app)/participations/import-form';

const TZ = 'America/Sao_Paulo';

/**
 * The import's own edge-case-dense reader (fix-round finding #4): unexported
 * and untested before this round, despite being the most edge-case-dense code
 * in Task 8's diff — a hand-written RFC 4180 reader, a header matcher that has
 * to survive Excel-pt's accents and punctuation, and a date reader that reads
 * three different shapes against the Station's own zone. Each function is
 * tested here in isolation, the shape tests/unit/participations-schema.test.ts
 * already uses for this directory's schemas.
 */

/**
 * The decode, which had no test because it had no function: the form called
 * `File.text()`, a NON-FATAL UTF-8 decode that turns a malformed byte into
 * U+FFFD and never throws — so the `catch` beside it, whose message said "It
 * has to be a UTF-8 text file", could not fire for the case it named. A
 * Windows-1252 export from Excel-pt imported with its ASCII headers matching
 * perfectly and registered listeners under mojibake names, which then become
 * the deduplication anchors every later import is matched against.
 *
 * `Buffer` is used to build the fixtures because these run in vitest's `node`
 * environment; the bytes are what matters and they are the same bytes a browser
 * would hand `arrayBuffer()`.
 */
describe('decodeImportFile', () => {
  /** The ArrayBuffer a File would give, from explicit bytes. */
  const bytesOf = (...values: number[]) => Uint8Array.from(values).buffer;

  it('reads valid UTF-8 as UTF-8', () => {
    const utf8 = new TextEncoder().encode('nome\nAntônio Gonçalves');
    const result = decodeImportFile(utf8.buffer as ArrayBuffer);
    expect(result.encoding).toBe('utf-8');
    expect(result.text).toBe('nome\nAntônio Gonçalves');
  });

  // 0xF4 is "ô" in Windows-1252 and is not a legal UTF-8 sequence start
  // followed by these bytes — which is exactly the file Excel writes on a
  // machine set to Portuguese, the same machine parseFile already accepts a
  // semicolon delimiter for.
  it('falls back to Windows-1252 and says so, rather than producing U+FFFD', () => {
    // "nome\nAnt<F4>nio" — the mojibake case, in the bytes that cause it.
    const result = decodeImportFile(
      bytesOf(0x6e, 0x6f, 0x6d, 0x65, 0x0a, 0x41, 0x6e, 0x74, 0xf4, 0x6e, 0x69, 0x6f),
    );
    expect(result.encoding).toBe('windows-1252');
    expect(result.text).toBe('nome\nAntônio');
    // The whole point: not a replacement character anywhere. `File.text()`
    // would have returned "Ant�nio" and thrown nothing.
    expect(result.text).not.toContain('�');
  });

  // The guard that has to be able to fire, and the two cases that show why
  // neither DECODER can be the one to fire it.
  //
  // 0x81 is one of the five bytes Windows-1252 leaves unassigned, and
  // `{ fatal: true }` on that decoder does NOT refuse it — the Encoding
  // Standard maps it to U+0081. The first version of this function relied on
  // that refusal and this very case went green where it should have gone red.
  it('throws on a byte no encoding assigns, which neither decoder rejects', () => {
    expect(() => decodeImportFile(bytesOf(0x6e, 0x6f, 0x6d, 0x65, 0x0a, 0x81))).toThrow();
  });

  // And the mirror image, on the other decoder: UTF-16LE ASCII is a run of
  // perfectly legal one-byte UTF-8 sequences, so `{ fatal: true }` on UTF-8
  // accepts it happily. normalizeHeader strips NUL along with every other
  // non-alphanumeric, so "n\0o\0m\0e\0" would have matched the `nome` column
  // and every name in the file would have imported with a NUL between its
  // letters.
  it('throws on UTF-16LE text, which the UTF-8 decoder accepts as ASCII plus NULs', () => {
    const utf16 = Buffer.from('nome\nAna', 'utf16le');
    expect(() =>
      decodeImportFile(utf16.buffer.slice(utf16.byteOffset, utf16.byteOffset + utf16.byteLength)),
    ).toThrow();
  });

  it('carries the encoding through parseFile onto the panel’s own field', () => {
    const { text, encoding } = decodeImportFile(
      // "nome;participou em\nJo<E3>o;01/08/2026"
      bytesOf(
        0x6e, 0x6f, 0x6d, 0x65, 0x3b, 0x70, 0x61, 0x72, 0x74, 0x69, 0x63, 0x69, 0x70, 0x6f, 0x75,
        0x20, 0x65, 0x6d, 0x0a, 0x4a, 0x6f, 0xe3, 0x6f, 0x3b, 0x30, 0x31, 0x2f, 0x30, 0x38, 0x2f,
        0x32, 0x30, 0x32, 0x36,
      ),
    );
    const file = parseFile('lista.csv', text, TZ, encoding);
    expect(file.encoding).toBe('windows-1252');
    expect(file.delimiter).toBe(';');
    expect(file.rows[0]?.fullName).toBe('João');
  });
});

describe('normalizeHeader', () => {
  it('lowercases and strips separators', () => {
    expect(normalizeHeader('Participou Em')).toBe('participouem');
    expect(normalizeHeader('participou_em')).toBe('participouem');
    expect(normalizeHeader('PARTICIPOU-EM')).toBe('participouem');
  });

  // NFD splits an accented letter into a plain one plus a combining mark, so
  // dropping everything outside a-z0-9 removes the accent along with the
  // separators — the whole reason this function reads a Portuguese header at
  // all, since "Não" and "Celular" are exactly what an Excel-pt export writes.
  it('strips accents via NFD decomposition', () => {
    expect(normalizeHeader('Não')).toBe('nao');
    expect(normalizeHeader('Célular')).toBe('celular');
  });

  it('trims surrounding whitespace', () => {
    expect(normalizeHeader('  Nome  ')).toBe('nome');
  });
});

describe('readDelimited', () => {
  it('splits a simple file into records by line, dropping a trailing newline', () => {
    const records = readDelimited('a,b,c\n1,2,3\n', ',');
    expect(records).toEqual([
      { line: 1, values: ['a', 'b', 'c'] },
      { line: 2, values: ['1', '2', '3'] },
    ]);
  });

  it('reads a final record with no trailing newline', () => {
    const records = readDelimited('a,b\n1,2', ',');
    expect(records).toEqual([
      { line: 1, values: ['a', 'b'] },
      { line: 2, values: ['1', '2'] },
    ]);
  });

  // The one thing a naive split(',') gets wrong: a quoted field containing the
  // delimiter must not shift every column after it — this is the whole reason
  // this reader is hand-written rather than `line.split(delimiter)`.
  it('does not split a delimiter inside a quoted field', () => {
    const records = readDelimited('name,age\n"Silva, Ana",30\n', ',');
    expect(records[1]).toEqual({ line: 2, values: ['Silva, Ana', '30'] });
  });

  it('reads `""` as one literal quote inside a quoted field', () => {
    const records = readDelimited('note\n"She said ""hi"""\n', ',');
    expect(records[1]).toEqual({ line: 2, values: ['She said "hi"'] });
  });

  it('treats CRLF the same as a bare LF', () => {
    const records = readDelimited('a,b\r\n1,2\r\n', ',');
    expect(records).toEqual([
      { line: 1, values: ['a', 'b'] },
      { line: 2, values: ['1', '2'] },
    ]);
  });

  // The line number is the PHYSICAL line a record STARTS on. A quoted field
  // may embed a newline, so a record after one must count both of that
  // record's lines, not just its own position among records.
  it('counts physical lines through a quoted newline', () => {
    const records = readDelimited('name,note\n"Ana\nMaria",ok\nBruno,fine\n', ',');
    expect(records[1]).toEqual({ line: 2, values: ['Ana\nMaria', 'ok'] });
    expect(records[2]).toEqual({ line: 4, values: ['Bruno', 'fine'] });
  });

  it('reads with a semicolon delimiter, unaffected by commas inside quotes', () => {
    const records = readDelimited('nome;cidade\n"Silva, Ana";Recife\n', ';');
    expect(records[1]).toEqual({ line: 2, values: ['Silva, Ana', 'Recife'] });
  });
});

describe('toInstant', () => {
  it('returns an empty string for a blank value', () => {
    expect(toInstant('', TZ)).toBe('');
    expect(toInstant('   ', TZ)).toBe('');
  });

  it('takes a value already carrying Z as-is', () => {
    expect(toInstant('2026-07-30T17:30:00.000Z', TZ)).toBe('2026-07-30T17:30:00.000Z');
  });

  it('takes a value already carrying an explicit offset as-is', () => {
    expect(toInstant('2026-07-30T14:30:00-03:00', TZ)).toBe('2026-07-30T17:30:00.000Z');
  });

  // dd/mm/yyyy, what a Brazilian spreadsheet exports. Read against the
  // STATION's zone (São Paulo, UTC-3), never the machine running the test.
  it('reads dd/mm/yyyy with a time as the Station wall clock', () => {
    expect(toInstant('30/07/2026 14:30', TZ)).toBe('2026-07-30T17:30:00.000Z');
  });

  // A date with no time of day is read as midnight in the Station's zone —
  // stated in the panel before writing, not invented silently.
  it('reads a date-only dd/mm/yyyy as midnight in the Station zone', () => {
    expect(toInstant('30/07/2026', TZ)).toBe('2026-07-30T03:00:00.000Z');
  });

  it('reads yyyy-mm-dd with a time, space-separated, as the Station wall clock', () => {
    expect(toInstant('2026-07-30 14:30:00', TZ)).toBe('2026-07-30T17:30:00.000Z');
  });

  it('reads a date-only yyyy-mm-dd as midnight in the Station zone', () => {
    expect(toInstant('2026-07-30', TZ)).toBe('2026-07-30T03:00:00.000Z');
  });

  it('returns an empty string for a value in none of the three shapes', () => {
    expect(toInstant('30-07-2026', TZ)).toBe('');
    expect(toInstant('not a date', TZ)).toBe('');
  });
});

describe('parseFile', () => {
  it('maps Portuguese headers in any order, by name rather than position', () => {
    const csv = 'telefone,participou_em,nome,cpf\n11988887777,30/07/2026 14:30,Ana Maria,12345678901\n';
    const file = parseFile('listeners.csv', csv, TZ);
    expect(file.delimiter).toBe(',');
    expect(file.mapping).toEqual({
      phone: 'telefone',
      participatedAt: 'participou_em',
      fullName: 'nome',
      cpf: 'cpf',
    });
    expect(file.rows).toEqual([
      {
        line: 2,
        fullName: 'Ana Maria',
        phone: '11988887777',
        cpf: '12345678901',
        participatedAt: '2026-07-30T17:30:00.000Z',
      },
    ]);
  });

  it('matches header aliases and English names identically after normalisation', () => {
    const csv = 'Name,Phone,CPF,ParticipatedAt\nBruno,11955554444,98765432100,2026-07-30\n';
    const file = parseFile('en.csv', csv, TZ);
    expect(file.mapping).toEqual({
      fullName: 'Name',
      phone: 'Phone',
      cpf: 'CPF',
      participatedAt: 'ParticipatedAt',
    });
  });

  // Excel set to Portuguese writes semicolons. Never guessed silently — the
  // panel names whichever delimiter won, and this is the count that decides.
  it('picks semicolon when the header line has more semicolons than commas', () => {
    const csv = 'nome;telefone;participou_em\n"Silva, Ana";11988887777;2026-07-30\n';
    const file = parseFile('excel-pt.csv', csv, TZ);
    expect(file.delimiter).toBe(';');
    expect(file.rows[0]?.fullName).toBe('Silva, Ana');
  });

  // A UTF-8 BOM is what Excel writes; left in place it becomes part of the
  // first header and "nome" would not match.
  it('strips a leading UTF-8 BOM before reading the header', () => {
    const csv = '﻿nome,telefone,participou_em\nAna,11988887777,2026-07-30\n';
    const file = parseFile('bom.csv', csv, TZ);
    expect(file.mapping.fullName).toBe('nome');
    expect(file.headers[0]).toBe('nome');
  });

  it('reports a column as not found when no alias matches', () => {
    const csv = 'nome,participou_em\nAna,2026-07-30\n';
    const file = parseFile('no-identifier.csv', csv, TZ);
    expect(file.mapping.phone).toBeUndefined();
    expect(file.mapping.cpf).toBeUndefined();
  });

  // A trailing blank line (or several, from a spreadsheet saved with empty
  // rows at the bottom) must not be reported back as a line with no name —
  // that would be the reader's own mistake billed to the operator.
  it('drops fully blank rows rather than reporting them', () => {
    const csv = 'nome,participou_em\nAna,2026-07-30\n\n,,\n';
    const file = parseFile('blank-rows.csv', csv, TZ);
    expect(file.rows).toHaveLength(1);
  });

  it('reads an unreadable date as an empty participatedAt rather than throwing', () => {
    const csv = 'nome,participou_em\nAna,not a date\n';
    const file = parseFile('bad-date.csv', csv, TZ);
    expect(file.rows[0]?.participatedAt).toBe('');
  });

  it('leaves cpf and phone as the raw file value, punctuation included', () => {
    const csv = 'nome,cpf,telefone,participou_em\nAna,"123.456.789-09","+55 (11) 98765-4321",2026-07-30\n';
    const file = parseFile('punctuated.csv', csv, TZ);
    expect(file.rows[0]?.cpf).toBe('123.456.789-09');
    expect(file.rows[0]?.phone).toBe('+55 (11) 98765-4321');
  });
});

/**
 * Fix-round finding #1: the size check that replaces a silent cap with a
 * stated refusal. importRowsPayloadBytes is exercised directly against real
 * rows rather than through a render, since this project's unit tests run in
 * vitest's `node` environment with no DOM (vitest.config.ts).
 */
describe('importRowsPayloadBytes and IMPORT_ROWS_BODY_LIMIT_BYTES', () => {
  const row: ParsedRow = {
    line: 1,
    fullName: 'Ana Maria',
    phone: '11988887777',
    cpf: '12345678901',
    participatedAt: '2026-07-30T17:30:00.000Z',
  };

  it('measures UTF-8 BYTES, not the JSON string length', () => {
    const accented: ParsedRow = { ...row, fullName: 'José da Conceição' };
    const jsonLength = JSON.stringify([accented]).length;
    const byteLength = importRowsPayloadBytes([accented]);
    // Every accented letter here (é, ç, ã) is two UTF-8 bytes but one UTF-16
    // code unit, so the true byte count must exceed the string's .length.
    expect(byteLength).toBeGreaterThan(jsonLength);
  });

  it('agrees with a direct TextEncoder measurement of the same JSON', () => {
    const rows = [row, { ...row, line: 2, fullName: 'Bruno Costa' }];
    expect(importRowsPayloadBytes(rows)).toBe(
      new TextEncoder().encode(JSON.stringify(rows)).length,
    );
  });

  // The design doc's own reference point (docs/superpowers/specs/
  // 2026-07-30-block-4c-participations-design.md:90): a promotion with eight
  // thousand participations. A file of that size, even built from
  // worst-realistic-case rows (a long accented name, and CPF/phone still
  // carrying the punctuation a spreadsheet cell has), must clear the cap
  // comfortably — this is the regression next.config.mjs's bodySizeLimit and
  // this constant were sized against.
  it('keeps an eight-thousand-row worst-case file comfortably under the cap', () => {
    const worst: ParsedRow = {
      line: 1,
      fullName: 'Maria Aparecida da Conceição Nascimento Oliveira',
      phone: '+55 (11) 98765-4321',
      cpf: '123.456.789-09',
      participatedAt: '2026-07-30T17:30:00.000-03:00',
    };
    const rows = Array.from({ length: 8000 }, (_, i) => ({ ...worst, line: i + 2 }));
    expect(importRowsPayloadBytes(rows)).toBeLessThan(IMPORT_ROWS_BODY_LIMIT_BYTES);
  });

  it('exceeds the cap for a file far past the design doc scale', () => {
    const rows = Array.from({ length: 200_000 }, (_, i) => ({ ...row, line: i + 2 }));
    expect(importRowsPayloadBytes(rows)).toBeGreaterThan(IMPORT_ROWS_BODY_LIMIT_BYTES);
  });
});
