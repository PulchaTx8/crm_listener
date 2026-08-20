'use client';

import { useTranslations } from 'next-intl';
import { useState, useTransition } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

export type WinnerAction = 'deliver' | 'cancel_delivery' | 'return' | 'write_off' | 'reopen';

export interface WinnerPowers {
  deliver: boolean;
  deliverCancel: boolean;
  return: boolean;
  writeOff: boolean;
  reopenDeadline: boolean;
  /**
   * `false` on Pickups only, which delivers through its own window
   * (hand-over-dialog.tsx) rather than this generic strip. Optional, and
   * undefined means "offer it", so draw-detail.tsx -- which builds no
   * `handOver` field at all -- is unaffected by this opt-out.
   */
  handOver?: boolean;
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
    // Block 30a. Pickups delivers through its own window (hand-over-dialog.tsx),
    // which shows the promotion, the listener and the prize before it hands
    // anything over, and carries the receipt field this generic strip has no
    // room for. Draws still uses the strip -- the same courtesy
    // `reopenDeadline: false` already extends one line down.
    if (powers.deliver && powers.handOver !== false) actions.push('deliver');
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

  // The clock put this prize back on the shelf. Three ways out and no fourth:
  // the ledger has no DELIVERY out of pending_return, so somebody arriving
  // late is given time again -- deliberately, with a reason -- and handed the
  // prize through the ordinary path afterwards.
  if (status === 'RETURN_PENDING') {
    const actions: WinnerAction[] = [];
    if (powers.reopenDeadline) actions.push('reopen');
    if (powers.return && allowsReturnToStock) actions.push('return');
    if (powers.writeOff) actions.push('write_off');
    return actions;
  }

  // RETURNED and WRITTEN_OFF are the end of the line: the prize left this
  // winner and there is nothing further to do to it here.
  return [];
}

// Catalogue keys, not words: a module body has no request behind it.
// Exported so tests/unit/winner-actions.test.ts can pin D5's own claim --
// "the WinnerAction value, the door and the audit action are unchanged" by
// the write_off relabel -- without a DOM, which this project's unit tests do
// not have (vitest.config.ts).
export const LABEL_KEYS: Record<WinnerAction, string> = {
  deliver: 'actionHandOver',
  cancel_delivery: 'actionUndoTheHandover',
  return: 'actionReturnToStock',
  write_off: 'actionWriteOffAsLost',
  reopen: 'actionReopenTheDeadline',
};

/** Every one but handing over needs a reason on the record. */
const NEEDS_REASON: Record<WinnerAction, boolean> = {
  deliver: false,
  cancel_delivery: true,
  return: true,
  write_off: true,
  reopen: true,
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
  const t = useTranslations('draws');
  const [open, setOpen] = useState<WinnerAction | null>(null);
  const [reason, setReason] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const actions = availableWinnerActions({ status, allowsReturnToStock, powers, drawStatus });
  if (actions.length === 0) return null;

  function run(action: WinnerAction) {
    if (NEEDS_REASON[action] && reason.trim().length === 0) {
      setOpen(action);
      setMessage(t('giveAReason'));
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
            {t(LABEL_KEYS[action])}
          </Button>
        ))}
      </div>

      {open && NEEDS_REASON[open] ? (
        <div className="flex gap-2">
          <Input
            value={reason}
            placeholder={t(`reasonFor`, { action: t(LABEL_KEYS[open]).toLowerCase() })}
            aria-label={t('reason')}
            onChange={(event) => setReason(event.target.value)}
          />
          <Button type="button" size="sm" disabled={pending} onClick={() => run(open)}>
            {pending ? t('saving') : t('confirm')}
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
