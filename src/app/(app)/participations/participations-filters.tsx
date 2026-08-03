'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { Route } from 'next';
import { Input, Select } from '@/components/ui/input';
import { answerFilterState } from '@/lib/participations/answer-filter';
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
  /**
   * Whether this promotion asks anything of kind QUIZ. NOT whether it asks
   * anything at all: a poll has questions and no right answer, and offering a
   * correct/wrong filter there would be a choice with one outcome, because
   * promotion_participation_correctness (0089) answers true for everybody.
   */
  hasQuiz: boolean;
}

/**
 * One question of the SELECTED promotion, with the options somebody could have
 * chosen — the second half of D5's filter.
 *
 * A question with no options is not carried: the filter is over
 * `participation_answers.option_id`, so an essay has nothing to offer here. The
 * list is empty whenever no promotion is chosen, which is what makes the control
 * disappear rather than render a picker of nothing.
 */
export interface QuestionFilterOption {
  id: string;
  label: string;
}

export interface QuestionFilterGroup {
  id: string;
  prompt: string;
  options: QuestionFilterOption[];
}

/**
 * A click, reduced to the facts that decide whether it will navigate this
 * document. `href` is null when the click was not inside an anchor at all.
 */
export interface ClickIntent {
  button: number;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  /** The anchor's RESOLVED href, or null when there was no anchor. */
  href: string | null;
  /** The anchor's `target` attribute, or null/'' when it has none. */
  target: string | null;
}

/**
 * Whether this click is about to take the browser somewhere other than where it
 * already is — which is the question the search-cancelling listener below asks,
 * and the only reason it is out here as a pure function is that it must be
 * possible to make each of its five refusals go red.
 *
 * Every `false` it returns protects something the operator typed. A cancel is
 * DESTRUCTIVE — it throws away a search in flight — so a listener that answers
 * "yes" too readily is not a smaller version of the defect it was written for,
 * it is a new one. Read the branches as five ways of not doing damage:
 *
 *   - a non-primary or modified click opens a tab, or a context menu, and
 *     leaves this document exactly where it is;
 *   - a click that is not inside an anchor is not a navigation at all;
 *   - `target="_blank"` (or a named frame) points somewhere else;
 *   - a cross-origin link leaves the app, and by the time it matters this
 *     component is gone anyway;
 *   - a link to the address we are already at undoes nothing, so there is
 *     nothing for a pending keystroke to trample.
 *
 * `_self`, `_top` and `_parent` all navigate THIS document — the app is never
 * framed, so the last two are `_self` in practice — and they are spelled out
 * rather than folded into "not _blank" so that a named frame, which is a real
 * elsewhere, keeps its refusal.
 *
 * Covered by tests/unit/participations-filters.test.ts.
 */
const SAME_DOCUMENT_TARGETS = new Set(['', '_self', '_top', '_parent']);

