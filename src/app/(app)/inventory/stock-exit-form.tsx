'use client';

import { useActionState } from 'react';
import { recordStockExitAction, type MovementFormState } from './actions';
import { Button } from '@/components/ui/button';
import { Input, Textarea } from '@/components/ui/input';

const INITIAL: MovementFormState = { status: 'idle' };

export function StockExitForm({ companyId, prizeId }: { companyId: string; prizeId: string }) {
  const [state, action, pending] = useActionState(recordStockExitAction, INITIAL);

  return (
    <form action={action} data-testid="stock-exit-form" className="flex flex-col gap-3">
      <input type="hidden" name="companyId" value={companyId} />
      <input type="hidden" name="prizeId" value={prizeId} />

      <label className="flex flex-col gap-1 text-sm">
        Quantity
        <Input name="quantity" type="number" min={1} step={1} required />
      </label>

      <label className="flex flex-col gap-1 text-sm">
        Note
        <Textarea name="note" required maxLength={2000} placeholder="Why is this leaving stock?" />
      </label>

      <div className="flex items-center gap-3">
        <Button type="submit" disabled={pending}>
          {pending ? 'Saving…' : 'Record exit'}
        </Button>
        {state.status === 'saved' && <p className="text-sm text-emerald-700">Exit recorded.</p>}
      </div>

      {state.status === 'error' && <p className="text-sm text-destructive">{state.message}</p>}
    </form>
  );
}
