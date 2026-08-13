import { getLocale, getTranslations } from 'next-intl/server';
import { DEFAULT_LOCALE, isLocale } from '@/i18n/locales';
import { legalDocument, LegalArticle } from '@/content/legal';

/**
 * Reachable with no session at all (src/middleware.ts's PUBLIC_PATHS) --
 * the listener who opens this comes from a link inside WhatsApp and has no
 * account.
 *
 * `<main>` holds the article AND a placeholder heading for the request form
 * -- Task 5's job, not this one's. NO STUBBED FORM: an input that does
 * nothing, on a page about a legal right, would be worse than no input at
 * all. The source's own final section ("Formulário de solicitação") is not
 * transcribed as prose in delete-data.*.ts for the same reason -- see that
 * file's header comment.
 */
export default async function DeleteDataPage() {
  const [raw, t] = await Promise.all([getLocale(), getTranslations('public')]);
  const locale = isLocale(raw) ? raw : DEFAULT_LOCALE;
  const document = legalDocument('delete-data', locale);

  return (
    <main className="flex flex-col gap-10">
      <LegalArticle document={document} locale={locale} />
      <section className="flex flex-col gap-3 border-t pt-6">
        <h2 className="text-lg font-semibold">{t('requestForm')}</h2>
      </section>
    </main>
  );
}
