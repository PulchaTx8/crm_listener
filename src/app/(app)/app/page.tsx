import { createUserClient } from '@/lib/supabase/user-client';

/**
 * Where a signed-in member lands. Business features arrive in Block 2; what
 * matters here is that a suspended Company still appears, with its reason —
 * companies metadata is visible to org members regardless of status precisely
 * so the customer sees why access stopped instead of an empty screen (spec §4).
 */
export default async function MemberHomePage() {
  const supabase = await createUserClient();

  const { data: companies } = await supabase
    .from('companies')
    .select('id, name, status, suspension_reason')
    .order('name', { ascending: true });

  const list = companies ?? [];

  return (
    <main className="flex flex-col gap-8">
      <header className="flex items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold">Your stations</h1>
          <p className="text-sm text-muted-foreground">
            Audience, prize and promotion features arrive in the next release.
          </p>
        </div>
        <form action="/auth/signout" method="post">
          <button type="submit" className="text-sm underline">
            Sign out
          </button>
        </form>
      </header>

      {list.length === 0 ? (
        <p className="text-muted-foreground">
          No station is linked to your account yet. Please contact us.
        </p>
      ) : (
        <ul className="flex flex-col gap-3">
          {list.map((c) => (
            <li key={c.id} className="flex flex-col gap-1 rounded-md border p-4">
              <div className="flex items-center justify-between gap-4">
                <span className="font-medium">{c.name}</span>
                <span
                  className={
                    c.status === 'active'
                      ? 'rounded-full border px-2 py-0.5 text-xs'
                      : 'rounded-full border border-destructive px-2 py-0.5 text-xs text-destructive'
                  }
                >
                  {c.status}
                </span>
              </div>
              {c.status === 'suspended' ? (
                <p className="text-sm text-muted-foreground">
                  Your subscription is suspended{c.suspension_reason ? `: ${c.suspension_reason}` : ''}.
                  Contact us to restore access.
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
