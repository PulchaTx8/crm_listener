'use client';

import { useTranslations } from 'next-intl';
import { useActionState, useId, useState, useTransition } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import type { RequestSummary } from '@/services/music';
import { formatInstant } from '../../promotions/format';
import {
  callOffRequestAction,
  markRequestPlayedAction,
  markRequestReadAction,
  revealRequestPhoneAction,
  type AttendRequestState,
} from './actions';
import { maskedPhone, PlayStatusBadge, ReadStatusBadge } from './request-status';

const INITIAL: AttendRequestState = { ok: null };

/**
 * Three steps, remembered in this browser. A studio machine is used by the same
 * few people every night, and making them resize the text at the start of every
 * shift is the small friction that ends with the window unused. localStorage
 * rather than a profile column: it is a property of the screen somebody is
 * standing in front of, not of who they are — the same person at the reception
 * desk wants the small one.
 */
const SIZES = ['text-base', 'text-xl', 'text-3xl'] as const;
const SIZE_KEY = 'pulchatx.attend.noteSize';

function readStoredSize(): number {
  if (typeof window === 'undefined') return 0;
  const stored = Number(window.localStorage.getItem(SIZE_KEY));
  return Number.isInteger(stored) && stored >= 0 && stored < SIZES.length ? stored : 0;
}

/**
 * The reading surface. It opens for anybody who can read the list (design D10):
 * its first purpose is a bigger, calmer view of one request, and only the four
 * buttons are gated. Without the permission it is a window with a Fechar button,
 * which is a useful thing rather than a broken one.
 */
