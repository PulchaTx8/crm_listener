'use client';

import { useTranslations } from 'next-intl';
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { Route } from 'next';
import { Input, Select } from '@/components/ui/input';
import { RefreshButton } from '@/components/ui/refresh-button';
import { GENDER_VALUES, type GenderValue } from '@/lib/conversation/steps';
import { hasActiveFilters, membersHref } from './list-params';
import type { MemberListState } from './list-params';

const DEBOUNCE_MS = 350;

/**
 * The screen's one client boundary. It filters nothing itself: every control
 * here but Refresh only edits the URL, which is what makes MembersPage — a
 * Server Component — re-run and ask Postgres a narrower question. What
 * changes on a keystroke is the query the database runs, not a `.filter()`
 * in the browser.
 *
 * Changing any filter drops the cursor (membersHref, called without one), and
 * it has to: a cursor is a position in one ordering of one result set, so
 * carrying it across a filter change resumes from a row that no longer means
 * anything. Refresh (src/components/ui/refresh-button.tsx) drops nothing: it
 * edits no URL and asks for no new query, so there is no cursor to drop.
 */
export function MembersFilters({ state }: { state: MemberListState }) {
  const t = useTranslations('members');
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

  // The mode selector's own value, for the identical reason fromDay/toDay
  // below are local state rather than reads of state.dateMode directly.
  // state.dateMode is a SERVER PROP: for the whole router.replace() round
  // trip navigate() starts, it still holds whatever mode was active before
  // the click. Both date boxes decide what to write (birthdayFrom vs.
  // registeredFrom) from this value, and navigate() (below) spreads ...state
  // before applying what was just picked -- so an operator who switches to
  // Birthday and picks a date before the RSC response lands would have that
  // date written as a registration-window instant, with dates=birthday
  // dropped from the URL because the stale prop was spread back in. Local
  // state closes over the click that started the round trip instead of
  // waiting for what the server has confirmed so far, and it is what
  // navigate() itself now reads (below) rather than state.dateMode.
  const [dateMode, setDateMode] = useState(state.dateMode);
  useEffect(() => setDateMode(state.dateMode), [state.dateMode]);

  const [fromDay, setFromDay] = useState('');
  const [toDay, setToDay] = useState('');
  // Gated on dateMode rather than firing unconditionally: parseMemberListState
  // does not forbid a URL that carries both windows at once (registeredFrom/To
  // alongside birthdayFrom/To), and with all four of these effects ungated
  // they would all fire on that render, React would batch them, and whichever
  // was declared last would win the shared fromDay/toDay state -- showing a
  // birthday day under a "Registered from" label, or vice versa, with no box
  // for the other window even on screen to reveal the mismatch. Only the pair
  // matching the currently active mode may write these two boxes; dateMode is
  // in every dependency array below because switching modes has to re-run the
  // check even when the field itself did not change.
  useEffect(() => {
    if (state.dateMode === 'registered') setFromDay(toDayInput(state.registeredFrom));
  }, [state.dateMode, state.registeredFrom]);
  useEffect(() => {
    if (state.dateMode === 'registered') setToDay(toDayInput(state.registeredTo));
  }, [state.dateMode, state.registeredTo]);
  // Same back/forward reasoning as the pair above, not the zone one: a
  // birthday day is a slice of a string (monthDayOf, below), not an instant,
  // so there is no clock to get wrong here -- only the URL state to resync
  // onto after a navigation this component did not cause.
  useEffect(() => {
    if (state.dateMode === 'birthday') setFromDay(birthdayDayInput(state.birthdayFrom));
  }, [state.dateMode, state.birthdayFrom]);
  useEffect(() => {
    if (state.dateMode === 'birthday') setToDay(birthdayDayInput(state.birthdayTo));
  }, [state.dateMode, state.birthdayTo]);

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
      // Read from local state rather than the (possibly stale) prop, for the
      // same reason as the three fields above: a caller of navigate() fired
      // from an event that has not yet round-tripped must still write the
      // mode it locally believes is active.
      dateMode,
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
          <span className="text-muted-foreground">{t('search')}</span>
          <Input
            type="search"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              debounce('q', () => navigate({}));
            }}
            placeholder={t('namePhoneEMailOrThe')}
            aria-label={t('searchTheAudienceByNamePhone')}
            data-testid="member-search-input"
          />
        </label>

        <label className="flex w-24 flex-col gap-1 text-sm">
          <span className="text-muted-foreground">{t('ageFrom')}</span>
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
          <span className="text-muted-foreground">{t('ageTo')}</span>
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
          <span className="text-muted-foreground">{t('rulesConsent')}</span>
          <Select
            value={state.consent ?? ''}
            onChange={(e) => {
              const value = e.target.value;
              navigate({ consent: value === 'yes' || value === 'no' ? value : undefined });
            }}
            data-testid="member-consent-filter"
          >
            <option value="">{t('any')}</option>
            <option value="yes">{t('consentedToTheRules')}</option>
            <option value="no">{t('hasNotConsented')}</option>
          </Select>
        </label>

        {/*
          The gender block, and the reason this screen gains a filter for a
          column no operator asked to see: it is what Block 29's campaigns
          address an audience by, and a criterion that cannot be tried against
          the real list before a send is a criterion nobody can trust.

          FOUR CHOICES OVER THREE STORED VALUES. "Not recorded" is the fourth,
          and it is the column being null — which is a different population from
          "Prefiro não dizer", not a politer spelling of it. Both are offered
          because both are real answers to "who has not told us".

          A controlled `value` bound to server state, which is the shape that
          bit this project once already on a CHECKBOX: a box whose `checked`
          comes from the server unticks itself on click, because the click's own
          render restores the old value before the navigation lands. A <select>
          is safe from it — the navigation carries the new value and the render
          that follows agrees with it — and this comment is here so the next
          filter added beside it is not a checkbox written from memory.
        */}
        <label className="flex w-56 flex-col gap-1 text-sm">
          <span className="text-muted-foreground">{t('gender')}</span>
          <Select
            value={state.gender ?? ''}
            onChange={(e) => {
              const value = e.target.value;
              navigate({
                gender:
                  value === 'none' || (GENDER_VALUES as readonly string[]).includes(value)
                    ? (value as GenderValue | 'none')
                    : undefined,
              });
            }}
            data-testid="member-gender-filter"
          >
            <option value="">{t('any')}</option>
            {GENDER_VALUES.map((value) => (
              <option key={value} value={value}>
                {t(`gender_${value}`)}
              </option>
            ))}
            <option value="none">{t('genderNotRecorded')}</option>
          </Select>
        </label>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <label className="flex w-40 flex-col gap-1 text-sm">
          <span className="text-muted-foreground">{t('dateFilter')}</span>
          <Select
            value={dateMode}
            onChange={(e) => {
              const mode = e.target.value === 'birthday' ? 'birthday' : 'registered';
              // Set before navigate() is called, so the round trip navigate()
              // starts already carries the new mode (typed.dateMode, above) and
              // so this select and the two boxes below stop showing the old
              // mode for the round trip rather than snapping back once it lands.
              setDateMode(mode);
              // SWITCHING CLEARS THE OTHER WINDOW. Two live windows would show a
              // count nobody can account for from what is on screen, and the
              // boxes can only display one of them.
              navigate(
                mode === 'birthday'
                  ? { dateMode: mode, registeredFrom: undefined, registeredTo: undefined }
                  : { dateMode: mode, birthdayFrom: undefined, birthdayTo: undefined },
              );
            }}
            data-testid="member-date-mode"
          >
            <option value="registered">{t('dateModeRegistered')}</option>
            <option value="birthday">{t('dateModeBirthday')}</option>
          </Select>
        </label>

        <label className="flex w-48 flex-col gap-1 text-sm">
          <span className="text-muted-foreground">
            {dateMode === 'birthday' ? t('birthdaysFrom') : t('registeredFrom')}
          </span>
          <Input
            type="date"
            value={fromDay}
            onChange={(e) => {
              const day = e.target.value;
              setFromDay(day);
              navigate(
                dateMode === 'birthday'
                  ? { birthdayFrom: monthDayOf(day) }
                  : { registeredFrom: startOfLocalDay(day) },
              );
            }}
            data-testid="member-date-from"
          />
        </label>

        <label className="flex w-48 flex-col gap-1 text-sm">
          <span className="text-muted-foreground">
            {dateMode === 'birthday' ? t('birthdaysTo') : t('registeredTo')}
          </span>
          <Input
            type="date"
            value={toDay}
            onChange={(e) => {
              const day = e.target.value;
              setToDay(day);
              navigate(
                dateMode === 'birthday'
                  ? { birthdayTo: monthDayOf(day) }
                  : { registeredTo: endOfLocalDay(day) },
              );
            }}
            data-testid="member-date-to"
          />
        </label>

        <label className="flex items-center gap-2 py-2 text-sm">
          <input
            type="checkbox"
            checked={state.blockedOnly}
            onChange={(e) => navigate({ blockedOnly: e.target.checked })}
            data-testid="member-blocked-filter"
          />
          {t('blockedListenersOnly')}</label>

        {hasActiveFilters(state) && (
          <Link
            href={
              membersHref({
                // Clearing the audience filters leaves the Station search
                // alone: it is a different question, asked of a different list.
                stationSearch: state.stationSearch,
                sort: state.sort,
                direction: state.direction,
                blockedOnly: false,
                // birthdayFrom/birthdayTo, like registeredFrom/registeredTo
                // above, are simply absent from this literal, so membersHref
                // drops both windows regardless of which mode is active.
                // dateMode is carried through rather than reset, because
                // hasActiveFilters is a single OR across every filter --
                // Clear can appear when the only active thing is unrelated to
                // dates (a search term, an age band), and resetting the mode
                // then would silently flip a view the operator chose for a
                // reason that has nothing to do with dates. Choosing Birthday
                // with no dates yet is a real state (list-params.ts, at the
                // dateMode field) and Clear has no more standing to overrule
                // it than any other control on this bar does.
                dateMode: state.dateMode,
              }) as Route
            }
            className="rounded-md border px-3 py-1.5 text-sm ring-offset-background hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            data-testid="member-clear-filters"
          >
            {t('clearFilters')}</Link>
        )}
        <RefreshButton />
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

/**
 * A `<input type="date">` value as the day of the year the URL carries.
 *
 * The year is DISCARDED here rather than on the server, for the same reason the
 * registration range is converted here: the input's value is a wall-clock day
 * with no zone, and anything that re-parses it elsewhere risks interpreting it
 * in a different one. Slicing the string touches no clock at all.
 */
function monthDayOf(value: string): string | undefined {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value.slice(5) : undefined;
}

/**
 * The reverse of monthDayOf: `MM-DD` as an `<input type="date">` value, for
 * the boxes' display in Birthday mode. The year is fixed rather than carried
 * anywhere, because Birthday mode ignores it on both ends (spec D2) — 2000
 * only so that 29 February, a value `birth_md` genuinely holds, has a year to
 * sit on when the box renders it. String concatenation, not a Date object,
 * for the same reason monthDayOf slices rather than parses: it never touches
 * a clock, so it cannot be misread in a different one.
 */
function birthdayDayInput(monthDay: string | undefined): string {
  return monthDay && /^\d{2}-\d{2}$/.test(monthDay) ? `2000-${monthDay}` : '';
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
