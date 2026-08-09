'use client';

import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useActionState, useEffect, useId } from 'react';
import { X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
// The tab tuple is declared with parseRecordParam rather than here, because the
// page that validates `tab=` against it is a Server Component and cannot import
// a value out of a client module. See src/lib/record-params.ts.
import { ORGANIZATION_TABS, type OrganizationTab } from '@/lib/record-params';
import { formatTaxId } from '@/lib/tax-id';
import {
  addStationAction,
  saveOrganizationAction,
  type OrganizationActionState,
  type OrganizationRow,
  type StationBrief,
} from './actions';
import { RegenerateForm } from './organization-forms';

const IDLE: OrganizationActionState = { status: 'idle' };

/**
 * One customer group's record, over the console's list.
 *
 * Three tabs, per design D2: what the group IS, who owns it, and what it has.
 * Nothing here is fetched when the dialog opens — page.tsx already read every
 * field it shows, its Stations included. That rule is not a preference: the URL
 * changes without a server round trip (use-record-dialog.ts), so a fetch on open
 * would be a second way for one screen to be wrong, which is the defect Block 15
 * shipped and had to correct.
 */
export function OrganizationRecordDialog({
  open,
  row,
  missing,
  tab,
  onTab,
  onClose,
  onSaved,
  onStationAdded,
}: {
  open: boolean;
  row: OrganizationRow | null;
  /** An address that named no group in the list. */
  missing?: boolean;
  tab: OrganizationTab;
  onTab: (tab: OrganizationTab) => void;
  onClose: () => void;
  onSaved: (organization: OrganizationRow) => void;
  onStationAdded: (organizationId: string, station: StationBrief) => void;
}) {
  const t = useTranslations('admin');
  const titleId = useId();

  const tabLabels: Record<OrganizationTab, string> = {
    data: t('tabData'),
    owner: t('tabOwner'),
    stations: t('tabStations'),
  };

  if (missing || !row) {
    // This list does not page, so an address that names no group means the group
    // does not exist rather than that it is on another page — which is why this
    // says so plainly where the retiring customers screen had to hedge.
    return (
      <Dialog open={open} onClose={onClose} labelledBy={titleId} className="max-w-lg">
        <DialogHeader>
          <DialogTitle id={titleId}>{t('organization')}</DialogTitle>
        </DialogHeader>
        <DialogBody>
          <p className="text-sm text-destructive">{t('noSuchOrganization')}</p>
        </DialogBody>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            {t('close')}
          </Button>
        </DialogFooter>
      </Dialog>
    );
  }

  return (
    <Dialog open={open} onClose={onClose} labelledBy={titleId}>
      <DialogHeader>
        <div className="flex flex-col gap-1">
          <DialogTitle id={titleId}>{row.name}</DialogTitle>
          <p className="text-xs text-muted-foreground">
            {row.suspendedAt
              ? `${t('blocked')}${row.suspensionReason ? ` — ${row.suspensionReason}` : ''}`
              : t('stationsCount', { count: row.stationCount })}
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label={t('closeRecord')}
          className="rounded-md p-1.5 ring-offset-background hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        >
          <X className="size-4" aria-hidden="true" />
        </button>
      </DialogHeader>

      <div role="tablist" aria-label={t('recordSections')} className="flex gap-1 border-b px-5">
        {ORGANIZATION_TABS.map((name) => (
          <button
            key={name}
            type="button"
            role="tab"
            aria-selected={tab === name}
            onClick={() => onTab(name)}
            className={
              tab === name
                ? 'border-b-2 border-primary px-3 py-2 text-sm font-medium'
                : 'border-b-2 border-transparent px-3 py-2 text-sm text-muted-foreground hover:text-foreground'
            }
          >
            {tabLabels[name]}
          </button>
        ))}
      </div>

      <DialogBody>
        {tab === 'data' && <OrganizationForm row={row} onSaved={onSaved} />}

        {tab === 'owner' && (
          <div className="flex flex-col gap-3">
            {row.owner ? (
              <>
                <p className="text-sm">
                  {t('owner2')} <strong>{row.owner.email}</strong>
                </p>
                <RegenerateForm userId={row.owner.userId} email={row.owner.email} />
              </>
            ) : (
              // More than one owner per group is allowed (Block 1c) and the
              // listing picks the earliest; none at all means every owner
              // membership was archived, which leaves nobody to reissue a
              // password for.
              <p className="text-sm text-muted-foreground">{t('thisOrganizationHasNoOwnerOn')}</p>
            )}
          </div>
        )}

        {tab === 'stations' && (
          <div className="flex flex-col gap-4">
            <ul className="flex flex-col gap-2 text-sm">
              {row.stations.map((station) => (
                <li
                  key={station.id}
                  className="flex items-center justify-between gap-3 rounded-md border p-3"
                >
                  {/* Read-only here, and a link rather than an edit: a Station's
                      own record is the Stations screen's, and two places that
                      edit one record is two places to keep in step. */}
                  <Link
                    href={`/admin/stations?organization=${row.id}&record=${station.id}`}
                    className="hover:underline"
                  >
                    {station.name}
                  </Link>
                  <span className="text-xs text-muted-foreground">{station.status}</span>
                </li>
              ))}
              {row.stations.length === 0 && (
                <li className="text-sm text-muted-foreground">{t('thisOrganizationHasNoStation')}</li>
              )}
            </ul>

            <AddStationForm
              organizationId={row.id}
              onAdded={(station) => onStationAdded(row.id, station)}
            />
          </div>
        )}
      </DialogBody>

      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose}>
          {t('close')}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

/**
 * The group's own record: what it is called, who it is on a document, and where
 * it invoices from.
 *
 * EVERY FIELD IS SUBMITTED ON EVERY SAVE, because update_organization writes
 * every field it takes and blanks what it is not given. A form that omitted an
 * untouched field would clear it, so there are no optional fields here — only
 * empty ones.
 *
 * `key` on the form is deliberate: the inputs are uncontrolled, so switching
 * from one group's record to another without remounting would leave the previous
 * group's values in the boxes.
 */
function OrganizationForm({
  row,
  onSaved,
}: {
  row: OrganizationRow;
  onSaved: (organization: OrganizationRow) => void;
}) {
  const t = useTranslations('admin');
  const [state, action, pending] = useActionState(saveOrganizationAction, IDLE);

  useEffect(() => {
    if (state.status === 'done' && state.organization) onSaved(state.organization);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  return (
    <form key={row.id} action={action} className="flex flex-col gap-5">
      <input type="hidden" name="organizationId" value={row.id} />

      <Field label={t('organizationName')}>
        <Input name="name" defaultValue={row.name} required />
      </Field>

      <fieldset className="flex flex-col gap-3 rounded-md border p-4">
        <legend className="px-1 text-xs font-medium text-muted-foreground">
          {t('invoicingIdentity')}
        </legend>

        {/* D7, said in words where the operator can read it: this answers who
            EMITS, never who HAS. Each Station keeps its own CNPJ either way. */}
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted-foreground">{t('whoIssuesTheInvoice')}</span>
          <select
            name="billingEntity"
            defaultValue={row.billingEntity}
            className="h-9 rounded-md border bg-background px-3 text-sm"
          >
            <option value="STATIONS">{t('eachStationInvoicesForItself')}</option>
            <option value="ORGANIZATION">{t('theGroupInvoicesForAll')}</option>
          </select>
          <span className="text-xs text-muted-foreground">{t('theSelectorSaysWhoEmits')}</span>
        </label>

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t('legalName')}>
            <Input name="legalName" defaultValue={row.legalName ?? ''} />
          </Field>
          <Field label={t('taxId')}>
            {/* Shown punctuated and stored bare: the service normalises it, and
                anything that is not fourteen digits is stored as absent rather
                than as a stub no invoice can be raised against. */}
            <Input name="taxId" defaultValue={formatTaxId(row.taxId)} placeholder="00.000.000/0000-00" />
          </Field>
          <Field label={t('municipalRegistration')}>
            <Input
              name="municipalRegistration"
              defaultValue={row.municipalRegistration ?? ''}
            />
          </Field>
          <Field label={t('fiscalEmail')}>
            <Input name="fiscalEmail" type="email" defaultValue={row.fiscalEmail ?? ''} />
          </Field>
        </div>
      </fieldset>

      <fieldset className="grid gap-3 rounded-md border p-4 sm:grid-cols-2">
        <legend className="px-1 text-xs font-medium text-muted-foreground">{t('address')}</legend>
        <Field label={t('addressLine')}>
          <Input name="addressLine" defaultValue={row.addressLine ?? ''} />
        </Field>
        <Field label={t('addressNumber')}>
          <Input name="addressNumber" defaultValue={row.addressNumber ?? ''} />
        </Field>
        <Field label={t('addressComplement')}>
          <Input name="addressComplement" defaultValue={row.addressComplement ?? ''} />
        </Field>
        <Field label={t('neighbourhood')}>
          <Input name="neighbourhood" defaultValue={row.neighbourhood ?? ''} />
        </Field>
        <Field label={t('city')}>
          <Input name="city" defaultValue={row.city ?? ''} />
        </Field>
        <Field label={t('state')}>
          <Input name="state" defaultValue={row.state ?? ''} />
        </Field>
        <Field label={t('postalCode')}>
          <Input name="postalCode" defaultValue={row.postalCode ?? ''} />
        </Field>
      </fieldset>

      {state.status === 'error' && <p className="text-sm text-destructive">{state.message}</p>}
      {state.status === 'done' && <p className="text-sm text-muted-foreground">{t('saved')}</p>}

      <div>
        <Button type="submit" disabled={pending} data-testid="organization-save">
          {pending ? t('working') : t('save')}
        </Button>
      </div>
    </form>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span className="text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}

function AddStationForm({
  organizationId,
  onAdded,
}: {
  organizationId: string;
  onAdded: (station: StationBrief) => void;
}) {
  const t = useTranslations('admin');
  const [state, action, pending] = useActionState(addStationAction, IDLE);

  useEffect(() => {
    if (state.status === 'done' && state.station) onAdded(state.station);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  return (
    <form action={action} className="flex flex-col gap-2 border-t pt-4">
      <input type="hidden" name="organizationId" value={organizationId} />
      <div className="flex flex-wrap items-center gap-2">
        <Input name="name" placeholder={t('newStationName')} required className="h-9 w-48 text-sm" />
        <Button type="submit" variant="outline" disabled={pending} data-testid="organization-add-station">
          {pending ? t('adding') : t('addStation')}
        </Button>
      </div>
      {state.status === 'error' && <p className="text-sm text-destructive">{state.message}</p>}
    </form>
  );
}
