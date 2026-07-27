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
      // Visible to every member, including operators and viewers who hold no
      // users.invite. Deliberate, and not a hole: the page renders only what the
      // invitations RLS policy returns, and every write goes through an RPC that
      // re-checks permission. Hiding a link is a courtesy; the boundary is in
      // the database.
      label: 'Organization',
      items: [{ href: '/team', label: 'Team', icon: ICONS.users }],
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
      roleLabel: isAdmin ? 'Platform admin' : 'Member',
    },
  };
}