export function startsAnotherNavigation(intent: ClickIntent, currentHref: string): boolean {
  if (intent.button !== 0) return false;
  if (intent.metaKey || intent.ctrlKey || intent.shiftKey || intent.altKey) return false;
  if (intent.href === null) return false;
  if (!SAME_DOCUMENT_TARGETS.has(intent.target ?? '')) return false;

  let destination: URL;
  let current: URL;
  try {
    destination = new URL(intent.href, currentHref);
    current = new URL(currentHref);
  } catch {
    return false;
  }
  if (destination.origin !== current.origin) return false;
  return destination.href !== current.href;
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
  currentHref,
  timeZone,
  promotions,
  questions,
  canSearchByListener,
}: {
  state: ParticipationListState;
  /**
   * The address of the list this render represents, cursor included, built by
   * the page with the same `participationsHref` this component navigates with.
   * It is what the sync effect below watches, and it has to come from the server
   * rather than be read from the browser: it must change on EVERY navigation,
   * including the ones that leave the search term exactly where it was.
   */
  currentHref: string;
  /** The Station's zone, so the day the operator picks is that Station's day. */
  timeZone: string;
  promotions: PromotionOption[];
  /**
   * The selected promotion's questions that have options, or an empty list when
   * no promotion is selected. The page reads them; this row only renders them.
   */
  questions: QuestionFilterGroup[];
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
   * The address this component believes the list is currently at: the one the
   * server just rendered, or — between asking and being answered — the one we
   * asked for. The effect below compares the two to tell our own navigation
   * landing apart from somebody else's.
   */
  const expectedHref = useRef(currentHref);

  /**
   * The pending keystroke is cancelled when somebody else's navigation is
   * STARTED. The effect below cancels it too, and that is not a duplicate: this
   * one decides the outcome and that one repairs the input.
   *
   * The reason it cannot be left to the effect alone is structural rather than
   * a matter of tuning. That effect is keyed on `currentHref`, which is a prop
   * from the SERVER render, so it cannot run until the destination has come
   * back and committed — and this screen's render is several sequential
   * Supabase round trips (the session, the Station access, the search
   * permission, the page, the promotion picker). A debounce is a fixed number
   * of milliseconds; that round trip is not. So a guard that waits for the new
   * render is being asked to win a race nothing tells it it is in, and on any
   * stack where the render outruns the debounce it simply loses: the pending
   * timer fires first and replaces the navigation the operator just made with
   * the filters they just left, plus the search they abandoned. That was
   * measured, not inferred — the numbers and the per-case hold counts are in
   * Task 9's report rather than here, because they belong to one machine on one
   * day and this comment has to stay true on every other one. Raising the
   * debounce moves the boundary and leaves the same defect live on a slower
   * Station, which is why this is a listener.
   *
   * A capture-phase click listener on the document, because the links that
   * start those navigations are not this component's to wrap: the Station chips
   * are rendered by page.tsx, Previous/Next by the shared PageControls, and the
   * app shell owns the rest. Wrapping them would mean touching three modules
   * and remembering to do it again for the fourth. The alternatives were a
   * router event (the App Router publishes none), `useSearchParams` (still
   * commit-time, so it is the same defect) and monkey-patching `history`
   * (global, and it would fire for our own `replace` as well).
   *
   * What counts as a navigation is `startsAnotherNavigation` above, out there
   * rather than inline so that each of its five refusals can be made to fail —
   * every one of them is what stops a cancel throwing away something the
   * operator typed.
   *
   * `popstate` is here for the same reason and gets the same treatment: Back and
   * Forward are navigations the operator started, and they are the case Task 7's
   * first fix round was written for. Note what does NOT reach it — `router.replace`
   * is a `history.replaceState`, and neither that nor a Link's `pushState`
   * dispatches `popstate` — so this cancels genuine browser navigation and never
   * our own.
   */
  useEffect(() => {
    function cancelPending() {
      clearTimeout(timer.current);
    }

    function onNavigationStart(event: MouseEvent) {
      // The DOM half, kept to exactly what needs a DOM: find the anchor. The
      // decision itself is a pure function of the facts below.
      const eventTarget = event.target;
      const anchor = eventTarget instanceof Element ? eventTarget.closest('a[href]') : null;
      const link = anchor instanceof HTMLAnchorElement ? anchor : null;
      const intent: ClickIntent = {
        button: event.button,
        metaKey: event.metaKey,
        ctrlKey: event.ctrlKey,
        shiftKey: event.shiftKey,
        altKey: event.altKey,
        // `.href` on an anchor is already resolved against the document.
        href: link ? link.href : null,
        target: link ? link.target : null,
      };
      if (startsAnotherNavigation(intent, window.location.href)) cancelPending();
    }

    // Capture, so a handler that stops propagation on its way up cannot leave
    // the timer alive. It runs before the router's own handler, which only
    // means the timer is cleared microseconds before the navigation it belongs
    // to begins.
    document.addEventListener('click', onNavigationStart, true);
    window.addEventListener('popstate', cancelPending);
    return () => {
      document.removeEventListener('click', onNavigationStart, true);
      window.removeEventListener('popstate', cancelPending);
    };
  }, []);

  /**
   * Re-synced from the URL so browser back/forward leaves this input agreeing
   * with the list beside it — and, when the URL changed for a reason that was
   * not this component, the pending debounce is CANCELLED rather than left to
   * fire afterwards and undo that navigation.
   *
   * This is still the effect that decides what the INPUT says, and it is still
   * the only guard against a navigation the listener above cannot observe (a
   * programmatic push from elsewhere in the tree). What it is no longer asked to
   * do is beat the network: by the time it runs, the timer is usually already
   * cleared, and its `clearTimeout` is the backstop rather than the mechanism.
   *
   * Two things about the shape here, both of them defects this file already had
   * once each.
   *
   * FIRST, the dependency is the whole address and not `state.search`. Keyed on
   * the search term alone, the body does not run at all when an external
   * navigation leaves the term where it was — which is the ordinary case, since
   * a Station chip, Clear filters, Previous/Next and Back all carry no `q=` and
   * the term is usually already absent. `undefined → undefined` is not a change,
   * React skips the effect, and no guard written inside it can fire. The stale
   * timer then calls the stale `navigate`, which merges the PRE-navigation state
   * with the abandoned text and replaces the navigation the operator just made
   * with the filters they just left. The address changes on every one of those,
   * so it is the thing to watch.
   *
   * SECOND, the guard is a comparison against a value and not a flag consumed
   * once. Our own navigation comes back through this same effect, so clearing
   * unconditionally would cancel a keystroke typed during the round trip: type
   * "Ana", pause past the debounce, type "b" while the render is in flight, and
   * the "b" is dropped for good, where leaving it alone converges — the pending
   * timer fires with "Anab" and the next render agrees with it. A boolean set
   * before `router.replace` and cleared by the effect separates those two cases,
   * but it strands: a `replace` to the address we are already at produces no
   * render, nothing consumes the flag, and the next EXTERNAL navigation is
   * silently treated as ours. Comparing addresses cannot strand, because there
   * is no pending token to lose — a `replace` that changes nothing leaves
   * `expectedHref` equal to `currentHref`, which is exactly true.
   *
   * The one case this reads as "ours" wrongly is an external navigation to the
   * address we are already at, and by definition that one changes nothing there
   * is anything to undo.
   */
  useEffect(() => {
    if (currentHref === expectedHref.current) return;
    clearTimeout(timer.current);
    setSearch(state.search ?? '');
    typedSearch.current = state.search ?? '';
    // Accepted: this render is now what we believe we are looking at. Without
    // this, a later Forward onto an address we once sent would match the stale
    // ref and be mistaken for our own.
    expectedHref.current = currentHref;
  }, [currentHref, state.search]);

  function navigate(next: Partial<ParticipationListState>) {
    clearTimeout(timer.current);
    // Always from what is currently typed rather than from what the last render
    // was given: without this, a pending keystroke firing after a select was
    // changed would rewrite the URL from the pre-change state and undo it.
    const typed: ParticipationListState = {
      ...state,
      search: typedSearch.current.trim() || undefined,
    };
    // Built from the MERGED target rather than from `typed`, so a caller that
    // ever overrides a field in `next` is recorded as what was really sent.
    const href = participationsHref({ ...typed, ...next });
    // Recorded BEFORE the replace, so the render it produces is recognised as
    // ours however fast it arrives. Every filter drops the cursor, and the page
    // builds `currentHref` with the cursor it actually rendered, so the two
    // strings are produced by the same function over the same shape.
    expectedHref.current = href;
    // typedRoutes cannot express a query string assembled at runtime as a route
    // literal — the same cast the rest of this codebase uses.
    router.replace(href as Route);
  }

  // What the two answer filters may offer, decided in one place and read three
  // times below — the two controls and the sentence that stands in for them.
  // @/lib/participations/answer-filter holds the rules rather than this file,
  // because a rendering decision that can be wrong in the operator's favour
  // ("offer a filter that narrows to everybody") is worth unit tests, and a
  // client component's JSX is not where those go.
  const answers = answerFilterState({
    promotionId: state.promotionId,
    promotionHasQuiz: promotions.some((p) => p.id === state.promotionId && p.hasQuiz),
    promotionHasOptions: questions.some((question) => question.options.length > 0),
  });

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
        Said rather than left blank. Both answer filters need a promotion — a
        question belongs to one, and so does a right answer — so an operator who
        was told this screen can filter by what people answered would otherwise
        stand in front of a row that simply does not have it, with nothing
        naming the one click that brings it back.
      */}
      {answers.reason ? (
        <p
          className="self-end pb-2 text-xs text-muted-foreground"
          data-testid="participation-answer-filter-note"
        >
          {answers.reason}
        </p>
      ) : null}

      {/*
        Block 6c. Rendered only where there is something to be right about:
        answerFilterState needs a promotion (a right answer belongs to one) and
        needs that promotion to ask a QUIZ. A poll has questions and no right
        answer, and a correct/wrong control there would offer a choice with one
        outcome.

        'Any' is a third state rather than a default, and it matters: on a
        promotion with a quiz, drawing without narrowing is exactly the case that
        needs draws.include_wrong_answers (0078).
      */}
      {answers.correctnessAvailable ? (
        <label className="flex w-44 flex-col gap-1 text-sm">
          <span className="text-muted-foreground">Quiz answer</span>
          <Select
            value={
              state.answeredCorrectly === undefined ? '' : state.answeredCorrectly ? 'yes' : 'no'
            }
            onChange={(e) =>
              navigate({
                answeredCorrectly:
                  e.target.value === 'yes' ? true : e.target.value === 'no' ? false : undefined,
              })
            }
            data-testid="participation-answered-filter"
          >
            <option value="">Any answer</option>
            <option value="yes">Answered correctly</option>
            <option value="no">Answered wrongly</option>
          </Select>
        </label>
      ) : null}

      {/*
        D5's second filter, and the one that works where the first cannot: a poll
        has no right answer, but "who chose this option" is a question worth
        drawing on. Grouped by question, because an option label on its own —
        "Yes", "The blue one" — names nothing an operator can pick from
        confidently when a promotion asks more than one thing.

        It ANDs with the correctness filter above (D5), which is why picking an
        option somebody answered correctly and an option they did not can leave
        the list empty: that is two conditions, not two lists added together, and
        list_participations (0090) narrows exactly the same way.
      */}
      {answers.optionsAvailable ? (
        <label className="flex w-56 flex-col gap-1 text-sm">
          <span className="text-muted-foreground">Chose</span>
          <Select
            value={state.optionId ?? ''}
            onChange={(e) => navigate({ optionId: e.target.value || undefined })}
            data-testid="participation-option-filter"
          >
            <option value="">Any option</option>
            {questions.map((question) => (
              <optgroup key={question.id} label={question.prompt}>
                {question.options.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.label}
                  </option>
                ))}
              </optgroup>
            ))}
          </Select>
        </label>
      ) : null}

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
