/**
 * Block 12a, D2. Which language a person reads, and how that is decided.
 *
 * Deliberately free of Next imports. This is the one piece of the resolution
 * that can be asserted directly, and everything above it -- the request config,
 * the middleware, the Server Action -- is plumbing around these functions.
 */
export type Locale = 'en' | 'pt' | 'es';

/** Every locale the product will ever offer. Matches the check constraint in 0135. */
export const SUPPORTED_LOCALES = ['en', 'pt', 'es'] as const satisfies readonly Locale[];

/**
 * The ones a person may choose TODAY.
 *
 * Block 12b writes `pt.json` and `es.json` and opens this to all three, which
 * is the only change the gear beside the member's name needed to appear.
 *
 * NOTHING GOES IN HERE WITHOUT ITS CATALOGUE. resolveLocale filters on this
 * constant and the answer becomes a filename, so a language named here with no
 * `messages/<it>.json` beside it is a crashed render on every route, public
 * ones included. `catalogue.test.ts` pins a file on disk for each entry, and it
 * is the guard, not a formality.
 */
export const AVAILABLE_LOCALES = ['en', 'pt', 'es'] as const satisfies readonly Locale[];

export const DEFAULT_LOCALE: Locale = 'en';

export function isLocale(value: string | undefined | null): value is Locale {
  return typeof value === 'string' && (SUPPORTED_LOCALES as readonly string[]).includes(value);
}

/**
 * Whether this value names a catalogue that EXISTS TODAY.
 *
 * The distance between this and isLocale is the whole point. `pt` is a locale
 * the product will offer; it is not a locale the product can render until
 * Block 12b writes `messages/pt.json`. Resolution must answer the second
 * question, because what it returns becomes a filename in src/i18n/request.ts
 * and a missing file there is a crashed render, not a fallback.
 */
export function isAvailable(
  value: string | undefined | null,
  available: readonly Locale[] = AVAILABLE_LOCALES,
): value is Locale {
  return isLocale(value) && available.includes(value);
}

/**
 * Profile, then cookie, then the browser, then English.
 *
 * Every input is untrusted -- the cookie is client-writable and the header is
 * whatever was sent -- so anything that is not one of the three is discarded
 * rather than passed along. A locale reaches a filename downstream
 * (src/i18n/request.ts), and that is reason enough.
 *
 * IT NEVER RETURNS A LANGUAGE WITHOUT A CATALOGUE. Each step is filtered by
 * AVAILABLE_LOCALES rather than SUPPORTED_LOCALES, so a Brazilian browser
 * sending `Accept-Language: pt-BR` is answered with English while `pt` is
 * unwritten, instead of naming a file that is not there. Block 12b changes that
 * answer by adding the catalogue and the constant, and nothing here.
 */
export function resolveLocale(input: {
  profile?: string | null;
  cookie?: string | null;
  acceptLanguage?: string | null;
  /**
   * Defaults to AVAILABLE_LOCALES. Present so the ORDER can be asserted while
   * only one catalogue exists -- with a single available language every branch
   * below returns the same answer and the order is untestable.
   */
  available?: readonly Locale[];
}): Locale {
  const available = input.available ?? AVAILABLE_LOCALES;

  if (isAvailable(input.profile, available)) return input.profile;
  if (isAvailable(input.cookie, available)) return input.cookie;

  const fromBrowser = preferredFromHeader(input.acceptLanguage, available);
  if (fromBrowser) return fromBrowser;

  return isAvailable(DEFAULT_LOCALE, available) ? DEFAULT_LOCALE : (available[0] ?? DEFAULT_LOCALE);
}

/**
 * What the browser's cookie should become, or null to leave it alone.
 *
 * The profile is the choice that travels with the person; the cookie is one
 * browser's memory of it. When they disagree the profile wins -- but somebody
 * who never chose has no opinion to impose, and their cookie may well hold a
 * choice they made before signing in.
 *
 * Returning null when they already agree is not an optimisation: without it
 * every response in the product carries a Set-Cookie that changes nothing.
 */
export function localeCookieUpdate(input: {
  profile?: string | null;
  cookie?: string | null;
}): Locale | null {
  if (!isLocale(input.profile)) return null;
  if (input.cookie === input.profile) return null;
  return input.profile;
}

/**
 * Reads Accept-Language by QUALITY, not by position.
 * "fr-FR,fr;q=0.9,es;q=0.7" means "French, or Spanish if you must" -- answering
 * English there ignores a preference the browser stated plainly.
 *
 * Filtered by what is available, not by what is supported: this is the one
 * input nobody in the product had to opt into, so it is the one that would
 * reach every visitor at once.
 */
function preferredFromHeader(
  header: string | null | undefined,
  available: readonly Locale[],
): Locale | null {
  if (!header) return null;

  const ranked = header
    .split(',')
    .map((part) => {
      const [tag, ...params] = part.trim().split(';');
      const quality = params.find((p) => p.trim().startsWith('q='));
      return {
        // pt-BR and pt read the same catalogue; the region does not choose one.
        base: (tag ?? '').trim().toLowerCase().split('-')[0] ?? '',
        quality: quality ? Number.parseFloat(quality.split('=')[1] ?? '0') : 1,
      };
    })
    .filter((entry) => entry.base.length > 0 && Number.isFinite(entry.quality))
    .sort((a, b) => b.quality - a.quality);

  for (const entry of ranked) {
    if (isAvailable(entry.base, available)) return entry.base;
  }
  return null;
}
