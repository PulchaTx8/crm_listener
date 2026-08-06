'use client';

import { useTranslations } from 'next-intl';
import { useActionState, useEffect } from 'react';
import {
  releaseReservationAction,
  reserveStockAction,
  type MovementFormState,
} from './actions';
import { Button } from '@/components/ui/button';
import { Input, Textarea } from '@/components/ui/input';

const INITIAL: MovementFormState = { status: 'idle' };

/** Asks the record to re-read, so the ledger and the balance show this movement. */
interface MovementReport {
  onRecorded?: () => void;
}

/**
 * Moves available stock into reserved. Both this and ReleaseForm below are
 * gated on the same permission (inventory.reserve — reserve_stock and
 * release_reservation both check it, 0027), so a caller who holds it sees
 * both forms or neither.
 */
export function ReserveForm({
  companyId,
  prizeId,
  onRecorded,
}: { companyId: string; prizeId: string } & MovementReport) {
  const t = useTranslations('inventory');
  const [state, action, pending] = useActionState(reserveStockAction, INITIAL);

  useEffect(() => {
    if (state.status === 'saved') onRecorded?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  return (
    <form action={action} data-testid="reserve-form" className="flex flex-col gap-3">
      <input type="hidden" name="companyId" value={companyId} />
      <input type="hidden" name="prizeId" value={prizeId} />

      <label className="flex flex-col gap-1 text-sm">
        {t('quantity')}<Input name="quantity" type="number" min={1} step={1} required />
      </label>

      <label className="flex flex-col gap-1 text-sm">
        {t('note')}<Textarea name="note" required maxLength={2000} placeholder={t('whatIsThisHeldFor')} />
      </label>

      <div className="flex items-center gap-3">
        <Button type="submit" disabled={pending}>
          {pending ? t('saving') : t('reserveStock')}
        </Button>
        {state.status === 'saved' && <p className="text-sm text-emerald-700">{t('reserved2')}</p>}
      </div>

      {state.status === 'error' && <p className="text-sm text-destructive">{state.message}</p>}
    </form>
  );
}

/** Moves reserved stock back to available. */
export function ReleaseForm({
  companyId,
  prizeId,
  onRecorded,
}: { companyId: string; prizeId: string } & MovementReport) {
  const t = useTranslations('inventory');
  const [state, action, pending] = useActionState(releaseReservationAction, INITIAL);

  useEffect(() => {
    if (state.status === 'saved') onRecorded?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  return (
    <form action={action} data-testid="release-form" className="flex flex-col gap-3">
      <input type="hidden" name="companyId" value={companyId} />
      <input type="hidden" name="prizeId" value={prizeId} />

      <label className="flex flex-col gap-1 text-sm">
        {t('quantity')}<Input name="quantity" type="number" min={1} step={1} required />
      </label>

      <label className="flex flex-col gap-1 text-sm">
        {t('note')}<Textarea name="note" required maxLength={2000} placeholder={t('whyIsThisBeingReleased')} />
      </label>

      <div className="flex items-center gap-3">
        <Button type="submit" disabled={pending}>
          {pending ? t('saving') : t('releaseReservation')}
        </Button>
        {state.status === 'saved' && <p className="text-sm text-emerald-700">{t('released')}</p>}
      </div>

      {state.status === 'error' && <p className="text-sm text-destructive">{state.message}</p>}
    </form>
  );
}
