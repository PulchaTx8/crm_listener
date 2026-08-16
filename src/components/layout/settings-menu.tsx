import { getLocale, getTranslations } from 'next-intl/server';
import { headers } from 'next/headers';
import { AVAILABLE_LOCALES, isLocale, DEFAULT_LOCALE, type Locale } from '@/i18n/locales';
import { isTheme, THEME_CHOICES, THEME_HEADER, type ThemeChoice } from '@/lib/theme/theme';
import { setLocaleAction } from '@/app/(app)/locale-actions';
import { setThemeAction } from '@/app/(app)/theme-actions';

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

/** The theme names ARE translated, unlike the languages: they are ordinary words about the product. */
const THEME_LABEL_KEYS: Record<ThemeChoice, string> = {
  system: 'themeSystem',
  light: 'themeLight',
  dark: 'themeDark',
};

/**
 * Block 12b, and Block 25. The gear beside the signed-in member's name: click
 * it, pick a language or a theme, and the whole interface follows from the next
 * paint.
 *
 * IT WAS `locale-selector.tsx` UNTIL BLOCK 25, and the rename is deliberate
 * rather than churn: a file called "locale" that also owns the theme is a name
 * that has stopped being true, and this codebase renames those — the Inventory
 * nav item became Stock on exactly that rule. The test ids keep their `locale-`
 * prefix where they name locale things, so `language.spec.ts` moves by its
 * import alone.
 *
 * A SERVER COMPONENT WITH NO CLIENT JAVASCRIPT AT ALL, and that is the reason
 * for `<details>`. The menu opens because the browser opens it, and each option
 * is a one-field form posting to a Server Action — so this works before
 * hydration, works with JavaScript off, and adds nothing to the bundle of a
 * shell that every single screen renders. It also stays clear of the CSP: there
 * is no inline handler for a nonce to have to bless.
 *
 * That last point is not incidental to the theme. It is precisely why
 * `next-themes` was rejected (design D2): its flash-prevention is an inline
 * script, and this product's CSP would have to be widened to admit one.
 */
export async function SettingsMenu() {
  const [raw, t] = await Promise.all([getLocale(), getTranslations('shell')]);
  const current: Locale = isLocale(raw) ? raw : DEFAULT_LOCALE;

  // The same header the root layout stamps the class from, read again rather
  // than passed down: this component is rendered by the shell, which does not
  // know it, and a prop threaded through two layers to say what one header
  // already says is a second copy of the same fact.
  //
  // Absent is System — the state a person who has never opened this menu is
  // already in, which is why it is the first row rather than the last.
  const themeHeader = (await headers()).get(THEME_HEADER);
  const currentTheme: ThemeChoice = isTheme(themeHeader) ? themeHeader : 'system';

  return (
    <details className="relative" data-testid="locale-menu">
      <summary
        aria-label={t('settings')}
        title={t('settings')}
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
        className="absolute bottom-full left-0 z-20 mb-1 min-w-40 rounded-md border border-sidebar-border bg-sidebar-accent py-1 shadow-lg"
      >
        {/* A language menu with one language is a control that cannot do
            anything. The whole section goes rather than rendering a list of one
            — and the divider below goes with it, or the menu would open on a
            rule with nothing above it. */}
        {AVAILABLE_LOCALES.length > 1 && (
          <>
            {AVAILABLE_LOCALES.map((locale) => (
              <form action={setLocaleAction} key={locale}>
                <input type="hidden" name="locale" value={locale} />
                <Row
                  testId={`locale-option-${locale}`}
                  chosen={locale === current}
                  label={LOCALE_NAMES[locale]}
                />
              </form>
            ))}

            {/* The owner's own instruction: a division between the languages and
                the themes. `<hr>` rather than a bordered wrapper, because it is
                a separator and assistive technology should be told so. */}
            <hr className="my-1 border-sidebar-border" data-testid="settings-divider" />
          </>
        )}

        {THEME_CHOICES.map((choice) => (
          <form action={setThemeAction} key={choice}>
            <input type="hidden" name="theme" value={choice} />
            <Row
              testId={`theme-option-${choice}`}
              chosen={choice === currentTheme}
              label={t(THEME_LABEL_KEYS[choice])}
            />
          </form>
        ))}
      </div>
    </details>
  );
}

/**
 * One row of the menu, and the tick that says which one is on.
 *
 * Its own component because the two sections would otherwise carry two copies of
 * the same nine lines — and the tick's fixed-width spacer is the kind of detail
 * that gets corrected in one copy and not the other, leaving one list's labels
 * indented differently from the other's.
 */
function Row({ testId, chosen, label }: { testId: string; chosen: boolean; label: string }) {
  return (
    <button
      type="submit"
      role="menuitem"
      aria-current={chosen ? 'true' : undefined}
      data-testid={testId}
      className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors hover:bg-sidebar-border ${
        chosen ? 'font-semibold text-white' : 'text-sidebar-muted'
      }`}
    >
      <span aria-hidden="true" className="w-3">
        {chosen ? '✓' : ''}
      </span>
      {label}
    </button>
  );
}
