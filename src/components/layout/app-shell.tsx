import Link from 'next/link';
import { SidebarNav, type NavSection } from './sidebar-nav';

/** Feather-style path data, inlined to keep the shell dependency-free. */
export const ICONS = {
  radio:
    'M12 12h.01M7.05 16.95a7 7 0 0 1 0-9.9M16.95 7.05a7 7 0 0 1 0 9.9M4.22 19.78a11 11 0 0 1 0-15.56M19.78 4.22a11 11 0 0 1 0 15.56',
  users:
    'M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75',
  building: 'M3 21h18M5 21V7l8-4v18M19 21V11l-6-4M9 9v.01M9 12v.01M9 15v.01M9 18v.01',
  inbox:
    'M22 12h-6l-2 3h-4l-2-3H2M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z',
  shield: 'M12 3l7 4v5c0 4.4-3 8.3-7 9-4-0.7-7-4.6-7-9V7l7-4z',
  box: 'M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16zM3.27 6.96L12 12.01L20.73 6.96M12 22.08L12 12',
  headphones:
    'M3 18v-6a9 9 0 0 1 18 0v6M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3zM3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z',
} as const;

export interface ShellUser {
  email: string;
  fullName: string | null;
  roleLabel: string;
}

function initials(user: ShellUser): string {
  const source = user.fullName?.trim() || user.email;
  const parts = source.split(/[\s@.]+/).filter(Boolean);
  const first = parts[0]?.[0] ?? '?';
  const second = parts.length > 1 ? (parts[1]?.[0] ?? '') : '';
  return (first + second).toUpperCase();
}

/**
 * The application chrome: a dark sidebar on the left, a light content column on
 * the right. Both the member area and the platform console render inside it, so
 * the two never drift apart visually.
 */
export function AppShell({
  sections,
  user,
  children,
}: {
  sections: NavSection[];
  user: ShellUser;
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-screen bg-background">
      <aside className="sticky top-0 hidden h-screen w-[260px] shrink-0 flex-col border-r border-sidebar-border bg-sidebar md:flex">
        <div className="flex items-center gap-3 border-b border-sidebar-border px-5 py-4">
          <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-sidebar-accent-foreground/15 text-sidebar-accent-foreground">
            <svg
              aria-hidden="true"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.75"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="h-5 w-5"
            >
              <path d={ICONS.radio} />
            </svg>
          </span>
          <span className="flex flex-col leading-tight">
            <span className="text-sm font-semibold text-white">PulchatX</span>
            <span className="text-[10px] uppercase tracking-widest text-sidebar-muted">CRM</span>
          </span>
        </div>

        <SidebarNav sections={sections} />

        <div className="flex items-center gap-3 border-t border-sidebar-border px-4 py-4">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-sidebar-accent text-xs font-semibold text-sidebar-accent-foreground">
            {initials(user)}
          </span>
          <span className="flex min-w-0 flex-col leading-tight">
            <span className="truncate text-sm text-white">{user.fullName ?? user.email}</span>
            <span className="text-xs text-sidebar-muted">{user.roleLabel}</span>
          </span>
          <form action="/auth/signout" method="post" className="ml-auto">
            <button
              type="submit"
              aria-label="Sign out"
              className="rounded-md p-2 text-sidebar-muted transition-colors hover:bg-sidebar-accent hover:text-white"
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
                <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9" />
              </svg>
            </button>
          </form>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        {/* The sidebar is hidden below md, so the bar carries the navigation
            there instead of leaving the user with no way to move. */}
        <header className="sticky top-0 z-10 flex flex-wrap items-center gap-x-4 gap-y-2 border-b bg-card/80 px-6 py-3 backdrop-blur md:hidden">
          <Link href="/app" className="text-sm font-semibold">
            PulchatX
          </Link>
          {sections
            .flatMap((s) => s.items)
            .map((item) => (
              <Link key={item.href} href={item.href} className="text-sm text-muted-foreground">
                {item.label}
              </Link>
            ))}
          <form action="/auth/signout" method="post" className="ml-auto">
            <button type="submit" className="text-sm text-muted-foreground underline">
              Sign out
            </button>
          </form>
        </header>

        <main className="flex-1 px-6 py-6 md:px-8 md:py-8">{children}</main>
      </div>
    </div>
  );
}

/**
 * Page heading. Lives with the page rather than the shell, because a layout
 * cannot know which page is rendering inside it.
 */
export function PageHeader({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-bold tracking-tight">{title}</h1>
        {description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
      </div>
      {action}
    </div>
  );
}
