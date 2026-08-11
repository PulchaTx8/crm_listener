'use client';

import { useActionState, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import type { WidgetTrack } from '@/lib/widget/music-mapping';
import {
  getWaitAction,
  requestSongAction,
  searchSongsAction,
  type RequestState,
  type SearchState,
} from './music-actions';

/**
 * Block 17b. The widget's first button, opened.
 *
 * FOUR STEPS IN ONE COMPONENT -- search, choose, note, done -- because they are
 * one conversation and splitting them across files would mean lifting the
 * chosen recording into a parent that has nothing else to do with it.
 *
 * THE WAIT IS ASKED FOR BEFORE ANYTHING IS SHOWN. A listener inside a Station's
 * cooldown gets told so immediately rather than after searching, choosing a
 * recording and writing a note. The ceiling is still enforced inside the write
 * (0167) -- this is courtesy, not enforcement, and the two are deliberately not
 * the same mechanism.
 */

const SEARCH_IDLE: SearchState = { status: 'idle' };
const REQUEST_IDLE: RequestState = { status: 'idle' };

/** Long enough that a typist is not a load generator, short enough to feel live. */
const DEBOUNCE_MS = 400;

/** Matches searchSchema's floor: one letter is not a search. */
const MIN_QUERY = 2;

export function RequestSongPanel({
  publicKey,
  onClose,
}: {
  publicKey: string;
  onClose: () => void;
}) {
  const t = useTranslations('widget');

  const [wait, setWait] = useState<'loading' | 'ready' | 'blocked' | 'error'>('loading');
  const [waitSeconds, setWaitSeconds] = useState(0);
  const [query, setQuery] = useState('');
  const [searchState, setSearchState] = useState<SearchState>(SEARCH_IDLE);
  const [searching, setSearching] = useState(false);
  const [chosen, setChosen] = useState<WidgetTrack | null>(null);
  const [note, setNote] = useState('');
  const [requestState, submit, sending] = useActionState(requestSongAction, REQUEST_IDLE);

  useEffect(() => {
    let live = true;
    void getWaitAction(publicKey).then((answer) => {
      if (!live) return;
      if (!answer.ok) {
        setWait('error');
        return;
      }
      setWaitSeconds(answer.waitSeconds);
      setWait(answer.waitSeconds > 0 ? 'blocked' : 'ready');
    });
    return () => {
      live = false;
    };
  }, [publicKey]);

  useEffect(() => {
    const typed = query.trim();
    if (typed.length < MIN_QUERY) {
      setSearchState(SEARCH_IDLE);
      return;
    }

    // `live` rather than an AbortController: a slow first search finishing
    // after a fast second one would otherwise replace newer results with older
    // ones, which reads as the box ignoring what was typed last.
    let live = true;
    setSearching(true);

    const timer = setTimeout(() => {
      const formData = new FormData();
      formData.set('publicKey', publicKey);
      formData.set('query', typed);

      void searchSongsAction(SEARCH_IDLE, formData).then((state) => {
        if (!live) return;
        setSearchState(state);
        setSearching(false);
      });
    }, DEBOUNCE_MS);

    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [query, publicKey]);

  if (wait === 'loading') {
    return <Shell title={t('requestASong')} onClose={onClose}>{t('searching')}</Shell>;
  }

  if (wait === 'error') {
    return (
      <Shell title={t('requestASong')} onClose={onClose}>
        <p className="text-sm text-destructive">{t('somethingWentWrong')}</p>
      </Shell>
    );
  }

  if (wait === 'blocked' && requestState.status !== 'recorded') {
    return (
      <Shell title={t('requestASong')} onClose={onClose}>
        <p className="text-sm text-muted-foreground" data-testid="widget-song-wait">
          {waitMessage(t, waitSeconds)}
        </p>
      </Shell>
    );
  }

  if (requestState.status === 'recorded') {
    return (
      <Shell title={t('requestASong')} onClose={onClose}>
        <p className="text-sm" data-testid="widget-song-recorded">
          {t('requestRecorded')}
        </p>
      </Shell>
    );
  }

  if (chosen) {
    return (
      <Shell title={t('requestASong')} onClose={onClose}>
        <form action={submit} className="flex flex-col gap-3">
          <input type="hidden" name="publicKey" value={publicKey} />
          <input type="hidden" name="deezerTrackId" value={chosen.id} />

          <TrackLine track={chosen} />

          <label className="flex flex-col gap-1 text-sm">
            {t('noteLabel')}
            <textarea
              name="note"
              value={note}
              onChange={(event) => setNote(event.target.value)}
              // The same 500 as music_requests_note_length (0167), so the
              // database is never the first thing to say no.
              maxLength={500}
              rows={3}
              className="rounded-md border bg-background p-2 text-sm"
              data-testid="widget-song-note"
            />
            <span className="text-xs text-muted-foreground">{t('noteCount', { count: note.length })}</span>
          </label>

          {requestState.status === 'refused' ? (
            <p className="text-sm text-destructive" data-testid="widget-song-error">
              {refusalMessage(t, requestState)}
            </p>
          ) : null}

          <div className="flex gap-2">
            <Button type="submit" disabled={sending} data-testid="widget-song-send">
              {sending ? t('sending') : t('sendRequest')}
            </Button>
            <Button type="button" variant="outline" onClick={() => setChosen(null)} disabled={sending}>
              {t('back')}
            </Button>
          </div>
        </form>
      </Shell>
    );
  }

  return (
    <Shell title={t('requestASong')} onClose={onClose}>
      <label className="flex flex-col gap-1 text-sm">
        {t('searchLabel')}
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          className="rounded-md border bg-background p-2 text-sm"
          autoComplete="off"
          data-testid="widget-song-search"
        />
      </label>

      {searching ? <p className="text-sm text-muted-foreground">{t('searching')}</p> : null}

      {searchState.status === 'refused' ? (
        <p className="text-sm text-destructive" data-testid="widget-song-error">
          {refusalMessage(t, searchState)}
        </p>
      ) : null}

      {searchState.status === 'results' ? (
        searchState.tracks.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('noResults')}</p>
        ) : (
          <ul className="flex flex-col gap-1" data-testid="widget-song-results">
            {searchState.tracks.map((track) => (
              <li key={track.id}>
                <button
                  type="button"
                  onClick={() => setChosen(track)}
                  className="flex w-full items-center gap-2 rounded-md border p-2 text-left hover:bg-accent"
                >
                  <TrackLine track={track} />
                </button>
              </li>
            ))}
          </ul>
        )
      ) : null}
    </Shell>
  );
}

