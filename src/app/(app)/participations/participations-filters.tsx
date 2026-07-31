'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { Route } from 'next';
import { Input, Select } from '@/components/ui/input';
import { PARTICIPATION_STATUSES, STATUS_LABELS } from '@/lib/participation-status';
import type { ParticipationSource } from '@/services/participations';
// The Station-zone conversions come from the promotions screen's module rather
// than being re-derived here, on that module's own stated rule: a second copy of
// a timezone conversion is how two controls start disagreeing about which day
// something happened (spec L2).
import { fromZonedDay, toZonedDate } from '../promotions/zone';
import {
  ANY_STATUS,
  DEFAULT_PARTICIPATION_STATUS,
  hasActiveParticipationFilters,
  participationsHref,
  SEARCH_NOTE_ID,
  SOURCE_LABELS,
  SOURCE_ORDER,
} from './list-params';
import type { ParticipationListState, ParticipationStatusFilter } from './list-params';

const DEBOUNCE_MS = 350;
const ANY_SOURCE = '';

/** Just enough of a promotion to name it in the picker. */
export interface PromotionOption {
  id: string;
  name: string;
}

/**
 * These controls filter nothing themselves: they edit the URL, and the Server
 * Component asks Postgres a narrower question — the shape every list in this
 * codebase has used since Block 3b. Changing any of them drops the cursor
 * (participationsHref, called without one), and it has to: a cursor is a
 * position in one ordering of one result set.
 *
 * There is no sort control anywhere on this screen, and that is deliberate
 * rather than missing: the list is ordered newest-first by when the person
 * entered, fixed, because that is the one ordering participations_listing_idx
 * (0052) serves and a keyset cursor must compare exactly the columns it orders
 * by. See ./list-params.ts.
 */
