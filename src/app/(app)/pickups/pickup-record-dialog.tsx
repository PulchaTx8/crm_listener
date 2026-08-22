'use client';

import { useId } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { WinnerActions } from '@/components/draws/winner-actions';
import type { WinnerAction, WinnerPowers } from '@/components/draws/winner-actions';
import { maskedPhone } from '@/lib/members/mask';
import { STATUS_LABEL_KEYS } from './list-params';
import type { PickupRow } from '@/services/pickups';

/**
 * Block 31a, items 3 to 6 of the owner's Pickups list. What a prize IS, before
 * anything is done to it.
 *
 * IT MOUNTS `WinnerActions` RATHER THAN REIMPLEMENTING IT (spec D7). Return to
 * stock and Write off as lost keep their own confirmation, their own mandatory
 * reason, their own refusal messages and their own audit rows, because they are
 * still the same component calling the same server action into
 * `apply_winner_transition`. What changed is WHERE it is mounted.
 *
 * On the row there was nothing on screen naming what was about to be returned or
 * written off, and the strip's reason box was shared per row — the shape Block
 * 30a recorded and left alone. Here the two actions sit under the promotion, the
 * prize, the listener and the deadline they would act on.
 *
 * `deliver` and `reopenDeadline` stay FALSE, for the reason the row already
 * gives one line down from where this window is mounted: this screen hands over
 * through `hand-over-dialog.tsx`, which carries the receipt field, and reopens
 * through `ReopenForm`, which carries the new deadline. Neither fits a generic
 * strip, and neither moved.
 */
export function PickupRecordDialog({
  row,
  powers,
  timeZone,
  onAct,
  onClose,
}: {
  /** Read fresh off the grid's rows by the caller, so this window cannot drift from the table behind it. */
  row: PickupRow;
  powers: WinnerPowers;
  timeZone: string;
  onAct: (action: WinnerAction, reason: string) => Promise<string | null>;
  onClose: () => void;
}) {
  const t = useTranslations('pickups');
  const tv = useTranslations('vocab');
  const titleId = useId();

  const deadline = row.deadlineAt
    ? new Intl.DateTimeFormat(undefined, {
        timeZone,
        dateStyle: 'short',
        timeStyle: 'short',
      }).format(new Date(row.deadlineAt))
    : '—';

  return (
    <Dialog open onClose={onClose} labelledBy={titleId} className="max-w-lg">
      <DialogHeader>
        <DialogTitle id={titleId}>{t('thePrize')}</DialogTitle>
      </DialogHeader>
      {/* The test id sits on the BODY, not on `Dialog`: that primitive takes a
          closed prop list and forwards no attribute bag, and widening a shared
          primitive for one screen's test is the wrong trade — the same reasoning
          shows-grid.tsx records for its own dropdown. */}
      <DialogBody data-testid="pickup-record-dialog">
        <dl className="grid grid-cols-[8rem_1fr] gap-x-4 gap-y-3 text-sm">
          <dt className="text-muted-foreground">{t('promotion')}</dt>
          <dd data-testid="pickup-record-promotion">{row.promotionName}</dd>

          <dt className="text-muted-foreground">{t('prize')}</dt>
          <dd data-testid="pickup-record-prize">{row.prizeName}</dd>

          <dt className="text-muted-foreground">{t('listener')}</dt>
          <dd data-testid="pickup-record-listener">
            {row.memberName ?? '—'}
            {/* Four digits, like the grid behind it: this window is not a way
                around this screen's own masking (Block 30a, D1). */}
            {row.memberPhoneLast4 && (
              <span className="ml-2 text-muted-foreground">{maskedPhone(row.memberPhoneLast4)}</span>
            )}
          </dd>

          <dt className="text-muted-foreground">{t('status')}</dt>
          <dd data-testid="pickup-record-status">{tv(STATUS_LABEL_KEYS[row.status])}</dd>

          <dt className="text-muted-foreground">{t('deadline')}</dt>
          <dd data-testid="pickup-record-deadline">{deadline}</dd>
        </dl>

        <div className="mt-5 border-t pt-4">
          <WinnerActions
            status={row.status}
            allowsReturnToStock={row.allowsReturnToStock}
            powers={{ ...powers, deliver: false, handOver: false, reopenDeadline: false }}
            drawStatus={row.drawStatus}
            onAct={onAct}
          />
        </div>
      </DialogBody>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose} data-testid="pickup-record-close">
          {t('close')}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