function Shell({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const t = useTranslations('widget');

  return (
    <div
      className="flex flex-col gap-3 rounded-lg border bg-card p-4 text-card-foreground shadow-sm"
      data-testid="widget-song-panel"
    >
      <h1 className="text-base font-semibold">{title}</h1>
      {children}
      <Button type="button" variant="ghost" onClick={onClose} className="self-start">
        {t('back')}
      </Button>
    </div>
  );
}

/**
 * The cover comes straight off Deezer's CDN, which `img-src` in
 * src/lib/security/csp.ts has allowed since Block 13a. A plain <img> rather
 * than next/image: the widget is served inside somebody else's page and the
 * optimiser would put this deployment's own host in front of a third party's
 * image for no gain.
 */
function TrackLine({ track }: { track: WidgetTrack }) {
  return (
    <span className="flex items-center gap-2">
      {track.coverMd5 ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={`https://cdn-images.dzcdn.net/images/cover/${track.coverMd5}/56x56-000000-80-0-0.jpg`}
          alt=""
          width={40}
          height={40}
          className="rounded"
        />
      ) : null}
      <span className="flex flex-col">
        <span className="text-sm font-medium">{track.title}</span>
        <span className="text-xs text-muted-foreground">
          {track.artistName}
          {track.albumTitle ? ` · ${track.albumTitle}` : ''}
        </span>
      </span>
    </span>
  );
}

/**
 * Seconds into a sentence a person reads. Rounded UP, always: telling somebody
 * to come back in "2 minutes" when 2 minutes 40 remain earns a second refusal,
 * which reads as the widget lying rather than as rounding.
 */
function waitMessage(t: ReturnType<typeof useTranslations>, seconds: number): string {
  if (seconds >= 3600) return t('waitAgainInHours', { count: Math.ceil(seconds / 3600) });
  return t('waitAgainInMinutes', { count: Math.max(1, Math.ceil(seconds / 60)) });
}

function refusalMessage(
  t: ReturnType<typeof useTranslations>,
  state: { status: 'refused'; reason: string; waitSeconds?: number },
): string {
  switch (state.reason) {
    case 'cooldown':
      return waitMessage(t, state.waitSeconds ?? 60);
    case 'no_session':
      return t('identifyAgain');
    case 'rate_limited':
      return t('tooManyRequests');
    case 'deezer_quota':
      return t('searchBusy');
    case 'deezer_unavailable':
      return t('searchUnreachable');
    case 'not_found':
      return t('recordingUnreadable');
    case 'listener_anonymized':
      return t('numberCannotBeUsed');
    case 'unknown_installation':
      return t('widgetUnavailable');
    default:
      return t('somethingWentWrong');
  }
}
