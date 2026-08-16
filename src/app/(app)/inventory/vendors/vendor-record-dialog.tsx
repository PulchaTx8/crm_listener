'use client';

import { useActionState, useEffect, useId, useState } from 'react';
import { useTranslations } from 'next-intl';
import { X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input, Textarea } from '@/components/ui/input';
import type { VendorSummary } from '@/services/vendors';
import { saveVendorAction, type VendorFormState } from './actions';
import { getVendorRecordAction } from './record';

/**
 * Block 24, item 7. The supplier's record, on the shape of
 * `show-record-dialog.tsx`: a MODAL over the list, reading itself when it opens,
 * saving through a server action and handing the saved row back so the grid can
 * patch it without re-reading the page.
 *
 * ONE COMPONENT FOR BOTH REGISTERING AND EDITING. `save_vendor` takes exactly
 * one shape and decides insert-or-update from `p_vendor_id`, so a second dialog
 * would be this one with a null record — the same argument ShowRecordDialog
 * makes.
 *
 * THERE IS NO DELETE. The only way a supplier leaves circulation is Arquivar,
 * offered from the row's own menu the way archiving is on every other list here:
 * an entry points at a vendor, so a delete would be refused with 23503 the moment
 * one purchase named them.
 */
const VENDOR_FORM_IDLE: VendorFormState = { status: 'idle' };

/** Why a record could not be shown. Held as a shape, not a sentence: the sentence needs a translator, and this is set inside an effect. */
type Failure = { kind: 'not-found' } | { kind: 'error'; message: string };

export function VendorRecordDialog({
  open,
  recordId,
  companyId,
  manage,
  onClose,
  onSaved,
}: {
  open: boolean;
  /** Null while registering a new vendor; an id while reading an existing one. */
  recordId: string | null;
  /** The Station the list is showing — the one a NEW vendor is registered at. */
  companyId: string;
  /** Whether the caller holds inventory.catalogue here. A courtesy gate; save_vendor re-checks it against auth.uid(). */
  manage: boolean;
  onClose: () => void;
  onSaved: (vendor: VendorSummary, created: boolean) => void;
}) {
  const t = useTranslations('vendors');
  const titleId = useId();
  /**
   * The form lives in the scrolling body and its submit button lives in the
   * footer, joined by this id. Thirteen fields is more than a screen once the
   * address is open, and a Save button below all of them is a Save button an
   * operator has to go looking for.
   */
  const formId = useId();
  const [record, setRecord] = useState<VendorSummary | null>(null);
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
    void getVendorRecordAction(recordId).then((result) => {
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
    ? (record?.name ?? (loading ? t('loading') : t('vendor')))
    : t('registerVendor');
  // An existing record waits for its read; a new one is ready the moment the
  // dialog opens.
  const showForm = recordId ? record !== null : true;

  return (
    <Dialog open={open} onClose={requestClose} labelledBy={titleId} className="max-w-3xl">
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
            <p className="text-sm text-destructive" data-testid="vendor-record-error">
              {failure.kind === 'not-found' ? t('noSuchVendorOrYouCannotReachIt') : failure.message}
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
          <VendorForm
            // Keyed on the record, because every field below is uncontrolled and
            // `defaultValue` is read once per mount: without this, closing one
            // vendor and opening another would show the first one's fields.
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
          <Button type="submit" form={formId} disabled={saving} data-testid="vendor-save">
            {saving ? t('saving') : t('save')}
          </Button>
        )}
      </DialogFooter>
    </Dialog>
  );
}

/**
 * Every field on every save: `save_vendor` sets each column it takes on every
 * call, so a partial submission blanks whatever it leaves out — the same warning
 * ShowForm carries, and the reason this form has no "edit just the phone"
 * shortcut.
 *
 * Three groups, in the order somebody filling this in from a business card reads
 * them: who they are, how to reach them, where they are.
 */
