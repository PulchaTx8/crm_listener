'use client';

import { useActionState, useEffect, useId, useState } from 'react';
import { useTranslations } from 'next-intl';
import { X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input, Select } from '@/components/ui/input';
import { SHOW_AGE_RATINGS, SHOW_KINDS } from '@/schemas/shows';
import type { Band } from '@/lib/shows/bands';
import type { ShowSummary } from '@/services/shows';
import { saveShowAction, type ShowFormState } from './actions';
import { getShowRecordAction } from './record';
import { ScheduleEditor } from './schedule-editor';

/**
 * Block 18. The programme's record, on the shape of `song-record-dialog.tsx`:
 * a MODAL over the list, reading itself when it opens, saving through a server
 * action and handing the saved row back so the grid can patch it without
 * re-reading the page.
 *
 * It was an inline card until this commit, and the difference is not cosmetic:
 * a form rendered into the page pushed the list down under whoever opened it,
 * had no focus trap, no ESC and no backdrop, and left the operator looking at
 * half a table below half a form. `Dialog` supplies all four from the native
 * element, and every other record in this product already behaves that way.
 *
 * ONE COMPONENT FOR BOTH REGISTERING AND EDITING, unlike songs, which has two.
 * There, the two paths post to different actions with different fields. Here
 * `save_show` takes exactly one shape and decides insert-or-update from
 * `p_show_id`, so a second dialog would be this one with a null record.
 *
 * THERE IS NO DELETE, and its absence is D8 rather than an omission. The only
 * way a programme leaves circulation is Encerrar, offered from the row's own
 * menu the way archiving is on every other list here.
 */
const SHOW_FORM_IDLE: ShowFormState = { status: 'idle' };

/** Why a record could not be shown. Held as a shape, not a sentence: the sentence needs a translator, and this is set inside an effect. */
type Failure = { kind: 'not-found' } | { kind: 'error'; message: string };

export function ShowRecordDialog({
  open,
  recordId,
  companyId,
  manage,
  onClose,
  onSaved,
}: {
  open: boolean;
  /** Null while registering a new programme; an id while reading an existing one. */
  recordId: string | null;
  /** The Station the list is showing — the one a NEW programme is registered at. */
  companyId: string;
  /** Whether the caller holds music.manage here. A courtesy gate; save_show re-checks it against auth.uid(). */
  manage: boolean;
  onClose: () => void;
  onSaved: (show: ShowSummary, created: boolean) => void;
}) {
  const t = useTranslations('shows');
  const titleId = useId();
  /**
   * The form lives in the scrolling body and its submit button lives in the
   * footer, joined by this id. A programme's form is a page and a half tall
   * once the schedule has two bands, and a Save button at the bottom of it is a
   * Save button an operator has to go looking for.
   */
  const formId = useId();
  const [record, setRecord] = useState<ShowSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    setDirty(false);

    if (!open) {
      setRecord(null);
      setFailure(null);
      setLoading(false);
      return;
    }

    // Registering: nothing to read, and an empty form is the whole state.
    if (!recordId) {
      setRecord(null);
      setFailure(null);
      setLoading(false);
      return;
    }

    let current = true;
    setLoading(true);
    setFailure(null);
    void getShowRecordAction(recordId).then((result) => {
      if (!current) return;
      setLoading(false);
      if (result.status === 'ok') {
        setRecord(result.record);
        return;
      }
      setRecord(null);
      setFailure(
        result.status === 'not-found' ? { kind: 'not-found' } : { kind: 'error', message: result.message },
      );
    });
    return () => {
      current = false;
    };
  }, [open, recordId, reloadToken]);

  function requestClose() {
    if (dirty && !window.confirm(t('discardTheChangesYouHaveNotSaved'))) return;
    setDirty(false);
    onClose();
  }

  const title = recordId ? (record?.name ?? (loading ? t('loading') : t('programme'))) : t('registerAProgramme');
  // An existing record waits for its read; a new one is ready the moment the
  // dialog opens.
  const showForm = recordId ? record !== null : true;

  return (
    <Dialog open={open} onClose={requestClose} labelledBy={titleId} className="max-w-4xl">
      <DialogHeader>
        <DialogTitle id={titleId}>{title}</DialogTitle>
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
            <p className="text-sm text-destructive" data-testid="show-record-error">
              {failure.kind === 'not-found' ? t('noSuchProgrammeOrYouCannotReachIt') : failure.message}
            </p>
            {failure.kind === 'error' && (
              <Button type="button" variant="outline" onClick={() => setReloadToken((n) => n + 1)}>
                {t('tryAgain')}
              </Button>
            )}
          </div>
        )}

        {!manage && showForm && (
          <p className="mb-4 text-sm text-muted-foreground">{t('youDoNotHoldMusicManage')}</p>
        )}

        {showForm && (
          <ShowForm
            // Keyed on the record, because every field below is uncontrolled and
            // `defaultValue` is read once per mount: without this, closing one
            // programme and opening another would show the first one's fields.
            key={record?.id ?? 'new'}
            formId={formId}
            record={record}
            companyId={record?.companyId ?? companyId}
            disabled={!manage}
            onDirty={setDirty}
            onPending={setSaving}
            onSaved={(saved) => {
              setDirty(false);
              setRecord(saved);
              onSaved(saved, record === null);
            }}
          />
        )}
      </DialogBody>

      <DialogFooter>
        <Button type="button" variant="outline" onClick={requestClose} disabled={saving}>
          {t('close')}
        </Button>
        {manage && showForm && (
          // Outside the form it submits, which is what `form` is for. The
          // browser fires submit on the form itself, so the server action runs
          // exactly as it would from a button inside it.
          <Button type="submit" form={formId} disabled={saving} data-testid="show-save">
            {saving ? t('saving') : t('save')}
          </Button>
        )}
      </DialogFooter>
    </Dialog>
  );
}

