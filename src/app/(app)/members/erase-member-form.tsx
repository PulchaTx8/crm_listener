'use client';

import { useTranslations } from 'next-intl';
import { useActionState, useState } from 'react';
import { anonymizeMemberAction, type AnonymizeFormState } from './actions';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/input';

const INITIAL: AnonymizeFormState = { status: 'idle' };

const REASON_LABELS = {
  subject_request: 'The listener asked to have their data erased',
  court_order: 'A court ordered it',
  internal_policy: 'Internal policy requires it',
} as const;

/**
 * anonymize_member (0034) — irreversible, gated on members.erase. Every
 * clause below is a direct claim about that function's own body, not a
 * paraphrase:
 *
 * - "Survives": the row, its id, its Station links, and every consent, note
 *   and block row keep existing (anonymize_member never deletes a row in any
 *   of the five Member tables) — which is what lets future participation and
 *   delivery history keep referencing this listener without referencing a
 *   name. deleted_at is untouched by this function, so the listener still
 *   appears in the audience list afterwards (page.tsx's own
 *   `member.anonymizedAt ? 'Personal data erased' : ...` branch is what that
 *   looks like) — archiving is `archive_member`, a different action, not this
 *   one. This paragraph is deliberately scoped to the ROW and its
 *   dates/types/authors — it does not say the free text inside those rows
 *   survives, because it does not (see the next paragraph). The two used to
 *   sit far enough apart, and the second used to omit one column, that
 *   reading only the first implied the opposite (Task 9 review, Important
 *   1) — fixed by naming all three scrubbed free-text columns in the very
 *   next sentence, not by softening this one.
 * - "Does not survive": full_name, phone, email, cpf_hash, cpf_last_digits,
 *   passport, birth_date, every address column and discovery_source are set
 *   to null by this same function, plus first_contact_origin (kept separate
 *   in the copy below from first_contact_at, which this function does NOT
 *   null — a real, deliberately-unfixed asymmetry the block's own ledger
 *   records, so this copy does not claim first contact is erased wholesale).
 *   The free text in member_notes.body, member_consents.origin (0034:767-769
 *   — the exact field consent-form.tsx's own Origin input writes) and
 *   member_blocks.reason/lift_reason for this listener is nulled too (Ruling
 *   B), while those rows and their dates/types/authors stay. All THREE are
 *   named explicitly below — an earlier draft named only notes and blocks,
 *   which (read beside the "Survives" paragraph above) told an operator
 *   consent origins were untouched when they are not.
 * - "No undo": there is no function anywhere in this codebase that reverses
 *   anonymize_member. Once the UPDATE commits, the data it nulled is gone.
 *
 * The reason is a fixed three-option vocabulary (member_erasure_reason,
 * 0034) with deliberately no free-text alternative — not a UI restriction for
 * its own sake: the reason lands in an immutable audit_logs row, and open
 * text there would re-plant exactly the personal data this action just
 * removed (the owner's ruling, cited in anonymize_member's own comment).
 */
export function EraseMemberForm({ memberId }: { memberId: string }) {
  const t = useTranslations('members');
  const [state, action, pending] = useActionState(anonymizeMemberAction, INITIAL);
  const [confirmed, setConfirmed] = useState(false);

  return (
    <form action={action} data-testid="erase-member-form" className="flex flex-col gap-3">
      <input type="hidden" name="memberId" value={memberId} />

      <div className="flex flex-col gap-2 text-sm">
        <p>
          <strong>{t('whatSurvives')}</strong> {t('thisListenerSRecordStaysUnder')}</p>
        <p>
          <strong>{t('whatDoesNotSurvive')}</strong> {t('theirNamePhoneEMailCpf')}</p>
        <p>
          <strong>{t('thisCannotBeUndone')}</strong> {t('thereIsNoFunctionInThis')}</p>
      </div>

      <label className="flex flex-col gap-1 text-sm">
        {t('whyIsThisHappening')}<Select name="reason" defaultValue="" required>
          <option value="" disabled>
            {t('chooseAReason')}</option>
          {Object.entries(REASON_LABELS).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </Select>
        <span className="text-xs text-muted-foreground">
          {t('thisChoiceIsRecordedInAn')}</span>
      </label>

      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          className="mt-0.5"
          checked={confirmed}
          onChange={(e) => setConfirmed(e.target.checked)}
        />
        {t('iUnderstandThisPermanentlyRemovesThis')}</label>

      <div className="flex items-center gap-3">
        <Button type="submit" variant="destructive" disabled={pending || !confirmed}>
          {pending ? t('erasing') : t('erasePersonalDataPermanently')}
        </Button>
      </div>

      {state.status === 'error' && <p className="text-sm text-destructive">{state.message}</p>}
    </form>
  );
}
