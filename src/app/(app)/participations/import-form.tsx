'use client';

import { useTranslations } from 'next-intl';
import { useActionState, useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { STATUS_CLASSES, STATUS_LABEL_KEYS } from '@/lib/participation-status';
// Both borrowed from the promotions screen rather than re-derived, on that
// module's own rule: a second copy of a timezone conversion is how two controls
// on one screen start disagreeing about which day something happened (spec L2).
import { formatInstant } from '../promotions/format';
import { fromZonedWallClock } from '../promotions/zone';
import { importParticipationsAction, type ImportParticipationsState } from './actions';

const INITIAL: ImportParticipationsState = { status: 'idle' };

/**
 * The four columns of design spec D7, and the header spellings each is accepted
 * under.
 *
 * The spellings are Portuguese because the file is the operator's, not ours —
 * schemas/participations.ts says the same thing from the other side: the field
 * NAMES in this project are English, and the CSV's header row is whatever the
 * Station's spreadsheet already says. The English aliases are here so that a
 * file this system exports one day still imports back into it.
 *
 * Matched after normalisation, so `Participou Em`, `participou_em` and
 * `PARTICIPOU-EM` are one header. Read by NAME and never by position, which is
 * what "in any order" means.
 */
const COLUMN_ALIASES = {
  fullName: ['nome', 'nomecompleto', 'name', 'fullname'],
  phone: ['telefone', 'celular', 'fone', 'whatsapp', 'phone'],
  cpf: ['cpf'],
  participatedAt: [
    'participouem',
    'participou',
    'dataparticipacao',
    'datahora',
    'data',
    'participatedat',
  ],
} as const;

export type ColumnKey = keyof typeof COLUMN_ALIASES;

// Catalogue keys, not the words: a module body has no request behind it.
const COLUMN_LABEL_KEYS: Record<ColumnKey, string> = {
  fullName: 'columnName',
  phone: 'columnPhone',
  cpf: 'columnCpf',
  participatedAt: 'columnWhenTheyEntered',
};

/**
 * The four reasons import_participations skips a row (0054, 0056), each turned
 * into what the operator has to DO about it — which is different in all four
 * cases and is the only reason they are four reasons rather than one.
 *
 * `no identifier` is the operator's own file to fix. `listener is out of reach`
 * cannot be fixed from a file at all: the identifier belongs to somebody at a
 * Station this caller cannot see, and 0031's unique indexes would refuse a
 * second registration, so it needs access rather than editing. `listener is at
 * another station` is the one in between, and telling it apart from the second
 * is the whole point of 0056 giving it its own reason: this listener IS visible
 * to this caller, they simply are not attached to the Station running the
 * promotion, and linking them is something the operator can go and do. `outside
 * the promotion window` is about nobody at all — the line's date falls outside
 * the promotion's own dates, so either the date is wrong or the file belongs to
 * a different promotion, and no amount of access changes that.
 *
 * A lookup with a fallback rather than a ternary. The ternary this replaced read
 * anything that was not `no identifier` as "out of reach", so 0056's new reasons
 * would have rendered as an instruction to ask for a permission the operator
 * already held — and a fifth reason in Block 5 would do the same silently.
 *
 * Keyed by the database's own word, valued by a catalogue key: the wording has
 * to exist in three languages, and this module body has no request behind it.
 */
const SKIP_REASON_KEYS: Record<string, string> = {
  'no identifier': 'skipReasonNoIdentifier',
  'listener is out of reach': 'skipReasonOutOfReach',
  'listener is at another station': 'skipReasonAtAnotherStation',
  'outside the promotion window': 'skipReasonOutsideWindow',
};

/**
 * What the operator reads beside a skipped line. Three answers, in order: the
 * written instruction for a reason this build knows, the database's own word
 * for one it does not, and a last resort for a row that carries no reason at
 * all. The middle case is the point — a fifth reason added in SQL renders its
 * raw code, which is a worse sentence than a written one and a far better one
 * than the wrong sentence.
 */
function describeSkipReason(
  reason: string | null | undefined,
  t: (key: string) => string,
): string {
  const key = reason ? SKIP_REASON_KEYS[reason] : undefined;
  if (key) return t(key);
  return reason ?? t('theImportCouldNotUseThisLine');
}

/**
 * One line of the file, mapped but not yet validated — importRowSchema does
 * that on the server. Exported for the same reason the four functions below
 * are: it is the shape their unit tests assert against.
 */
export interface ParsedRow {
  line: number;
  fullName: string;
  phone: string;
  cpf: string;
  /** An instant, or '' when the file's value could not be read as a date. */
  participatedAt: string;
}

/** What the bytes were read as. Named on screen, never assumed silently. */
export type ImportEncoding = 'utf-8' | 'windows-1252';

export interface ParsedFile {
  name: string;
  delimiter: string;
  encoding: ImportEncoding;
  headers: string[];
  /** Which header each column was found under; a missing one is what stops the import. */
  mapping: Partial<Record<ColumnKey, string>>;
  rows: ParsedRow[];
}

/**
 * Control characters no spreadsheet ever puts in a CSV: C0 except tab, newline
 * and carriage return, DEL, and the whole C1 block.
 *
 * This is the only thing standing between the reader and a file that is neither
 * of the two encodings below, and it is needed because NEITHER decoder can
 * refuse one:
 *
 *   - Windows-1252's decoder cannot fail at all. The Encoding Standard maps
 *     every one of its five unassigned bytes (0x81, 0x8D, 0x8F, 0x90, 0x9D) to
 *     the matching C1 code point, so `{ fatal: true }` on it is a no-op —
 *     measured, not assumed; the first version of this function relied on it and
 *     its own test went green where it should have gone red.
 *   - UTF-8's decoder cannot fail on UTF-16LE text that is all ASCII: `n\0o\0m\0`
 *     is a run of perfectly legal one-byte sequences. The headers then normalise
 *     correctly (normalizeHeader strips anything outside a-z0-9, NUL included)
 *     and the file would import with a NUL between every letter of every name.
 *
 * So "is this text at all" is asked of the RESULT rather than of the decoder,
 * on both branches. That is what makes the refusal in onFileChosen a guard that
 * can fire, which is this project's rule for shipping one.
 */
const NOT_TEXT = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/;

/**
 * The bytes, turned into text, with the encoding SAID rather than assumed.
 *
 * This replaced `await chosen.text()`, which is a non-fatal UTF-8 decode: a
 * malformed byte becomes U+FFFD and nothing throws, so the `catch` that showed
 * "It has to be a UTF-8 text file" was unreachable for the exact case its own
 * copy named. Excel on a Windows machine set to Portuguese writes Windows-1252
 * — the same machine this file already reasons about two functions down, where
 * it accepts a semicolon delimiter for the same reason — and the ASCII headers
 * still matched, so the file imported and registered listeners under
 * permanently mojibake names. Those names then BECOME the deduplication anchors
 * every future import matches against, which is what makes it worth more than a
 * cosmetic fix.
 *
 * Two attempts, in the order that cannot guess wrong. UTF-8 with `fatal: true`
 * first: valid UTF-8 is not ambiguous, so anything that decodes cleanly is
 * decoded correctly. Only when that throws is Windows-1252 tried, and the panel
 * then names it beside the delimiter, with the first row's own name rendered
 * underneath — the operator's check that "Antônio" is not "AntÃ´nio", the same
 * check they already make on the date.
 *
 * REFUSING Windows-1252 outright was the other candidate, and it is what the
 * message this function makes reachable used to demand. Rejected on this file's
 * own established reasoning about the semicolon delimiter: refusing it would
 * refuse the commonest file this feature will ever be handed, on the very
 * machine the delimiter branch was written for. Accepted and NAMED is the shape
 * that already exists here — never silent.
 *
 * Not chardet or a byte-frequency heuristic: guessing between eight Latin
 * encodings that all decode without error is a guess presented as a fact, and
 * the panel already gives the operator a better instrument than any heuristic —
 * their own listener's name, on screen, before anything is written.
 *
 * Exported for the same reason the four readers below are: it is the shape its
 * unit tests assert against, and a decode is not something a render can prove.
 */
export function decodeImportFile(bytes: ArrayBuffer): { text: string; encoding: ImportEncoding } {
  let utf8: string | null = null;
  try {
    utf8 = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    // Not UTF-8. Fall through to the one other encoding worth trying.
  }

  const text = utf8 ?? new TextDecoder('windows-1252').decode(bytes);
  if (NOT_TEXT.test(text)) {
    throw new Error('this file is not text in either encoding this reader accepts');
  }
  return { text, encoding: utf8 === null ? 'windows-1252' : 'utf-8' };
}

/**
 * NFD splits an accented letter into a plain one and a combining mark, so
 * dropping everything outside `a-z0-9` afterwards strips the accents together
 * with the spaces, underscores, dots and dashes in one pass.
 *
 * One expression rather than a combining-mark range followed by a separator
 * range: the range spelling needs a class of characters that are invisible in
 * an editor, and anything that is not a letter or a digit is noise in a header
 * name anyway.
 *
 * Exported (with readDelimited, toInstant and parseFile below) so this
 * codebase's edge-case-dense reader has a direct unit test rather than only
 * the review it got via a throwaway e2e smoke spec — see
 * tests/unit/participation-import.test.ts.
 */
export function normalizeHeader(raw: string): string {
  return raw.trim().toLowerCase().normalize('NFD').replace(/[^a-z0-9]/g, '');
}

/**
 * A minimal RFC 4180 reader: quoted fields, `""` for a literal quote, CRLF or
 * LF line endings.
 *
 * Hand-written rather than a dependency because the whole of what this needs is
 * four columns of text — and because the one thing a naive `split(',')` gets
 * wrong here matters. A quoted name containing a comma ("Silva, Ana Maria")
 * would shift every column after it, so the row would import against the wrong
 * person rather than fail, which is the one direction a reading mistake here
 * must not go.
 *
 * The line number is the PHYSICAL line each record starts on, not its index
 * among the records: a quoted field may contain a newline, and this number is
 * going back to an operator who will look for it in their spreadsheet.
 */
export function readDelimited(text: string, delimiter: string): { line: number; values: string[] }[] {
  const records: { line: number; values: string[] }[] = [];
  let values: string[] = [];
  let field = '';
  let inQuotes = false;
  let line = 1;
  let recordLine = 1;
  let touched = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        if (ch === '\n') line += 1;
        field += ch;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
      touched = true;
      continue;
    }
    if (ch === delimiter) {
      values.push(field);
      field = '';
      touched = true;
      continue;
    }
    if (ch === '\r') continue;
    if (ch === '\n') {
      values.push(field);
      records.push({ line: recordLine, values });
      values = [];
      field = '';
      line += 1;
      recordLine = line;
      touched = false;
      continue;
    }
    field += ch;
    touched = true;
  }

  if (touched || field !== '' || values.length > 0) {
    values.push(field);
    records.push({ line: recordLine, values });
  }

  return records;
}

