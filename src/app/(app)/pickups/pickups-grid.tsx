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
  availableWinnerActions,
  WinnerActions,
  type WinnerAction,
  type WinnerPowers,
} from '@/components/draws/winner-actions';
import { Button } from '@/components/ui/button';
import { ListenerCardDialog } from '@/components/members/listener-card-dialog';
import type { PickupRow } from '@/services/pickups';
import { applyRowPatch, type RowState } from '@/lib/row-patch';
import { maskedPhone } from '@/lib/members/mask';
import { formatInstant } from '../promotions/format';
import { describeDeadline, STATUS_CLASSES, STATUS_LABEL_KEYS } from './list-params';
import type { PickupActionResult } from './actions';
import { ReopenForm } from './reopen-form';

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
              // Whether the reopen belongs on this row at all — the same
              // canonical function the generic button beneath uses, asked
              // once more so the rule for "when is reopen legal" lives in
              // exactly one place rather than being re-derived here.
              const canReopen = availableWinnerActions({
                status: row.status,
                allowsReturnToStock: row.allowsReturnToStock,
                powers: winnerPowers,
                drawStatus: row.drawStatus,
              }).includes('reopen');

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
                        aria-label={t('viewTheListener')}
                        data-testid="pickup-view-listener"
                      >
                        {t('view')}
                      </Button>
                    )}
                    <WinnerActions
                      status={row.status}
                      allowsReturnToStock={row.allowsReturnToStock}
                      // reopenDeadline forced false: this generic reason-only
                      // confirm row has no field for the new deadline
                      // reopen_pickup_deadline needs. ReopenForm below is what
                      // actually offers it — the same courtesy draws/page.tsx
                      // already uses to keep this exact button off a screen
                      // with no date field.
                      powers={{ ...winnerPowers, reopenDeadline: false }}
                      drawStatus={row.drawStatus}
                      onAct={(action, reason) => handleWinnerAction(row.winnerId, action, reason)}
                    />
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
