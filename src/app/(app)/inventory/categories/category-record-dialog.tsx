'use client';

import { useActionState, useEffect, useId, useState } from 'react';
import { useTranslations } from 'next-intl';
import { X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import type { PrizeCategorySummary } from '@/services/inventory';
import { savePrizeCategoryAction, type PrizeCategoryFormState } from './actions';
import { getPrizeCategoryRecordAction } from './record';

/**
 * Block 26. The category's record, on the shape of `vendor-record-dialog.tsx`: a
 * MODAL over the list, reading itself when it opens, saving through a server
 * action and handing the saved row back so the grid can patch it without
 * re-reading the page.
 *
 * ONE COMPONENT FOR BOTH REGISTERING AND RENAMING. `save_prize_category` takes
 * exactly one shape and decides insert-or-update from `p_category_id`, so a
 * second dialog would be this one with a null record.
 *
 * THERE IS NO DELETE. The only way a category leaves circulation is Arquivar,
 * offered from the row's own menu the way archiving is on every other list here:
 * prizes point at a category, so a delete would be refused with 23503 the moment
 * one prize wore it.
 */
const CATEGORY_FORM_IDLE: PrizeCategoryFormState = { status: 'idle' };

/** Why a record could not be shown. Held as a shape, not a sentence: the sentence needs a translator, and this is set inside an effect. */
type Failure = { kind: 'not-found' } | { kind: 'error'; message: string };

export function CategoryRecordDialog({
  open,
  recordId,
  companyId,
  manage,
  onClose,
  onSaved,
}: {
  open: boolean;
  /** Null while registering a new category; an id while reading an existing one. */
  recordId: string | null;
  /** The Station the list is showing — the one a NEW category is registered at. */
  companyId: string;
  /** Whether the caller holds inventory.catalogue here. A courtesy gate; save_prize_category re-checks it against auth.uid(). */
  manage: boolean;
  onClose: () => void;
  onSaved: (category: PrizeCategorySummary, created: boolean) => void;
}) {
  const t = useTranslations('prizeCategories');
  const titleId = useId();
  const formId = useId();
  const [record, setRecord] = useState<PrizeCategorySummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    setDirty(false);

    if (!open || !recordId) {
      // Closed, or registering: either way there is nothing to read, and an
      // empty form is the whole state.
      setRecord(null);
      setFailure(null);
      setLoading(false);
      return;
    }

    let current = true;
    setLoading(true);
    setFailure(null);
    void getPrizeCategoryRecordAction(recordId).then((result) => {
      // The answer to a record the operator has already closed must not land.
      if (!current) return;
      setLoading(false);
      if (result.status === 'ok') {
        setRecord(result.record);
        return;
      }
      setRecord(null);
      setFailure(
        result.status === 'not-found'
          ? { kind: 'not-found' }
          : { kind: 'error', message: result.message },
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

  const title = recordId
    ? (record?.name ?? (loading ? t('loading') : t('category')))
    : t('registerCategory');
  // An existing record waits for its read; a new one is ready the moment the
  // dialog opens.
  const showForm = recordId ? record !== null : true;

  return (
    <Dialog open={open} onClose={requestClose} labelledBy={titleId} className="max-w-lg">
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
            <p className="text-sm text-destructive" data-testid="category-record-error">
              {failure.kind === 'not-found' ? t('noSuchCategoryOrYouCannotReachIt') : failure.message}
            </p>
            {failure.kind === 'error' && (
              <Button type="button" variant="outline" onClick={() => setReloadToken((n) => n + 1)}>
                {t('tryAgain')}
              </Button>
            )}
          </div>
        )}

        {!manage && showForm && (
          <p className="mb-4 text-sm text-muted-foreground">{t('youDoNotHoldInventoryCatalogue')}</p>
        )}

        {showForm && (
          <CategoryForm
            // Keyed on the record, because the field below is uncontrolled and
            // `defaultValue` is read once per mount: without this, closing one
            // category and opening another would show the first one's name.
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
          // Outside the form it submits, which is what `form` is for. The browser
          // fires submit on the form itself, so the server action runs exactly as
          // it would from a button inside it.
          <Button type="submit" form={formId} disabled={saving} data-testid="category-save">
            {saving ? t('saving') : t('save')}
          </Button>
        )}
      </DialogFooter>
    </Dialog>
  );
}

function CategoryForm({
  formId,
  record,
  companyId,
  disabled,
  onDirty,
  onPending,
  onSaved,
}: {
  formId: string;
  record: PrizeCategorySummary | null;
  companyId: string;
  disabled: boolean;
  onDirty: (dirty: boolean) => void;
  /** So the footer's Save button, which is outside this form, can disable itself while the write is in flight. */
  onPending: (pending: boolean) => void;
  onSaved: (category: PrizeCategorySummary) => void;
}) {
  const t = useTranslations('prizeCategories');
  const [state, save, saving] = useActionState(savePrizeCategoryAction, CATEGORY_FORM_IDLE);

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
      data-testid="category-dialog"
    >
      <input type="hidden" name="companyId" value={companyId} />
      {record && <input type="hidden" name="categoryId" value={record.id} />}

      <label className="flex flex-col gap-1 text-sm">
        <span className="text-muted-foreground">{t('name')}</span>
        <Input
          name="name"
          defaultValue={record?.name ?? ''}
          maxLength={120}
          required
          disabled={locked}
          data-testid="category-name"
        />
      </label>

      {/* Renaming is safe in a way archiving is not, and saying so here is what
          stops an operator treating the two as the same button: the prizes go on
          pointing at this row, so they simply start reading the new word. */}
      {record && (
        <p className="text-xs text-muted-foreground" data-testid="category-prize-count">
          {t('prizesWearingThisLabel', { count: record.prizeCount })}
        </p>
      )}

      {state.status === 'error' && (
        <p className="text-sm text-destructive" data-testid="category-error">
          {state.message}
        </p>
      )}
    </form>
  );
}
