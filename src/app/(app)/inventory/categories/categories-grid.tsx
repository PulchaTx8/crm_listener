'use client';

import { useActionState, useEffect, useId, useState } from 'react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import type { Route } from 'next';
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
import { PRIZE_CATEGORY_TABS } from '@/lib/record-params';
import type { PrizeCategorySummary } from '@/services/inventory';
import { archivePrizeCategoryAction, type PrizeCategoryArchiveState } from './actions';
import {
  hasActivePrizeCategoryFilters,
  prizeCategorySortHref,
  prizesInCategoryHref,
} from './list-params';
import type { PrizeCategoryListState } from './list-params';
import { CategoryRecordDialog } from './category-record-dialog';

/**
 * Block 26. The category list, on the shape of `vendors-grid.tsx`: a table under a
 * register button, paged by keyset, with the record opening as a modal over it and
 * writes patching the row in place.
 *
 * Patching rather than re-rendering the route is the same rule vendors, shows,
 * songs, inventory and members carry: a fresh render would rebuild the keyset list
 * from page one under whoever was reading it.
 */

/**
 * How many columns the empty row has to span, actions included. A number that has
 * to be raised by hand with every column, or the "no categories" row stops
 * spanning the table.
 */
const COLUMN_COUNT = 4;

const INITIAL_ARCHIVE: PrizeCategoryArchiveState = { status: 'idle' };

