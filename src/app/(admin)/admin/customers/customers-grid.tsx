'use client';

import { useActionState, useEffect, useId, useState } from 'react';
import { MoreVertical, Pencil } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuItem } from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import {
  PageControls,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { useRecordDialog } from '@/hooks/use-record-dialog';
import { applyRowPatch, type RowState } from '@/lib/row-patch';
import {
  reactivateAction,
  suspendAction,
  type CustomerActionState,
  type CustomerRow,
} from './actions';
import { ProvisionForm } from './credential-forms';
import {
  CUSTOMER_TABS,
  CustomerRecordDialog,
  type CustomerTab,
  type StationBrief,
} from './customer-record-dialog';

/** How many columns the empty-state row has to span, actions included. */
const COLUMN_COUNT = 5;

const IDLE: CustomerActionState = { status: 'idle' };

/**
 * The customers console, and the host for the record dialog over it.
 *
 * This screen pages (keyset, newest first) and page.tsx still runs that query;
 * what this owns is the page of rows, so that suspending, reactivating,
 * adding a Station or provisioning a whole customer redraws a line instead of
 * the screen. Nothing here fetches a list, ever.
 */
export function CustomersGrid({
  initialRows,
  initialStationsByOrganization,
  search,
  previousHref,
  nextHref,
  initialRecord,
}: {
  initialRows: CustomerRow[];
  initialStationsByOrganization: Record<string, StationBrief[]>;
  search: string | undefined;
  previousHref: string | null;
  nextHref: string | null;
  initialRecord: { recordId: string | null; tab: string | null };
}) {
  const [grid, setGrid] = useState<RowState<CustomerRow>>({
    rows: initialRows,
    // No total, deliberately and unchanged: this list is platform-wide by
    // design, counting it is not cheap, and nobody is asking "how many".
    total: null,
  });
  const [stations, setStations] = useState(initialStationsByOrganization);

  useEffect(() => {
    setGrid({ rows: initialRows, total: null });
    setStations(initialStationsByOrganization);
  }, [initialRows, initialStationsByOrganization]);

  const { recordId, tab, open, setTab, close } = useRecordDialog(CUSTOMER_TABS, initialRecord);
  const [provisioning, setProvisioning] = useState(false);
  const [statusChange, setStatusChange] = useState<CustomerRow | null>(null);

  const openRow = recordId ? (grid.rows.find((row) => row.id === recordId) ?? null) : null;

  /** A Station that has just been created, wherever it came from. */
  function addStation(company: CustomerRow, owner: CustomerRow['owner']) {
    const row = { ...company, owner: company.owner ?? owner };
    setGrid((current) => applyRowPatch(current, { kind: 'create', row }));
    setStations((current) => ({
      ...current,
      [row.organizationId]: [
        ...(current[row.organizationId] ?? []),
        { id: row.id, name: row.name, status: row.status },
      ],
    }));
  }

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3">
        {/* A plain GET form: submitting it is a navigation, which is all this
            needs, and it carries no cursor — a search is a new list, so it
            starts at the beginning of one. */}
        <form method="get" action="/admin/customers" className="flex flex-wrap items-end gap-2">
          <Input
            type="search"
            name="q"
            defaultValue={search ?? ''}
            placeholder="Search by Station name"
            aria-label="Search customers by Station name"
            className="h-9 w-64 text-sm"
            data-testid="customer-search-input"
          />
          <Button type="submit" variant="outline" className="h-9">
            Search
          </Button>
        </form>

        <Button type="button" onClick={() => setProvisioning(true)} data-testid="customer-create">
          Provision customer
        </Button>
      </div>

      <div className="mt-4 rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Station</TableHead>
              <TableHead>Subscription</TableHead>
              <TableHead>Owner</TableHead>
              <TableHead>Provisioned</TableHead>
              <TableHead className="sticky right-0 bg-background text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {grid.rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={COLUMN_COUNT} className="text-sm text-muted-foreground">
                  {search ? 'No customer matches this search.' : 'No company provisioned yet.'}
                </TableCell>
              </TableRow>
            ) : (
              grid.rows.map((row) => (
                <TableRow key={row.id} data-testid="company-row">
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
                    {row.owner ? `Owner: ${row.owner.email}` : '—'}
                  </TableCell>
                  <TableCell>{new Date(row.createdAt).toLocaleDateString('en-GB')}</TableCell>
                  <TableCell className="sticky right-0 bg-background">
                    <div className="flex items-center justify-end gap-1">
                      {/* An "open" affordance, not an edit one: no migration
                          defines a rename or an update_company, so there is
                          nothing on this record for a console to edit. */}
                      <button
                        type="button"
                        aria-label={`Open ${row.name}`}
                        onClick={() => open(row.id, 'customer')}
                        className="rounded-md p-1.5 ring-offset-background hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                      >
                        <Pencil className="size-4" aria-hidden="true" />
                      </button>
                      <DropdownMenu
                        label={`Actions for ${row.name}`}
                        trigger={<MoreVertical className="size-4" aria-hidden="true" />}
                      >
                        <DropdownMenuItem onSelect={() => open(row.id, 'stations')}>
                          Add a Station…
                        </DropdownMenuItem>
                        {row.status === 'active' ? (
                          <DropdownMenuItem destructive onSelect={() => setStatusChange(row)}>
                            Suspend…
                          </DropdownMenuItem>
                        ) : (
                          <DropdownMenuItem onSelect={() => setStatusChange(row)}>
                            Reactivate…
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

        <PageControls
          label="Newest customers first"
          previousHref={previousHref}
          nextHref={nextHref}
        />
      </div>

      <CustomerRecordDialog
        open={recordId !== null}
        row={openRow}
        missing={recordId !== null && openRow === null}
        siblings={
          openRow
            ? (stations[openRow.organizationId] ?? []).filter((s) => s.id !== openRow.id)
            : []
        }
        tab={(tab as CustomerTab) ?? 'customer'}
        onTab={setTab}
        onClose={close}
        onStationAdded={(company) => addStation(company, openRow?.owner ?? null)}
      />

      <ProvisionDialog
        open={provisioning}
        onClose={() => setProvisioning(false)}
        onProvisioned={(company) => addStation(company, null)}
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
 * Suspend and reactivate share a dialog: one confirmation, one status write,
 * one row that stays exactly where it is afterwards. Suspension takes effect on
 * the customer's very next request without signing anybody out, because the RLS
 * helpers query these tables on every check — so the sentence says that rather
 * than implying the customer is locked out this instant.
 */
function StatusDialog({
  row,
  onCancel,
  onChanged,
}: {
  row: CustomerRow;
  onCancel: () => void;
  onChanged: (row: CustomerRow) => void;
}) {
  const titleId = useId();
  const suspending = row.status === 'active';
  const [state, action, pending] = useActionState(
    suspending ? suspendAction : reactivateAction,
    IDLE,
  );
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
          {suspending ? 'Suspend this subscription?' : 'Reactivate this subscription?'}
        </DialogTitle>
      </DialogHeader>
      <DialogBody>
        <p className="text-sm">
          {suspending ? (
            <>
              <strong>{row.name}</strong> keeps its data, and everyone signed in there loses access
              on their next request — nobody is signed out. Reactivating gives it all back.
            </>
          ) : (
            <>
              <strong>{row.name}</strong> becomes reachable again on the next request from anyone
              signed in there.
            </>
          )}
        </p>
        {suspending && (
          <label className="mt-4 flex flex-col gap-1 text-sm">
            <span className="text-muted-foreground">Reason</span>
            <Input
              placeholder="Reason"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              className="h-9 text-sm"
            />
            <span className="text-xs text-muted-foreground">
              Shown to the customer on their own screens. Left empty, it is recorded as
              &ldquo;non-payment&rdquo;.
            </span>
          </label>
        )}
        {state.status === 'error' && <p className="mt-3 text-sm text-destructive">{state.message}</p>}
      </DialogBody>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <form action={action}>
          <input type="hidden" name="companyId" value={row.id} />
          {/* The visible field lives in the body and this carries its value:
              an input associated with a form across the DOM by id works, but
              only until somebody renders two of these dialogs at once. */}
          {suspending && <input type="hidden" name="reason" value={reason} />}
          <Button type="submit" disabled={pending} data-testid="customer-status-confirm">
            {pending ? 'Working…' : suspending ? 'Suspend' : 'Reactivate'}
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
  onProvisioned: (company: CustomerRow) => void;
}) {
  const titleId = useId();
  return (
    <Dialog open={open} onClose={onClose} labelledBy={titleId}>
      <DialogHeader>
        <DialogTitle id={titleId}>Provision a customer</DialogTitle>
      </DialogHeader>
      <DialogBody>
        <p className="mb-4 text-sm text-muted-foreground">
          Creates the organization, the station and the owner account.
        </p>
        {/* The dialog stays open after a successful provisioning on purpose:
            the provisional password is shown once and stored nowhere, so
            closing over it would lose the only copy that exists. */}
        <ProvisionForm onProvisioned={onProvisioned} />
      </DialogBody>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose}>
          Close
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
