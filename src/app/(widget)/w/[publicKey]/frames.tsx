import type { StationIdentity } from '@/services/widget-installations';

/**
 * Block 19b, §6. The two shapes the widget's one page can take.
 *
 * THESE MOVED OUT OF `(widget)/layout.tsx`, which imposed the embedded shape on
 * every request because there was only one. A layout cannot make this choice:
 * it does not see the request's `Sec-Fetch-Dest`, and it wraps the route
 * regardless of what the route decided. So the layout became a pass-through and
 * both shapes live here, beside the page that picks between them.
 *
 * SERVER COMPONENTS, with no `'use client'`: neither frame has state, and the
 * `<style href=… precedence=…>` mechanism below is React 19's own hoisting,
 * which works from the server.
 *
 * BOTH TAKE `lang`, AND BOTH ARE WHERE THE WIDGET'S LANGUAGE IS DECLARED.
 * Block 30d lets a Station choose what its listeners read
 * (`companies.listener_locale`), and the page wraps its own subtree in a second
 * `NextIntlClientProvider` for that locale — but `<html lang>` is set once by
 * the root layout from the request's own resolution, which is the console
 * operator's cookie and not the Station's choice. `lang` is INHERITED FROM THE
 * NEAREST ANCESTOR THAT CARRIES IT, so declaring it on the element that wraps
 * the widget's content is what actually governs the harm: the voice a screen
 * reader picks, and whether a browser offers to translate a page that is
 * already in the reader's language. The `<html>` attribute itself still names
 * the cookie's locale — nothing under here can reach it — and that residue is
 * inert, because no widget text is an ancestor of these elements.
 *
 * REQUIRED RATHER THAN OPTIONAL: this page renders a frame from three places,
 * and a prop that may be omitted is one a fourth would forget on the day
 * somebody adds it.
 */

/**
 * What every widget has been since Block 17a: a 28rem column on somebody else's
 * page, with nothing of this product's chrome around it.
 *
 * TRANSPARENT, so the Station's own page shows through around the widget.
 * `globals.css` paints `body` with `bg-background` (a faint cool grey) for the
 * application, and inside an iframe that grey is a rectangle sitting on
 * somebody else's design.
 *
 * `href` + `precedence` is what makes React hoist this into <head> and dedupe
 * it rather than emit a <style> in the body — the supported React 19 mechanism,
 * not a trick. It survives the CSP because `style-src` carries
 * `'unsafe-inline'` (src/lib/security/csp.ts, which explains at length why that
 * keyword is there for the style ATTRIBUTE React emits everywhere); this rule
 * needs no nonce as a result.
 *
 * 28rem is Tailwind's `max-w-md` exactly. A widget is a column in somebody
 * else's sidebar, not a page: wider and it stops fitting where a Station will
 * actually put it.
 */
export function EmbeddedFrame({
  lang,
  children,
}: {
  /** The language the widget's own text is in — see this file's header. */
  lang: string;
  children: React.ReactNode;
}) {
  return (
    <>
      <style href="widget-surface" precedence="high">{`html,body{background:transparent}`}</style>
      <div lang={lang} className="mx-auto w-full max-w-md p-4">
        {children}
      </div>
    </>
  );
}

/**
 * What a listener who tapped a link inside WhatsApp gets: a screen with a floor,
 * a Station's name at the top of it, and buttons a thumb can hit.
 *
 * THE HEADER IS OPTIONAL AND THE PANELS ARE NOT. `identity` is null when the
 * door could not be reached or refused (design §7): the frame still draws, and
 * a listener still asks for their song. A Station's name is not worth a screen
 * nobody can use.
 *
 * THE STYLE BLOCK RATHER THAN `globals.css`, which is the same argument the
 * embedded frame's transparency rule has always made: the widget's visual rules
 * do not enter the file every other screen in this product shares. A SECOND
 * `href`, because React dedupes by that name and these two rules must never be
 * mistaken for one another — no request gets both.
 *
 * CHECKBOXES AND RADIOS ARE EXCLUDED FROM THE TOUCH-TARGET RULE, and it is not
 * a nicety: 17c's consent box and its option list are `input[type=checkbox]`
 * and `input[type=radio]`, and a 2.75rem minimum height turns each of them into
 * a tall rectangle beside its label.
 */
export function AppFrame({
  identity,
  lang,
  children,
}: {
  identity: StationIdentity | null;
  /** The language the widget's own text is in — see this file's header. */
  lang: string;
  children: React.ReactNode;
}) {
  return (
    <div lang={lang} data-widget-presentation="app" className="min-h-dvh bg-background">
      <style href="widget-app-surface" precedence="high">{`
        html,body{background:hsl(var(--background))}
        [data-widget-presentation='app'] button,
        [data-widget-presentation='app'] select,
        [data-widget-presentation='app'] textarea,
        [data-widget-presentation='app'] input:not([type='checkbox']):not([type='radio']){
          min-height:2.75rem;font-size:1rem
        }
      `}</style>

      {identity !== null && (
        <header
          className="flex items-center gap-3 border-b bg-card px-4 py-3 text-card-foreground"
          data-testid="widget-station-header"
        >
          {identity.thumbUrl ? (
            // A plain <img> rather than next/image, the same choice
            // request-song.tsx makes for Deezer covers: this page is served to
            // a listener on a Station's own terms and the optimiser would put
            // this deployment's host in front of an image the Station already
            // serves. `alt` is empty ON PURPOSE — the name is the very next
            // element, and a screen reader announcing it twice is noise.
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={identity.thumbUrl}
              alt=""
              width={40}
              height={40}
              className="h-10 w-10 rounded-full object-cover"
            />
          ) : null}
          <span className="text-base font-semibold">{identity.name}</span>
        </header>
      )}

      <div className="mx-auto w-full max-w-md p-4">{children}</div>
    </div>
  );
}
