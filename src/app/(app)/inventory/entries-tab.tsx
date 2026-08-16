'use client';

import { useTranslations } from 'next-intl';
import { useActionState, useEffect, useId, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/input';
import type { MovementEntry, PrizeBalance, PrizeMovementsPage } from '@/services/inventory';
import type { VendorOption } from '@/services/vendors';
import { reverseMovementAction, type ReverseMovementState } from './actions';
import { AdjustmentForm } from './adjustment-form';
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
  vendors,
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
  /** Block 24, item 8. The Station's live suppliers, arriving with the record — see record.ts for why they are not fetched here. */
  vendors: VendorOption[];
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
          vendors={vendors}
          onRecorded={onRecorded}
        />
      ) : canAdjust ? (
        // A caller who holds inventory.adjust but not inventory.entry — a
        // stocktaker doing periodic physical counts, never trusted with
        // ad-hoc entries — is squarely inside this product's own permission
        // model (the five inventory codes are independently grantable per
        // Company role) and existed before Block 23: the old standalone
        // AdjustmentForm served them, and narrowing that away as a side
        // effect of this layout change is not a decision to make silently.
        // StockEntryForm's own Tipo chooser has nothing to offer someone who
        // cannot also choose Compra/Permuta, so this renders AdjustmentForm
        // on its own instead — one form, no chooser, no dead option. The
        // adjustment is a different door with a different permission
        // (inventory.adjust, not inventory.entry); this tab is where it
        // lives, not what gates it.
        <AdjustmentForm companyId={companyId} prizeId={prizeId} balance={balance} onRecorded={onRecorded} />
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
            {/* A distinct testid, not just `name="note"`: the entry form
                sitting above this dialog on Entradas has its own note field
                of the same name, and the two coexist in the DOM while this
                dialog is open. */}
            <Textarea
              name="note"
              required
              maxLength={2000}
              placeholder={t('reversalReasonHint')}
              data-testid="reversal-reason"
            />
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
