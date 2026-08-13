import { AppShell } from '@/components/layout/app-shell';
import { getShellContext } from '@/lib/auth/shell';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const { sections, user, expandedSections } = await getShellContext();
  return (
    <AppShell sections={sections} user={user} expandedSections={expandedSections}>
      {children}
    </AppShell>
  );
}
