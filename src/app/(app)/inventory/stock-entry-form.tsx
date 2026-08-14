'use client';

import { useTranslations } from 'next-intl';
import { useActionState, useEffect, useRef, useState } from 'react';
import { recordStockEntryAction, type MovementFormState } from './actions';
import { Button } from '@/components/ui/button';
import { Input, Select, Textarea } from '@/components/ui/input';
import type { PrizeBalance } from '@/services/inventory';
import { AdjustmentForm } from './adjustment-form';

const INITIAL: MovementFormState = { status: 'idle' };

type EntryTipo = 'PURCHASE_ENTRY' | 'BARTER_ENTRY' | 'ADJUSTMENT';

/**
 * Compra, Permuta or Ajuste de estoque (design spec §7's Tipo list).
 *
 * "Ajuste de estoque" is NOT an entry (spec §5): it is `adjust_stock`, gated
 * on `inventory.adjust` rather than `inventory.entry`, and it takes a
 * counted total rather than a delta — a Quantidade field that means "how
 * many arrived" cannot hand its number to a door that means "how many there
 * are now". Rather than build a second, narrower counted-figure form here,
 * this component defers to the existing `AdjustmentForm` for that branch —
 * design spec §2's own inventory: "adjustment-form.tsx… move into the new
 * tabs. They are not rewritten." `canAdjust` keeps the option out of the
 * Tipo list entirely for a caller who lacks the permission, the same
 * courtesy `getInventoryPermissions` already gives every other write door on
 * this screen — the backend still refuses it if a stale render slips
 * through (reverse_movement/adjust_stock both re-check `has_permission`
 * against `auth.uid()` in their own body).
 */
export function StockEntryForm({
  companyId,
  prizeId,
  balance,
  canAdjust,
  onRecorded,
}: {
  companyId: string;
  prizeId: string;
  balance: PrizeBalance;
  /** Whether Ajuste de estoque belongs in the Tipo list — inventory.adjust (spec §5/§8), not inventory.entry. */
  canAdjust: boolean;
  /** Asks the record to re-read, so the ledger and the balance show this movement. */
  onRecorded?: () => void;
}) {
  const t = useTranslations('inventory');
  const [tipo, setTipo] = useState<EntryTipo>('PURCHASE_ENTRY');
  const [state, action, pending] = useActionState(recordStockEntryAction, INITIAL);

  // D9: quantity × unit price fills the total, and the operator can
  // overwrite it — real invoices carry freight and discounts. `touched`
  // flips true on the FIRST edit to the total field itself and, once true,
  // the effect below never writes to it again, no matter how many more
  // times quantity or unit price change afterwards: a field that keeps
  // overwriting what someone typed is worse than one that never helps.
  const [quantity, setQuantity] = useState('');
  const [unitAmount, setUnitAmount] = useState('');
  const [totalAmount, setTotalAmount] = useState('');
  const touched = useRef(false);

  // invoiceNumber and note carry no computed logic of their own, but they
  // live inside the SAME conditionally-unmounted branch below (only rendered
  // when tipo !== 'ADJUSTMENT') as quantity/unitAmount/totalAmount above.
  // Left uncontrolled, they would be wiped the instant the operator toggled
  // Tipo to Ajuste and back — the branch unmounts and remounts, and an
  // uncontrolled input has no memory of what was typed before it existed.
  // Lifted here so the whole form behaves one way rather than two: every
  // field in this branch survives a Tipo round trip, not just the three that
  // happened to need state for another reason.
  const [invoiceNumber, setInvoiceNumber] = useState('');
  const [note, setNote] = useState('');

  useEffect(() => {
    if (touched.current) return;
    const q = Number(quantity);
    const u = Number(unitAmount);
    if (quantity.trim() === '' || unitAmount.trim() === '' || !Number.isFinite(q) || !Number.isFinite(u)) {
      setTotalAmount('');
      return;
    }
    setTotalAmount((q * u).toFixed(2));
  }, [quantity, unitAmount]);

  useEffect(() => {
    if (state.status !== 'saved') return;
    onRecorded?.();
    // These three are controlled, so a successful submission has to clear
    // them itself — an uncontrolled field resets with the form; a controlled
    // one only shows whatever this component last told it to.
    setQuantity('');
    setUnitAmount('');
    setTotalAmount('');
    setInvoiceNumber('');
    setNote('');
    touched.current = false;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  return (
    <div className="flex flex-col gap-3">
      <label className="flex flex-col gap-1 text-sm">
        {t('entryType')}
        <Select value={tipo} onChange={(event) => setTipo(event.target.value as EntryTipo)}>
          <option value="PURCHASE_ENTRY">{t('entryPurchase')}</option>
          <option value="BARTER_ENTRY">{t('entryBarter')}</option>
          {canAdjust && <option value="ADJUSTMENT">{t('stockAdjustment')}</option>}
        </Select>
      </label>

      {tipo === 'ADJUSTMENT' ? (
        <AdjustmentForm companyId={companyId} prizeId={prizeId} balance={balance} onRecorded={onRecorded} />
      ) : (
        <form action={action} data-testid="stock-entry-form" className="flex flex-col gap-3">
          <input type="hidden" name="companyId" value={companyId} />
          <input type="hidden" name="prizeId" value={prizeId} />
          <input type="hidden" name="entryType" value={tipo} />

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
            {t('invoiceNumber')}
            <Input
              name="invoiceNumber"
              maxLength={80}
              placeholder={t('optional')}
              value={invoiceNumber}
              onChange={(event) => setInvoiceNumber(event.target.value)}
            />
          </label>

          <label className="flex flex-col gap-1 text-sm">
            {t('unitAmount')}
            <Input
              name="unitAmount"
              type="number"
              min={0}
              step="0.01"
              value={unitAmount}
              onChange={(event) => setUnitAmount(event.target.value)}
            />
          </label>

          <label className="flex flex-col gap-1 text-sm">
            {t('totalAmount')}
            <Input
              name="totalAmount"
              type="number"
              min={0}
              step="0.01"
              value={totalAmount}
              onChange={(event) => {
                touched.current = true;
                setTotalAmount(event.target.value);
              }}
            />
          </label>

          <label className="flex flex-col gap-1 text-sm">
            {t('note')}
            <Textarea
              name="note"
              maxLength={2000}
              placeholder={t('optional')}
              value={note}
              onChange={(event) => setNote(event.target.value)}
            />
          </label>

          <div className="flex items-center gap-3">
            <Button type="submit" disabled={pending}>
              {pending ? t('saving') : t('addStock')}
            </Button>
            {state.status === 'saved' && <p className="text-sm text-emerald-700">{t('stockAdded')}</p>}
          </div>

          {state.status === 'error' && <p className="text-sm text-destructive">{state.message}</p>}
        </form>
      )}
    </div>
  );
}
