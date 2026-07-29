'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { Route } from 'next';
import { Input, Select } from '@/components/ui/input';
import { hasActiveFilters, membersHref } from './list-params';
import type { MemberListState } from './list-params';

const DEBOUNCE_MS = 350;

/**
 * The screen's one client boundary. It filters nothing itself: every control
 * here only edits the URL, which is what makes MembersPage — a Server
 * Component — re-run and ask Postgres a narrower question. What changes on a
 * keystroke is the query the database runs, not a `.filter()` in the browser.
 *
 * Changing any filter drops the cursor (membersHref, called without one), and
 * it has to: a cursor is a position in one ordering of one result set, so
 * carrying it across a filter change resumes from a row that no longer means
 * anything.
 */
export function MembersFilters({ state }: { state: MemberListState }) {
  const router = useRouter();

  // Typed values live here between keystrokes; the URL is the source of truth
  // the moment a navigation happens. Re-syncing on every prop change is what
  // makes browser back/forward — which changes the URL without touching this
  // component — leave the controls agreeing with the list beside them. After
  // this component's OWN edits the prop arrives holding what was already
  // typed, so the sync is a no-op rather than a second source of truth.
  const [search, setSearch] = useState(state.search ?? '');
  const [ageMin, setAgeMin] = useState(state.ageMin?.toString() ?? '');
  const [ageMax, setAgeMax] = useState(state.ageMax?.toString() ?? '');
  useEffect(() => setSearch(state.search ?? ''), [state.search]);
  useEffect(() => setAgeMin(state.ageMin?.toString() ?? ''), [state.ageMin]);
  useEffect(() => setAgeMax(state.ageMax?.toString() ?? ''), [state.ageMax]);

  // The registration range travels as INSTANTS, converted here in the browser
  // — the whole-branch review's Critical from Block 3, in its cheaper form. A
  // date input's value is a wall-clock day with no zone; converting it on the
  // server would interpret it in the Node process's zone, which for a UTC
  // server and a Brazilian operator is three hours off, so "registered on the
  // 1st" would quietly mean "from 21:00 on the 31st". Deriving the inputs
  // back from those instants has to happen after mount for the same reason:
  // rendered on the server it would produce the server's calendar day and
  // mismatch what the browser hydrates.
  const [fromDay, setFromDay] = useState('');
  const [toDay, setToDay] = useState('');
  useEffect(() => setFromDay(toDayInput(state.registeredFrom)), [state.registeredFrom]);
  useEffect(() => setToDay(toDayInput(state.registeredTo)), [state.registeredTo]);

  const timers = useRef<Record<string, ReturnType<typeof setTimeout> | undefined>>({});
  useEffect(() => {
    const pending = timers.current;
    return () => Object.values(pending).forEach((t) => clearTimeout(t));
  }, []);

  /**
   * Always navigates from what is currently typed, not from what the last
   * render was given: without that, a pending keystroke firing after a
   * checkbox was ticked would rewrite the URL from the pre-tick state and
   * silently undo it.
   */
  function navigate(next: Partial<MemberListState>) {
    Object.values(timers.current).forEach((t) => clearTimeout(t));
    timers.current = {};
    const typed: MemberListState = {
      ...state,
      search: search.trim() || undefined,
      ageMin: parseAgeInput(ageMin),
      ageMax: parseAgeInput(ageMax),
    };
    // typedRoutes cannot express a query string assembled at runtime as a
    // route literal, so this casts to Route — the same pattern the rest of
    // this codebase uses for hand-built query strings.
    router.replace(membersHref({ ...typed, ...next }) as Route);
  }

  function debounce(key: string, run: () => void) {
    clearTimeout(timers.current[key]);
    timers.current[key] = setTimeout(run, DEBOUNCE_MS);
  }

  return (
    <div className="flex flex-col gap-3" data-testid="member-filters">
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex min-w-64 flex-1 flex-col gap-1 text-sm">
          <span className="text-muted-foreground">Search</span>
          <Input
            type="search"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              debounce('q', () => navigate({}));
            }}
            placeholder="Name, phone, e-mail, or the CPF's last digits"
            aria-label="Search the audience by name, phone, e-mail, or the CPF's last digits"
            data-testid="member-search-input"
          />
        </label>

        <label className="flex w-24 flex-col gap-1 text-sm">
          <span className="text-muted-foreground">Age from</span>
          <Input
            type="number"
            min={0}
            max={130}
            inputMode="numeric"
            value={ageMin}
            onChange={(e) => {
              setAgeMin(e.target.value);
              debounce('ageMin', () => navigate({}));
            }}
            data-testid="member-age-min"
          />
        </label>

        <label className="flex w-24 flex-col gap-1 text-sm">
          <span className="text-muted-foreground">Age to</span>
          <Input
            type="number"
            min={0}
            max={130}
            inputMode="numeric"
            value={ageMax}
            onChange={(e) => {
              setAgeMax(e.target.value);
              debounce('ageMax', () => navigate({}));
            }}
            data-testid="member-age-max"
          />
        </label>

        <label className="flex w-56 flex-col gap-1 text-sm">
          <span className="text-muted-foreground">Rules consent</span>
          <Select
            value={state.consent ?? ''}
            onChange={(e) => {
              const value = e.target.value;
              navigate({ consent: value === 'yes' || value === 'no' ? value : undefined });
            }}
            data-testid="member-consent-filter"
          >
            <option value="">Any</option>
            <option value="yes">Consented to the rules</option>
            <option value="no">Has not consented</option>
          </Select>
        </label>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <label className="flex w-48 flex-col gap-1 text-sm">
          <span className="text-muted-foreground">Registered from</span>
          <Input
            type="date"
            value={fromDay}
            onChange={(e) => {
              const day = e.target.value;
              setFromDay(day);
              navigate({ registeredFrom: startOfLocalDay(day) });
            }}
            data-testid="member-registered-from"
          />
        </label>

        <label className="flex w-48 flex-col gap-1 text-sm">
          <span className="text-muted-foreground">Registered to</span>
          <Input
            type="date"
            value={toDay}
            onChange={(e) => {
              const day = e.target.value;
              setToDay(day);
              navigate({ registeredTo: endOfLocalDay(day) });
            }}
            data-testid="member-registered-to"
          />
        </label>

        <label className="flex items-center gap-2 py-2 text-sm">
          <input
            type="checkbox"
            checked={state.blockedOnly}
            onChange={(e) => navigate({ blockedOnly: e.target.checked })}
            data-testid="member-blocked-filter"
          />
          Blocked listeners only
        </label>

        {hasActiveFilters(state) && (
          <Link
            href={
              membersHref({
                sort: state.sort,
                direction: state.direction,
                blockedOnly: false,
              }) as Route
            }
            className="rounded-md border px-3 py-1.5 text-sm ring-offset-background hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            data-testid="member-clear-filters"
          >
            Clear filters
          </Link>
        )}
      </div>
    </div>
  );
}

/** '' when there is nothing to show, or when the stored value is unreadable — never a crash and never "Invalid Date". */
function toDayInput(instant: string | undefined): string {
  if (!instant) return '';
  const parsed = new Date(instant);
  if (Number.isNaN(parsed.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${parsed.getFullYear()}-${pad(parsed.getMonth() + 1)}-${pad(parsed.getDate())}`;
}

/** The instant the chosen day begins, here, in the browser's own zone. */
function startOfLocalDay(day: string): string | undefined {
  if (!day) return undefined;
  const parsed = new Date(`${day}T00:00:00`);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

/** Inclusive: the range's upper bound is compared with `lte`, so it has to be the day's last instant. */
function endOfLocalDay(day: string): string | undefined {
  if (!day) return undefined;
  const parsed = new Date(`${day}T23:59:59.999`);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

function parseAgeInput(raw: string): number | undefined {
  if (!raw.trim()) return undefined;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value < 0 || value > 130) return undefined;
  return value;
}
