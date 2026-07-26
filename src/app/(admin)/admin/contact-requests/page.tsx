import { createUserClient } from '@/lib/supabase/user-client';

export default async function ContactRequestsPage() {
  const supabase = await createUserClient();
  const { data: requests } = await supabase
    .from('contact_requests')
    .select('id, name, email, phone, company_name, message, status, created_at')
    .order('created_at', { ascending: false });

  return (
    <main className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold">Contact requests</h1>
      {(requests ?? []).length === 0 ? (
        <p className="text-muted-foreground">Nothing yet.</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {(requests ?? []).map((r) => (
            <li key={r.id} className="rounded-md border p-3">
              <p className="font-medium">
                {r.name} — {r.email} {r.phone ? `— ${r.phone}` : ''}
              </p>
              {r.company_name ? <p className="text-sm">{r.company_name}</p> : null}
              {r.message ? <p className="mt-1 text-sm text-muted-foreground">{r.message}</p> : null}
              <p className="mt-1 text-xs text-muted-foreground">{r.status}</p>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
