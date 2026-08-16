import { redirect } from 'next/navigation';
import { createUserClient } from '@/lib/supabase/user-client';
import { AppShell } from '@/components/layout/app-shell';
import { getShellContext } from '@/lib/auth/shell';

// Renders from the caller's session cookies, so it can never be static. Stated
// explicitly rather than inferred from cookies(): the Supabase client is built
// before cookies() is reached, so during a build with no configuration this page
// would fail as a prerender error instead of being skipped as dynamic.
export const dynamic = 'force-dynamic';

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createUserClient();
  const { data: isAdmin } = await supabase.rpc('is_platform_admin');

  // Defense in depth: the RPCs re-check this themselves, but a non-admin
  // should never see the screens either. /app is where an ordinary member
  // belongs — bouncing them to /login would loop, since they are signed in.
  if (!isAdmin) redirect('/app');

  const { sections, user, expandedSections, collapsed } = await getShellContext();

  return (
    <AppShell
      sections={sections}
      user={user}
      expandedSections={expandedSections}
      collapsed={collapsed}
    >
      {children}
    </AppShell>
  );
}
