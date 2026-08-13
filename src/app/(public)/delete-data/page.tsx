import { getLocale, getTranslations } from 'next-intl/server';
import type { Route } from 'next';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { DEFAULT_LOCALE, isLocale } from '@/i18n/locales';
import { legalDocument, LegalArticle } from '@/content/legal';
import { dataDeletionRequestSchema } from '@/schemas/data-deletion';
import { submitDataDeletionRequest } from '@/services/data-deletion';
import { logger } from '@/lib/logger';
import { Button } from '@/components/ui/button';
import { Input, Textarea } from '@/components/ui/input';

/**
 * Reachable with no session at all (src/middleware.ts's PUBLIC_PATHS) -- the
 * listener who opens this comes from a link inside WhatsApp and has no account.
 *
 * `<main>` holds the article and then the request form the article's own final
 * section promises. The form RECORDS; it erases nothing. A public form that
 * deleted on submission would let anybody erase anybody's record by typing
 * their telephone number, so identity is confirmed by a person afterwards, off
 * this path.
 */
export default async function DeleteDataPage({
  searchParams,
}: {
  searchParams: Promise<{ protocol?: string; error?: string }>;
}) {
  const [raw, t, params] = await Promise.all([getLocale(), getTranslations('public'), searchParams]);
  const locale = isLocale(raw) ? raw : DEFAULT_LOCALE;
  const document = legalDocument('delete-data', locale);

  async function submit(formData: FormData) {
    'use server';
    const parsed = dataDeletionRequestSchema.safeParse({
      name: formData.get('name'),
      phone: formData.get('phone'),
      email: formData.get('email'),
      station: formData.get('station') || undefined,
      notes: formData.get('notes') || undefined,
      // An unchecked box posts NOTHING, so this is `false` rather than absent
      // by the time the schema sees it -- and z.literal(true) refuses it. The
      // refusal lives in the schema and not in a `required` attribute on the
      // input, because markup validation is the browser's opinion and can be
      // turned off from the console in four keystrokes.
      confirmed: formData.get('confirmed') === 'on',
    });

    if (!parsed.success) redirect('/delete-data?error=invalid');

    const headerList = await headers();
    const ip = headerList.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';

    // redirect() signals by throwing, so it must sit outside the catch --
    // inside, a successful submission would be reported as a failure.
    let destination: Route = '/delete-data?error=failed';
    try {
      const protocol = await submitDataDeletionRequest(parsed.data, ip);
      // Cast because typedRoutes cannot see through a template literal. The
      // protocol is the database's, carried back in the query string so the
      // receipt survives the reload a redirect performs.
      destination = `/delete-data?protocol=${encodeURIComponent(protocol)}` as Route;
    } catch (cause) {
      // The requester gets a deliberately vague sentence; the operator needs
      // the real one, and this request has a statutory clock on it.
      logger.error({ err: cause }, 'data deletion request submission failed');
    }
    redirect(destination);
  }

  // The receipt replaces the form rather than sitting above it: a form still on
  // screen after a successful submission invites a second identical request,
  // and each one starts its own statutory clock.
  if (params.protocol) {
    return (
      <main className="flex flex-col gap-10">
        <LegalArticle document={document} locale={locale} />
        <section className="flex flex-col gap-3 border-t pt-6">
          <h2 className="text-lg font-semibold">{t('yourRequestWasRecorded')}</h2>
          <p className="text-sm text-muted-foreground">{t('yourProtocolNumber')}</p>
          <p
            data-testid="deletion-protocol"
            className="font-mono text-2xl font-semibold tracking-widest"
          >
            {params.protocol}
          </p>
          <p className="text-sm text-muted-foreground">{t('writeThisNumberDownAnd')}</p>
        </section>
      </main>
    );
  }

  return (
    <main className="flex flex-col gap-10">
      <LegalArticle document={document} locale={locale} />
      <section className="flex flex-col gap-3 border-t pt-6">
        <h2 className="text-lg font-semibold">{t('requestForm')}</h2>
        {params.error ? (
          <p className="text-sm text-destructive">
            {params.error === 'invalid'
              ? t('pleaseCheckTheFieldsAndTry')
              : t('somethingWentWrongPleaseTry')}
          </p>
        ) : null}
        <form action={submit} className="flex flex-col gap-4">
          <Input data-testid="deletion-name" name="name" placeholder={t('yourName')} required />
          <Input
            data-testid="deletion-phone"
            name="phone"
            placeholder={t('telephoneWithCountryCode')}
            required
          />
          <Input
            data-testid="deletion-email"
            name="email"
            type="email"
            placeholder={t('eMail')}
            required
          />
          <Input
            data-testid="deletion-station"
            name="station"
            placeholder={t('radioStationOptional')}
          />
          <Textarea
            data-testid="deletion-notes"
            name="notes"
            placeholder={t('anythingElseWeShouldKnow')}
            rows={4}
          />
          <label className="flex items-start gap-2 text-sm">
            <input
              data-testid="deletion-confirm"
              type="checkbox"
              name="confirmed"
              className="mt-1"
            />
            <span>{t('iAmThePersonNamed')}</span>
          </label>
          <Button data-testid="deletion-submit" type="submit">
            {t('sendTheRequest')}
          </Button>
        </form>
      </section>
    </main>
  );
}
