'use client';

import { useState, useTransition } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { DrawDetail } from '@/services/draws';
// The Station-zone instant formatter, shared with every other screen rather
// than re-derived. 6a rendered these with toLocaleString('pt-BR') and no zone
// at all, which is both halves of what this task is fixing: the language, and
// an operator in another state reading a draw as having happened an hour from
// when the Station ran it (spec L2).
import { formatInstant } from '@/app/(app)/promotions/format';
import { WinnerActions, type WinnerAction, type WinnerPowers } from './winner-actions';

function formatDeadline(value: string | null, timeZone: string): string {
  // Null is not missing data: it means this winner has NO deadline, because
  // neither the promotion nor the prize set one (spec 6). Saying "no deadline"
  // is the whole point — a blank would read as a value nobody filled in.
  if (!value) return 'no deadline';
  return formatInstant(value, timeZone);
}

/**
 * A listener with no name on record still has to be distinguishable from the
 * next one. members.full_name is nullable (0031) and an erased listener is the
 * ordinary way this happens — get_draw returns the name to anybody who may see
 * the draw at all, so a blank here is never "you are not allowed to know".
 */
function listenerLabel(name: string | null, memberId: string): string {
  return name ?? `listener ${memberId.slice(0, 8)} (no name on record)`;
}

/**
 * The winners with their deadlines and — plainly, not behind a toggle — the seed
 * and the algorithm version.
 *
 * That last part is the block's whole claim: a draw is checkable because
 * anybody holding the record can recompute it. A proof nobody can see is not a
 * proof, so it is on the screen next to the winners rather than in an export
 * somebody has to know to ask for.
 */
