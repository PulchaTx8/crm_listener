import { redirect } from 'next/navigation';
import { createUserClient } from '@/lib/supabase/user-client';
import { ICONS, type ShellUser } from '@/components/layout/app-shell';
import type { NavSection } from '@/components/layout/sidebar-nav';

/**
 * Everything the chrome needs, resolved once per request. Both the member area
 * and the platform console call this, so the navigation cannot drift between
 * them — and the platform links only appear for a platform admin, which is a
 * convenience, not the guard: the admin layout still redirects and every RPC
 * re-checks in its own body.
 */
export async function getShellContext(): Promise<{ sections: NavSection[]; user: ShellUser }> {
  const supabase = await createUserClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const [{ data: profile }, { data: isAdmin }] = await Promise.all([
    supabase.from('profiles').select('email, full_name').eq('id', user.id).single(),
    supabase.rpc('is_platform_admin'),
  ]);

  const sections: NavSection[] = [
    {
      label: 'Overview',
      items: [{ href: '/app', label: 'My stations', icon: ICONS.radio }],
    },
    {
      // Visible to every member, including those holding members.view,
      // music.view and promotions.view in no Station at all — the same
      // courtesy every section below extends. Each of the three pages
      // redirects at the top of its own render for a caller who holds its
      // permission nowhere, and the three functions in 0118–0120 re-check
      // it themselves regardless of that redirect, raising 42501 rather
      // than returning a page of zeros. Hiding a link is a courtesy; the
      // boundary is in the database.
      label: 'Dashboards',
      items: [
        // "... overview", not the bare domain word, and the same rule the
        // Inventory section below records for its own rename (Block 6d): a
        // SECTION and an ITEM spelling the same word read as one link
        // rendered twice. This block shipped three of them at once — every
        // one of "Audience", "Music" and "Promotions" is already a section
        // label further down THIS SAME sidebar, so the shipped nav offered
        // two "Audience" entries (one a link here, one a heading over
        // Members and Participations), two "Music" and two "Promotions".
        // Unlike Inventory > Stock, the href is not what changed; only the
        // accessible name is, and tests/e2e/dashboards.spec.ts selects on
        // it by role and name, so its three getByRole('link') calls moved
        // with this.
        { href: '/dashboards/audience', label: 'Audience overview', icon: ICONS.chart },
        { href: '/dashboards/music', label: 'Music overview', icon: ICONS.music },
        { href: '/dashboards/promotions', label: 'Promotions overview', icon: ICONS.megaphone },
      ],
    },
    {
      // Block 8b. Its own section rather than an item under Dashboards,
      // because what it lists crosses every domain -- listeners, promotions,
      // music and stock all export into the same place -- and filing it under
      // one of them would misname where it belongs.
      //
      // "My reports" rather than "Reports", so the section and its single item
      // do not spell the same word: the sidebar renders both, and Block 8a's
      // own note here records what that looks like when they match.
      //
      // No permission guards this link, and none guards the page either. It
      // lists the caller's OWN runs, limited by report_runs' RLS (0122), so
      // there is nothing to hide from somebody whose list is empty. The
      // boundary is on the export buttons, each guarded by its own domain's
      // permission, and in request_report (0127), which re-checks regardless.
      label: 'Reports',
      items: [{ href: '/reports', label: 'My reports', icon: ICONS.inbox }],
    },
    {
      // Visible to every member, including those holding no inventory
      // permission in any Station at all — the same courtesy Team and Roles
      // below already extend. /inventory redirects at the top of its own
      // page for anyone holding inventory.view nowhere, and every RPC in
      // 0027/0028 (and the select policies in 0029) re-check has_permission
      // themselves regardless of that redirect. Hiding a link is a courtesy;
      // the boundary is in the database.
      label: 'Inventory',
      items: [
        // Same href as before Block 6d, Task 10 — only the label changed,
        // from 'Inventory' to 'Stock', so no existing href anywhere breaks.
        // The accessible name DID change, and did break one thing that
        // selected on it: tests/e2e/inventory-flow.spec.ts's own
        // getByRole('link', { name: ... }) had to be updated from 'Inventory'
        // to 'Stock' alongside this rename. 'Inventory' is now the SECTION
        // name, one level up, and having both the section and its first item
        // spell the same word read as one link rendered twice; 'Stock' is
        // what this item actually lists.
        { href: '/inventory', label: 'Stock', icon: ICONS.box },
        // Block 6d, Task 10. /inventory/movements redirects nobody by
        // itself — it opens on whichever Station listCompanyAccess resolves
        // inventory.view in, the same courtesy the item above already
        // extends — and list_movements (0096) re-checks that permission
        // itself regardless. ICONS.inbox rather than ICONS.box: this Record
        // has no dedicated ledger/list glyph, so the choice is among what
        // already exists, and reusing box here — the ROW DIRECTLY ABOVE, in
        // this SAME section — is exactly the case the Audience section's own
        // ticket/megaphone comment warns against (one icon on two adjacent
        // rows reads as one link rendered twice). inbox's tray-with-a-flow
        // shape is otherwise idle in this section (its only other use is
        // Platform > Contact requests, a different section entirely, the
        // same non-adjacency that already lets box itself serve both
        // Inventory and Pickups) and reads reasonably as things moving in
        // and out, which a stock ledger is.
        { href: '/inventory/movements', label: 'Movements', icon: ICONS.inbox },
      ],
    },
    {
      // Visible to every member, including those holding members.view
      // nowhere in the Organization — the same courtesy Inventory just above
      // extends for inventory.view. /members redirects at the top of its own
      // page for anyone holding members.view nowhere (access.ts's
      // canViewAudience), and members_select_reachable plus its four sibling
      // policies (0035_rls_members.sql) filter every read underneath
      // regardless of that redirect. Hiding a link is a courtesy; the
      // boundary is in the database.
      label: 'Audience',
      items: [
        { href: '/members', label: 'Members', icon: ICONS.headphones },
        // Moved here from Promotions in Block 6c, on the owner's ruling: this
        // is the listing of PEOPLE taking part, and it is where the draw is
        // run from, so it belongs beside the audience rather than beside the
        // promotions it happens to reference. The courtesy is unchanged:
        // /participations redirects at the top of its own page for anyone
        // holding participations.view in no Station, 0053's policies and
        // list_participations' own two-permission gate (0090) filter every
        // read regardless, and the write RPCs re-check has_permission in their
        // own bodies (0054). Hiding a link is a courtesy; the boundary is in
        // the database.
        { href: '/participations', label: 'Participations', icon: ICONS.ticket },
      ],
    },
    {
      // Visible to every member, on the same courtesy the two sections above
      // extend: /promotions redirects at the top of its own page for anyone
      // holding promotions.view in no Station, and 0044's three select
      // policies plus every RPC in 0042/0043 re-check has_permission
      // regardless of that redirect. Hiding a link is a courtesy; the boundary
      // is in the database.
      label: 'Promotions',
      items: [
        { href: '/promotions', label: 'Promotions', icon: ICONS.megaphone },
        // Block 6d, Task 9. /pickups redirects nobody by itself — it opens on
        // whichever Station listCompanyAccess resolves promotions.view in,
        // the same courtesy every item in this section already extends — and
        // list_pickups (0095) re-checks that permission itself regardless.
        // ICONS.box rather than a new path: it is the box/package shape
        // ICONS already declares for Inventory, and reusing it here is
        // unlike the ticket/megaphone case just above — those two sit on
        // adjacent ROWS OF THIS SAME SECTION, where one icon on both would
        // read as one link rendered twice, while Inventory is a different
        // section entirely, so the two never appear side by side.
        { href: '/pickups', label: 'Pickups', icon: ICONS.box },
      ],
    },
    {
      // Visible to every member, including those holding no music permission
      // in any Station at all — the same courtesy Inventory, Audience and
      // Promotions already extend. Each of the three pages redirects at the
      // top of its own render for anyone holding music.view nowhere, the
      // select policies in 0099 cut every read to the Stations that do hold
      // it, and every RPC in 0100/0101 re-checks has_permission in its own
      // body. Hiding a link is a courtesy; the boundary is in the database.
      label: 'Music',
      items: [
        { href: '/music/songs', label: 'Songs', icon: ICONS.music },
        { href: '/music/artists', label: 'Artists', icon: ICONS.users },
        { href: '/music/catalog', label: 'Catalog', icon: ICONS.box },
        { href: '/music/requests', label: 'Requests', icon: ICONS.ticket },
        // Last in the section on purpose: it is the destructive one, and a
        // sidebar is read top to bottom. Every other Music item above is a
        // place to build (register a song, an artist, a request); this is
        // the only place to collapse two records into one, irreversibly
        // (0106's apply_music_merge — see merge-panel.tsx's own comment).
        // ICONS.shield rather than a new path: it is already declared for
        // Roles, in a different section entirely (Organization), so the two
        // never sit adjacent — the same non-adjacency Pickups' reuse of
        // ICONS.box relies on, two comments above. Its guard-like shape
        // reads reasonably as the one screen in Music that asks for care.
        { href: '/music/maintenance', label: 'Maintenance', icon: ICONS.shield },
      ],
    },
    {
      // Visible to every member, including those holding templates.view in no
      // Station at all — the same courtesy every section above extends. Both
      // pages redirect at the top of their own render for anyone holding it
      // nowhere, 0109's and 0110's select policies cut every read to the
      // Stations that do hold it, and all four doors in 0113 re-check
      // templates.manage in their own bodies. Hiding a link is a courtesy; the
      // boundary is in the database.
      label: 'Templates',
      items: [
        // ICONS.message is new, and is the block's own: this is the one
        // section about WORDS rather than records, and nothing already
        // declared meant that (see the path's own comment in app-shell.tsx).
        { href: '/templates/messages', label: 'Messages', icon: ICONS.message },
        // ICONS.megaphone rather than message again: these two sit on ADJACENT
        // ROWS OF THIS SAME SECTION, which is exactly the case the Audience
        // section's ticket/megaphone comment warns against — one icon on both
        // would read as one link rendered twice. megaphone is otherwise used
        // only by Promotions, a different section entirely, the same
        // non-adjacency that already lets box serve both Inventory and
        // Pickups. Its shape reads reasonably here: a registered template is
        // the only thing that lets a Station SPEAK FIRST rather than answer.
        { href: '/templates/whatsapp', label: 'WhatsApp', icon: ICONS.megaphone },
      ],
    },
    {
      // Visible to every member, including those holding no organization-scoped
      // permission at all. Deliberate, and not a hole: Team renders the member
      // roster (widened per-permission by RLS, 0024), the role list, the
      // invite form and the per-Station assignment grid — every one of those
      // reads and writes is itself gated by RLS or by a SECURITY DEFINER
      // function re-checking has_org_permission; Roles redirects at the top of
      // its own page for anyone lacking roles.manage, and
      // create_role/update_role/delete_role re-check has_org_permission
      // themselves regardless of that redirect. Hiding a link is a courtesy;
      // the boundary is in the database.
      label: 'Organization',
      items: [
        { href: '/team', label: 'Team', icon: ICONS.users },
        { href: '/roles', label: 'Roles', icon: ICONS.shield },
      ],
    },
  ];

  if (isAdmin) {
    sections.push({
      label: 'Platform',
      items: [
        { href: '/admin/customers', label: 'Customers', icon: ICONS.building },
        { href: '/admin/contact-requests', label: 'Contact requests', icon: ICONS.inbox },
      ],
    });
  }

  return {
    sections,
    user: {
      email: profile?.email ?? user.email ?? '',
      fullName: profile?.full_name ?? null,
      // 'Team member', not 'Member' — this same file's "Audience" section,
      // just above, adds a "Members" nav link for the audience Block 3
      // built (project vocabulary: members are the audience,
      // company_memberships are internal panel users, and the two must
      // never be confused in copy). This label names the signed-in panel
      // user, so it collided with that word the moment this diff added the
      // nav item beside it (Task 8 review, Important 3).
      roleLabel: isAdmin ? 'Platform admin' : 'Team member',
    },
  };
}
