'use client';

import { useTranslations } from 'next-intl';
import { useActionState, useEffect, useId, useRef, useState } from 'react';
import { MoreVertical, Pencil } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuItem } from '@/components/ui/dropdown-menu';
import {
  PageControls,
  SortLink,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { useRecordDialog } from '@/hooks/use-record-dialog';
import { applyRowPatch, type RowState } from '@/lib/row-patch';
import { SONG_TABS, type SongTab } from '@/lib/record-params';
import type { ReferenceSummary, SongSummary } from '@/services/music';
import { formatDuration } from '../format';
import { archiveSongAction, createSongAction, type ArchiveSongState, type SongFormState } from './actions';
import { hasActiveSongFilters, songSortHref } from './list-params';
import type { SongListState } from './list-params';
import { SongFields } from './song-fields';
import { SongRecordDialog } from './song-record-dialog';

/** How many columns the empty-state row has to span, actions included. */
const COLUMN_COUNT = 8;

const INITIAL_ARCHIVE: ArchiveSongState = { status: 'idle' };
const INITIAL_CREATE: SongFormState = { status: 'idle' };

export function SongsGrid({
  initialRows,
  initialTotal,
  state,
  previousHref,
  nextHref,
  artists,
  labels,
  genres,
  manage,
  initialRecord,
}: {
  initialRows: SongSummary[];
  initialTotal: number;
  state: SongListState;
  previousHref: string | null;
  nextHref: string | null;
  artists: ReferenceSummary[];
  labels: ReferenceSummary[];
  genres: ReferenceSummary[];
  /** Whether the caller holds music.manage at this Station — a courtesy gate; create_song/update_song/archive_song each re-check it themselves. */
  manage: boolean;
  initialRecord: { recordId: string | null; tab: string | null };
}) {
  const t = useTranslations('music');
  const [grid, setGrid] = useState<RowState<SongSummary>>({
    rows: initialRows,
    total: initialTotal,
  });

  // A navigation hands down a new page: the one moment position and filter
  // membership are re-evaluated (src/lib/row-patch.ts).
  useEffect(() => {
    setGrid({ rows: initialRows, total: initialTotal });
  }, [initialRows, initialTotal]);

  const { recordId, tab, open, setTab, close } = useRecordDialog(SONG_TABS, initialRecord);
  const [archiving, setArchiving] = useState<SongSummary | null>(null);
  const [creating, setCreating] = useState(false);
  /** The song whose record was opened because it had just been registered. */
  const pendingCreate = useRef<string | null>(null);

  const titleSorted = state.sort === 'title';
  const addedSorted = state.sort === 'created';
  const ariaSort = (sorted: boolean) =>
    sorted ? (state.direction === 'asc' ? 'ascending' : 'descending') : 'none';

  return (
    <>
      {manage && (
        <div className="mt-4 flex flex-wrap justify-end gap-2">
          <Button type="button" onClick={() => setCreating(true)} data-testid="song-create">
            {t('registerSong')}</Button>
        </div>
      )}

      <div className="mt-4 rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead aria-sort={ariaSort(titleSorted)}>
                <SortLink
                  href={songSortHref(state, 'title')}
                  active={titleSorted}
                  direction={titleSorted ? state.direction : 'asc'}
                >
                  {t('title')}</SortLink>
              </TableHead>
              <TableHead>{t('artist')}</TableHead>
              <TableHead>{t('label')}</TableHead>
              <TableHead>{t('genre')}</TableHead>
              <TableHead>{t('duration')}</TableHead>
              <TableHead>{t('code')}</TableHead>
              <TableHead aria-sort={ariaSort(addedSorted)}>
                <SortLink
                  href={songSortHref(state, 'created')}
                  active={addedSorted}
                  direction={addedSorted ? state.direction : 'desc'}
                >
                  {t('added')}</SortLink>
              </TableHead>
              <TableHead className="sticky right-0 bg-background text-right">{t('actions')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {grid.rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={COLUMN_COUNT} className="text-sm text-muted-foreground">
                  {hasActiveSongFilters(state)
                    ? t('noSongMatchesTheseFilters')
                    : t('noSongsAreRegisteredInThis')}
                </TableCell>
              </TableRow>
            ) : (
              grid.rows.map((song) => (
                <TableRow key={song.id} data-testid="song-row">
                  <TableCell className="font-medium">
                    <button
                      type="button"
                      onClick={() => open(song.id)}
                      className="text-left ring-offset-background hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                    >
                      {song.title}
                    </button>
                  </TableCell>
                  {/*
                    Not the '—' the next two cells use. A dash there means "no
                    label was set", a legitimate state; a song with no artist
                    is not a state this system has (artist_id is NOT NULL and
                    create_song refuses one), so a dash here would tell the
                    operator something false. Null means the artist exists and
                    RLS will not show it — it was archived — and saying
                    "Unavailable" is both true and actionable: the row is still
                    clickable, and the record's artist picker lists only live
                    artists, so choosing one and saving is the way out.
                  */}
                  <TableCell>
                    {song.artistName ?? (
                      <span className="text-muted-foreground">{t('unavailable')}</span>
                    )}
                  </TableCell>
                  <TableCell>{song.labelName ?? '—'}</TableCell>
                  <TableCell>{song.genreName ?? '—'}</TableCell>
                  <TableCell>{formatDuration(song.durationSeconds)}</TableCell>
                  <TableCell>{song.internalCode ?? '—'}</TableCell>
                  <TableCell>{formatAddedDate(song.createdAt)}</TableCell>
                  <TableCell className="sticky right-0 bg-background">
                    <div className="flex items-center justify-end gap-1">
                      <button
                        type="button"
                        aria-label={t('editSong', { title: song.title })}
                        onClick={() => open(song.id, 'data')}
                        className="rounded-md p-1.5 ring-offset-background hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                      >
                        <Pencil className="size-4" aria-hidden="true" />
                      </button>
                      {manage && (
                        <DropdownMenu
                          label={t('actionsForSong', { title: song.title })}
                          trigger={<MoreVertical className="size-4" aria-hidden="true" />}
                        >
                          <DropdownMenuItem destructive onSelect={() => setArchiving(song)}>
                            {t('archiveSong')}</DropdownMenuItem>
                        </DropdownMenu>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>

        <PageControls
          total={grid.total}
          label={t('songsLabel', { count: grid.total ?? 0 })}
          previousHref={previousHref}
          nextHref={nextHref}
        />
      </div>

      <SongRecordDialog
        recordId={recordId}
        tab={(tab as SongTab) ?? 'data'}
        artists={artists}
        labels={labels}
        genres={genres}
        manage={manage}
        onTab={setTab}
        onClose={close}
        onSaved={(song) => setGrid((current) => applyRowPatch(current, { kind: 'save', row: song }))}
        onLoaded={(song) => {
          // A song registered a moment ago: its record was opened on the id
          // the create returned, and the row comes from that read. One read
          // rather than two.
          if (pendingCreate.current !== song.id) return;
          pendingCreate.current = null;
          setGrid((current) => applyRowPatch(current, { kind: 'create', row: song }));
        }}
      />

      {archiving && (
        <ArchiveSongDialog
          song={archiving}
          onCancel={() => setArchiving(null)}
          onArchived={(id) => {
            setArchiving(null);
            setGrid((current) => applyRowPatch(current, { kind: 'remove', id }));
          }}
        />
      )}

      {manage && (
        <CreateSongDialog
          open={creating}
          companyId={state.companyId}
          artists={artists}
          labels={labels}
          genres={genres}
          onClose={() => setCreating(false)}
          onCreated={(songId) => {
            setCreating(false);
            pendingCreate.current = songId;
            open(songId);
          }}
        />
      )}
    </>
  );
}

/** The day alone, in the runtime's zone — the same disclosed gap inventory/format.ts's formatDate carries: both callers are Server Components downstream, so that runtime is the server rather than the viewer's browser. */
function formatAddedDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-GB', { dateStyle: 'medium' });
}

/**
 * The same sentence the prize record carries, true for the same reason:
 * songs_select (0099) carries `deleted_at is null`, so an archived song is
 * unreadable through RLS for every caller. Nothing in this app can list it or
 * restore it afterwards.
 */
function ArchiveSongDialog({
  song,
  onCancel,
  onArchived,
}: {
  song: SongSummary;
  onCancel: () => void;
  onArchived: (id: string) => void;
}) {
  const t = useTranslations('music');
  const titleId = useId();
  const [state, action, pending] = useActionState(archiveSongAction, INITIAL_ARCHIVE);

  useEffect(() => {
    if (state.status === 'archived') onArchived(song.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  return (
    <Dialog open onClose={onCancel} labelledBy={titleId} className="max-w-lg">
      <DialogHeader>
        <DialogTitle id={titleId}>{t('archiveThisSong')}</DialogTitle>
      </DialogHeader>
      <DialogBody>
        <p className="text-sm">
          {song.title} {t('leavesTheCatalogueAndEveryList')}{' '}
          <strong>{t('thisCannotBeUndoneHere')}</strong> — not by you, not by support. Only direct
          database access can restore it.
        </p>
        {state.status === 'error' && <p className="mt-3 text-sm text-destructive">{state.message}</p>}
      </DialogBody>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onCancel}>
          {t('cancel')}</Button>
        <form action={action}>
          <input type="hidden" name="songId" value={song.id} />
          <Button type="submit" disabled={pending} data-testid="song-archive-confirm">
            {pending ? t('archiving') : t('archiveAnyway')}
          </Button>
        </form>
      </DialogFooter>
    </Dialog>
  );
}

function CreateSongDialog({
  open,
  companyId,
  artists,
  labels,
  genres,
  onClose,
  onCreated,
}: {
  open: boolean;
  companyId: string;
  artists: ReferenceSummary[];
  labels: ReferenceSummary[];
  genres: ReferenceSummary[];
  onClose: () => void;
  onCreated: (songId: string) => void;
}) {
  const t = useTranslations('music');
  const titleId = useId();
  return (
    <Dialog open={open} onClose={onClose} labelledBy={titleId}>
      <DialogHeader>
        <DialogTitle id={titleId}>{t('registerASong')}</DialogTitle>
      </DialogHeader>
      <DialogBody>
        <SongCreateForm
          companyId={companyId}
          artists={artists}
          labels={labels}
          genres={genres}
          onCreated={onCreated}
        />
      </DialogBody>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose}>
          {t('close')}</Button>
      </DialogFooter>
    </Dialog>
  );
}

/**
 * The confirmation stays on screen and opening the new record is a
 * deliberate click, the same shape inventory/prize-form.tsx uses for its own
 * create form: a dialog that closed itself the moment the write landed would
 * take its own "Song registered." with it, and an operator registering
 * several songs in a row would lose the form between each one.
 */
function SongCreateForm({
  companyId,
  artists,
  labels,
  genres,
  onCreated,
}: {
  companyId: string;
  artists: ReferenceSummary[];
  labels: ReferenceSummary[];
  genres: ReferenceSummary[];
  onCreated: (songId: string) => void;
}) {
  const t = useTranslations('music');
  const [state, action, pending] = useActionState(createSongAction, INITIAL_CREATE);

  return (
    <form action={action} data-testid="song-create-form" className="flex flex-col gap-3">
      <input type="hidden" name="companyId" value={companyId} />
      <SongFields artists={artists} labels={labels} genres={genres} />
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={pending}>
          {pending ? t('saving') : t('registerSong')}
        </Button>
        {state.status === 'saved' && (
          <p className="text-sm text-emerald-700">
            {t('songRegistered')}{' '}
            {state.songId && (
              <button
                type="button"
                onClick={() => onCreated(state.songId as string)}
                className="underline underline-offset-2"
              >
                {t('viewSong')}</button>
            )}
          </p>
        )}
      </div>
      {state.status === 'error' && <p className="text-sm text-destructive">{state.message}</p>}
    </form>
  );
}
