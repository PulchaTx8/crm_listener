import { getTranslations } from 'next-intl/server';
import { createUserClient } from '@/lib/supabase/user-client';
import { logger } from '@/lib/logger';
import { PageHeader } from '@/components/layout/app-shell';
import { Card, CardContent } from '@/components/ui/card';

// Renders from the caller's session cookies, so it can never be static. Stated
// explicitly rather than inferred from cookies(): the Supabase client is built
// before cookies() is reached, so during a build with no configuration this page
// would fail as a prerender error instead of being skipped as dynamic.
export const dynamic = 'force-dynamic';

/**
 * Where a signed-in member lands. Business features arrive in Block 2; what
 * matters here is that every reachable Company still appears, suspended or
 * not — companies_select_org_member (0006, corrected by 0021 to scope by
 * actual per-Company access rather than blanket Organization membership)
 * allows reading metadata regardless of status precisely so the customer sees
 * why access stopped instead of an empty screen (spec §4). Block 1c is what
 * makes this list ever have more than one row: an Organization can now hold
 * several Companies, added from the platform console, and this is how a
 * member first discovers they were granted a role in one — this page reads
 * `companies` directly (not the Team screen's list_manageable_companies),
 * since "which Stations can I reach" and "which Stations can I administer"
 * are different questions with different answers for a non-owner.
 *
 * The admin link lives in the sidebar now, so this page no longer resolves
 * is_platform_admin itself.
 */
export default async function MemberHomePage() {
  const t = await getTranslations('app');
  const supabase = await createUserClient();

  const { data: companies, error: companiesError } = await supabase
    .from('companies')
    .select('id, name, status, timezone')
    .is('deleted_at', null)
    .order('name', { ascending: true });

  if (companiesError) logger.error({ err: companiesError }, 'could not load stations');

  const list = companies ?? [];

  return (
    <>
      <PageHeader
        title={t('yourStations')}
        description={t('yourStationsDescription')}
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
                <span className="text-sm text-muted-foreground">{c.timezone}</span>
                {c.status === 'suspended' ? (
                  <p className="text-sm text-muted-foreground">
                    Suspended — no data is available while the subscription is inactive.
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
