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
 * Block 12a, D4. RENDERS NOTHING while only one language exists.
 *
 * A control offering "Português" before the Portuguese catalogue is written
 * would hand somebody English and call it their choice. AVAILABLE_LOCALES opens
 * in Block 12b and this appears with it, with no other change required — which
 * is the whole reason the work was split in two.
 *
 * It reads its own locale rather than taking a prop, so mounting it costs the
 * shell one line and no plumbing.
 */
export async function LocaleSelector() {
  if (AVAILABLE_LOCALES.length < 2) return null;

  const [raw, t] = await Promise.all([getLocale(), getTranslations('shell')]);
  const current: Locale = isLocale(raw) ? raw : DEFAULT_LOCALE;

  return (
    <form action={setLocaleAction} className="flex items-center gap-2">
      <label className="sr-only" htmlFor="locale-selector">
        {t('language')}
      </label>
      <select
        id="locale-selector"
        name="locale"
        defaultValue={current}
        data-testid="locale-selector"
        className="rounded-md border border-sidebar-border bg-transparent px-2 py-1 text-xs text-white"
      >
        {AVAILABLE_LOCALES.map((locale) => (
          <option key={locale} value={locale} className="text-black">
            {LOCALE_NAMES[locale]}
          </option>
        ))}
      </select>
      <button
        type="submit"
        data-testid="locale-save"
        className="rounded-md p-1 text-xs text-sidebar-muted transition-colors hover:text-white"
      >
        {t('languageSave')}
      </button>
    </form>
  );
}
