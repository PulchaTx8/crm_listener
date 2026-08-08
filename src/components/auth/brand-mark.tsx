import { getTranslations } from 'next-intl/server';

/**
 * The PulchatX mark and wordmark.
 *
 * Extracted because it had two copies -- `(auth)/layout.tsx` and the landing
 * page -- and this block deletes the landing while giving the layout a second
 * place to draw it (the panel on a wide screen, a header on a narrow one). Left
 * inline that would have been three.
 *
 * NOT A LINK, unlike the copy it replaces. Both old copies wrapped this in
 * `<Link href="/">`, and `/` is now a redirect to the sign-in screen -- so on
 * every screen that renders this, the link either points at the page you are
 * already on or bounces you to it. A control that appears to navigate and does
 * not is worse than a picture.
 */
export async function BrandMark({ className }: { className?: string }) {
  const t = await getTranslations('auth');
  return (
    <div className={className}>
      <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-sidebar text-sidebar-accent-foreground">
        <svg
          aria-hidden="true"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.75"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="h-5 w-5"
        >
          <path d="M12 12h.01M7.05 16.95a7 7 0 0 1 0-9.9M16.95 7.05a7 7 0 0 1 0 9.9M4.22 19.78a11 11 0 0 1 0-15.56M19.78 4.22a11 11 0 0 1 0 15.56" />
        </svg>
      </span>
      <span className="text-lg font-semibold">{t('pulchatx')}</span>
    </div>
  );
}
