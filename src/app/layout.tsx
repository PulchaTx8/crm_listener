import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { NextIntlClientProvider } from 'next-intl';
import { getLocale, getTranslations } from 'next-intl/server';
import { cookies } from 'next/headers';
import { resolveTheme, THEME_COOKIE, THEME_SCOPE_HEADER } from '@/lib/theme/theme';
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
   * Block 25, D4. The ONLY place in the product that writes this class.
   *
   * TWO SOURCES, AND EACH ANSWERS THE HALF IT CAN. The middleware says whether
   * this route may be themed at all — it is the only layer that knows the path,
   * and the widget and the public pages must follow the machine (D7, D8). The
   * COOKIE says which theme, because `cookies()` inside a revalidated render sees
   * what the Server Action just wrote, and a header does not: the middleware ran
   * before the action did. Reading the value off the header made choosing a theme
   * land one navigation late, every time, and the e2e is what found it.
   *
   * ABSENT IS AN ANSWER, NOT A GAP. No class means System, and the
   * `prefers-color-scheme` block in globals.css takes over in the browser — with
   * no script, no hydration step and therefore no flash.
   *
   * `resolveTheme` rather than trusting the cookie's string: it is
   * client-writable, and what this returns becomes a class name on the document
   * element.
   */
  const scoped = (await headers()).get(THEME_SCOPE_HEADER) !== null;
  const theme = scoped
    ? resolveTheme({ cookie: (await cookies()).get(THEME_COOKIE)?.value })
    : null;

  return (
    <html lang={locale} className={theme ?? undefined}>
      <body>
        <NextIntlClientProvider>{children}</NextIntlClientProvider>
      </body>
    </html>
  );
}
