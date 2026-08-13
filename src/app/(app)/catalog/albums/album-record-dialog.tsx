'use client';

import { useTranslations } from 'next-intl';
import { useActionState, useEffect, useId, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { ARTWORK_ACCEPT } from '@/lib/security/artwork';
import type { AlbumSummary } from '@/services/music';
import { AlbumThumb } from './album-thumb';
import {
  clearAlbumCoverAction,
  updateAlbumAction,
  uploadAlbumCoverAction,
  type AlbumCoverClearState,
  type AlbumCoverState,
  type AlbumSaveState,
} from './actions';
import { getAlbumRecordAction, type AlbumRecord } from './record';

const INITIAL_SAVE: AlbumSaveState = { status: 'idle' };
const INITIAL_UPLOAD: AlbumCoverState = { status: 'idle' };
const INITIAL_CLEAR: AlbumCoverClearState = { status: 'idle' };

/**
 * One album's whole record over the Albums list. Same shape as the artist
 * record (music/artists/artist-record-dialog.tsx): one read per opening,
 * rendered from it, so nothing here can re-run the list query behind the
 * dialog.
 *
 * ONE TAB (ALBUM_TABS, src/lib/record-params.ts), unlike the artist record's
 * two — no tab strip is rendered at all, the same choice
 * shows/show-record-dialog.tsx makes for SHOW_TABS's own single entry. An
 * album's record is its fields and its picture, not a second section: the
 * songs naming it are reached from the Songs screen, not from here.
 */
export function AlbumRecordDialog({
  recordId,
  manage,
  onClose,
  onSaved,
  onLoaded,
}: {
  recordId: string | null;
  /** Whether the caller holds music.manage at this Station — a courtesy gate, never the boundary; update_album and set_album_cover each re-check it themselves. */
  manage: boolean;
  onClose: () => void;
  onSaved: (album: AlbumSummary) => void;
  /** Every successful read of a record, which is how an album registered a moment ago gets its row: the grid opens the new record and takes the row from this read rather than a second one of its own. */
  onLoaded?: (album: AlbumSummary) => void;
}) {
  const t = useTranslations('music');
  const titleId = useId();
  const [record, setRecord] = useState<AlbumRecord | null>(null);
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
    void getAlbumRecordAction(recordId).then((result) => {
      if (!current) return;
      setLoading(false);
      if (result.status === 'ok') {
        setRecord(result.record);
        onLoaded?.(result.record.album);
        return;
      }
      setRecord(null);
      setFailure(result.status === 'not-found' ? t('noSuchAlbumOrYouDo') : result.message);
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

  /** Merges a change into the local record AND tells the grid — the one path both the data form and the picture control patch through. */
  function patch(album: AlbumSummary) {
    setRecord((current) => (current ? { ...current, album } : current));
    onSaved(album);
  }

  return (
    <Dialog open={recordId !== null} onClose={requestClose} labelledBy={titleId} className="max-w-lg">
      <DialogHeader>
        <DialogTitle id={titleId}>
          {record?.album.title ?? (loading ? t('loading') : t('album'))}
        </DialogTitle>
        <button
          type="button"
          onClick={requestClose}
          aria-label={t('closeRecord')}
          className="rounded-md p-1.5 ring-offset-background hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        >
          <X className="size-4" aria-hidden="true" />
        </button>
      </DialogHeader>

      <DialogBody>
        {loading && <p className="text-sm text-muted-foreground">{t('loadingTheRecord')}</p>}

        {failure && (
          <div className="flex flex-col items-start gap-3">
            <p className="text-sm text-destructive">{failure}</p>
            <Button type="button" variant="outline" onClick={() => setReloadToken((n) => n + 1)}>
              {t('tryAgain')}
            </Button>
          </div>
        )}

        {record && (
          <div className="flex flex-col gap-4">
            <AlbumCoverControl
              companyId={record.companyId}
              albumId={record.album.id}
              thumbUrl={record.album.thumbUrl}
              coverMd5={record.album.coverMd5}
              manage={manage}
              onChanged={(thumbUrl) => patch({ ...record.album, thumbUrl })}
            />

            {manage ? (
              <AlbumDataForm
                album={record.album}
                onDirty={setDirty}
                onSaved={(saved) => {
                  setDirty(false);
                  patch(saved);
                }}
              />
            ) : (
              <div className="flex flex-col gap-4">
                <p className="text-sm text-muted-foreground">
                  {t('youDoNotHoldMusicManageForThisRecord')}
                </p>
                <AlbumReadOnlyFields album={record.album} />
              </div>
            )}
          </div>
        )}
      </DialogBody>

      <DialogFooter>
        <Button type="button" variant="outline" onClick={requestClose}>
          {t('close')}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

/**
 * The picture, D4: `thumbUrl` if the operator uploaded one, otherwise
 * `coverMd5` (Deezer's), otherwise nothing — AlbumThumb's own job. Upload and
 * remove are their own actions rather than fields on AlbumDataForm's Save,
 * because set_album_cover (0187) is its own writer for the same reason
 * update_album carries no thumb_url parameter — a wholesale field replacer
 * would delete a cover the moment a title got saved.
 *
 * The upload form submits itself the instant a file is chosen, the same
 * `requestSubmit()` shape song-record-dialog.tsx's Deezer-link form uses for
 * an equivalent "this input's own change IS the write" control — there is no
 * separate button, so nothing else can drive it.
 */
function AlbumCoverControl({
  companyId,
  albumId,
  thumbUrl,
  coverMd5,
  manage,
  onChanged,
}: {
  companyId: string;
  albumId: string;
  thumbUrl: string | null;
  coverMd5: string | null;
  manage: boolean;
  onChanged: (thumbUrl: string | null) => void;
}) {
  const t = useTranslations('music');
  const uploadFormRef = useRef<HTMLFormElement>(null);
  const [uploadState, uploadAction, uploading] = useActionState(uploadAlbumCoverAction, INITIAL_UPLOAD);
  const [clearState, clearAction, clearing] = useActionState(clearAlbumCoverAction, INITIAL_CLEAR);

  useEffect(() => {
    if (uploadState.status === 'saved') onChanged(uploadState.thumbUrl ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uploadState]);

  useEffect(() => {
    if (clearState.status === 'cleared') onChanged(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clearState]);

  return (
    <div className="flex items-center gap-4" data-testid="album-cover">
      <AlbumThumb thumbUrl={thumbUrl} coverMd5={coverMd5} size="lg" />

      {manage && (
        <div className="flex flex-col items-start gap-2">
          <form ref={uploadFormRef} action={uploadAction}>
            <input type="hidden" name="companyId" value={companyId} />
            <input type="hidden" name="albumId" value={albumId} />
            <input
              type="file"
              name="file"
              accept={ARTWORK_ACCEPT}
              disabled={uploading}
              onChange={(e) => {
                if (e.target.files?.[0]) uploadFormRef.current?.requestSubmit();
              }}
              className="text-sm"
              data-testid="album-cover-input"
            />
          </form>

          {thumbUrl && (
            <form action={clearAction}>
              <input type="hidden" name="albumId" value={albumId} />
              <Button type="submit" variant="outline" size="sm" disabled={clearing} data-testid="album-cover-remove">
                {clearing ? t('saving') : t('removeCover')}
              </Button>
            </form>
          )}

          {!thumbUrl && coverMd5 && (
            <span className="text-xs text-muted-foreground">{t('poweredByDeezer')}</span>
          )}

          {uploading && <span className="text-xs text-muted-foreground">{t('saving')}</span>}
          {uploadState.status === 'error' && (
            <span className="text-sm text-destructive" data-testid="album-cover-problem">
              {uploadState.message}
            </span>
          )}
          {clearState.status === 'error' && (
            <span className="text-sm text-destructive">{clearState.message}</span>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Every field on every save: update_album (0187) sets title, UPC and release
 * date on every call, so a partial submission would blank what it leaves out
 * — the same warning ArtistDataForm (music/artists/artist-record-dialog.tsx)
 * carries for its own single field.
 *
 * `deezer_album_id` and `cover_md5` are D6: facts about a third party's
 * catalogue, written by the Deezer registration path alone. There is no
 * field for either here — the boundary is update_album itself, which takes
 * no parameter for them, and this form simply has nothing to send.
 */
function AlbumDataForm({
  album,
  onDirty,
  onSaved,
}: {
  album: AlbumSummary;
  onDirty: (dirty: boolean) => void;
  onSaved: (album: AlbumSummary) => void;
}) {
  const t = useTranslations('music');
  const [state, action, pending] = useActionState(updateAlbumAction, INITIAL_SAVE);

  useEffect(() => {
    if (state.status === 'saved' && state.album) onSaved(state.album);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  return (
    <form
      action={action}
      onChange={() => onDirty(true)}
      data-testid="album-data-form"
      className="flex flex-col gap-3"
    >
      <input type="hidden" name="albumId" value={album.id} />

      {/* Keyed on the canonical value itself, the same trick
          reference-record-dialog.tsx's ReferenceDataForm uses for its own
          name field: these only change once the CANONICAL value changes,
          i.e. after a successful save has come back through the fresh
          `album` prop (AlbumRecordDialog's `patch` sets it from the RPC's own
          return) — forcing the uncontrolled input to remount and pick up the
          new defaultValue. Without the key, a save that update_album
          canonicalises (a trimmed title, a whitespace-only UPC stored as
          NULL) would leave this input showing what was typed while the grid
          shows what was stored. A failed save leaves `album` untouched, so
          the key does not change and the operator's just-typed, unsaved text
          stays on screen next to the error explaining why it was not saved. */}
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-muted-foreground">{t('title')}</span>
        <Input
          key={album.title}
          name="title"
          defaultValue={album.title}
          required
          maxLength={160}
          data-testid="album-title"
        />
      </label>

      <label className="flex flex-col gap-1 text-sm">
        <span className="text-muted-foreground">{t('upc')}</span>
        <Input
          key={album.upc ?? ''}
          name="upc"
          defaultValue={album.upc ?? ''}
          maxLength={14}
          placeholder={t('optional')}
          data-testid="album-upc"
        />
      </label>

      <label className="flex flex-col gap-1 text-sm">
        <span className="text-muted-foreground">{t('releaseDate')}</span>
        <Input
          key={album.releaseDate ?? ''}
          type="date"
          name="releaseDate"
          defaultValue={album.releaseDate ?? ''}
          data-testid="album-release-date"
        />
      </label>

      <div className="flex items-center gap-3">
        <Button type="submit" disabled={pending} data-testid="album-save">
          {pending ? t('saving') : t('save')}
        </Button>
        {state.status === 'error' && <span className="text-sm text-destructive">{state.message}</span>}
        {state.status === 'saved' && <span className="text-sm text-muted-foreground">{t('saved')}</span>}
      </div>
    </form>
  );
}

function AlbumReadOnlyFields({ album }: { album: AlbumSummary }) {
  const t = useTranslations('music');
  return (
    <>
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-muted-foreground">{t('title')}</span>
        <Input value={album.title} disabled readOnly />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-muted-foreground">{t('upc')}</span>
        <Input value={album.upc ?? ''} disabled readOnly placeholder={t('optional')} />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-muted-foreground">{t('releaseDate')}</span>
        <Input type="date" value={album.releaseDate ?? ''} disabled readOnly />
      </label>
    </>
  );
}
