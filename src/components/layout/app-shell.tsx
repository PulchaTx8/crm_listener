import Link from 'next/link';
import { cn } from '@/lib/utils';
import { SidebarNav, type NavSection } from './sidebar-nav';
import { SettingsMenu } from './settings-menu';
import { SidebarToggle } from './sidebar-toggle';
import { getTranslations } from 'next-intl/server';

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
  megaphone:
    'M3 11v2a1 1 0 0 0 1 1h3l5 4V6L7 10H4a1 1 0 0 0-1 1zM16 9a3 3 0 0 1 0 6M19 6a7 7 0 0 1 0 12',
  // A ticket, for the entries a promotion collects. Its own path rather than
  // reusing megaphone: the two sit next to each other in the Promotions
  // section, and one icon on both rows would make the pair read as one link
  // that had been rendered twice.
  ticket:
    'M3 9V7a1 1 0 0 1 1-1h16a1 1 0 0 1 1 1v2a2 2 0 0 0 0 4v2a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-2a2 2 0 0 0 0-4zM13 6v2M13 11v2M13 16v2',
  // A music note, for the catalogue. Its own path rather than reusing radio:
  // that one is Overview's "My stations" and would make the two sections read
  // as the same destination.
  music: 'M9 18V5l12-2v13M9 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0zM21 16a3 3 0 1 1-6 0 3 3 0 0 1 6 0z',
  // A speech bubble, for what the bot says. Its own path rather than reusing
  // anything here: nine of the ten glyphs above are objects or people, and the
  // Templates block is about WORDS — the one idea this map had no shape for.
  // megaphone is the near miss and is genuinely a different thing: that one
  // announces a promotion to everybody, this one is one side of a conversation
  // with one listener.
  message: 'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z',
  // A bar chart, for Block 8a's Dashboards section. Its own path rather than
  // reusing anything here: the eleven glyphs above are all objects or
  // people (a radio, a box, a shield, a ticket, a speech bubble…), and
  // nothing already declared means *a measure* — the one idea three read-only
  // aggregate screens are entirely about.
  chart: 'M3 3v18h18M8 17V10M13 17V6M18 17v-4',
  // A tag, for Block 20b's Genres. Its own path rather than reusing anything
  // here: `music` is Songs on an adjacent row of the SAME section, which is
  // exactly the case the house rule forbids, and nothing else declared means
  // *a label you file something under* — which is what a genre is.
  tag: 'M20.59 13.41 13.42 20.58a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82zM7 7h.01',
  // A disc, for Block 20b's Albums. Its own path for the same reason as `tag`
  // directly above -- it sits two rows from Songs -- and because an album is a
  // physical object in a way a note is not: `box` was the near miss and reads
  // as a package, which is Inventory's meaning of it.
  disc: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 14.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z',
  // A folder, for Block 27's Catalogue > Categories. Its own path rather than
  // reusing `tag`, which is Genres — the ADJACENT ROW OF THIS SAME SECTION,
  // which is the one case the house rule forbids: one icon on two neighbouring
  // rows reads as one link rendered twice. (Inventory > Categories keeps `tag`,
  // and keeps it legitimately: that is a different section, so the two never
  // appear side by side — the same non-adjacency that already lets `box` serve
  // both Inventory and Pickups.) Nothing else declared here means *the thing you
  // file others under*: `box` is a package, `inbox` is a tray things flow
  // through, and `tag` is spoken for.
  folder: 'M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z',
  // A bin, for the deletion requests in the Platform section. Its own path
  // rather than reusing anything above, and the two near misses are both worse
  // than a new glyph: `inbox` is the ADJACENT row of that same section (Contact
  // requests), which is exactly the case the house rule forbids; and `shield`,
  // the other candidate, already means *a guard* on three rows elsewhere
  // (Roles, Audit trail, Maintenance) -- it says protection, and this row is
  // where somebody asks to be erased. Nothing declared here meant erasure.
  trash:
    'M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6M10 11v6M14 11v6',
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
export async function AppShell({
  sections,
  user,
  expandedSections,
  collapsed,
  children,
}: {
  sections: NavSection[];
  user: ShellUser;
  expandedSections: string[];
  /**
   * Block 27. Folded to a rail of icons. Resolved on the server
   * (lib/auth/shell.ts) so the chrome arrives at the right width rather than
   * snapping to it after hydration.
   */
  collapsed: boolean;
  children: React.ReactNode;
}) {
  // Block 12a. The shell is rendered by both layouts, so its wording is the
  // first thing every screen inherits.
  const t = await getTranslations('shell');

  return (
    <div className="flex min-h-screen bg-background">
      {/*
        Block 27. Two widths, one aside. THE TOGGLE LIVES AT THE TOP and the
        reason is mechanical rather than aesthetic: the footer already carries an
        avatar, a name, a role, a settings gear and a sign-out form inside 260
        pixels, and when the rail narrows that footer must itself become a stack
        of icons. A control whose home disappears in the state it produces is in
        the wrong place.
      */}
      <aside
        className={cn(
          'sticky top-0 hidden h-screen shrink-0 flex-col border-r border-sidebar-border bg-sidebar md:flex',
          collapsed ? 'w-[72px]' : 'w-[260px]',
        )}
        data-collapsed={collapsed ? 'true' : 'false'}
      >
        <div
          className={cn(
            'border-b border-sidebar-border py-4',
            collapsed ? 'flex flex-col items-center gap-2 px-2' : 'flex items-center gap-3 px-5',
          )}
        >
          {/* The mark itself, on the reasoning src/components/auth/brand-mark.tsx
              sets out: the tile carries its own background, so the tinted square
              that used to sit behind the drawn glyph goes with it. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/brand/pulchatx-mark.png"
            alt=""
            width={36}
            height={36}
            className="h-9 w-9 rounded-lg"
          />
          {/* The wordmark goes when folded; the mark stays, because 72 pixels of
              unbranded dark column is not a product. */}
          {!collapsed && (
            <span className="flex flex-col leading-tight">
              <span className="text-sm font-semibold text-white">PulchatX</span>
              <span className="text-[10px] uppercase tracking-widest text-sidebar-muted">
                {t('tagline')}
              </span>
            </span>
          )}
          <div className={collapsed ? undefined : 'ml-auto'}>
            <SidebarToggle collapsed={collapsed} />
          </div>
        </div>

        <SidebarNav
          sections={sections}
          expandedSections={expandedSections}
          collapsed={collapsed}
        />

        {/* Folded, the footer stacks: avatar, gear, sign out. The name and the
            role go with the width — they are the two things here that cannot be
            an icon. */}
        <div
          className={cn(
            'border-t border-sidebar-border py-4',
            collapsed ? 'flex flex-col items-center gap-2 px-2' : 'flex items-center gap-3 px-4',
          )}
        >
          <span
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-sidebar-accent text-xs font-semibold text-sidebar-accent-foreground"
            title={collapsed ? (user.fullName ?? user.email) : undefined}
          >
            {initials(user)}
          </span>
          {!collapsed && (
            <span className="flex min-w-0 flex-col leading-tight">
              <span className="truncate text-sm text-white">{user.fullName ?? user.email}</span>
              <span className="text-xs text-sidebar-muted">{user.roleLabel}</span>
            </span>
          )}
          {/* Block 12b, and Block 25: the gear that changes the interface
              language and the theme. */}
          <SettingsMenu />
          <form action="/auth/signout" method="post" className={collapsed ? undefined : 'ml-auto'}>
            <button
              type="submit"
              aria-label={t('signOut')}
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
              {t('signOut')}
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
