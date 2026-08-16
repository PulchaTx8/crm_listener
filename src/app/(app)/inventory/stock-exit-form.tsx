'use client';

import { useTranslations } from 'next-intl';
import { useActionState, useEffect, useState } from 'react';
import { recordStockExitAction, type MovementFormState } from './actions';
import { Button } from '@/components/ui/button';
import { Input, Select, Textarea } from '@/components/ui/input';
import type { PrizeBalance } from '@/services/inventory';
import { AdjustmentForm } from './adjustment-form';

const INITIAL: MovementFormState = { status: 'idle' };

type ExitTipo = 'TRANSFER_EXIT' | 'ADJUSTMENT';

/**
 * Envio para outra emissora or Ajuste de estoque (design spec §7's Tipo
 * list) — "Registrar saída" always writes `TRANSFER_EXIT`; the old
 * unlabelled `MANUAL_EXIT` default this form used to leave implicit is no
 * longer reachable from here, on the owner's own list.
 *
 * Ajuste routes to `adjust_stock`, not to this door — see
 * stock-entry-form.tsx's own header for why this defers to the existing
 * `AdjustmentForm` instead of reimplementing that door's counted-figure form.
 */
export function StockExitForm({
  companyId,
  prizeId,
  balance,
  canAdjust,
  onRecorded,
}: {
  companyId: string;
  prizeId: string;
  balance: PrizeBalance;
  /** Whether Ajuste de estoque belongs in the Tipo list — inventory.adjust (spec §5/§8), not inventory.exit. */
  canAdjust: boolean;
  /** Asks the record to re-read, so the ledger and the balance show this movement. */
  onRecorded?: () => void;
}) {
  const t = useTranslations('inventory');
  const [tipo, setTipo] = useState<ExitTipo>('TRANSFER_EXIT');
  const [state, action, pending] = useActionState(recordStockExitAction, INITIAL);

  // Lifted for the same reason stock-entry-form.tsx lifts its own fields:
  // quantity and note live inside the conditionally-unmounted branch below
  // (only rendered when tipo !== 'ADJUSTMENT'). Left uncontrolled, toggling
  // Tipo to Ajuste and back would silently discard whatever was typed —
  // the branch unmounts and remounts, and an uncontrolled input has no
  // memory of what was there before it existed.
  const [quantity, setQuantity] = useState('');
  const [note, setNote] = useState('');

  useEffect(() => {
    if (state.status !== 'saved') return;
    onRecorded?.();
    setQuantity('');
    setNote('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  return (
    <div className="flex flex-col gap-3">
      <label className="flex flex-col gap-1 text-sm">
        {t('entryType')}
        <Select value={tipo} onChange={(event) => setTipo(event.target.value as ExitTipo)}>
          <option value="TRANSFER_EXIT">{t('exitTransfer')}</option>
          {canAdjust && <option value="ADJUSTMENT">{t('stockAdjustment')}</option>}
        </Select>
      </label>

      {tipo === 'ADJUSTMENT' ? (
        <AdjustmentForm companyId={companyId} prizeId={prizeId} balance={balance} onRecorded={onRecorded} />
      ) : (
        <form action={action} data-testid="stock-exit-form" className="flex flex-col gap-3">
          <input type="hidden" name="companyId" value={companyId} />
          <input type="hidden" name="prizeId" value={prizeId} />
          <input type="hidden" name="type" value="TRANSFER_EXIT" />

          <label className="flex flex-col gap-1 text-sm">
            {t('quantity')}
            <Input
              name="quantity"
              type="number"
              min={1}
              step={1}
              required
              value={quantity}
              onChange={(event) => setQuantity(event.target.value)}
            />
          </label>

          <label className="flex flex-col gap-1 text-sm">
            {t('note')}
            <Textarea
              name="note"
              required
              maxLength={2000}
              placeholder={t('whyIsThisLeavingStock')}
              value={note}
              onChange={(event) => setNote(event.target.value)}
            />
          </label>

          <div className="flex items-center gap-3">
            <Button type="submit" disabled={pending}>
              {pending ? t('saving') : t('recordExit')}
            </Button>
            {state.status === 'saved' && <p className="text-sm text-success">{t('exitRecorded')}</p>}
          </div>

          {state.status === 'error' && <p className="text-sm text-destructive">{state.message}</p>}
        </form>
      )}
    </div>
  );
}
