'use client';

import { useTranslations } from 'next-intl';
import { useActionState, useEffect, useId, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
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
import type { ReferenceSummary } from '@/services/music';
import { createReferenceAction, type ReferenceFormState } from './actions';
import { hasActiveReferenceFilters, referenceSortHref } from './list-params';
import type { ReferenceListState, ReferenceScreenCopy, ReferenceScreenKind } from './list-params';
import { ReferenceRecordDialog } from './reference-record-dialog';

/** Two columns against music/artists/artists-grid.tsx's four: name and legacy id, and nothing else — 0100 gives neither table a `created_at` a screen would show, and there is no Actions column because every row action (save, archive) lives inside the dialog a click on the name opens, not beside the row. */
const COLUMN_COUNT = 2;

const INITIAL_CREATE: ReferenceFormState = { status: 'idle' };

/**
 * The Cadastrar button and its popup live HERE, not in reference-screen.tsx,
 * even though that file renders everything else on screen: reference-screen.tsx
 * is a Server Component (its own header explains why — it composes the async
 * StationSearchForm), and a create button needs `useState` for whether its
 * dialog is open. Keeping the trigger beside the state it opens is also the
 * shape music/artists/artists-grid.tsx already uses for "Register artist" and
 * CreateArtistDialog — this table is that one file's shape, not two of them.
 *
 * Props otherwise render directly, never copied into local state the way
 * ArtistsGrid mirrors `initialRows`/`initialTotal` into a `grid` useState.
 * That copy exists there to survive revalidatePath NOT being called
 * (row-patch.ts patches instead); here revalidatePath IS the update
 * mechanism (actions.ts's own header explains why it is safe on this screen),
 * so every write already arrives as a fresh `rows`/`total` prop and a second
 * copy would only be one more place for the two to disagree.
 */
export function ReferencesGrid({
  kind,
  rows,
  total,
  state,
  previousHref,
  nextHref,
  manage,
  copy,
}: {
  kind: ReferenceScreenKind;
  rows: ReferenceSummary[];
  total: number;
  state: ReferenceListState;
  previousHref: string | null;
  nextHref: string | null;
  /** Whether the caller holds music.manage at this Station — a courtesy gate; create_music_reference/update_music_reference/archive_music_reference each re-check it themselves. */
  manage: boolean;
  copy: ReferenceScreenCopy;
}) {
  const t = useTranslations('music');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  // Derived from the live `rows` prop by id, every render, rather than a
  // snapshot taken when the row was clicked: after a rename or an archive,
  // revalidatePath (actions.ts) hands this component a fresh `rows` array,
  // and re-deriving here is what lets the open dialog show the new name, or
  // close itself when the id it named is no longer in the list — with no
  // callback threaded back up from the dialog for either case.
  const editing = rows.find((row) => row.id === editingId) ?? null;

  const ariaSort = state.direction === 'asc' ? 'ascending' : 'descending';

  return (
    <>
      {manage && (
        <div className="mt-4 flex flex-wrap justify-end gap-2">
          <Button type="button" onClick={() => setCreating(true)} data-testid="reference-create">
            {copy.createButton}
          </Button>
        </div>
      )}

      <div className="mt-4 rounded-lg border" data-testid="references-grid">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead aria-sort={ariaSort}>
                <SortLink href={referenceSortHref(kind, state)} active direction={state.direction}>
                  {t('name')}
                </SortLink>
              </TableHead>
              <TableHead>{t('legacyId')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={COLUMN_COUNT} className="text-sm text-muted-foreground">
                  {hasActiveReferenceFilters(state) ? copy.noMatchMessage : copy.emptyMessage}
                </TableCell>
              </TableRow>
            ) : (
              rows.map((item) => (
                <TableRow key={item.id} data-testid="reference-row">
                  <TableCell className="font-medium">
                    <button
                      type="button"
                      onClick={() => setEditingId(item.id)}
                      className="text-left ring-offset-background hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                    >
                      {item.name}
                    </button>
                  </TableCell>
                  <TableCell>{item.legacyId ?? '—'}</TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>

        <PageControls
          total={total}
          label={copy.countLabel}
          previousHref={previousHref}
          nextHref={nextHref}
        />
      </div>

      <ReferenceRecordDialog
        record={editing}
        kind={kind}
        manage={manage}
        copy={copy}
        onClose={() => setEditingId(null)}
      />

      {manage && (
        <CreateReferenceDialog
          open={creating}
          kind={kind}
          companyId={state.companyId}
          copy={copy}
          onClose={() => setCreating(false)}
        />
      )}
    </>
  );
}

function CreateReferenceDialog({
  open,
  kind,
  companyId,
  copy,
  onClose,
}: {
  open: boolean;
  kind: ReferenceScreenKind;
  companyId: string;
  copy: ReferenceScreenCopy;
  onClose: () => void;
}) {
  const t = useTranslations('music');
  const titleId = useId();
  return (
    <Dialog open={open} onClose={onClose} labelledBy={titleId}>
      <DialogHeader>
        <DialogTitle id={titleId}>{copy.createDialogTitle}</DialogTitle>
      </DialogHeader>
      <DialogBody>
        <ReferenceCreateForm kind={kind} companyId={companyId} copy={copy} onCreated={onClose} />
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
 * Closes itself the moment the write lands, unlike
 * music/artists/artists-grid.tsx's ArtistCreateForm, which stays open on a
 * "registered — view it" message until the operator clicks through. That
 * extra step exists there to open the record dialog on the row the write just
 * created, saving a second read: this screen needs no equivalent read (the
 * record dialog above derives its row from the live `rows` prop it already
 * has), and revalidatePath (actions.ts) means the new row is already on
 * screen the moment this dialog closes — so there is nothing left for an
 * extra click to do.
 */
function ReferenceCreateForm({
  kind,
  companyId,
  copy,
  onCreated,
}: {
  kind: ReferenceScreenKind;
  companyId: string;
  copy: ReferenceScreenCopy;
  onCreated: () => void;
}) {
  const t = useTranslations('music');
  const [state, action, pending] = useActionState(createReferenceAction, INITIAL_CREATE);

  useEffect(() => {
    if (state.status === 'saved') onCreated();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  return (
    <form action={action} data-testid="reference-create-form" className="flex flex-col gap-3">
      <input type="hidden" name="companyId" value={companyId} />
      <input type="hidden" name="kind" value={kind} />

      <label className="flex flex-col gap-1 text-sm">
        <span className="text-muted-foreground">{t('name')}</span>
        <Input name="name" required maxLength={160} data-testid="reference-name" />
      </label>

      {/* legacy_id is settable only here: this is the create path, and
          create_music_reference still takes it (unlike update_music_reference
          — see its read-only counterpart in reference-record-dialog.tsx). */}
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-muted-foreground">{t('legacyId')}</span>
        <Input name="legacyId" maxLength={120} placeholder={t('optional')} />
      </label>

      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={pending} data-testid="reference-save">
          {pending ? t('saving') : copy.createButton}
        </Button>
      </div>
      {state.status === 'error' && <p className="text-sm text-destructive">{state.message}</p>}
    </form>
  );
}
