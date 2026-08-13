/**
 * Block 20b, D4/D5. Which sidebar sections are open.
 *
 * PURE, AND IN ITS OWN FILE ON PURPOSE. The sidebar is a client component and
 * this repository has no component-testing library — vitest runs in `node`,
 * with no jsdom and no React Testing Library — so a decision left inside
 * `sidebar-nav.tsx` is checked by a browser or by nothing. The same split
 * `promotion-mapping.ts` exists for.
 */

/**
 * NOT HttpOnly, deliberately: the client writes it directly on every toggle,
 * which is why expanding a section costs no round trip. It carries no identity,
 * no permission and no secret — the worst a forged value can do is open a
 * section the caller could open by clicking.
 */
export const NAV_COOKIE = 'pulchatx_nav_open';

/** A year. A sidebar preference that expires is a sidebar preference nobody set. */
export const NAV_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

/**
 * The expanded section keys, from the raw cookie value.
 *
 * Everything here is hostile input — the cookie is writable by the page — and
 * every unreadable shape becomes "nothing expanded" rather than an error. An
 * unknown key is KEPT rather than dropped: sections come and go between blocks,
 * and a key naming no current section simply matches nothing when
 * `isSectionOpen` asks. Dropping it here would silently forget a section that a
 * later deployment brings back.
 */
export function parseExpanded(raw: string | undefined | null): string[] {
  if (!raw) return [];
  const seen = new Set<string>();
  for (const part of raw.split(',')) {
    const key = part.trim();
    if (key !== '') seen.add(key);
  }
  return [...seen];
}

export function serializeExpanded(keys: readonly string[]): string {
  return keys.join(',');
}

/**
 * Adds a key that is absent, removes a key that is present.
 *
 * Extracted from `sidebar-nav.tsx`'s own click handler (Task 3 review, fix
 * round 1) — the add/remove rule is exactly the kind of decision this module
 * exists to hold, checkable by a unit test rather than only by a browser, and
 * the component was about to grow a SECOND piece of toggle logic (the
 * active-section override) beside it.
 *
 * Does not mutate `keys`: it is component state the caller re-renders from,
 * and a `filter`/`splice` that touched the original array in place would
 * break the caller's own comparison of "what changed" between renders.
 */
export function toggleExpanded(keys: readonly string[], key: string): string[] {
  return keys.includes(key) ? keys.filter((k) => k !== key) : [...keys, key];
}

/**
 * The section holding the page the caller is on, or null.
 *
 * THE LONGEST MATCHING HREF WINS, and that is not decoration: `/music/requests`
 * belongs to Audience and `/music/songs` to Catalogue (Block 20b, D1), so a
 * first-match scan over a shared prefix would file the caller under whichever
 * section happened to be built first.
 *
 * The query string is stripped from each href before comparing. Defensive
 * rather than load-bearing today: no nav href carries a query string any more
 * (Block 20c gave Catalogue's three items real routes instead of the
 * `?tab=` addresses that used to make this necessary), so `pathname` and
 * `path` already agree without the strip. Kept because a pathname never
 * carries a query string either way, so the strip costs nothing and a future
 * href built the old way would silently work rather than silently break.
 */
export function activeSectionKey(
  sections: readonly { key: string; items: readonly { href: string }[] }[],
  pathname: string,
): string | null {
  let best: { key: string; length: number } | null = null;

  for (const section of sections) {
    for (const item of section.items) {
      const path = item.href.split('?')[0] ?? item.href;
      // The trailing slash is what makes this a path segment rather than a
      // string prefix: without it, /app lights up for /appointments too.
      const matches = pathname === path || pathname.startsWith(`${path}/`);
      if (matches && (best === null || path.length > best.length)) {
        best = { key: section.key, length: path.length };
      }
    }
  }

  return best?.key ?? null;
}

/**
 * A section is open when the caller expanded it, or when it is the one they are
 * standing in — UNLESS they collapsed that active section by hand, which
 * `collapsedKey` records.
 *
 * The active section is never written to the cookie. It is open because of WHERE
 * THE CALLER IS, not because of anything they chose, and it has to go back to
 * whatever they did choose the moment they navigate away. A hand-collapse of the
 * active section is the one exception the cookie must never learn about — spec
 * §4.2's "a caller may still collapse the active section by hand; it re-opens on
 * the next navigation" — which is why it travels as a separate, ungated
 * argument rather than through `expanded`.
 *
 * WHOLE-BRANCH REVIEW, I1. This used to be sidebar-nav.tsx's own job — a ternary
 * that answered `!activeCollapsed` for the active section and never called this
 * function at all — which meant the rule that took two review rounds to settle
 * (first it wrote the opposite preference into the cookie; then it revived on a
 * round trip) was reachable only by a browser, in the one file this module
 * exists to keep that from happening to. `collapsedKey` is KEYED rather than a
 * bare boolean for the same reason: an unkeyed override answers for whichever
 * section happens to be active right now, so the section that has just BECOME
 * active inherits the previous section's collapsed flag for one render before
 * the caller's clearing effect fires — a flash closed-then-open. Keyed to a
 * specific section, it simply does not match a different `key`, active or not,
 * so there is nothing to flash.
 */
export function isSectionOpen(
  key: string,
  activeKey: string | null,
  expanded: readonly string[],
  collapsedKey: string | null = null,
): boolean {
  if (key === activeKey) return collapsedKey !== key;
  return expanded.includes(key);
}
