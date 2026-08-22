'use client';

import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import {
  PageControls,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  // `WinnerActions` itself is no longer imported here: Block 31a moved the strip
  // into `PickupRecordDialog`. What this file still needs is the PREDICATE, to
  // decide whether the pencil that opens that window is drawn at all.
  availableWinnerActions,
  type WinnerAction,
  type WinnerPowers,
} from '@/components/draws/winner-actions';
import { Button } from '@/components/ui/button';
import { ListenerCardDialog } from '@/components/members/listener-card-dialog';
import type { PickupRow } from '@/services/pickups';
import { applyRowPatch, type RowState } from '@/lib/row-patch';
import { Pencil } from 'lucide-react';
import { maskedPhone } from '@/lib/members/mask';
import { PickupRecordDialog } from './pickup-record-dialog';
import { formatInstant } from '../promotions/format';
import { describeDeadline, STATUS_CLASSES, STATUS_LABEL_KEYS } from './list-params';
import type { PickupActionResult } from './actions';
import { ReopenForm } from './reopen-form';
import { HandOverDialog } from './hand-over-dialog';

/** How many columns the empty-state row has to span. */
const COLUMN_COUNT = 6;

/**
 * applyRowPatch (@/lib/row-patch) keys every row on `id`, the shape
 * promotions-grid.tsx, team-grid.tsx and every other patched grid in this
 * codebase already share it over. `winnerId` is this service's own name for
 * the same fact — PickupRow does not rename it just to fit this one helper —
 * so the grid aliases it locally instead of asking the service to.
 */
type PickupGridRow = PickupRow & { id: string };

function toGridRow(row: PickupRow): PickupGridRow {
  return { ...row, id: row.winnerId };
}

/**
 * The pickups list itself: one row per winner across every promotion of the
 * Station, soonest deadline first.
 *
 * A client component, the same trade participations-grid.tsx's own comment
 * states for its screen: what it buys is the row patch below, in place
 * without revalidatePath (actions.ts's own standing rule) — the alternative,
 * re-running the keyset query after every delivery or write-off, would throw
 * away an operator's place in a list they are midway down acting on.
 */
