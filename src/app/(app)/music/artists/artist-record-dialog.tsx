'use client';

import { useActionState, useEffect, useId, useState } from 'react';
import Link from 'next/link';
import type { Route } from 'next';
import { X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import type { ArtistSummary } from '@/services/music';
// The tab tuple is declared with parseRecordParam rather than here, because the
// grid that opens this dialog reads it too and a Server Component elsewhere
// cannot import a value out of a client module. See src/lib/record-params.ts.
import { ARTIST_TABS, type ArtistTab } from '@/lib/record-params';
import { updateArtistAction, type ArtistSaveState } from './actions';
import { getArtistRecordAction, type ArtistRecord } from './record';

const TAB_LABELS: Record<ArtistTab, string> = { data: 'Artist data', songs: 'Songs' };

const INITIAL_SAVE: ArtistSaveState = { status: 'idle' };

/**
 * One artist's whole record over the Artists list. Same shape as the song
 * record (songs/song-record-dialog.tsx): one read per opening, rendered from
 * it, so nothing here can re-run the list query behind the dialog.
 *
 * Two tabs, unlike the song record's one: `data` is the name and the legacy
 * handle, `songs` is what getArtistRecordAction (record.ts) already fetched
 * alongside the artist in that SAME read. Switching `tab` below is local
 * React state — it never calls getArtistRecordAction again, so it can never
 * reach the server, let alone re-run the songs list behind this dialog.
 */
export function ArtistRecordDialog({
  recordId,
  tab,
  manage,
  onTab,
  onClose,
  onSaved,
  onLoaded,
}: {
  recordId: string | null;
  tab: ArtistTab;
  /** Whether the caller holds music.manage at this Station — a courtesy gate, never the boundary; update_music_reference re-checks it itself. */
  manage: boolean;
  onTab: (tab: ArtistTab) => void;
  onClose: () => void;
  onSaved: (artist: ArtistSummary) => void;
  /** Every successful read of a record, which is how an artist registered a moment ago gets its row: the grid opens the new record and takes the row from this read rather than a second one of its own. */
  onLoaded?: (artist: ArtistSummary) => void;
}) {
  const titleId = useId();
  const [record, setRecord] = useState<ArtistRecord | null>(null);
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
    void getArtistRecordAction(recordId).then((result) => {
      if (!current) return;
      setLoading(false);
      if (result.status === 'ok') {
        setRecord(result.record);
        onLoaded?.(result.record.artist);
        return;
      }
      setRecord(null);
      setFailure(
        result.status === 'not-found'
          ? 'No such artist, or you do not have permission to see this one.'
          : result.message,
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
        <DialogTitle id={titleId}>
          {record?.artist.name ?? (loading ? 'Loading…' : 'Artist')}
        </DialogTitle>
        <button
          type="button"
          onClick={requestClose}
          aria-label="Close record"
          className="rounded-md p-1.5 ring-offset-background hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        >
          <X className="size-4" aria-hidden="true" />
        </button>
      </DialogHeader>

      {record && (
        <div role="tablist" aria-label="Record sections" className="flex gap-1 border-b px-5">
          {ARTIST_TABS.map((name) => (
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
        {loading && <p className="text-sm text-muted-foreground">Loading the record…</p>}

        {failure && (
          <div className="flex flex-col items-start gap-3">
            <p className="text-sm text-destructive">{failure}</p>
            <Button type="button" variant="outline" onClick={() => setReloadToken((n) => n + 1)}>
              Try again
            </Button>
          </div>
        )}

        {record && tab === 'data' && (
          <>
            {manage ? (
              <ArtistDataForm
                artist={record.artist}
                onDirty={setDirty}
                onSaved={(saved) => {
                  setDirty(false);
                  setRecord({ ...record, artist: saved });
                  onSaved(saved);
                }}
              />
            ) : (
              <div className="flex flex-col gap-4">
                <p className="text-sm text-muted-foreground">
                  You do not hold music.manage at this Station, so this artist can be read here but
                  not edited.
                </p>
                <ArtistReadOnlyFields artist={record.artist} />
              </div>
            )}
          </>
        )}

        {record && tab === 'songs' && <ArtistSongsTab record={record} />}
      </DialogBody>

      <DialogFooter>
        <Button type="button" variant="outline" onClick={requestClose}>
          Close
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

/**
 * Every field on every save: update_music_reference (0102) sets name on
 * every call, so a partial submission would blank what it leaves out if this
 * form ever grew a second field it did not submit — the same warning
 * song-record-dialog.tsx's SongDataForm carries.
 */
function ArtistDataForm({
  artist,
  onDirty,
  onSaved,
}: {
  artist: ArtistSummary;
  onDirty: (dirty: boolean) => void;
  onSaved: (artist: ArtistSummary) => void;
}) {
  const [state, action, pending] = useActionState(updateArtistAction, INITIAL_SAVE);

  useEffect(() => {
    if (state.status === 'saved' && state.artist) onSaved(state.artist);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  return (
    <form
      action={action}
      onChange={() => onDirty(true)}
      data-testid="artist-data-form"
      className="flex flex-col gap-3"
    >
      <input type="hidden" name="artistId" value={artist.id} />

      <label className="flex flex-col gap-1 text-sm">
        <span className="text-muted-foreground">Name</span>
        <Input name="name" defaultValue={artist.name} required maxLength={160} />
      </label>

      {/*
        legacy_id is Block 9's ETL idempotency handle (design spec D7), not an
        operator's field — a hand-edited value would let a second import run
        fail to recognise this row and duplicate it. Read-only, the same
        reasoning song-fields.tsx's own comment gives at length for the
        identical field on a song.

        No `name` attribute, deliberately: this field must never reach the
        edit form's FormData at all, on this side or a hand-crafted one.
        referenceUpdateSchema (schemas/music.ts) no longer has a `legacyId`
        field to parse one into either way, and update_music_reference (0102)
        no longer takes a matching RPC parameter — the fix closed at the
        database layer, this field staying un-named is defence in depth on
        top of that, not the boundary itself.
      */}
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-muted-foreground">Legacy id</span>
        <Input
          value={artist.legacyId ?? ''}
          disabled
          readOnly
          placeholder="Not linked to an import"
          data-testid="artist-legacy-id"
        />
        <span className="text-xs text-muted-foreground">
          Set by the catalogue import; not editable here.
        </span>
      </label>

      <div className="flex items-center gap-3">
        <Button type="submit" disabled={pending}>
          {pending ? 'Saving…' : 'Save'}
        </Button>
        {state.status === 'error' && <span className="text-sm text-destructive">{state.message}</span>}
        {state.status === 'saved' && <span className="text-sm text-muted-foreground">Saved.</span>}
      </div>
    </form>
  );
}

function ArtistReadOnlyFields({ artist }: { artist: ArtistSummary }) {
  return (
    <>
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-muted-foreground">Name</span>
        <Input value={artist.name} disabled readOnly />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-muted-foreground">Legacy id</span>
        <Input value={artist.legacyId ?? ''} disabled readOnly placeholder="Not linked to an import" />
      </label>
    </>
  );
}

/**
 * Renders from the single read record.ts took when the record opened —
 * getArtistSongs ran there, inside getArtistRecordAction, alongside
 * getArtistById, never here. Opening this tab is a local `tab` state change
 * (useRecordDialog, via onTab) and nothing about it calls the server, so it
 * cannot re-run that read, let alone the Artists list's own keyset query
 * behind this dialog.
 *
 * Each row links to the Songs screen carrying both the Station (companyId)
 * and the song's own id — `/music/songs?companyId=…&artist=<id>&record=<id>`
 * — which is how an operator gets from an artist to one of their songs
 * without losing the Station.
 */
function ArtistSongsTab({ record }: { record: ArtistRecord }) {
  return (
    <div className="flex flex-col gap-3">
      {record.songs.length === 0 ? (
        <p className="text-sm text-muted-foreground">No songs are registered under this artist.</p>
      ) : (
        <ul className="flex flex-col divide-y" data-testid="artist-songs-list">
          {record.songs.map((song) => (
            <li key={song.id} className="py-2">
              <Link
                href={
                  `/music/songs?companyId=${record.companyId}&artist=${record.artist.id}&record=${song.id}` as Route
                }
                className="text-sm text-primary underline-offset-2 hover:underline"
                data-testid="artist-song-link"
              >
                {song.title}
              </Link>
            </li>
          ))}
        </ul>
      )}
      {record.songsCapped && (
        <p className="text-xs text-muted-foreground">
          Showing the first 200 songs.{' '}
          <Link
            href={`/music/songs?companyId=${record.companyId}&artist=${record.artist.id}` as Route}
            className="text-primary underline underline-offset-2"
          >
            See the rest in Songs
          </Link>
          .
        </p>
      )}
    </div>
  );
}
