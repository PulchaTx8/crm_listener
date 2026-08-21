'use client';

import { useActionState, useEffect, useId, useState } from 'react';
import { useTranslations } from 'next-intl';
import { MoreVertical, Pencil } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuItem } from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import {
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
import { SHOW_TABS } from '@/lib/record-params';
import { SHOW_LIST_MAX } from '@/lib/shows/limits';
import type { Band } from '@/lib/shows/bands';
import type { ShowSummary } from '@/services/shows';
import { endShowAction, type ShowFormState } from './actions';
import { hasActiveShowFilters, showSortHref } from './list-params';
import type { ShowListState } from './list-params';
import { ShowRecordDialog } from './show-record-dialog';

/**
 * Block 18. The programme list, on the shape of `songs-grid.tsx`: a table under
 * a register button, with the record opening as a modal over it and writes
 * patching the row in place.
 *
 * IT NO LONGER PAGES. Block 30e, D1: the screen shows every programme of the
 * Station in both of its views, because a week grid cannot page and two views
 * disagreeing about how many programmes exist is worse than either. `capped`
 * below is the honest half of that promise.
 *
 * Patching rather than re-rendering the route is the same rule songs, inventory
 * and members carry: a fresh render would rebuild the list under whoever was
 * reading it.
 */

/**
 * How many columns the empty row has to span, actions included. A number that
 * has to be raised by hand with every column, or the "no programmes" row stops
 * spanning the table.
 */
const COLUMN_COUNT = 8;

const INITIAL_END: ShowFormState = { status: 'idle' };

export function ShowsGrid({
  initialRows,
  initialTotal,
  state,
  capped,
  manage,
  initialRecord,
}: {
  initialRows: ShowSummary[];
  initialTotal: number;
  state: ShowListState;
  /** D1: whether SHOW_LIST_MAX cut the list. Said on the screen, never swallowed. */
  capped: boolean;
  /** Whether the caller holds music.manage at this Station — a courtesy gate; save_show and end_show re-check it themselves. */
  manage: boolean;
  initialRecord: { recordId: string | null; tab: string | null };
}) {
  const t = useTranslations('shows');
  const [grid, setGrid] = useState<RowState<ShowSummary>>({
    rows: initialRows,
    total: initialTotal,
  });

  // A navigation hands down a new page: the one moment position and filter
  // membership are re-evaluated (src/lib/row-patch.ts).
  useEffect(() => {
    setGrid({ rows: initialRows, total: initialTotal });
  }, [initialRows, initialTotal]);

  const { recordId, open, close } = useRecordDialog(SHOW_TABS, initialRecord);
  const [creating, setCreating] = useState(false);
  const [ending, setEnding] = useState<ShowSummary | null>(null);

  const nameSorted = state.sort === 'name';
  const addedSorted = state.sort === 'created';
  const ariaSort = (sorted: boolean) =>
    sorted ? (state.direction === 'asc' ? 'ascending' : 'descending') : 'none';

  return (
    <>
      {manage && (
        <div className="mt-4 flex flex-wrap justify-end gap-2">
          <Button type="button" onClick={() => setCreating(true)} data-testid="show-add">
            {t('registerAProgramme')}
          </Button>
        </div>
      )}

      <div className="mt-4 rounded-lg border">
        <Table data-testid="shows-table">
          <TableHeader>
            <TableRow>
              {/* No visible label: the pictures are a column beside the names
                  they belong to, and a heading over them would be read aloud on
                  every row for nothing. */}
              <TableHead className="w-12">
                <span className="sr-only">{t('picture')}</span>
              </TableHead>
              <TableHead aria-sort={ariaSort(nameSorted)}>
                <SortLink
                  href={showSortHref(state, 'name')}
                  active={nameSorted}
                  direction={nameSorted ? state.direction : 'asc'}
                >
                  {t('name')}
                </SortLink>
              </TableHead>
              <TableHead>{t('kind')}</TableHead>
              <TableHead>{t('ageRating')}</TableHead>
              <TableHead>{t('schedule')}</TableHead>
              <TableHead>{t('onAir')}</TableHead>
              <TableHead aria-sort={ariaSort(addedSorted)}>
                <SortLink
                  href={showSortHref(state, 'created')}
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
                  data-testid="shows-empty"
                >
                  {hasActiveShowFilters(state) ? t('noProgrammeMatchesTheseFilters') : t('noProgrammesYet')}
                </TableCell>
              </TableRow>
            ) : (
              grid.rows.map((show) => (
                <TableRow key={show.id} data-testid="show-row">
                  <TableCell>
                    {show.thumbUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={show.thumbUrl} alt="" width={32} height={32} className="rounded" />
                    ) : (
                      <span className="block size-8 rounded bg-muted" aria-hidden="true" />
                    )}
                  </TableCell>
                  <TableCell className="font-medium">
                    <span className="flex flex-col gap-1">
                      <span className="flex flex-wrap items-center gap-2">
                        <button
                          type="button"
                          onClick={() => open(show.id)}
                          className="text-left ring-offset-background hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                        >
                          {show.name}
                        </button>
                        {/* D3 and D7: the four programmes that predate this block
                            carry only a name, and this is where an operator
                            learns which half is missing rather than from a
                            document. */}
                        {!show.complete && <Chip testId="show-incomplete">{t('incomplete')}</Chip>}
                        {show.ended && <Chip testId="show-ended">{t('ended')}</Chip>}
                      </span>
                      {show.presenterName && (
                        <span className="text-xs font-normal text-muted-foreground">
                          {show.presenterName}
                        </span>
                      )}
                    </span>
                  </TableCell>
                  <TableCell>{show.kind ? t(`kind_${show.kind}`) : '—'}</TableCell>
                  <TableCell>{show.ageRating ? t(`age_${show.ageRating}`) : '—'}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {show.bands.length > 0 ? <ScheduleSummary bands={show.bands} /> : '—'}
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                    {show.startsOn ?? '—'}
                    {show.endsOn ? ` → ${show.endsOn}` : ''}
                  </TableCell>
                  <TableCell className="whitespace-nowrap">{formatAddedDate(show.createdAt)}</TableCell>
                  <TableCell className="sticky right-0 bg-background">
                    <div className="flex items-center justify-end gap-1">
                      <button
                        type="button"
                        aria-label={t('editProgramme', { name: show.name })}
                        onClick={() => open(show.id)}
                        data-testid="show-edit"
                        className="rounded-md p-1.5 ring-offset-background hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                      >
                        <Pencil className="size-4" aria-hidden="true" />
                      </button>
                      {manage && (
                        <DropdownMenu
                          label={t('actionsForProgramme', { name: show.name })}
                          trigger={<MoreVertical className="size-4" aria-hidden="true" />}
                        >
                          {/* D8's only way out, and the only retiring action
                              there is: nothing pointing at `shows` cascades, so
                              a delete would be refused by the database the
                              moment one request named the programme. */}
                          <DropdownMenuItem onSelect={() => setEnding(show)}>
                            {/* The testid is on the label rather than the item:
                                DropdownMenuItem takes three props and none of
                                them is an attribute bag, and widening a shared
                                primitive for one screen's test is the wrong
                                trade. The click lands on the button either
                                way. */}
                            <span data-testid="show-end">{t('endThisProgramme')}</span>
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

        {/* Block 30e, D1. There is nothing to page through: the count is what
            tells the operator how many programmes there are, and the second line
            appears only when the ceiling cut the list. */}
        <div className="flex flex-wrap items-center justify-between gap-2 border-t px-4 py-3">
          <p className="text-sm text-muted-foreground" data-testid="shows-count">
            {t('programmesLabel', { count: grid.total ?? 0 })}
          </p>
          {capped && (
            <p className="text-sm text-muted-foreground" data-testid="shows-capped">
              {t('showingTheFirstProgrammes', { count: SHOW_LIST_MAX })}
            </p>
          )}
        </div>
      </div>

      <ShowRecordDialog
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
          // A programme just registered has no row to stay open over, and the
          // one it produced is at the top of the list behind this dialog.
          if (created) setCreating(false);
        }}
      />

      {ending && (
        <EndShowDialog
          show={ending}
          onCancel={() => setEnding(null)}
          onEnded={(saved) => {
            setEnding(null);
            setGrid((current) => applyRowPatch(current, { kind: 'save', row: saved }));
          }}
        />
      )}
    </>
  );
}

function Chip({ children, testId }: { children: React.ReactNode; testId: string }) {
  return (
    <span
      className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground"
      data-testid={testId}
    >
      {children}
    </span>
  );
}

/** The day alone, in the runtime's zone — the same disclosed gap songs-grid.tsx's formatAddedDate carries. */
function formatAddedDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-GB', { dateStyle: 'medium' });
}

/**
 * Ending is not deleting, and this dialog exists to say so before it happens: the
 * row stays, its schedule stays, and every request and participation already
 * pointing at the programme keeps pointing at it. What changes is that the
 * widget stops offering it and the list stops showing it.
 */
function EndShowDialog({
  show,
  onCancel,
  onEnded,
}: {
  show: ShowSummary;
  onCancel: () => void;
  onEnded: (show: ShowSummary) => void;
}) {
  const t = useTranslations('shows');
  const titleId = useId();
  const [state, action, pending] = useActionState(endShowAction, INITIAL_END);

  useEffect(() => {
    if (state.status === 'saved' && state.record) onEnded(state.record);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  return (
    <Dialog open onClose={onCancel} labelledBy={titleId} className="max-w-lg">
      <DialogHeader>
        <DialogTitle id={titleId}>{t('endThisProgramme')}</DialogTitle>
      </DialogHeader>
      <form action={action}>
        <input type="hidden" name="showId" value={show.id} />
        <DialogBody>
          <p className="text-sm">{show.name}</p>
          <p className="mt-2 text-sm text-muted-foreground">{t('endingKeepsEveryPastLink')}</p>
          <label className="mt-4 flex max-w-56 flex-col gap-1 text-sm">
            <span className="text-muted-foreground">{t('endsOn')}</span>
            <Input
              type="date"
              name="endsOn"
              defaultValue={show.endsOn ?? ''}
              required
              disabled={pending}
              data-testid="show-end-date"
            />
          </label>
          {state.status === 'error' && (
            <p className="mt-3 text-sm text-destructive" data-testid="show-end-error">
              {state.message}
            </p>
          )}
        </DialogBody>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onCancel} disabled={pending}>
            {t('cancel')}
          </Button>
          <Button type="submit" disabled={pending} data-testid="show-end-confirm">
            {pending ? t('saving') : t('endThisProgramme')}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}

/**
 * "Seg–Sex 10:00–12:30 · Sáb 23:00–02:00".
 *
 * Consecutive days are collapsed into a range because that is how a schedule is
 * read aloud, and because five separate day names in a table cell is a wall.
 */
function ScheduleSummary({ bands }: { bands: Band[] }) {
  const t = useTranslations('shows');

  const short = (day: number) => t(`dayShort_${day}`);

  const describe = (band: Band): string => {
    const days = [...band.days].sort((a, b) => a - b);
    const parts: string[] = [];
    let run: number[] = [];

    const flush = () => {
      if (run.length === 0) return;
      const first = run[0];
      const last = run[run.length - 1];
      if (first === undefined || last === undefined) return;
      parts.push(run.length > 2 ? `${short(first)}–${short(last)}` : run.map(short).join(', '));
      run = [];
    };

    for (const day of days) {
      const previous = run[run.length - 1];
      if (previous !== undefined && day !== previous + 1) flush();
      run.push(day);
    }
    flush();

    return `${parts.join(', ')} ${band.starts}–${band.ends}`;
  };

  return (
    <span className="flex flex-col">
      {bands.map((band, index) => (
        <span key={index}>{describe(band)}</span>
      ))}
    </span>
  );
}
