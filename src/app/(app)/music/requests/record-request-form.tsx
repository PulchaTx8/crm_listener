'use client';

import { useTranslations } from 'next-intl';
import { useActionState, useEffect, useState, useTransition } from 'react';
import { Button } from '@/components/ui/button';
import { Input, Select } from '@/components/ui/input';
import type { ReferenceSummary, SongOption } from '@/services/music';
import type { StationListener } from '@/services/participations';
// The Station-zone conversion comes from the promotions screen's own module,
// on that module's own rule: a second copy of a timezone conversion is how
// two controls on this app start disagreeing about which day something
// happened (spec L2). record-participation-form.tsx reuses it for the same
// reason.
import { fromZonedWallClock } from '../../promotions/zone';
import {
  recordRequestAction,
  searchRequestListenersAction,
  searchRequestSongsAction,
  type RecordRequestState,
} from './actions';

const INITIAL: RecordRequestState = { ok: null };

/** The same figure record-participation-form.tsx uses for its own picker, repeated rather than imported for that module's own reason: two unrelated pickers sharing one constant is a seam worth not having. */
const SEARCH_DEBOUNCE_MS = 350;

/** How a picked listener reads in the confirmation line — the same shape describeListener has on the participation form. */
function describeListener(listener: StationListener, t: (key: string) => string): string {
  const identifiers = [
    listener.phone,
    listener.cpfLastDigits ? `···${listener.cpfLastDigits}` : null,
  ].filter(Boolean);
  const name = listener.fullName ?? t('unnamedListener');
  return identifiers.length ? `${name} — ${identifiers.join(' · ')}` : name;
}

/** How a picked song reads in the picker and the confirmation line. */
function describeSong(song: SongOption): string {
  return song.artistName ? `${song.title} — ${song.artistName}` : song.title;
}

/**
 * What the hidden `requestedAt` field posts. Blank stays blank — that is how
 * this form says "now" (requestFormSchema's own blankToUndefined turns it
 * into the absence create_music_request's `coalesce(…, now())` wants).
 *
 * `fromZonedWallClock` returns `undefined` only when the wall-clock string it
 * was given does not parse — practically unreachable from a native
 * `datetime-local` control — but falling back to `''` in that case would mean
 * exactly the same thing blank already means: "record it as now", silently,
 * for an operator who typed a specific time. That is the one failure mode
 * the `requestedAt` guard on the schema exists to close, so this does not
 * reopen it here: an unconverted value is sent through as-is, which
 * `requestFormSchema`'s `z.string().datetime()` check refuses (a bare
 * `datetime-local` value carries no 'Z' designator), surfacing the guard's
 * own message instead of a wrong instant nobody asked for.
 */
function requestedAtFieldValue(whenLocal: string, timeZone: string): string {
  if (!whenLocal) return '';
  return fromZonedWallClock(whenLocal, timeZone) ?? whenLocal;
}

/**
 * One request, typed by hand — the shape record-participation-form.tsx
 * already solved, with a second search-and-pick half added for the song.
 *
 * Two ways to name the listener, exactly the two requestFormSchema takes
 * (schemas/music.ts): pick somebody already at this Station, or type their
 * details and let resolveOrCreateMember find or register them (Block 3's
 * deduplication, D4). The picker is Station-scoped because
 * create_music_request refuses a listener not linked to this Station, so an
 * Organization-wide one would offer people this form cannot enter.
 *
 * The song half has no free-text alternative — D5: a request always names a
 * catalogued song, picked from searchSongs, which excludes archived songs on
 * its own terms (services/music.ts's own comment on that exclusion).
 */
