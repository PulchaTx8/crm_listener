'use client';

import { useTranslations } from 'next-intl';
import { useActionState, useEffect, useId, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import type { ReferenceSummary, SongSummary } from '@/services/music';
// The tab tuple is declared with parseRecordParam rather than here, because the
// grid that opens this dialog reads it too and a Server Component elsewhere
// cannot import a value out of a client module. See src/lib/record-params.ts.
import { SONG_TABS, type SongTab } from '@/lib/record-params';
import { SongThumb } from '@/components/music/song-thumb';
import { updateSongAction, type SongSaveState } from './actions';
import { linkToDeezerAction, unlinkFromDeezerAction, type DeezerLinkState } from './deezer-actions';
import { DeezerTab } from './deezer-tab';
import type { DeezerSearchRow } from './deezer-marking';
import { getSongRecordAction, type SongRecord } from './record';
import { SongFields } from './song-fields';

// Catalogue keys, not words: a module body has no request behind it.
const TAB_LABEL_KEYS: Record<SongTab, string> = { data: 'songData', deezer: 'deezerSearch' };

const INITIAL_SAVE: SongSaveState = { status: 'idle' };
const INITIAL_LINK: DeezerLinkState = { status: 'idle' };

/**
 * One song's whole record over the Songs list. Same shape as the prize
 * record (inventory/prize-record-dialog.tsx): one read per opening, rendered
 * from it, so nothing here can re-run the list query behind the dialog.
 *
 * Two tabs since Block 13a (SONG_TABS === ['data', 'deezer']). This comment
 * used to say there was one, and predicted that a second would cost "a tuple
 * entry and a label, not a rewrite of this component" — because the strip
 * below maps over the tuple rather than hard-coding "data". That turned out to
 * be true, and the prediction is left here as the reason the pattern is worth
 * keeping rather than as a boast.
 */
export function SongRecordDialog({
  recordId,
  tab,
  artists,
  labels,
  genres,
  albums,
  categories,
  companyId,
  manage,
  onTab,
  onClose,
  onSaved,
  onOpenExisting,
  onLoaded,
}: {
  recordId: string | null;
  tab: SongTab;
  artists: ReferenceSummary[];
  labels: ReferenceSummary[];
  genres: ReferenceSummary[];
  albums: ReferenceSummary[];
  categories: ReferenceSummary[];
  /** The Station this record belongs to — the Deezer tab searches on its behalf and marks what it already holds. */
  companyId: string;
  /** Whether the caller holds music.manage at this Station — a courtesy gate, never the boundary; update_song re-checks it itself. */
  manage: boolean;
  onTab: (tab: SongTab) => void;
  onClose: () => void;
  onSaved: (song: SongSummary) => void;
  /** A recording already registered here: the Deezer tab offers its record instead of offering to register it twice. */
  onOpenExisting: (songId: string) => void;
  /** Every successful read of a record, which is how a song registered a moment ago gets its row: the grid opens the new record and takes the row from this read rather than a second one of its own. */
  onLoaded?: (song: SongSummary) => void;
}) {
  const t = useTranslations('music');
  const titleId = useId();
  const [record, setRecord] = useState<SongRecord | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    if (!recordId) {
      setRecord(null);
      setFailure(null);
      setDirty(false);
      return;
    }
    let current = true;
    setLoading(true);
    setFailure(null);
    void getSongRecordAction(recordId).then((result) => {
      if (!current) return;
      setLoading(false);
      if (result.status === 'ok') {
        setRecord(result.record);
        onLoaded?.(result.record.song);
        return;
      }
      setRecord(null);
      setFailure(
        result.status === 'not-found' ? t('noSuchSongOrYouDo') : result.message,
      );
    });
    return () => {
      current = false;
    };
    // onLoaded is stable for this dialog's lifetime, and adding it would make
    // the record re-read whenever the grid re-renders its callback.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recordId, reloadToken]);

  function requestClose() {
    if (dirty && !window.confirm(t('discardTheChangesYouHaveNotSaved'))) return;
    setDirty(false);
    onClose();
  }

  return (
    <Dialog open={recordId !== null} onClose={requestClose} labelledBy={titleId}>
      <DialogHeader>
        {record && <SongThumb coverMd5={record.song.coverMd5} size="md" />}
        <DialogTitle id={titleId}>{record?.song.title ?? (loading ? t('loading') : t('song'))}</DialogTitle>
        <button
          type="button"
          onClick={requestClose}
          aria-label={t('closeRecord')}
          className="rounded-md p-1.5 ring-offset-background hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        >
          <X className="size-4" aria-hidden="true" />
        </button>
      </DialogHeader>

      {record && (
        <div role="tablist" aria-label={t('recordSections')} className="flex gap-1 border-b px-5">
          {SONG_TABS.map((name) => (
            <button
              key={name}
              type="button"
              role="tab"
              aria-selected={tab === name}
              onClick={() => onTab(name)}
              className={
                tab === name
                  ? 'border-b-2 border-primary px-3 py-2 text-sm font-medium'
                  : 'border-b-2 border-transparent px-3 py-2 text-sm text-muted-foreground hover:text-foreground'
              }
            >
              {t(TAB_LABEL_KEYS[name])}
            </button>
          ))}
        </div>
      )}

      <DialogBody>
        {loading && <p className="text-sm text-muted-foreground">{t('loadingTheRecord')}</p>}

        {failure && (
          <div className="flex flex-col items-start gap-3">
            <p className="text-sm text-destructive">{failure}</p>
            <Button type="button" variant="outline" onClick={() => setReloadToken((n) => n + 1)}>
              {t('tryAgain')}</Button>
          </div>
        )}

        {record && tab === 'data' && (
          <>
            {manage ? (
              <SongDataForm
                song={record.song}
                artists={artists}
                labels={labels}
                genres={genres}
                albums={albums}
                categories={categories}
                onDirty={setDirty}
                onSaved={(saved) => {
                  setDirty(false);
                  setRecord({ ...record, song: saved });
                  onSaved(saved);
                }}
              />
            ) : (
              <div className="flex flex-col gap-4">
                <p className="text-sm text-muted-foreground">
                  {t('youDoNotHoldMusicManage2')}</p>
                <SongFields
                  song={record.song}
                  artists={artists}
                  labels={labels}
                  genres={genres}
                  albums={albums}
                  categories={categories}
                  disabled
                />
              </div>
            )}
          </>
        )}

        {record && tab === 'deezer' && (
          <>
            {manage ? (
              <LinkPanel
                song={record.song}
                companyId={companyId}
                onLinked={(saved) => {
                  setRecord({ ...record, song: saved });
                  onSaved(saved);
                  // Back to the fields, where the code and the cover it just
                  // wrote are visible. Staying on a results list after the
                  // write landed would leave the operator guessing whether it
                  // did.
                  onTab('data');
                }}
                onOpenExisting={onOpenExisting}
              />
            ) : (
              <p className="text-sm text-muted-foreground">{t('youDoNotHoldMusicManage2')}</p>
            )}
          </>
        )}
      </DialogBody>

      <DialogFooter>
        <Button type="button" variant="outline" onClick={requestClose}>
          {t('close')}</Button>
      </DialogFooter>
    </Dialog>
  );
}

/**
 * Every field on every save: update_song (0101) sets each column it takes on
 * every call, so a partial submission blanks whatever it leaves out — the
 * same warning prize-record-dialog.tsx's PrizeDataForm carries.
 */
function SongDataForm({
  song,
  artists,
  labels,
  genres,
  albums,
  categories,
  onDirty,
  onSaved,
}: {
  song: SongSummary;
  artists: ReferenceSummary[];
  labels: ReferenceSummary[];
  genres: ReferenceSummary[];
  albums: ReferenceSummary[];
  categories: ReferenceSummary[];
  onDirty: (dirty: boolean) => void;
  onSaved: (song: SongSummary) => void;
}) {
  const t = useTranslations('music');
  const [state, action, pending] = useActionState(updateSongAction, INITIAL_SAVE);

  useEffect(() => {
    if (state.status === 'saved' && state.song) onSaved(state.song);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  return (
    <form
      action={action}
      onChange={() => onDirty(true)}
      data-testid="song-data-form"
      className="flex flex-col gap-3"
    >
      <input type="hidden" name="songId" value={song.id} />

      <SongFields
        song={song}
        artists={artists}
        labels={labels}
        genres={genres}
        albums={albums}
        categories={categories}
      />

      <div className="flex items-center gap-3">
        <Button type="submit" disabled={pending}>
          {pending ? t('saving') : t('save')}
        </Button>
        {state.status === 'error' && <span className="text-sm text-destructive">{state.message}</span>}
        {state.status === 'saved' && <span className="text-sm text-muted-foreground">{t('saved')}</span>}
      </div>
    </form>
  );
}

/**
 * The Deezer tab on a song that already exists (design D10).
 *
 * This is the only path by which the catalogue built before Block 13a — and
 * everything Block 9's import will bring — ever gets a cover. Without it, only
 * songs registered from this day forward would have one, and every screen
 * would read as half-illustrated for years.
 *
 * A link writes the code, the album and (only if absent) the ISRC. It touches
 * NOTHING the operator typed: somebody who has curated a record for a year is
 * not corrected by a catalogue. link_song_to_deezer (0139) is where that rule
 * is actually enforced; this component simply has no field with which to break
 * it.
 */
function LinkPanel({
  song,
  companyId,
  onLinked,
  onOpenExisting,
}: {
  song: SongSummary;
  companyId: string;
  onLinked: (song: SongSummary) => void;
  onOpenExisting: (songId: string) => void;
}) {
  const t = useTranslations('music');
  const [linkState, linkAction, linking] = useActionState(linkToDeezerAction, INITIAL_LINK);
  const [unlinkState, unlinkAction, unlinking] = useActionState(
    unlinkFromDeezerAction,
    INITIAL_LINK,
  );
  const formRef = useRef<HTMLFormElement | null>(null);
  const [pendingTrack, setPendingTrack] = useState<DeezerSearchRow | null>(null);

  useEffect(() => {
    if (linkState.status === 'saved' && linkState.song) onLinked(linkState.song);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [linkState]);

  useEffect(() => {
    if (unlinkState.status === 'saved' && unlinkState.song) onLinked(unlinkState.song);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unlinkState]);

  // The chosen row is submitted through a real <form action={...}>, so the
  // link goes through useActionState like every other write in this block
  // rather than through a bespoke fetch. The row's values land in hidden
  // fields and the form submits itself once React has rendered them.
  useEffect(() => {
    if (pendingTrack) formRef.current?.requestSubmit();
  }, [pendingTrack]);

  return (
    <div className="flex flex-col gap-4">
      {song.deezerTrackId !== null && (
        <div className="flex flex-wrap items-center gap-3 rounded-md border p-3">
          <SongThumb coverMd5={song.coverMd5} size="md" />
          <div className="flex-1 text-sm">
            <p className="font-medium">{t('deezerCode')}</p>
            <p className="text-muted-foreground">{song.deezerTrackId}</p>
          </div>
          <form action={unlinkAction}>
            <input type="hidden" name="songId" value={song.id} />
            <Button type="submit" variant="outline" disabled={unlinking} data-testid="deezer-unlink">
              {unlinking ? t('unlinking') : t('unlinkFromDeezer')}
            </Button>
          </form>
        </div>
      )}

      <form action={linkAction} ref={formRef}>
        <input type="hidden" name="songId" value={song.id} />
        <input type="hidden" name="deezerTrackId" value={pendingTrack?.id ?? ''} />
        <input type="hidden" name="deezerAlbumId" value={pendingTrack?.albumId ?? ''} />
        <input type="hidden" name="albumTitle" value={pendingTrack?.albumTitle ?? ''} />
        <input type="hidden" name="coverMd5" value={pendingTrack?.coverMd5 ?? ''} />
        <input type="hidden" name="isrc" value={pendingTrack?.isrc ?? ''} />
      </form>

      {linkState.status === 'error' && (
        <p className="text-sm text-destructive">{linkState.message}</p>
      )}
      {unlinkState.status === 'error' && (
        <p className="text-sm text-destructive">{unlinkState.message}</p>
      )}

      <DeezerTab
        companyId={companyId}
        mode="link"
        linking={linking}
        onLink={setPendingTrack}
        onOpenExisting={onOpenExisting}
      />
    </div>
  );
}
