'use client';

import { useActionState } from 'react';
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
}: {
  memberId: string;
  stations: Pick<MemberStationRow, 'companyId' | 'companyName'>[];
}) {
  const [state, action, pending] = useActionState(recordConsentAction, INITIAL);

  return (
    <form action={action} data-testid="consent-form" className="flex flex-col gap-3">
      <input type="hidden" name="memberId" value={memberId} />

      <label className="flex flex-col gap-1 text-sm">
        Station
        <Select name="companyId" defaultValue={stations[0]?.companyId ?? ''} required>
          {stations.map((s) => (
            <option key={s.companyId} value={s.companyId}>
              {s.companyName}
            </option>
          ))}
        </Select>
      </label>

      <label className="flex flex-col gap-1 text-sm">
        Consent
        <Select name="consentType" defaultValue="rules" required>
          {Object.entries(CONSENT_TYPE_LABELS).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </Select>
      </label>

      <label className="flex flex-col gap-1 text-sm">
        Status
        <Select name="granted" defaultValue="true" required>
          <option value="true">Granted</option>
          <option value="false">Withdrawn</option>
        </Select>
      </label>

      <label className="flex flex-col gap-1 text-sm">
        Origin
        <Input name="origin" maxLength={500} placeholder="Optional — e.g. signed at the front desk" />
      </label>

      <div className="flex items-center gap-3">
        <Button type="submit" disabled={pending}>
          {pending ? 'Saving…' : 'Record consent'}
        </Button>
        {state.status === 'saved' && <p className="text-sm text-emerald-700">Consent recorded.</p>}
      </div>

      {state.status === 'error' && <p className="text-sm text-destructive">{state.message}</p>}
    </form>
  );
}