export function RecordRequestForm({
  companyId,
  timeZone,
  shows,
  canFindListeners,
  canRegisterListeners,
  onCancel,
}: {
  companyId: string;
  timeZone: string;
  shows: ReferenceSummary[];
  /** members.view. Without it neither way of naming a listener works — see the note rendered below. */
  canFindListeners: boolean;
  /** members.create. Only the "somebody new" half needs it. */
  canRegisterListeners: boolean;
  onCancel: () => void;
}) {
  const t = useTranslations('music');
  const [state, action, pending] = useActionState(recordRequestAction, INITIAL);

  const [pickedListener, setPickedListener] = useState<StationListener | null>(null);
  const [listenerSearch, setListenerSearch] = useState('');
  const [listenerOptions, setListenerOptions] = useState<StationListener[]>([]);
  const [listenerCut, setListenerCut] = useState(false);
  const [listenerSearchFailure, setListenerSearchFailure] = useState<string | null>(null);
  const [listenerSearching, startListenerSearch] = useTransition();

  const [pickedSong, setPickedSong] = useState<SongOption | null>(null);
  const [songSearch, setSongSearch] = useState('');
  const [songOptions, setSongOptions] = useState<SongOption[]>([]);
  const [songCut, setSongCut] = useState(false);
  const [songSearchFailure, setSongSearchFailure] = useState<string | null>(null);
  const [songSearching, startSongSearch] = useTransition();

  const [whenLocal, setWhenLocal] = useState('');

  /** Bumped to remount the fields after a recorded entry, so the next one starts blank. */
  const [round, setRound] = useState(0);
  const [showResult, setShowResult] = useState(false);

  useEffect(() => {
    if (state.ok === null) return;
    setShowResult(true);
  }, [state]);

  // Debounced, because it runs per keystroke. Skipped once somebody is
  // picked, and when this caller cannot search at all.
  useEffect(() => {
    if (!canFindListeners || pickedListener) return;
    let current = true;
    const timer = setTimeout(() => {
      startListenerSearch(async () => {
        const result = await searchRequestListenersAction(companyId, listenerSearch);
        // The answer to a term the operator has already typed past must not
        // land — the same guard record-participation-form.tsx uses for its
        // own read.
        if (!current) return;
        if (result.status === 'ok') {
          setListenerOptions(result.page.listeners);
          setListenerCut(result.page.hasMore);
          setListenerSearchFailure(null);
          return;
        }
        setListenerOptions([]);
        setListenerCut(false);
        setListenerSearchFailure(result.message);
      });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [companyId, listenerSearch, pickedListener, canFindListeners]);

  useEffect(() => {
    if (pickedSong) return;
    let current = true;
    const timer = setTimeout(() => {
      startSongSearch(async () => {
        const result = await searchRequestSongsAction(companyId, songSearch);
        if (!current) return;
        if (result.status === 'ok') {
          setSongOptions(result.page.songs);
          setSongCut(result.page.hasMore);
          setSongSearchFailure(null);
          return;
        }
        setSongOptions([]);
        setSongCut(false);
        setSongSearchFailure(result.message);
      });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [companyId, songSearch, pickedSong]);

  function recordAnother() {
    setShowResult(false);
    setPickedListener(null);
    setListenerSearch('');
    setListenerOptions([]);
    setListenerCut(false);
    setPickedSong(null);
    setSongSearch('');
    setSongOptions([]);
    setSongCut(false);
    setWhenLocal('');
    setRound((r) => r + 1);
  }

  if (!canFindListeners) {
    return (
      <div className="flex flex-col gap-3 rounded-md border p-4" data-testid="request-record-form">
        <p className="text-sm text-muted-foreground">
          {t('recordingARequestByHandNeeds')}</p>
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
      className="flex flex-col gap-4"
      data-testid="request-record-form"
    >
      <input type="hidden" name="companyId" value={companyId} />
      {pickedListener && <input type="hidden" name="memberId" value={pickedListener.memberId} />}
      {pickedSong && <input type="hidden" name="songId" value={pickedSong.songId} />}
      {/* Blank means "now" (create_music_request's own coalesce) — the hidden
          field carries '' rather than being omitted, so a submission with
          nothing typed still posts a value the schema's blankToUndefined
          turns into the same absence. */}
      <input type="hidden" name="requestedAt" value={requestedAtFieldValue(whenLocal, timeZone)} />

      <div key={round} className="flex flex-col gap-4">
        {pickedListener ? (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-muted/50 p-3">
            <span className="text-sm" data-testid="request-picked-listener">
              {describeListener(pickedListener, t)}
            </span>
            <Button type="button" variant="outline" onClick={() => setPickedListener(null)}>
              {t('chooseSomebodyElse')}</Button>
          </div>
        ) : (
          <>
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-muted-foreground">{t('findAListenerAtThisStation')}</span>
              <Input
                value={listenerSearch}
                onChange={(e) => setListenerSearch(e.target.value)}
                placeholder={t('namePhoneOrCpfDigits')}
                data-testid="request-listener-search"
              />
              {listenerCut && (
                <span className="text-xs text-muted-foreground" data-testid="request-listener-cut">
                  {t('showingTheFirstMatchesNarrowThe')}</span>
              )}
              {listenerSearching && <span className="text-xs text-muted-foreground">{t('looking')}</span>}
              {listenerSearchFailure && (
                <span className="text-xs text-destructive">{listenerSearchFailure}</span>
              )}
            </label>

            {listenerOptions.length > 0 && (
              <ul className="flex flex-col gap-1" data-testid="request-listener-options">
                {listenerOptions.map((listener) => (
                  <li key={listener.memberId}>
                    <button
                      type="button"
                      onClick={() => setPickedListener(listener)}
                      className="w-full rounded-md border px-3 py-2 text-left text-sm ring-offset-background hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                      data-testid="request-listener-option"
                    >
                      {describeListener(listener, t)}
                    </button>
                  </li>
                ))}
              </ul>
            )}

            {/* The second way in — typing somebody's details and letting
                resolveOrCreateMember find or register them — the same
                deduplication the picker above reads from. */}
            <fieldset className="flex flex-col gap-3 rounded-md border border-dashed p-3">
              <legend className="px-1 text-xs text-muted-foreground">{t('orEnterWhoIsAsking')}</legend>

              <label className="flex flex-col gap-1 text-sm">
                <span className="text-muted-foreground">{t('name')}</span>
                <Input name="fullName" maxLength={200} data-testid="request-full-name" />
              </label>

              <div className="grid gap-3 sm:grid-cols-2">
                <label className="flex flex-col gap-1 text-sm">
                  <span className="text-muted-foreground">{t('phone')}</span>
                  <Input name="phone" maxLength={40} data-testid="request-phone" />
                </label>
                <label className="flex flex-col gap-1 text-sm">
                  <span className="text-muted-foreground">{t('eMail')}</span>
                  <Input name="email" type="email" maxLength={160} data-testid="request-email" />
                </label>
                <label className="flex flex-col gap-1 text-sm">
                  <span className="text-muted-foreground">CPF</span>
                  <Input name="cpf" maxLength={20} data-testid="request-cpf" />
                </label>
                <label className="flex flex-col gap-1 text-sm">
                  <span className="text-muted-foreground">{t('passport')}</span>
                  <Input name="passport" maxLength={40} data-testid="request-passport" />
                </label>
              </div>

              <p className="text-xs text-muted-foreground">
                {t('aPhoneEMailCpfOr')}</p>

              {!canRegisterListeners && (
                <p className="text-xs text-muted-foreground" data-testid="request-register-note">
                  {t('youCannotRegisterListenersAtThis')}</p>
              )}
            </fieldset>
          </>
        )}

        {pickedSong ? (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-muted/50 p-3">
            <span className="text-sm" data-testid="request-picked-song">
              {describeSong(pickedSong)}
            </span>
            <Button type="button" variant="outline" onClick={() => setPickedSong(null)}>
              {t('chooseAnotherSong')}</Button>
          </div>
        ) : (
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-muted-foreground">{t('whichSong')}</span>
            <Input
              value={songSearch}
              onChange={(e) => setSongSearch(e.target.value)}
              placeholder={t('titleOrCode')}
              data-testid="request-song-search"
            />
            {songCut && (
              <span className="text-xs text-muted-foreground" data-testid="request-song-cut">
                {t('showingTheFirstMatchesNarrowThe')}</span>
            )}
            {songSearching && <span className="text-xs text-muted-foreground">{t('looking')}</span>}
            {songSearchFailure && (
              <span className="text-xs text-destructive">{songSearchFailure}</span>
            )}
            {songOptions.length > 0 && (
              <ul className="mt-1 flex flex-col gap-1" data-testid="request-song-options">
                {songOptions.map((song) => (
                  <li key={song.songId}>
                    <button
                      type="button"
                      onClick={() => setPickedSong(song)}
                      className="w-full rounded-md border px-3 py-2 text-left text-sm ring-offset-background hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                      data-testid="request-song-option"
                    >
                      {describeSong(song)}
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <span className="text-xs text-muted-foreground">
              {t('aRequestAlwaysPointsAtA')}</span>
          </label>
        )}

        {shows.length > 0 && (
          <label className="flex w-72 flex-col gap-1 text-sm">
            <span className="text-muted-foreground">{t('programmeOptional')}</span>
            <Select name="showId" defaultValue="" data-testid="request-show-select">
              <option value="">{t('noProgramme')}</option>
              {shows.map((show) => (
                <option key={show.id} value={show.id}>
                  {show.name}
                </option>
              ))}
            </Select>
          </label>
        )}

        <label className="flex w-72 flex-col gap-1 text-sm">
          <span className="text-muted-foreground">{t('whenOptional')}</span>
          <Input
            type="datetime-local"
            value={whenLocal}
            onChange={(e) => setWhenLocal(e.target.value)}
            data-testid="request-when"
          />
          <span className="text-xs text-muted-foreground">
            {t('leaveBlankToRecordItAs')}{timeZone}
            ).
          </span>
        </label>
      </div>

      {showResult && state.ok === true && (
        <div
          className="flex flex-col gap-2 rounded-md border p-3"
          data-testid="request-record-outcome"
        >
          <p className="text-sm">{t('requestRecorded')}</p>
          {state.listener === 'created' && (
            <p className="text-xs text-muted-foreground" data-testid="request-listener-created">
              {t('nobodyAtThisStationHeldThat')}</p>
          )}
          <div>
            <Button type="button" variant="outline" onClick={recordAnother}>
              {t('recordAnotherRequest')}</Button>
          </div>
        </div>
      )}

      {showResult && state.ok === false && (
        <p className="text-sm text-destructive" data-testid="request-record-error">
          {state.message}
        </p>
      )}

      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={onCancel}>
          {t('close')}</Button>
        <Button type="submit" disabled={pending} data-testid="request-record-submit">
          {pending ? t('recording') : t('recordARequest')}
        </Button>
      </div>
    </form>
  );
}
