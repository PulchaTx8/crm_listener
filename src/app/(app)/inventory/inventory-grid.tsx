'use client';

import { useActionState, useEffect, useId, useRef, useState } from 'react';
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
import { PRIZE_TABS, type PrizeTab } from '@/lib/record-params';
import type { PrizeCategorySummary, PrizeSummary } from '@/services/inventory';
import { archivePrizeAction, type ArchivePrizeState } from './actions';
import { CategoryForm } from './category-form';
import { formatDate, physicalTotal } from './format';
import { hasActiveInventoryFilters, inventorySortHref } from './list-params';
import type { InventoryListState } from './list-params';
import { PrizeRecordDialog } from './prize-record-dialog';
import { PrizeForm } from './prize-form';

/** How many columns the empty-state row has to span, actions included. */
const COLUMN_COUNT = 12;

export interface InventoryGridPowers {
  catalogue: boolean;
  entry: boolean;
  exit: boolean;
  adjust: boolean;
  reserve: boolean;
}

const INITIAL_ARCHIVE: ArchivePrizeState = { status: 'idle' };

export function InventoryGrid({
  initialRows,
  initialTotal,
  state,
  previousHref,
  nextHref,
  categories,
  powers,
  initialRecord,
}: {
  initialRows: PrizeSummary[];
  initialTotal: number;
  state: InventoryListState;
  previousHref: string | null;
  nextHref: string | null;
  categories: PrizeCategorySummary[];
  powers: InventoryGridPowers;
  initialRecord: { recordId: string | null; tab: string | null };
}) {
  const [grid, setGrid] = useState<RowState<PrizeSummary>>({
    rows: initialRows,
    total: initialTotal,
  });

  // A navigation hands down a new page: the one moment position and filter
  // membership are re-evaluated (src/lib/row-patch.ts).
  useEffect(() => {
    setGrid({ rows: initialRows, total: initialTotal });
  }, [initialRows, initialTotal]);

  const { recordId, tab, open, setTab, close } = useRecordDialog(PRIZE_TABS, initialRecord);
  const [archiving, setArchiving] = useState<PrizeSummary | null>(null);
  const [creating, setCreating] = useState<'prize' | 'category' | null>(null);
  /** The prize whose record was opened because it had just been registered. */
  const pendingCreate = useRef<string | null>(null);

  const categoryNameById = new Map(categories.map((c) => [c.id, c.name]));
  const nameSorted = state.sort === 'name';
  const addedSorted = state.sort === 'created';
  const ariaSort = (sorted: boolean) =>
    sorted ? (state.direction === 'asc' ? 'ascending' : 'descending') : 'none';

  return (
    <>
      {powers.catalogue && (
        <div className="mt-4 flex flex-wrap justify-end gap-2">
          {/* Two buttons rather than a menu hiding one of them: a Station has
              two creatable things and neither is the other's afterthought. */}
          <Button type="button" variant="outline" onClick={() => setCreating('category')}>
            Register category
          </Button>
          <Button type="button" onClick={() => setCreating('prize')} data-testid="prize-create">
            Register prize
          </Button>
        </div>
      )}

      <div className="mt-4 rounded-lg border">
        <Table>
          <caption className="px-3 py-2 text-left text-xs text-muted-foreground">
            Delivered is a cumulative counter and sits outside physical stock, as does written
            off, which this table leaves to each prize&apos;s own record.
          </caption>
          <TableHeader>
            <TableRow>
              <TableHead aria-sort={ariaSort(nameSorted)}>
                <SortLink
                  href={inventorySortHref(state, 'name')}
                  active={nameSorted}
                  direction={nameSorted ? state.direction : 'asc'}
                >
                  Prize
                </SortLink>
              </TableHead>
              <TableHead>Code</TableHead>
              <TableHead>Category</TableHead>
              <TableHead aria-sort={ariaSort(addedSorted)}>
                <SortLink
                  href={inventorySortHref(state, 'created')}
                  active={addedSorted}
                  direction={addedSorted ? state.direction : 'desc'}
                >
                  Added
                </SortLink>
              </TableHead>
              <TableHead className="text-right">In stock</TableHead>
              <TableHead className="text-right">Available</TableHead>
              <TableHead className="text-right">Reserved</TableHead>
              <TableHead className="text-right">Linked</TableHead>
              <TableHead className="text-right">Awaiting pickup</TableHead>
              <TableHead className="text-right">Pending return</TableHead>
              <TableHead className="text-right">Delivered</TableHead>
              <TableHead className="sticky right-0 bg-background text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {grid.rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={COLUMN_COUNT} className="text-sm text-muted-foreground">
                  {hasActiveInventoryFilters(state)
                    ? 'No prize matches these filters.'
                    : 'No prizes are registered in this Station yet.'}
                </TableCell>
              </TableRow>
            ) : (
              grid.rows.map((prize) => (
                <TableRow key={prize.id} data-testid="prize-row">
                  <TableCell className="font-medium">
                    <button
                      type="button"
                      onClick={() => open(prize.id)}
                      className="text-left ring-offset-background hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                    >
                      {prize.name}
                    </button>
                  </TableCell>
                  <TableCell>{prize.internalCode ?? '—'}</TableCell>
                  <TableCell>{categoryNameById.get(prize.categoryId ?? '') ?? 'Uncategorised'}</TableCell>
                  <TableCell>{formatDate(prize.createdAt)}</TableCell>
                  <TableCell className="text-right font-semibold">{physicalTotal(prize.balance)}</TableCell>
                  <TableCell className="text-right">{prize.balance.available}</TableCell>
                  <TableCell className="text-right">{prize.balance.reserved}</TableCell>
                  <TableCell className="text-right">{prize.balance.linked}</TableCell>
                  <TableCell className="text-right">{prize.balance.awaitingPickup}</TableCell>
                  <TableCell className="text-right">{prize.balance.pendingReturn}</TableCell>
                  <TableCell className="text-right">{prize.balance.delivered}</TableCell>
                  <TableCell className="sticky right-0 bg-background">
                    <div className="flex items-center justify-end gap-1">
                      <button
                        type="button"
                        aria-label={`Edit ${prize.name}`}
                        onClick={() => open(prize.id, 'data')}
                        className="rounded-md p-1.5 ring-offset-background hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                      >
                        <Pencil className="size-4" aria-hidden="true" />
                      </button>
                      {powers.catalogue && (
                        <DropdownMenu
                          label={`Actions for ${prize.name}`}
                          trigger={<MoreVertical className="size-4" aria-hidden="true" />}
                        >
                          <DropdownMenuItem destructive onSelect={() => setArchiving(prize)}>
                            Archive prize…
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
          label={grid.total === 1 ? 'prize' : 'prizes'}
          previousHref={previousHref}
          nextHref={nextHref}
        />
      </div>

      <PrizeRecordDialog
        recordId={recordId}
        tab={(tab as PrizeTab) ?? 'data'}
        categories={categories}
        powers={powers}
        onTab={setTab}
        onClose={close}
        onSaved={(prize) => setGrid((current) => applyRowPatch(current, { kind: 'save', row: prize }))}
        onLoaded={(prize) => {
          // A prize registered a moment ago: its record was opened on the id
          // the create returned, and the row comes from that read. One read
          // rather than two, and the balance on the row is the one the ledger
          // reports rather than a zero assumed here.
          if (pendingCreate.current !== prize.id) return;
          pendingCreate.current = null;
          setGrid((current) => applyRowPatch(current, { kind: 'create', row: prize }));
        }}
      />

      {archiving && (
        <ArchivePrizeDialog
          prize={archiving}
          onCancel={() => setArchiving(null)}
          onArchived={(id) => {
            setArchiving(null);
            setGrid((current) => applyRowPatch(current, { kind: 'remove', id }));
          }}
        />
      )}

      <CreateDialog
        creating={creating}
        companyId={state.companyId}
        categories={categories}
        onClose={() => setCreating(null)}
        onPrizeCreated={(prizeId) => {
          setCreating(null);
          pendingCreate.current = prizeId;
          open(prizeId);
        }}
      />
    </>
  );
}

/**
 * The same sentence the audience screen uses, and true for the same reason:
 * prizes_select_inventory_view (0029) carries `deleted_at is null`, so an
 * archived prize is unreadable through RLS for every caller. Nothing in this
 * app can list it or restore it afterwards.
 */
function ArchivePrizeDialog({
  prize,
  onCancel,
  onArchived,
}: {
  prize: PrizeSummary;
  onCancel: () => void;
  onArchived: (id: string) => void;
}) {
  const titleId = useId();
  const [state, action, pending] = useActionState(archivePrizeAction, INITIAL_ARCHIVE);

  useEffect(() => {
    if (state.status === 'archived') onArchived(prize.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  return (
    <Dialog open onClose={onCancel} labelledBy={titleId} className="max-w-lg">
      <DialogHeader>
        <DialogTitle id={titleId}>Archive this prize?</DialogTitle>
      </DialogHeader>
      <DialogBody>
        <p className="text-sm">
          {prize.name} leaves the catalogue and every list in the app.{' '}
          <strong>This cannot be undone here</strong> — not by you, not by support. Only direct
          database access can restore it.
        </p>
        <p className="mt-3 text-sm text-muted-foreground">
          Its movement history stays in the ledger; what disappears is the prize itself.
        </p>
        {state.status === 'error' && <p className="mt-3 text-sm text-destructive">{state.message}</p>}
      </DialogBody>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <form action={action}>
          <input type="hidden" name="prizeId" value={prize.id} />
          <Button type="submit" disabled={pending} data-testid="prize-archive-confirm">
            {pending ? 'Archiving…' : 'Archive anyway'}
          </Button>
        </form>
      </DialogFooter>
    </Dialog>
  );
}

function CreateDialog({
  creating,
  companyId,
  categories,
  onClose,
  onPrizeCreated,
}: {
  creating: 'prize' | 'category' | null;
  companyId: string;
  categories: PrizeCategorySummary[];
  onClose: () => void;
  onPrizeCreated: (prizeId: string) => void;
}) {
  const titleId = useId();
  return (
    <Dialog open={creating !== null} onClose={onClose} labelledBy={titleId}>
      <DialogHeader>
        <DialogTitle id={titleId}>
          {creating === 'category' ? 'Register a category' : 'Register a prize'}
        </DialogTitle>
      </DialogHeader>
      <DialogBody>
        {creating === 'category' ? (
          <CategoryForm companyId={companyId} />
        ) : (
          <PrizeForm companyId={companyId} categories={categories} onCreated={onPrizeCreated} />
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
