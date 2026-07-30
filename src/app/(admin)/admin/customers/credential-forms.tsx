'use client';

import { useActionState, useEffect } from 'react';
import {
  provisionAction,
  regenerateAction,
  type CredentialState,
  type CustomerRow,
} from './actions';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

const INITIAL: CredentialState = { status: 'idle' };

/** Shown once, on screen. Never written to a URL, a log or the database. */
function CredentialNotice({ state }: { state: CredentialState }) {
  if (state.status === 'error') {
    return <p className="text-sm text-destructive">{state.message}</p>;
  }
  if (state.status !== 'revealed' || !state.password) return null;

  return (
    <div className="rounded-md border border-primary p-4">
      <p className="text-sm">
        Provisional password for <strong>{state.email}</strong>, shown once:
      </p>
      <code className="mt-2 block break-all text-lg">{state.password}</code>
      <p className="mt-2 text-sm text-muted-foreground">
        It expires in 7 days and must be changed on first sign-in. Copy it now — it is not stored
        anywhere and cannot be shown again.
      </p>
    </div>
  );
}

export function ProvisionForm({
  onProvisioned,
}: {
  /** Reports the Station that was created, so the console can show its row. */
  onProvisioned?: (company: CustomerRow) => void;
}) {
  const [state, action, pending] = useActionState(provisionAction, INITIAL);

  useEffect(() => {
    // Absent when the read-back after provisioning failed. The customer exists
    // either way and the password above is still shown; the list simply does
    // not gain its line until the next navigation.
    if (state.status === 'revealed' && state.company) onProvisioned?.(state.company);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  return (
    <div className="flex flex-col gap-4">
      <CredentialNotice state={state} />
      <form action={action} className="flex flex-col gap-3">
        <Input name="organizationName" placeholder="Organization name" required />
        <Input name="companyName" placeholder="Company (Station) name" required />
        <Input name="ownerEmail" type="email" placeholder="Owner e-mail" required />
        <Input name="ownerName" placeholder="Owner name (optional)" />
        <Button type="submit" disabled={pending}>
          {pending ? 'Provisioning…' : 'Provision'}
        </Button>
      </form>
    </div>
  );
}

export function RegenerateForm({ userId, email }: { userId: string; email: string }) {
  const [state, action, pending] = useActionState(regenerateAction, INITIAL);

  return (
    <div className="flex flex-col gap-2">
      <form action={action}>
        <input type="hidden" name="userId" value={userId} />
        <input type="hidden" name="email" value={email} />
        <Button type="submit" variant="outline" disabled={pending}>
          {pending ? 'Working…' : 'New password'}
        </Button>
      </form>
      <CredentialNotice state={state} />
    </div>
  );
}
