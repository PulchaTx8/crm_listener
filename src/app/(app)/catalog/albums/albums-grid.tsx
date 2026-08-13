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
import { ALBUM_TABS } from '@/lib/record-params';
import type { AlbumSummary } from '@/services/music';
import { archiveAlbumAction, createAlbumAction, type ArchiveAlbumState, type AlbumFormState } from './actions';
import { albumSortHref, hasActiveAlbumFilters } from './list-params';
import type { AlbumListState } from './list-params';
import { AlbumRecordDialog } from './album-record-dialog';
import { AlbumThumb } from './album-thumb';

/** Five columns against music/artists/artists-grid.tsx's four: cover, title, release date, UPC, actions — an album carries a picture the way no reference or artist row does. */
const COLUMN_COUNT = 5;

const INITIAL_ARCHIVE: ArchiveAlbumState = { status: 'idle' };
const INITIAL_CREATE: AlbumFormState = { status: 'idle' };

export function AlbumsGrid({
  initialRows,
  initialTotal,
  state,
  previousHref,
  nextHref,
  manage,
  initialRecord,
}: {
  initialRows: AlbumSummary[];
  initialTotal: number;
  state: AlbumListState;
  previousHref: string | null;
  nextHref: string | null;
  /** Whether the caller holds music.manage at this Station — a courtesy gate; create_album/update_album/archive_album/set_album_cover each re-check it themselves. */
  manage: boolean;
  initialRecord: { recordId: string | null; tab: string | null };
}) {
  const t = useTranslations('music');
  const [grid, setGrid] = useState<RowState<AlbumSummary>>({
    rows: initialRows,
    total: initialTotal,
  });

  // A navigation hands down a new page: the one moment position and filter
  // membership are re-evaluated (src/lib/row-patch.ts).
  useEffect(() => {
    setGrid({ rows: initialRows, total: initialTotal });
  }, [initialRows, initialTotal]);

  // ALBUM_TABS has one entry, so `tab`/`setTab` are never destructured here —
  // the same choice shows/shows-grid.tsx makes for SHOW_TABS's own single tab.
  const { recordId, open, close } = useRecordDialog(ALBUM_TABS, initialRecord);
  const [archiving, setArchiving] = useState<AlbumSummary | null>(null);
  const [creating, setCreating] = useState(false);
  /** The album whose record was opened because it had just been registered. */
  const pendingCreate = useRef<string | null>(null);

  const titleSorted = state.direction === 'asc' ? 'ascending' : 'descending';

  return (
    <>
      {manage && (
        <div className="mt-4 flex flex-wrap justify-end gap-2">
          <Button type="button" onClick={() => setCreating(true)} data-testid="album-create">
            {t('registerAlbum')}
          </Button>
        </div>
      )}

      <div className="mt-4 rounded-lg border" data-testid="albums-grid">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('cover')}</TableHead>
              <TableHead aria-sort={titleSorted}>
                <SortLink href={albumSortHref(state)} active direction={state.direction}>
                  {t('title')}
                </SortLink>
              </TableHead>
              <TableHead>{t('releaseDate')}</TableHead>
              <TableHead>{t('upc')}</TableHead>
              <TableHead className="sticky right-0 bg-background text-right">{t('actions')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {grid.rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={COLUMN_COUNT} className="text-sm text-muted-foreground">
                  {hasActiveAlbumFilters(state)
                    ? t('noAlbumMatchesTheseFilters')
                    : t('noAlbumsAreRegisteredInThis')}
                </TableCell>
              </TableRow>
            ) : (
              grid.rows.map((album) => (
                <TableRow key={album.id} data-testid="album-row">
                  <TableCell>
                    <AlbumThumb thumbUrl={album.thumbUrl} coverMd5={album.coverMd5} />
                  </TableCell>
                  <TableCell className="font-medium">
                    <button
                      type="button"
                      onClick={() => open(album.id)}
                      className="text-left ring-offset-background hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                    >
                      {album.title}
                    </button>
                  </TableCell>
                  {/* The raw yyyy-mm-dd string, not new Date(...).toLocaleDateString():
                      release_date is a `date` column with no time component, and
                      parsing it as a Date reads it as UTC midnight before rendering
                      it back in the runtime's own zone — a west-of-UTC reader sees
                      the DAY BEFORE what was stored. Displaying the stored string
                      untouched is exactly what a date-only column calls for. */}
                  <TableCell>{album.releaseDate ?? '—'}</TableCell>
                  <TableCell>{album.upc ?? '—'}</TableCell>
                  <TableCell className="sticky right-0 bg-background">
                    <div className="flex items-center justify-end gap-1">
                      <button
                        type="button"
                        aria-label={t('editAlbum', { name: album.title })}
                        onClick={() => open(album.id)}
                        className="rounded-md p-1.5 ring-offset-background hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                      >
                        <Pencil className="size-4" aria-hidden="true" />
                      </button>
                      {manage && (
                        <DropdownMenu
                          label={t('actionsForAlbum', { name: album.title })}
                          trigger={<MoreVertical className="size-4" aria-hidden="true" />}
                        >
                          <DropdownMenuItem destructive onSelect={() => setArchiving(album)}>
                            {t('archiveAlbum')}
                          </DropdownMenuItem>
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
          label={t('albumsLabel', { count: grid.total ?? 0 })}
          previousHref={previousHref}
          nextHref={nextHref}
        />
      </div>

      <AlbumRecordDialog
        recordId={recordId}
        manage={manage}
        onClose={close}
        onSaved={(album) => setGrid((current) => applyRowPatch(current, { kind: 'save', row: album }))}
        onLoaded={(album) => {
          // An album registered a moment ago: its record was opened on the id
          // the create returned, and the row comes from that read. One read
          // rather than two.
          if (pendingCreate.current !== album.id) return;
          pendingCreate.current = null;
          setGrid((current) => applyRowPatch(current, { kind: 'create', row: album }));
        }}
      />

      {archiving && (
        <ArchiveAlbumDialog
          album={archiving}
          onCancel={() => setArchiving(null)}
          onArchived={(id) => {
            setArchiving(null);
            setGrid((current) => applyRowPatch(current, { kind: 'remove', id }));
          }}
        />
      )}

      {manage && (
        <CreateAlbumDialog
          open={creating}
          companyId={state.companyId}
          onClose={() => setCreating(false)}
          onCreated={(albumId) => {
            setCreating(false);
            pendingCreate.current = albumId;
            open(albumId);
          }}
        />
      )}
    </>
  );
}

/**
 * archive_album never refuses (unlike archive_music_reference): a live song
 * keeps pointing at an archived album (0137's own comment on the RPC), so
 * this confirmation carries no BusinessRuleError branch the way
 * ArchiveArtistDialog's does.
 */
function ArchiveAlbumDialog({
  album,
  onCancel,
  onArchived,
}: {
  album: AlbumSummary;
  onCancel: () => void;
  onArchived: (id: string) => void;
}) {
  const t = useTranslations('music');
  const titleId = useId();
  const [state, action, pending] = useActionState(archiveAlbumAction, INITIAL_ARCHIVE);

  useEffect(() => {
    if (state.status === 'archived') onArchived(album.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  return (
    <Dialog open onClose={onCancel} labelledBy={titleId} className="max-w-lg">
      <DialogHeader>
        <DialogTitle id={titleId}>{t('archiveThisAlbumQuestion')}</DialogTitle>
      </DialogHeader>
      <DialogBody>
        <p className="text-sm">
          <strong>{album.title}</strong> {t('stopsBeingSelectableForANew')}{' '}
          <strong>{t('thisCannotBeUndoneHere')}</strong> {t('notByYouNotBySupport')}
        </p>
        {state.status === 'error' && <p className="mt-3 text-sm text-destructive">{state.message}</p>}
      </DialogBody>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onCancel}>
          {t('cancel')}
        </Button>
        <form action={action}>
          <input type="hidden" name="albumId" value={album.id} />
          <Button type="submit" disabled={pending} data-testid="album-archive-confirm">
            {pending ? t('archiving') : t('archiveAnyway')}
          </Button>
        </form>
      </DialogFooter>
    </Dialog>
  );
}

function CreateAlbumDialog({
  open,
  companyId,
  onClose,
  onCreated,
}: {
  open: boolean;
  companyId: string;
  onClose: () => void;
  onCreated: (albumId: string) => void;
}) {
  const t = useTranslations('music');
  const titleId = useId();
  return (
    <Dialog open={open} onClose={onClose} labelledBy={titleId}>
      <DialogHeader>
        <DialogTitle id={titleId}>{t('registerAnAlbum')}</DialogTitle>
      </DialogHeader>
      <DialogBody>
        <AlbumCreateForm companyId={companyId} onCreated={onCreated} />
      </DialogBody>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose}>
          {t('close')}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

/**
 * Title, UPC and release date together — unlike ArtistCreateForm's name-only
 * form, because create_album (0137) already takes all three as its own
 * optional parameters (createAlbum, services/music.ts), and D4's picture
 * control needs an existing album id, which this form does not have yet
 * either way. Closes itself the instant the write lands and opens the new
 * record, the same shape ReferenceCreateForm (catalog/references/
 * references-grid.tsx) uses for its own single-field form — there is nothing
 * left for a "registered — view it" confirmation to add here, and the record
 * it opens is where the picture gets attached.
 */
function AlbumCreateForm({
  companyId,
  onCreated,
}: {
  companyId: string;
  onCreated: (albumId: string) => void;
}) {
  const t = useTranslations('music');
  const [state, action, pending] = useActionState(createAlbumAction, INITIAL_CREATE);

  useEffect(() => {
    if (state.status === 'saved' && state.albumId) onCreated(state.albumId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  return (
    <form action={action} data-testid="album-create-form" className="flex flex-col gap-3">
      <input type="hidden" name="companyId" value={companyId} />

      <label className="flex flex-col gap-1 text-sm">
        <span className="text-muted-foreground">{t('title')}</span>
        <Input name="title" required maxLength={160} data-testid="album-title" />
      </label>

      <label className="flex flex-col gap-1 text-sm">
        <span className="text-muted-foreground">{t('upc')}</span>
        <Input name="upc" maxLength={14} placeholder={t('optional')} data-testid="album-upc" />
      </label>

      <label className="flex flex-col gap-1 text-sm">
        <span className="text-muted-foreground">{t('releaseDate')}</span>
        <Input type="date" name="releaseDate" data-testid="album-release-date" />
      </label>

      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={pending} data-testid="album-save">
          {pending ? t('saving') : t('registerAlbum')}
        </Button>
      </div>
      {state.status === 'error' && <p className="text-sm text-destructive">{state.message}</p>}
    </form>
  );
}
