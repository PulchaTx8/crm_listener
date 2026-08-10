'use client';

import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useActionState, useEffect, useId, useState } from 'react';
import { MoreVertical, Pencil } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuItem } from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useRecordDialog } from '@/hooks/use-record-dialog';
import { applyRowPatch, type RowState } from '@/lib/row-patch';
import { STATION_TABS, type StationTab } from '@/lib/record-params';
import type { ApiCredentialRow } from '@/services/api-credentials';
import type { IntegrationRow } from '@/services/integrations';
import type { WidgetInstallationRow } from '@/services/widget-installations';
import { reactivateAction, suspendAction, type StationActionState, type StationRow } from './actions';
import { StationRecordDialog } from './station-record-dialog';
import type { CredentialStatus } from './integration-tab';
import type { StationProfile } from './station-form';

/** How many columns the empty-state row has to span, actions included. */
const COLUMN_COUNT = 5;

const IDLE: StationActionState = { status: 'idle' };

export interface OrganizationOption {
  id: string;
  name: string;
  suspendedAt: string | null;
}

/**
 * The Stations of ONE customer group, and the record dialog over them.
 *
 * THE GROUP IS CHOSEN WITH A REAL NAVIGATION, not with client-side filtering.
 * The server has to re-read: each listed Station's profile, keys and integration
 * are loaded eagerly so the record can open without fetching, and that read is
 * scoped to the chosen group. Filtering a list the browser already holds would
 * mean the page had loaded every Station on the platform — which is exactly what
 * makes eager loading affordable here and impossible there.
 */
