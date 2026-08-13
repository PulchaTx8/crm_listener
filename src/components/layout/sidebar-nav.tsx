'use client';

import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import type { Route } from 'next';
import { useEffect, useState } from 'react';
import { cn } from '@/lib/utils';
import {
  NAV_COOKIE,
  NAV_COOKIE_MAX_AGE,
  activeSectionKey,
  isSectionOpen,
  serializeExpanded,
  toggleExpanded,
} from '@/lib/nav/disclosure';

export interface NavItem {
  href: Route;
  label: string;
  /** Inline SVG path data, so the shell carries no icon dependency. */
  icon: string;
}

export interface NavSection {
  /**
   * A stable identifier, and NOT the label.
   *
   * Block 20b, D5. `label` is the output of `t('audience')` — translated, and
   * different in every language. The disclosure cookie (Task 3) is keyed on
   * this, so keying it on the label would forget every expansion the moment
   * somebody switched language, and would key a Portuguese and an English
   * installation differently for no reason. The two happen to spell the same
   * word today; neither is derived from the other, and renaming a section's
   * copy must never silently reset everybody's sidebar.
   */
  key: string;
  label: string;
  items: NavItem[];
}

/**
 * Client component only because the active row depends on the current path.
 * Everything else in the shell stays a Server Component.
 *
 * Block 20b, D4/D5. Every section is now a disclosure rather than a plain
 * heading: closed by default, open for the section holding the current page,
 * and open for whatever a member expanded themselves — logic that lives in
 * `@/lib/nav/disclosure` rather than here, because this file is a client
 * component and this repository has no component-testing library.
 */
