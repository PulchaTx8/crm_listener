import { getTranslations } from 'next-intl/server';
import { PageHeader } from '@/components/layout/app-shell';
import { Card, CardContent } from '@/components/ui/card';
import { listMyReportRuns } from '@/services/reports';
import { RunsTable } from './runs-table';

// Renders from the caller's session and RLS, so it can never be static.
export const dynamic = 'force-dynamic';

/**
 * Block 8b. Every report this caller has asked for.
 *
 * NO PERMISSION GUARD AT THE TOP, unlike every other screen in this app, and
 * that is deliberate rather than an omission. This page lists runs, and
 * report_runs' RLS (0122) already limits those to the requester, the
 * Organization's owner and the platform admin -- there is nothing here to hide
 * from somebody whose own list is empty. Every export BUTTON that fills this
 * list is guarded by its own domain's permission, and request_report re-checks
 * it in the database regardless.
 */
export default async function ReportsPage() {
  const t = await getTranslations('reports');
  const runs = await listMyReportRuns();

  return (
    <>
      <PageHeader
        title={t('myReports')}
        description={t('reportsDescription')}
      />
      <Card>
        <CardContent className="pt-6">
          <RunsTable runs={runs} />
        </CardContent>
      </Card>
    </>
  );
}
