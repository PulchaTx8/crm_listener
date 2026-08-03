'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { Route } from 'next';
import { Input, Select } from '@/components/ui/input';
import { fromZonedDay, toZonedDate } from '../../promotions/zone';
import { MOVEMENT_TYPE_LABELS } from '../format';
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
 * No debounce anywhere here, unlike pickups-filters.tsx and participations-
 * filters.tsx: both of those carry one for a free-text search box, and this
 * screen has none — type, prize and promotion are all plain selects and the
 * two date fields are `<input type="date">`, none of which fires on every
 * keystroke the way a search box does.
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
  const router = useRouter();

  function navigate(next: Partial<MovementListState>) {
    // typedRoutes cannot express a query string assembled at runtime as a
    // route literal, so this casts to Route — the pattern the rest of this
    // codebase uses for every hand-built query string.
    router.replace(movementsHref({ ...state, ...next }) as Route);
  }

  return (
    <div className="flex flex-wrap items-end gap-3" data-testid="movements-filters">
      <label className="flex w-52 flex-col gap-1 text-sm">
        <span className="text-muted-foreground">Type</span>
        <Select
          value={state.type ?? ''}
          onChange={(event) =>
            navigate({
              type: (event.target.value || undefined) as MovementListState['type'],
            })
          }
          data-testid="movement-type-filter"
        >
          <option value="">Any type</option>
          {MOVEMENT_TYPES.map((type) => (
            <option key={type} value={type}>
              {MOVEMENT_TYPE_LABELS[type]}
            </option>
          ))}
        </Select>
      </label>

      <label className="flex w-56 flex-col gap-1 text-sm">
        <span className="text-muted-foreground">Prize</span>
        <Select
          value={state.prizeId ?? ''}
          onChange={(event) => navigate({ prizeId: event.target.value || undefined })}
          data-testid="movement-prize-filter"
        >
          <option value="">Any prize</option>
          {prizes.map((prize) => (
            <option key={prize.id} value={prize.id}>
              {prize.name}
            </option>
          ))}
        </Select>
      </label>

      <label className="flex w-56 flex-col gap-1 text-sm">
        <span className="text-muted-foreground">Promotion</span>
        <Select
          value={state.promotionId ?? ''}
          onChange={(event) => navigate({ promotionId: event.target.value || undefined })}
          data-testid="movement-promotion-filter"
        >
          <option value="">Any promotion</option>
          {promotions.map((promotion) => (
            <option key={promotion.id} value={promotion.id}>
              {promotion.name}
            </option>
          ))}
        </Select>
      </label>

      <label className="flex w-44 flex-col gap-1 text-sm">
        <span className="text-muted-foreground">From</span>
        <Input
          type="date"
          value={toZonedDate(state.from, timeZone)}
          onChange={(event) => navigate({ from: fromZonedDay(event.target.value, timeZone, false) })}
          aria-label="Show movements recorded on or after this day"
          data-testid="movement-from-filter"
        />
      </label>

      <label className="flex w-44 flex-col gap-1 text-sm">
        <span className="text-muted-foreground">To</span>
        <Input
          type="date"
          value={toZonedDate(state.to, timeZone)}
          onChange={(event) => navigate({ to: fromZonedDay(event.target.value, timeZone, true) })}
          aria-label="Show movements recorded on or before this day"
          data-testid="movement-to-filter"
        />
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
          Clear filters
        </Link>
      )}
    </div>
  );
}
