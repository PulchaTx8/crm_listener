'use client';

import { useTranslations } from 'next-intl';
import { useActionState, useEffect, useState } from 'react';
import {
  linkPrizeToPromotionAction,
  releaseReservationAction,
  reserveStockAction,
  type MovementFormState,
} from './actions';
import { Button } from '@/components/ui/button';
import { Input, Select, Textarea } from '@/components/ui/input';
import type { LinkablePromotion } from '@/services/promotions';
import type { ReservableShow } from '@/services/shows';

const INITIAL: MovementFormState = { status: 'idle' };

/** Asks the record to re-read, so the ledger and the balance show this movement. */
interface MovementReport {
  onRecorded?: () => void;
}

type ReservationTipo = 'RESERVE' | 'PROGRAMME' | 'PROMOTION';

/**
 * The Reservas tab's own Tipo select (Task 7, design spec §7): three values,
 * and only two of them share a door.
 *
 * Reservar and Vincular Programa both write through `reserve_stock` (D7 — a
 * programme reservation is a reservation with an owner, and nothing else) —
 * the same shape stock-entry-form.tsx keeps Compra and Permuta in ONE form
 * under, so both are handled by ONE sub-component, `ReserveOrProgrammeForm`,
 * with the Programa control appearing only for the second value and the
 * `showId` field travelling with it.
 *
 * Vincular Promoção calls a DIFFERENT door — the existing promotion-link RPC
 * (D6), gated on `promotions.prizes` rather than `inventory.reserve` — so it
 * is its own sub-component, `PromotionLinkForm`, the same way
 * stock-entry-form.tsx swaps out to AdjustmentForm for Ajuste de estoque
 * rather than folding a second door's fields into the first form. Its own
 * `<option>` renders only when `canLinkPromotion` holds (fix round 1): a
 * caller who durably lacks `promotions.prizes` would otherwise see a
 * permanently dead option on every render, never offered here rather than
 * left to fail on submit (station-access.ts's own comment on
 * `canLinkPromotion` says why that is not the stale-render case this screen
 * otherwise leans on). The door itself still re-checks the permission — this
 * is the courtesy gate, never the boundary.
 *
 * Each of the two doors' `useActionState` lives INSIDE its own sub-component
 * rather than up here, and each sub-component is mounted with `key={tipo}`
 * (fix round 1, Minor): switching Tipo away and back — RESERVE to PROGRAMME,
 * or either to PROMOTION and back — unmounts the previous instance and
 * mounts a fresh one, which is what clears a stale "Reserved."/"Linked to
 * the promotion." banner left over from a submission under a DIFFERENT Tipo.
 * Holding the action state up here, shared across every Tipo value, was the
 * defect: the state survived a Tipo change with nothing to invalidate it.
 *
 * `quantity` and `note` are lifted INTO THIS component and passed down to
 * `ReserveOrProgrammeForm` as controlled values (fix round 2) — ABOVE the
 * `key={tipo}` remount boundary that clears the action-state banner. That
 * key remounts the child on every Tipo change, and an uncontrolled input has
 * no memory across a remount; without lifting, the same fix that clears the
 * stale banner between Reservar and Vincular Programa was also silently
 * discarding whatever the operator had already typed. The exact papercut
 * Task 6 fixed the identical way in stock-entry-form.tsx/stock-exit-form.tsx,
 * whose own comments state the same reasoning for the same shape.
 */
