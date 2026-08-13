import { getLocale } from 'next-intl/server';
import { DEFAULT_LOCALE, isLocale } from '@/i18n/locales';
import { legalDocument, LegalArticle } from '@/content/legal';

/**
 * Reachable with no session at all (src/middleware.ts's PUBLIC_PATHS) --
 * the listener who opens this comes from a link inside WhatsApp and has no
 * account.
 */
export default async function TermsPage() {
  const raw = await getLocale();
  const locale = isLocale(raw) ? raw : DEFAULT_LOCALE;
  const document = legalDocument('terms', locale);

  return (
    <main>
      <LegalArticle document={document} locale={locale} />
    </main>
  );
}
