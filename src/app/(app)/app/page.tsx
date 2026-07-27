import { createUserClient } from '@/lib/supabase/user-client';
import { PageHeader } from '@/components/layout/app-shell';
import { Card, CardContent } from '@/components/ui/card';

// Renders from the caller's session cookies, so it can never be static. Stated
// explicitly rather than inferred from cookies(): the Supabase client is built
// before cookies() is reached, so during a build with no configuration this page
// would fail as a prerender error instead of being skipped as dynamic.
export const dynamic = 'force-dynamic';

/**
 * Where a signed-in member lands. Business features arrive in Block 2; what
 * matters here is that a suspended Company still appears, with its reason —
 * companies metadata is visible to org members regardless of status precisely
 * so the customer sees why access stopped instead of an empty screen (spec §4).
 *
 * The admin link lives in the sidebar now, so this page no longer resolves
 * is_platform_admin itself.
 */
export default async function MemberHomePage() {
  const supabase = await createUserClient();

  const { data: companies } = await supabase
    .from('companies')
    .select('id, name, status, suspension_reason')
    .order('name', { ascending: true });

  const list = companies ?? [];

  return (
    <>
      <PageHeader
        title="Your stations"
        description="Audience, prize and promotion features arrive in the next release."
      />

      {list.length === 0 ? (
        <Card>
          <CardContent className="pt-6">
            <p className="text-sm text-muted-foreground">
              No station is linked to your account yet. Please contact us.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {list.map((c) => (
            <Card key={c.id} data-testid="station-card">
              <CardContent className="flex flex-col gap-3 pt-6">
                <div className="flex items-start justify-between gap-3">
                  <span className="font-medium">{c.name}</span>
                  <span
                    className={
                      c.status === 'active'
                        ? 'rounded-full bg-primary/10 px-2.5 py-0.5 text-xs font-medium text-primary'
                        : 'rounded-full bg-destructive/10 px-2.5 py-0.5 text-xs font-medium text-destructive'
                    }
                  >
                    {c.status}
                  </span>
                </div>
                {c.status === 'suspended' ? (
                  <p className="text-sm text-muted-foreground">
                    Your subscription is suspended
                    {c.suspension_reason ? `: ${c.suspension_reason}` : ''}. Contact us to restore
                    access.
                  </p>
                ) : null}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </>
  );
}
