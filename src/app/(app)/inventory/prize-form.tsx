'use client';

import { useActionState } from 'react';
import { createPrizeAction, type PrizeFormState } from './actions';
import { Button } from '@/components/ui/button';
import { Input, Select, Textarea } from '@/components/ui/input';
import type { PrizeCategorySummary } from '@/services/inventory';

const INITIAL: PrizeFormState = { status: 'idle' };

export function PrizeForm({
  companyId,
  categories,
}: {
  companyId: string;
  categories: PrizeCategorySummary[];
}) {
  const [state, action, pending] = useActionState(createPrizeAction, INITIAL);

  return (
    <form action={action} data-testid="prize-form" className="flex flex-col gap-3">
      <input type="hidden" name="companyId" value={companyId} />

      <label className="flex flex-col gap-1 text-sm">
        Name
        <Input name="name" required maxLength={120} />
      </label>

      <label className="flex flex-col gap-1 text-sm">
        Category
        <Select name="categoryId" defaultValue="">
          <option value="">Uncategorised</option>
          {categories.map((category) => (
            <option key={category.id} value={category.id}>
              {category.name}
            </option>
          ))}
        </Select>
      </label>

      <label className="flex flex-col gap-1 text-sm">
        Internal code
        <Input name="internalCode" maxLength={40} placeholder="Optional SKU or barcode" />
      </label>

      <label className="flex flex-col gap-1 text-sm">
        Description
        <Textarea name="description" maxLength={2000} placeholder="Optional" />
      </label>

      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" name="allowsReturnToStock" defaultChecked />
        Allows return to stock
      </label>

      <div className="flex items-center gap-3">
        <Button type="submit" disabled={pending}>
          {pending ? 'Saving…' : 'Register prize'}
        </Button>
        {state.status === 'saved' && <p className="text-sm text-emerald-700">Prize registered.</p>}
      </div>

      {state.status === 'error' && <p className="text-sm text-destructive">{state.message}</p>}
    </form>
  );
}
