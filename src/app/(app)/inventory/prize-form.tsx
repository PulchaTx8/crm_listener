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
  onCreated,
}: {
  companyId: string;
  categories: PrizeCategorySummary[];
  /** Reports the new prize's id so the grid can open its record and take the row from it. */
  onCreated?: (prizeId: string) => void;
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

      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={pending}>
          {pending ? 'Saving…' : 'Register prize'}
        </Button>
        {/* The confirmation stays on screen and opening the new record is a
            deliberate click, the same shape the registration desk uses for a
            listener: a dialog that closed itself the moment the write landed
            would take its own "Prize registered." with it. */}
        {state.status === 'saved' && (
          <p className="text-sm text-emerald-700">
            Prize registered.{' '}
            {state.prizeId && onCreated && (
              <button
                type="button"
                onClick={() => onCreated(state.prizeId as string)}
                className="underline underline-offset-2"
              >
                View prize
              </button>
            )}
          </p>
        )}
      </div>

      {state.status === 'error' && <p className="text-sm text-destructive">{state.message}</p>}
    </form>
  );
}