/**
 * The file's own date format, read against the STATION's zone.
 *
 * In the browser and never on the server, the rule schemas/participations.ts
 * states for this field in particular: only the browser knows which Station was
 * on screen, and `01/08/2026 14:30` parsed in whatever zone the server process
 * happens to run in is wrong by hours with nothing downstream able to notice.
 *
 * Three shapes, and only the first is already an instant:
 *
 *   - anything carrying `Z` or an explicit offset is taken as it stands;
 *   - `dd/mm/yyyy`, which is what a Brazilian spreadsheet exports;
 *   - `yyyy-mm-dd`, which is what everything else exports.
 *
 * A value with no time of day is read as midnight in the Station's zone, and
 * the mapping shown before the import says so out loud. A date-only column is
 * the ordinary case in a hand-kept spreadsheet, so refusing it would refuse most
 * real files, while assuming noon would be inventing a fact — and design spec D7
 * is explicit that this value is not decoration: the minimum interval measures
 * against it.
 */
export function toInstant(raw: string, timeZone: string): string {
  const value = raw.trim();
  if (!value) return '';

  if (/([zZ]|[+-]\d{2}:?\d{2})$/.test(value)) {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? '' : new Date(parsed).toISOString();
  }

  const pad = (v: string | undefined, width = 2) => (v ?? '0').padStart(width, '0');

  const dayFirst = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(
    value,
  );
  if (dayFirst) {
    const wall = `${dayFirst[3]}-${pad(dayFirst[2])}-${pad(dayFirst[1])}T${pad(dayFirst[4])}:${pad(dayFirst[5])}:${pad(dayFirst[6])}`;
    return fromZonedWallClock(wall, timeZone) ?? '';
  }

  const yearFirst = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(
    value,
  );
  if (yearFirst) {
    const wall = `${yearFirst[1]}-${pad(yearFirst[2])}-${pad(yearFirst[3])}T${pad(yearFirst[4])}:${pad(yearFirst[5])}:${pad(yearFirst[6])}`;
    return fromZonedWallClock(wall, timeZone) ?? '';
  }

  return '';
}

