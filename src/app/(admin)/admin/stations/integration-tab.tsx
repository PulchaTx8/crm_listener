'use client';

import { useTranslations } from 'next-intl';
import { useActionState, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  disableIntegrationAction,
  saveIntegrationAction,
  type IntegrationState,
} from './actions';
import type { IntegrationRow } from '@/services/integrations';

const IDLE: IntegrationState = { status: 'idle' };

/**
 * One Station's WhatsApp connection, lifted out of /admin/integrations when that
 * screen was retired.
 *
 * WHY IT MOVED: the old screen was a list of every Station on the platform with
 * a card each — which is a Stations screen wearing a different name, and the
 * second one this console had. A Station's connection is a fact about the
 * Station, so it belongs in its record beside the rest of them.
 *
 * WHAT CHANGED IN THE MOVE: the form no longer calls router.refresh(). There it
 * cost a re-render of a plain list; here it would close the dialog the form is
 * inside. Both actions return the saved row instead, and this tab redraws from
 * it.
 *
 * IT CARRIES NO SECRET AND HAS NO FIELD FOR ONE. The three Meta credentials are
 * installation-wide environment variables (Block 10a, D5), so what a Station
 * owns is its number and nothing else. A field here for an access token would be
 * the first step of a secrets subsystem that block deliberately did not open.
 */
export function IntegrationTab({
  companyId,
  initialRow,
}: {
  companyId: string;
  /** Null when this Station has never been connected. */
  initialRow: IntegrationRow | null;
}) {
  const t = useTranslations('admin');
  const [saveState, save, saving] = useActionState(saveIntegrationAction, IDLE);
  const [disableState, disable, disabling] = useActionState(disableIntegrationAction, IDLE);
  const [touched, setTouched] = useState(false);

  // `row` in a state means the read-back succeeded; `undefined` means the write
  // landed and only the refresh failed, so what is on screen stays.
  const row =
    disableState.row !== undefined
      ? disableState.row
      : saveState.row !== undefined
        ? saveState.row
        : initialRow;

  const problem =
    saveState.status === 'error'
      ? saveState.message
      : disableState.status === 'error'
        ? disableState.message
        : null;

  const pending = saving || disabling;

  return (
    <div className="flex flex-col gap-4" data-testid={`integration-${companyId}`}>
      <p className="text-sm text-muted-foreground">
        {row?.integration_id
          ? row.enabled
            ? t('thisStationIsConnected')
            : t('thisStationIsConnectedButDisabled')
          : t('thisStationIsNotConnected')}
      </p>

      <form
        // Keyed on what the form is showing, so a save or a disable refills the
        // uncontrolled inputs from the row that came back rather than leaving
        // the operator looking at what they typed over stale values.
        key={`${row?.integration_id ?? 'new'}-${row?.updated_at ?? ''}`}
        action={save}
        className="flex flex-col gap-3"
      >
        <input type="hidden" name="companyId" value={companyId} />

        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-xs">
            <span className="text-muted-foreground">{t('phoneNumberId')}</span>
            <Input
              name="phoneNumberId"
              defaultValue={row?.phone_number_id ?? ''}
              required
              placeholder="1234567890"
              className="w-48"
              onChange={() => setTouched(true)}
            />
          </label>

          <label className="flex flex-col gap-1 text-xs">
            <span className="text-muted-foreground">{t('wabaId')}</span>
            <Input
              name="wabaId"
              defaultValue={row?.waba_id ?? ''}
              className="w-48"
              onChange={() => setTouched(true)}
            />
          </label>

          <label className="flex flex-col gap-1 text-xs">
            <span className="text-muted-foreground">{t('displayNumber')}</span>
            <Input
              name="displayPhoneNumber"
              defaultValue={row?.display_phone_number ?? ''}
              placeholder="+55 11 90000-0000"
              className="w-48"
              onChange={() => setTouched(true)}
            />
          </label>

          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              name="enabled"
              defaultChecked={row?.enabled ?? true}
              className="h-4 w-4"
              onChange={() => setTouched(true)}
            />
            {t('enabled')}
          </label>

          <Button type="submit" size="sm" disabled={pending} data-testid="integration-save">
            {row?.integration_id ? t('save') : t('connect')}
          </Button>
        </div>

        {saveState.status === 'done' && !touched && (
          <p className="text-sm text-muted-foreground">{t('saved')}</p>
        )}
      </form>

      {row?.integration_id && row.enabled ? (
        <form action={disable}>
          <input type="hidden" name="companyId" value={companyId} />
          <Button type="submit" variant="ghost" size="sm" disabled={pending}>
            {t('disable')}
          </Button>
        </form>
      ) : null}

      {problem ? (
        <p role="alert" className="text-sm text-destructive">
          {problem}
        </p>
      ) : null}
    </div>
  );
}
