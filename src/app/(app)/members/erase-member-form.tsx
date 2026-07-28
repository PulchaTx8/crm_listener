'use client';

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
 *   one.
 * - "Does not survive": full_name, phone, email, cpf_hash, cpf_last_digits,
 *   passport, birth_date, every address column and discovery_source are set
 *   to null by this same function, plus first_contact_origin (kept separate
 *   in the copy below from first_contact_at, which this function does NOT
 *   null — a real, deliberately-unfixed asymmetry the block's own ledger
 *   records, so this copy does not claim first contact is erased wholesale).
 *   The free text in member_notes.body, member_consents.origin and
 *   member_blocks.reason/lift_reason for this listener is nulled too (Ruling
 *   B), while those rows and their dates/types/authors stay.
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
  const [state, action, pending] = useActionState(anonymizeMemberAction, INITIAL);
  const [confirmed, setConfirmed] = useState(false);

  return (
    <form action={action} data-testid="erase-member-form" className="flex flex-col gap-3">
      <input type="hidden" name="memberId" value={memberId} />

      <div className="flex flex-col gap-2 text-sm">
        <p>
          <strong>What survives:</strong> this listener&apos;s record stays, under the same id,
          still linked to every Station they took part in. Every consent, note and block already
          on file stays too — their dates, types and who recorded them are untouched. They will
          still appear in your audience list, labelled &ldquo;Personal data erased&rdquo; instead
          of their name.
        </p>
        <p>
          <strong>What does not survive:</strong> their name, phone, e-mail, CPF, passport, birth
          date, full address, how they found the station, and how they first contacted the
          Station are permanently removed from this record. The free text in their notes and in
          the reason (and lift reason) of their blocks is removed the same way — the notes and
          blocks themselves stay, empty of that text.
        </p>
        <p>
          <strong>This cannot be undone.</strong> There is no function in this system that
          restores what this removes, so there is nothing to offer instead of a plain warning.
        </p>
      </div>

      <label className="flex flex-col gap-1 text-sm">
        Why is this happening?
        <Select name="reason" defaultValue="" required>
          <option value="" disabled>
            Choose a reason
          </option>
          {Object.entries(REASON_LABELS).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </Select>
        <span className="text-xs text-muted-foreground">
          This choice is recorded in an unchangeable audit trail. There is no field for extra
          detail on purpose — a free-text explanation would write exactly the kind of personal
          detail this action removes right back into that trail.
        </span>
      </label>

      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          className="mt-0.5"
          checked={confirmed}
          onChange={(e) => setConfirmed(e.target.checked)}
        />
        I understand this permanently removes this listener&apos;s personal data and cannot be
        undone.
      </label>

      <div className="flex items-center gap-3">
        <Button type="submit" variant="destructive" disabled={pending || !confirmed}>
          {pending ? 'Erasing…' : 'Erase personal data permanently'}
        </Button>
      </div>

      {state.status === 'error' && <p className="text-sm text-destructive">{state.message}</p>}
    </form>
  );
}
