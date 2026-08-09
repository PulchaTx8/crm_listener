'use client';

import { useTranslations } from 'next-intl';
import { useActionState, useEffect } from 'react';
import {
  provisionOrganizationAction,
  regenerateAction,
  type CredentialState,
  type OrganizationRow,
} from './actions';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

const INITIAL: CredentialState = { status: 'idle' };

/**
 * Lifted out of admin/customers/credential-forms.tsx when that screen was
 * retired. What changed is the provisioning form: it no longer asks for a
 * Station name, because a customer's Station count is not known when the
 * customer is taken on, and that single field is what made every group on this
 * platform look like one radio (Block 16, D1).
 */

/** Shown once, on screen. Never written to a URL, a log or the database. */
function CredentialNotice({ state }: { state: CredentialState }) {
  const t = useTranslations('admin');
  if (state.status === 'error') {
    return <p className="text-sm text-destructive">{state.message}</p>;
  }
  if (state.status !== 'revealed' || !state.password) return null;

  return (
    <div className="rounded-md border border-primary p-4">
      <p className="text-sm">
        {t('provisionalPasswordFor')} <strong>{state.email}</strong>, shown once:
      </p>
      <code className="mt-2 block break-all text-lg">{state.password}</code>
      <p className="mt-2 text-sm text-muted-foreground">{t('itExpiresIn7DaysAnd')}</p>
    </div>
  );
}

export function ProvisionForm({
  onProvisioned,
}: {
  /** Reports the group that was created, so the console can show its row. */
  onProvisioned?: (organization: OrganizationRow) => void;
}) {
  const t = useTranslations('admin');
  const [state, action, pending] = useActionState(provisionOrganizationAction, INITIAL);

  useEffect(() => {
    // Absent when the read-back after provisioning failed. The group exists
    // either way and the password above is still shown; the list simply does
    // not gain its line until the next navigation.
    if (state.status === 'revealed' && state.organization) onProvisioned?.(state.organization);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  return (
    <div className="flex flex-col gap-4">
      <CredentialNotice state={state} />
      <form action={action} className="flex flex-col gap-3">
        <Input name="organizationName" placeholder={t('organizationName')} required />
        <Input name="ownerEmail" type="email" placeholder={t('ownerEMail')} required />
        <Input name="ownerName" placeholder={t('ownerNameOptional')} />
        <Button type="submit" disabled={pending} data-testid="organization-provision-submit">
          {pending ? t('provisioning') : t('provision')}
        </Button>
      </form>
    </div>
  );
}

export function RegenerateForm({ userId, email }: { userId: string; email: string }) {
  const t = useTranslations('admin');
  const [state, action, pending] = useActionState(regenerateAction, INITIAL);

  return (
    <div className="flex flex-col gap-2">
      <form action={action}>
        <input type="hidden" name="userId" value={userId} />
        <input type="hidden" name="email" value={email} />
        <Button type="submit" variant="outline" disabled={pending}>
          {pending ? t('working') : t('newPassword')}
        </Button>
      </form>
      <CredentialNotice state={state} />
    </div>
  );
}
