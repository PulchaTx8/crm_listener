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
 * under, so this stays one `<form>` too, with the Programa control appearing
 * only for the second value and the `showId` field travelling with it.
 *
 * Vincular Promoção calls a DIFFERENT door — the existing promotion-link RPC
 * (D6), gated on `promotions.prizes` rather than `inventory.reserve` — so it
 * swaps to its own `<form>` entirely, the same way stock-entry-form.tsx swaps
 * out to AdjustmentForm for Ajuste de estoque rather than folding a second
 * door's fields into the first form.
 */
export function ReservationForm({
  companyId,
  prizeId,
  shows,
  promotions,
  onRecorded,
}: {
  companyId: string;
  prizeId: string;
  /** Programmes active or starting in the future (design spec §7). */
  shows: ReservableShow[];
  /** Promotions active or starting in the future (design spec §7). */
  promotions: LinkablePromotion[];
} & MovementReport) {
  const t = useTranslations('inventory');
  const [tipo, setTipo] = useState<ReservationTipo>('RESERVE');
  const [reserveState, reserveAction, reservePending] = useActionState(reserveStockAction, INITIAL);
  const [linkState, linkAction, linkPending] = useActionState(linkPrizeToPromotionAction, INITIAL);

  useEffect(() => {
    if (reserveState.status === 'saved') onRecorded?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reserveState]);

  useEffect(() => {
    if (linkState.status === 'saved') onRecorded?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [linkState]);

  return (
    <div className="flex flex-col gap-3">
      <label className="flex flex-col gap-1 text-sm">
        {t('entryType')}
        <Select value={tipo} onChange={(event) => setTipo(event.target.value as ReservationTipo)}>
          <option value="RESERVE">{t('reservationTypeReserve')}</option>
          <option value="PROGRAMME">{t('reservationTypeProgramme')}</option>
          <option value="PROMOTION">{t('reservationTypePromotion')}</option>
        </Select>
      </label>

      {tipo === 'PROMOTION' ? (
        <form action={linkAction} data-testid="promotion-link-form" className="flex flex-col gap-3">
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
            <Button type="submit" disabled={linkPending || promotions.length === 0}>
              {linkPending ? t('saving') : t('linkToPromotion')}
            </Button>
            {linkState.status === 'saved' && (
              <p className="text-sm text-emerald-700">{t('linkedToThePromotion')}</p>
            )}
          </div>

          {linkState.status === 'error' && <p className="text-sm text-destructive">{linkState.message}</p>}
        </form>
      ) : (
        <form action={reserveAction} data-testid="reserve-form" className="flex flex-col gap-3">
          <input type="hidden" name="companyId" value={companyId} />
          <input type="hidden" name="prizeId" value={prizeId} />

          {tipo === 'PROGRAMME' && (
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
            {t('quantity')}<Input name="quantity" type="number" min={1} step={1} required />
          </label>

          <label className="flex flex-col gap-1 text-sm">
            {t('note')}<Textarea name="note" required maxLength={2000} placeholder={t('whatIsThisHeldFor')} />
          </label>

          <div className="flex items-center gap-3">
            <Button type="submit" disabled={reservePending || (tipo === 'PROGRAMME' && shows.length === 0)}>
              {reservePending ? t('saving') : t('reserveStock')}
            </Button>
            {reserveState.status === 'saved' && <p className="text-sm text-emerald-700">{t('reserved2')}</p>}
          </div>

          {reserveState.status === 'error' && <p className="text-sm text-destructive">{reserveState.message}</p>}
        </form>
      )}
    </div>
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
