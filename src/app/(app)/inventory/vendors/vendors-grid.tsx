'use client';

import { useActionState, useEffect, useId, useState } from 'react';
import { useTranslations } from 'next-intl';
import { MoreVertical, Pencil } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuItem } from '@/components/ui/dropdown-menu';
import {
  PageControls,
  SortLink,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { useRecordDialog } from '@/hooks/use-record-dialog';
import { applyRowPatch, type RowState } from '@/lib/row-patch';
import { VENDOR_TABS } from '@/lib/record-params';
import type { VendorSummary } from '@/services/vendors';
import { archiveVendorAction, type VendorFormState } from './actions';
import { hasActiveVendorFilters, vendorSortHref } from './list-params';
import type { VendorListState } from './list-params';
import { VendorRecordDialog } from './vendor-record-dialog';

/**
 * Block 24, item 7. The supplier list, on the shape of `shows-grid.tsx`: a table
 * under a register button, paged by keyset, with the record opening as a modal
 * over it and writes patching the row in place.
 *
 * Patching rather than re-rendering the route is the same rule shows, songs,
 * inventory and members carry: a fresh render would rebuild the keyset list from
 * page one under whoever was reading it.
 */

/**
 * How many columns the empty row has to span, actions included. A number that
 * has to be raised by hand with every column, or the "no vendors" row stops
 * spanning the table.
 */
const COLUMN_COUNT = 6;

const INITIAL_ARCHIVE: VendorFormState = { status: 'idle' };

export function VendorsGrid({
  initialRows,
  initialTotal,
  state,
  previousHref,
  nextHref,
  manage,
  initialRecord,
}: {
  initialRows: VendorSummary[];
  initialTotal: number;
  state: VendorListState;
  previousHref: string | null;
  nextHref: string | null;
  /** Whether the caller holds inventory.catalogue at this Station — a courtesy gate; both doors re-check it themselves. */
  manage: boolean;
  initialRecord: { recordId: string | null; tab: string | null };
}) {
  const t = useTranslations('vendors');
  const [grid, setGrid] = useState<RowState<VendorSummary>>({
    rows: initialRows,
    total: initialTotal,
  });

  // A navigation hands down a new page: the one moment position and filter
  // membership are re-evaluated (src/lib/row-patch.ts).
  useEffect(() => {
    setGrid({ rows: initialRows, total: initialTotal });
  }, [initialRows, initialTotal]);

  const { recordId, open, close } = useRecordDialog(VENDOR_TABS, initialRecord);
  const [creating, setCreating] = useState(false);
  const [archiving, setArchiving] = useState<VendorSummary | null>(null);

  const nameSorted = state.sort === 'name';
  const addedSorted = state.sort === 'created';
  const ariaSort = (sorted: boolean) =>
    sorted ? (state.direction === 'asc' ? 'ascending' : 'descending') : 'none';

  return (
    <>
      {manage && (
        <div className="mt-4 flex flex-wrap justify-end gap-2">
          <Button type="button" onClick={() => setCreating(true)} data-testid="vendor-add">
            {t('registerVendor')}
          </Button>
        </div>
      )}

      <div className="mt-4 rounded-lg border">
        <Table data-testid="vendors-table">
          <TableHeader>
            <TableRow>
              <TableHead aria-sort={ariaSort(nameSorted)}>
                <SortLink
                  href={vendorSortHref(state, 'name')}
                  active={nameSorted}
                  direction={nameSorted ? state.direction : 'asc'}
                >
                  {t('name')}
                </SortLink>
              </TableHead>
              <TableHead>{t('document')}</TableHead>
              <TableHead>{t('contact')}</TableHead>
              <TableHead>{t('city')}</TableHead>
              <TableHead aria-sort={ariaSort(addedSorted)}>
                <SortLink
                  href={vendorSortHref(state, 'created')}
                  active={addedSorted}
                  direction={addedSorted ? state.direction : 'desc'}
                >
                  {t('added')}
                </SortLink>
              </TableHead>
              <TableHead className="sticky right-0 bg-background text-right">{t('actions')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {grid.rows.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={COLUMN_COUNT}
                  className="text-sm text-muted-foreground"
                  data-testid="vendors-empty"
                >
                  {hasActiveVendorFilters(state) ? t('noVendorMatchesTheseFilters') : t('noVendorsYet')}
                </TableCell>
              </TableRow>
            ) : (
              grid.rows.map((vendor) => (
                <TableRow key={vendor.id} data-testid="vendor-row">
                  <TableCell className="font-medium">
                    <span className="flex flex-col gap-1">
                      <button
                        type="button"
                        onClick={() => open(vendor.id)}
                        className="text-left ring-offset-background hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                      >
                        {vendor.name}
                      </button>
                      {/* Under the name rather than in a column: it is empty for
                          most suppliers, and a mostly-empty column costs every
                          row width to serve a few. */}
                      {vendor.legalName && (
                        <span className="text-xs font-normal text-muted-foreground">
                          {vendor.legalName}
                        </span>
                      )}
                    </span>
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-sm">{vendor.document ?? '—'}</TableCell>
                  <TableCell className="text-sm">
                    <span className="flex flex-col">
                      <span>{vendor.contactName ?? '—'}</span>
                      {vendor.phone && (
                        <span className="text-xs text-muted-foreground">{vendor.phone}</span>
                      )}
                    </span>
                  </TableCell>
                  <TableCell className="text-sm">{vendor.city ?? '—'}</TableCell>
                  <TableCell className="whitespace-nowrap">{formatAddedDate(vendor.createdAt)}</TableCell>
                  <TableCell className="sticky right-0 bg-background">
                    <div className="flex items-center justify-end gap-1">
                      <button
                        type="button"
                        aria-label={t('editVendor', { name: vendor.name })}
                        onClick={() => open(vendor.id)}
                        data-testid="vendor-edit"
                        className="rounded-md p-1.5 ring-offset-background hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                      >
                        <Pencil className="size-4" aria-hidden="true" />
                      </button>
                      {manage && (
                        <DropdownMenu
                          label={t('actionsForVendor', { name: vendor.name })}
                          trigger={<MoreVertical className="size-4" aria-hidden="true" />}
                        >
                          {/* The only retiring action there is: an entry points
                              at a vendor, so a delete would be refused by the
                              database the moment one purchase named them. */}
                          <DropdownMenuItem onSelect={() => setArchiving(vendor)}>
                            {/* The testid is on the label rather than the item:
                                DropdownMenuItem takes three props and none of
                                them is an attribute bag, and widening a shared
                                primitive for one screen's test is the wrong
                                trade. The click lands on the button either
                                way. */}
                            <span data-testid="vendor-archive">{t('archiveThisVendor')}</span>
                          </DropdownMenuItem>
                        </DropdownMenu>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>

        <PageControls
          total={grid.total}
          label={t('vendorsLabel', { count: grid.total ?? 0 })}
          previousHref={previousHref}
          nextHref={nextHref}
        />
      </div>

      <VendorRecordDialog
        open={creating || recordId !== null}
        recordId={creating ? null : recordId}
        companyId={state.companyId}
        manage={manage}
        onClose={() => {
          if (creating) setCreating(false);
          else close();
        }}
        onSaved={(saved, created) => {
          setGrid((current) =>
            applyRowPatch(current, created ? { kind: 'create', row: saved } : { kind: 'save', row: saved }),
          );
          // A vendor just registered has no row to stay open over, and the one
          // it produced is at the top of the list behind this dialog.
          if (created) setCreating(false);
        }}
      />

      {archiving && (
        <ArchiveVendorDialog
          vendor={archiving}
          onCancel={() => setArchiving(null)}
          onArchived={(id) => {
            setArchiving(null);
            // REMOVED rather than patched, unlike every other archive in this
            // product: 0198's select policy filters `deleted_at`, so the row is
            // unreadable the instant it is archived and there is nothing to
            // patch it with. Taking it off the list is also what the list should
            // show, since an archived vendor is not on it.
            setGrid((current) => applyRowPatch(current, { kind: 'remove', id }));
          }}
        />
      )}
    </>
  );
}

/** The day alone, in the runtime's zone — the same disclosed gap shows-grid.tsx's formatAddedDate carries. */
function formatAddedDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-GB', { dateStyle: 'medium' });
}

/**
 * Archiving is not deleting, and this dialog exists to say so before it happens:
 * the row stays, and every entry already naming the supplier keeps naming them —
 * `archive_vendor` is deliberately never refused over those entries, and
 * `list_movements` goes on resolving the name (0199, 0200). What changes is that
 * the picker on the entry form stops offering it.
 */
function ArchiveVendorDialog({
  vendor,
  onCancel,
  onArchived,
}: {
  vendor: VendorSummary;
  onCancel: () => void;
  onArchived: (id: string) => void;
}) {
  const t = useTranslations('vendors');
  const titleId = useId();
  const [state, action, pending] = useActionState(archiveVendorAction, INITIAL_ARCHIVE);

  useEffect(() => {
    if (state.status === 'saved') onArchived(vendor.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  return (
    <Dialog open onClose={onCancel} labelledBy={titleId} className="max-w-lg">
      <DialogHeader>
        <DialogTitle id={titleId}>{t('archiveThisVendor')}</DialogTitle>
      </DialogHeader>
      <form action={action}>
        <input type="hidden" name="vendorId" value={vendor.id} />
        <DialogBody>
          <p className="text-sm">{vendor.name}</p>
          <p className="mt-2 text-sm text-muted-foreground">{t('archivingKeepsEveryPastEntry')}</p>
          {state.status === 'error' && (
            <p className="mt-3 text-sm text-destructive" data-testid="vendor-archive-error">
              {state.message}
            </p>
          )}
        </DialogBody>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onCancel} disabled={pending}>
            {t('cancel')}
          </Button>
          <Button
            type="submit"
            variant="destructive"
            disabled={pending}
            data-testid="vendor-archive-confirm"
          >
            {pending ? t('saving') : t('archiveThisVendor')}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}
