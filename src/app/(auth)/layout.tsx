import { BrandMark } from '@/components/auth/brand-mark';
import { BrandPanel } from '@/components/auth/brand-panel';

/**
 * Sign-in, password reset, the forced password change and the invitation
 * acceptance. Deliberately outside the application shell: somebody held at the
 * password gate should not be shown a navigation they cannot use.
 *
 * Two columns on a wide screen — what the product is on the left, the form on
 * the right — which is also where the landing page's content went when this
 * block deleted it.
 *
 * ON A NARROW SCREEN THE FORM COMES FIRST, and that is the one place this
 * departs from the design it was drawn from. The reference hides its panel
 * below `lg` entirely; here the picture is meant to be replaced periodically by
 * the operator, and a panel nobody on a phone ever sees would make that work
 * invisible to half the audience. So it stays, below the form: whoever came to
 * sign in reaches the e-mail field without scrolling, and whoever arrived at
 * the domain out of curiosity scrolls and finds the pitch.
 *
 * `lg:h-screen` rather than `min-h-screen` on the wide layout: the panel holds
 * a picture of unknown height, and a column that can grow past the viewport
 * would push the form off the bottom of the screen. Each column scrolls inside
 * itself instead. Below `lg` the page scrolls normally, because there the two
 * are stacked and a locked height would trap the content.
 */
export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="bg-background lg:grid lg:h-screen lg:grid-cols-2">
      {/* FIRST IN THE MARKUP, SECOND ON A WIDE SCREEN. The form is what this
          page is for, so it leads the document — which is the order a screen
          reader and the keyboard follow — and `lg:order-2` moves it to the
          right only where the two columns exist. Reordering with CSS is safe
          in exactly this direction: the visual order changes, the focus order
          does not. */}
      <div className="flex flex-col justify-center gap-8 px-6 py-12 lg:order-2 lg:overflow-y-auto lg:px-12">
        {/* The panel's own copy of the mark is hidden below `lg`, where it
            would sit at the very bottom of the page. */}
        <BrandMark className="flex items-center justify-center gap-2 lg:hidden" />
        <div className="mx-auto w-full max-w-sm">{children}</div>
      </div>

      {/* ONE PADDING VALUE ON ALL FOUR SIDES, at every width. The panel is a
          card floating on the page background, so an inset that differs by edge
          reads as a mistake rather than as rhythm. `p-6` also lines the card up
          with the form column's own `px-6` when the two are stacked. */}
      <div className="p-6 lg:order-1 lg:overflow-y-auto">
        <BrandPanel />
      </div>
    </div>
  );
}
