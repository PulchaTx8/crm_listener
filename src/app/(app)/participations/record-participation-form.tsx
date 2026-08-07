'use client';

import { useTranslations } from 'next-intl';
import { useActionState, useEffect, useState, useTransition } from 'react';
import { Button } from '@/components/ui/button';
import { Input, Select, Textarea } from '@/components/ui/input';
// Values from @/lib, types from the services. The Records below are values and
// cannot cross the client boundary out of a `server-only` module — the rule
// prizes-tab.tsx states at length for LINKABLE_PRIZE_PAGE_SIZE, and the reason
// @/lib/participation-status exists at all.
import { STATUS_CLASSES, STATUS_LABEL_KEYS, STATUS_MEANING_KEYS } from '@/lib/participation-status';
import { STATION_LISTENER_PAGE_SIZE } from '@/lib/station-listeners';
import type { PromotionQuestion } from '@/services/promotions';
import type { StationListener } from '@/services/participations';
// The Station-zone conversion comes from the promotions screen's module rather
// than being re-derived, on that module's own rule: two copies of a timezone
// conversion are how two controls on one screen start disagreeing about which
// day something happened (spec L2).
import { fromZonedWallClock, toZonedDateTime } from '../promotions/zone';
import {
  recordParticipationAction,
  searchStationListenersAction,
  type RecordParticipationState,
} from './actions';

const INITIAL: RecordParticipationState = { status: 'idle' };

/**
 * The same figure every debounced control in this app uses, repeated rather
 * than imported for the reason prizes-tab.tsx gives for repeating it: those are
 * a list's navigation delay and this is a picker's server round trip, and one
 * shared constant would tie two unrelated decisions together.
 */
const SEARCH_DEBOUNCE_MS = 350;

/** How a picked listener reads in the confirmation line. */
function describeListener(listener: StationListener): string {
  const identifiers = [
    listener.phone,
    listener.cpfLastDigits ? `···${listener.cpfLastDigits}` : null,
  ].filter(Boolean);
  const name = listener.fullName ?? 'Unnamed listener';
  return identifiers.length ? `${name} — ${identifiers.join(' · ')}` : name;
}

/**
 * One entry, typed by hand.
 *
 * Two ways to name the listener and they are the same two the schema takes
 * (schemas/participations.ts): pick somebody already at this Station, or type
 * their details and let resolve_or_create_member find or register them (design
 * spec D4). The picker is Station-scoped because apply_participation refuses a
 * listener the promotion's Station is not linked to, so an Organization-wide
 * one would offer people this form cannot enter.
 *
 * **What comes back is an outcome, not a verdict on the operator.** Repeating,
 * coming back early and passing the ceiling are all RECORDED, each with the
 * status that says so — design spec D5 — so this form reports what happened and
 * never renders three of the four statuses as a failure. That distinction is
 * the reason the result panel below is not simply "saved / error".
 */
