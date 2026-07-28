'use client';

import { useActionState } from 'react';
import { recordStockEntryAction, type MovementFormState } from './actions';
import { Button } from '@/components/ui/button';
import { Input, Select, Textarea } from '@/components/ui/input';

const INITIAL: MovementFormState = { status: 'idle' };

export function StockEntryForm({ companyId, prizeId }: { companyId: string; prizeId: string }) {
  const [state, action, pending] = useActionState(recordStockEntryAction, INITIAL);

  return (
    <form action={action} data-testid="stock-entry-form" className="flex flex-col gap-3">
      <input type="hidden" name="companyId" value={companyId} />
      <input type="hidden" name="prizeId" value={prizeId} />

      <label className="flex flex-col gap-1 text-sm">
        Type
        <Select name="entryType" defaultValue="MANUAL_ENTRY">
          <option value="INITIAL_ENTRY">Initial entry</option>
          <option value="PURCHASE_ENTRY">Purchase</option>
          <option value="MANUAL_ENTRY">Manual entry</option>
        </Select>
      </label>

      <label className="flex flex-col gap-1 text-sm">
        Quantity
        <Input name="quantity" type="number" min={1} step={1} required />
      </label>

      <label className="flex flex-col gap-1 text-sm">
        Note
        <Textarea name="note" maxLength={2000} placeholder="Optional" />
      </label>

      <div className="flex items-center gap-3">
        <Button type="submit" disabled={pending}>
          {pending ? 'Saving…' : 'Add stock'}
        </Button>
        {state.status === 'saved' && <p className="text-sm text-emerald-700">Stock added.</p>}
      </div>

      {state.status === 'error' && <p className="text-sm text-destructive">{state.message}</p>}
    </form>
  );
}
