import { getTranslations } from 'next-intl/server';
import { createUserClient } from '@/lib/supabase/user-client';
import { PageHeader } from '@/components/layout/app-shell';
import { Card, CardContent } from '@/components/ui/card';

// Renders from the caller's session cookies, so it can never be static. Stated
// explicitly rather than inferred from cookies(): the Supabase client is built
// before cookies() is reached, so during a build with no configuration this page
// would fail as a prerender error instead of being skipped as dynamic.
export const dynamic = 'force-dynamic';

export default async function ContactRequestsPage() {
  const t = await getTranslations('admin');
  const supabase = await createUserClient();
  const { data: requests } = await supabase
    .from('contact_requests')
    .select('id, name, email, phone, company_name, message, status, created_at')
    .order('created_at', { ascending: false });

  return (
    <>
      <PageHeader title={t('contactRequests')} description={t('contactRequestsDescription')} />

      {(requests ?? []).length === 0 ? (
        <Card>
          <CardContent className="pt-6">
            <p className="text-sm text-muted-foreground">{t('nothingYet')}</p>
          </CardContent>
        </Card>
      ) : (
        <div className="flex flex-col gap-3">
          {(requests ?? []).map((r) => (
            <Card key={r.id}>
              <CardContent className="flex flex-col gap-1 pt-6">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="font-medium">
                    {r.name} — {r.email} {r.phone ? `— ${r.phone}` : ''}
                  </p>
                  <span className="rounded-full bg-muted px-2.5 py-0.5 text-xs font-medium text-muted-foreground">
                    {r.status}
                  </span>
                </div>
                {r.company_name ? <p className="text-sm">{r.company_name}</p> : null}
                {r.message ? (
                  <p className="mt-1 text-sm text-muted-foreground">{r.message}</p>
                ) : null}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </>
  );
}
