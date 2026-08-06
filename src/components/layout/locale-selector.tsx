import { getLocale, getTranslations } from 'next-intl/server';
import { AVAILABLE_LOCALES, isLocale, DEFAULT_LOCALE, type Locale } from '@/i18n/locales';
import { setLocaleAction } from '@/app/(app)/locale-actions';

/**
 * Each language named in itself, which is how a person finds theirs in a list —
 * somebody who reads only Spanish should not have to recognise the word
 * "Spanish". These three words are the one place in the product that is
 * deliberately never translated.
 */
const LOCALE_NAMES: Record<Locale, string> = {
  en: 'English',
  pt: 'Português',
  es: 'Español',
};

/**
 * Block 12b. The gear beside the signed-in member's name: click it, pick a
 * language, and the whole interface is in that language from the next paint.
 *
 * A SERVER COMPONENT WITH NO CLIENT JAVASCRIPT AT ALL, and that is the reason
 * for `<details>`. The menu opens because the browser opens it, and each
 * language is a one-field form posting to the Server Action — so this works
 * before hydration, works with JavaScript off, and adds nothing to the bundle
 * of a shell that every single screen renders. It also stays clear of the CSP:
 * there is no inline handler for a nonce to have to bless.
 *
 * Still gated by AVAILABLE_LOCALES. A control offering a language whose
 * catalogue nobody wrote would hand somebody English and call it their choice —
 * and, since the resolution refuses a language it cannot render, that choice
 * would silently do nothing at all.
 */
export async function LocaleSelector() {
  if (AVAILABLE_LOCALES.length < 2) return null;

  const [raw, t] = await Promise.all([getLocale(), getTranslations('shell')]);
  const current: Locale = isLocale(raw) ? raw : DEFAULT_LOCALE;

  return (
    <details className="relative" data-testid="locale-menu">
      <summary
        aria-label={t('language')}
        title={t('language')}
        data-testid="locale-gear"
        // `list-none` plus the WebKit pseudo-element: without both, the browser
        // draws its own disclosure triangle beside the gear.
        className="flex cursor-pointer list-none items-center rounded-md p-2 text-sidebar-muted transition-colors hover:bg-sidebar-accent hover:text-white [&::-webkit-details-marker]:hidden"
      >
        <svg
          aria-hidden="true"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.75"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="h-4 w-4"
        >
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
      </summary>

      {/* Upwards: this lives in the sidebar's bottom row, and a menu opening
          downwards would fall off the viewport. */}
      <div
        role="menu"
        className="absolute bottom-full left-0 z-20 mb-1 min-w-36 rounded-md border border-sidebar-border bg-sidebar-accent py-1 shadow-lg"
      >
        {AVAILABLE_LOCALES.map((locale) => (
          <form action={setLocaleAction} key={locale}>
            <input type="hidden" name="locale" value={locale} />
            <button
              type="submit"
              role="menuitem"
              aria-current={locale === current ? 'true' : undefined}
              data-testid={`locale-option-${locale}`}
              className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors hover:bg-sidebar-border ${
                locale === current ? 'font-semibold text-white' : 'text-sidebar-muted'
              }`}
            >
              <span aria-hidden="true" className="w-3">
                {locale === current ? '✓' : ''}
              </span>
              {LOCALE_NAMES[locale]}
            </button>
          </form>
        ))}
      </div>
    </details>
  );
}
