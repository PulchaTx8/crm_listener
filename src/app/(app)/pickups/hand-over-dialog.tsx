'use client';

import { useTranslations } from 'next-intl';
import { useId, useState, useTransition } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { maskedPhone } from '@/lib/members/mask';

/**
 * Block 30a, item 5. What is being handed over, before it is handed over.
 *
 * IT DELIVERS. The button reads "Dar baixa" because that is what an operator
 * says when a prize leaves the shelf -- the owner's ruling of 2026-08-19 -- and
 * the action it runs is `deliver`, not `write_off`. The destructive write-off
 * was relabelled "Baixa por perda" in the same change, because two buttons
 * reading the same words on one screen, one of which cannot be undone, is the
 * shape of a mistake nobody recovers from.
 *
 * THE NOTE ITSELF IS NOT NEW; THE PLACE TO WRITE ONE IS. deliver_prize (0084)
 * has taken `p_note` since Block 6b, and pickupWinnerAction has passed this
 * screen's `reason` through as `p_note` since Block 6d -- but WinnerActions'
 * own generic strip never exposed a way to write one for `deliver`:
 * `NEEDS_REASON.deliver` is false there, so its Deliver button always sent an
 * empty reason. This window is the first place that field is actually
 * reachable; a second column beside the promotion/listener/prize block above
 * would be two places to look for one sentence.
 *
 * The listener's number is the four digits the list already carries. This
 * window deliberately offers NO reveal: an operator who needs to telephone
 * somebody opens the listener card, which records the asking.
 */
export function HandOverDialog({
  promotionName,
  listenerName,
  listenerPhoneLast4,
  prizeName,
  onConfirm,
  onClose,
}: {
  promotionName: string;
  listenerName: string | null;
  listenerPhoneLast4: string | null;
  prizeName: string;
  /** Resolves to an error message, or null when the prize was handed over. */
  onConfirm: (note: string) => Promise<string | null>;
  onClose: () => void;
}) {
  const t = useTranslations('pickups');
  const td = useTranslations('draws');
  const titleId = useId();
  const [note, setNote] = useState('');
  const [failure, setFailure] = useState<string | null>(null);
  const [pending, start] = useTransition();

  function confirm() {
    setFailure(null);
    start(async () => {
      const message = await onConfirm(note.trim());
      if (message) setFailure(message);
      else onClose();
    });
  }

  return (
    <Dialog open onClose={onClose} labelledBy={titleId} className="max-w-lg">
      <DialogHeader>
        <DialogTitle id={titleId}>{td('actionHandOver')}</DialogTitle>
      </DialogHeader>
      <DialogBody>
        <dl className="grid grid-cols-[8rem_1fr] gap-x-4 gap-y-3 text-sm">
          <dt className="text-muted-foreground">{t('promotion')}</dt>
          <dd data-testid="hand-over-promotion">{promotionName}</dd>

          <dt className="text-muted-foreground">{t('listener')}</dt>
          <dd data-testid="hand-over-listener">
            {listenerName ?? '—'}
            {listenerPhoneLast4 && (
              <span className="ml-2 text-muted-foreground">
                {maskedPhone(listenerPhoneLast4)}
              </span>
            )}
          </dd>

          <dt className="text-muted-foreground">{t('prize')}</dt>
          <dd data-testid="hand-over-prize">{prizeName}</dd>
        </dl>

        <label className="mt-5 flex flex-col gap-1 text-sm">
          <span className="text-muted-foreground">{t('deliveryNotes')}</span>
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={3}
            className="rounded-md border border-input bg-background px-3 py-2 text-sm"
            data-testid="hand-over-note"
          />
        </label>

        {failure && <p className="mt-3 text-sm text-destructive">{failure}</p>}
      </DialogBody>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose}>
          {t('cancel')}
        </Button>
        <Button type="button" onClick={confirm} disabled={pending} data-testid="hand-over-confirm">
          {td('actionWriteOff')}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
