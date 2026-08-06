'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { isPanelType, REPORT_TYPE_LABELS, type ReportFormat, type ReportType } from '@/lib/reports/types';
import { requestReportAction } from '@/app/(app)/reports/actions';

/**
 * Block 8b. One component, mounted eight times.
 *
 * IT ASKS FOR THE FORMAT AND NOTHING ELSE. The filters arrive as a prop from
 * the screen the operator was already looking at, because they have already
 * expressed the question by filtering -- asking them to express it again, in a
 * second vocabulary, is how the dialog and the screen come to disagree about
 * what was exported.
 */
export function ExportDialog({
  reportType,
  companyIds,
  filters,
  disabled,
}: {
  reportType: ReportType;
  companyIds: string[];
  /**
   * `object`, not `Record<string, unknown>`: the eight mount sites hand this
   * their own filter INTERFACES (PeriodSelection, the listing param types), and
   * an interface has no index signature, so the narrower type would force a
   * cast at every one of them. Nothing is lost by widening -- this value is
   * serialised and then parsed by `reportRequestSchema.strict()` on the server,
   * which is where the shape is actually decided, and where a wrong one is
   * refused rather than silently carried.
   */
  filters: object;
  disabled?: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  // One per mount: eight of these can exist on one route tree, and a fixed id
  // would point every dialog's aria-labelledby at the first one's title.
  const titleId = `export-dialog-${reportType.toLowerCase()}`;

  const panel = isPanelType(reportType);
  // A panel renders to PDF and a listing to a spreadsheet. 0122 enforces the
  // same pairing with a CHECK; this is what stops the operator reaching it.
  const formats: ReportFormat[] = panel ? ['PDF'] : ['XLSX', 'CSV'];

  async function submit(format: ReportFormat) {
    setError(null);
    const data = new FormData();
    data.set('reportType', reportType);
    data.set('format', format);
    // No organizationId: the action derives it from these ids, through the
    // caller's own client. A value the client sends is a value the server has
    // to distrust anyway.
    data.set('companyIds', companyIds.join(','));
    data.set('filters', JSON.stringify(filters));

    const result = await requestReportAction(data);
    if (!result.ok) {
      setError(result.error ?? 'The report could not be queued.');
      return;
    }
    setOpen(false);
    startTransition(() => router.push('/reports'));
  }

  return (
    <>
      <Button type="button" variant="outline" size="sm" disabled={disabled} onClick={() => setOpen(true)}>
        Export
      </Button>

      <Dialog open={open} onClose={() => setOpen(false)} labelledBy={titleId}>
        <DialogHeader>
          <DialogTitle id={titleId}>Export {REPORT_TYPE_LABELS[reportType]}</DialogTitle>
        </DialogHeader>
        <DialogBody>
          <p className="text-sm text-muted-foreground">
            The filters currently on this screen are the filters of the file. It is generated in
            the background and appears under <strong>My reports</strong> when it is ready.
          </p>
          {error ? (
            <p role="alert" className="mt-3 text-sm text-destructive">
              {error}
            </p>
          ) : null}
        </DialogBody>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => setOpen(false)} disabled={pending}>
            Cancel
          </Button>
          {formats.map((format) => (
            <Button key={format} type="button" disabled={pending} onClick={() => submit(format)}>
              {format}
            </Button>
          ))}
        </DialogFooter>
      </Dialog>
    </>
  );
}
