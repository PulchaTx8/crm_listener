'use client';

import { useTranslations } from 'next-intl';
import { useState, useTransition } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { fromZonedWallClock } from '../promotions/zone';

/**
 * The one action WinnerActions cannot offer through its own generic confirm
 * row: reopen_pickup_deadline (0093) needs a NEW deadline as well as a
 * reason, and that row is a single reason Input. Rendered instead of the
 * generic "Reopen the deadline" button — pickups-grid.tsx passes WinnerActions
 * a `reopenDeadline: false` powers object on this screen for exactly that
 * reason, the same courtesy draws/page.tsx already uses to keep the button
 * off a screen with no date field at all.
 *
 * The date is typed and read in the STATION's timezone, not the browser's —
 * the same rule promotion-fields.tsx carries for its own two datetime-local
 * inputs, and for the identical reason: an operator in another state reading
 * their own local time would pick a moment other than the one they meant, and
 * `fromZonedWallClock` (../promotions/zone) is the one place both screens
 * read that conversion from.
 */
export function ReopenForm({
  timeZone,
  onReopen,
}: {
  /** The Station's zone, so the date this operator types is that Station's day. */
  timeZone: string;
  onReopen: (deadlineAt: string, reason: string) => Promise<string | null>;
}) {
  const t = useTranslations('pickups');
  const [deadline, setDeadline] = useState('');
  const [reason, setReason] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function submit() {
    const instant = fromZonedWallClock(deadline, timeZone);
    if (!instant) {
      setMessage('Choose the new deadline.');
      return;
    }
    if (reason.trim().length === 0) {
      setMessage('Give a reason.');
      return;
    }
    setMessage(null);
    startTransition(async () => {
      const failure = await onReopen(instant, reason);
      if (failure) setMessage(failure);
      else {
        setDeadline('');
        setReason('');
      }
    });
  }

  return (
    <div className="mt-1 flex flex-wrap items-end gap-2" data-testid="reopen-form">
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-muted-foreground">{t('newDeadline')}</span>
        <Input
          type="datetime-local"
          value={deadline}
          onChange={(event) => setDeadline(event.target.value)}
          aria-label={t('theNewPickupDeadlineInThis')}
          data-testid="reopen-deadline"
        />
      </label>
      <Input
        value={reason}
        placeholder={t('reasonReopeningTheDeadline')}
        aria-label={t('reason')}
        onChange={(event) => setReason(event.target.value)}
        data-testid="reopen-reason"
      />
      <Button
        type="button"
        size="sm"
        disabled={pending}
        onClick={submit}
        data-testid="reopen-submit"
      >
        {pending ? t('saving') : t('reopen')}
      </Button>
      {message ? (
        <p role="alert" className="text-sm text-destructive">
          {message}
        </p>
      ) : null}
    </div>
  );
}
