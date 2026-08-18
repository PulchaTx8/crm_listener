'use client';

import { useTranslations } from 'next-intl';
import { useActionState, useEffect, useId, useState } from 'react';
import { MoreVertical, Pencil } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuItem } from '@/components/ui/dropdown-menu';
import { Select } from '@/components/ui/input';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import type { RegisteredTemplate } from '@/services/templates';
import { formatInstant } from '../../promotions/format';
import { archiveTemplateAction, type ArchiveTemplateState } from './actions';
import { TemplateDialog } from './template-dialog';

const INITIAL_ARCHIVE: ArchiveTemplateState = { status: 'idle' };

/** Green for the channel that already existed (WhatsApp), primary for the one this block adds — no meaning beyond telling the two apart at a glance. */
const CHANNEL_BADGE_CLASSES: Record<'WHATSAPP' | 'EMAIL', string> = {
  WHATSAPP: 'bg-success/10 text-success',
  EMAIL: 'bg-primary/10 text-primary',
};

/** How many columns the empty-state row has to span, Actions included. */
const COLUMN_COUNT = 5;

/**
 * Every marketing template this Station holds, in one table — never
 * paginated (design D6: the whole list is in hand), which is what makes the
 * channel filter below a client-side `.filter()` over `templates` rather than
 * a navigation the way `songs-filters.tsx`'s own filters are. The system half
 * (`TemplateRegistry`) renders a card per fixed purpose because a purpose can
 * exist unregistered; a marketing template has no such slot to fill when
 * absent, so this is an ordinary table with a create button instead.
 */
