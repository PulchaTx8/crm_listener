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
 * Block 12a ships the machinery and the English catalogue, so this holds one
 * entry and the selector renders nothing. Block 12b writes the other two
 * catalogues and opens it. That is what keeps anybody from choosing "Português"
 * and being handed English (D4).
 */
export const AVAILABLE_LOCALES = ['en'] as const satisfies readonly Locale[];

export const DEFAULT_LOCALE: Locale = 'en';

export function isLocale(value: string | undefined | null): value is Locale {
  return typeof value === 'string' && (SUPPORTED_LOCALES as readonly string[]).includes(value);
}

/**
 * Profile, then cookie, then the browser, then English.
 *
 * Every input is untrusted -- the cookie is client-writable and the header is
 * whatever was sent -- so anything that is not one of the three is discarded
 * rather than passed along. A locale reaches a filename downstream
 * (src/i18n/request.ts), and that is reason enough.
 */
export function resolveLocale(input: {
  profile?: string | null;
  cookie?: string | null;
  acceptLanguage?: string | null;
}): Locale {
  if (isLocale(input.profile)) return input.profile;
  if (isLocale(input.cookie)) return input.cookie;

  const fromBrowser = preferredFromHeader(input.acceptLanguage);
  if (fromBrowser) return fromBrowser;

  return DEFAULT_LOCALE;
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
 */
function preferredFromHeader(header: string | null | undefined): Locale | null {
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
    if (isLocale(entry.base)) return entry.base;
  }
  return null;
}
