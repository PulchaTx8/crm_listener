import { getTranslations } from 'next-intl/server';
import { createUserClient } from '@/lib/supabase/user-client';
import { PageHeader } from '@/components/layout/app-shell';
import { Card, CardContent } from '@/components/ui/card';

// Renders from the caller's session cookies, so it can never be static. Stated
// explicitly rather than inferred from cookies(): the Supabase client is built
// before cookies() is reached, so during a build with no configuration this page
// would fail as a prerender error instead of being skipped as dynamic.
export const dynamic = 'force-dynamic';

/**
 * Where a statutory deletion request is worked.
 *
 * READ THROUGH THE CALLER'S OWN SESSION (createUserClient), not the service
 * client -- so `data_deletion_requests_select_admin` from 0188 is what decides
 * whether anything comes back. An authenticated caller who is not a platform
 * admin holds the SELECT grant and still reads zero rows, because
 * is_platform_admin() is what the USING clause tests. The service client would
 * bypass that policy and make this screen its own authorisation, which is the
 * shape contact-requests deliberately does not use either.
 *
 * IT ERASES NOTHING. Neither does the form that fills it. The erasure is a
 * platform admin's own procedure, run by hand after identity is confirmed; this
 * screen exists so that the request is a queue somebody works rather than an
 * e-mail somebody may have read.
 */
export default async function DataDeletionRequestsPage() {
  const t = await getTranslations('admin');
  const supabase = await createUserClient();
  const { data: requests } = await supabase
    .from('data_deletion_requests')
    .select('id, protocol, name, email, phone, company_name, message, status, created_at')
    .order('created_at', { ascending: false });

  return (
    <>
      <PageHeader
        title={t('deletionRequests')}
        description={t('deletionRequestsDescription')}
      />

      {(requests ?? []).length === 0 ? (
        <Card>
          <CardContent className="pt-6">
            <p className="text-sm text-muted-foreground">{t('nothingYet')}</p>
          </CardContent>
        </Card>
      ) : (
        <div className="flex flex-col gap-3">
          {(requests ?? []).map((r) => (
            <Card key={r.id} data-testid="deletion-request-row">
              <CardContent className="flex flex-col gap-1 pt-6">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  {/* The protocol first and in a monospaced face: it is what the
                      requester quotes on the telephone, so it is what an
                      operator scans this list for. */}
                  <p className="font-mono text-sm font-semibold tracking-widest">{r.protocol}</p>
                  <span className="rounded-full bg-muted px-2.5 py-0.5 text-xs font-medium text-muted-foreground">
                    {r.status}
                  </span>
                </div>
                <p className="font-medium">
                  {r.name} — {r.email} — {r.phone}
                </p>
                {r.company_name ? <p className="text-sm">{r.company_name}</p> : null}
                {r.message ? (
                  <p className="mt-1 text-sm text-muted-foreground">{r.message}</p>
                ) : null}
                <p className="text-xs text-muted-foreground">
                  {new Date(r.created_at).toLocaleDateString('en-GB')}
                </p>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </>
  );
}
