'use client';

import { useActionState, useEffect, useState } from 'react';
import { liftMemberBlockAction, type LiftBlockFormState } from './actions';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

const INITIAL: LiftBlockFormState = { status: 'idle' };

/**
 * lift_member_block (0034) — records lifted_at/lifted_by/lift_reason on the
 * SAME row, never a new one (the one write in this block's lifecycle tables
 * that is an edit rather than an append, and 0034's own comment on the RPC
 * says why: is_member_blocked reads lifted_at directly off this row). Shown
 * only next to a block row that has not been lifted yet — a block whose
 * ends_at has already passed can still be lifted here (lift_member_block has
 * no ends_at check of its own), which is harmless: is_member_blocked already
 * reads it as not-blocking either way, and recording who lifted it and why is
 * a real fact worth having regardless of whether it changed anything live.
 */
export function LiftBlockButton({
  blockId,
  onLifted,
}: {
  blockId: string;
  /** Asks the record to re-read, so the row above gains its "Lifted" line. */
  onLifted?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [state, action, pending] = useActionState(liftMemberBlockAction, INITIAL);

  useEffect(() => {
    if (state.status === 'saved') onLifted?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  if (state.status === 'saved') {
    return <p className="text-xs text-emerald-700">Lifted.</p>;
  }

  if (!open) {
    return (
      <Button type="button" variant="outline" size="sm" onClick={() => setOpen(true)}>
        Lift this block
      </Button>
    );
  }

  return (
    <form action={action} data-testid="lift-block-form" className="flex flex-col gap-2">
      <input type="hidden" name="blockId" value={blockId} />
      <label className="flex flex-col gap-1 text-xs">
        Reason for lifting it now
        <Input name="reason" required maxLength={2000} className="h-9 text-sm" />
      </label>
      <div className="flex items-center gap-2">
        <Button type="submit" size="sm" disabled={pending}>
          {pending ? 'Saving…' : 'Confirm lift'}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
      {state.status === 'error' && <p className="text-xs text-destructive">{state.message}</p>}
    </form>
  );
}
