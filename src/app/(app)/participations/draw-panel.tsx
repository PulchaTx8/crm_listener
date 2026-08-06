'use client';

import { useTranslations } from 'next-intl';
import { useState, useTransition } from 'react';
import Link from 'next/link';
import type { Route } from 'next';
import { Button } from '@/components/ui/button';
import { RunDrawDialog } from '@/components/draws/run-draw-dialog';
import type { DrawUnitChoice, DrawUnitRequest } from '@/components/draws/run-draw-dialog';
import type { DrawHat } from '@/services/participations';
import { prepareDrawHatAction, runDrawFromListAction } from './actions';
import type { DrawnWinner } from './actions';
import type { ParticipationListState } from './list-params';

/**
 * The draw, run from the list rather than from the promotion.
 *
 * This is Block 6c's whole shape in one component: a draw is a shuffle over a
 * list somebody filtered and looked at, so the button belongs beside the list
 * and the hat is the rows it is showing.
 *
 * THE HAT IS READ WHEN THIS OPENS, NOT WHEN THE BUTTON IS PRESSED, and the two
 * are different products. Read at press time, the operator would be approving a
 * description — "everyone matching these filters, whoever that turns out to be
 * in a moment" — and an entry recorded while they read the summary would join a
 * draw they never saw it in. Read on opening, the summary states a number and
 * that number is what goes in; anything that has moved since refuses the draw
 * with the sentence run_draw raises (D3), which is a refusal an operator can act
 * on rather than a silent difference.
 */
export function DrawPanel({
  state,
  promotionId,
  promotionName,
  linked,
}: {
  /** The filters exactly as this render was produced from, sent back to collect the same set. */
  state: ParticipationListState;
  /**
   * The same promotion `state.promotionId` names, passed separately because it
   * is the one field this component cannot work without: the page renders this
   * only when a promotion is chosen, and a prop is how that precondition is
   * stated to the compiler rather than asserted away at the two places it is
   * read.
   */
  promotionId: string;
  promotionName: string;
  /** The promotion's live links, already reduced to what is still available. */
  linked: DrawUnitChoice[];
}) {
  const t = useTranslations('participations');
  const [open, setOpen] = useState(false);
  const [hat, setHat] = useState<DrawHat | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [result, setResult] = useState<{ drawId: string; winners: DrawnWinner[] } | null>(null);
  const [loading, startLoading] = useTransition();

  function openPanel() {
    setOpen(true);
    setHat(null);
    setResult(null);
    setMessage(null);
    startLoading(async () => {
      const answer = await prepareDrawHatAction(state);
      if (answer.status === 'error') {
        setMessage(answer.message);
        return;
      }
      setHat(answer.hat);
    });
  }

  async function run(units: DrawUnitRequest[] | null): Promise<string | null> {
    // Not reachable from the dialog while `hat` is null — it is not rendered
    // until the hat is in hand — and checked anyway, because returning "no hat"
    // is cheaper than an empty array reaching run_draw, which reads one as "draw
    // the whole promotion".
    if (!hat) return 'The list has not been read yet. Close this and open it again.';

    const answer = await runDrawFromListAction(promotionId, units, hat.participationIds);
    if (answer.status === 'error') return answer.message;

    setResult({ drawId: answer.drawId, winners: answer.winners });
    return null;
  }

  if (!open) {
    return (
      <Button type="button" onClick={openPanel} data-testid="open-draw-panel">
        {t('draw')}</Button>
    );
  }

  return (
    <div
      className="w-full rounded-lg border p-4"
      data-testid="draw-panel"
      aria-label={`Run a draw in ${promotionName}`}
    >
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 className="font-medium">{t('draw2')}{' '}{promotionName}</h2>
        <Button
          type="button"
          variant="outline"
          onClick={() => setOpen(false)}
          data-testid="close-draw-panel"
        >
          {t('close')}</Button>
      </div>

      {loading && (
        <p className="text-sm text-muted-foreground" data-testid="draw-hat-loading">
          {t('readingTheFilteredList')}</p>
      )}

      {message && (
        <p role="alert" className="text-sm text-destructive" data-testid="draw-panel-error">
          {message}
        </p>
      )}

      {/* The draw's own result, first, because it is what the operator pressed
          the button for. The list behind this panel is NOT re-read — see the
          rule at the top of ./actions.ts — so the winners are named here and the
          draw's own record is one link away. */}
      {result && (
        <div className="space-y-2" data-testid="draw-panel-result">
          <p className="text-sm font-medium">
            {result.winners.length === 1
              ? 'One prize was awarded.'
              : `${result.winners.length} prizes were awarded.`}
          </p>
          <ul className="space-y-1 text-sm">
            {result.winners.map((winner) => (
              <li key={winner.awardedRank} data-testid="draw-panel-winner">
                {winner.prizeName} — {winner.listenerName ?? '—'}
              </li>
            ))}
          </ul>
          <Link
            href={`/promotions/${promotionId}/draws?draw=${result.drawId}` as Route}
            className="text-sm underline underline-offset-2"
            data-testid="draw-panel-record-link"
          >
            {t('openThisDrawSRecord')}</Link>
          <p className="text-xs text-muted-foreground">
            {t('theListBehindThisPanelStill')}</p>
        </div>
      )}

      {hat && !result && (
        <div className="space-y-3">
          {/* The number, and everything the filters matched that a draw cannot
              take. Both exclusions are visible in the list itself — the status
              badge and the "Won here" column — and are counted here so that the
              set the operator approves is a set they were told the size of. */}
          <p className="text-sm" data-testid="draw-hat-summary">
            <strong>{hat.participationIds.length}</strong>{' '}
            {t('entriesLabel', { count: hat.participationIds.length })} {t('inTheHatOutOf')}{' '}
            {hat.matched} {t('matchingTheseFilters')}</p>
          {(hat.alreadyWon > 0 || hat.notValid > 0) && (
            <p className="text-xs text-muted-foreground" data-testid="draw-hat-excluded">
              {t('leftOut')}{' '}
              {[
                hat.alreadyWon > 0
                  ? `${hat.alreadyWon} who already won in this promotion`
                  : null,
                hat.notValid > 0 ? `${hat.notValid} whose entry did not count` : null,
              ]
                .filter(Boolean)
                .join(', ')}
              .
            </p>
          )}

          {hat.participationIds.length === 0 ? (
            <p className="text-sm text-muted-foreground" data-testid="draw-hat-empty">
              {t('nobodyInThisListCanBe')}</p>
          ) : linked.length === 0 ? (
            <p className="text-sm text-muted-foreground" data-testid="draw-nothing-linked">
              {t('thisPromotionHasNoPrizeUnits')}</p>
          ) : (
            <RunDrawDialog linked={linked} onRun={run} />
          )}
        </div>
      )}
    </div>
  );
}