export function StationsGrid({
  organizations,
  selectedOrganizationId,
  initialRows,
  initialRecord,
  initialProfiles,
  initialCredentials,
  initialIntegrations,
  initialInstallations,
  secrets,
  siteUrl,
}: {
  organizations: OrganizationOption[];
  selectedOrganizationId: string | null;
  initialRows: StationRow[];
  initialRecord: { recordId: string | null; tab: string | null };
  /** Keyed by Station id. Every listed Station, read before any record opened. */
  initialProfiles: Record<string, StationProfile>;
  initialCredentials: Record<string, ApiCredentialRow[]>;
  initialIntegrations: Record<string, IntegrationRow | null>;
  /** Keyed by Station id, `null` for one with no widget configured yet -- an
   * absent key would make "not loaded" and "not configured" the same value,
   * which is exactly what the Widget tab has to tell apart. */
  initialInstallations: Record<string, WidgetInstallationRow | null>;
  secrets: CredentialStatus;
  siteUrl: string;
}) {
  const t = useTranslations('admin');
  const router = useRouter();
  const [grid, setGrid] = useState<RowState<StationRow>>({
    rows: initialRows,
    total: initialRows.length,
  });
  const [statusChange, setStatusChange] = useState<StationRow | null>(null);

  /**
   * THE FOUR RECORD SNAPSHOTS, AND WHY THEY ARE STATE RATHER THAN PROPS.
   *
   * page.tsx reads each Station's profile, keys, integration and widget
   * installation once, before any record is opened, and nothing re-reads them:
   * the actions in actions.ts deliberately call no revalidatePath, because a
   * fresh render would close the dialog the forms live in. Held as props, these
   * would therefore stay frozen at what the server sent for the whole life of
   * the screen -- and the dialog mounts each tab only while it is selected, so
   * switching tabs or reopening the record re-read the frozen copy and showed
   * the operator the values from before their save. A save that HAD landed read
   * as one that had not; reported from the hosted console on 2026-08-10.
   *
   * Each action returns what it wrote, and the four `on...` callbacks handed to
   * StationRecordDialog at the bottom of this file put it here. The props are
   * still the source on arrival, and still win on a real navigation -- choosing
   * another group re-runs the server read, and the effects below adopt it.
   */
  const [profiles, setProfiles] = useState(initialProfiles);
  const [credentials, setCredentials] = useState(initialCredentials);
  const [integrations, setIntegrations] = useState(initialIntegrations);
  const [installations, setInstallations] = useState(initialInstallations);

  useEffect(() => {
    setGrid({ rows: initialRows, total: initialRows.length });
  }, [initialRows]);

  useEffect(() => setProfiles(initialProfiles), [initialProfiles]);
  useEffect(() => setCredentials(initialCredentials), [initialCredentials]);
  useEffect(() => setIntegrations(initialIntegrations), [initialIntegrations]);
  useEffect(() => setInstallations(initialInstallations), [initialInstallations]);

  const { recordId, tab, open, setTab, close } = useRecordDialog(STATION_TABS, initialRecord);
  const openRow = recordId ? (grid.rows.find((row) => row.id === recordId) ?? null) : null;

  return (
    <>
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted-foreground">{t('organization')}</span>
          <select
            value={selectedOrganizationId ?? ''}
            onChange={(event) => {
              const id = event.target.value;
              // push, not replace: choosing a group is a place the operator can
              // come Back from, and this is the one navigation on this screen
              // that is meant to re-run the server read.
              router.push(id ? `/admin/stations?organization=${id}` : '/admin/stations');
            }}
            className="h-9 w-72 rounded-md border border-input bg-background px-3 text-sm"
            data-testid="station-organization-select"
          >
            <option value="">{t('chooseACustomer')}</option>
            {organizations.map((organization) => (
              <option key={organization.id} value={organization.id}>
                {organization.name}
                {organization.suspendedAt ? ` — ${t('blocked')}` : ''}
              </option>
            ))}
          </select>
        </label>
      </div>

      {selectedOrganizationId === null ? (
        // Nothing is listed until a group is chosen, and that is the design
        // rather than an empty state: this screen reads every listed Station's
        // record eagerly, so "all Stations" is the one selection it must not
        // offer.
        <p className="mt-6 text-sm text-muted-foreground">{t('chooseACustomerToSeeItsStations')}</p>
      ) : (
        <div className="mt-4 rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('station')}</TableHead>
                <TableHead>{t('subscription')}</TableHead>
                <TableHead>{t('whatsapp')}</TableHead>
                <TableHead>{t('provisioned')}</TableHead>
                <TableHead className="sticky right-0 bg-background text-right">
                  {t('actions')}
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {grid.rows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={COLUMN_COUNT} className="text-sm text-muted-foreground">
                    {t('thisCustomerHasNoStationYet')}
                  </TableCell>
                </TableRow>
              ) : (
                grid.rows.map((row) => {
                  const integration = integrations[row.id] ?? null;
                  return (
                    <TableRow key={row.id} data-testid="station-row">
                      <TableCell className="font-medium">
                        <button
                          type="button"
                          onClick={() => open(row.id)}
                          className="text-left ring-offset-background hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                        >
                          {row.name}
                        </button>
                      </TableCell>
                      <TableCell>
                        <span
                          className={
                            row.status === 'active'
                              ? 'rounded-full bg-primary/10 px-2.5 py-0.5 text-xs font-medium text-primary'
                              : 'rounded-full bg-destructive/10 px-2.5 py-0.5 text-xs font-medium text-destructive'
                          }
                        >
                          {row.status}
                          {row.suspensionReason ? ` — ${row.suspensionReason}` : ''}
                        </span>
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {integration?.integration_id
                          ? (integration.display_phone_number ?? integration.phone_number_id)
                          : '—'}
                      </TableCell>
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
                            {/* Today's suspend/reactivate, relabelled (D5.1).
                                This stops ONE radio; blocking the group on the
                                Organizations screen stops the customer. */}
                            {row.status === 'active' ? (
                              <DropdownMenuItem destructive onSelect={() => setStatusChange(row)}>
                                {t('block')}
                              </DropdownMenuItem>
                            ) : (
                              <DropdownMenuItem onSelect={() => setStatusChange(row)}>
                                {t('unblock')}
                              </DropdownMenuItem>
                            )}
                          </DropdownMenu>
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
        </div>
      )}

      <StationRecordDialog
        open={recordId !== null}
        row={openRow}
        missing={recordId !== null && openRow === null}
        profile={openRow ? (profiles[openRow.id] ?? null) : null}
        credentials={openRow ? (credentials[openRow.id] ?? []) : []}
        integration={openRow ? (integrations[openRow.id] ?? null) : null}
        secrets={secrets}
        installation={openRow ? (installations[openRow.id] ?? null) : null}
        siteUrl={siteUrl}
        tab={(tab as StationTab) ?? 'data'}
        onTab={setTab}
        onClose={close}
        // Keyed by Station rather than assuming the open record: these arrive
        // from a tab that is about to unmount, and the id it saved against is
        // the only one that can be trusted to still be the right one.
        onProfileSaved={(companyId, profile) =>
          setProfiles((current) => ({ ...current, [companyId]: profile }))
        }
        onIntegrationSaved={(companyId, integration) =>
          setIntegrations((current) => ({ ...current, [companyId]: integration }))
        }
        onCredentialsChanged={(companyId, rows) =>
          setCredentials((current) => ({ ...current, [companyId]: rows }))
        }
        onInstallationSaved={(companyId, installation) =>
          setInstallations((current) => ({ ...current, [companyId]: installation }))
        }
      />

      {statusChange && (
        <StatusDialog
          row={statusChange}
          onCancel={() => setStatusChange(null)}
          onChanged={(row) => {
            setStatusChange(null);
            setGrid((current) => applyRowPatch(current, { kind: 'save', row }));
          }}
        />
      )}
    </>
  );
}

/**
 * Blocking and releasing one Station share a dialog: one confirmation, one
 * status write, one row that stays exactly where it is afterwards.
 *
 * It takes effect on the customer's very next request without signing anybody
 * out, because the RLS helpers query these tables on every check — so the
 * sentence says that rather than implying the customer is locked out this
 * instant.
 */
function StatusDialog({
  row,
  onCancel,
  onChanged,
}: {
  row: StationRow;
  onCancel: () => void;
  onChanged: (row: StationRow) => void;
}) {
  const t = useTranslations('admin');
  const titleId = useId();
  const suspending = row.status === 'active';
  const [state, action, pending] = useActionState(suspending ? suspendAction : reactivateAction, IDLE);
  const [reason, setReason] = useState('');

  useEffect(() => {
    if (state.status !== 'done') return;
    onChanged({
      ...row,
      status: suspending ? 'suspended' : 'active',
      // suspend_company stores the reason it was given; reactivate_company
      // clears it. The row shows what the database now holds either way.
      suspensionReason: suspending ? reason.trim() || 'non-payment' : null,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  return (
    <Dialog open onClose={onCancel} labelledBy={titleId} className="max-w-lg">
      <DialogHeader>
        <DialogTitle id={titleId}>
          {suspending ? t('blockThisStation') : t('releaseThisStation')}
        </DialogTitle>
      </DialogHeader>
      <DialogBody>
        <p className="text-sm">
          {suspending ? (
            <>
              <strong>{row.name}</strong> {t('keepsItsDataAndEveryoneSigned')}
            </>
          ) : (
            <>
              <strong>{row.name}</strong> {t('becomesReachableAgainOnTheNext')}
            </>
          )}
        </p>
        {suspending && (
          <label className="mt-4 flex flex-col gap-1 text-sm">
            <span className="text-muted-foreground">{t('reason')}</span>
            <Input
              placeholder={t('reason')}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              className="h-9 text-sm"
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
          <input type="hidden" name="companyId" value={row.id} />
          {/* The visible field lives in the body and this carries its value: an
              input associated with a form across the DOM by id works, but only
              until somebody renders two of these dialogs at once. */}
          {suspending && <input type="hidden" name="reason" value={reason} />}
          <Button type="submit" disabled={pending} data-testid="station-status-confirm">
            {pending ? t('working') : suspending ? t('block') : t('unblock')}
          </Button>
        </form>
      </DialogFooter>
    </Dialog>
  );
}
