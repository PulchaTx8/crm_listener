'use client';

import { useActionState } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { saveStationEmailIdentityAction, type EmailIdentityState } from './actions';

const IDLE: EmailIdentityState = { status: 'idle' };

export interface StationEmailIdentity {
  fromName: string | null;
  fromAddress: string | null;
  replyTo: string | null;
}

/**
 * Who this Station's campaign e-mail comes from.
 *
 * THE WARNING LIVES HERE, beside the field it is about. Block 29's D5 put the
 * transport on one installation-wide SMTP, so deliverability rests on the
 * installation's domain: an address on a domain the installation cannot sign
 * lands in spam. Repeating that on thirty template forms would be thirty places
 * to read it and none to act on it.
 */
export function StationEmailTab({
  companyId,
  initial,
}: {
  companyId: string;
  initial: StationEmailIdentity;
}) {
  const t = useTranslations('app');
  const [state, save, pending] = useActionState(saveStationEmailIdentityAction, IDLE);

  return (
    <form action={save} className="flex flex-col gap-3">
      <input type="hidden" name="companyId" value={companyId} />

      <p className="rounded-md border border-dashed p-3 text-xs text-muted-foreground">
        {t('emailIdentityDomainWarning')}
      </p>

      <label className="flex flex-col gap-1 text-sm">
        <span className="text-muted-foreground">{t('emailFromName')}</span>
        <Input name="fromName" defaultValue={initial.fromName ?? ''} maxLength={120}
               data-testid="station-email-from-name" />
      </label>

      <label className="flex flex-col gap-1 text-sm">
        <span className="text-muted-foreground">{t('emailFromAddress')}</span>
        <Input name="fromAddress" type="email" defaultValue={initial.fromAddress ?? ''}
               maxLength={200} data-testid="station-email-from-address" />
      </label>

      <label className="flex flex-col gap-1 text-sm">
        <span className="text-muted-foreground">{t('emailReplyTo')}</span>
        <Input name="replyTo" type="email" defaultValue={initial.replyTo ?? ''}
               maxLength={200} data-testid="station-email-reply-to" />
      </label>

      <div className="flex items-center gap-3">
        <Button type="submit" disabled={pending}>
          {pending ? t('saving') : t('save')}
        </Button>
        {state.status === 'error' && (
          <span className="text-sm text-destructive">{state.message}</span>
        )}
        {state.status === 'saved' && (
          <span className="text-sm text-muted-foreground">{t('saved')}</span>
        )}
      </div>
    </form>
  );
}
