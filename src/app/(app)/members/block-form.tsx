'use client';

import { useActionState } from 'react';
import { blockMemberAction, type BlockFormState } from './actions';
import { Button } from '@/components/ui/button';
import { Input, Select, Textarea } from '@/components/ui/input';
import { BLOCK_KIND_LABELS } from './format';
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
 * `stations` is non-empty on every real render: [memberId]/page.tsx only
 * mounts this component behind `stations.length > 0` (Task 9 re-review,
 * Important — an earlier draft of both that gate and this file's own Scope
 * comment claimed an empty list "can only happen for an owner/platform-admin
 * caller", which was false: canBlock is true for an ORDINARY delegate
 * holding members.block at any Station this listener is linked to, while
 * `stations` itself is filtered by a DIFFERENT permission, members.view —
 * see the gate's own comment in [memberId]/page.tsx for the full reasoning
 * and the citations). `stations[0]?.companyId ?? ''` below is a type-level
 * fallback for the empty array TypeScript still allows, not a real path this
 * component expects to take.
 */
export function BlockForm({
  memberId,
  stations,
}: {
  memberId: string;
  stations: Pick<MemberStationRow, 'companyId' | 'companyName'>[];
}) {
  const [state, action, pending] = useActionState(blockMemberAction, INITIAL);

  return (
    <form action={action} data-testid="block-form" className="flex flex-col gap-3">
      <input type="hidden" name="memberId" value={memberId} />

      <label className="flex flex-col gap-1 text-sm">
        Kind
        <Select name="kind" defaultValue="draw_ban" required>
          {Object.entries(BLOCK_KIND_LABELS).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </Select>
      </label>

      <label className="flex flex-col gap-1 text-sm">
        Scope
        {/* Defaults to the first Station, not "Whole Organization" (Task 9
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
          <option value="">Whole Organization</option>
        </Select>
      </label>

      <label className="flex flex-col gap-1 text-sm">
        Reason
        <Textarea name="reason" required maxLength={2000} placeholder="Why is this listener being blocked?" />
      </label>

      <label className="flex flex-col gap-1 text-sm">
        Ends
        <Input name="endsAt" type="datetime-local" />
        <span className="text-xs text-muted-foreground">
          Leave blank for an indefinite block. A date here means the block stops applying once
          that moment passes — nothing needs to run for that to happen, so it will not un-block
          them a moment early or late.
        </span>
      </label>

      <div className="flex items-center gap-3">
        <Button type="submit" variant="destructive" disabled={pending}>
          {pending ? 'Saving…' : 'Block this listener'}
        </Button>
        {state.status === 'saved' && <p className="text-sm text-emerald-700">Block recorded.</p>}
      </div>

      {state.status === 'error' && <p className="text-sm text-destructive">{state.message}</p>}
    </form>
  );
}
