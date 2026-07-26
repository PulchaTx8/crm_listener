import Link from 'next/link';
import { redirect } from 'next/navigation';
import { createUserClient } from '@/lib/supabase/user-client';

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createUserClient();
  const { data: isAdmin } = await supabase.rpc('is_platform_admin');

  // Defense in depth: the RPCs re-check this themselves, but a non-admin
  // should never see the screens either. /app is where an ordinary member
  // belongs — bouncing them to /login would loop, since they are signed in.
  if (!isAdmin) redirect('/app');

  return (
    <div className="mx-auto min-h-screen max-w-4xl px-6 py-12">
      <nav className="mb-8 flex items-center justify-between">
        <div className="flex gap-4 text-sm">
          <Link href="/admin/customers" className="underline">
            Customers
          </Link>
          <Link href="/admin/contact-requests" className="underline">
            Contact requests
          </Link>
          <Link href="/app" className="underline">
            My stations
          </Link>
        </div>
        <form action="/auth/signout" method="post">
          <button type="submit" className="text-sm underline">
            Sign out
          </button>
        </form>
      </nav>
      {children}
    </div>
  );
}