export function parseFile(
  name: string,
  text: string,
  timeZone: string,
  encoding: ImportEncoding = 'utf-8',
): ParsedFile {
  // A UTF-8 BOM is what Excel writes, and left in place it becomes part of the
  // first header — so `nome` would not match and a perfectly good file would be
  // refused over a byte nobody can see. Compared by code point rather than
  // stripped with a regexp for the reason normalizeHeader gives.
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

  // Comma per the spec; semicolon accepted because that is what Excel writes on
  // a machine set to Portuguese, and refusing it would refuse the commonest file
  // this feature will ever be handed. Never silent: the panel below names the
  // separator it used, so a file that read as one column says so instead of
  // looking empty.
  const breakAt = body.indexOf('\n');
  const firstLine = breakAt === -1 ? body : body.slice(0, breakAt);
  const delimiter =
    (firstLine.match(/;/g)?.length ?? 0) > (firstLine.match(/,/g)?.length ?? 0) ? ';' : ',';

  const records = readDelimited(body, delimiter);
  const headers = (records[0]?.values ?? []).map((h) => h.trim());
  const normalized = headers.map(normalizeHeader);

  const mapping: Partial<Record<ColumnKey, string>> = {};
  const index: Partial<Record<ColumnKey, number>> = {};
  (Object.keys(COLUMN_ALIASES) as ColumnKey[]).forEach((key) => {
    const found = normalized.findIndex((h) =>
      (COLUMN_ALIASES[key] as readonly string[]).includes(h),
    );
    if (found >= 0) {
      index[key] = found;
      mapping[key] = headers[found];
    }
  });

  const valueOf = (values: string[], key: ColumnKey) => {
    const position = index[key];
    return position === undefined ? '' : (values[position] ?? '').trim();
  };

  const rows = records
    .slice(1)
    // A trailing newline produces one empty record, and a spreadsheet saved with
    // blank rows at the bottom produces several. Reporting those back as lines
    // with no name would be reporting our own reading of the file as the
    // operator's mistake.
    .filter((record) => record.values.some((value) => value.trim() !== ''))
    .map((record) => ({
      line: record.line,
      fullName: valueOf(record.values, 'fullName'),
      phone: valueOf(record.values, 'phone'),
      cpf: valueOf(record.values, 'cpf'),
      participatedAt: toInstant(valueOf(record.values, 'participatedAt'), timeZone),
    }));

  return { name, delimiter, encoding, headers, mapping, rows };
}