export function ParticipationsFilters({
  state,
  timeZone,
  promotions,
  canSearchByListener,
}: {
  state: ParticipationListState;
  /** The Station's zone, so the day the operator picks is that Station's day. */
  timeZone: string;
  promotions: PromotionOption[];
  /**
   * Whether the listener search is available to this caller at all. It is a
   * different permission from the rest of the screen — see ./access.ts — and the
   * input is rendered disabled rather than dropped, so that a caller who cannot
   * use it still sees that the capability exists and is not theirs, rather than
   * finding a filter bar that is quietly shorter than a colleague's.
   */
  canSearchByListener: boolean;
}) {
  const router = useRouter();
  const [search, setSearch] = useState(state.search ?? '');
  /**
   * The same text as `search`, held in a ref, and a DELIBERATE departure from
   * promotions-filters.tsx and members-filters.tsx — which both read the state
   * variable here and are both one keystroke behind because of it.
   *
   * The debounce schedules `() => navigate({})` during the keystroke that
   * changed the text. `navigate` is rebuilt on every render and closes over that
   * render's `search`, so the callback still holds the function from the render
   * BEFORE `setSearch` landed: type "Ana" and the URL gets "An", after which the
   * sync below rewrites the input to "An" and the operator watches their last
   * character disappear. Driven from a single `fill()` — one input event
   * carrying the whole term — it is worse still: the closure holds the empty
   * initial value and the search is never applied at all, which is how this was
   * found rather than reasoned about.
   *
   * A ref because it is read at CALL time rather than captured: a stale
   * `navigate` still reads the current text. The alternatives were a
   * `useCallback` over `search` (which re-creates the function on every
   * keystroke, so the already-scheduled timer keeps the old one anyway) and
   * passing the term as an argument (which every other control would then have
   * to remember to pass). Neither is smaller than this.
   */
  const typedSearch = useRef(state.search ?? '');

  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  /**
   * The last term this component actually sent, which is how the effect below
   * tells its own navigation landing apart from somebody else changing the URL.
   */
  const lastNavigated = useRef<string | undefined>(state.search);

  /**
   * Re-synced from the URL so browser back/forward leaves this input agreeing
   * with the list beside it — and, when the URL changed for a reason that was
   * not this component, the pending debounce is CANCELLED rather than left to
   * fire afterwards and undo the Back.
   *
   * The guard is not decoration, and the plain "clear the timer on every sync"
   * that this fix started as is a downgrade rather than a smaller version of it.
   * Our own navigation comes back through this same effect, so clearing
   * unconditionally also cancels a keystroke typed during the round trip: type
   * "Ana", pause past the debounce, type "b" while the render is in flight, and
   * the "b" is silently dropped for good. Left alone, that case converges — the
   * pending timer fires with "Anab" and the next sync agrees with it — so the
   * unconditional clear turns a flicker into data loss.
   *
   * Comparing against what we last SENT separates the two exactly: an incoming
   * `state.search` equal to it is the URL reporting our own edit back, and
   * anything else — Back, forward, a Station chip, Clear filters — is somebody
   * else's navigation, which is the case that must win over a pending keystroke.
   */
  useEffect(() => {
    if (state.search === lastNavigated.current) return;
    clearTimeout(timer.current);
    setSearch(state.search ?? '');
    typedSearch.current = state.search ?? '';
  }, [state.search]);

  function navigate(next: Partial<ParticipationListState>) {
    clearTimeout(timer.current);
    // Always from what is currently typed rather than from what the last render
    // was given: without this, a pending keystroke firing after a select was
    // changed would rewrite the URL from the pre-change state and undo it.
    const typed: ParticipationListState = {
      ...state,
      search: typedSearch.current.trim() || undefined,
    };
    // Read off the MERGED target rather than off `typed`, so a caller that ever
    // overrides `search` in `next` is recorded as what was really sent.
    const target: ParticipationListState = { ...typed, ...next };
    lastNavigated.current = target.search;
    // typedRoutes cannot express a query string assembled at runtime as a route
    // literal — the same cast the rest of this codebase uses.
    router.replace(participationsHref(target) as Route);
  }

  return (
    <div className="flex flex-wrap items-end gap-3" data-testid="participations-filters">
      <label className="flex w-64 flex-col gap-1 text-sm">
        <span className="text-muted-foreground">Listener</span>
        <Input
          type="search"
          value={search}
          disabled={!canSearchByListener}
          onChange={(e) => {
            setSearch(e.target.value);
            // The ref is written in the same breath as the state, so the timer
            // below reads this keystroke rather than the one before it.
            typedSearch.current = e.target.value;
            clearTimeout(timer.current);
            timer.current = setTimeout(() => navigate({}), DEBOUNCE_MS);
          }}
          placeholder="Name, phone, or the CPF's last digits"
          aria-label="Search entries by listener name, phone, or the CPF's last digits"
          // Points at the page's explanation, and only when there is one to point
          // at. A disabled input is out of the tab order, so this reaches the
          // readers that expose disabled controls in browse mode; the sentence
          // itself is on the page for everybody else, which is why it is not
          // duplicated here.
          aria-describedby={canSearchByListener ? undefined : SEARCH_NOTE_ID}
          data-testid="participation-search-input"
        />
      </label>

      <label className="flex w-56 flex-col gap-1 text-sm">
        <span className="text-muted-foreground">Promotion</span>
        <Select
          value={state.promotionId ?? ''}
          onChange={(e) => navigate({ promotionId: e.target.value || undefined })}
          data-testid="participation-promotion-filter"
        >
          <option value="">Any promotion</option>
          {promotions.map((promotion) => (
            <option key={promotion.id} value={promotion.id}>
              {promotion.name}
            </option>
          ))}
        </Select>
      </label>

      {/*
        Rendered with the others, never behind a disclosure, and that placement is
        the decision rather than the styling. It opens on VALID — almost every
        question asked of this screen is about the entries that counted — and a
        default that narrows the list has to be visible next to what it narrows,
        or an operator concludes the refused attempts were never recorded. Design
        spec D5 is that a refusal is written down instead of thrown away; this
        control is how somebody finds the ones that were.
      */}
      <label className="flex w-48 flex-col gap-1 text-sm">
        <span className="text-muted-foreground">Status</span>
        <Select
          value={state.status}
          onChange={(e) => navigate({ status: e.target.value as ParticipationStatusFilter })}
          data-testid="participation-status-filter"
        >
          <option value={ANY_STATUS}>Any status</option>
          {PARTICIPATION_STATUSES.map((status) => (
            <option key={status} value={status}>
              {STATUS_LABELS[status]}
            </option>
          ))}
        </Select>
      </label>

      <label className="flex w-44 flex-col gap-1 text-sm">
        <span className="text-muted-foreground">Source</span>
        <Select
          value={state.source ?? ANY_SOURCE}
          onChange={(e) =>
            navigate({ source: (e.target.value || undefined) as ParticipationSource | undefined })
          }
          data-testid="participation-source-filter"
        >
          <option value={ANY_SOURCE}>Any source</option>
          {SOURCE_ORDER.map((source) => (
            <option key={source} value={source}>
              {SOURCE_LABELS[source]}
            </option>
          ))}
        </Select>
      </label>

      {/*
        The range is over when the PERSON ENTERED, never over when the row was
        written — listParticipationsPage narrows on participated_at, which for an
        imported file is the instant the file carries rather than the instant of
        the upload. Labelling these "Recorded from/until" would describe a column
        this screen does not filter on.
      */}
      <label className="flex w-44 flex-col gap-1 text-sm">
        <span className="text-muted-foreground">Entered from</span>
        <Input
          type="date"
          value={toZonedDate(state.from, timeZone)}
          onChange={(e) => navigate({ from: fromZonedDay(e.target.value, timeZone, false) })}
          aria-label="Show entries made on or after this day"
          data-testid="participation-from-filter"
        />
      </label>

      <label className="flex w-44 flex-col gap-1 text-sm">
        <span className="text-muted-foreground">Entered until</span>
        <Input
          type="date"
          value={toZonedDate(state.to, timeZone)}
          onChange={(e) => navigate({ to: fromZonedDay(e.target.value, timeZone, true) })}
          aria-label="Show entries made on or before this day"
          data-testid="participation-to-filter"
        />
      </label>

      {hasActiveParticipationFilters(state) && (
        <Link
          href={
            participationsHref({
              companyId: state.companyId,
              // Clearing the entry filters leaves the Station search alone: it is
              // a different question, asked of a different list.
              stationSearch: state.stationSearch,
              // Back to the screen as it opens, which means back to the default
              // and not to "any status" — the note beside the list explains that
              // default either way, so this cannot hide anything silently.
              status: DEFAULT_PARTICIPATION_STATUS,
            }) as Route
          }
          className="rounded-md border px-3 py-1.5 text-sm ring-offset-background hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          data-testid="participation-clear-filters"
        >
          Clear filters
        </Link>
      )}
    </div>
  );
}
