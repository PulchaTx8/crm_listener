'use client';

import { useTranslations } from 'next-intl';
import { useActionState, useEffect, useId, useState } from 'react';
import { X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import type { ReferenceSummary, SongSummary } from '@/services/music';
// The tab tuple is declared with parseRecordParam rather than here, because the
// grid that opens this dialog reads it too and a Server Component elsewhere
// cannot import a value out of a client module. See src/lib/record-params.ts.
import { SONG_TABS, type SongTab } from '@/lib/record-params';
import { updateSongAction, type SongSaveState } from './actions';
import { getSongRecordAction, type SongRecord } from './record';
import { SongFields } from './song-fields';

const TAB_LABELS: Record<SongTab, string> = { data: 'Song data' };

const INITIAL_SAVE: SongSaveState = { status: 'idle' };

/**
 * One song's whole record over the Songs list. Same shape as the prize
 * record (inventory/prize-record-dialog.tsx): one read per opening, rendered
 * from it, so nothing here can re-run the list query behind the dialog.
 *
 * Only one tab exists (SONG_TABS === ['data']), unlike the prize record's
 * two — the strip below still maps over the tuple rather than hard-coding
 * "data", so a second tab added later (an Artists-screen-style history, say)
 * costs a tuple entry and a label, not a rewrite of this component.
 */
export function SongRecordDialog({
  recordId,
  tab,
  artists,
  labels,
  genres,
  manage,
  onTab,
  onClose,
  onSaved,
  onLoaded,
}: {
  recordId: string | null;
  tab: SongTab;
  artists: ReferenceSummary[];
  labels: ReferenceSummary[];
  genres: ReferenceSummary[];
  /** Whether the caller holds music.manage at this Station — a courtesy gate, never the boundary; update_song re-checks it itself. */
  manage: boolean;
  onTab: (tab: SongTab) => void;
  onClose: () => void;
  onSaved: (song: SongSummary) => void;
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
    if (dirty && !window.confirm('Discard the changes you have not saved?')) return;
    setDirty(false);
    onClose();
  }

  return (
    <Dialog open={recordId !== null} onClose={requestClose} labelledBy={titleId}>
      <DialogHeader>
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
              {TAB_LABELS[name]}
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
                  disabled
                />
              </div>
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
  onDirty,
  onSaved,
}: {
  song: SongSummary;
  artists: ReferenceSummary[];
  labels: ReferenceSummary[];
  genres: ReferenceSummary[];
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

      <SongFields song={song} artists={artists} labels={labels} genres={genres} />

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