export function PickupsGrid({
  rows: initialRows,
  total: initialTotal,
  timeZone,
  winnerPowers,
  canFindListeners,
  previousHref,
  nextHref,
  onWinnerAction,
  onReopen,
}: {
  rows: PickupRow[];
  total: number;
  timeZone: string;
  winnerPowers: WinnerPowers;
  /** members.view, resolved once by pickups/page.tsx (./access.ts) rather than a second time here. */
  canFindListeners: boolean;
  previousHref: string | null;
  nextHref: string | null;
  onWinnerAction: (
    winnerId: string,
    action: WinnerAction,
    reason: string,
  ) => Promise<PickupActionResult>;
  onReopen: (winnerId: string, deadlineAt: string, reason: string) => Promise<PickupActionResult>;
}) {
  const t = useTranslations('pickups');
  // The shared enum vocabulary, which several screens render.
  const tv = useTranslations('vocab');
  // Only for actionHandOver, which HandOverDialog's own title also reads off
  // this same key -- the trigger below and the window it opens say the same
  // word, deliberately.
  const td = useTranslations('draws');
  const [grid, setGrid] = useState<RowState<PickupGridRow>>({
    rows: initialRows.map(toGridRow),
    total: initialTotal,
  });

  // A navigation hands down a new page: the one moment this screen's position
  // and filter membership are re-evaluated, the same rule promotions-grid.tsx's
  // own effect states (src/lib/row-patch.ts).
  useEffect(() => {
    setGrid({ rows: initialRows.map(toGridRow), total: initialTotal });
  }, [initialRows, initialTotal]);

  const [listenerId, setListenerId] = useState<string | null>(null);

  // The id outlives the row unless something clears it: `listenerId` staying
  // set after its row leaves `grid.rows` (a filter narrowing the page) would
  // reopen the listener card unprompted the moment that filter is cleared
  // again — the same defect participations-grid.tsx:89 documents and fixes
  // with this identical effect.
  useEffect(() => {
    if (listenerId !== null && !grid.rows.some((row) => row.memberId === listenerId)) {
      setListenerId(null);
    }
  }, [grid.rows, listenerId]);

  const [handOverWinnerId, setHandOverWinnerId] = useState<string | null>(null);

  // Block 31a. The pencil's window, on the same shape as Hand over's: only the
  // id lives in state, so the row it shows is read fresh off `grid.rows` on
  // every render and can never drift from the table behind it.
  const [recordWinnerId, setRecordWinnerId] = useState<string | null>(null);

  // And the same guard the two windows above already carry: an id outliving its
  // row (a filter narrowing the page) would reopen this window unprompted the
  // moment that filter was cleared again.
  useEffect(() => {
    if (recordWinnerId !== null && !grid.rows.some((row) => row.winnerId === recordWinnerId)) {
      setRecordWinnerId(null);
    }
  }, [grid.rows, recordWinnerId]);

  // The same defect, on the window this task adds: `handOverWinnerId`
  // staying set after its row leaves `grid.rows` (a filter narrowing the
  // page) would reopen Hand over unprompted the moment that filter is
  // cleared again, exactly as `listenerId` just above.
  useEffect(() => {
    if (handOverWinnerId !== null && !grid.rows.some((row) => row.winnerId === handOverWinnerId)) {
      setHandOverWinnerId(null);
    }
  }, [grid.rows, handOverWinnerId]);

  // Only the id lives in state, the same choice `listenerId` makes above:
  // the row itself is read fresh off `grid.rows` on every render, so the
  // promotion/listener/prize this window shows can never drift from what
  // the table behind it is currently showing for that winner.
  const handOverRow = grid.rows.find((row) => row.winnerId === handOverWinnerId);
  const recordRow = grid.rows.find((row) => row.winnerId === recordWinnerId);

  /**
   * Block 31a, D7. The powers the pencil's window offers, and the ONE predicate
   * that decides whether the pencil is even drawn.
   *
   * `availableWinnerActions` is asked rather than a second rule written beside
   * it: the button must appear exactly when the window behind it would have
   * something to offer, and the strip already knows that — including the case
   * of a cancelled draw, where it offers nothing at all.
   */
  const recordPowers: WinnerPowers = {
    ...winnerPowers,
    deliver: false,
    handOver: false,
    reopenDeadline: false,
  };

  function patch(winnerId: string, next: { status: PickupRow['status']; deadlineAt?: string }) {
    setGrid((current) => {
      const row = current.rows.find((r) => r.winnerId === winnerId);
      if (!row) return current;
      return applyRowPatch(current, {
        kind: 'save',
        row: {
          ...row,
          status: next.status,
          ...(next.deadlineAt !== undefined ? { deadlineAt: next.deadlineAt } : {}),
        },
      });
    });
  }

  async function handleWinnerAction(
    winnerId: string,
    action: WinnerAction,
    reason: string,
  ): Promise<string | null> {
    const result = await onWinnerAction(winnerId, action, reason);
    if (result.status === 'error') return result.message;
    // deadlineAt is deliberately left out of the patch here: none of the four
    // transitions this button reaches may touch it (D3 — only the reopen
    // writes deadline_at), so the row keeps whatever it already had.
    patch(winnerId, { status: result.winnerStatus });
    return null;
  }

  async function handleReopen(
    winnerId: string,
    deadlineAt: string,
    reason: string,
  ): Promise<string | null> {
    const result = await onReopen(winnerId, deadlineAt, reason);
    if (result.status === 'error') return result.message;
    patch(winnerId, { status: result.winnerStatus, deadlineAt: result.deadlineAt ?? deadlineAt });
    return null;
  }

  return (
    <div className="mt-4 rounded-lg border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t('listener')}</TableHead>
            <TableHead>{t('prize')}</TableHead>
            <TableHead>{t('promotion')}</TableHead>
            <TableHead>{t('status')}</TableHead>
            {/* No sort control: listPickups orders by (deadline_at, id)
                ascending, fixed, because that is exactly what list_pickups
                (0095) is written to serve and a keyset cursor must compare
                precisely the columns it orders by — the same reasoning
                participations-grid.tsx states for its own fixed ordering. */}
            <TableHead aria-sort="ascending">{t('deadline')}</TableHead>
            <TableHead>{t('actions')}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {grid.rows.length === 0 ? (
            <TableRow>
              <TableCell colSpan={COLUMN_COUNT} className="py-8 text-center text-muted-foreground">
                {t('noPrizeMatchesTheseFilters')}</TableCell>
            </TableRow>
          ) : (
            grid.rows.map((row) => {
              // Whether reopen and Hand over belong on this row at all — the
              // canonical function, asked with the UNMODIFIED powers, so the
              // rule for "when is X legal" lives in exactly one place rather
              // than being re-derived here. This is the same call `canReopen`
              // alone used to make; `deliver` rides along because the
              // `handOver: false` passed to WinnerActions below only
              // suppresses the generic strip's own button, never what
              // `deliver` is actually legal for.
              const rowActions = availableWinnerActions({
                status: row.status,
                allowsReturnToStock: row.allowsReturnToStock,
                powers: winnerPowers,
                drawStatus: row.drawStatus,
              });
              const canReopen = rowActions.includes('reopen');
              const canDeliver = rowActions.includes('deliver');

              return (
                <TableRow key={row.winnerId} data-testid="pickup-row">
                  <TableCell>
                    {/*
                      A missing name is rendered the same way whatever the
                      reason, the same uniformity participations-grid.tsx
                      keeps for its own listener column: an anonymised
                      listener and a caller who holds promotions.view but not
                      members.view (list_pickups' Rule 2) are indistinguishable
                      from here, on purpose.
                    */}
                    <span className="text-sm">{row.memberName ?? '—'}</span>
                    {row.memberPhoneLast4 && (
                      <span className="mt-0.5 block text-xs text-muted-foreground">
                        {maskedPhone(row.memberPhoneLast4)}
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="text-sm">{row.prizeName}</TableCell>
                  <TableCell className="text-sm">{row.promotionName}</TableCell>
                  <TableCell>
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_CLASSES[row.status]}`}
                      data-testid="pickup-status"
                    >
                      {tv(STATUS_LABEL_KEYS[row.status])}
                    </span>
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-sm" data-testid="pickup-deadline">
                    <DeadlineText deadlineAt={row.deadlineAt} status={row.status} timeZone={timeZone} />
                  </TableCell>
                  <TableCell>
                    {canFindListeners && (
                      <Button
                        key="view-listener"
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => setListenerId(row.memberId)}
                        aria-label={t('openTheMember')}
                        data-testid="pickup-view-listener"
                      >
                        {t('member')}
                      </Button>
                    )}
                    {/* Block 31a, items 3 and 4. The pencil is drawn only when
                        the window behind it would have an action to offer —
                        the same predicate the strip that used to sit here
                        applied to itself. */}
                    {availableWinnerActions({
                      status: row.status,
                      allowsReturnToStock: row.allowsReturnToStock,
                      powers: recordPowers,
                      drawStatus: row.drawStatus,
                    }).length > 0 && (
                      <button
                        type="button"
                        aria-label={t('openThisPrize')}
                        onClick={() => setRecordWinnerId(row.winnerId)}
                        data-testid="pickup-edit"
                        className="rounded-md p-1.5 ring-offset-background hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                      >
                        <Pencil className="size-4" aria-hidden="true" />
                      </button>
                    )}
                    {canDeliver && (
                      <Button
                        key="hand-over"
                        type="button"
                        size="sm"
                        onClick={() => setHandOverWinnerId(row.winnerId)}
                        data-testid="pickup-hand-over"
                      >
                        {td('actionHandOver')}
                      </Button>
                    )}
                    {/*
                      Block 31a, item 5. `WinnerActions` used to sit HERE, and
                      moved into `PickupRecordDialog` behind the pencil above.
                      What moved is where it is mounted: the same component, the
                      same mandatory reason, the same server action, the same
                      audit rows — now under a summary naming the promotion, the
                      prize, the listener and the deadline it would act on.

                      Draws still mounts the strip in its own row layout, where
                      it has always been.
                    */}
                    {canReopen && (
                      <ReopenForm
                        timeZone={timeZone}
                        onReopen={(deadlineAt, reason) => handleReopen(row.winnerId, deadlineAt, reason)}
                      />
                    )}
                  </TableCell>
                </TableRow>
              );
            })
          )}
        </TableBody>
      </Table>

      {listenerId && (
        <ListenerCardDialog memberId={listenerId} onClose={() => setListenerId(null)} />
      )}

      {recordRow && (
        <PickupRecordDialog
          row={recordRow}
          powers={recordPowers}
          timeZone={timeZone}
          onAct={(action, reason) => handleWinnerAction(recordRow.winnerId, action, reason)}
          onClose={() => setRecordWinnerId(null)}
        />
      )}

      {handOverRow && (
        <HandOverDialog
          promotionName={handOverRow.promotionName}
          listenerName={handOverRow.memberName}
          listenerPhoneLast4={handOverRow.memberPhoneLast4}
          prizeName={handOverRow.prizeName}
          onConfirm={(note) => handleWinnerAction(handOverRow.winnerId, 'deliver', note)}
          onClose={() => setHandOverWinnerId(null)}
        />
      )}

      {/*
        `total` is the count of rows matching the same filters, from the same
        query the rows themselves came from (list_pickups' own total_count,
        computed off the identical CTE). It does not change when an action
        patches a row in place — the runbook's "one refresh behind" applies to
        this count too: a delivered prize still counts toward an active
        AWAITING_PICKUP filter's total until the next real navigation.
      */}
      <PageControls
        total={grid.total}
        label={t('prizesLabel', { count: grid.total ?? 0 })}
        previousHref={previousHref}
        nextHref={nextHref}
      />
    </div>
  );
}

/**
 * The deadline column's own text: the actual instant, in the Station's zone,
 * plus the clock's own reading of it (describeDeadline, ./list-params) —
 * "overdue by X" in red whenever the date says so, regardless of whether the
 * sweep has already relabelled the row RETURN_PENDING. Nothing is appended
 * for a resolved winner (describeDeadline's own '—'), so a Delivered row
 * shows only the date it was once due, with no alarm beside it.
 */
function DeadlineText({
  deadlineAt,
  status,
  timeZone,
}: {
  deadlineAt: PickupRow['deadlineAt'];
  status: PickupRow['status'];
  timeZone: string;
}) {
  const t = useTranslations('pickups');
  if (!deadlineAt) return <span>{t('noDeadline')}</span>;

  const clock = describeDeadline(deadlineAt, status, t);
  // Read off the DATE, never off the sentence. This used to be
  // `clock.startsWith('overdue')`, which asked an English question about text
  // the catalogue now answers in three languages — the red would simply have
  // stopped appearing in Portuguese and Spanish, silently.
  const overdue = new Date(deadlineAt).getTime() - Date.now() <= 0;

  return (
    <span>
      {formatInstant(deadlineAt, timeZone)}
      {clock !== '—' && (
        <span
          className={overdue ? 'ml-1 font-medium text-destructive' : 'ml-1 text-muted-foreground'}
          data-testid="pickup-deadline-clock"
        >
          · {clock}
        </span>
      )}
    </span>
  );
}
