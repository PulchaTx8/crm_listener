'use client';

import { useTranslations } from 'next-intl';
import { useActionState, useEffect, useId, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/input';
import type { MovementEntry, PrizeBalance, PrizeMovementsPage } from '@/services/inventory';
import { reverseMovementAction, type ReverseMovementState } from './actions';
import { MovementHistory } from './movement-history';
import { StockEntryForm } from './stock-entry-form';

const INITIAL_REVERSE: ReverseMovementState = { status: 'idle' };

/**
 * Entradas (design spec §7): the entry form above its own filtered history.
 * `canEnter` gates the form the same way `powers.catalogue` already gates
 * Dados do prêmio (spec §8: "each tab renders only what its holder may
 * use") — a caller with none of the write codes still gets a useful screen,
 * the history alone, rather than a broken one.
 */
export function EntriesTab({
  companyId,
  prizeId,
  balance,
  page,
  timeZone,
  canEnter,
  canAdjust,
  onRecorded,
}: {
  companyId: string;
  prizeId: string;
  balance: PrizeBalance;
  page: PrizeMovementsPage;
  /** The Station's own zone (spec §7) — every date renders in the zone the movement actually happened in, not the reader's. */
  timeZone: string;
  canEnter: boolean;
  canAdjust: boolean;
  /** Asks the record to re-read, so the ledger, the balance and this tab's own history show what was just written or reversed. */
  onRecorded: () => void;
}) {
  const t = useTranslations('inventory');
  const [archiving, setArchiving] = useState<MovementEntry | null>(null);

  return (
    <div className="flex flex-col gap-6">
      {canEnter ? (
        <StockEntryForm
          companyId={companyId}
          prizeId={prizeId}
          balance={balance}
          canAdjust={canAdjust}
          onRecorded={onRecorded}
        />
      ) : (
        <p className="text-sm text-muted-foreground">{t('youDoNotHoldInventoryEntry')}</p>
      )}

      <div className="flex flex-col gap-3">
        {page.totalCount > page.movements.length && (
          <p className="text-xs text-muted-foreground" data-testid="movements-truncated">
            {t('showingOfTotalMovements', { shown: page.movements.length, total: page.totalCount })}
          </p>
        )}
        {/* onReverse only when this caller could ever have recorded an
            entry in the first place — reverse_movement borrows the
            ORIGINAL movement's own permission (spec §5/§8), so a caller
            without inventory.entry could not make one of these rows and
            could not undo one either. MovementHistory's own actionLabelKey
            (movement-history.tsx) is what decides row-by-row whether a
            reversed or non-entry/exit row offers the button at all — not
            reimplemented here. */}
        <MovementHistory
          movements={page.movements}
          timeZone={timeZone}
          emptyMessage={t('noMovementsOfThisKind')}
          onReverse={canEnter ? setArchiving : undefined}
        />
      </div>

      {archiving && (
        <ArchiveMovementDialog
          movement={archiving}
          onCancel={() => setArchiving(null)}
          onArchived={() => {
            setArchiving(null);
            onRecorded();
          }}
        />
      )}
    </div>
  );
}

/**
 * The confirmation every Arquivar button opens (Task 6 brief, note 1): the
 * reason is REQUIRED, never invented on the operator's behalf —
 * reverse_movement (0195) refuses a blank note with 22023, exactly as
 * record_stock_exit/reserve_stock/release_reservation already do, and a
 * reversal is the row a reader most wants explained. `archiveWritesTheOpposite`
 * says what archiving actually does, since D1 means nothing is deleted.
 */
function ArchiveMovementDialog({
  movement,
  onCancel,
  onArchived,
}: {
  movement: MovementEntry;
  onCancel: () => void;
  onArchived: () => void;
}) {
  const t = useTranslations('inventory');
  const titleId = useId();
  const formId = useId();
  const [state, action, pending] = useActionState(reverseMovementAction, INITIAL_REVERSE);

  useEffect(() => {
    if (state.status === 'saved') onArchived();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  return (
    <Dialog open onClose={onCancel} labelledBy={titleId} className="max-w-lg">
      <DialogHeader>
        <DialogTitle id={titleId}>{t('archiveThisMovement')}</DialogTitle>
      </DialogHeader>
      <DialogBody>
        <p className="text-sm text-muted-foreground">{t('archiveWritesTheOpposite')}</p>
        <form id={formId} action={action} className="mt-3 flex flex-col gap-3">
          <input type="hidden" name="movementId" value={movement.id} />
          <label className="flex flex-col gap-1 text-sm">
            {t('reversalReason')}
            <Textarea name="note" required maxLength={2000} placeholder={t('reversalReasonHint')} />
          </label>
        </form>
        {state.status === 'error' && <p className="mt-3 text-sm text-destructive">{state.message}</p>}
      </DialogBody>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onCancel}>
          {t('cancel')}
        </Button>
        <Button type="submit" form={formId} disabled={pending} data-testid="movement-archive-confirm">
          {pending ? t('archiving') : t('archiveMovement')}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
