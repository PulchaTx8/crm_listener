import { cookies, headers } from 'next/headers';
import { getRequestConfig } from 'next-intl/server';
import { resolveLocale, type Locale } from './locales';

/**
 * Block 12a, D2. What language this request is rendered in.
 *
 * IT READS THE COOKIE AND NEVER THE PROFILE, and that is not a shortcut. The
 * middleware (src/middleware.ts) already loads the profile row on every request
 * to check must_change_password, and writes the cookie from it. Asking the
 * database again here would be a second round trip on every render, to learn
 * something that was known a moment earlier.
 *
 * The locale is resolved through the pure function in ./locales rather than
 * read straight out of the cookie, because the cookie is client-writable and
 * the value ends up in the import path below.
 */
export default getRequestConfig(async () => {
  const [cookieStore, headerList] = await Promise.all([cookies(), headers()]);

  const locale: Locale = resolveLocale({
    cookie: cookieStore.get('locale')?.value,
    acceptLanguage: headerList.get('accept-language'),
  });

  return {
    locale,
    messages: (await import(`../../messages/${locale}.json`)).default,
  };
});
