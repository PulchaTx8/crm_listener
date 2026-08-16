'use client';

import { useTranslations } from 'next-intl';
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
import { ImageThumb } from '@/components/media/image-thumb';
import { useRecordDialog } from '@/hooks/use-record-dialog';
import { applyRowPatch, type RowState } from '@/lib/row-patch';
import { PRIZE_TABS, type PrizeTab } from '@/lib/record-params';
import type { PrizeSummary } from '@/services/inventory';
import { archivePrizeAction, type ArchivePrizeState } from './actions';
import { useCategoryList } from './category-list';
import { formatDate, physicalTotal } from './format';
import { hasActiveInventoryFilters, inventorySortHref } from './list-params';
import type { InventoryListState } from './list-params';
import { PrizeRecordDialog } from './prize-record-dialog';
import { PrizeForm } from './prize-form';

/** How many columns the empty-state row has to span, actions included. */
// Thirteen since Block 14 added the picture. Read by the empty state's colSpan,
// which is why it is a constant rather than a number typed twice.
const COLUMN_COUNT = 13;

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
  powers,
  canLinkPromotion,
  timeZone,
  initialRecord,
}: {
  initialRows: PrizeSummary[];
  initialTotal: number;
  state: InventoryListState;
  previousHref: string | null;
  nextHref: string | null;
  powers: InventoryGridPowers;
  /**
   * promotions.prizes (fix round 1), threaded straight through to
   * PrizeRecordDialog/ReservationsTab — not part of `powers` above, because
   * it is not one of the five inventory codes that interface names.
   */
  canLinkPromotion: boolean;
  /** The selected Station's own zone — threaded to PrizeRecordDialog, whose movement histories render every date in it rather than the reader's own (spec §7). */
  timeZone: string;
  initialRecord: { recordId: string | null; tab: string | null };
}) {
  const t = useTranslations('inventory');
  // Block 26. The shared list, so the Register Prize dialog's own inline
  // registration reaches the record dialog's picker and the filter bar above at
  // once (category-list.tsx says why it is not a prop and not a refresh).
  const { categories } = useCategoryList();
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
  const [creating, setCreating] = useState(false);
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
          {/* ONE BUTTON since Block 26. "Register category" stood beside this one
              until categories got a screen of their own (/inventory/categories);
              it could create a category and nothing else — no list, no rename, no
              way to retire one — and a label an operator can only ever add is a
              label that accumulates into this screen's own filter. Registering one
              mid-prize is still possible, and lives where the need appears: inside
              the dialog below, next to the picker that turned out to be missing
              it. */}
          <Button type="button" onClick={() => setCreating(true)} data-testid="prize-create">
            {t('registerPrize')}</Button>
        </div>
      )}

      <div className="mt-4 rounded-lg border">
        <Table>
          <caption className="px-3 py-2 text-left text-xs text-muted-foreground">
            {t('deliveredIsACumulativeCounterAnd')}</caption>
          <TableHeader>
            <TableRow>
              {/* Labelled for a screen reader rather than left empty: an
                  unlabelled header cell reads as a column with no name, and the
                  pictures themselves carry alt="" because the prize's name is
                  in the very next cell. */}
              <TableHead>
                <span className="sr-only">{t('picture')}</span>
              </TableHead>
              <TableHead aria-sort={ariaSort(nameSorted)}>
                <SortLink
                  href={inventorySortHref(state, 'name')}
                  active={nameSorted}
                  direction={nameSorted ? state.direction : 'asc'}
                >
                  {t('prize')}</SortLink>
              </TableHead>
              <TableHead>{t('code')}</TableHead>
              <TableHead>{t('category')}</TableHead>
              <TableHead aria-sort={ariaSort(addedSorted)}>
                <SortLink
                  href={inventorySortHref(state, 'created')}
                  active={addedSorted}
                  direction={addedSorted ? state.direction : 'desc'}
                >
                  {t('added')}</SortLink>
              </TableHead>
              <TableHead className="text-right">{t('inStock')}</TableHead>
              <TableHead className="text-right">{t('available')}</TableHead>
              <TableHead className="text-right">{t('reserved')}</TableHead>
              <TableHead className="text-right">{t('linked')}</TableHead>
              <TableHead className="text-right">{t('awaitingPickup')}</TableHead>
              <TableHead className="text-right">{t('pendingReturn')}</TableHead>
              <TableHead className="text-right">{t('delivered')}</TableHead>
              <TableHead className="sticky right-0 bg-background text-right">{t('actions')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {grid.rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={COLUMN_COUNT} className="text-sm text-muted-foreground">
                  {hasActiveInventoryFilters(state)
                    ? t('noPrizeMatchesTheseFilters')
                    : t('noPrizesAreRegisteredInThis')}
                </TableCell>
              </TableRow>
            ) : (
              grid.rows.map((prize) => (
                <TableRow key={prize.id} data-testid="prize-row">
                  <TableCell>
                    <ImageThumb url={prize.photoUrl} icon="prize" />
                  </TableCell>
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
                  {/* Translated since Block 26, where it stopped being a rare
                      state: archiving a category takes the label off every prize
                      wearing it, so this cell is now somewhere an operator is
                      deliberately sent — and it was the last English literal on
                      this row. `uncategorised` is the key the picker and the
                      filter beside it already use for the same word. */}
                  <TableCell>
                    {categoryNameById.get(prize.categoryId ?? '') ?? t('uncategorised')}
                  </TableCell>
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
                        aria-label={t('editPrize', { name: prize.name })}
                        onClick={() => open(prize.id, 'data')}
                        className="rounded-md p-1.5 ring-offset-background hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                      >
                        <Pencil className="size-4" aria-hidden="true" />
                      </button>
                      {powers.catalogue && (
                        <DropdownMenu
                          label={t('actionsForPrize', { name: prize.name })}
                          trigger={<MoreVertical className="size-4" aria-hidden="true" />}
                        >
                          <DropdownMenuItem destructive onSelect={() => setArchiving(prize)}>
                            {t('archivePrize')}</DropdownMenuItem>
                        </DropdownMenu>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>

        {/* `?? 0` on the label keeps the old answer: an unknown total read as
            plural before this became an ICU message, and a withheld count
            should not start saying "prize". */}
        <PageControls
          total={grid.total}
          label={t('prizesLabel', { count: grid.total ?? 0 })}
          previousHref={previousHref}
          nextHref={nextHref}
        />
      </div>

      <PrizeRecordDialog
        recordId={recordId}
        tab={(tab as PrizeTab) ?? 'data'}
        categories={categories}
        powers={powers}
        canLinkPromotion={canLinkPromotion}
        timeZone={timeZone}
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

      <CreatePrizeDialog
        open={creating}
        companyId={state.companyId}
        onClose={() => setCreating(false)}
        onPrizeCreated={(prizeId) => {
          setCreating(false);
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
  const t = useTranslations('inventory');
  const titleId = useId();
  const [state, action, pending] = useActionState(archivePrizeAction, INITIAL_ARCHIVE);

  useEffect(() => {
    if (state.status === 'archived') onArchived(prize.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  return (
    <Dialog open onClose={onCancel} labelledBy={titleId} className="max-w-lg">
      <DialogHeader>
        <DialogTitle id={titleId}>{t('archiveThisPrize')}</DialogTitle>
      </DialogHeader>
      <DialogBody>
        <p className="text-sm">
          {prize.name} {t('leavesTheCatalogueAndEveryList')}{' '}
          <strong>{t('thisCannotBeUndoneHere')}</strong> — not by you, not by support. Only direct
          database access can restore it.
        </p>
        <p className="mt-3 text-sm text-muted-foreground">
          {t('itsMovementHistoryStaysInThe')}</p>
        {state.status === 'error' && <p className="mt-3 text-sm text-destructive">{state.message}</p>}
      </DialogBody>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onCancel}>
          {t('cancel')}</Button>
        <form action={action}>
          <input type="hidden" name="prizeId" value={prize.id} />
          <Button type="submit" disabled={pending} data-testid="prize-archive-confirm">
            {pending ? t('archiving') : t('archiveAnyway')}
          </Button>
        </form>
      </DialogFooter>
    </Dialog>
  );
}

/**
 * One thing to register here since Block 26, so the dialog says which one in its
 * title rather than branching on what it was opened for. The category branch it
 * used to carry became `/inventory/categories`; what stayed is the ability to
 * register a category WITHOUT leaving this form, which PrizeForm offers beside
 * the picker itself.
 */
function CreatePrizeDialog({
  open,
  companyId,
  onClose,
  onPrizeCreated,
}: {
  open: boolean;
  companyId: string;
  onClose: () => void;
  onPrizeCreated: (prizeId: string) => void;
}) {
  const t = useTranslations('inventory');
  const titleId = useId();
  return (
    <Dialog open={open} onClose={onClose} labelledBy={titleId}>
      <DialogHeader>
        <DialogTitle id={titleId}>{t('registerAPrize')}</DialogTitle>
      </DialogHeader>
      <DialogBody>
        <PrizeForm companyId={companyId} onCreated={onPrizeCreated} />
      </DialogBody>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose}>
          {t('close')}</Button>
      </DialogFooter>
    </Dialog>
  );
}
