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
          state={state}
          onCancel={() => setArchiving(null)}
          onArchived={() => {
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
 * Archiving is REFUSED while a live prize still wears the label — the owner's
 * ruling of 2026-08-16 — so this dialog has two faces rather than one.
 *
 * With prizes on it, there is nothing to confirm: it says how many, points at
 * them, and offers no destructive button at all. Rendering a button that the
 * database will decline is a worse screen than not rendering it, and the
 * remedy — move them to another category — is somebody's decision per prize,
 * which is the maintenance screen still to be built.
 *
 * With none, it is an ordinary confirmation. Archiving is not deleting: the row
 * stays and nothing that ever named it is rewritten. What changes is that the
 * picker and the filter stop offering it.
 *
 * THE COUNT ON THE ROW IS A COURTESY, NOT THE GATE. It was read when the page
 * was, so somebody may have moved a prize into this category since — which is
 * why the refusal branch below still renders `state.message`: on that race the
 * door declines a submission this dialog thought was safe, and its sentence
 * carries the real count.
 */
function ArchiveCategoryDialog({
  category,
  state: listState,
  onCancel,
  onArchived,
}: {
  category: PrizeCategorySummary;
  /** For the link to the prizes that are blocking this, which live on Stock. */
  state: PrizeCategoryListState;
  onCancel: () => void;
  onArchived: () => void;
}) {
  const t = useTranslations('prizeCategories');
  const titleId = useId();
  const [state, action, pending] = useActionState(archivePrizeCategoryAction, INITIAL_ARCHIVE);
  const blocked = category.prizeCount > 0;

  useEffect(() => {
    if (state.status === 'archived') onArchived();
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
            {blocked
              ? t('moveThePrizesOffItFirst', { count: category.prizeCount })
              : t('archivingKeepsEveryPastRecord')}
          </p>
          {blocked && (
            <Link
              href={prizesInCategoryHref(listState, category.id) as Route}
              className="mt-2 inline-block text-sm text-primary underline underline-offset-2"
              data-testid="category-archive-prizes-link"
            >
              {t('showThePrizesIn', { name: category.name })}
            </Link>
          )}
          {state.status === 'error' && (
            <p className="mt-3 text-sm text-destructive" data-testid="category-archive-error">
              {state.message}
            </p>
          )}
        </DialogBody>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onCancel} disabled={pending}>
            {blocked ? t('close') : t('cancel')}
          </Button>
          {/* Absent, not disabled, when prizes block it: a greyed-out button
              invites a hover looking for a reason, and the reason is already the
              sentence above it. */}
          {!blocked && (
            <Button
              type="submit"
              variant="destructive"
              disabled={pending}
              data-testid="category-archive-confirm"
            >
              {pending ? t('saving') : t('archiveThisCategory')}
            </Button>
          )}
        </DialogFooter>
      </form>
    </Dialog>
  );
}
