/**
 * Block 17a, spec §4.2. The widget's own frame — and it draws NO application
 * chrome at all: no navigation, no locale switcher, no footer, no Station name.
 * Everything this product usually puts around a page belongs to the product;
 * this page belongs to somebody else's website, and every pixel it adds is a
 * pixel a radio station's designer did not ask for.
 *
 * IT IS NOT A ROOT LAYOUT, and it cannot be. `src/app/layout.tsx` exists and
 * owns `<html>` and `<body>` for the whole application; a route group can only
 * take those over when EVERY group has its own root layout and there is no
 * `app/layout.tsx` at all. So the brief's "sets `<html>` background to
 * transparent" is done with a rule rather than an attribute — the alternative
 * would have been to give every other route group its own root layout, which is
 * a rewrite of four working screens' outermost markup to change one colour on a
 * fifth.
 */
export default function WidgetLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      {/*
        TRANSPARENT, so the Station's own page shows through around the widget.
        `globals.css` paints `body` with `bg-background` (a faint cool grey) for
        the application, and inside an iframe that grey is a rectangle sitting on
        somebody else's design.

        `href` + `precedence` is what makes React hoist this into <head> and
        dedupe it rather than emit a <style> in the body — the supported React 19
        mechanism, not a trick. It survives the CSP because `style-src` carries
        `'unsafe-inline'` (src/lib/security/csp.ts, which explains at length why
        that keyword is there for the style ATTRIBUTE React emits everywhere);
        this rule needs no nonce as a result. Putting it in `globals.css` behind
        a `:has()` selector was the alternative, and was rejected because it puts
        the widget's one visual rule in the file every other screen shares.
      */}
      <style href="widget-surface" precedence="high">{`html,body{background:transparent}`}</style>
      {/*
        28rem is Tailwind's `max-w-md` exactly. A widget is a column in somebody
        else's sidebar, not a page: wider and it stops fitting where a Station
        will actually put it.
      */}
      <div className="mx-auto w-full max-w-md p-4">{children}</div>
    </>
  );
}