/**
 * Every field on every save: `save_show` sets each column it takes on every
 * call, so a partial submission blanks whatever it leaves out — the same
 * warning SongDataForm carries.
 */
function ShowForm({
  formId,
  record,
  companyId,
  disabled,
  onDirty,
  onPending,
  onSaved,
}: {
  formId: string;
  record: ShowSummary | null;
  companyId: string;
  disabled: boolean;
  onDirty: (dirty: boolean) => void;
  /** So the footer's Save button, which is outside this form, can disable itself while the write is in flight. */
  onPending: (pending: boolean) => void;
  onSaved: (show: ShowSummary) => void;
}) {
  const t = useTranslations('shows');
  const [state, save, saving] = useActionState(saveShowAction, SHOW_FORM_IDLE);
  const [bands, setBands] = useState<Band[]>(record?.bands ?? []);

  useEffect(() => {
    if (state.status === 'saved' && state.record) onSaved(state.record);
    // onSaved closes over the dialog's state and is rebuilt on every render;
    // depending on it would re-fire this on renders that saved nothing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  useEffect(() => {
    onPending(saving);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saving]);

  const locked = disabled || saving;

  return (
    <form
      id={formId}
      action={save}
      onChange={() => onDirty(true)}
      className="flex flex-col gap-4"
      data-testid="show-dialog"
    >
      <input type="hidden" name="companyId" value={companyId} />
      {record && <input type="hidden" name="showId" value={record.id} />}
      {/* The bands travel as one JSON field: the editor holds objects and
          save_show takes objects, so a form encoding in between would be a
          third representation of the same thing to keep in step. */}
      <input type="hidden" name="bands" value={JSON.stringify(bands)} />

      <label className="flex flex-col gap-1 text-sm">
        <span className="text-muted-foreground">{t('name')}</span>
        <Input
          name="name"
          defaultValue={record?.name ?? ''}
          maxLength={200}
          required
          disabled={locked}
          data-testid="show-name"
        />
      </label>

      <div className="grid gap-4 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted-foreground">{t('kind')}</span>
          <Select
            name="kind"
            defaultValue={record?.kind ?? ''}
            required
            disabled={locked}
            data-testid="show-kind"
          >
            <option value="" disabled>
              {t('chooseAKind')}
            </option>
            {SHOW_KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {t(`kind_${kind}`)}
              </option>
            ))}
          </Select>
        </label>

        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted-foreground">{t('ageRating')}</span>
          <Select
            name="ageRating"
            defaultValue={record?.ageRating ?? ''}
            required
            disabled={locked}
            data-testid="show-age-rating"
          >
            <option value="" disabled>
              {t('chooseAnAgeRating')}
            </option>
            {SHOW_AGE_RATINGS.map((rating) => (
              <option key={rating} value={rating}>
                {t(`age_${rating}`)}
              </option>
            ))}
          </Select>
        </label>

        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted-foreground">{t('presenter')}</span>
          <Input
            name="presenterName"
            defaultValue={record?.presenterName ?? ''}
            maxLength={200}
            disabled={locked}
            data-testid="show-presenter"
          />
        </label>

        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted-foreground">{t('producer')}</span>
          <Input
            name="producerName"
            defaultValue={record?.producerName ?? ''}
            maxLength={200}
            disabled={locked}
            data-testid="show-producer"
          />
        </label>

        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted-foreground">{t('startsOn')}</span>
          <Input
            type="date"
            name="startsOn"
            defaultValue={record?.startsOn ?? ''}
            required
            disabled={locked}
            data-testid="show-starts-on"
          />
        </label>

        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted-foreground">{t('endsOn')}</span>
          <Input
            type="date"
            name="endsOn"
            defaultValue={record?.endsOn ?? ''}
            disabled={locked}
            data-testid="show-ends-on"
          />
          {/* D7: empty is the indeterminate case, and the hint says so rather
              than leaving an operator to wonder whether they forgot it. */}
          <span className="text-xs text-muted-foreground">{t('leaveEmptyWhileItIsOnAir')}</span>
        </label>
      </div>

      <ScheduleEditor bands={bands} onChange={setBands} disabled={locked} />

      {state.status === 'error' && (
        <p className="text-sm text-destructive" data-testid="show-error">
          {state.message}
        </p>
      )}

      {/* Beside the fields rather than in the footer: the footer holds the
          control, and the answer to pressing it belongs where the eye already
          is. Save itself is rendered by the dialog. */}
      {state.status === 'saved' && (
        <p className="text-sm text-success" data-testid="show-saved">
          {t('programmeSaved')}
        </p>
      )}
    </form>
  );
}
