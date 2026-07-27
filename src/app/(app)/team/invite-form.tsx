'use client';

import { useActionState, useState } from 'react';
import { inviteAction, type InviteState } from './actions';
import { Button } from '@/components/ui/button';
import { Input, Select } from '@/components/ui/input';

const INITIAL: InviteState = { status: 'idle' };

interface RoleOption {
  id: string;
  name: string;
}

interface CompanyOption {
  id: string;
  name: string;
}

export function InviteForm({
  organizationId,
  roles,
  companies,
}: {
  organizationId: string;
  roles: RoleOption[];
  companies: CompanyOption[];
}) {
  const [state, action, pending] = useActionState(inviteAction, INITIAL);
  // The only interactive piece: whether the role select and Station list are
  // disabled follows this one checkbox. createInvitationSchema (Block 1c)
  // rejects an owner invitation that carries a role or a Station, and rejects
  // a member invitation that carries neither — so the two must never both be
  // fillable at once.
  const [isOwner, setIsOwner] = useState(false);

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

        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            name="isOwner"
            checked={isOwner}
            onChange={(e) => setIsOwner(e.target.checked)}
          />
          Invite as owner (full access to every Station)
        </label>

        {/* Disabled fields are excluded from FormData by the browser itself, so
            checking "owner" already guarantees roleId and companyIds arrive
            empty — inviteAction's own isOwner ? ... branching is the second,
            server-side line of defence, not the only one. */}
        <div className="flex flex-col gap-1">
          <Select
            name="roleId"
            disabled={isOwner}
            required={!isOwner}
            defaultValue=""
            className="text-sm"
          >
            <option value="" disabled>
              Choose a role…
            </option>
            {roles.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </Select>
          {!isOwner && roles.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No roles yet — create one on the Roles screen first.
            </p>
          ) : null}
        </div>

        <fieldset disabled={isOwner} className="flex flex-col gap-1 rounded-md border p-3">
          <legend className="px-1 text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Stations
          </legend>
          {companies.map((c) => (
            <label key={c.id} className="flex items-center gap-2 text-sm">
              <input type="checkbox" name="companyIds" value={c.id} />
              {c.name}
            </label>
          ))}
        </fieldset>

        <Button type="submit" disabled={pending}>
          {pending ? 'Sending…' : 'Send invitation'}
        </Button>
      </form>
    </div>
  );
}
