import type { Database } from '@/lib/supabase/database.types';

export type BroadcastBand = Database['public']['Enums']['broadcast_band'];

/**
 * The one place a stored frequency becomes something a person reads, and back.
 *
 * THE COLUMN IS ALWAYS kHz (0153, design D11). FM 98.5 MHz is stored as 98500;
 * AM 1200 kHz is stored as 1200. One unit and an integer, so nothing rounds and
 * everything sorts -- but nobody says "ninety-eight thousand five hundred
 * kilohertz" about a radio station, so the two directions live here rather than
 * being re-derived beside each screen that needs one.
 *
 * Pure and free of `server-only`, deliberately: the card renders on the server
 * and the console's form runs in the browser, and a second copy of this
 * arithmetic is how the two would come to disagree.
 */

/** What a Station's dial position reads as, or null when there is nothing to read. */
export function formatFrequency(
  band: BroadcastBand | null,
  khz: number | null,
  locale: string,
): string | null {
  if (!band || khz === null) return null;
  // WEB is a real band with no dial position. A null here is the truth rather
  // than a gap to fill.
  if (band === 'WEB') return null;

  if (band === 'AM') {
    // Whole kilohertz, and NO thousands separator: an AM dial reads 1200, not
    // "1.200". Localising this number would be correct arithmetic and the wrong
    // typography — which is why the locale below applies to the decimal
    // separator on FM and to nothing here.
    return `${khz} AM`;
  }

  // FM in MHz with one decimal — "98,5 FM" in Portuguese, "98.5 FM" in English.
  // The separator is the locale's, which is the whole reason this takes one.
  const mhz = khz / 1000;
  return `${mhz.toLocaleString(locale, {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  })} FM`;
}

/**
 * What the operator typed, as the column stores it.
 *
 * A BLANK IS null, NEVER 0. companies_frequency_positive (0153) refuses a zero,
 * so a form that sent one would report a constraint violation where the person
 * meant "I do not know" — and the message would name a constraint rather than a
 * field.
 *
 * Both separators are accepted: somebody on a Brazilian keyboard types 98,5.
 */
export function khzFromInput(band: BroadcastBand | null, typed: string): number | null {
  if (!band || band === 'WEB') return null;

  const cleaned = typed.trim().replace(',', '.');
  if (!cleaned) return null;

  const value = Number(cleaned);
  // NaN and Infinity both mean "that is not a frequency". Answering null rather
  // than passing either on keeps the refusal in the form, where the field is.
  if (!Number.isFinite(value) || value <= 0) return null;

  return band === 'AM' ? Math.round(value) : Math.round(value * 1000);
}

/** The inverse, for filling the form from what is stored. */
export function inputFromKhz(band: BroadcastBand | null, khz: number | null): string {
  if (!band || band === 'WEB' || khz === null) return '';
  // Plain digits and a dot, never localised: this fills an <input type="number">,
  // which parses neither a comma nor a thousands separator.
  return band === 'AM' ? String(khz) : String(khz / 1000);
}
