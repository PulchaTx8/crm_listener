/**
 * Block 27. Whether the sidebar is folded to a rail of icons.
 *
 * PURE, AND IN ITS OWN FILE ON PURPOSE — disclosure.ts beside it gives the
 * reason: the sidebar is a client component and this repository has no
 * component-testing library (vitest runs in `node`, with no jsdom and no React
 * Testing Library), so a decision left inside `sidebar-nav.tsx` is checked by a
 * browser or by nothing.
 *
 * Its own module rather than three more exports in disclosure.ts, because it
 * answers a DIFFERENT question. Which sections are open is about where the
 * caller was working; this is about how much of the screen the chrome may have.
 * Folding must not disturb the disclosure state, and expanding must restore
 * exactly what was open before — which is easiest to keep true when the two
 * never share a value.
 */

/**
 * NOT HttpOnly, deliberately, on the same terms as NAV_COOKIE: the client writes
 * it directly on every click, which is why folding costs no round trip. It
 * carries no identity, no permission and no secret — the worst a forged value
 * can do is fold a sidebar the caller could fold by clicking.
 */
export const NAV_COLLAPSED_COOKIE = 'pulchatx_nav_collapsed';

/** A year. A sidebar preference that expires is a sidebar preference nobody set. */
export const NAV_COLLAPSED_MAX_AGE = 60 * 60 * 24 * 365;

/**
 * Exactly one value means collapsed. Everything else — absent, '0', 'true', a
 * padded '1', rubbish — means expanded.
 *
 * Strict rather than forgiving, because the two failure modes are not
 * symmetric: a sidebar that wrongly arrives EXPANDED costs one click, and one
 * that wrongly arrives FOLDED hides every label on a screen the caller may not
 * know their way around. When in doubt, show the words.
 */
export function parseCollapsed(raw: string | undefined | null): boolean {
  return raw === '1';
}