export function DrawDetailView({
  draw,
  timeZone,
  canCancel,
  onCancel,
  winnerPowers,
  onWinnerAction,
  receiptUrls,
  onAttachReceipt,
}: {
  draw: DrawDetail;
  /** The Station's zone, so every instant here is the one the Station ran on. */
  timeZone: string;
  canCancel: boolean;
  onCancel: (reason: string) => Promise<string | null>;
  winnerPowers: WinnerPowers;
  onWinnerAction: (
    winnerId: string,
    action: WinnerAction,
    reason: string,
  ) => Promise<string | null>;
  /** Signed, short-lived, minted server-side: the bucket is private, so a path is not a link. */
  receiptUrls: Record<string, string>;
  onAttachReceipt: (winnerId: string, formData: FormData) => Promise<string | null>;
}) {
  const [reason, setReason] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const cancelled = draw.status === 'CANCELLED';

  function submitCancel() {
    if (reason.trim().length === 0) {
      setMessage('Give a reason for the cancellation.');
      return;
    }
    setMessage(null);
    startTransition(async () => {
      const failure = await onCancel(reason);
      if (failure) setMessage(failure);
    });
  }

  return (
    <section className="space-y-6" data-testid="draw-detail">
      <header className="space-y-1">
        <h2 className="text-lg font-semibold">Draw of {formatInstant(draw.drawnAt, timeZone)}</h2>
        <p className="text-sm text-muted-foreground">
          {draw.entryCount} entr{draw.entryCount === 1 ? 'y' : 'ies'} in the hat ·{' '}
          {draw.winners.length} prize{draw.winners.length === 1 ? '' : 's'}
        </p>
        {cancelled ? (
          <p className="text-sm font-medium text-destructive" data-testid="draw-cancelled">
            Cancelled on {draw.cancelledAt ? formatInstant(draw.cancelledAt, timeZone) : ''}
            {draw.cancellationReason ? ` — ${draw.cancellationReason}` : ''}
          </p>
        ) : null}
      </header>

      <div>
        <h3 className="mb-2 font-medium">Winners</h3>
        <ol className="space-y-1" data-testid="draw-winners">
          {draw.winners.map((winner) => (
            <li key={winner.id} className="border-b py-2">
              <div className="flex justify-between gap-4">
                <span>
                  {winner.awardedRank}. {listenerLabel(winner.memberName, winner.memberId)}
                </span>
                <span className="text-sm text-muted-foreground">
                  {winner.prizeName} · {formatDeadline(winner.deadlineAt, timeZone)} ·{' '}
                  <span data-testid={`winner-status-${winner.awardedRank}`}>{winner.status}</span>
                </span>
              </div>

              <p className="text-sm text-muted-foreground">
                {receiptUrls[winner.id] ? (
                  <a
                    href={receiptUrls[winner.id]}
                    target="_blank"
                    rel="noreferrer"
                    className="underline"
                    data-testid="winner-receipt"
                  >
                    View receipt
                  </a>
                ) : winner.receiptErasedAt ? (
                  // Not the same as never having had one, and the screen says so:
                  // the listener asked to be erased and the object is gone.
                  <span data-testid="winner-receipt-erased">
                    receipt erased at the listener&apos;s request
                  </span>
                ) : (
                  <span data-testid="winner-no-receipt">no receipt</span>
                )}
              </p>

              {/*
                The upload comes AFTER the delivery is already recorded, which
                is D1: this control does not exist until the prize has been
                handed over, so no failure here can stop a handover being
                written down. One slot -- once a receipt is filed the form is
                gone, because attach_delivery_receipt refuses a second.
              */}
              {!cancelled &&
              winner.status === 'DELIVERED' &&
              !winner.receiptPath &&
              !winner.receiptErasedAt &&
              winnerPowers.deliver ? (
                <ReceiptForm winnerId={winner.id} onAttach={onAttachReceipt} />
              ) : null}

              {!cancelled ? (
                <WinnerActions
                  status={winner.status}
                  allowsReturnToStock={winner.allowsReturnToStock}
                  powers={winnerPowers}
                  onAct={(action, reason) => onWinnerAction(winner.id, action, reason)}
                />
              ) : null}
            </li>
          ))}
        </ol>
      </div>

      <div className="rounded border p-3 text-sm">
        <h3 className="mb-1 font-medium">How to check this draw</h3>
        <p className="text-muted-foreground">
          Rank the entries by <code>sha256(seed + &quot;:&quot; + participation id)</code> and walk
          the list, skipping anybody already awarded. The runbook has the whole recipe.
        </p>
        <dl className="mt-2 space-y-1">
          <div className="flex gap-2">
            <dt className="font-medium">Seed</dt>
            <dd>
              <code data-testid="draw-seed" className="break-all">
                {draw.seed}
              </code>
            </dd>
          </div>
          <div className="flex gap-2">
            <dt className="font-medium">Algorithm</dt>
            <dd data-testid="draw-algorithm-version">v{draw.algorithmVersion}</dd>
          </div>
        </dl>
      </div>

      {canCancel && !cancelled ? (
        <div className="space-y-2 border-t pt-4">
          <label className="block text-sm font-medium" htmlFor="cancel-reason">
            Cancel this draw
          </label>
          <Input
            id="cancel-reason"
            value={reason}
            placeholder="Why it is being cancelled"
            onChange={(event) => setReason(event.target.value)}
          />
          <Button
            type="button"
            variant="destructive"
            onClick={submitCancel}
            disabled={pending}
            data-testid="cancel-draw"
          >
            {pending ? 'Cancelling…' : 'Cancel this draw'}
          </Button>
        </div>
      ) : null}

      {message ? (
        <p role="alert" className="text-sm text-destructive">
          {message}
        </p>
      ) : null}
    </section>
  );
}

/**
 * The receipt upload, and it only exists once the delivery is on the record.
 *
 * That ordering is D1 made visible: deliver_prize has already succeeded by the
 * time this control is on screen, so a failed upload leaves a delivery with no
 * receipt rather than a prize that changed hands with nothing written down.
 */
function ReceiptForm({
  winnerId,
  onAttach,
}: {
  winnerId: string;
  onAttach: (winnerId: string, formData: FormData) => Promise<string | null>;
}) {
  const [message, setMessage] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  return (
    <form
      className="mt-1 flex items-center gap-2"
      action={(formData: FormData) => {
        startTransition(async () => {
          const failure = await onAttach(winnerId, formData);
          setMessage(failure);
        });
      }}
    >
      <input
        type="file"
        name="receipt"
        aria-label="Receipt of the handover"
        data-testid="receipt-input"
        className="text-sm"
      />
      <Button
        type="submit"
        size="sm"
        variant="outline"
        disabled={pending}
        data-testid="receipt-attach"
      >
        {pending ? 'Uploading…' : 'Attach receipt'}
      </Button>
      {message ? (
        <span role="alert" className="text-sm text-destructive">
          {message}
        </span>
      ) : null}
    </form>
  );
}
