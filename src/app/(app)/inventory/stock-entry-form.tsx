'use client';

import { useTranslations } from 'next-intl';
import { useActionState, useEffect } from 'react';
import { recordStockEntryAction, type MovementFormState } from './actions';
import { Button } from '@/components/ui/button';
import { Input, Select, Textarea } from '@/components/ui/input';

const INITIAL: MovementFormState = { status: 'idle' };

export function StockEntryForm({
  companyId,
  prizeId,
  onRecorded,
}: {
  companyId: string;
  prizeId: string;
  /** Asks the record to re-read, so the ledger and the balance show this movement. */
  onRecorded?: () => void;
}) {
  const t = useTranslations('inventory');
  const [state, action, pending] = useActionState(recordStockEntryAction, INITIAL);

  useEffect(() => {
    if (state.status === 'saved') onRecorded?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  return (
    <form action={action} data-testid="stock-entry-form" className="flex flex-col gap-3">
      <input type="hidden" name="companyId" value={companyId} />
      <input type="hidden" name="prizeId" value={prizeId} />

      <label className="flex flex-col gap-1 text-sm">
        {t('type')}<Select name="entryType" defaultValue="MANUAL_ENTRY">
          <option value="INITIAL_ENTRY">{t('initialEntry')}</option>
          <option value="PURCHASE_ENTRY">{t('purchase')}</option>
          <option value="MANUAL_ENTRY">{t('manualEntry')}</option>
        </Select>
      </label>

      <label className="flex flex-col gap-1 text-sm">
        {t('quantity')}<Input name="quantity" type="number" min={1} step={1} required />
      </label>

      <label className="flex flex-col gap-1 text-sm">
        {t('note')}<Textarea name="note" maxLength={2000} placeholder={t('optional')} />
      </label>

      <div className="flex items-center gap-3">
        <Button type="submit" disabled={pending}>
          {pending ? t('saving') : t('addStock')}
        </Button>
        {state.status === 'saved' && <p className="text-sm text-emerald-700">{t('stockAdded')}</p>}
      </div>

      {state.status === 'error' && <p className="text-sm text-destructive">{state.message}</p>}
    </form>
  );
}
