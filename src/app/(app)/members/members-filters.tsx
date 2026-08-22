'use client';

import { useTranslations } from 'next-intl';
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { Route } from 'next';
import { Input, Select } from '@/components/ui/input';
import { MonthDayFields } from './month-day-fields';
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
  // BLOCK 31a, D4. There is no birthday pair here any more. `MonthDayFields`
  // reads `state.birthdayFrom` / `state.birthdayTo` directly and holds nothing
  // of its own: a select changes on a click rather than on a keystroke, so it
  // has no debounce to protect and therefore no reason to mirror a prop. A
  // `useState` mirroring a prop that nothing writes is how the two come to
  // disagree — which is what the two effects removed here existed to prevent.
  //
  // The registered pair above keeps its mirror, because those are typed date
  // boxes and the mirror is what lets a half-typed date survive a re-render.

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
              // setDateMode does NOT make navigate()'s own typed.dateMode
              // (above) carry the new mode for THIS call: it schedules a
              // re-render, while navigate() runs synchronously in this same
              // handler and closes over the OLD dateMode from the render
              // that is still current. What actually carries the new mode
              // into the URL here is the explicit dateMode: mode in the
              // literal below, which wins the {...typed, ...next} spread
              // inside navigate() -- it is NOT redundant with typed.dateMode
              // and must not be dropped as if it were, or Birthday mode
              // stops reaching the URL from this control.
              //
              // Calling setDateMode anyway is what makes this select and the
              // two boxes below stop showing the old mode for the round trip
              // rather than snapping back once it lands, and it is what lets
              // a LATER navigate() call from either box -- a separate event,
              // firing after this component has re-rendered with the new
              // mode -- read it from typed.dateMode on its own, with no
              // explicit dateMode of its own to pass (see their onChange,
              // below).
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

        {/*
          BLOCK 31a, D4. Two shapes, because the two windows are two different
          questions: a birthday is a day and a month with no year the filter has
          ever used, and a registration is an instant. The boxes below carried
          both until now, with a placeholder year on screen that the birthday
          half threw away.
        */}
        {dateMode === 'birthday' ? (
          <>
            <MonthDayFields
              label={t('birthdaysFrom')}
              value={state.birthdayFrom}
              onChange={(monthDay) => navigate({ birthdayFrom: monthDay })}
              testId="member-birthday-from"
            />
            <MonthDayFields
              label={t('birthdaysTo')}
              value={state.birthdayTo}
              onChange={(monthDay) => navigate({ birthdayTo: monthDay })}
              testId="member-birthday-to"
            />
          </>
        ) : (
          <>
            <label className="flex w-48 flex-col gap-1 text-sm">
              <span className="text-muted-foreground">{t('registeredFrom')}</span>
              <Input
                type="date"
                value={fromDay}
                onChange={(e) => {
                  const day = e.target.value;
                  setFromDay(day);
                  navigate({ registeredFrom: startOfLocalDay(day) });
                }}
                data-testid="member-date-from"
              />
            </label>

            <label className="flex w-48 flex-col gap-1 text-sm">
              <span className="text-muted-foreground">{t('registeredTo')}</span>
              <Input
                type="date"
                value={toDay}
                onChange={(e) => {
                  const day = e.target.value;
                  setToDay(day);
                  navigate({ registeredTo: endOfLocalDay(day) });
                }}
                data-testid="member-date-to"
              />
            </label>
          </>
        )}

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
                // it than any other control on this bar does -- read from
                // LOCAL dateMode, not state.dateMode: this Link is rendered
                // whenever hasActiveFilters(state) is true, and that can
                // still hold from a stale prop while the mode select's own
                // round trip is in flight (its old window has not yet been
                // cleared server-side). Building this href from state.dateMode
                // would let a Clear click in that window silently revert a
                // mode switch the operator already made -- the same race A1
                // fixed for the two date boxes above.
                dateMode,
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

/*
 * `monthDayOf` and `birthdayDayInput` lived here until Block 31a, D4. They were
 * the two halves of putting a birthday into an `<input type="date">`: one threw
 * the year away on the way out, the other invented a fixed year 2000 on the way
 * in, so that 29 February had somewhere to sit. `MonthDayFields` needs neither —
 * it renders the day and the month the URL already carries, and the year is gone
 * from the screen rather than hidden on it.
 */

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
