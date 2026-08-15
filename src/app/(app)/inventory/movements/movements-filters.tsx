'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { Route } from 'next';
import { Button } from '@/components/ui/button';
import { Input, Select } from '@/components/ui/input';
import { fromZonedDay, toZonedDate } from '../../promotions/zone';
import { MOVEMENT_TYPE_LABEL_KEYS } from '../format';
import {
  hasActiveMovementFilters,
  movementsHref,
  MOVEMENT_TYPES,
} from './list-params';
import type { MovementListState } from './list-params';

/** Just enough of a prize to name it in the picker. */
export interface MovementPrizeOption {
  id: string;
  name: string;
}

/** Just enough of a promotion to name it in the picker. */
export interface MovementPromotionOption {
  id: string;
  name: string;
}

/**
 * These controls filter nothing themselves: they edit the URL, and the Server
 * Component asks Postgres a narrower question — the shape every list screen in
 * this codebase has used since Block 3b (participations-filters.tsx, pickups-
 * filters.tsx). Changing any of them drops the cursor (movementsHref, called
 * without one), and it has to: a cursor is a position in one ordering of one
 * result set.
 *
 * Prize and Promotion still navigate on every change, no debounce, for the
 * reason this file's header always gave: both are plain selects, and neither
 * fires on every keystroke the way a search box does.
 *
 * Type, De and Até (Block 23, Task 8, design D10) do NOT navigate on change —
 * they are typed into a `<form>` of their own and committed only when
 * Consultar is submitted. This is deliberate, and it is the one filter bar in
 * this codebase that works this way on purpose: a period is typed in two
 * halves (De, then Até), and applying the filter after De alone is both a
 * wasted read and a list that visibly narrows and then narrows again under
 * the operator's hands before they have finished saying what they meant. The
 * Movimentação tab (prize-record-dialog.tsx) shares this exact reasoning for
 * its own copy of these same three controls — see that file's header comment
 * for why it could not simply reuse this component outright (this one edits
 * a URL; that one edits local state over an in-memory read).
 *
 * `<form className="contents">`: the three fields and the Consultar button
 * stay direct children of the same flex-wrap row every other control here
 * sits in — `display: contents` removes the form's own box from layout
 * without giving up a single native submit boundary (Enter in De or Até
 * submits it, exactly like clicking Consultar).
 *
 * There is no sort control anywhere on this screen, and that is deliberate
 * rather than missing: listMovements orders by (created_at, movement_id)
 * descending, fixed, because that is exactly what list_movements (0096) is
 * written to serve and a keyset cursor must compare precisely the columns it
 * orders by.
 */
export function MovementsFilters({
  state,
  prizes,
  promotions,
  timeZone,
}: {
  state: MovementListState;
  prizes: MovementPrizeOption[];
  promotions: MovementPromotionOption[];
  /** The Station's own zone, so the day the operator picks is that Station's day. */
  timeZone: string;
}) {
  const t = useTranslations('inventory');
  const router = useRouter();

  function navigate(next: Partial<MovementListState>) {
    // typedRoutes cannot express a query string assembled at runtime as a
    // route literal, so this casts to Route — the pattern the rest of this
    // codebase uses for every hand-built query string.
    router.replace(movementsHref({ ...state, ...next }) as Route);
  }

  // Draft values for Type/De/Até: typed here and committed to the URL only on
  // Consultar. Re-synced from `state` whenever it changes for a reason other
  // than this form's own submit — Clear filters, a Station switch, a
  // pagination link — so the fields never go on showing a draft the operator
  // typed a moment ago once the URL (the actual truth this screen reads) has
  // moved on without it.
  const [draftType, setDraftType] = useState(state.type ?? '');
  const [draftFrom, setDraftFrom] = useState(() => toZonedDate(state.from, timeZone));
  const [draftTo, setDraftTo] = useState(() => toZonedDate(state.to, timeZone));

  useEffect(() => {
    setDraftType(state.type ?? '');
    setDraftFrom(toZonedDate(state.from, timeZone));
    setDraftTo(toZonedDate(state.to, timeZone));
  }, [state.type, state.from, state.to, timeZone]);

  function handleConsult(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    navigate({
      type: (draftType || undefined) as MovementListState['type'],
      from: fromZonedDay(draftFrom, timeZone, false),
      to: fromZonedDay(draftTo, timeZone, true),
    });
  }

  return (
    <div className="flex flex-wrap items-end gap-3" data-testid="movements-filters">
      <form onSubmit={handleConsult} className="contents">
        <label className="flex w-52 flex-col gap-1 text-sm">
          <span className="text-muted-foreground">{t('type')}</span>
          <Select
            value={draftType}
            onChange={(event) => setDraftType(event.target.value)}
            data-testid="movement-type-filter"
          >
            <option value="">{t('everyMovementType')}</option>
            {MOVEMENT_TYPES.map((type) => (
              <option key={type} value={type}>
                {t(MOVEMENT_TYPE_LABEL_KEYS[type])}
              </option>
            ))}
          </Select>
        </label>

        <label className="flex w-44 flex-col gap-1 text-sm">
          <span className="text-muted-foreground">{t('periodFrom')}</span>
          <Input
            type="date"
            value={draftFrom}
            onChange={(event) => setDraftFrom(event.target.value)}
            aria-label={t('showMovementsRecordedOnOrAfter')}
            data-testid="movement-from-filter"
          />
        </label>

        <label className="flex w-44 flex-col gap-1 text-sm">
          <span className="text-muted-foreground">{t('periodTo')}</span>
          <Input
            type="date"
            value={draftTo}
            onChange={(event) => setDraftTo(event.target.value)}
            aria-label={t('showMovementsRecordedOnOrBefore')}
            data-testid="movement-to-filter"
          />
        </label>

        <Button type="submit" data-testid="movements-consult">
          {t('consult')}
        </Button>
      </form>

      <label className="flex w-56 flex-col gap-1 text-sm">
        <span className="text-muted-foreground">{t('prize')}</span>
        <Select
          value={state.prizeId ?? ''}
          onChange={(event) => navigate({ prizeId: event.target.value || undefined })}
          data-testid="movement-prize-filter"
        >
          <option value="">{t('anyPrize')}</option>
          {prizes.map((prize) => (
            <option key={prize.id} value={prize.id}>
              {prize.name}
            </option>
          ))}
        </Select>
      </label>

      <label className="flex w-56 flex-col gap-1 text-sm">
        <span className="text-muted-foreground">{t('promotion')}</span>
        <Select
          value={state.promotionId ?? ''}
          onChange={(event) => navigate({ promotionId: event.target.value || undefined })}
          data-testid="movement-promotion-filter"
        >
          <option value="">{t('anyPromotion')}</option>
          {promotions.map((promotion) => (
            <option key={promotion.id} value={promotion.id}>
              {promotion.name}
            </option>
          ))}
        </Select>
      </label>

      {hasActiveMovementFilters(state) && (
        <Link
          href={
            movementsHref({
              companyId: state.companyId,
              // Clearing the movement filters leaves the Station search
              // alone: it is a different question, asked of a different list
              // — the same reasoning pickups-filters.tsx and participations-
              // filters.tsx both give for their own Clear filters link.
              stationSearch: state.stationSearch,
            }) as Route
          }
          className="rounded-md border px-3 py-1.5 text-sm ring-offset-background hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          data-testid="movement-clear-filters"
        >
          {t('clearFilters')}</Link>
      )}
    </div>
  );
}
