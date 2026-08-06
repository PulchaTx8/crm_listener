'use client';

import { useTranslations } from 'next-intl';
import { useActionState, useEffect } from 'react';
import { adjustStockAction, type AdjustmentFormState } from './actions';
import { Button } from '@/components/ui/button';
import { Input, Textarea } from '@/components/ui/input';
import type { PrizeBalance } from '@/services/inventory';
import { physicalTotal } from './format';

const INITIAL: AdjustmentFormState = { status: 'idle' };

/**
 * Asks for the counted figure, never a delta — someone reconciling with a
 * shelf counts what is there; making them compute a difference against a
 * number they may not even have in front of them is how the sign gets
 * inverted. adjust_stock (0030) derives ADJUSTMENT_POSITIVE/NEGATIVE itself
 * from this figure against the current available/committed figures, so this
 * form never does that arithmetic.
 *
 * `counted` means the PHYSICAL total: everything on the shelf, reserved units
 * included (design spec §4 puts reserved inside the physical total — a
 * reservation commits units, it does not remove them from the Station).
 * Before 0030 this form already said "what is actually on the shelf right
 * now," but adjust_stock only reconciled `available` against that figure —
 * an operator who correctly counted reserved stock along with everything
 * else had their honest count read as an increase to `available` alone,
 * inventing units that were never missing (branch-level review, Critical).
 * The RPC now matches what this form has always told the operator to do.
 *
 * `BalanceStats` renders above this form on the prize detail page but this
 * form never referenced it — the person had no way to see what the system
 * currently believes before overwriting it. The two figures below (physical
 * total, committed) are read from the same `balance` prop that page passes
 * to `BalanceStats`, so the two can never silently disagree.
 */
export function AdjustmentForm({
  companyId,
  prizeId,
  balance,
  onRecorded,
}: {
  companyId: string;
  prizeId: string;
  balance: PrizeBalance;
  /** Asks the record to re-read, so the ledger and the balance show this movement. */
  onRecorded?: () => void;
}) {
  const t = useTranslations('inventory');
  const [state, action, pending] = useActionState(adjustStockAction, INITIAL);

  useEffect(() => {
    if (state.status === 'saved') onRecorded?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  const physical = physicalTotal(balance);
  const committed = balance.reserved + balance.linked + balance.awaitingPickup + balance.pendingReturn;

  return (
    <form action={action} data-testid="adjustment-form" className="flex flex-col gap-3">
      <input type="hidden" name="companyId" value={companyId} />
      <input type="hidden" name="prizeId" value={prizeId} />

      <p className="text-xs text-muted-foreground">
        {t('theSystemCurrentlyShows')}{' '}<strong>{physical}</strong> {t('unitSPhysicallyInTheStation')}{' '}<strong>{committed}</strong> {t('unitSAreAlreadyCommittedReserved')}</p>

      <label className="flex flex-col gap-1 text-sm">
        {t('countedFigure')}<Input name="counted" type="number" min={0} step={1} required />
        <span className="text-xs text-muted-foreground">
          {t('countEverythingPhysicallyPresentInThe')}</span>
      </label>

      <label className="flex flex-col gap-1 text-sm">
        {t('note')}<Textarea name="note" required maxLength={2000} placeholder={t('whyDoesTheCountDiffer')} />
      </label>

      <div className="flex items-center gap-3">
        <Button type="submit" disabled={pending}>
          {pending ? t('saving') : t('adjustStock')}
        </Button>
        {state.status === 'saved' && (
          <p className="text-sm text-emerald-700">{t('adjustmentRecorded')}</p>
        )}
        {state.status === 'no_change' && (
          <p className="text-sm text-muted-foreground">{state.message}</p>
        )}
      </div>

      {state.status === 'error' && <p className="text-sm text-destructive">{state.message}</p>}
    </form>
  );
}
