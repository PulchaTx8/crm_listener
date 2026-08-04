'use client';

import { useActionState, useEffect, useId, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import type { ReferenceSummary } from '@/services/music';
import type { MusicReferenceKind } from '@/schemas/music';
import {
  archiveReferenceAction,
  createReferenceAction,
  updateReferenceAction,
  type ArchiveReferenceState,
  type ReferenceFormState,
} from './actions';

const INITIAL_CREATE: ReferenceFormState = { status: 'idle' };
const INITIAL_SAVE: ReferenceFormState = { status: 'idle' };
const INITIAL_ARCHIVE: ArchiveReferenceState = { status: 'idle' };

/**
 * One short list — labels, genres or shows, picked by `kind` — with an
 * inline "Add" row above it and per-row edit/archive below. There is no
 * record dialog here: the whole record is one field, so the row IS the form,
 * the deliberate difference from the Songs and Artists screens this block
 * also ships.
 *
 * Forms render only when `manage` — a courtesy, not the boundary:
 * create_music_reference, update_music_reference and archive_music_reference
 * (actions.ts) each re-check music.manage themselves before writing
 * anything, so a stale render — the permission revoked after this page
 * loaded but before a tab still open in another window is used — is still
 * refused where it actually matters.
 */
export function ReferencePanel({
  kind,
  noun,
  title,
  description,
  items,
  companyId,
  manage,
}: {
  kind: MusicReferenceKind;
  /** Singular, lower case — "label", "genre", "show" — used in this panel's own copy. */
  noun: string;
  title: string;
  description: string;
  items: ReferenceSummary[];
  companyId: string;
  /** Whether the caller holds music.manage at this Station. */
  manage: boolean;
}) {
  return (
    <div className="flex flex-col gap-4">
      <div>
        <h2 className="text-sm font-medium">{title}</h2>
        <p className="text-sm text-muted-foreground">{description}</p>
      </div>

      {manage && <AddRow kind={kind} noun={noun} companyId={companyId} />}

      {items.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No {title.toLowerCase()} yet{manage ? ' — add the first one above.' : '.'}
        </p>
      ) : (
        <ul className="flex flex-col divide-y" data-testid={`${kind.toLowerCase()}-list`}>
          {items.map((item) =>
            manage ? (
              <EditableRow key={item.id} kind={kind} noun={noun} item={item} />
            ) : (
              <li key={item.id} className="py-2 text-sm" data-testid={`${kind.toLowerCase()}-row`}>
                {item.name}
              </li>
            ),
          )}
        </ul>
      )}
    </div>
  );
}

function AddRow({
  kind,
  noun,
  companyId,
}: {
  kind: MusicReferenceKind;
  noun: string;
  companyId: string;
}) {
  const [state, action, pending] = useActionState(createReferenceAction, INITIAL_CREATE);

  return (
    <form
      action={action}
      className="flex flex-wrap items-end gap-2 rounded-md border border-dashed p-3"
      data-testid={`${kind.toLowerCase()}-create-form`}
    >
      <input type="hidden" name="companyId" value={companyId} />
      <input type="hidden" name="kind" value={kind} />
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-muted-foreground">Name</span>
        <Input name="name" required maxLength={160} className="h-9 w-56" placeholder={`New ${noun}`} />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-muted-foreground">Legacy id</span>
        <Input name="legacyId" maxLength={120} className="h-9 w-40" placeholder="Optional" />
      </label>
      <Button type="submit" disabled={pending} className="h-9">
        {pending ? 'Adding…' : `Add ${noun}`}
      </Button>
      {state.status === 'error' && <span className="text-sm text-destructive">{state.message}</span>}
    </form>
  );
}

/**
 * `legacyId` renders read-only when the row has one, and is never part of
 * this row's save form: referenceUpdateSchema (schemas/music.ts) has no
 * `legacyId` field, and update_music_reference (0102) has no parameter left
 * to send one to — see actions.ts's own comment on updateReferenceAction.
 * Setting one is a create, not an edit.
 *
 * The name input is keyed on `item.name`, not on `item.id` (the row's own
 * `key` one level up in ReferencePanel already is): this key only changes
 * once the CANONICAL name changes, i.e. after a successful save has come back
 * through the list refresh actions.ts's revalidatePath triggers. That forces
 * the uncontrolled input to remount and pick up the fresh `defaultValue`. A
 * failed save leaves the database — and therefore `item.name` — untouched, so
 * the key does not change and the operator's just-typed, unsaved text stays
 * on screen next to the error explaining why it was not saved.
 */
