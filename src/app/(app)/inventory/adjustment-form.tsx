'use client';

import { useActionState } from 'react';
import { adjustStockAction, type AdjustmentFormState } from './actions';
import { Button } from '@/components/ui/button';
import { Input, Textarea } from '@/components/ui/input';

const INITIAL: AdjustmentFormState = { status: 'idle' };

/**
 * Asks for the counted figure, never a delta — someone reconciling with a
 * shelf counts what is there; making them compute a difference against a
 * number they may not even have in front of them is how the sign gets
 * inverted. adjust_stock (0027) derives ADJUSTMENT_POSITIVE/NEGATIVE itself
 * from this figure against the current `available` count, so this form never
 * does that arithmetic.
 */
export function AdjustmentForm({ companyId, prizeId }: { companyId: string; prizeId: string }) {
  const [state, action, pending] = useActionState(adjustStockAction, INITIAL);

  return (
    <form action={action} data-testid="adjustment-form" className="flex flex-col gap-3">
      <input type="hidden" name="companyId" value={companyId} />
      <input type="hidden" name="prizeId" value={prizeId} />

      <label className="flex flex-col gap-1 text-sm">
        Counted figure
        <Input name="counted" type="number" min={0} step={1} required />
        <span className="text-xs text-muted-foreground">
          What is actually on the shelf right now — not the difference from what is booked. The
          system works out whether that is an increase or a decrease.
        </span>
      </label>

      <label className="flex flex-col gap-1 text-sm">
        Note
        <Textarea name="note" required maxLength={2000} placeholder="Why does the count differ?" />
      </label>

      <div className="flex items-center gap-3">
        <Button type="submit" disabled={pending}>
          {pending ? 'Saving…' : 'Adjust stock'}
        </Button>
        {state.status === 'saved' && (
          <p className="text-sm text-emerald-700">Adjustment recorded.</p>
        )}
        {state.status === 'no_change' && (
          <p className="text-sm text-muted-foreground">{state.message}</p>
        )}
      </div>

      {state.status === 'error' && <p className="text-sm text-destructive">{state.message}</p>}
    </form>
  );
}
