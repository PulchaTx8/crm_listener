'use client';

import { useTranslations } from 'next-intl';
import { useId, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import type { MovementEntry, PrizeMovementsPage } from '@/services/inventory';
import type { LinkablePromotion } from '@/services/promotions';
import type { ReservableShow } from '@/services/shows';
import { MovementHistory } from './movement-history';
import { ReleaseForm, ReservationForm } from './reservation-forms';

/**
 * Reservas (design spec §7): the Tipo select (Reservar / Vincular Programa /
 * Vincular Promoção) above this tab's own filtered history, exactly the
 * frame Entradas and Saídas already establish. `canReserve` gates the whole
 * form the same way `powers.entry`/`powers.exit` gate theirs (spec §8: "each
 * tab renders only what its holder may use").
 *
 * "Vincular Promoção" is narrower still (fix round 1): its own door
 * (`link_prize_to_promotion`) is gated on `promotions.prizes`, a permission
 * `inventory.reserve` says nothing about. `canLinkPromotion` is that check,
 * resolved once alongside `powers` (station-access.ts's own comment on
 * `canLinkPromotion` explains why this is a courtesy HIDE rather than the
 * stale-render discipline the rest of this screen leans on) and threaded
 * down to `ReservationForm`, which is what actually decides whether the
 * option renders at all.
 *
 * `shows`/`promotions` are PROPS here, not a read of this component's own
 * (Task 9 follow-up). record.ts's own header on `PrizeRecord.shows`/
 * `.promotions` states the reasoning in full: a `useEffect` here calling a
 * Server Action directly used to lose that read outright, roughly half the
 * time, whenever the tab switch that mounted this component landed inside a
 * window `useRecordDialog`'s own `history.replaceState` call opens. Folding
 * the read into `getPrizeRecordAction` removes the second dispatch
 * entirely rather than timing around it — there is nothing left here for a
 * tab switch to race.
 */
export function ReservationsTab({
  companyId,
  prizeId,
  page,
  timeZone,
  shows,
  promotions,
  canReserve,
  canLinkPromotion,
  onRecorded,
}: {
  companyId: string;
  prizeId: string;
  page: PrizeMovementsPage;
  /** The Station's own zone (spec §7) — every date renders in the zone the movement actually happened in, not the reader's. */
  timeZone: string;
  /** Programmes active or starting in the future (design spec §7) — read once, with the rest of the record. */
  shows: ReservableShow[];
  /** Promotions active or starting in the future (design spec §7) — read once, with the rest of the record. */
  promotions: LinkablePromotion[];
  canReserve: boolean;
  /** promotions.prizes — see this function's own header. */
  canLinkPromotion: boolean;
  /** Asks the record to re-read, so the ledger, the balance and this tab's own history show what was just written or released. */
  onRecorded: () => void;
}) {
  const t = useTranslations('inventory');
  const [releasing, setReleasing] = useState<MovementEntry | null>(null);

  return (
    <div className="flex flex-col gap-6">
      {canReserve ? (
        <ReservationForm
          companyId={companyId}
          prizeId={prizeId}
          shows={shows}
          promotions={promotions}
          canLinkPromotion={canLinkPromotion}
          onRecorded={onRecorded}
        />
      ) : (
        <p className="text-sm text-muted-foreground">{t('youDoNotHoldInventoryReserve')}</p>
      )}

      <div className="flex flex-col gap-3">
        {page.totalCount > page.movements.length && (
          <p className="text-xs text-muted-foreground" data-testid="movements-truncated">
            {t('showingOfTotalMovements', { shown: page.movements.length, total: page.totalCount })}
          </p>
        )}
        {/* onReverse only when this caller could ever have made a
            reservation in the first place, the same reasoning
            entries-tab.tsx/exits-tab.tsx give for their own Arquivar. A
            PROMOTION_LINK row never reaches this callback at all —
            actionLabelKey (movement-history.tsx) returns null for one,
            which is what makes "Linked to a promotion — undo it on the
            promotion's own screen" the ONLY thing that row ever shows,
            never a button beside it that would fail. */}
        <MovementHistory
          movements={page.movements}
          timeZone={timeZone}
          emptyMessage={t('noMovementsOfThisKind')}
          onReverse={canReserve ? setReleasing : undefined}
        />
      </div>

      {releasing && (
        <ReleaseReservationDialog
          movement={releasing}
          companyId={companyId}
          prizeId={prizeId}
          onCancel={() => setReleasing(null)}
          onReleased={() => {
            setReleasing(null);
            onRecorded();
          }}
        />
      )}
    </div>
  );
}

/**
 * The confirmation every Release button opens. Unlike Entradas/Saídas'
 * Arquivar, this reuses `ReleaseForm` (reservation-forms.tsx) wholesale
 * rather than inlining its own fields — `reservationId` is `movement.id`
 * itself, never left for the operator to type or omit (Task 7 brief, note 1:
 * "this screen is the caller that must always pass it"), and `maxQuantity`
 * is the row's own `remainingQuantity` — both values this dialog already
 * holds and neither the reservation's own history row asks the operator to
 * repeat.
 */
function ReleaseReservationDialog({
  movement,
  companyId,
  prizeId,
  onCancel,
  onReleased,
}: {
  movement: MovementEntry;
  companyId: string;
  prizeId: string;
  onCancel: () => void;
  onReleased: () => void;
}) {
  const t = useTranslations('inventory');
  const titleId = useId();

  return (
    <Dialog open onClose={onCancel} labelledBy={titleId} className="max-w-lg">
      <DialogHeader>
        <DialogTitle id={titleId}>{t('releaseThisReservation')}</DialogTitle>
      </DialogHeader>
      <DialogBody>
        <ReleaseForm
          companyId={companyId}
          prizeId={prizeId}
          reservationId={movement.id}
          // actionLabelKey only ever calls this dialog into being for a row
          // whose remainingQuantity is a positive number (movement-history.tsx),
          // so the `?? movement.quantity` fallback below is for the type
          // checker, not a real case — remainingQuantity is null only on a
          // movement type this dialog never receives.
          maxQuantity={movement.remainingQuantity ?? movement.quantity}
          onRecorded={onReleased}
        />
      </DialogBody>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onCancel}>
          {t('cancel')}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