function EditableRow({
  kind,
  noun,
  item,
}: {
  kind: MusicReferenceKind;
  noun: string;
  item: ReferenceSummary;
}) {
  const [saveState, saveAction, savePending] = useActionState(updateReferenceAction, INITIAL_SAVE);
  const [confirmingArchive, setConfirmingArchive] = useState(false);

  return (
    <li className="flex flex-col gap-2 py-3" data-testid={`${kind.toLowerCase()}-row`}>
      <div className="flex flex-wrap items-center gap-2">
        <form action={saveAction} className="flex flex-wrap items-center gap-2">
          <input type="hidden" name="kind" value={kind} />
          <input type="hidden" name="id" value={item.id} />
          <Input
            key={item.name}
            name="name"
            defaultValue={item.name}
            required
            maxLength={160}
            className="h-9 w-56"
            aria-label={`${noun} name`}
          />
          <Button type="submit" variant="outline" size="sm" disabled={savePending}>
            {savePending ? 'Saving…' : 'Save'}
          </Button>
        </form>

        <Button
          type="button"
          variant="destructive"
          size="sm"
          onClick={() => setConfirmingArchive(true)}
        >
          Archive
        </Button>

        {item.legacyId && (
          <span
            className="text-xs text-muted-foreground"
            title="Set by the catalogue import; not editable here."
          >
            Legacy id: {item.legacyId}
          </span>
        )}
      </div>

      {saveState.status === 'error' && <p className="text-sm text-destructive">{saveState.message}</p>}

      {confirmingArchive && (
        <ArchiveReferenceDialog
          kind={kind}
          noun={noun}
          item={item}
          onClose={() => setConfirmingArchive(false)}
        />
      )}
    </li>
  );
}

/**
 * The archive confirmation, modelled directly on ArchiveSongDialog
 * (music/songs/songs-grid.tsx) — the codebase's one established shape for
 * confirming an irreversible archive/delete: a styled `<Dialog>` with a
 * stable `data-testid`, not `window.confirm` (unstyled, blocks the main
 * thread, and undrivable by the `getByTestId('...-archive-confirm')` pattern
 * every e2e spec that exercises an archive flow already uses).
 *
 * This needs none of the record-overlay machinery the brief's "no record
 * dialog here" rules out: no URL param, no `record-params.ts` entry, no
 * `useRecordDialog`. It is local `useState` on the row that opens it
 * (`confirmingArchive` above) plus the same `Dialog` primitive every other
 * confirmation in this codebase already uses — "no record dialog" and "no
 * confirmation dialog" are different rules, and only the first one binds
 * this screen.
 */
function ArchiveReferenceDialog({
  kind,
  noun,
  item,
  onClose,
}: {
  kind: MusicReferenceKind;
  noun: string;
  item: ReferenceSummary;
  /** Closes the dialog — called both on Cancel and, via the effect below, once the archive itself succeeds. */
  onClose: () => void;
}) {
  const titleId = useId();
  const [state, action, pending] = useActionState(archiveReferenceAction, INITIAL_ARCHIVE);

  useEffect(() => {
    if (state.status === 'archived') onClose();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  return (
    <Dialog open onClose={onClose} labelledBy={titleId} className="max-w-lg">
      <DialogHeader>
        <DialogTitle id={titleId}>Archive this {noun}?</DialogTitle>
      </DialogHeader>
      <DialogBody>
        <p className="text-sm">
          <strong>{item.name}</strong> stops being selectable for a new song or request.{' '}
          <strong>This cannot be undone here</strong> — not by you, not by support. Only direct
          database access can restore it.
        </p>
        {state.status === 'error' && <p className="mt-3 text-sm text-destructive">{state.message}</p>}
      </DialogBody>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose}>
          Cancel
        </Button>
        <form action={action}>
          <input type="hidden" name="kind" value={kind} />
          <input type="hidden" name="id" value={item.id} />
          <Button type="submit" disabled={pending} data-testid={`${noun}-archive-confirm`}>
            {pending ? 'Archiving…' : 'Archive anyway'}
          </Button>
        </form>
      </DialogFooter>
    </Dialog>
  );
}