export function AttendDialog({
  request,
  timeZone,
  canAttend,
  canFindListeners,
  onClose,
}: {
  request: RequestSummary;
  timeZone: string;
  canAttend: boolean;
  /** members.view — whether the "show the number" button is worth offering at all. */
  canFindListeners: boolean;
  onClose: () => void;
}) {
  const t = useTranslations('music');
  const titleId = useId();
  const [size, setSize] = useState(readStoredSize);
  const [phone, setPhone] = useState<string | null>(null);
  /**
   * True once a reveal has come back with `phone: null` — the listener has
   * exercised erasure between the list read and this click (revealRequestPhone's
   * own comment). Kept apart from `phone` itself: both start at null, and
   * without this flag "not yet revealed" and "revealed, and there is nothing
   * to reveal" render identically — the mask stays up and the button stays
   * offered, so a second click spends another audit row to learn the same
   * nothing.
   */
  const [phoneErased, setPhoneErased] = useState(false);
  const [phoneError, setPhoneError] = useState<string | null>(null);
  const [revealing, startReveal] = useTransition();

  const [readState, readAction, readPending] = useActionState(markRequestReadAction, INITIAL);
  const [playState, playAction, playPending] = useActionState(markRequestPlayedAction, INITIAL);
  const [offState, offAction, offPending] = useActionState(callOffRequestAction, INITIAL);

  /**
   * Which of the three marks was submitted most recently, so `failure` below
   * can show that one's own message rather than the first of the three that
   * happens to be non-null — a stale call-off failure would otherwise keep
   * showing under the window after a later, successful mark-read. Set on
   * submit, read once the corresponding useActionState settles.
   */
  const [lastAction, setLastAction] = useState<'read' | 'play' | 'off' | null>(null);

  function resize(step: number) {
    const next = Math.min(SIZES.length - 1, Math.max(0, size + step));
    setSize(next);
    window.localStorage.setItem(SIZE_KEY, String(next));
  }

  function reveal() {
    // Cleared up front, not only on the next success: a fixed number must not
    // keep showing the error from the attempt before it.
    setPhoneError(null);
    startReveal(async () => {
      const result = await revealRequestPhoneAction(request.requestId);
      if (result.status === 'ok') {
        setPhone(result.phone);
        setPhoneErased(result.phone === null);
      } else {
        setPhoneError(result.message);
      }
    });
  }

  const failure =
    lastAction === 'read'
      ? readState.ok === false && readState.message
      : lastAction === 'play'
        ? playState.ok === false && playState.message
        : lastAction === 'off'
          ? offState.ok === false && offState.message
          : null;

  return (
    <Dialog open onClose={onClose} labelledBy={titleId} className="max-w-2xl">
      <DialogHeader>
        <DialogTitle id={titleId}>{t('attend')}</DialogTitle>
      </DialogHeader>
      <DialogBody>
        <p className="text-2xl font-semibold" data-testid="attend-listener">
          {request.memberName ?? '—'}
        </p>

        {request.memberPhoneLast4 && (
          <p className="mt-1 flex items-center gap-2 text-sm text-muted-foreground">
            <span data-testid="attend-phone">
              {phoneErased
                ? t('thisListenerHasSinceExercisedTheir')
                : (phone ?? maskedPhone(request.memberPhoneLast4))}
            </span>
            {phone === null && !phoneErased && canFindListeners && (
              <button
                type="button"
                onClick={reveal}
                disabled={revealing}
                className="rounded-md border px-2 py-0.5 text-xs hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                data-testid="attend-reveal-phone"
              >
                {t('showTheNumber')}
              </button>
            )}
          </p>
        )}
        {phoneError && <p className="mt-1 text-sm text-destructive">{phoneError}</p>}

        <p className="mt-4 text-xl" data-testid="attend-song">
          {request.songTitle} · <span className="text-muted-foreground">{request.artistName}</span>
        </p>

        <div className="mt-4 rounded-lg border p-3">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-xs uppercase tracking-wide text-muted-foreground">
              {t('messageFromTheListener')}
            </span>
            <span className="flex gap-1">
              <button
                type="button"
                onClick={() => resize(-1)}
                aria-label={t('smallerText')}
                className="rounded-md border px-2 text-xs hover:bg-accent"
              >
                A−
              </button>
              <button
                type="button"
                onClick={() => resize(1)}
                aria-label={t('largerText')}
                className="rounded-md border px-2 text-xs hover:bg-accent"
              >
                A+
              </button>
            </span>
          </div>
          <p className={`whitespace-pre-wrap ${SIZES[size]}`} data-testid="attend-note">
            {request.listenerNote ?? (
              <span className="text-muted-foreground">{t('noMessageWasLeft')}</span>
            )}
          </p>
        </div>

        <p className="mt-4 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          <span>{request.showName ?? '—'}</span>
          <span>·</span>
          <span>{formatInstant(request.requestedAt, timeZone)}</span>
          <ReadStatusBadge status={request.readStatus} />
          <PlayStatusBadge status={request.playStatus} />
        </p>

        {failure && <p className="mt-3 text-sm text-destructive">{failure}</p>}
        {!canAttend && (
          <p className="mt-3 text-sm text-muted-foreground" data-testid="attend-no-permission">
            {t('youCannotAttendRequestsAt')}
          </p>
        )}
      </DialogBody>
      <DialogFooter>
        {canAttend && (
          <>
            {/* A fact already true is a label, not a disabled button that looks
                broken — and it carries the time, which is what somebody coming
                back to the row actually wants to know. */}
            {request.readAt ? (
              <span className="text-sm text-muted-foreground" data-testid="attend-read-done">
                {t('readAtTime', { time: formatInstant(request.readAt, timeZone) })}
              </span>
            ) : (
              <form action={readAction} onSubmit={() => setLastAction('read')}>
                <input type="hidden" name="requestId" value={request.requestId} />
                <Button type="submit" disabled={readPending} data-testid="attend-mark-read">
                  {t('markRead')}
                </Button>
              </form>
            )}

            {request.playedAt ? (
              <span className="text-sm text-muted-foreground" data-testid="attend-played-done">
                {t('playedAtTime', { time: formatInstant(request.playedAt, timeZone) })}
              </span>
            ) : (
              <form action={playAction} onSubmit={() => setLastAction('play')}>
                <input type="hidden" name="requestId" value={request.requestId} />
                <Button type="submit" disabled={playPending} data-testid="attend-mark-played">
                  {t('markPlayed')}
                </Button>
              </form>
            )}

            {/* NOT OFFERED once the song has played (design D2): 0190 refuses it,
                because cancellation outranks the play in 0189's derivation and
                would take a play that really happened off every screen. Hiding
                the button is what leaves that refusal reachable only by a race. */}
            {request.cancelledAt ? (
              <span className="text-sm text-muted-foreground" data-testid="attend-cancelled">
                {t('cancelledAtTime', { time: formatInstant(request.cancelledAt, timeZone) })}
              </span>
            ) : (
              request.playedAt === null && (
                <form action={offAction} onSubmit={() => setLastAction('off')}>
                  <input type="hidden" name="requestId" value={request.requestId} />
                  <Button
                    type="submit"
                    variant="destructive"
                    disabled={offPending}
                    data-testid="attend-call-off"
                  >
                    {t('callOff')}
                  </Button>
                </form>
              )
            )}
          </>
        )}
        <Button type="button" variant="outline" onClick={onClose}>
          {t('close')}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
