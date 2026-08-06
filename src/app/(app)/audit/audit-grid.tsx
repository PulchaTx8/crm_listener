import { getTranslations } from 'next-intl/server';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { actionLabel, actorLabel } from '@/lib/audit/labels';
import type { AuditRow } from '@/schemas/audit';

/**
 * Block 10a. The trail, one page of it.
 *
 * `detail` renders as formatted JSON inside a `<details>`, never summarised.
 * Nine blocks wrote into that column with forty different shapes and Block 11
 * will write more; a renderer per shape would show nothing for the shapes it
 * does not know, which in an audit viewer is indistinguishable from an event
 * that carried no detail.
 *
 * `<details>` rather than a dialog or a tooltip because it survives being
 * printed, copied and read by a screen reader without any JavaScript at all —
 * this is the screen somebody opens when they are trying to establish what
 * happened, and it should not depend on a hydration succeeding.
 */
export async function AuditGrid({ rows }: { rows: AuditRow[] }) {
  const t = await getTranslations('audit');
  if (rows.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        {t('noAuditEntriesMatchTheseFilters')}{' '}
        <code>{t('auditView')}</code> {t('inNoOrganizationSeesThisToo')}</p>
    );
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>{t('when')}</TableHead>
          <TableHead>{t('who')}</TableHead>
          <TableHead>{t('what')}</TableHead>
          <TableHead>{t('target')}</TableHead>
          <TableHead>{t('station')}</TableHead>
          <TableHead>{t('detail')}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={row.id}>
            <TableCell className="whitespace-nowrap">
              {new Date(row.created_at).toLocaleString()}
            </TableCell>
            <TableCell>{actorLabel(row)}</TableCell>
            <TableCell>
              {actionLabel(row.action)}
              {row.succeeded ? null : (
                <span className="ml-2 rounded bg-destructive/10 px-1.5 py-0.5 text-xs text-destructive">
                  {t('failed2')}</span>
              )}
            </TableCell>
            <TableCell className="text-xs text-muted-foreground">
              {row.target_table ?? '—'}
              {row.target_id ? <span className="block">{row.target_id}</span> : null}
            </TableCell>
            <TableCell>{row.company_name ?? '—'}</TableCell>
            <TableCell>
              {row.detail && Object.keys(row.detail as object).length > 0 ? (
                <details>
                  <summary className="cursor-pointer text-xs text-muted-foreground">
                    {t('show')}</summary>
                  <pre className="mt-1 max-w-md overflow-x-auto rounded bg-muted p-2 text-xs">
                    {JSON.stringify(row.detail, null, 2)}
                  </pre>
                </details>
              ) : (
                <span className="text-xs text-muted-foreground">—</span>
              )}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
