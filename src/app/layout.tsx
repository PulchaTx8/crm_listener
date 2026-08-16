import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { NextIntlClientProvider } from 'next-intl';
import { getLocale, getTranslations } from 'next-intl/server';
import { isTheme, THEME_HEADER } from '@/lib/theme/theme';
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

  /**
   * Block 25, D4. The ONLY place in the product that writes this class, and it
   * decides nothing: the middleware resolved the theme and said so on a header,
   * having already established that this route may have one at all.
   *
   * ABSENT IS AN ANSWER, NOT A GAP. No class means System, and the
   * `prefers-color-scheme` block in globals.css takes over in the browser — with
   * no script, no hydration step and therefore no flash. That is also what the
   * widget and every public page get, because the middleware deliberately never
   * sets the header for them.
   *
   * `isTheme` rather than trusting the string: the header is deleted and rewritten
   * on every request precisely so a client cannot supply it, and validating what
   * arrives is the second half of that — what this returns becomes a class name
   * on the document element.
   */
  const theme = (await headers()).get(THEME_HEADER);

  return (
    <html lang={locale} className={isTheme(theme) ? theme : undefined}>
      <body>
        <NextIntlClientProvider>{children}</NextIntlClientProvider>
      </body>
    </html>
  );
}
