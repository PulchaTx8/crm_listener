'use client';

import { useTranslations } from 'next-intl';
import { useActionState, useEffect, useState } from 'react';
import { blockMemberAction, type BlockFormState } from './actions';
import { Button } from '@/components/ui/button';
import { Input, Select, Textarea } from '@/components/ui/input';
import { BLOCK_KIND_LABEL_KEYS } from './format';
import type { MemberStationRow } from '@/services/members';

const INITIAL: BlockFormState = { status: 'idle' };

/**
 * block_member (0034): draw_ban or suspension, a mandatory reason, an
 * optional Station scope (blank here means Organization-wide — block_member's
 * own p_company_id default null) and an optional end date. Deliberately no
 * "expires automatically" wording beyond what is stated below: is_member_blocked
 * (0032) reads starts_at/ends_at at query time on every check, so a dated
 * block stops applying because the date has passed, not because anything in
 * this codebase runs to mark it so. Lifting one before its date (or an
 * indefinite one at all) is the separate "Lift this block" action next to
 * each un-lifted row in Block history, not this form — this form only ever
 * creates a new block row (block_member is append-only, like every table in
 * this block).
 *
 * `stations` is non-empty on every real render: the record dialog only
 * mounts this component behind `stations.length > 0` (Task 9 re-review,
 * Important — an earlier draft of both that gate and this file's own Scope
 * comment claimed an empty list "can only happen for an owner/platform-admin
 * caller", which was false: canBlock is true for an ORDINARY delegate
 * holding members.block at any Station this listener is linked to, while
 * `stations` itself is filtered by a DIFFERENT permission, members.view —
 * see the record dialog's own gating for the full reasoning
 * and the citations). `stations[0]?.companyId ?? ''` below is a type-level
 * fallback for the empty array TypeScript still allows, not a real path this
 * component expects to take.
 *
 * `endsAt` is carried as a hidden ISO field, computed from the visible
 * `datetime-local` input HERE, in the browser — not submitted as-is (whole-
 * branch review, C1, Critical). A `datetime-local` input's own value is a
 * naive wall-clock string with no offset ("2026-08-15T14:30"); per ECMA-262,
 * `new Date(...)` on a string like that parses it as local time IN WHATEVER
 * PROCESS RUNS IT. Read server-side by `z.coerce.date()` (schemas/members.ts)
 * instead, "local" would have meant the Node PROCESS's own zone, not the
 * operator's — a UTC-hosted server with a Brazilian operator would then
 * persist every dated block three hours early, invisibly, because
 * formatDateTime renders the same wrong instant back in the same zone that
 * mis-parsed it. Verified on this machine: `TZ=UTC` and
 * `TZ=America/Sao_Paulo` parse the identical naive string to instants three
 * hours apart. Converting here, in the browser, is what makes "local"
 * genuinely mean the operator's own zone — the correct semantics for this
 * field — with no need to know or interpolate the Station's own
 * `companies.timezone` at all.
 */
export function BlockForm({
  memberId,
  stations,
  onRecorded,
}: {
  memberId: string;
  stations: Pick<MemberStationRow, 'companyId' | 'companyName'>[];
  /**
   * Reports a block that landed, so the record can re-read its history and the
   * grid can mark the row.
   *
   * `appliesNow` is answered here rather than guessed by the caller, and only
   * from what block_member (0034) makes certain: the row it just wrote starts
   * at now() and carries no lifted_at, so is_member_blocked (0032) — which
   * reads starts_at/ends_at/lifted_at at query time on every check — treats it
   * as blocking unless the end date chosen on this very form has already
   * passed. That is the whole of the rule, evaluated on the one input this
   * component owns; nothing here re-implements the rest of the predicate, and
   * the badge is re-derived from the database on the next navigation regardless.
   */
  onRecorded?: (appliesNow: boolean) => void;
}) {
  const t = useTranslations('members');
  // The shared enum vocabulary, which several screens render.
  const tv = useTranslations('vocab');
  const [state, action, pending] = useActionState(blockMemberAction, INITIAL);
  const [endsAtLocal, setEndsAtLocal] = useState('');
  // '' (nothing chosen) stays '' — blockMemberSchema's own optionalTimestamp
  // already treats a blank endsAt as "indefinite", not as an invalid date.
  const endsAtIso = endsAtLocal ? new Date(endsAtLocal).toISOString() : '';

  useEffect(() => {
    if (state.status !== 'saved') return;
    onRecorded?.(!endsAtIso || new Date(endsAtIso).getTime() > Date.now());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  return (
    <form action={action} data-testid="block-form" className="flex flex-col gap-3">
      <input type="hidden" name="memberId" value={memberId} />

      <label className="flex flex-col gap-1 text-sm">
        {t('kind')}<Select name="kind" defaultValue="draw_ban" required>
          {Object.entries(BLOCK_KIND_LABEL_KEYS).map(([value, labelKey]) => (
            <option key={value} value={value}>
              {tv(labelKey)}
            </option>
          ))}
        </Select>
      </label>

      <label className="flex flex-col gap-1 text-sm">
        {t('scope')}{/* Defaults to the first Station, not "Whole Organization" (Task 9
            review, minor): defaulting a destructive action to its widest
            blast radius is backwards, even though block_member's own
            has_org_permission gate refuses most delegates who would try it
            by accident and a mistaken block is recoverable via Lift.
            "Whole Organization" is still one click away, listed last — a
            deliberate choice, not the untouched default. */}
        <Select name="companyId" defaultValue={stations[0]?.companyId ?? ''}>
          {stations.map((s) => (
            <option key={s.companyId} value={s.companyId}>
              {s.companyName}
            </option>
          ))}
          <option value="">{t('wholeOrganization')}</option>
        </Select>
      </label>

      <label className="flex flex-col gap-1 text-sm">
        {t('reason')}<Textarea name="reason" required maxLength={2000} placeholder={t('whyIsThisListenerBeingBlocked')} />
      </label>

      <label className="flex flex-col gap-1 text-sm">
        {t('ends')}{/* No `name` here — this input is never submitted directly. Its value
            is a naive wall-clock string with no offset; converting it to an
            instant belongs in the browser (see this file's own doc comment,
            C1), not on the server, so `onChange` is what feeds the hidden
            `endsAt` field below rather than a server action reading this
            input's raw value. */}
        <Input
          type="datetime-local"
          data-testid="block-ends-at-input"
          value={endsAtLocal}
          onChange={(e) => setEndsAtLocal(e.target.value)}
        />
        <input type="hidden" name="endsAt" value={endsAtIso} />
        <span className="text-xs text-muted-foreground">
          {t('leaveBlankForAnIndefiniteBlock')}</span>
      </label>

      <div className="flex items-center gap-3">
        <Button type="submit" variant="destructive" disabled={pending}>
          {pending ? t('saving') : t('blockThisListener')}
        </Button>
        {state.status === 'saved' && <p className="text-sm text-emerald-700">{t('blockRecorded')}</p>}
      </div>

      {state.status === 'error' && <p className="text-sm text-destructive">{state.message}</p>}
    </form>
  );
}
