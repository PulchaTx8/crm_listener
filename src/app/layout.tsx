import type { Metadata } from 'next';
import { NextIntlClientProvider } from 'next-intl';
import { getLocale, getTranslations } from 'next-intl/server';
import './globals.css';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('app');
  return { title: t('title'), description: t('description') };
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Block 12a. `lang` is not decoration: it is what a screen reader uses to
  // pick a voice and what a browser uses to decide whether to offer a
  // translation. Reading it here is also what makes every route dynamic --
  // /_not-found was the last prerendered one, and it goes with this.
  const locale = await getLocale();

  return (
    <html lang={locale}>
      <body>
        <NextIntlClientProvider>{children}</NextIntlClientProvider>
      </body>
    </html>
  );
}
