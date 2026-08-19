'use client';

import { useTranslations } from 'next-intl';
import { useActionState, useEffect, useId, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/input';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { cancelCampaignAction, type CancelCampaignState } from './actions';

const INITIAL_CANCEL: CancelCampaignState = { status: 'idle' };

/** How many columns the empty-state row has to span. */
const COLUMN_COUNT = 13;

type Translator = (key: string, values?: Record<string, string>) => string;

export type CampaignStatus = 'queued' | 'running' | 'sent' | 'failed' | 'cancelled';

/** One row of the grid, which is also the history -- Task 7's own step 4: one table, ordered by something total. */
export interface CampaignGridRow {
  id: string;
  companyId: string;
  companyName: string;
  status: CampaignStatus;
  /** Null when the list has since been archived, or (rarer) this row's own snapshot could not be read -- see listCampaigns' own header (services/campaigns.ts). Never a fabricated name. */
  listName: string | null;
  channel: 'WHATSAPP' | 'EMAIL';
  /** Null when this caller holds messaging.view but not templates.view (0110's own select policy) -- listCampaigns' own header explains why. */
  templateName: string | null;
  totalRecipients: number;
  sentCount: number;
  failedCount: number;
  suppressedCount: number;
  createdByName: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  /** Whether this caller holds messaging.send at THIS row's own Station -- see page.tsx's own comment for why this cannot be one flag for the whole grid. */
  canCancel: boolean;
}

const STATUS_LABEL_KEYS: Record<CampaignStatus, string> = {
  queued: 'campaignStatusQueued',
  running: 'campaignStatusRunning',
  sent: 'campaignStatusSent',
  failed: 'campaignStatusFailed',
  cancelled: 'campaignStatusCancelled',
};

/**
 * `toLocaleString()`, the same shape the Reports screen's own history table
 * uses for its own timestamps (runs-table.tsx) -- no locale threaded through,
 * the browser's own is what renders.
 */
function formatDateTime(value: string | null): string {
  return value ? new Date(value).toLocaleString() : '—';
}

/**
 * The history grid (Task 7, Step 4). Every campaign this caller's
 * `messaging.view` reaches, across every Station -- page.tsx's own comment
 * explains why this is not narrowed to one Station, the same reasoning
 * ListsGrid gives for its own read.
 *
 * ORDERED `created_at desc, id desc` BY listCampaigns ITSELF (services/campaigns.ts),
 * A TOTAL ORDER -- both columns are `not null`, so this grid cannot render
 * the way `listTemplates`' own marketing half once did, ordered by a column
 * (`purpose`) that was null on every row it could return (whole-branch
 * review finding this project has already paid for once, restated in
 * listCampaigns' own header).
 *
 * Cancel is the only per-row action, gated on `canCancel` (messaging.send at
 * THIS row's own Station) AND on the campaign's own status -- a finished or
 * already-cancelled campaign has nothing left to stop, the same refusal
 * `cancel_campaign` (0243) itself raises as 22023 if this screen let the
 * click through anyway.
 */
export function CampaignsGrid({ rows }: { rows: CampaignGridRow[] }) {
  const t = useTranslations('templates');
  const [cancelling, setCancelling] = useState<CampaignGridRow | null>(null);

  return (
    <div className="overflow-x-auto rounded-lg border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t('campaignStatusColumnLabel')}</TableHead>
            <TableHead>{t('stationColumnLabel')}</TableHead>
            <TableHead>{t('campaignListColumnLabel')}</TableHead>
            <TableHead>{t('channelLabel')}</TableHead>
            <TableHead>{t('campaignTemplateColumnLabel')}</TableHead>
            <TableHead>{t('campaignTotalColumnLabel')}</TableHead>
            <TableHead>{t('campaignSentColumnLabel')}</TableHead>
            <TableHead>{t('campaignFailedColumnLabel')}</TableHead>
            <TableHead>{t('campaignSuppressedColumnLabel')}</TableHead>
            <TableHead>{t('campaignCreatedByColumnLabel')}</TableHead>
            <TableHead>{t('campaignStartedColumnLabel')}</TableHead>
            <TableHead>{t('campaignFinishedColumnLabel')}</TableHead>
            <TableHead className="sticky right-0 bg-background text-right">{t('actions')}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.length === 0 ? (
            <TableRow>
              <TableCell colSpan={COLUMN_COUNT} className="text-sm text-muted-foreground">
                {t('noCampaignsYet')}
              </TableCell>
            </TableRow>
          ) : (
            rows.map((row) => {
              const canCancelNow = row.canCancel && (row.status === 'queued' || row.status === 'running');
              return (
                <TableRow key={row.id} data-testid="campaign-row">
                  <TableCell>{t(STATUS_LABEL_KEYS[row.status])}</TableCell>
                  <TableCell>{row.companyName}</TableCell>
                  <TableCell>{row.listName ?? '—'}</TableCell>
                  <TableCell>{row.channel === 'WHATSAPP' ? t('channelWhatsapp') : t('channelEmail')}</TableCell>
                  <TableCell>{row.templateName ?? '—'}</TableCell>
                  <TableCell>{row.totalRecipients.toLocaleString()}</TableCell>
                  <TableCell>{row.sentCount.toLocaleString()}</TableCell>
                  <TableCell>{row.failedCount.toLocaleString()}</TableCell>
                  <TableCell>{row.suppressedCount.toLocaleString()}</TableCell>
                  <TableCell>{row.createdByName ?? '—'}</TableCell>
                  <TableCell>{formatDateTime(row.startedAt)}</TableCell>
                  <TableCell>{formatDateTime(row.finishedAt)}</TableCell>
                  <TableCell className="sticky right-0 bg-background text-right">
                    {canCancelNow && (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        key="cancel-campaign"
                        onClick={() => setCancelling(row)}
                        data-testid="campaign-cancel-open"
                      >
                        {t('cancelCampaignButton')}
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              );
            })
          )}
        </TableBody>
      </Table>

      {cancelling && (
        <CancelCampaignDialog campaign={cancelling} onClose={() => setCancelling(null)} t={t} />
      )}
    </div>
  );
}

/**
 * The confirmation dialog for a running or queued campaign's Cancel button
 * (`canCancelNow` in the grid above). Repeats the list name and when the
 * campaign started -- both already visible in the row the operator just
 * clicked, but a dialog that names what it is about to stop is safer than
 * one that trusts the operator to remember which row they clicked.
 */
function CancelCampaignDialog({
  campaign,
  onClose,
  t,
}: {
  campaign: CampaignGridRow;
  onClose: () => void;
  t: Translator;
}) {
  const titleId = useId();
  const formId = useId();
  const [state, action, pending] = useActionState(cancelCampaignAction, INITIAL_CANCEL);

  useEffect(() => {
    if (state.status === 'cancelled') onClose();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  return (
    <Dialog open onClose={onClose} labelledBy={titleId} className="max-w-lg">
      <DialogHeader>
        <DialogTitle id={titleId}>{t('cancelThisCampaign')}</DialogTitle>
      </DialogHeader>
      <DialogBody>
        <dl className="mb-3 grid grid-cols-2 gap-x-4 gap-y-1 text-sm text-muted-foreground">
          <dt>{t('campaignListColumnLabel')}</dt>
          <dd>{campaign.listName ?? '—'}</dd>
          <dt>{t('campaignStartedColumnLabel')}</dt>
          <dd>{formatDateTime(campaign.startedAt)}</dd>
        </dl>
        <p className="text-sm">{t('cancelCampaignWarning')}</p>
        <form id={formId} action={action} className="mt-3">
          <input type="hidden" name="campaignId" value={campaign.id} />
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-muted-foreground">{t('cancelCampaignReasonLabel')}</span>
            <Textarea name="reason" maxLength={500} rows={3} />
          </label>
        </form>
        {state.status === 'error' && <p className="mt-3 text-sm text-destructive">{state.message}</p>}
      </DialogBody>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose} key="close">
          {t('cancel')}
        </Button>
        <Button
          type="submit"
          form={formId}
          disabled={pending}
          key="confirm"
          data-testid="campaign-cancel-confirm"
        >
          {pending ? t('saving') : t('cancelCampaignButton')}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
