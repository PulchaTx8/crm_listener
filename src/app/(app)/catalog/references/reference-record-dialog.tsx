'use client';

import { useTranslations } from 'next-intl';
import { useActionState, useEffect, useId, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import type { ReferenceSummary } from '@/services/music';
import {
  archiveReferenceAction,
  updateReferenceAction,
  type ArchiveReferenceState,
  type ReferenceSaveState,
} from './actions';
import type { ReferenceScreenCopy, ReferenceScreenKind } from './list-params';

const INITIAL_SAVE: ReferenceSaveState = { status: 'idle' };
const INITIAL_ARCHIVE: ArchiveReferenceState = { status: 'idle' };

/**
 * One record's whole editable surface: a name, a read-only legacy id, a Save
 * button and an Archive button — no tabs, unlike
 * music/artists/artist-record-dialog.tsx's two, and no related-records panel,
 * because the record IS the name (0100: a name and a legacy id, nothing
 * else) and there is no list this screen's kind is "for" the way an artist is
 * for its songs.
 *
 * Archive lives INSIDE this dialog, unlike ArtistRecordDialog's (whose
 * archive is a separate action on the grid row's dropdown menu): a record
 * this thin has no second surface worth splitting the write across. Clicking
 * Archive here opens ArchiveReferenceDialog, a second native `<dialog>`
 * stacked on top of this one via the browser's own top layer — the same
 * `showModal()` behaviour dialog.tsx documents, exercised twice rather than
 * once.
 */
export function ReferenceRecordDialog({
  record,
  kind,
  manage,
  copy,
  onClose,
}: {
  record: ReferenceSummary | null;
  kind: ReferenceScreenKind;
  /** Whether the caller holds music.manage at this Station — a courtesy gate; update_music_reference/archive_music_reference each re-check it themselves. */
  manage: boolean;
  copy: ReferenceScreenCopy;
  onClose: () => void;
}) {
  const t = useTranslations('music');
  const titleId = useId();
  const [dirty, setDirty] = useState(false);
  const [confirmingArchive, setConfirmingArchive] = useState(false);

  function requestClose() {
    if (dirty && !window.confirm(t('discardTheChangesYouHaveNotSaved'))) return;
    setDirty(false);
    onClose();
  }

  return (
    <>
      <Dialog open={record !== null} onClose={requestClose} labelledBy={titleId} className="max-w-lg">
        <DialogHeader>
          <DialogTitle id={titleId}>{record?.name ?? copy.title}</DialogTitle>
        </DialogHeader>

        <DialogBody>
          {record &&
            (manage ? (
              <ReferenceDataForm
                record={record}
                kind={kind}
                onDirty={setDirty}
                onSaved={() => setDirty(false)}
              />
            ) : (
              <div className="flex flex-col gap-4">
                <p className="text-sm text-muted-foreground">{copy.readOnlyNotice}</p>
                <ReferenceReadOnlyFields record={record} />
              </div>
            ))}
        </DialogBody>

        <DialogFooter>
          {manage && record && (
            <Button
              type="button"
              variant="destructive"
              onClick={() => setConfirmingArchive(true)}
              data-testid="reference-archive"
            >
              {copy.archiveButton}
            </Button>
          )}
          <Button type="button" variant="outline" onClick={requestClose}>
            {t('close')}
          </Button>
        </DialogFooter>
      </Dialog>

      {confirmingArchive && record && (
        <ArchiveReferenceDialog
          record={record}
          kind={kind}
          copy={copy}
          onCancel={() => setConfirmingArchive(false)}
          onArchived={() => {
            setConfirmingArchive(false);
            // revalidatePath (actions.ts) removes the row from the list this
            // dialog's `record` prop is derived from (references-grid.tsx),
            // which alone would close the outer dialog too — closed
            // explicitly here anyway, rather than left to that side effect,
            // so this dialog does not depend on a refresh landing before the
            // operator's next click.
            onClose();
          }}
        />
      )}
    </>
  );
}

/**
 * Every field on every save: update_music_reference (0102) sets name on every
 * call, so a partial submission would blank what it leaves out if this form
 * ever grew a second writable field — the same warning artist-record-dialog.tsx's
 * ArtistDataForm carries.
 */
function ReferenceDataForm({
  record,
  kind,
  onDirty,
  onSaved,
}: {
  record: ReferenceSummary;
  kind: ReferenceScreenKind;
  onDirty: (dirty: boolean) => void;
  onSaved: () => void;
}) {
  const t = useTranslations('music');
  const [state, action, pending] = useActionState(updateReferenceAction, INITIAL_SAVE);

  useEffect(() => {
    if (state.status === 'saved') onSaved();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  return (
    <form
      action={action}
      onChange={() => onDirty(true)}
      data-testid="reference-data-form"
      className="flex flex-col gap-3"
    >
      <input type="hidden" name="kind" value={kind} />
      <input type="hidden" name="id" value={record.id} />

      <label className="flex flex-col gap-1 text-sm">
        <span className="text-muted-foreground">{t('name')}</span>
        {/* Keyed on the name itself, the same trick reference-panel.tsx's
            EditableRow uses: this only changes once the CANONICAL name
            changes, i.e. after a successful save has come back through the
            fresh `record` prop (references-grid.tsx derives it from the
            revalidated list) — forcing this uncontrolled input to remount and
            pick up the new defaultValue. A failed save leaves `record.name`
            untouched, so the key does not change and the operator's just-typed,
            unsaved text stays on screen next to the error explaining why it
            was not saved. */}
        <Input
          key={record.name}
          name="name"
          defaultValue={record.name}
          required
          maxLength={160}
          data-testid="reference-name"
        />
      </label>

      {/* legacy_id is Block 9's ETL idempotency handle, read-only in every
          screen once a record exists — see artist-record-dialog.tsx's own,
          longer comment on the identical field. No `name` attribute,
          deliberately: this field must never reach the edit form's FormData
          at all, on this side or a hand-crafted one. referenceUpdateSchema
          has no `legacyId` field to parse one into either way. */}
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-muted-foreground">{t('legacyId')}</span>
        <Input
          value={record.legacyId ?? ''}
          disabled
          readOnly
          placeholder={t('notLinkedToAnImport')}
          data-testid="reference-legacy-id"
        />
        <span className="text-xs text-muted-foreground">{t('setByTheCatalogueImportNot')}</span>
      </label>

      <div className="flex items-center gap-3">
        <Button type="submit" disabled={pending} data-testid="reference-save">
          {pending ? t('saving') : t('save')}
        </Button>
        {state.status === 'error' && <span className="text-sm text-destructive">{state.message}</span>}
        {state.status === 'saved' && <span className="text-sm text-muted-foreground">{t('saved')}</span>}
      </div>
    </form>
  );
}

function ReferenceReadOnlyFields({ record }: { record: ReferenceSummary }) {
  const t = useTranslations('music');
  return (
    <>
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-muted-foreground">{t('name')}</span>
        <Input value={record.name} disabled readOnly />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-muted-foreground">{t('legacyId')}</span>
        <Input value={record.legacyId ?? ''} disabled readOnly placeholder={t('notLinkedToAnImport')} />
      </label>
    </>
  );
}

/**
 * The archive confirmation, modelled directly on ArchiveReferenceDialog
 * (music/catalog/reference-panel.tsx, deleted in Task 5) — a styled `<Dialog>`
 * with a stable `data-testid`, never `window.confirm` (unstyled, blocks the
 * main thread, and undrivable by the `getByTestId('...-archive-confirm')`
 * pattern every e2e spec that exercises an archive flow already uses).
 */
function ArchiveReferenceDialog({
  record,
  kind,
  copy,
  onCancel,
  onArchived,
}: {
  record: ReferenceSummary;
  kind: ReferenceScreenKind;
  copy: ReferenceScreenCopy;
  onCancel: () => void;
  onArchived: () => void;
}) {
  const t = useTranslations('music');
  const titleId = useId();
  const [state, action, pending] = useActionState(archiveReferenceAction, INITIAL_ARCHIVE);

  useEffect(() => {
    if (state.status === 'archived') onArchived();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  return (
    <Dialog open onClose={onCancel} labelledBy={titleId} className="max-w-lg">
      <DialogHeader>
        <DialogTitle id={titleId}>{copy.archiveConfirmTitle}</DialogTitle>
      </DialogHeader>
      <DialogBody>
        <p className="text-sm">
          <strong>{record.name}</strong> {t('stopsBeingSelectableForANew')}{' '}
          <strong>{t('thisCannotBeUndoneHere')}</strong> {t('notByYouNotBySupport')}
        </p>
        {state.status === 'error' && <p className="mt-3 text-sm text-destructive">{state.message}</p>}
      </DialogBody>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onCancel}>
          {t('cancel')}
        </Button>
        <form action={action}>
          <input type="hidden" name="kind" value={kind} />
          <input type="hidden" name="id" value={record.id} />
          <Button type="submit" disabled={pending} data-testid="reference-archive-confirm">
            {pending ? t('archiving') : t('archiveAnyway')}
          </Button>
        </form>
      </DialogFooter>
    </Dialog>
  );
}
