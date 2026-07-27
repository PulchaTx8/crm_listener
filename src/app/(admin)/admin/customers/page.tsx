import { createUserClient } from '@/lib/supabase/user-client';
import { logger } from '@/lib/logger';
import { Button } from '@/components/ui/button';
import { suspendAction, reactivateAction } from './actions';
import { ProvisionForm, RegenerateForm } from './credential-forms';

// Renders from the caller's session cookies, so it can never be static. Stated
// explicitly rather than inferred from cookies(): the Supabase client is built
// before cookies() is reached, so during a build with no configuration this page
// would fail as a prerender error instead of being skipped as dynamic.
export const dynamic = 'force-dynamic';

export default async function CustomersPage() {
  const supabase = await createUserClient();

  const { data: companies } = await supabase
    .from('companies')
    .select('id, name, status, suspension_reason, created_at')
    .order('created_at', { ascending: false });

  // The owner of each Company, so a provisional password can be reissued
  // without hunting for the user by hand. Both reads are permitted here because
  // the company_memberships and profiles policies admit platform admins.
  //
  // Two queries joined in JS rather than one PostgREST embed: resource
  // embedding needs a foreign key between the two tables, and there is none.
  // company_memberships.user_id and profiles.id both reference auth.users(id),
  // which does not give PostgREST a path from one to the other — the embed
  // fails with PGRST200 and returns no rows at all.
  const { data: owners, error: ownersError } = await supabase
    .from('company_memberships')
    .select('company_id, user_id')
    .eq('role', 'owner');

  if (ownersError) logger.error({ err: ownersError }, 'could not load company owners');

  const ownerUserIds = [...new Set((owners ?? []).map((o) => o.user_id))];

  const { data: ownerProfiles, error: profilesError } = ownerUserIds.length
    ? await supabase.from('profiles').select('id, email').in('id', ownerUserIds)
    : { data: [], error: null };

  if (profilesError) logger.error({ err: profilesError }, 'could not load owner profiles');

  const emailByUser = new Map((ownerProfiles ?? []).map((p) => [p.id, p.email]));

  const ownerByCompany = new Map<string, { userId: string; email: string }>();
  for (const row of owners ?? []) {
    ownerByCompany.set(row.company_id, {
      userId: row.user_id,
      email: emailByUser.get(row.user_id) ?? '',
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
