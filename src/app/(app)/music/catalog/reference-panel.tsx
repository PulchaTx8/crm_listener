'use client';

import { useActionState } from 'react';
import { Button } from '@/components/ui/button';
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
  const [archiveState, archiveAction, archivePending] = useActionState(
    archiveReferenceAction,
    INITIAL_ARCHIVE,
  );

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

        <form
          action={archiveAction}
          onSubmit={(event) => {
            // A lightweight gate in front of an irreversible RPC, not a
            // record dialog: archiving a reference is unreadable through RLS
            // for every caller afterwards (services/music.ts's own comment on
            // archiveMusicReference), and this screen deliberately carries no
            // modal machinery for a one-field row to open one over.
            if (
              !window.confirm(
                `Archive "${item.name}"? It stops being selectable for a new song or request, and this cannot be undone here.`,
              )
            ) {
              event.preventDefault();
            }
          }}
        >
          <input type="hidden" name="kind" value={kind} />
          <input type="hidden" name="id" value={item.id} />
          <Button type="submit" variant="destructive" size="sm" disabled={archivePending}>
            {archivePending ? 'Archiving…' : 'Archive'}
          </Button>
        </form>

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
      {archiveState.status === 'error' && (
        <p className="text-sm text-destructive">{archiveState.message}</p>
      )}
    </li>
  );
}
