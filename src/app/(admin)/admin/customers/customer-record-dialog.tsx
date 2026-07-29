'use client';

import { useActionState, useEffect, useId } from 'react';
import { X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { addCompanyAction, type CustomerActionState, type CustomerRow } from './actions';
import { RegenerateForm } from './credential-forms';

export const CUSTOMER_TABS = ['customer', 'stations', 'owner'] as const;
export type CustomerTab = (typeof CUSTOMER_TABS)[number];

const TAB_LABELS: Record<CustomerTab, string> = {
  customer: 'Customer',
  stations: 'Stations',
  owner: 'Owner',
};

const IDLE: CustomerActionState = { status: 'idle' };

/** A sibling Station under the same Organization, as the Stations tab lists them. */
export interface StationBrief {
  id: string;
  name: string;
  status: string;
}

/**
 * One customer's record, over the console's list.
 *
 * The Customer tab has no Save button, and that is a finding rather than an
 * omission: no migration defines update_company or a rename, so there is
 * nothing on a Station that this console may edit. What the tabs carry are the
 * operations — add_company here, the provisional password next door — and the
 * suspend/reactivate pair, which is a status change rather than a field, lives
 * in the row menu beside the record.
 *
 * Nothing is fetched when this opens: page.tsx already read every field it
 * shows, siblings included.
 */
export function CustomerRecordDialog({
  open,
  row,
  missing,
  siblings,
  tab,
  onTab,
  onClose,
  onStationAdded,
}: {
  open: boolean;
  row: CustomerRow | null;
  /** An address that named no Station on this page. */
  missing?: boolean;
  siblings: StationBrief[];
  tab: CustomerTab;
  onTab: (tab: CustomerTab) => void;
  onClose: () => void;
  onStationAdded: (company: CustomerRow) => void;
}) {
  const titleId = useId();

  if (missing || !row) {
    // Unlike the other record screens, this list DOES page — so a customer that
    // is not on the page being viewed is a real possibility, and it is told
    // apart from a Station that does not exist by neither of them saying which
    // it was. A platform admin can find the row by searching for its name; an
    // id pasted from elsewhere learns nothing.
    return (
      <Dialog open={open} onClose={onClose} labelledBy={titleId} className="max-w-lg">
        <DialogHeader>
          <DialogTitle id={titleId}>Customer</DialogTitle>
        </DialogHeader>
        <DialogBody>
          <p className="text-sm text-destructive">
            No such customer on this page. Search for the Station by name, or clear the search and
            page through the list.
          </p>
        </DialogBody>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            Close
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
            {row.status}
            {row.suspensionReason ? ` — ${row.suspensionReason}` : ''}
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="rounded-md p-1.5 ring-offset-background hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        >
          <X className="size-4" aria-hidden="true" />
        </button>
      </DialogHeader>

      <div role="tablist" aria-label="Record sections" className="flex gap-1 border-b px-5">
        {CUSTOMER_TABS.map((name) => (
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
            {TAB_LABELS[name]}
          </button>
        ))}
      </div>

      <DialogBody>
        {tab === 'customer' && (
          <dl className="grid gap-2 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-xs text-muted-foreground">Station</dt>
              <dd>{row.name}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Subscription</dt>
              <dd>
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
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Provisioned</dt>
              <dd>{new Date(row.createdAt).toLocaleDateString('en-GB')}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Owner</dt>
              <dd>{row.owner?.email ?? '—'}</dd>
            </div>
          </dl>
        )}

        {tab === 'stations' && (
          <div className="flex flex-col gap-4">
            <ul className="flex flex-col gap-2 text-sm">
              {siblings.map((station) => (
                <li
                  key={station.id}
                  className="flex items-center justify-between gap-3 rounded-md border p-3"
                >
                  <span>{station.name}</span>
                  <span className="text-xs text-muted-foreground">{station.status}</span>
                </li>
              ))}
              {siblings.length === 0 && (
                <li className="text-sm text-muted-foreground">
                  This Organization has no other Station.
                </li>
              )}
            </ul>

            {/* An Organization can hold more than one Station (Block 1c), and
                add_company is platform-admin only — which is why this form lives
                in the console rather than on the customer's own screens. */}
            <AddStationForm organizationId={row.organizationId} onAdded={onStationAdded} />
          </div>
        )}

        {tab === 'owner' && (
          <div className="flex flex-col gap-3">
            {row.owner ? (
              <>
                <p className="text-sm">
                  Owner: <strong>{row.owner.email}</strong>
                </p>
                <RegenerateForm userId={row.owner.userId} email={row.owner.email} />
              </>
            ) : (
              // Block 1c allows more than one owner per Organization and the
              // page picks the earliest; none at all means every owner
              // membership was archived, which leaves nobody to reissue a
              // password for.
              <p className="text-sm text-muted-foreground">
                This Organization has no owner on record.
              </p>
            )}
          </div>
        )}
      </DialogBody>

      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose}>
          Close
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

function AddStationForm({
  organizationId,
  onAdded,
}: {
  organizationId: string;
  onAdded: (company: CustomerRow) => void;
}) {
  const [state, action, pending] = useActionState(addCompanyAction, IDLE);

  useEffect(() => {
    if (state.status === 'done' && state.company) onAdded(state.company);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  return (
    <form action={action} className="flex flex-col gap-2 border-t pt-4">
      <input type="hidden" name="organizationId" value={organizationId} />
      <div className="flex flex-wrap items-center gap-2">
        <Input name="name" placeholder="New Station name" required className="h-9 w-48 text-sm" />
        <Button type="submit" variant="outline" disabled={pending}>
          {pending ? 'Adding…' : 'Add Station'}
        </Button>
      </div>
      {state.status === 'error' && <p className="text-sm text-destructive">{state.message}</p>}
    </form>
  );
}
