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
      {/*
        NO WRAPPER AND NO BACKGROUND, unlike the drawn glyph this replaces. The
        artwork is a tile that already carries its own #4811EF to every edge, so
        a coloured square behind it would only show as a fringe when the two
        purples disagree by a shade.

        A plain <img> rather than next/image, the choice every other picture in
        this project makes (src/app/(widget)/w/[publicKey]/frames.tsx says why
        at length): the file is a fixed 128px asset served from this origin,
        which is the case next/image's optimiser has nothing to add to.

        alt="" on purpose. The wordmark beside it is the same name in text, and
        a screen reader announcing "PulchatX PulchatX" is noise.
      */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src="/brand/pulchatx-mark.png"
        alt=""
        width={36}
        height={36}
        className="h-9 w-9 rounded-lg"
      />
      <span className="text-lg font-semibold">{t('pulchatx')}</span>
    </div>
  );
}
