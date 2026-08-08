import { getTranslations } from 'next-intl/server';
import Link from 'next/link';
import { buttonVariants } from '@/components/ui/button';
import { getLoginHeroUrl } from '@/lib/branding/login-hero';
import { BrandMark } from './brand-mark';

/**
 * The panel beside the sign-in form: what this product is, and a way to ask for
 * an account.
 *
 * It carries what the landing page used to, because this block deletes that
 * page. The two paragraphs and the button still read from the `public`
 * namespace rather than being copied into `auth` -- `/contato`, which the button
 * leads to, reads the same catalogue, and one sentence about what PulchatX is
 * should not exist twice in three languages.
 *
 * The `Entrar` button the landing page carried is gone: the form it pointed at
 * is now the other half of this screen.
 */
export async function BrandPanel() {
  const t = await getTranslations('public');
  const hero = await getLoginHeroUrl();

  return (
    /* `lg:min-h-full` FILLS THE COLUMN. The card is only as tall as its
       contents, and on a wide screen that left the gap under it several times
       the 24px inset above and beside it — the card looked dropped into the
       column rather than fitted to it. `min-` and not `h-full`: a picture taller
       than the viewport still grows the card and scrolls its column. Below `lg`
       there is no column height to fill, and the percentage would resolve
       against nothing, so the class is scoped to the breakpoint. */
    <div className="flex flex-col gap-8 rounded-2xl bg-muted px-8 py-10 lg:min-h-full lg:px-12 lg:py-14">
      {/* Hidden here on a narrow screen because the layout renders the mark
          above the form instead — see (auth)/layout.tsx for why the form comes
          first there. */}
      <BrandMark className="hidden items-center gap-2 lg:flex" />

      <div className="flex flex-col gap-4">
        <h1 className="text-4xl font-bold tracking-tight">{t('pulchatx')}</h1>
        <p className="max-w-xl text-lg text-muted-foreground">
          {t('crmForEntertainmentCompaniesManageYour')}
        </p>
        <p className="max-w-xl text-muted-foreground">{t('pulchatxIsSoldBySubscriptionGet')}</p>
      </div>

      {/* Button takes no asChild and Radix Slot is deliberately not a dependency
          of this project, so the link carries the button styling directly —
          the shape the landing page used. */}
      <Link href="/contato" className={buttonVariants({ className: 'self-start' })}>
        {t('getInTouch')}
      </Link>

      {hero ? (
        /* A PLAIN <img>, NOT next/image, which is this project's standing
           choice for a remote picture (see components/media/image-thumb.tsx):
           the optimiser would proxy the Storage origin through the Next server
           for no gain.

           WIDTH AND HEIGHT ARE STATED, and they are the asset's own 912x456.
           Without them the panel has no height until the bytes arrive and the
           whole column jumps when they do — on the first screen of the product,
           over the form somebody may already be typing in. `h-auto` lets the
           real height follow the scaled width; the pair only fixes the RATIO.

           Not `object-cover`: a replacement of a different shape should be
           letterboxed by its own aspect ratio rather than silently cropped,
           because the operator who uploads it cannot see this file.

           EMPTY ALT, deliberately. This is decoration whose content is chosen
           in a dashboard months from now, so no text written here could
           describe it. An invented alt — "promotional image" — would be read
           aloud on the sign-in screen of every session and tell nobody
           anything; `alt=""` lets a screen reader skip it and reach the form,
           which is what the person came for. */
        // eslint-disable-next-line @next/next/no-img-element -- deliberate; see the comment above.
        <img
          src={hero}
          alt=""
          width={912}
          height={456}
          className="h-auto w-full max-w-[912px] rounded-xl"
        />
      ) : null}
    </div>
  );
}
