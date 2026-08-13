import Link from 'next/link';
import type { Route } from 'next';
import { getLocale, getTranslations } from 'next-intl/server';
import { AVAILABLE_LOCALES, DEFAULT_LOCALE, isLocale, type Locale } from '@/i18n/locales';
import { setLocaleAction } from '@/app/(app)/locale-actions';

/**
 * Each language named in itself, the same choice
 * src/components/layout/locale-selector.tsx makes and for the same reason:
 * somebody who reads only Spanish should not have to recognise the word
 * "Spanish".
 */
const LOCALE_NAMES: Record<Locale, string> = {
  en: 'English',
  pt: 'Português',
  es: 'Español',
};

/**
 * The header every page in the (public) route group renders: the wordmark,
 * links to the three legal documents, and a language switch.
 *
 * NO LINK INTO THE SIGNED-IN PRODUCT, including the wordmark itself. The
 * reader has no account -- `/` redirects a session-less visitor straight to
 * /login (see src/middleware.ts), so a wordmark that pointed there would be a
 * dead end dressed up as a way home. src/components/auth/brand-mark.tsx made
 * the identical call, for the identical reason.
 *
 * setLocaleAction IS REUSED RATHER THAN DUPLICATED (task brief). Its own
 * comment (src/app/(app)/locale-actions.ts) records that the cookie is
 * written FIRST and that the profile write is skipped -- not thrown -- for
 * somebody with no session, which is exactly this reader.
 */
export async function PublicHeader() {
  const [raw, t] = await Promise.all([getLocale(), getTranslations('public')]);
  const current: Locale = isLocale(raw) ? raw : DEFAULT_LOCALE;

  return (
    <header className="mb-10 flex flex-col gap-4 border-b pb-6 sm:flex-row sm:items-center sm:justify-between">
      <span className="text-base font-semibold">{t('pulchatx')}</span>

      <nav
        aria-label={t('legalDocuments')}
        className="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm"
      >
        {/* `as Route`: these three pages are brand new in this same change,
            and typedRoutes cannot see a route's static literal until Next
            regenerates its route types (`next dev`/`next build`) -- the same
            cast the rest of this codebase uses when a route is simply too
            new (e.g. src/app/(app)/catalog/genres/page.tsx). */}
        <Link
          href={'/privacy' as Route}
          className="text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
        >
          {t('privacyPolicy')}
        </Link>
        <Link
          href={'/terms' as Route}
          className="text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
        >
          {t('termsOfService')}
        </Link>
        <Link
          href={'/delete-data' as Route}
          className="text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
        >
          {t('dataDeletionRequest')}
        </Link>
      </nav>

      <div role="group" aria-label={t('language')} className="flex items-center gap-1 text-sm">
        {AVAILABLE_LOCALES.map((locale) => (
          <form action={setLocaleAction} key={locale}>
            <input type="hidden" name="locale" value={locale} />
            <button
              type="submit"
              aria-current={locale === current ? 'true' : undefined}
              className={`rounded px-2 py-1 transition-colors hover:bg-muted ${
                locale === current ? 'font-semibold text-foreground' : 'text-muted-foreground'
              }`}
            >
              {LOCALE_NAMES[locale]}
            </button>
          </form>
        ))}
      </div>
    </header>
  );
}
