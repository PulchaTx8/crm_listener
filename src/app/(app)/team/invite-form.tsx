'use client';

import { useActionState } from 'react';
import { inviteAction, type InviteState } from './actions';
import { Button } from '@/components/ui/button';
import { Input, Select } from '@/components/ui/input';

const INITIAL: InviteState = { status: 'idle' };

export function InviteForm({ organizationId }: { organizationId: string }) {
  const [state, action, pending] = useActionState(inviteAction, INITIAL);

  return (
    <div className="flex flex-col gap-4">
      {state.status === 'error' ? (
        <p className="text-sm text-destructive">{state.message}</p>
      ) : null}

      {state.status === 'revealed' && state.acceptUrl ? (
        <div className="rounded-md border border-primary bg-primary/5 p-4">
          <p className="text-sm">
            Invitation sent to <strong>{state.email}</strong>. If the e-mail does not arrive, share
            this link directly:
          </p>
          <code className="mt-2 block break-all text-sm">{state.acceptUrl}</code>
          <p className="mt-2 text-sm text-muted-foreground">
            It expires in 7 days and can be used once. It cannot be shown again — if it is lost,
            revoke the invitation and send a new one.
          </p>
        </div>
      ) : null}

      <form action={action} className="flex flex-col gap-3">
        <input type="hidden" name="organizationId" value={organizationId} />
        <Input name="email" type="email" placeholder="Colleague's e-mail" required />
        <Select name="role" defaultValue="operator">
          <option value="operator">Operator</option>
          <option value="viewer">Viewer</option>
          <option value="owner">Owner</option>
        </Select>
        <Button type="submit" disabled={pending}>
          {pending ? 'Sending…' : 'Send invitation'}
        </Button>
      </form>
    </div>
  );
}
