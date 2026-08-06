'use client';

import { useTranslations } from 'next-intl';
import { useActionState, useEffect } from 'react';
import { recordConsentAction, type ConsentFormState } from './actions';
import { Button } from '@/components/ui/button';
import { Input, Select } from '@/components/ui/input';
import { CONSENT_TYPE_LABELS } from './format';
import type { MemberStationRow } from '@/services/members';

const INITIAL: ConsentFormState = { status: 'idle' };

/**
 * record_member_consent (0034) — append-only: this always writes a NEW row,
 * never edits one, so "withdraw" here means the same as "grant": submit
 * another row, this time with Granted = No. member_consents_select_reachable
 * (0035) is what makes the Consents section above show the whole history, not
 * just the latest row, which is what makes an append-only withdrawal legible
 * at all.
 *
 * The Station select is restricted to `stations` — the listener's OWN
 * reachable links (listMemberStations) — rather than every Station the caller
 * can reach in general: record_member_consent itself refuses a Station this
 * listener is not linked to (member_linked_to_company, 0034), so offering a
 * wider list here would only produce a refusal this courtesy exists to avoid.
 */
export function ConsentForm({
  memberId,
  stations,
  onRecorded,
}: {
  memberId: string;
  stations: Pick<MemberStationRow, 'companyId' | 'companyName'>[];
  /**
   * Asks the record to re-read itself so the history above gains the row that
   * was just appended. The detail page this form used to live on got that from
   * revalidatePath('/members/[memberId]'); that route is gone, and the list
   * route must not be revalidated at all (Block 3c), so the record refreshes
   * itself instead — a server action, not a render of the screen behind it.
   */
  onRecorded?: () => void;
}) {
  const t = useTranslations('members');
  const [state, action, pending] = useActionState(recordConsentAction, INITIAL);

  useEffect(() => {
    if (state.status === 'saved') onRecorded?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  return (
    <form action={action} data-testid="consent-form" className="flex flex-col gap-3">
      <input type="hidden" name="memberId" value={memberId} />

      <label className="flex flex-col gap-1 text-sm">
        {t('station')}<Select name="companyId" defaultValue={stations[0]?.companyId ?? ''} required>
          {stations.map((s) => (
            <option key={s.companyId} value={s.companyId}>
              {s.companyName}
            </option>
          ))}
        </Select>
      </label>

      <label className="flex flex-col gap-1 text-sm">
        {t('consent')}<Select name="consentType" defaultValue="rules" required>
          {Object.entries(CONSENT_TYPE_LABELS).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </Select>
      </label>

      <label className="flex flex-col gap-1 text-sm">
        {t('status')}<Select name="granted" defaultValue="true" required>
          <option value="true">{t('granted')}</option>
          <option value="false">{t('withdrawn')}</option>
        </Select>
      </label>

      <label className="flex flex-col gap-1 text-sm">
        {t('origin')}<Input name="origin" maxLength={500} placeholder={t('optionalEGSignedAtThe')} />
      </label>

      <div className="flex items-center gap-3">
        <Button type="submit" disabled={pending}>
          {pending ? 'Saving…' : 'Record consent'}
        </Button>
        {state.status === 'saved' && <p className="text-sm text-emerald-700">{t('consentRecorded')}</p>}
      </div>

      {state.status === 'error' && <p className="text-sm text-destructive">{state.message}</p>}
    </form>
  );
}
