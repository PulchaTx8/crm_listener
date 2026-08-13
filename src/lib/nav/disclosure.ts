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
 * The query string is stripped from each href before comparing. Catalogue's
 * three items differ from each other ONLY by `?tab=`, and a pathname never
 * carries one — matching on the raw href would leave that section permanently
 * inactive.
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
 * standing in.
 *
 * The active section is never written to the cookie. It is open because of WHERE
 * THE CALLER IS, not because of anything they chose, and it has to go back to
 * whatever they did choose the moment they navigate away.
 */
export function isSectionOpen(
  key: string,
  activeKey: string | null,
  expanded: readonly string[],
): boolean {
  return key === activeKey || expanded.includes(key);
}