/**
 * The server's own ceiling on one request body, restated here so the browser
 * can refuse an oversized file before writing anything rather than let Next's
 * body parser answer a partway-through POST with a 413 the operator cannot
 * read — the defect the fix-round review named: at Next's 1 MB default, the
 * `rows` field this form posts as one JSON string silently capped the import
 * at roughly seven thousand rows with no message at all.
 *
 * MUST be kept equal, by hand, to next.config.mjs's
 * `experimental.serverActions.bodySizeLimit` ('8mb'). There is no way to share
 * one literal between the two files: next.config.mjs is loaded by plain
 * Node before webpack ever runs, so it cannot import a value out of this
 * `'use client'` module, and this module importing next.config.mjs would pull
 * Next's own config-loading machinery into the browser bundle to reach one
 * number. next.config.mjs's own comment states the other half of this pair
 * and how the value was sized.
 */
export const IMPORT_ROWS_BODY_LIMIT_BYTES = 8 * 1024 * 1024;

/**
 * Block 11b, D10. A ceiling on the FILE, not on the rows.
 *
 * This file never becomes a storage object -- it is parsed in the browser and
 * posted as rows -- so it has no MIME question at all. What it can do is kill
 * the tab: `arrayBuffer()` below pulls the whole thing into memory, and a
 * mis-selected multi-gigabyte file takes the dialog with it, with no message.
 *
 * Above IMPORT_ROWS_BODY_LIMIT_BYTES on purpose. That constant is what actually
 * caps an import, and it is measured against the SERIALISED rows; this one only
 * has to stop a read that would never have finished.
 */
