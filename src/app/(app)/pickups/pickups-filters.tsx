'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { Route } from 'next';
import { Input, Select } from '@/components/ui/input';
import {
  ANY_STATUS,
  DEFAULT_PICKUP_STATUS,
  hasActivePickupFilters,
  PICKUP_STATUSES,
  pickupsHref,
  SEARCH_NOTE_ID,
  STATUS_LABELS,
} from './list-params';
import type { PickupListState, PickupStatusFilter } from './list-params';

const DEBOUNCE_MS = 350;

/** Just enough of a promotion to name it in the picker. */
export interface PickupPromotionOption {
  id: string;
  name: string;
}

/**
 * These controls filter nothing themselves: they edit the URL, and the Server
 * Component asks Postgres a narrower question — the shape every list screen in
 * this codebase has used since Block 3b (participations-filters.tsx, members-
 * filters.tsx). Changing any of them drops the cursor (pickupsHref, called
 * without one), and it has to: a cursor is a position in one ordering of one
 * result set.
 *
 * The debounce here follows members-filters.tsx's simpler shape rather than
 * participations-filters.tsx's own — the one with the capture-phase click
 * listener that cancels a pending keystroke when another navigation starts.
 * That apparatus exists to fix a race measured on a screen with several
 * sequential round trips ahead of its render; nothing here needs it
 * reinvented pre-emptively, and members-filters.tsx is the standing proof
 * that not every debounced filter bar in this codebase carries it.
 *
 * There is no sort control anywhere on this screen, and that is deliberate
 * rather than missing: listPickups orders by (deadline_at, id) ascending,
 * fixed, because that is exactly what list_pickups (0095) is written to serve
 * and a keyset cursor must compare precisely the columns it orders by.
 */
export function PickupsFilters({
  state,
  promotions,
  canSearchByListener,
}: {
  state: PickupListState;
  promotions: PickupPromotionOption[];
  /**
   * Whether the listener search is available to this caller at all — a
   * different permission from the rest of the screen (members.view rather
   * than promotions.view). See ./access.ts. The input is rendered disabled
   * rather than dropped, so a caller without it still sees the capability
   * exists and is not theirs.
   */
  canSearchByListener: boolean;
}) {
  const router = useRouter();
  const [search, setSearch] = useState(state.search ?? '');

  // Re-synced from the URL so browser back/forward leaves this input
  // agreeing with the list beside it — the same rule members-filters.tsx
  // carries for its own search field.
  useEffect(() => setSearch(state.search ?? ''), [state.search]);

  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  function navigate(next: Partial<PickupListState>) {
    clearTimeout(timer.current);
    // Always from what is currently typed rather than from what the last
    // render was given: without this, a pending keystroke firing after a
    // select was changed would rewrite the URL from the pre-change state and
    // undo it — the same reasoning members-filters.tsx's own navigate gives.
    const typed: PickupListState = { ...state, search: search.trim() || undefined };
    // typedRoutes cannot express a query string assembled at runtime as a
    // route literal, so this casts to Route — the pattern the rest of this
    // codebase uses for every hand-built query string.
    router.replace(pickupsHref({ ...typed, ...next }) as Route);
  }

  return (
    <div className="flex flex-wrap items-end gap-3" data-testid="pickups-filters">
      <label className="flex w-64 flex-col gap-1 text-sm">
        <span className="text-muted-foreground">Listener</span>
        <Input
          type="search"
          value={search}
          disabled={!canSearchByListener}
          onChange={(event) => {
            setSearch(event.target.value);
            clearTimeout(timer.current);
            timer.current = setTimeout(() => navigate({}), DEBOUNCE_MS);
          }}
          placeholder="Name or phone"
          aria-label="Search by listener name or phone"
          // Points at the page's explanation, and only when there is one to
          // point at — the same wiring participations-filters.tsx carries for
          // its own disabled search input.
          aria-describedby={canSearchByListener ? undefined : SEARCH_NOTE_ID}
          data-testid="pickup-search-input"
        />
      </label>

      <label className="flex w-56 flex-col gap-1 text-sm">
        <span className="text-muted-foreground">Promotion</span>
        <Select
          value={state.promotionId ?? ''}
          onChange={(event) => navigate({ promotionId: event.target.value || undefined })}
          data-testid="pickup-promotion-filter"
        >
          <option value="">Any promotion</option>
          {promotions.map((promotion) => (
            <option key={promotion.id} value={promotion.id}>
              {promotion.name}
            </option>
          ))}
        </Select>
      </label>

      <label className="flex w-48 flex-col gap-1 text-sm">
        <span className="text-muted-foreground">Status</span>
        <Select
          value={state.status}
          onChange={(event) => navigate({ status: event.target.value as PickupStatusFilter })}
          data-testid="pickup-status-filter"
        >
          <option value={ANY_STATUS}>Any status</option>
          {PICKUP_STATUSES.map((status) => (
            <option key={status} value={status}>
              {STATUS_LABELS[status]}
            </option>
          ))}
        </Select>
      </label>

      {hasActivePickupFilters(state) && (
        <Link
          href={
            pickupsHref({
              companyId: state.companyId,
              // Clearing the pickup filters leaves the Station search alone:
              // it is a different question, asked of a different list — the
              // same reasoning participations-filters.tsx gives for its own
              // Clear filters link.
              stationSearch: state.stationSearch,
              status: DEFAULT_PICKUP_STATUS,
            }) as Route
          }
          className="rounded-md border px-3 py-1.5 text-sm ring-offset-background hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          data-testid="pickup-clear-filters"
        >
          Clear filters
        </Link>
      )}
    </div>
  );
}
