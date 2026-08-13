'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { Route } from 'next';
import { cn } from '@/lib/utils';

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
 */
export function SidebarNav({ sections }: { sections: NavSection[] }) {
  const pathname = usePathname();

  return (
    <nav className="flex flex-1 flex-col gap-6 overflow-y-auto px-3 py-4">
      {sections.map((section) => (
        <div key={section.key} data-nav-section={section.key} className="flex flex-col gap-1">
          <p className="px-3 pb-1 text-[11px] font-medium uppercase tracking-wider text-sidebar-muted">
            {section.label}
          </p>
          {section.items.map((item) => {
            // Exact match, or a nested route beneath this one. Without the
            // slash, /app would light up for /app-something too.
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
      ))}
    </nav>
  );
}