function VendorForm({
  formId,
  record,
  companyId,
  disabled,
  onDirty,
  onPending,
  onSaved,
}: {
  formId: string;
  record: VendorSummary | null;
  companyId: string;
  disabled: boolean;
  onDirty: (dirty: boolean) => void;
  /** So the footer's Save button, which is outside this form, can disable itself while the write is in flight. */
  onPending: (pending: boolean) => void;
  onSaved: (vendor: VendorSummary) => void;
}) {
  const t = useTranslations('vendors');
  const [state, save, saving] = useActionState(saveVendorAction, VENDOR_FORM_IDLE);

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
      className="flex flex-col gap-6"
      data-testid="vendor-dialog"
    >
      <input type="hidden" name="companyId" value={companyId} />
      {record && <input type="hidden" name="vendorId" value={record.id} />}

      <fieldset className="flex flex-col gap-4" disabled={locked}>
        <legend className="mb-2 text-sm font-medium">{t('whoTheyAre')}</legend>

        <div className="grid gap-4 sm:grid-cols-2">
          <label className="flex flex-col gap-1 text-sm sm:col-span-2">
            <span className="text-muted-foreground">{t('name')}</span>
            <Input
              name="name"
              defaultValue={record?.name ?? ''}
              maxLength={200}
              required
              data-testid="vendor-name"
            />
            {/* The one required field, and the hint says why the rest are not:
                the paperwork arrives at a different time from the supplier. */}
            <span className="text-xs text-muted-foreground">{t('theOnlyFieldThisNeeds')}</span>
          </label>

          <label className="flex flex-col gap-1 text-sm">
            <span className="text-muted-foreground">{t('legalName')}</span>
            <Input
              name="legalName"
              defaultValue={record?.legalName ?? ''}
              maxLength={200}
              data-testid="vendor-legal-name"
            />
          </label>

          <label className="flex flex-col gap-1 text-sm">
            <span className="text-muted-foreground">{t('document')}</span>
            <Input
              name="document"
              defaultValue={record?.document ?? ''}
              maxLength={40}
              placeholder={t('cnpjOrCpf')}
              data-testid="vendor-document"
            />
          </label>
        </div>
      </fieldset>

      <fieldset className="flex flex-col gap-4" disabled={locked}>
        <legend className="mb-2 text-sm font-medium">{t('howToReachThem')}</legend>

        <div className="grid gap-4 sm:grid-cols-2">
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-muted-foreground">{t('contact')}</span>
            <Input
              name="contactName"
              defaultValue={record?.contactName ?? ''}
              maxLength={200}
              data-testid="vendor-contact"
            />
          </label>

          <label className="flex flex-col gap-1 text-sm">
            <span className="text-muted-foreground">{t('phone')}</span>
            <Input
              name="phone"
              defaultValue={record?.phone ?? ''}
              maxLength={40}
              data-testid="vendor-phone"
            />
          </label>

          <label className="flex flex-col gap-1 text-sm">
            <span className="text-muted-foreground">{t('email')}</span>
            {/* NOT type="email". Nothing in this product mails a vendor, and the
                address is typed off a business card — refusing a department
                mailbox spelled oddly buys nothing. The schema says the same. */}
            <Input
              name="email"
              defaultValue={record?.email ?? ''}
              maxLength={200}
              data-testid="vendor-email"
            />
          </label>

          <label className="flex flex-col gap-1 text-sm">
            <span className="text-muted-foreground">{t('website')}</span>
            <Input
              name="website"
              defaultValue={record?.website ?? ''}
              maxLength={300}
              data-testid="vendor-website"
            />
          </label>
        </div>
      </fieldset>

      <fieldset className="flex flex-col gap-4" disabled={locked}>
        <legend className="mb-2 text-sm font-medium">{t('whereTheyAre')}</legend>

        <div className="grid gap-4 sm:grid-cols-2">
          <label className="flex flex-col gap-1 text-sm sm:col-span-2">
            <span className="text-muted-foreground">{t('address')}</span>
            <Input
              name="addressLine"
              defaultValue={record?.addressLine ?? ''}
              maxLength={300}
              data-testid="vendor-address"
            />
          </label>

          <label className="flex flex-col gap-1 text-sm">
            <span className="text-muted-foreground">{t('city')}</span>
            <Input
              name="city"
              defaultValue={record?.city ?? ''}
              maxLength={120}
              data-testid="vendor-city"
            />
          </label>

          <div className="grid grid-cols-2 gap-4">
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-muted-foreground">{t('state')}</span>
              <Input
                name="state"
                defaultValue={record?.state ?? ''}
                maxLength={60}
                data-testid="vendor-state"
              />
            </label>

            <label className="flex flex-col gap-1 text-sm">
              <span className="text-muted-foreground">{t('postalCode')}</span>
              <Input
                name="postalCode"
                defaultValue={record?.postalCode ?? ''}
                maxLength={20}
                data-testid="vendor-postal-code"
              />
            </label>
          </div>
        </div>
      </fieldset>

      <label className="flex flex-col gap-1 text-sm">
        <span className="text-muted-foreground">{t('notes')}</span>
        <Textarea
          name="notes"
          defaultValue={record?.notes ?? ''}
          rows={3}
          maxLength={2000}
          disabled={locked}
          data-testid="vendor-notes"
        />
      </label>

      {state.status === 'error' && (
        <p className="text-sm text-destructive" data-testid="vendor-error">
          {state.message}
        </p>
      )}
    </form>
  );
}
