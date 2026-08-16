'use client';

import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { NAV_COLLAPSED_COOKIE, NAV_COLLAPSED_MAX_AGE } from '@/lib/nav/collapse';

/**
 * Block 27. Folds the sidebar to a rail of icons, and unfolds it.
 *
 * IT WRITES A COOKIE AND ASKS THE SERVER FOR THE SHELL AGAIN, rather than
 * keeping the width in React state. The width is decided on the server
 * (lib/auth/shell.ts) precisely so the chrome ARRIVES correct instead of
 * flashing after hydration — and a local `useState` beside that would be two
 * sources for one fact, with the next full navigation taking the server's answer
 * and silently undoing the click.
 *
 * `router.refresh()` rather than a reload: it re-renders the Server Components
 * in place, so the page underneath — a filtered list, an open record — is not
 * thrown away to change the width of the chrome around it.
 *
 * The cookie is written straight to document.cookie rather than through a Server
 * Action, on NAV_COOKIE's own reasoning: folding must not cost a round trip, and
 * this value guards nothing.
 */
export function SidebarToggle({ collapsed }: { collapsed: boolean }) {
  const t = useTranslations('shell');
  const router = useRouter();

  function toggle() {
    const next = collapsed ? '0' : '1';
    document.cookie = `${NAV_COLLAPSED_COOKIE}=${next}; path=/; max-age=${NAV_COLLAPSED_MAX_AGE}; samesite=lax`;
    router.refresh();
  }

  return (
    <button
      type="button"
      onClick={toggle}
      // `aria-expanded` on the control, and the label says which way it goes:
      // an icon rail with no words is exactly the state in which a screen reader
      // has nothing else to go on.
      aria-expanded={!collapsed}
      aria-label={collapsed ? t('expandTheSidebar') : t('collapseTheSidebar')}
      className="rounded-md p-2 text-sidebar-muted transition-colors hover:bg-sidebar-accent hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-accent-foreground focus-visible:ring-offset-2 focus-visible:ring-offset-sidebar"
      data-testid="sidebar-toggle"
    >
      <svg
        aria-hidden="true"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="h-4 w-4"
      >
        {/* A panel with a bar down one side — the shape the rest of the industry
            uses for this, so it reads without a caption. Mirrored when folded so
            the filled edge always points at where the panel would go. */}
        <path d="M3 5h18v14H3zM9 5v14" />
      </svg>
    </button>
  );
}