export function RecordParticipationForm({
  promotionId,
  companyId,
  timeZone,
  questions,
  canFindListeners,
  canRegisterListeners,
  onCancel,
  onRecorded,
}: {
  promotionId: string;
  companyId: string;
  timeZone: string;
  questions: PromotionQuestion[];
  /** members.view. Without it neither way of naming a listener works — see the note rendered below. */
  canFindListeners: boolean;
  /** members.create. Only the "somebody new" half needs it. */
  canRegisterListeners: boolean;
  onCancel: () => void;
  /** Called after every recorded attempt, whatever its status, so the tab re-reads its counts. */
  onRecorded: () => void;
}) {
  const t = useTranslations('participations');
  // The shared enum vocabulary, which several screens render.
  const tv = useTranslations('vocab');
  const [state, action, pending] = useActionState(recordParticipationAction, INITIAL);

  const [picked, setPicked] = useState<StationListener | null>(null);
  const [search, setSearch] = useState('');
  const [options, setOptions] = useState<StationListener[]>([]);
  const [cut, setCut] = useState(false);
  const [searchFailure, setSearchFailure] = useState<string | null>(null);
  const [searching, startSearching] = useTransition();

  // Safe to read the clock in a lazy initializer: this form is only ever
  // mounted from the record dialog, whose body renders nothing until the record
  // has come back from a client-side read, so there is no server render of it
  // for a differing `now` to disagree with.
  const [when, setWhen] = useState(() => toZonedDateTime(new Date().toISOString(), timeZone));

  /** Bumped to remount the fields after a recorded entry, so the next one starts blank. */
  const [round, setRound] = useState(0);
  const [showResult, setShowResult] = useState(false);

  useEffect(() => {
    if (state.status === 'idle') return;
    setShowResult(true);
    // Every recorded attempt, not only the VALID ones: a DUPLICATE is a row in
    // the table and the tab's refused count has just changed.
    //
    // And every ATTEMPTED one, even the failures. A thrown error does not prove
    // nothing was written — a transport failure after record_participation
    // committed is indistinguishable here from one that never reached it — so
    // re-reading is the only answer that is right either way. A failure before
    // the call (the schema, the listener) carries no `attempted` and does not
    // re-read, because nothing could have changed.
    if (state.status === 'recorded' || (state.status === 'error' && state.attempted)) {
      onRecorded();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  // Debounced, because it runs per keystroke and each run is a server round
  // trip. Skipped entirely once somebody is picked, and when this caller cannot
  // search at all.
  useEffect(() => {
    if (!canFindListeners || picked) return;
    let current = true;
    const timer = setTimeout(() => {
      startSearching(async () => {
        const result = await searchStationListenersAction(companyId, search);
        // The answer to a term the operator has already typed past must not
        // land. The debounce narrows that window and does not close it: two
        // requests can be in flight whenever one is slower than the pause
        // between two keystrokes. Same guard prizes-tab.tsx and the record
        // dialog both use for their own reads.
        if (!current) return;
        if (result.status === 'ok') {
          setOptions(result.page.listeners);
          setCut(result.page.hasMore);
          setSearchFailure(null);
          return;
        }
        setOptions([]);
        setCut(false);
        setSearchFailure(result.message);
      });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [companyId, search, picked, canFindListeners]);

  function recordAnother() {
    setShowResult(false);
    setPicked(null);
    setSearch('');
    setOptions([]);
    setCut(false);
    setWhen(toZonedDateTime(new Date().toISOString(), timeZone));
    setRound((r) => r + 1);
  }

  if (!canFindListeners) {
    return (
      <div className="flex flex-col gap-3 rounded-md border p-4" data-testid="participation-record-form">
        <p className="text-sm text-muted-foreground">
          {t('recordingAnEntryByHandNeeds')}</p>
        <div>
          <Button type="button" variant="outline" onClick={onCancel}>
            {t('close')}</Button>
        </div>
      </div>
    );
  }

  return (
    <form
      action={action}
      className="flex flex-col gap-4 rounded-md border p-4"
      data-testid="participation-record-form"
    >
      <input type="hidden" name="promotionId" value={promotionId} />
      {/* No companyId is posted. The action derives the Station from the
          promotion itself (getPromotionStationId), because a Station read off
          the form is one the server never established: it let a caller register
          a listener into one Station's audience while naming another Station's
          promotion. `companyId` is still a prop here — the picker below
          searches one Station's listeners — but it is a read, and a read the
          database bounds. */}
      {picked && <input type="hidden" name="memberId" value={picked.memberId} />}

      <div key={round} className="flex flex-col gap-4">
        {picked ? (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-muted/50 p-3">
            <span className="text-sm" data-testid="participation-picked-listener">
              {describeListener(picked)}
            </span>
            <Button type="button" variant="outline" onClick={() => setPicked(null)}>
              {t('chooseSomebodyElse')}</Button>
          </div>
        ) : (
          <>
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-muted-foreground">{t('findAListenerAtThisStation')}</span>
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={t('namePhoneOrCpfDigits')}
                data-testid="participation-listener-search"
              />
              {/* No silent caps: a list that stops has to say so, or an
                  operator hunting for the person who is not there concludes
                  they were never registered. Driven by the service's own
                  hasMore — one row read past the page — rather than by a full
                  page, so a Station with exactly twenty matches is not told
                  about a truncation that did not happen. */}
              {cut && (
                <span className="text-xs text-muted-foreground" data-testid="participation-listener-cut">
                  {t('showingTheFirst')}{' '}{STATION_LISTENER_PAGE_SIZE}. Narrow the search to reach the rest.
                </span>
              )}
              {searching && <span className="text-xs text-muted-foreground">{t('looking')}</span>}
              {searchFailure && <span className="text-xs text-destructive">{searchFailure}</span>}
            </label>

            {options.length > 0 && (
              <ul className="flex flex-col gap-1" data-testid="participation-listener-options">
                {options.map((listener) => (
                  <li key={listener.memberId}>
                    <button
                      type="button"
                      onClick={() => setPicked(listener)}
                      className="w-full rounded-md border px-3 py-2 text-left text-sm ring-offset-background hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                      data-testid="participation-listener-option"
                    >
                      {describeListener(listener)}
                    </button>
                  </li>
                ))}
              </ul>
            )}

            {/* The second way in, and not a fallback for a failed search: an
                operator taking a call has the person's number in front of them
                and no reason to search first. resolve_or_create_member finds
                whoever already holds that phone or CPF and registers them when
                nobody does (design spec D4), so typing is the same
                deduplication the picker reads from. */}
            <fieldset className="flex flex-col gap-3 rounded-md border border-dashed p-3">
              <legend className="px-1 text-xs text-muted-foreground">
                {t('orEnterWhoIsTakingPart')}</legend>

              <label className="flex flex-col gap-1 text-sm">
                <span className="text-muted-foreground">{t('name')}</span>
                <Input name="fullName" maxLength={200} data-testid="participation-full-name" />
              </label>

              <div className="grid gap-3 sm:grid-cols-2">
                <label className="flex flex-col gap-1 text-sm">
                  <span className="text-muted-foreground">{t('phone')}</span>
                  <Input name="phone" maxLength={40} data-testid="participation-phone" />
                </label>
                <label className="flex flex-col gap-1 text-sm">
                  <span className="text-muted-foreground">CPF</span>
                  <Input name="cpf" maxLength={14} data-testid="participation-cpf" />
                </label>
              </div>

              <p className="text-xs text-muted-foreground">
                {t('aPhoneNumberOrACpf')}</p>

              {!canRegisterListeners && (
                <p className="text-xs text-muted-foreground" data-testid="participation-register-note">
                  {t('youCannotRegisterListenersAtThis')}</p>
              )}
            </fieldset>
          </>
        )}

        <label className="flex w-72 flex-col gap-1 text-sm">
          <span className="text-muted-foreground">{t('whenTheyEntered')}</span>
          <Input
            type="datetime-local"
            value={when}
            onChange={(e) => setWhen(e.target.value)}
            required
            data-testid="participation-when"
          />
          {/* The visible control speaks the Station's wall clock and the hidden
              one beside it carries the instant. Not decoration and not a
              convenience: design spec D7 measures the minimum interval against
              THIS value rather than against when the row was written, so an
              entry backdated to last night is judged against last night. */}
          <input
            type="hidden"
            name="participatedAt"
            value={fromZonedWallClock(when, timeZone) ?? ''}
          />
          <span className="text-xs text-muted-foreground">
            {t('thisStationSLocalTime')}{timeZone}).
          </span>
        </label>

        {questions.length > 0 && (
          <fieldset className="flex flex-col gap-3 rounded-md border p-3">
            <legend className="px-1 text-xs text-muted-foreground">{t('answers')}</legend>
            {questions.map((question) => (
              <label key={question.id} className="flex flex-col gap-1 text-sm">
                <span>{question.prompt}</span>
                {/* Every question posts all three fields, whichever kind it is,
                    because the action pairs them up by position. The empty
                    hidden partner below is what keeps the three lists the same
                    length: drop it and one essay in the middle of a quiz pairs
                    every answer after it with the wrong question. */}
                <input type="hidden" name="answerQuestionId" value={question.id} />
                {question.kind === 'ESSAY' ? (
                  <>
                    <Textarea
                      name="answerText"
                      rows={2}
                      maxLength={2000}
                      data-testid="participation-answer-text"
                    />
                    <input type="hidden" name="answerOptionId" value="" />
                  </>
                ) : (
                  <>
                    <Select name="answerOptionId" data-testid="participation-answer-option">
                      <option value="">{t('noAnswer')}</option>
                      {question.options.map((option) => (
                        <option key={option.id} value={option.id}>
                          {option.label}
                        </option>
                      ))}
                    </Select>
                    <input type="hidden" name="answerText" value="" />
                  </>
                )}
              </label>
            ))}
            {/* Stated because the opposite is the intuitive guess, and it was
                the project's own guess until design spec D2 corrected it:
                nobody is refused for answering wrongly. What was answered is
                stored whatever the status, and whether it was right is a
                draw-time question Block 6 asks of the answer. */}
            <p className="text-xs text-muted-foreground">
              {t('aWrongAnswerRefusesNobodyLeaving')}</p>
          </fieldset>
        )}
      </div>

      {showResult && state.status === 'recorded' && (
        <div
          className="flex flex-col gap-2 rounded-md border p-3"
          data-testid="participation-record-outcome"
        >
          <span
            className={`w-fit rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_CLASSES[state.outcome]}`}
            data-testid="participation-record-status"
          >
            {tv(STATUS_LABEL_KEYS[state.outcome])}
          </span>
          <p className="text-sm">{tv(STATUS_MEANING_KEYS[state.outcome])}</p>
          {state.listener === 'created' && (
            <p className="text-xs text-muted-foreground" data-testid="participation-listener-created">
              {t('nobodyAtThisStationHeldThat')}</p>
          )}
          <div>
            <Button type="button" variant="outline" onClick={recordAnother}>
              {t('recordAnotherEntry')}</Button>
          </div>
        </div>
      )}

      {/*
        `elsewhere` is neither a write nor our failure, and saying so precisely
        is the whole point of this branch existing (services/participations.ts,
        resolve_or_create_member's own comment): the identifier belongs to
        somebody already registered in this Organization, at a Station this
        caller cannot reach. The RPC deliberately returns no id for that case,
        and registering a second listener with the same identifier is impossible
        anyway — 0031's per-Organization unique indexes on phone, e-mail, CPF and
        passport would refuse the duplicate. So nothing was written, nothing can
        be forced, and the way out is somebody who can reach that listener, not
        a retry.
      */}
      {showResult && state.status === 'out-of-reach' && (
        <p className="text-sm" data-testid="participation-out-of-reach">
          {t('thatPhoneOrCpfAlreadyBelongs')}</p>
      )}

      {showResult && state.status === 'error' && (
        <p className="text-sm text-destructive" data-testid="participation-record-error">
          {state.message}
        </p>
      )}

      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={onCancel}>
          {t('close')}</Button>
        <Button type="submit" disabled={pending} data-testid="participation-record-submit">
          {pending ? t('recording') : t('recordEntry')}
        </Button>
      </div>
    </form>
  );
}
