'use client';

import { useTranslations } from 'next-intl';
import { useActionState, useEffect, useId, useState } from 'react';
import { MoreVertical, Pencil } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuItem } from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useRecordDialog } from '@/hooks/use-record-dialog';
import { applyRowPatch, type RowState } from '@/lib/row-patch';
import { ORGANIZATION_TABS, type OrganizationTab } from '@/lib/record-params';
import {
  blockAction,
  unblockAction,
  type OrganizationActionState,
  type OrganizationRow,
  type StationBrief,
} from './actions';
import { ProvisionForm } from './organization-forms';
import { OrganizationRecordDialog } from './organization-record-dialog';

/** How many columns the empty-state row has to span, actions included. */
const COLUMN_COUNT = 5;

const IDLE: OrganizationActionState = { status: 'idle' };

/**
 * The customer groups, and the host for the record dialog over them.
 *
 * NO PAGING, AND THAT IS NOT AN OMISSION. The platform has tens of
 * Organizations, not thousands; the screen that needed a cursor was listing
 * STATIONS across every group at once, and that list is now filtered to one
 * group at a time on a screen of its own. The grid still patches its own rows,
 * so provisioning, saving or blocking redraws a line rather than the screen.
 */
export function OrganizationsGrid({
  initialRows,
  initialRecord,
}: {
  initialRows: OrganizationRow[];
  initialRecord: { recordId: string | null; tab: string | null };
}) {
  const t = useTranslations('admin');
  const [grid, setGrid] = useState<RowState<OrganizationRow>>({
    rows: initialRows,
    total: initialRows.length,
  });

  useEffect(() => {
    setGrid({ rows: initialRows, total: initialRows.length });
  }, [initialRows]);

  const { recordId, tab, open, setTab, close } = useRecordDialog(ORGANIZATION_TABS, initialRecord);
  const [provisioning, setProvisioning] = useState(false);
  const [blocking, setBlocking] = useState<OrganizationRow | null>(null);

  const openRow = recordId ? (grid.rows.find((row) => row.id === recordId) ?? null) : null;

  function patch(row: OrganizationRow) {
    setGrid((current) => applyRowPatch(current, { kind: 'save', row }));
  }

  /**
   * A save reports the group as the database now holds it — but the read-back
   * goes through list_organizations, which does not carry the Stations, so the
   * ones already on screen are kept rather than replaced with an empty list.
   */
  function merge(saved: OrganizationRow) {
    const existing = grid.rows.find((row) => row.id === saved.id);
    patch({ ...saved, stations: existing?.stations ?? saved.stations });
  }

  function appendStation(organizationId: string, station: StationBrief) {
    setGrid((current) => ({
      ...current,
      rows: current.rows.map((row) =>
        row.id === organizationId
          ? { ...row, stations: [...row.stations, station], stationCount: row.stationCount + 1 }
          : row,
      ),
    }));
  }

  return (
    <>
      <div className="flex flex-wrap items-center justify-end gap-3">
        <Button type="button" onClick={() => setProvisioning(true)} data-testid="organization-create">
          {t('provisionCustomer')}
        </Button>
      </div>

      <div className="mt-4 rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('organization')}</TableHead>
              <TableHead>{t('stations')}</TableHead>
              <TableHead>{t('owner')}</TableHead>
              <TableHead>{t('provisioned')}</TableHead>
              <TableHead className="sticky right-0 bg-background text-right">{t('actions')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {grid.rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={COLUMN_COUNT} className="text-sm text-muted-foreground">
                  {t('noCustomerProvisionedYet')}
                </TableCell>
              </TableRow>
            ) : (
              grid.rows.map((row) => (
                <TableRow key={row.id} data-testid="organization-row">
                  <TableCell className="font-medium">
                    <button
                      type="button"
                      onClick={() => open(row.id)}
                      className="text-left ring-offset-background hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                    >
                      {row.name}
                    </button>
                    {row.suspendedAt && (
                      <span className="ml-2 rounded-full bg-destructive/10 px-2.5 py-0.5 text-xs font-medium text-destructive">
                        {t('blocked')}
                        {row.suspensionReason ? ` — ${row.suspensionReason}` : ''}
                      </span>
                    )}
                  </TableCell>
                  <TableCell>{row.stationCount}</TableCell>
                  <TableCell className="text-muted-foreground">{row.owner?.email ?? '—'}</TableCell>
                  <TableCell>{new Date(row.createdAt).toLocaleDateString('en-GB')}</TableCell>
                  <TableCell className="sticky right-0 bg-background">
                    <div className="flex items-center justify-end gap-1">
                      <button
                        type="button"
                        aria-label={`Open ${row.name}`}
                        onClick={() => open(row.id, 'data')}
                        className="rounded-md p-1.5 ring-offset-background hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                      >
                        <Pencil className="size-4" aria-hidden="true" />
                      </button>
                      <DropdownMenu
                        label={t('actionsForCustomer', { name: row.name })}
                        trigger={<MoreVertical className="size-4" aria-hidden="true" />}
                      >
                        <DropdownMenuItem onSelect={() => open(row.id, 'stations')}>
                          {t('addAStation')}
                        </DropdownMenuItem>
                        {row.suspendedAt ? (
                          <DropdownMenuItem onSelect={() => setBlocking(row)}>
                            {t('unblock')}
                          </DropdownMenuItem>
                        ) : (
                          <DropdownMenuItem destructive onSelect={() => setBlocking(row)}>
                            {t('block')}
                          </DropdownMenuItem>
                        )}
                      </DropdownMenu>
                    </div>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      <OrganizationRecordDialog
        open={recordId !== null}
        row={openRow}
        missing={recordId !== null && openRow === null}
        tab={(tab as OrganizationTab) ?? 'data'}
        onTab={setTab}
        onClose={close}
        onSaved={merge}
        onStationAdded={appendStation}
      />

      <ProvisionDialog
        open={provisioning}
        onClose={() => setProvisioning(false)}
        onProvisioned={(row) =>
          setGrid((current) => applyRowPatch(current, { kind: 'create', row: { ...row, stations: [] } }))
        }
      />

      {blocking && (
        <BlockDialog
          row={blocking}
          onCancel={() => setBlocking(null)}
          onChanged={(row) => {
            setBlocking(null);
            patch(row);
          }}
        />
      )}
    </>
  );
}

/**
 * Blocking and releasing share a dialog, and the blocking half states in words
 * what it is about to do — the group AND every Station under it, the owner
 * included.
 *
 * That sentence is not decoration. A platform admin reading "block" beside a
 * group could reasonably expect the staff to lose access and the owner to keep
 * it; 0156 makes that untrue on purpose, and a console that does not say so is a
 * console that surprises somebody in the middle of a billing conversation.
 */
function BlockDialog({
  row,
  onCancel,
  onChanged,
}: {
  row: OrganizationRow;
  onCancel: () => void;
  onChanged: (row: OrganizationRow) => void;
}) {
  const t = useTranslations('admin');
  const titleId = useId();
  const releasing = row.suspendedAt !== null;
  const [state, action, pending] = useActionState(releasing ? unblockAction : blockAction, IDLE);
  const [reason, setReason] = useState('');

  useEffect(() => {
    if (state.status !== 'done') return;
    onChanged({
      ...row,
      // The RPC stamps its own now(); this is the row redrawn, not the record
      // read back, and the only thing the screen shows about it is whether it is
      // set. The next navigation replaces it with the database's own value.
      suspendedAt: releasing ? null : new Date().toISOString(),
      suspensionReason: releasing ? null : reason.trim(),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  return (
    <Dialog open onClose={onCancel} labelledBy={titleId} className="max-w-lg">
      <DialogHeader>
        <DialogTitle id={titleId}>
          {releasing ? t('releaseThisCustomer') : t('blockThisCustomer')}
        </DialogTitle>
      </DialogHeader>
      <DialogBody>
        <p className="text-sm">
          {releasing ? (
            <>
              <strong>{row.name}</strong> {t('becomesReachableAgainOnTheNext')}
            </>
          ) : (
            <>
              <strong>{row.name}</strong> {t('andEveryStationUnderItIncludingTheOwner')}
            </>
          )}
        </p>
        {!releasing && (
          <label className="mt-4 flex flex-col gap-1 text-sm">
            <span className="text-muted-foreground">{t('reason')}</span>
            <Input
              placeholder={t('reason')}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              className="h-9 text-sm"
              data-testid="organization-block-reason"
            />
            <span className="text-xs text-muted-foreground">{t('shownToTheCustomerOnTheir')}</span>
          </label>
        )}
        {state.status === 'error' && <p className="mt-3 text-sm text-destructive">{state.message}</p>}
      </DialogBody>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onCancel}>
          {t('cancel')}
        </Button>
        <form action={action}>
          <input type="hidden" name="organizationId" value={row.id} />
          {/* The visible field lives in the body and this carries its value: an
              input associated with a form across the DOM by id works, but only
              until somebody renders two of these dialogs at once. */}
          {!releasing && <input type="hidden" name="reason" value={reason} />}
          <Button type="submit" disabled={pending} data-testid="organization-block-confirm">
            {pending ? t('working') : releasing ? t('unblock') : t('block')}
          </Button>
        </form>
      </DialogFooter>
    </Dialog>
  );
}

function ProvisionDialog({
  open,
  onClose,
  onProvisioned,
}: {
  open: boolean;
  onClose: () => void;
  onProvisioned: (organization: OrganizationRow) => void;
}) {
  const t = useTranslations('admin');
  const titleId = useId();
  return (
    <Dialog open={open} onClose={onClose} labelledBy={titleId}>
      <DialogHeader>
        <DialogTitle id={titleId}>{t('provisionACustomer')}</DialogTitle>
      </DialogHeader>
      <DialogBody>
        <p className="mb-4 text-sm text-muted-foreground">{t('createsTheGroupAndItsOwner')}</p>
        {/* The dialog stays open after a successful provisioning on purpose: the
            provisional password is shown once and stored nowhere, so closing
            over it would lose the only copy that exists. */}
        <ProvisionForm onProvisioned={onProvisioned} />
      </DialogBody>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose}>
          {t('close')}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
