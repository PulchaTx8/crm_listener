import { songIntegrationSchema } from '@/schemas/music';
import type { SongIntegrationInput } from '@/schemas/music';

/**
 * Block 27. One card, from a file the operator's own software wrote.
 *
 * THIS IS NOT A SECURITY BOUNDARY AND IS NOT WRITTEN AS ONE. It runs in the
 * browser, so a determined caller simply does not run it:
 * saveSongIntegrationAction parses `songIntegrationFormSchema` again on the
 * server, and `save_song_integration` (0207) re-checks the permission and every
 * length in its own body, as does `set_song_integration_code` (0208). The
 * boundary is in the database, the way it is everywhere else on this product.
 *
 * What this buys is that an honest mistake — the wrong file, an export carrying
 * thirty columns, a truncated download — becomes a sentence on the screen
 * instead of a round trip that fails with the database's own wording. And it
 * buys one thing more, which is why it strips rather than merely validates: the
 * card that leaves here is built key by key into a fresh object, so nothing the
 * file carried beyond the four fields has any path onward.
 *
 * Nothing here throws. Every unreadable shape is a `reason` the tab can phrase.
 */

/**
 * Checked against `File.size` BEFORE the file is read, so a two-gigabyte file
 * never becomes a string in memory. One card is a few hundred bytes; 64 KB is
 * room for an export with generous whitespace and nothing like room for a
 * catalogue.
 */
export const MAX_INTEGRATION_FILE_BYTES = 64 * 1024;

/**
 * The only keys taken off the file. Anything else is dropped rather than
 * refused — an operator's export carrying thirty columns should import the four
 * we asked for — and `companyId` in particular must never survive: the action
 * reads that from the form, and a file that could set it would be choosing a
 * Station.
 */
const ALLOWED_KEYS = ['code', 'title', 'artistName', 'categoryName'] as const;

export type IntegrationFileResult =
  | { ok: true; card: SongIntegrationInput }
  | { ok: false; reason: 'unreadable' | 'empty' | 'many' | 'invalid'; count?: number };

/**
 * Drops C0 and C1 control characters, which a pasted or badly-encoded export
 * carries and which none of these fields should ever hold: a newline inside a
 * code makes two codes that look identical on screen and are not.
 *
 * A loop over code points rather than a character-class regex, deliberately: a
 * class written with literal control characters is invisible in a diff and
 * unreadable in an editor, and one written with escapes is a line nobody can
 * safely edit by hand. This says what it means.
 */
function stripControlChars(value: string): string {
  let out = '';
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) continue;
    out += ch;
  }
  return out;
}

function clean(value: unknown): unknown {
  // Non-strings pass through untouched so the schema below can REFUSE them.
  // Coercing here would turn a number into a string and accept a file that
  // should have been rejected.
  if (typeof value !== 'string') return value;
  return stripControlChars(value).trim();
}

export function parseIntegrationFile(text: string): IntegrationFileResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'unreadable' };
  }

  if (Array.isArray(raw)) {
    if (raw.length === 0) return { ok: false, reason: 'empty' };
    // The owner chose one card per file (design D10). More than one is refused
    // rather than guessed at: taking the first would silently import the wrong
    // song, which is worse than asking for a different file. The count travels
    // so the message can say what was found.
    if (raw.length > 1) return { ok: false, reason: 'many', count: raw.length };
    raw = raw[0];
  }

  if (typeof raw !== 'object' || raw === null) return { ok: false, reason: 'invalid' };

  // Built key by key into a FRESH, null-prototype object rather than spread or
  // Object.assign'd: whatever arrived is never the thing that leaves, so
  // `__proto__`, `constructor` and anything else the file carried has no path
  // onward. (JSON.parse already makes `__proto__` an own property rather than a
  // prototype write, so this is defence in depth — written down because "the
  // parser happens to be safe" is not something to depend on silently.)
  //
  // hasOwnProperty called off Object.prototype rather than off `source`,
  // because `source` is exactly the object that might carry a `hasOwnProperty`
  // of its own.
  const source = raw as Record<string, unknown>;
  const candidate: Record<string, unknown> = Object.create(null);
  for (const key of ALLOWED_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(source, key)) continue;
    candidate[key] = clean(source[key]);
  }

  const parsed = songIntegrationSchema.safeParse(candidate);
  if (!parsed.success) return { ok: false, reason: 'invalid' };

  // Zod returns its own plain object, and `optionalText` turns a blank into
  // undefined — so the card carries only the keys that had a value, with an
  // ordinary prototype the caller can spread.
  return { ok: true, card: parsed.data };
}
