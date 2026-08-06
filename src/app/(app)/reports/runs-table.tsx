'use client';

import { useTranslations } from 'next-intl';
import { useEffect, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { REPORT_TYPE_LABELS, type ReportType } from '@/lib/reports/types';
import type { ReportRun } from '@/schemas/reports';
import { downloadReportAction } from './actions';

/**
 * Block 8b. The caller's own runs, and the only place a download link is ever
 * made.
 *
 * THE REFRESH STOPS. A run is QUEUED or RUNNING for at most a few ticks, and an
 * interval that keeps firing afterwards is a page polling a database for ever
 * in a tab somebody left open. The effect re-evaluates whenever the refreshed
 * data arrives, so the moment nothing is pending it clears itself.
 *
 * TanStack Query is not in this project and this does not justify adding it:
 * `router.refresh()` re-renders the server component that already knows how to
 * read these rows.
 */
export function RunsTable({ runs }: { runs: ReportRun[] }) {
  const t = useTranslations('reports');
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  const hasPending = runs.some((run) => run.status === 'QUEUED' || run.status === 'RUNNING');

  useEffect(() => {
    if (!hasPending) return;
    const timer = setInterval(() => {
      startTransition(() => router.refresh());
    }, 3000);
    return () => clearInterval(timer);
  }, [hasPending, router]);

  async function download(runId: string) {
    setError(null);
    setPendingId(runId);
    try {
      const result = await downloadReportAction(runId);
      if (!result.ok || !result.url) {
        setError(result.error ?? 'The download link could not be created.');
        // The row may have expired since the page rendered.
        startTransition(() => router.refresh());
        return;
      }
      // Navigating rather than opening a tab: the URL is single-use in
      // practice and a blocked pop-up would look like a broken button.
      window.location.href = result.url;
    } finally {
      setPendingId(null);
    }
  }

  if (runs.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        {t('noReportsYetUseTheExport')}</p>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t('report')}</TableHead>
            <TableHead>{t('format')}</TableHead>
            <TableHead>{t('requested')}</TableHead>
            <TableHead>{t('rows')}</TableHead>
            <TableHead>{t('status')}</TableHead>
            <TableHead>{t('file')}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {runs.map((run) => (
            <TableRow key={run.id}>
              <TableCell>
                {REPORT_TYPE_LABELS[run.report_type as ReportType] ?? run.report_type}
                {run.withheld.length > 0 ? (
                  <span className="block text-xs text-muted-foreground">
                    {t('withheld')}{' '}{run.withheld.join(', ')}
                  </span>
                ) : null}
              </TableCell>
              <TableCell>{run.format}</TableCell>
              <TableCell>{new Date(run.requested_at).toLocaleString()}</TableCell>
              <TableCell>{run.row_count ?? '—'}</TableCell>
              <TableCell>
                <StatusCell run={run} />
              </TableCell>
              <TableCell>
                {run.status === 'READY' && run.storage_path ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={pendingId === run.id}
                    onClick={() => download(run.id)}
                  >
                    {pendingId === run.id ? t('preparing') : t('download')}
                  </Button>
                ) : run.status === 'READY' ? (
                  // READY with no path is an expired run: the history survives
                  // and the bytes do not (0128). Saying "expired" rather than
                  // hiding the row is the point -- the record of who exported
                  // what is the part that must not disappear.
                  <span className="text-xs text-muted-foreground">{t('expired')}</span>
                ) : (
                  <span className="text-xs text-muted-foreground">—</span>
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function StatusCell({ run }: { run: ReportRun }) {
  const t = useTranslations('reports');
  if (run.status === 'FAILED') {
    return (
      <span className="text-sm text-destructive" title={run.last_error ?? undefined}>
        {t('failed')}{run.last_error ? (
          <span className="block text-xs font-normal">{run.last_error}</span>
        ) : null}
      </span>
    );
  }
  if (run.status === 'QUEUED') return <span className="text-sm">{t('queued')}</span>;
  if (run.status === 'RUNNING') return <span className="text-sm">{t('generating')}</span>;
  return <span className="text-sm">{t('ready')}</span>;
}