export function ReservationForm({
  companyId,
  prizeId,
  shows,
  promotions,
  canLinkPromotion,
  onRecorded,
}: {
  companyId: string;
  prizeId: string;
  /** Programmes active or starting in the future (design spec §7). */
  shows: ReservableShow[];
  /** Promotions active or starting in the future (design spec §7). */
  promotions: LinkablePromotion[];
  /**
   * promotions.prizes (fix round 1): link_prize_to_promotion's OWN
   * permission, a different domain than `inventory.reserve`, which is what
   * gates this whole form's existence (ReservationsTab's own `canReserve`).
   * False hides the "Vincular promoção" option entirely rather than
   * rendering a control the door would refuse.
   */
  canLinkPromotion: boolean;
} & MovementReport) {
  const t = useTranslations('inventory');
  const [tipo, setTipo] = useState<ReservationTipo>('RESERVE');
  // Reservar/Vincular Programa's own quantity and note (fix round 2) — see
  // this function's own header for why these two, and only these two, live
  // here rather than inside ReserveOrProgrammeForm. Vincular Promoção's own
  // quantity is a different field entirely (a different door, a different
  // meaning) and is not lifted here, the same as AdjustmentForm's own fields
  // were never lifted into stock-entry-form.tsx's parent.
  const [quantity, setQuantity] = useState('');
  const [note, setNote] = useState('');

  return (
    <div className="flex flex-col gap-3">
      <label className="flex flex-col gap-1 text-sm">
        {t('entryType')}
        <Select value={tipo} onChange={(event) => setTipo(event.target.value as ReservationTipo)}>
          <option value="RESERVE">{t('reservationTypeReserve')}</option>
          <option value="PROGRAMME">{t('reservationTypeProgramme')}</option>
          {canLinkPromotion && <option value="PROMOTION">{t('reservationTypePromotion')}</option>}
        </Select>
      </label>

      {tipo === 'PROMOTION' && canLinkPromotion ? (
        <PromotionLinkForm prizeId={prizeId} promotions={promotions} onRecorded={onRecorded} />
      ) : (
        // `canLinkPromotion` false with `tipo` somehow still 'PROMOTION' is
        // unreachable through the select above (the option does not exist to
        // pick), but this branch is what a stray 'PROMOTION' state falls
        // through to regardless — the same door RESERVE/PROGRAMME always
        // offer, never a blank tab.
        <ReserveOrProgrammeForm
          key={tipo}
          companyId={companyId}
          prizeId={prizeId}
          shows={shows}
          withProgramme={tipo === 'PROGRAMME'}
          quantity={quantity}
          onQuantityChange={setQuantity}
          note={note}
          onNoteChange={setNote}
          onRecorded={onRecorded}
        />
      )}
    </div>
  );
}

