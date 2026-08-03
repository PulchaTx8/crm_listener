'use client';

import { useState, useTransition } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

export type WinnerAction = 'deliver' | 'cancel_delivery' | 'return' | 'write_off';

export interface WinnerPowers {
  deliver: boolean;
  deliverCancel: boolean;
  return: boolean;
  writeOff: boolean;
}

/**
 * Which actions a winner's row offers.
 *
 * A COURTESY, never the boundary: each RPC re-checks its own permission and its
 * own transition before writing anything (0084/0085), so a permission revoked
 * after this page rendered is still refused where it matters. What this buys is
 * a screen that does not offer an operator something they will be told off for
 * pressing.
 *
 * The order is fixed rather than derived, because these are buttons and buttons
 * that move between renders get pressed by accident.
 */
export function availableWinnerActions(input: {
  status: string;
  allowsReturnToStock: boolean;
  powers: WinnerPowers;
  /**
   * The draw's OWN status, not the winner's. get_draw (0080) returns it
   * already, and cancel_draw (0079) deliberately leaves a cancelled draw's
   * winners AWAITING_PICKUP -- it has no vocabulary for "un-awarded" -- so a
   * winner's own status alone cannot tell this apart from a live one.
   * apply_winner_transition (Block 6d Task 12) refuses every transition on a
   * cancelled draw's winner with 22023; this is the courtesy that keeps the
   * button from being there to press, never the boundary.
   */
  drawStatus: 'COMPLETED' | 'CANCELLED';
}): WinnerAction[] {
  const { status, allowsReturnToStock, powers, drawStatus } = input;

  if (drawStatus === 'CANCELLED') return [];

  if (status === 'AWAITING_PICKUP') {
    const actions: WinnerAction[] = [];
    if (powers.deliver) actions.push('deliver');
    // A prize registered as one that cannot go back to stock offers no return.
    // The RPC refuses it with a sentence naming the prize; this only keeps the
    // button from being there to press.
    if (powers.return && allowsReturnToStock) actions.push('return');
    if (powers.writeOff) actions.push('write_off');
    return actions;
  }

  if (status === 'DELIVERED') {
    return powers.deliverCancel ? ['cancel_delivery'] : [];
  }

  // RETURNED and WRITTEN_OFF are the end of the line: the prize left this
  // winner and there is nothing further to do to it here.
  return [];
}

const LABELS: Record<WinnerAction, string> = {
  deliver: 'Hand over',
  cancel_delivery: 'Undo the handover',
  return: 'Return to stock',
  write_off: 'Write off',
};

/** The three that undo or destroy need a reason; handing over does not. */
const NEEDS_REASON: Record<WinnerAction, boolean> = {
  deliver: false,
  cancel_delivery: true,
  return: true,
  write_off: true,
};

export function WinnerActions({
  status,
  allowsReturnToStock,
  powers,
  drawStatus,
  onAct,
}: {
  status: string;
  allowsReturnToStock: boolean;
  powers: WinnerPowers;
  drawStatus: 'COMPLETED' | 'CANCELLED';
  onAct: (action: WinnerAction, reason: string) => Promise<string | null>;
}) {
  const [open, setOpen] = useState<WinnerAction | null>(null);
  const [reason, setReason] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const actions = availableWinnerActions({ status, allowsReturnToStock, powers, drawStatus });
  if (actions.length === 0) return null;

  function run(action: WinnerAction) {
    if (NEEDS_REASON[action] && reason.trim().length === 0) {
      setOpen(action);
      setMessage('Give a reason.');
      return;
    }
    setMessage(null);
    startTransition(async () => {
      const failure = await onAct(action, reason);
      if (failure) setMessage(failure);
      else {
        setReason('');
        setOpen(null);
      }
    });
  }

  return (
    <div className="mt-1 space-y-2" data-testid="winner-actions">
      <div className="flex flex-wrap gap-2">
        {actions.map((action) => (
          <Button
            key={action}
            type="button"
            size="sm"
            variant={action === 'write_off' ? 'destructive' : 'outline'}
            disabled={pending}
            data-testid={`winner-${action}`}
            onClick={() =>
              NEEDS_REASON[action] && open !== action ? setOpen(action) : run(action)
            }
          >
            {LABELS[action]}
          </Button>
        ))}
      </div>

      {open && NEEDS_REASON[open] ? (
        <div className="flex gap-2">
          <Input
            value={reason}
            placeholder={`Reason — ${LABELS[open].toLowerCase()}`}
            aria-label="Reason"
            onChange={(event) => setReason(event.target.value)}
          />
          <Button type="button" size="sm" disabled={pending} onClick={() => run(open)}>
            {pending ? 'Saving…' : 'Confirm'}
          </Button>
        </div>
      ) : null}

      {message ? (
        <p role="alert" className="text-sm text-destructive">
          {message}
        </p>
      ) : null}
    </div>
  );
}
