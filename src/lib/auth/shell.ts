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
      // Visible to every member, including those holding no inventory
      // permission in any Station at all — the same courtesy Team and Roles
      // below already extend. /inventory redirects at the top of its own
      // page for anyone holding inventory.view nowhere, and every RPC in
      // 0027/0028 (and the select policies in 0029) re-check has_permission
      // themselves regardless of that redirect. Hiding a link is a courtesy;
      // the boundary is in the database.
      label: 'Inventory',
      items: [{ href: '/inventory', label: 'Inventory', icon: ICONS.box }],
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