export function SidebarNav({
  sections,
  expandedSections,
}: {
  sections: NavSection[];
  expandedSections: string[];
}) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [expanded, setExpanded] = useState<string[]>(expandedSections);
  const activeKey = activeSectionKey(sections, pathname);

  // Task 3 review, fix round 1. `isSectionOpen` keeps the ACTIVE section open
  // no matter what `expanded` says (disclosure.ts's own contract), so a click
  // on that section's own heading can never be answered by `expanded`/the
  // cookie -- there is nothing for the cookie to hold that would ever close
  // it. THE BUG THIS REPLACES: `toggle` used to write there anyway, closing
  // nothing on screen (the button visibly did not respond) while silently
  // recording the OPPOSITE of what the click asked -- Audience "expanded",
  // which then opened it on every OTHER screen.
  //
  // The fix (spec §4.2, "a caller may still collapse the active section by
  // hand; it re-opens on the next navigation") is a LOCAL override that never
  // reaches the cookie.
  //
  // Fix round 2. THE FIRST VERSION OF THIS COMMENT WAS WRONG. It carried the
  // pathname the override was set for and compared on READ
  // (`override.pathname === pathname`), on the theory that a stale value from
  // the PREVIOUS page would simply stop matching once `pathname` moved on. It
  // does not: `SidebarNav` is mounted ONCE by the shared `(app)` layout and is
  // NOT remounted by a client-side navigation between sibling routes
  // (standard App Router layout persistence) -- so navigating away and then
  // BACK to the same page made the stored pathname match again, and the
  // override revived. Collapse Audience on /members, visit /promotions,
  // return to /members by clicking Members again: Audience rendered collapsed
  // -- exactly the "re-opens on the next navigation" guarantee broken.
  //
  // So the override is cleared UNCONDITIONALLY on every pathname change
  // instead, by the effect below, rather than merely stopping to apply. That
  // costs one extra render right after a navigation (the effect runs after
  // the DOM commits with the new pathname, so the stale value is still what
  // renders on the FIRST pass; the clearing effect then triggers a second one)
  // -- and that extra render is the actual price of "re-opens on the next
  // navigation", not an optimisation to route around.
  //
  // Whole-branch review, I1. THIS WAS STILL WRONG, in a way both fix rounds
  // above missed: the override lived here as a bare `boolean`
  // (`activeCollapsed`), answering for "whichever section is active right
  // now" rather than for a specific section -- and `isSectionOpen` was never
  // called for the active section at all, this file's own ternary bypassed it.
  // Two costs, paid together: the settled rule (this whole comment block) was
  // reachable only by a browser, exactly what `disclosure.ts` exists to
  // prevent; and a bare boolean carried no memory of WHICH section it was set
  // for, so the section that had just BECOME active inherited the outgoing
  // section's collapsed flag for the one render before this effect fires --
  // collapse Audience, navigate to Promotions, and Promotions rendered closed
  // for a frame. `collapsedKey` fixes both: it is the single source `disclosure
  // .ts`'s `isSectionOpen` now combines itself (`collapsedKey !== key` only
  // when `key === activeKey`), so a section that is not the one just collapsed
  // is never affected, active or not, on this render or any other.
  const [collapsedKey, setCollapsedKey] = useState<string | null>(null);
  useEffect(() => setCollapsedKey(null), [pathname]);

  function toggle(key: string) {
    if (key === activeKey) {
      setCollapsedKey((current) => (current === key ? null : key));
      return;
    }
    const next = toggleExpanded(expanded, key);
    setExpanded(next);
    // Written straight to document.cookie rather than through a Server Action:
    // opening a section must not cost a round trip, and this value guards
    // nothing (see NAV_COOKIE's own comment). SameSite=Lax and a year's life.
    document.cookie = `${NAV_COOKIE}=${encodeURIComponent(serializeExpanded(next))}; path=/; max-age=${NAV_COOKIE_MAX_AGE}; samesite=lax`;
  }

  return (
    <nav className="flex flex-1 flex-col gap-6 overflow-y-auto px-3 py-4">
      {sections.map((section) => {
        // Whole-branch review, I1. `collapsedKey` now travels INTO
        // `isSectionOpen` rather than being combined with its answer here --
        // the hardest-won rule (this section's own history above) lives in
        // `disclosure.ts`, where a unit test can reach it, for every section
        // including the active one.
        const open = isSectionOpen(section.key, activeKey, expanded, collapsedKey);
        const panelId = `nav-section-${section.key}`;
        return (
          <div key={section.key} data-nav-section={section.key} className="flex flex-col gap-1">
            <button
              type="button"
              onClick={() => toggle(section.key)}
              aria-expanded={open}
              aria-controls={panelId}
              className="flex items-center justify-between gap-2 rounded-md px-3 py-1 text-left text-[11px] font-medium uppercase tracking-wider text-sidebar-muted transition-colors hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-accent-foreground focus-visible:ring-offset-2 focus-visible:ring-offset-sidebar"
            >
              {section.label}
              <svg
                aria-hidden="true"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                className={cn('h-3 w-3 shrink-0 transition-transform', open && 'rotate-90')}
              >
                <path d="M9 18l6-6-6-6" />
              </svg>
            </button>
            {/* Stays in the DOM, hidden rather than unmounted -- aria-controls
                above must point at an element that exists.
                `flex` is conditional rather than a permanent class: the
                `hidden` attribute's `display: none` is a User-Agent style,
                the lowest rung of the cascade, so an unconditional `flex`
                utility (an AUTHOR style) would win regardless of `hidden`
                being present -- the panel would carry the attribute and stay
                laid out and clickable anyway. Tailwind's own docs name this
                exact interaction. */}
            <div id={panelId} hidden={!open} className={cn('flex-col gap-1', open && 'flex')}>
              {section.items.map((item) => {
                // Exact match, or a nested route beneath this one. Without the
                // slash, /app would light up for /app-something too. Unchanged
                // by this block: this compares pathname against item.href
                // directly, not through activeSectionKey, which answers a
                // different question (which SECTION owns the page) and strips
                // query strings that this comparison must not strip --
                // Catalog's three items differ from each other only by
                // ?tab=.
                //
                // Whole-branch review, I3. A pathname never carries a query
                // string, so that comparison alone left Record labels, Genres
                // and Albums -- whose hrefs are `/music/catalog?tab=...` --
                // unable to ever match, on any screen: no aria-current, no
                // highlight, ever. `hrefPath`/`hrefQuery` split the href apart
                // so the path still has to match exactly as before (Songs does
                // not light up for the catalogue's own /music/catalog), and
                // when the href names a query string, every parameter it names
                // must also match the current one. `hrefQuery` is `undefined`
                // for every OTHER item in this sidebar, so `queryMatches`
                // short-circuits to `true` and this branch changes nothing for
                // them -- the plain-path rule is exactly what it was.
                const [hrefPath = '', hrefQuery] = `${item.href}`.split('?');
                const queryMatches =
                  !hrefQuery ||
                  [...new URLSearchParams(hrefQuery)].every(
                    ([param, value]) => searchParams.get(param) === value,
                  );
                const active =
                  (pathname === hrefPath || pathname.startsWith(`${hrefPath}/`)) && queryMatches;
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    aria-current={active ? 'page' : undefined}
                    className={cn(
                      'flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors',
                      active
                        ? 'bg-sidebar-accent font-medium text-sidebar-accent-foreground'
                        : 'text-sidebar-foreground hover:bg-sidebar-accent/60 hover:text-white',
                    )}
                  >
                    <svg
                      aria-hidden="true"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.75"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      className="h-4 w-4 shrink-0"
                    >
                      <path d={item.icon} />
                    </svg>
                    {item.label}
                  </Link>
                );
              })}
            </div>
          </div>
        );
      })}
    </nav>
  );
}
