'use client';

import { useTranslations } from 'next-intl';
import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { disableIntegrationAction, saveIntegrationAction } from './actions';
import type { IntegrationRow } from '@/services/integrations';

/**
 * Block 10a. One Station's WhatsApp connection.
 *
 * IT CARRIES NO SECRET AND HAS NO FIELD FOR ONE. The three Meta credentials are
 * installation-wide environment variables (design D5), so what a Station owns is
 * its number and nothing else. A field here for an access token would be the
 * first step of a secrets subsystem this block deliberately does not open.
 */
export function IntegrationForm({ row }: { row: IntegrationRow }) {
  const t = useTranslations('admin');
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  async function save(formData: FormData) {
    setError(null);
    const result = await saveIntegrationAction(formData);
    if (result.status === 'error') {
      setError(result.message ?? 'The integration could not be saved.');
      return;
    }
    startTransition(() => router.refresh());
  }

  async function disable() {
    setError(null);
    const result = await disableIntegrationAction(row.company_id);
    if (result.status === 'error') {
      setError(result.message ?? 'The integration could not be disabled.');
      return;
    }
    startTransition(() => router.refresh());
  }

  return (
    // Keyed by Station id, because the Station's NAME lives in the card header
    // outside this form -- so there is no text inside the form that identifies
    // which radio it configures, and a test (or anyone reading the DOM during
    // an incident) would otherwise have to infer it from document order.
    <form action={save} data-testid={`integration-${row.company_id}`} className="flex flex-col gap-3">
      <input type="hidden" name="companyId" value={row.company_id} />

      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-xs">
          <span className="text-muted-foreground">{t('phoneNumberId')}</span>
          <Input
            name="phoneNumberId"
            defaultValue={row.phone_number_id ?? ''}
            required
            placeholder="1234567890"
            className="w-48"
          />
        </label>

        <label className="flex flex-col gap-1 text-xs">
          <span className="text-muted-foreground">{t('wabaId')}</span>
          <Input name="wabaId" defaultValue={row.waba_id ?? ''} className="w-48" />
        </label>

        <label className="flex flex-col gap-1 text-xs">
          <span className="text-muted-foreground">{t('displayNumber')}</span>
          <Input
            name="displayPhoneNumber"
            defaultValue={row.display_phone_number ?? ''}
            placeholder="+55 11 90000-0000"
            className="w-48"
          />
        </label>

        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            name="enabled"
            defaultChecked={row.enabled ?? true}
            className="h-4 w-4"
          />
          {t('enabled')}</label>

        <Button type="submit" size="sm" disabled={pending}>
          {row.integration_id ? t('save') : t('connect')}
        </Button>

        {row.integration_id && row.enabled ? (
          <Button type="button" variant="ghost" size="sm" onClick={disable} disabled={pending}>
            {t('disable')}</Button>
        ) : null}
      </div>

      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </form>
  );
}
