'use client';

import { useTranslations } from 'next-intl';
import { useActionState, useEffect, useId, useState } from 'react';
import { X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import type { MemberDetail } from '@/services/members';
// The tab tuple is declared with parseRecordParam rather than here, because the
// page that validates `tab=` against it is a Server Component and cannot import
// a value out of a client module. See src/lib/record-params.ts.
import { MEMBER_TABS, type MemberTab } from '@/lib/record-params';
import { updateMemberAction, type MemberSaveState } from './actions';
import { getMemberRecordAction, type MemberRecord } from './record';
import { BlockForm } from './block-form';
import { ConsentForm } from './consent-form';
import { EraseMemberForm } from './erase-member-form';
import { LiftBlockButton } from './lift-block-button';
import { BLOCK_KIND_LABELS, CONSENT_TYPE_LABELS, formatCalendarDate, formatDate, formatDateTime } from './format';

const TAB_LABELS: Record<MemberTab, string> = {
  data: 'Data',
  stations: 'Stations',
  consents: 'Consents',
  notes: 'Notes',
  blocks: 'Blocks',
};

export interface MemberRecordPowers {
  edit: boolean;
  block: boolean;
  erase: boolean;
}

const INITIAL_SAVE: MemberSaveState = { status: 'idle' };

/**
 * One listener's whole record, over the list rather than on a route of its own.
 *
 * The read happens once per opening, for every tab at once (record.ts), so
 * moving between tabs cannot reach the server — and therefore cannot re-run the
 * list query behind this dialog, which is the promise the whole block rests on.
 */
export function MemberRecordDialog({
  recordId,
  tab,
  powers,
  onTab,
  onClose,
  onSaved,
  onLoaded,
  onBlocked,
}: {
  recordId: string | null;
  tab: MemberTab;
  powers: MemberRecordPowers;
  onTab: (tab: MemberTab) => void;
  onClose: () => void;
  onSaved: (detail: MemberDetail) => void;
  /**
   * Every successful read of a record, which is how a listener registered a
   * moment ago gets their row: the grid opens the new record and takes the row
   * from this read rather than from a second one of its own.
   */
  onLoaded?: (detail: MemberDetail) => void;
  /** A block that applies from now, so the grid can mark the row. */
  onBlocked: (memberId: string) => void;
}) {
  const t = useTranslations('members');
  const titleId = useId();
  const [record, setRecord] = useState<MemberRecord | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    if (!recordId) {
      setRecord(null);
      setFailure(null);
      setDirty(false);
      return;
    }
    let current = true;
    setLoading(true);
    setFailure(null);
    void getMemberRecordAction(recordId).then((result) => {
      if (!current) return;
      setLoading(false);
      if (result.status === 'ok') {
        setRecord(result.record);
        onLoaded?.(result.record.detail);
        return;
      }
      setRecord(null);
      // Both facts collapse into one sentence on purpose (record.ts): telling
      // them apart would confirm to somebody pasting ids which ones are real.
      setFailure(
        result.status === 'not-found'
          ? 'No such listener, or you do not have permission to see this one.'
          : result.message,
      );
    });
    return () => {
      current = false;
    };
    // onLoaded is stable for this dialog's lifetime, and adding it would make
    // the record re-read whenever the grid re-renders its callback.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recordId, reloadToken]);

  /**
   * Re-reads this one record after a write made inside it, so the consent,
   * note and block histories show what was just appended.
   *
   * The detail page these forms used to live on got that from
   * revalidatePath('/members/[memberId]'). That route is gone (Task 9) and the
   * list route must never be revalidated (the rule this whole block rests on),
   * so the record refreshes ITSELF: one server action, the same one that
   * opened it, re-running for one id. Nothing about the list behind the dialog
   * is re-rendered or re-queried, which is exactly the distinction — the
   * prohibition is on re-running the LIST, not on reading the record again.
   */
  function refresh() {
    setReloadToken((token) => token + 1);
  }

  function requestClose() {
    // ESC and a backdrop click both land here. Silently discarding a half-typed
    // record is the same failure as losing it to a network error.
    if (dirty && !window.confirm('Discard the changes you have not saved?')) return;
    setDirty(false);
    onClose();
  }

  const detail = record?.detail;
  const erased = Boolean(detail?.anonymizedAt);
  const title = erased
    ? 'Personal data erased'
    : (detail?.fullName ?? (loading ? 'Loading…' : 'Listener'));

  return (
    <Dialog open={recordId !== null} onClose={requestClose} labelledBy={titleId}>
      <DialogHeader>
        <div className="flex flex-col gap-1">
          <DialogTitle id={titleId}>{title}</DialogTitle>
          {detail && (
            <p className="text-xs text-muted-foreground">
              {t('registered')}{' '}{formatDate(detail.createdAt)}
              {erased ? ` · erased ${formatDate(detail.anonymizedAt as string)}` : ''}
            </p>
          )}
        </div>
        {/* "Close record", not "Close": the footer carries a Close button too,
            and two controls with one accessible name in a single dialog cannot
            be told apart by anything that reads names — a screen reader, or a
            test. */}
        <button
          type="button"
          onClick={requestClose}
          aria-label={t('closeRecord')}
          className="rounded-md p-1.5 ring-offset-background hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        >
          <X className="size-4" aria-hidden="true" />
        </button>
      </DialogHeader>

      {record && (
        <div role="tablist" aria-label={t('recordSections')} className="flex gap-1 border-b px-5">
          {MEMBER_TABS.map((name) => (
            <button
              key={name}
              type="button"
              role="tab"
              aria-selected={tab === name}
              onClick={() => onTab(name)}
              className={
                tab === name
                  ? 'border-b-2 border-primary px-3 py-2 text-sm font-medium'
                  : 'border-b-2 border-transparent px-3 py-2 text-sm text-muted-foreground hover:text-foreground'
              }
            >
              {TAB_LABELS[name]}
            </button>
          ))}
        </div>
      )}

      <DialogBody>
        {loading && <p className="text-sm text-muted-foreground">{t('loadingTheRecord')}</p>}

        {failure && (
          <div className="flex flex-col items-start gap-3">
            <p className="text-sm text-destructive">{failure}</p>
            {/* The list behind this dialog is untouched and still usable, which
                is why a failed record does not need to take the screen down. */}
            <Button type="button" variant="outline" onClick={() => setReloadToken((n) => n + 1)}>
              {t('tryAgain')}</Button>
          </div>
        )}

        {record && detail && (
          <>
            {tab === 'data' && (
              <DataTab
                detail={detail}
                canEdit={powers.edit && !erased}
                canErase={powers.erase && !erased}
                onDirty={setDirty}
                onSaved={(saved) => {
                  setDirty(false);
                  setRecord({ ...record, detail: saved });
                  onSaved(saved);
                }}
              />
            )}

            {tab === 'stations' && (
              <ul className="flex flex-col gap-2 text-sm">
                {record.stations.map((station) => (
                  <li key={station.companyId} className="flex items-center justify-between gap-3 rounded-md border p-3">
                    <span>{station.companyName}</span>
                    <span className="text-xs text-muted-foreground">
                      {t('linked')}{' '}{formatDate(station.linkedAt)}
                      {station.blocked ? ' · blocked here' : ''}
                    </span>
                  </li>
                ))}
                {record.stations.length === 0 && (
                  <li className="text-sm text-muted-foreground">
                    {t('noStationYouCanReachHas')}</li>
                )}
              </ul>
            )}

            {tab === 'consents' && (
              <div className="flex flex-col gap-4">
                <ul className="flex flex-col gap-2 text-sm">
                  {record.consents.map((consent) => (
                    <li key={consent.id} className="rounded-md border p-3">
                      <span className="font-medium">{CONSENT_TYPE_LABELS[consent.consentType]}</span>
                      {' · '}
                      {consent.granted ? 'Granted' : 'Withdrawn'}
                      {' · '}
                      {formatDateTime(consent.grantedAt)}
                      {consent.origin ? <span className="block text-muted-foreground">{consent.origin}</span> : null}
                    </li>
                  ))}
                  {record.consents.length === 0 && (
                    <li className="text-sm text-muted-foreground">{t('nothingRecordedAtAStationYou')}</li>
                  )}
                </ul>
                {powers.edit && !erased && (
                  <ConsentForm
                    memberId={detail.id}
                    stations={record.stations}
                    onRecorded={refresh}
                  />
                )}
              </div>
            )}

            {tab === 'notes' && (
              <ul className="flex flex-col gap-2 text-sm">
                {record.notes.map((note) => (
                  <li key={note.id} className="rounded-md border p-3">
                    <span className="text-xs text-muted-foreground">{formatDateTime(note.createdAt)}</span>
                    <p>{note.body ?? '(personal data erased)'}</p>
                  </li>
                ))}
                {record.notes.length === 0 && (
                  <li className="text-sm text-muted-foreground">{t('noNoteRecordedAtAStation')}</li>
                )}
                {/* Read-only: add_member_note (0034) exists in the database and
                    in the service, and has never had an interface. Writing one
                    is a screen this block did not take on, not an oversight to
                    be quietly filled in here. */}
              </ul>
            )}

            {tab === 'blocks' && (
              <div className="flex flex-col gap-4">
                <ul className="flex flex-col gap-2 text-sm">
                  {record.blocks.map((block) => (
                    <li key={block.id} data-testid="member-block-row" className="rounded-md border p-3">
                      <span className="font-medium">{BLOCK_KIND_LABELS[block.kind]}</span>
                      {' · '}
                      {block.companyId ? 'One Station' : 'Whole Organization'}
                      {' · from '}
                      {formatDateTime(block.startsAt)}
                      {block.endsAt ? ` until ${formatDateTime(block.endsAt)}` : ', no end date'}
                      {block.liftedAt && (
                        <span className="block text-muted-foreground">
                          {t('lifted2')}{' '}{formatDateTime(block.liftedAt)}
                          {block.liftReason ? ` — ${block.liftReason}` : ''}
                        </span>
                      )}
                      {block.reason && !block.liftedAt && (
                        <span className="block text-muted-foreground">{block.reason}</span>
                      )}
                      {powers.block && !block.liftedAt && (
                        <div className="mt-2">
                          <LiftBlockButton blockId={block.id} onLifted={refresh} />
                        </div>
                      )}
                    </li>
                  ))}
                  {record.blocks.length === 0 && (
                    <li className="text-sm text-muted-foreground">{t('noBlockOnRecord')}</li>
                  )}
                </ul>
                {powers.block && !erased && (
                  <BlockForm
                    memberId={detail.id}
                    stations={record.stations}
                    onRecorded={(appliesNow) => {
                      refresh();
                      // The grid's badge is only marked for a block that is
                      // blocking now; a back-dated one leaves the row alone
                      // rather than claiming something is_member_blocked would
                      // disagree with.
                      if (appliesNow) onBlocked(detail.id);
                    }}
                  />
                )}
              </div>
            )}
          </>
        )}
      </DialogBody>

      <DialogFooter>
        <Button type="button" variant="outline" onClick={requestClose}>
          {t('close')}</Button>
      </DialogFooter>
    </Dialog>
  );
}

/**
 * The identity form. Every field is submitted on every save because
 * update_member (0034) replaces the record wholesale rather than merging — a
 * partial submission would blank whatever it left out.
 *
 * first_contact_at and first_contact_origin are deliberately absent: they are
 * write-once evidence behind the owner's position on first-contact consent, and
 * update_member does not touch them at all.
 */
function DataTab({
  detail,
  canEdit,
  canErase,
  onDirty,
  onSaved,
}: {
  detail: MemberDetail;
  canEdit: boolean;
  canErase: boolean;
  onDirty: (dirty: boolean) => void;
  onSaved: (detail: MemberDetail) => void;
}) {
  const t = useTranslations('members');
  const [state, action, pending] = useActionState(updateMemberAction, INITIAL_SAVE);

  useEffect(() => {
    if (state.status === 'saved' && state.detail) onSaved(state.detail);
    // onSaved is stable for the dialog's lifetime; re-running on its identity
    // would re-report a save that already happened.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  if (!canEdit) {
    return (
      <div className="flex flex-col gap-4">
        <ReadOnlyIdentity detail={detail} />
        {detail.anonymizedAt && (
          <p className="text-sm text-muted-foreground">
            {t('thisListenerSPersonalDataWas')}</p>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <form
        action={action}
        onChange={() => onDirty(true)}
        data-testid="member-data-form"
        className="grid gap-3 sm:grid-cols-2"
      >
        <input type="hidden" name="memberId" value={detail.id} />
        <Field name="fullName" label="Name" defaultValue={detail.fullName ?? ''} required />
        <Field name="phone" label="Phone" defaultValue={detail.phone ?? ''} />
        <Field name="email" label="E-mail" defaultValue={detail.email ?? ''} />
        {/* The stored CPF is a hash; only its last three digits are readable,
            so this field is for replacing the number, never for showing it. */}
        <Field name="cpf" label={`CPF${detail.cpfLastDigits ? ` (on file: ···${detail.cpfLastDigits})` : ''}`} defaultValue="" />
        <Field name="passport" label="Passport" defaultValue={detail.passport ?? ''} />
        <Field name="birthDate" label="Date of birth" type="date" defaultValue={detail.birthDate ?? ''} />
        <Field name="addressLine" label="Address" defaultValue={detail.addressLine ?? ''} />
        <Field name="addressNumber" label="Number" defaultValue={detail.addressNumber ?? ''} />
        <Field name="addressComplement" label="Complement" defaultValue={detail.addressComplement ?? ''} />
        <Field name="neighbourhood" label="Neighbourhood" defaultValue={detail.neighbourhood ?? ''} />
        <Field name="city" label="City" defaultValue={detail.city ?? ''} />
        <Field name="state" label="State" defaultValue={detail.state ?? ''} />
        <Field name="postalCode" label="Postcode" defaultValue={detail.postalCode ?? ''} />
        <Field name="discoverySource" label="How they found us" defaultValue={detail.discoverySource ?? ''} />

        <div className="sm:col-span-2 flex items-center gap-3">
          <Button type="submit" disabled={pending}>
            {pending ? 'Saving…' : 'Save'}
          </Button>
          {state.status === 'error' && <span className="text-sm text-destructive">{state.message}</span>}
          {state.status === 'saved' && <span className="text-sm text-muted-foreground">{t('saved')}</span>}
        </div>
      </form>

      {canErase && (
        <div className="border-t pt-4">
          <EraseMemberForm memberId={detail.id} />
        </div>
      )}
    </div>
  );
}

function ReadOnlyIdentity({ detail }: { detail: MemberDetail }) {
  const rows: [string, string | null][] = [
    ['Phone', detail.phone],
    ['E-mail', detail.email],
    ['CPF', detail.cpfLastDigits ? `···${detail.cpfLastDigits}` : null],
    ['Passport', detail.passport],
    ['Date of birth', detail.birthDate ? formatCalendarDate(detail.birthDate) : null],
    ['City', detail.city],
  ];
  return (
    <dl className="grid gap-2 text-sm sm:grid-cols-2">
      {rows.map(([label, value]) => (
        <div key={label}>
          <dt className="text-xs text-muted-foreground">{label}</dt>
          <dd>{value ?? '—'}</dd>
        </div>
      ))}
    </dl>
  );
}

function Field({
  name,
  label,
  defaultValue,
  type,
  required,
}: {
  name: string;
  label: string;
  defaultValue: string;
  type?: string;
  required?: boolean;
}) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <Input name={name} type={type} defaultValue={defaultValue} required={required} />
    </label>
  );
}
