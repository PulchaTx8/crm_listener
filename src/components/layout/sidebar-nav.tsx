'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { Route } from 'next';
import { useState } from 'react';
import { cn } from '@/lib/utils';
import {
  NAV_COOKIE,
  NAV_COOKIE_MAX_AGE,
  activeSectionKey,
  isSectionOpen,
  serializeExpanded,
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
  const [expanded, setExpanded] = useState<string[]>(expandedSections);
  const activeKey = activeSectionKey(sections, pathname);

  function toggle(key: string) {
    const next = expanded.includes(key) ? expanded.filter((k) => k !== key) : [...expanded, key];
    setExpanded(next);
    // Written straight to document.cookie rather than through a Server Action:
    // opening a section must not cost a round trip, and this value guards
    // nothing (see NAV_COOKIE's own comment). SameSite=Lax and a year's life.
    document.cookie = `${NAV_COOKIE}=${encodeURIComponent(serializeExpanded(next))}; path=/; max-age=${NAV_COOKIE_MAX_AGE}; samesite=lax`;
  }

  return (
    <nav className="flex flex-1 flex-col gap-6 overflow-y-auto px-3 py-4">
      {sections.map((section) => {
        const open = isSectionOpen(section.key, activeKey, expanded);
        const panelId = `nav-section-${section.key}`;
        return (
          <div key={section.key} data-nav-section={section.key} className="flex flex-col gap-1">
            <button
              type="button"
              onClick={() => toggle(section.key)}
              aria-expanded={open}
              aria-controls={panelId}
              className="flex items-center justify-between gap-2 rounded-md px-3 py-1 text-left text-[11px] font-medium uppercase tracking-wider text-sidebar-muted transition-colors hover:text-white"
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
                const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
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