export function MarketingGrid({
  templates,
  companyId,
  timeZone,
  manage,
}: {
  templates: RegisteredTemplate[];
  companyId: string;
  /** The Station's own zone — `updatedAt` renders there, never the reader's (spec L2, same rule `template-registry.tsx` follows). */
  timeZone: string;
  /** Whether the caller holds templates.manage at this Station. */
  manage: boolean;
}) {
  const t = useTranslations('templates');

  /**
   * A controlled `<select>`, deliberately, over the CHECKBOX shape this
   * project has already shipped as a defect: `members-filters.tsx`'s own
   * header records that a box whose `checked` is derived from state the
   * click itself is about to change unticks itself, because the click's own
   * render restores the old value before anything else runs. A `<select>` is
   * safe from that — this state is client-only and the value that was just
   * chosen is what the next render reads back — so this filter is exactly
   * the shape that comment warns the NEXT one added beside it should keep.
   */
  const [channelFilter, setChannelFilter] = useState<'' | 'WHATSAPP' | 'EMAIL'>('');
  const [editing, setEditing] = useState<'new' | RegisteredTemplate | null>(null);
  const [archiving, setArchiving] = useState<RegisteredTemplate | null>(null);

  const rows =
    channelFilter === '' ? templates : templates.filter((row) => row.channel === channelFilter);

  return (
    <>
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <label className="flex w-56 flex-col gap-1 text-sm">
          <span className="text-muted-foreground">{t('channelLabel')}</span>
          <Select
            value={channelFilter}
            onChange={(e) => setChannelFilter(e.target.value as '' | 'WHATSAPP' | 'EMAIL')}
            data-testid="marketing-channel-filter"
          >
            <option value="">{t('anyChannel')}</option>
            <option value="EMAIL">{t('channelEmail')}</option>
            <option value="WHATSAPP">{t('channelWhatsapp')}</option>
          </Select>
        </label>

        {manage && (
          <Button type="button" onClick={() => setEditing('new')} data-testid="marketing-template-create">
            {t('newTemplateButton')}
          </Button>
        )}
      </div>

      <div className="rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('internalNameLabel')}</TableHead>
              <TableHead>{t('channelLabel')}</TableHead>
              <TableHead>{t('descriptionLabel')}</TableHead>
              <TableHead>{t('lastUpdated')}</TableHead>
              <TableHead className="sticky right-0 bg-background text-right">{t('actions')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={COLUMN_COUNT} className="text-sm text-muted-foreground">
                  {t('noMarketingTemplatesYet')}
                </TableCell>
              </TableRow>
            ) : (
              rows.map((row) => (
                <TableRow key={row.id} data-testid="marketing-template-row">
                  <TableCell className="font-medium">
                    {manage ? (
                      <button
                        type="button"
                        onClick={() => setEditing(row)}
                        className="text-left ring-offset-background hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                      >
                        {row.internalName}
                      </button>
                    ) : (
                      row.internalName
                    )}
                  </TableCell>
                  <TableCell>
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs font-medium ${CHANNEL_BADGE_CLASSES[row.channel]}`}
                    >
                      {row.channel === 'EMAIL' ? t('channelEmail') : t('channelWhatsapp')}
                    </span>
                  </TableCell>
                  <TableCell>{row.description ?? '—'}</TableCell>
                  <TableCell>
                    {formatInstant(row.updatedAt, timeZone)}
                    {' · '}
                    {row.updatedByName ?? '—'}
                  </TableCell>
                  <TableCell className="sticky right-0 bg-background">
                    {manage && (
                      <div className="flex items-center justify-end gap-1">
                        <button
                          type="button"
                          aria-label={t('editTemplate', { name: row.internalName })}
                          onClick={() => setEditing(row)}
                          className="rounded-md p-1.5 ring-offset-background hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                        >
                          <Pencil className="size-4" aria-hidden="true" />
                        </button>
                        <DropdownMenu
                          label={t('actionsForTemplate', { name: row.internalName })}
                          trigger={<MoreVertical className="size-4" aria-hidden="true" />}
                        >
                          <DropdownMenuItem destructive onSelect={() => setArchiving(row)}>
                            {t('archiveTemplateButton')}
                          </DropdownMenuItem>
                        </DropdownMenu>
                      </div>
                    )}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {/*
        Only while something is actually being created or edited — never an
        always-mounted dialog with `open` toggling. TemplateDialog's own
        header explains why that split matters: every field in it initialises
        local state from `existing` exactly once, and a fresh mount per
        target is what makes that safe.
      */}
      {manage && editing !== null && (
        <TemplateDialog
          companyId={companyId}
          existing={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
        />
      )}

      {archiving && (
        <ArchiveMarketingTemplateDialog template={archiving} onClose={() => setArchiving(null)} />
      )}
    </>
  );
}

/**
 * The removal confirmation, on the shape `ArchiveTemplateDialog`
 * (template-registry.tsx) and `ArchiveSongDialog` (music/songs/songs-grid.tsx)
 * already establish: a styled `<Dialog>` with a stable `data-testid`, never
 * `window.confirm`. Reuses `archiveTemplateAction` unchanged — `archive_message_template`
 * (0113) resolves the Station from the row itself and does not care whether
 * `purpose` is null, so the same door and the same schema that already serve
 * the system half serve this one.
 */
function ArchiveMarketingTemplateDialog({
  template,
  onClose,
}: {
  template: RegisteredTemplate;
  onClose: () => void;
}) {
  const t = useTranslations('templates');
  const titleId = useId();
  const [state, action, pending] = useActionState(archiveTemplateAction, INITIAL_ARCHIVE);

  useEffect(() => {
    if (state.status === 'archived') onClose();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  return (
    <Dialog open onClose={onClose} labelledBy={titleId} className="max-w-lg">
      <DialogHeader>
        <DialogTitle id={titleId}>{t('archiveThisMarketingTemplate')}</DialogTitle>
      </DialogHeader>
      <DialogBody>
        <p className="text-sm">
          <strong>{template.internalName}</strong>: {t('archiveMarketingTemplateWarning')}
        </p>
        <p className="mt-3 text-sm text-muted-foreground">{t('archiveMarketingTemplateNote')}</p>
        {state.status === 'error' && <p className="mt-3 text-sm text-destructive">{state.message}</p>}
      </DialogBody>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose}>
          {t('cancel')}
        </Button>
        <form action={action}>
          <input type="hidden" name="templateId" value={template.id} />
          <Button type="submit" disabled={pending} data-testid="marketing-template-archive-confirm">
            {pending ? t('removing') : t('removeAnyway')}
          </Button>
        </form>
      </DialogFooter>
    </Dialog>
  );
}