export function CategoriesGrid({
  initialRows,
  initialTotal,
  state,
  previousHref,
  nextHref,
  manage,
  initialRecord,
}: {
  initialRows: PrizeCategorySummary[];
  initialTotal: number;
  state: PrizeCategoryListState;
  previousHref: string | null;
  nextHref: string | null;
  /** Whether the caller holds inventory.catalogue at this Station — a courtesy gate; both doors re-check it themselves. */
  manage: boolean;
  initialRecord: { recordId: string | null; tab: string | null };
}) {
  const t = useTranslations('prizeCategories');
  const [grid, setGrid] = useState<RowState<PrizeCategorySummary>>({
    rows: initialRows,
    total: initialTotal,
  });

  // A navigation hands down a new page: the one moment position and filter
  // membership are re-evaluated (src/lib/row-patch.ts).
  useEffect(() => {
    setGrid({ rows: initialRows, total: initialTotal });
  }, [initialRows, initialTotal]);

  const { recordId, open, close } = useRecordDialog(PRIZE_CATEGORY_TABS, initialRecord);
  const [creating, setCreating] = useState(false);
  const [archiving, setArchiving] = useState<PrizeCategorySummary | null>(null);
  /**
   * What the last archive actually did, kept so the operator reads the DOOR's own
   * number rather than the one the confirmation estimated off a row read when the
   * page was. Cleared by the next navigation, along with the rest of the grid.
   */
  const [archived, setArchived] = useState<{ name: string; detached: number } | null>(null);

  useEffect(() => setArchived(null), [initialRows, initialTotal]);

  const nameSorted = state.sort === 'name';
  const addedSorted = state.sort === 'created';
  const ariaSort = (sorted: boolean) =>
    sorted ? (state.direction === 'asc' ? 'ascending' : 'descending') : 'none';

  return (
    <>
      {manage && (
        <div className="mt-4 flex flex-wrap justify-end gap-2">
          <Button type="button" onClick={() => setCreating(true)} data-testid="category-add">
            {t('registerCategory')}
          </Button>
        </div>
      )}

      {archived && (
        <p className="mt-4 text-sm text-muted-foreground" data-testid="category-archived-notice">
          {t('archivedAndUncategorised', { name: archived.name, count: archived.detached })}
        </p>
      )}

      <div className="mt-4 rounded-lg border">
        <Table data-testid="categories-table">
          <TableHeader>
            <TableRow>
              <TableHead aria-sort={ariaSort(nameSorted)}>
                <SortLink
                  href={prizeCategorySortHref(state, 'name')}
                  active={nameSorted}
                  direction={nameSorted ? state.direction : 'asc'}
                >
                  {t('name')}
                </SortLink>
              </TableHead>
              <TableHead className="text-right">{t('prizes')}</TableHead>
              <TableHead aria-sort={ariaSort(addedSorted)}>
                <SortLink
                  href={prizeCategorySortHref(state, 'created')}
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
                  data-testid="categories-empty"
                >
                  {hasActivePrizeCategoryFilters(state)
                    ? t('noCategoryMatchesThisSearch')
                    : t('noCategoriesYet')}
                </TableCell>
              </TableRow>
            ) : (
              grid.rows.map((category) => (
                <TableRow key={category.id} data-testid="category-row">
                  <TableCell className="font-medium">
                    <button
                      type="button"
                      onClick={() => open(category.id)}
                      className="text-left ring-offset-background hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                    >
                      {category.name}
                    </button>
                  </TableCell>
                  <TableCell className="text-right">
                    {/* A count that goes somewhere. The Stock screen filtered to
                        this category IS the list of what wears the label, with the
                        columns and the paging a prize list needs — which is why
                        this record has no second tab of its own. A zero is not a
                        link: there is nothing on the other side of it. */}
                    {category.prizeCount > 0 ? (
                      <Link
                        href={prizesInCategoryHref(state, category.id) as Route}
                        className="underline underline-offset-2 ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                        aria-label={t('showThePrizesIn', { name: category.name })}
                        data-testid="category-prizes-link"
                      >
                        {category.prizeCount}
                      </Link>
                    ) : (
                      <span className="text-muted-foreground">0</span>
                    )}
                  </TableCell>
                  <TableCell className="whitespace-nowrap">{formatAddedDate(category.createdAt)}</TableCell>
                  <TableCell className="sticky right-0 bg-background">
                    <div className="flex items-center justify-end gap-1">
                      <button
                        type="button"
                        aria-label={t('editCategory', { name: category.name })}
                        onClick={() => open(category.id)}
                        data-testid="category-edit"
                        className="rounded-md p-1.5 ring-offset-background hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                      >
                        <Pencil className="size-4" aria-hidden="true" />
                      </button>
                      {manage && (
                        <DropdownMenu
                          label={t('actionsForCategory', { name: category.name })}
                          trigger={<MoreVertical className="size-4" aria-hidden="true" />}
                        >
                          <DropdownMenuItem destructive onSelect={() => setArchiving(category)}>
                            {/* The testid is on the label rather than the item:
                                DropdownMenuItem takes three props and none of them
                                is an attribute bag, and widening a shared primitive
                                for one screen's test is the wrong trade. The click
                                lands on the button either way. */}
                            <span data-testid="category-archive">{t('archiveThisCategory')}</span>
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
          label={t('categoriesLabel', { count: grid.total ?? 0 })}
          previousHref={previousHref}
          nextHref={nextHref}
        />
      </div>

      <CategoryRecordDialog
        open={creating || recordId !== null}
        recordId={creating ? null : recordId}
        companyId={state.companyId}
        manage={manage}
        onClose={() => {
          if (creating) setCreating(false);
          else close();
        }}
        onSaved={(saved, created) => {
          // The archive line belongs to the archive that produced it. Left
          // standing over a fresh registration it reads as a report on THIS
          // write, which it is not.
          setArchived(null);
          setGrid((current) =>
            applyRowPatch(current, created ? { kind: 'create', row: saved } : { kind: 'save', row: saved }),
          );
          // A category just registered has no row to stay open over, and the one
          // it produced is at the top of the list behind this dialog.
          if (created) setCreating(false);
        }}
      />

      {archiving && (
        <ArchiveCategoryDialog
          category={archiving}
          onCancel={() => setArchiving(null)}
          onArchived={(detached) => {
            setArchived({ name: archiving.name, detached });
            setArchiving(null);
            // REMOVED rather than patched, the same as vendors: 0029's select
            // policy filters `deleted_at`, so the row is unreadable the instant it
            // is archived and there is nothing to patch it with.
            setGrid((current) => applyRowPatch(current, { kind: 'remove', id: archiving.id }));
          }}
        />
      )}
    </>
  );
}

/** The day alone, in the runtime's zone — the same disclosed gap vendors-grid.tsx's formatAddedDate carries. */
function formatAddedDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-GB', { dateStyle: 'medium' });
}

/**
 * Archiving is not deleting, and this dialog exists to say what it IS before it
 * happens — which for a category is more than "the picker stops offering it".
 *
 * The prizes wearing the label lose it. `archive_prize_category` (0202) sets their
 * `category_id` to null deliberately, unlike `archive_vendor`, which leaves every
 * entry naming a supplier alone: a movement's supplier is history, a category is a
 * label the screens resolve from the LIVE list, so a prize left pointing at an
 * archived row would read as uncategorised anyway. The count comes off the row, so
 * the operator agrees to a number rather than to a word.
 */
function ArchiveCategoryDialog({
  category,
  onCancel,
  onArchived,
}: {
  category: PrizeCategorySummary;
  onCancel: () => void;
  onArchived: (detached: number) => void;
}) {
  const t = useTranslations('prizeCategories');
  const titleId = useId();
  const [state, action, pending] = useActionState(archivePrizeCategoryAction, INITIAL_ARCHIVE);

  useEffect(() => {
    if (state.status === 'archived') onArchived(state.detached ?? 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  return (
    <Dialog open onClose={onCancel} labelledBy={titleId} className="max-w-lg">
      <DialogHeader>
        <DialogTitle id={titleId}>{t('archiveThisCategory')}</DialogTitle>
      </DialogHeader>
      <form action={action}>
        <input type="hidden" name="categoryId" value={category.id} />
        <DialogBody>
          <p className="text-sm">{category.name}</p>
          <p className="mt-2 text-sm text-muted-foreground" data-testid="category-archive-warning">
            {category.prizeCount > 0
              ? t('thePrizesWearingItBecomeUncategorised', { count: category.prizeCount })
              : t('noPrizeWearsThisLabel')}
          </p>
          {state.status === 'error' && (
            <p className="mt-3 text-sm text-destructive" data-testid="category-archive-error">
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
            data-testid="category-archive-confirm"
          >
            {pending ? t('saving') : t('archiveThisCategory')}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}
