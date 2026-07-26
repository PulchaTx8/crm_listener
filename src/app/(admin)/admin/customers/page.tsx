import { createUserClient } from '@/lib/supabase/user-client';
import { Button } from '@/components/ui/button';
import { suspendAction, reactivateAction } from './actions';
import { ProvisionForm, RegenerateForm } from './credential-forms';

export default async function CustomersPage() {
  const supabase = await createUserClient();

  const { data: companies } = await supabase
    .from('companies')
    .select('id, name, status, suspension_reason, created_at')
    .order('created_at', { ascending: false });

  // The owner of each Company, so a provisional password can be reissued
  // without hunting for the user by hand. Readable here because the
  // company_memberships policy admits platform admins.
  const { data: owners } = await supabase
    .from('company_memberships')
    .select('company_id, user_id, role, profiles:user_id (email)')
    .eq('role', 'owner');

  type OwnerRow = { company_id: string; user_id: string; profiles: { email: string } | null };
  const ownerByCompany = new Map<string, { userId: string; email: string }>();
  for (const row of (owners ?? []) as unknown as OwnerRow[]) {
    ownerByCompany.set(row.company_id, {
      userId: row.user_id,
      email: row.profiles?.email ?? '',
    });
  }

  return (
    <main className="flex flex-col gap-10">
      <section className="flex flex-col gap-4">
        <h1 className="text-2xl font-semibold">Provision a customer</h1>
        <ProvisionForm />
      </section>

      <section className="flex flex-col gap-4">
        <h2 className="text-xl font-semibold">Companies</h2>
        {(companies ?? []).length === 0 ? (
          <p className="text-muted-foreground">No company provisioned yet.</p>
        ) : (
          <ul className="flex flex-col gap-3">
            {(companies ?? []).map((c) => {
              const owner = ownerByCompany.get(c.id);
              return (
                <li key={c.id} className="flex flex-col gap-3 rounded-md border p-4">
                  <div className="flex items-center justify-between gap-4">
                    <span>
                      {c.name} — <em>{c.status}</em>
                      {c.suspension_reason ? (
                        <span className="text-muted-foreground"> ({c.suspension_reason})</span>
                      ) : null}
                    </span>
                    {c.status === 'active' ? (
                      <form action={suspendAction} className="flex items-center gap-2">
                        <input type="hidden" name="companyId" value={c.id} />
                        <input
                          name="reason"
                          placeholder="Reason"
                          className="rounded border p-1 text-sm"
                        />
                        <Button type="submit" variant="outline">
                          Suspend
                        </Button>
                      </form>
                    ) : (
                      <form action={reactivateAction}>
                        <input type="hidden" name="companyId" value={c.id} />
                        <Button type="submit" variant="outline">
                          Reactivate
                        </Button>
                      </form>
                    )}
                  </div>
                  {owner ? (
                    <div className="flex items-center justify-between gap-4 border-t pt-3">
                      <span className="text-sm text-muted-foreground">Owner: {owner.email}</span>
                      <RegenerateForm userId={owner.userId} email={owner.email} />
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </main>
  );
}
