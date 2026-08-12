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
 * `app/layout.tsx` at all.
 *
 * BLOCK 19b EMPTIED IT. Until then this file imposed a 28rem column and a
 * transparent `html,body` on every request under `/w`, which was right while
 * there was one presentation and wrong the moment there were two: a layout
 * cannot see `Sec-Fetch-Dest`, and it wraps the route whatever the route
 * decided. Both rules now live in `w/[publicKey]/frames.tsx`, chosen per
 * request by the page. What is left is the statement that this group adds
 * nothing — which is what the paragraph above always claimed it was.
 */
export default function WidgetLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
