'use client';

import { useTranslations } from 'next-intl';
import { useActionState, useEffect, useId, useRef, useState } from 'react';
import { MoreVertical, Pencil } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuItem } from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
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
import { ARTIST_TABS, type ArtistTab } from '@/lib/record-params';
import type { ArtistSummary } from '@/services/music';
import { archiveArtistAction, createArtistAction, type ArchiveArtistState, type ArtistFormState } from './actions';
import { hasActiveArtistFilters, artistSortHref } from './list-params';
import type { ArtistListState } from './list-params';
import { ArtistRecordDialog } from './artist-record-dialog';

/** How many columns the empty-state row has to span, actions included. */
const COLUMN_COUNT = 4;

const INITIAL_ARCHIVE: ArchiveArtistState = { status: 'idle' };
const INITIAL_CREATE: ArtistFormState = { status: 'idle' };

export function ArtistsGrid({
  initialRows,
  initialTotal,
  state,
  previousHref,
  nextHref,
  manage,
  initialRecord,
}: {
  initialRows: ArtistSummary[];
  initialTotal: number;
  state: ArtistListState;
  previousHref: string | null;
  nextHref: string | null;
  /** Whether the caller holds music.manage at this Station — a courtesy gate; create_music_reference/update_music_reference/archive_music_reference each re-check it themselves. */
  manage: boolean;
  initialRecord: { recordId: string | null; tab: string | null };
}) {
  const t = useTranslations('music');
  const [grid, setGrid] = useState<RowState<ArtistSummary>>({
    rows: initialRows,
    total: initialTotal,
  });

  // A navigation hands down a new page: the one moment position and filter
  // membership are re-evaluated (src/lib/row-patch.ts).
  useEffect(() => {
    setGrid({ rows: initialRows, total: initialTotal });
  }, [initialRows, initialTotal]);

  const { recordId, tab, open, setTab, close } = useRecordDialog(ARTIST_TABS, initialRecord);
  const [archiving, setArchiving] = useState<ArtistSummary | null>(null);
  const [creating, setCreating] = useState(false);
  /** The artist whose record was opened because it had just been registered. */
  const pendingCreate = useRef<string | null>(null);

  const nameSorted = state.sort === 'name';
  const addedSorted = state.sort === 'created';
  const ariaSort = (sorted: boolean) =>
    sorted ? (state.direction === 'asc' ? 'ascending' : 'descending') : 'none';

  return (
    <>
      {manage && (
        <div className="mt-4 flex flex-wrap justify-end gap-2">
          <Button type="button" onClick={() => setCreating(true)} data-testid="artist-create">
            {t('registerArtist')}</Button>
        </div>
      )}

      <div className="mt-4 rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead aria-sort={ariaSort(nameSorted)}>
                <SortLink
                  href={artistSortHref(state, 'name')}
                  active={nameSorted}
                  direction={nameSorted ? state.direction : 'asc'}
                >
                  {t('name')}</SortLink>
              </TableHead>
              <TableHead>{t('legacyId')}</TableHead>
              <TableHead aria-sort={ariaSort(addedSorted)}>
                <SortLink
                  href={artistSortHref(state, 'created')}
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
                  {hasActiveArtistFilters(state)
                    ? t('noArtistMatchesTheseFilters')
                    : t('noArtistsAreRegisteredInThis')}
                </TableCell>
              </TableRow>
            ) : (
              grid.rows.map((artist) => (
                <TableRow key={artist.id} data-testid="artist-row">
                  <TableCell className="font-medium">
                    <button
                      type="button"
                      onClick={() => open(artist.id)}
                      className="text-left ring-offset-background hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                    >
                      {artist.name}
                    </button>
                  </TableCell>
                  <TableCell>{artist.legacyId ?? '—'}</TableCell>
                  <TableCell>{formatAddedDate(artist.createdAt)}</TableCell>
                  <TableCell className="sticky right-0 bg-background">
                    <div className="flex items-center justify-end gap-1">
                      <button
                        type="button"
                        aria-label={`Edit ${artist.name}`}
                        onClick={() => open(artist.id, 'data')}
                        className="rounded-md p-1.5 ring-offset-background hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                      >
                        <Pencil className="size-4" aria-hidden="true" />
                      </button>
                      {manage && (
                        <DropdownMenu
                          label={`Actions for ${artist.name}`}
                          trigger={<MoreVertical className="size-4" aria-hidden="true" />}
                        >
                          <DropdownMenuItem destructive onSelect={() => setArchiving(artist)}>
                            {t('archiveArtist')}</DropdownMenuItem>
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
          label={t('artistsLabel', { count: grid.total ?? 0 })}
          previousHref={previousHref}
          nextHref={nextHref}
        />
      </div>

      <ArtistRecordDialog
        recordId={recordId}
        tab={(tab as ArtistTab) ?? 'data'}
        manage={manage}
        stationSearch={state.stationSearch}
        onTab={setTab}
        onClose={close}
        onSaved={(artist) => setGrid((current) => applyRowPatch(current, { kind: 'save', row: artist }))}
        onLoaded={(artist) => {
          // An artist registered a moment ago: its record was opened on the
          // id the create returned, and the row comes from that read. One
          // read rather than two.
          if (pendingCreate.current !== artist.id) return;
          pendingCreate.current = null;
          setGrid((current) => applyRowPatch(current, { kind: 'create', row: artist }));
        }}
      />

      {archiving && (
        <ArchiveArtistDialog
          artist={archiving}
          onCancel={() => setArchiving(null)}
          onArchived={(id) => {
            setArchiving(null);
            setGrid((current) => applyRowPatch(current, { kind: 'remove', id }));
          }}
        />
      )}

      {manage && (
        <CreateArtistDialog
          open={creating}
          companyId={state.companyId}
          onClose={() => setCreating(false)}
          onCreated={(artistId) => {
            setCreating(false);
            pendingCreate.current = artistId;
            open(artistId);
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
 * archive_music_reference can refuse this one (unlike archive_song): a live
 * song still naming the artist answers 23503, surfaced here through
 * archiveArtistAction/describeMusicWriteError as an instruction rather than
 * a raw row count. The confirmation copy below still tells the operator
 * what a SUCCESSFUL archive means — unreadable through RLS for every caller,
 * the same sentence the song and prize records carry — since the refusal
 * path renders its own message in `state.message` instead.
 */
function ArchiveArtistDialog({
  artist,
  onCancel,
  onArchived,
}: {
  artist: ArtistSummary;
  onCancel: () => void;
  onArchived: (id: string) => void;
}) {
  const t = useTranslations('music');
  const titleId = useId();
  const [state, action, pending] = useActionState(archiveArtistAction, INITIAL_ARCHIVE);

  useEffect(() => {
    if (state.status === 'archived') onArchived(artist.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  return (
    <Dialog open onClose={onCancel} labelledBy={titleId} className="max-w-lg">
      <DialogHeader>
        <DialogTitle id={titleId}>{t('archiveThisArtist')}</DialogTitle>
      </DialogHeader>
      <DialogBody>
        <p className="text-sm">
          {artist.name} {t('leavesTheCatalogueAndEveryList')}{' '}
          <strong>{t('thisCannotBeUndoneHere')}</strong> — not by you, not by support. Only direct
          database access can restore it.
        </p>
        {state.status === 'error' && <p className="mt-3 text-sm text-destructive">{state.message}</p>}
      </DialogBody>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onCancel}>
          {t('cancel')}</Button>
        <form action={action}>
          <input type="hidden" name="artistId" value={artist.id} />
          <Button type="submit" disabled={pending} data-testid="artist-archive-confirm">
            {pending ? t('archiving') : t('archiveAnyway')}
          </Button>
        </form>
      </DialogFooter>
    </Dialog>
  );
}

function CreateArtistDialog({
  open,
  companyId,
  onClose,
  onCreated,
}: {
  open: boolean;
  companyId: string;
  onClose: () => void;
  onCreated: (artistId: string) => void;
}) {
  const t = useTranslations('music');
  const titleId = useId();
  return (
    <Dialog open={open} onClose={onClose} labelledBy={titleId}>
      <DialogHeader>
        <DialogTitle id={titleId}>{t('registerAnArtist')}</DialogTitle>
      </DialogHeader>
      <DialogBody>
        <ArtistCreateForm companyId={companyId} onCreated={onCreated} />
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
 * deliberate click, the same shape SongCreateForm (songs/songs-grid.tsx)
 * uses for its own create form: a dialog that closed itself the moment the
 * write landed would take its own "Artist registered." with it, and an
 * operator registering several artists in a row would lose the form between
 * each one.
 */
function ArtistCreateForm({
  companyId,
  onCreated,
}: {
  companyId: string;
  onCreated: (artistId: string) => void;
}) {
  const t = useTranslations('music');
  const [state, action, pending] = useActionState(createArtistAction, INITIAL_CREATE);

  return (
    <form action={action} data-testid="artist-create-form" className="flex flex-col gap-3">
      <input type="hidden" name="companyId" value={companyId} />

      <label className="flex flex-col gap-1 text-sm">
        <span className="text-muted-foreground">{t('name')}</span>
        <Input name="name" required maxLength={160} />
      </label>

      {/* legacy_id is settable only here: this is the create path, and
          create_music_reference still takes it (unlike update_music_reference
          — see the field's read-only counterpart in artist-record-dialog.tsx). */}
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-muted-foreground">{t('legacyId')}</span>
        <Input name="legacyId" maxLength={120} placeholder={t('optional')} />
      </label>

      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={pending}>
          {pending ? t('saving') : t('registerArtist')}
        </Button>
        {state.status === 'saved' && (
          <p className="text-sm text-emerald-700">
            {t('artistRegistered')}{' '}
            {state.artistId && (
              <button
                type="button"
                onClick={() => onCreated(state.artistId as string)}
                className="underline underline-offset-2"
              >
                {t('viewArtist')}</button>
            )}
          </p>
        )}
      </div>
      {state.status === 'error' && <p className="text-sm text-destructive">{state.message}</p>}
    </form>
  );
}