const IMPORT_FILE_MAX_BYTES = 20 * 1024 * 1024;

/**
 * The exact byte count of what the hidden `rows` field below will send.
 *
 * `TextEncoder`, not the JSON string's own `.length` — a `.length` counts
 * UTF-16 code units, and an accented name (every "ã", "ç", "õ" this file's own
 * header aliases expect) is more BYTES on the wire than characters on screen.
 * Next's body size limit counts bytes (action-handler.js's `Buffer.byteLength`
 * on the raw stream), so a byte count is the only measurement that answers
 * the question this function exists to ask: will the server accept this.
 *
 * Exported so the cap can be tested directly against real rows rather than
 * through a render — see tests/unit/participation-import.test.ts.
 */
export function importRowsPayloadBytes(rows: ParsedRow[]): number {
  return new TextEncoder().encode(JSON.stringify(rows)).length;
}

/**
 * A file of entries, written in one call (design spec D6): it writes what it can
 * and reports what it skipped, by line number, with no preview-and-confirm
 * stage.
 *
 * What IS shown before the write is how the header mapped, which §6 asks for and
 * which is not the same thing: it costs no round trip, writes nothing, and is
 * the operator's only chance to notice that a month-first file was read
 * day-first before six hundred rows land on the wrong dates.
 */
