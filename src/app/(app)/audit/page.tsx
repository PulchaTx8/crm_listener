import { getTranslations } from 'next-intl/server';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import type { Route } from 'next';
import { createUserClient } from '@/lib/supabase/user-client';
import { logger } from '@/lib/logger';
import { PageHeader } from '@/components/layout/app-shell';
import { Card, CardContent } from '@/components/ui/card';
import { listAuditLogs } from '@/services/audit';
import type { AuditPage } from '@/services/audit';
import { AuditGrid } from './audit-grid';
import { AuditFilters } from './audit-filters';
import {
  auditHref,
  parseAuditCursor,
  parseAuditListState,
  type AuditSearchParams,
} from './list-params';

// Renders from the caller's session and the policies on audit_logs, so it can
// never be static.
export const dynamic = 'force-dynamic';

/**
 * Block 10a. The Organization's record of itself.
 *
 * NO PERMISSION GATE AT THE TOP, and unlike `/reports` — where the same is true
 * because a caller only ever sees their own runs — here it is true for a
 * sharper reason: `list_audit_logs` is `SECURITY INVOKER`, so `audit_logs`'
 * own two policies decide every row. A caller holding `audit.view` nowhere gets
 * an empty page, which is the correct answer and not an error, and adding a
 * redirect here would be this codebase's usual courtesy rather than a boundary.
 *
 * The courtesy is skipped deliberately: an empty audit trail with a sentence
 * explaining why is more useful to somebody who expected to see something than
 * a silent bounce to /app.
 */
export default async function AuditPage({
  searchParams,
}: {
  searchParams: Promise<AuditSearchParams>;
}) {
  const t = await getTranslations('audit');
  const params = await searchParams;
  const state = parseAuditListState(params);
  const cursor = parseAuditCursor(params);

  const supabase = await createUserClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  let page: AuditPage;
  try {
    page = await listAuditLogs(state, cursor);
  } catch (cause) {
    logger.error({ err: cause }, 'could not load the audit trail');
    return (
      <>
        <PageHeader title={t('auditTrail')} />
        <Card>
          <CardContent className="pt-6">
            <p className="text-sm text-muted-foreground">
              {t('theAuditTrailCouldNotBe')}</p>
          </CardContent>
        </Card>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title={t('auditTrail')}
        description="What has been done in this Organization, by whom, and when. Filtered by what you may read."
      />

      <Card className="mb-4">
        <CardContent className="pt-6">
          <AuditFilters state={state} />
        </CardContent>
      </Card>

      <Card>
        <CardContent className="pt-6">
          <AuditGrid rows={page.rows} />

          <div className="mt-4 flex items-center justify-between text-sm text-muted-foreground">
            <span>
              {page.totalCount} {page.totalCount === 1 ? 'entry' : 'entries'}
            </span>
            {page.nextCursor ? (
              <Link
                href={auditHref(state, page.nextCursor) as Route}
                className="underline underline-offset-4"
              >
                {t('olderEntries')}</Link>
            ) : null}
          </div>
        </CardContent>
      </Card>
    </>
  );
}