function ReserveOrProgrammeForm({
  companyId,
  prizeId,
  shows,
  withProgramme,
  quantity,
  onQuantityChange,
  note,
  onNoteChange,
  onRecorded,
}: {
  companyId: string;
  prizeId: string;
  shows: ReservableShow[];
  /** Whether this render is "Vincular programa" (the Programa control and its `showId` field) rather than a plain "Reservar". */
  withProgramme: boolean;
  /** Lifted into the parent (fix round 2) — see ReservationForm's own header for why. */
  quantity: string;
  onQuantityChange: (value: string) => void;
  note: string;
  onNoteChange: (value: string) => void;
} & MovementReport) {
  const t = useTranslations('inventory');
  const [state, action, pending] = useActionState(reserveStockAction, INITIAL);

  useEffect(() => {
    if (state.status !== 'saved') return;
    onRecorded?.();
    // Cleared on a successful save, not on every remount: the whole point of
    // lifting these two into the parent was to let them survive a Tipo round
    // trip, so only a real write — the same trigger stock-entry-form.tsx's
    // own reset effect uses — should empty them again.
    onQuantityChange('');
    onNoteChange('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  return (
    <form action={action} data-testid="reserve-form" className="flex flex-col gap-3">
      <input type="hidden" name="companyId" value={companyId} />
      <input type="hidden" name="prizeId" value={prizeId} />

      {withProgramme && (
        <label className="flex flex-col gap-1 text-sm">
          {t('programme')}
          <Select name="showId" required data-testid="reservation-show-select">
            <option value="">{t('chooseAProgramme')}</option>
            {shows.map((show) => (
              <option key={show.id} value={show.id}>
                {show.name}
              </option>
            ))}
          </Select>
          {shows.length === 0 && (
            <span className="text-xs text-muted-foreground">{t('noActiveOrUpcomingProgrammes')}</span>
          )}
        </label>
      )}

      <label className="flex flex-col gap-1 text-sm">
        {t('quantity')}
        <Input
          name="quantity"
          type="number"
          min={1}
          step={1}
          required
          value={quantity}
          onChange={(event) => onQuantityChange(event.target.value)}
        />
      </label>

      <label className="flex flex-col gap-1 text-sm">
        {t('note')}
        <Textarea
          name="note"
          required
          maxLength={2000}
          placeholder={t('whatIsThisHeldFor')}
          value={note}
          onChange={(event) => onNoteChange(event.target.value)}
        />
      </label>

      <div className="flex items-center gap-3">
        <Button type="submit" disabled={pending || (withProgramme && shows.length === 0)}>
          {pending ? t('saving') : t('reserveStock')}
        </Button>
        {state.status === 'saved' && <p className="text-sm text-emerald-700">{t('reserved2')}</p>}
      </div>

      {state.status === 'error' && <p className="text-sm text-destructive">{state.message}</p>}
    </form>
  );
}

function PromotionLinkForm({
  prizeId,
  promotions,
  onRecorded,
}: {
  prizeId: string;
  promotions: LinkablePromotion[];
} & MovementReport) {
  const t = useTranslations('inventory');
  const [state, action, pending] = useActionState(linkPrizeToPromotionAction, INITIAL);

  useEffect(() => {
    if (state.status === 'saved') onRecorded?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  return (
    <form action={action} data-testid="promotion-link-form" className="flex flex-col gap-3">
      <input type="hidden" name="prizeId" value={prizeId} />

      <label className="flex flex-col gap-1 text-sm">
        {t('promotion')}
        <Select name="promotionId" required data-testid="promotion-link-select">
          <option value="">{t('chooseAPromotion')}</option>
          {promotions.map((promotion) => (
            <option key={promotion.id} value={promotion.id}>
              {promotion.name}
            </option>
          ))}
        </Select>
        {promotions.length === 0 && (
          <span className="text-xs text-muted-foreground">{t('noActiveOrUpcomingPromotions')}</span>
        )}
      </label>

      <label className="flex flex-col gap-1 text-sm">
        {t('quantity')}<Input name="quantity" type="number" min={1} step={1} required />
      </label>

      <div className="flex items-center gap-3">
        <Button type="submit" disabled={pending || promotions.length === 0}>
          {pending ? t('saving') : t('linkToPromotion')}
        </Button>
        {state.status === 'saved' && <p className="text-sm text-emerald-700">{t('linkedToThePromotion')}</p>}
      </div>

      {state.status === 'error' && <p className="text-sm text-destructive">{state.message}</p>}
    </form>
  );
}

/**
 * Moves reserved stock back to available for ONE named reservation (design
 * D5). `reservationId` is required, not optional, on purpose (Task 7 brief,
 * note 1): `release_reservation`'s remaining-quantity arithmetic is gated on
 * `p_reservation_id`, and the optional shape on the schema and the RPC exists
 * only for callers that predate D5 — this screen is the caller that must
 * always name the reservation it is releasing, never fall back to the
 * anonymous, unattributed release the RPC still accepts for backward
 * compatibility.
 */
export function ReleaseForm({
  companyId,
  prizeId,
  reservationId,
  maxQuantity,
  onRecorded,
}: {
  companyId: string;
  prizeId: string;
  /** Which reservation this releases — release_reservation's own `p_reservation_id` (0194). */
  reservationId: string;
  /** The reservation's own remaining quantity (list_movements), the ceiling this input's `max` enforces on screen; release_reservation re-checks it and names the figure if bypassed. */
  maxQuantity: number;
} & MovementReport) {
  const t = useTranslations('inventory');
  const [state, action, pending] = useActionState(releaseReservationAction, INITIAL);

  useEffect(() => {
    if (state.status === 'saved') onRecorded?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  return (
    <form action={action} data-testid="release-form" className="flex flex-col gap-3">
      <input type="hidden" name="companyId" value={companyId} />
      <input type="hidden" name="prizeId" value={prizeId} />
      <input type="hidden" name="reservationId" value={reservationId} />

      <label className="flex flex-col gap-1 text-sm">
        {t('quantity')}
        <Input name="quantity" type="number" min={1} max={maxQuantity} step={1} required />
      </label>

      <label className="flex flex-col gap-1 text-sm">
        {t('note')}<Textarea name="note" required maxLength={2000} placeholder={t('whyIsThisBeingReleased')} />
      </label>

      <div className="flex items-center gap-3">
        <Button type="submit" disabled={pending}>
          {pending ? t('saving') : t('releaseReservation')}
        </Button>
        {state.status === 'saved' && <p className="text-sm text-emerald-700">{t('released')}</p>}
      </div>

      {state.status === 'error' && <p className="text-sm text-destructive">{state.message}</p>}
    </form>
  );
}