export function ImportParticipationsForm({
  promotionId,
  timeZone,
  requireCorrectAnswer,
  hasQuestions,
  canRegisterListeners,
  onCancel,
  onImported,
}: {
  promotionId: string;
  timeZone: string;
  /** Drives the warning design spec D7 asks for: an imported row carries no answers. */
  requireCorrectAnswer: boolean;
  hasQuestions: boolean;
  /** members.create — D10, and the RPC refuses the file before its first line without it. */
  canRegisterListeners: boolean;
  onCancel: () => void;
  /** Called once a file has been written, so the tab re-reads its counts. */
  onImported: () => void;
}) {
  const t = useTranslations('participations');
  const [state, action, pending] = useActionState(importParticipationsAction, INITIAL);
  const [file, setFile] = useState<ParsedFile | null>(null);
  const [readFailure, setReadFailure] = useState<string | null>(null);

  useEffect(() => {
    if (state.status === 'done') onImported();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  // The name and the timestamp are each required of every row by importRowSchema,
  // so a file without those columns cannot produce one usable line.
  const missing = file
    ? (['fullName', 'participatedAt'] as ColumnKey[]).filter(
        (key) => file.mapping[key] === undefined,
      )
    : [];
  // Either identifier will do, and a row carrying neither is skipped per line by
  // import_participations with the reason — a better report than refusing the
  // file. Neither COLUMN, though, means not one row in it could ever be matched.
  const noIdentifierColumn =
    file !== null && file.mapping.phone === undefined && file.mapping.cpf === undefined;
  // Fix-round finding #1: above this, Next's own body size limit would have
  // silently capped the import with no message at all. The refusal happens
  // HERE, before anything is posted — never as a truncation and never as a
  // 413 the operator has no way to read.
  //
  // Memoized on `file` (fix-round finding, minor): importRowsPayloadBytes does
  // a full JSON.stringify + TextEncoder.encode over every row, and without
  // this it re-ran on every render of this component — including the ones
  // `pending` triggers while the file itself has not changed at all.
  const rowsPayloadBytes = useMemo(
    () => (file ? importRowsPayloadBytes(file.rows) : 0),
    [file],
  );
  const oversized = file !== null && rowsPayloadBytes > IMPORT_ROWS_BODY_LIMIT_BYTES;
  const ready =
    file !== null && missing.length === 0 && !noIdentifierColumn && !oversized && file.rows.length > 0;

  async function onFileChosen(chosen: File | undefined) {
    setReadFailure(null);
    if (!chosen) {
      setFile(null);
      return;
    }
    // Block 11b, D10. Refused BEFORE the read, because the read is the damage.
    if (chosen.size > IMPORT_FILE_MAX_BYTES) {
      setFile(null);
      setReadFailure(
        `That file is ${Math.round(chosen.size / (1024 * 1024))} MB. An import file may be at most 20 MB — split it and import the parts.`,
      );
      return;
    }
    try {
      // arrayBuffer(), not text(): File.text() is a NON-FATAL UTF-8 decode, so
      // it never throws and the refusal below could never fire for the case it
      // names. See decodeImportFile.
      const { text, encoding } = decodeImportFile(await chosen.arrayBuffer());
      setFile(parseFile(chosen.name, text, timeZone, encoding));
    } catch {
      setFile(null);
      setReadFailure(
        'That file could not be read as text. It is neither UTF-8 nor Windows-1252 — re-save it from your spreadsheet as CSV UTF-8 and choose it again.',
      );
    }
  }

  return (
    <form
      action={action}
      className="flex flex-col gap-4 rounded-md border p-4"
      data-testid="participation-import-form"
    >
      <input type="hidden" name="promotionId" value={promotionId} />
      {file && <input type="hidden" name="rows" value={JSON.stringify(file.rows)} />}

      <label className="flex flex-col gap-1 text-sm">
        <span className="text-muted-foreground">{t('theFile')}</span>
        <input
          type="file"
          accept=".csv,text/csv,text/plain"
          onChange={(e) => void onFileChosen(e.target.files?.[0])}
          className="text-sm file:mr-3 file:rounded-md file:border file:border-input file:bg-background file:px-3 file:py-1.5 file:text-sm"
          data-testid="participation-import-file"
        />
        <span className="text-xs text-muted-foreground">
          {t('aCsvWithOneHeaderRow')}</span>
      </label>

      {readFailure && <p className="text-sm text-destructive">{readFailure}</p>}

      {file && (
        <div
          className="flex flex-col gap-2 rounded-md border p-3"
          data-testid="participation-import-mapping"
        >
          <p className="text-sm font-medium">{file.name}</p>
          <ul className="flex flex-col gap-0.5 text-xs text-muted-foreground">
            {(Object.keys(COLUMN_ALIASES) as ColumnKey[]).map((key) => (
              <li key={key}>
                {t(COLUMN_LABEL_KEYS[key])}:{' '}
                {file.mapping[key] ? (
                  <span className="text-foreground">{file.mapping[key]}</span>
                ) : (
                  <span>{t('notFoundInThisFile')}</span>
                )}
              </li>
            ))}
          </ul>
          {/* The encoding is named for the same reason the separator beside it
              is: a guess this screen made about the operator's file has to be
              visible, or a wrong one looks exactly like a right one. Only the
              non-obvious case is called out — every file that decodes as UTF-8
              decodes as itself, and a line saying so on every import would be
              noise the eye stops reading. */}
          {file.encoding === 'windows-1252' && (
            <p className="text-xs text-muted-foreground" data-testid="participation-import-encoding">
              {t('thisFileIsNotUtf8')}</p>
          )}
          <p className="text-xs text-muted-foreground">
            {file.rows.length} {t('linesLabel', { count: file.rows.length })} {t('underTheHeaderSeparatedBy')}{file.delimiter}”.
            {file.rows[0] && (
              <>
                {' '}
                {t('theFirstReadsAs')}{' '}
                <span className="text-foreground">{file.rows[0].fullName || '(no name)'}</span>,
                entering{' '}
                <span className="text-foreground">
                  {file.rows[0].participatedAt
                    ? formatInstant(file.rows[0].participatedAt, timeZone)
                    : t('atATimeSpelledInA')}
                </span>
                . Times are read as this Station&apos;s local time, and a date with no time of day
                is read as midnight.
              </>
            )}
          </p>

          {missing.length > 0 && (
            <p className="text-sm text-destructive" data-testid="participation-import-missing">
              {t('thisFileHasNoColumnForFull', {
                columns: missing.map((key) => t(COLUMN_LABEL_KEYS[key])).join(t('orSeparator')),
                headers: file.headers.join(', ') || t('emptyHeaderRow'),
              })}
            </p>
          )}
          {noIdentifierColumn && (
            <p className="text-sm text-destructive">
              {t('thisFileHasNeitherAPhone')}{' '}{file.headers.join(', ') || '(empty)'}.
            </p>
          )}
          {file.rows.length === 0 && missing.length === 0 && (
            <p className="text-sm text-destructive">
              {t('thatFileHasAHeaderRow')}</p>
          )}
          {/* Fix-round finding #1: a stated refusal, naming the cap, in place
              of the silent one Next's default would have given this form —
              see IMPORT_ROWS_BODY_LIMIT_BYTES's own comment. */}
          {oversized && (
            <p className="text-sm text-destructive" data-testid="participation-import-oversize">
              {t('thisFileIsTooLargeTo')}{' '}{file.rows.length}{' '}
              {t('linesSend', { count: file.rows.length })} {t('about')}{' '}
              {(rowsPayloadBytes / (1024 * 1024)).toFixed(1)} {t('mbToTheServerAndOne')}{' '}{(IMPORT_ROWS_BODY_LIMIT_BYTES / (1024 * 1024)).toFixed(0)} {t('mbSplitItIntoAtLeast')}{' '}{Math.ceil(rowsPayloadBytes / IMPORT_ROWS_BODY_LIMIT_BYTES)} {t('smallerFilesAndImportEachOne')}</p>
          )}
        </div>
      )}

      {/*
        Design spec D7, said before anything is written rather than discovered in
        the result. An imported line carries no answer — the file has four
        columns and none of them is one — so on a promotion that draws only among
        correct answers, everything imported is recorded, counted, and then
        excluded from the draw. That is not a defect for the import to fix; it is
        a fact about the promotion, and the operator is the only one who can
        decide what to do about it.
      */}
      {requireCorrectAnswer && (
        <p
          className="rounded-md bg-amber-100 p-3 text-sm text-amber-900"
          data-testid="participation-import-answer-warning"
        >
          {/* One whole sentence per branch. The half that used to live here as
              JSX text -- ". Every entry from this file…" -- could not survive
              translation glued onto a key, because no other language puts that
              clause where English does. */}
          {hasQuestions ? t('importAnswerWarning') : t('importAnswerWarningNoQuiz')}
        </p>
      )}

      {!canRegisterListeners && (
        <p className="text-sm text-muted-foreground" data-testid="participation-import-members-note">
          {t('importingRegistersTheListenersItDoes')}</p>
      )}

      {state.status === 'error' && (
        <p className="text-sm text-destructive" data-testid="participation-import-error">
          {state.message}
        </p>
      )}

      {state.status === 'done' && <ImportReport state={state} />}

      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={onCancel}>
          {t('close')}</Button>
        <Button type="submit" disabled={pending || !ready} data-testid="participation-import-submit">
          {pending ? t('importing') : t('importAction')}
        </Button>
      </div>
    </form>
  );
}

/**
 * What the file did, line by line.
 *
 * The headline figure is deliberately NOT `recorded`. import_participations
 * increments that for every row it writes, refusals included, and then counts
 * the refusals again in three fields of its own — so "342 entered" over a file
 * of repeats would be a number nobody could reconcile with the promotion's own
 * tab. The entries that will be in the draw are `recorded` minus those three,
 * and that is the figure shown first.
 *
 * The lines that counted sit behind a disclosure and everything else is in the
 * open. That is a judgement about attention and not a cap: six hundred lines
 * reading "counted" bury the four that need somebody to act. The disclosure says
 * how many it holds and opening it costs nothing — no row is dropped and none is
 * unreachable.
 */
function ImportReport({ state }: { state: Extract<ImportParticipationsState, { status: 'done' }> }) {
  const t = useTranslations('participations');
  // The shared enum vocabulary, which several screens render.
  const tv = useTranslations('vocab');
  const { result, unreadable } = state;
  const entered = result.recorded - result.duplicate - result.tooSoon - result.overLimit;
  const total = result.recorded + result.skipped + unreadable.length;
  const counted = result.rows.filter((row) => row.outcome === 'recorded' && row.status === 'VALID');
  const attention = result.rows.filter((row) => row.outcome === 'skipped' || row.status !== 'VALID');

  return (
    <div
      className="flex flex-col gap-3 rounded-md border p-3"
      data-testid="participation-import-report"
    >
      <p className="text-sm">
        <span data-testid="participation-import-entered">{entered}</span> {t('of')}{' '}{total}{' '}
        {t('linesLabel', { count: total })} {t('enteredTheDraw')}</p>

      <ul className="flex flex-col gap-0.5 text-xs text-muted-foreground">
        <li>{t('recordedAsAlreadyEntered')}{' '}{result.duplicate}</li>
        <li>{t('recordedAsCameBackTooSoon')}{' '}{result.tooSoon}</li>
        <li>{t('recordedAsPastTheirLimit')}{' '}{result.overLimit}</li>
        <li data-testid="participation-import-skipped">{t('skippedByTheImport')}{' '}{result.skipped}</li>
        <li data-testid="participation-import-unreadable">
          {t('linesThatCouldNotBeRead')}{' '}{unreadable.length}
        </li>
        <li data-testid="participation-import-created">
          {t('listenersRegistered')}{' '}{result.membersCreated}
        </li>
      </ul>

      {(attention.length > 0 || unreadable.length > 0) && (
        <ul className="flex flex-col gap-1 text-xs" data-testid="participation-import-problems">
          {unreadable.map((row) => (
            <li key={`unreadable-${row.line}`} className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{t('line')}{' '}{row.line}</span>
              <span className="rounded-full bg-destructive/10 px-2 py-0.5 text-destructive">
                {t('notRead')}</span>
              <span className="text-muted-foreground">{row.reason}</span>
            </li>
          ))}
          {attention.map((row) => (
            <li key={`row-${row.line}`} className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{t('line')}{' '}{row.line}</span>
              {row.outcome === 'skipped' ? (
                <>
                  <span className="rounded-full bg-muted px-2 py-0.5 text-muted-foreground">
                    {t('skipped')}</span>
                  {/* An unrecognised reason renders itself rather than being
                      dressed as one of the three. The database's own word is a
                      worse sentence than a written one and a far better one than
                      the wrong sentence — see SKIP_REASON_KEYS. */}
                  <span className="text-muted-foreground">
                    {describeSkipReason(row.reason, t)}
                  </span>
                </>
              ) : (
                <span
                  className={`rounded-full px-2 py-0.5 ${row.status ? STATUS_CLASSES[row.status] : ''}`}
                >
                  {row.status ? tv(STATUS_LABEL_KEYS[row.status]) : ''}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}

      {counted.length > 0 && (
        <details className="text-xs">
          <summary className="cursor-pointer text-muted-foreground">
            {counted.length} {t('linesLabel', { count: counted.length })} {t('counted')}</summary>
          <ul className="mt-1 flex flex-col gap-0.5">
            {counted.map((row) => (
              <li key={`counted-${row.line}`}>{t('line')}{' '}{row.line} — counted</li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
