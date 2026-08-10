'use client';

import { useActionState, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { ApiCredentialRow } from '@/services/api-credentials';
import { issueApiKeyAction, revokeApiKeyAction, type ApiKeyState } from './actions';

const IDLE: ApiKeyState = { status: 'idle' };

/**
 * The scopes a key may hold. Permission CODES, the same vocabulary the roles
 * screen uses -- api_credential_scopes.permission_code is a foreign key against
 * public.permissions (0148), so anything not in that table is refused by
 * Postgres rather than by this list.
 *
 * Only these three are offered. A key that could read dashboards or move stock
 * is not a thing this block set out to make possible, and offering a code is how
 * somebody ends up holding it.
 */
const OFFERED_SCOPES = ['music.manage', 'music.request', 'members.create'] as const;

/**
 * A Station's machine keys: what exists, what it may do, and when it was last
 * used.
 *
 * REVOKED KEYS STAY ON THE LIST. "Was this key ever issued, and when did it
 * die?" is the question somebody asks during an incident, and a list that
 * quietly hides them cannot answer it.
 */
export function ApiKeysTab({
  companyId,
  initialRows,
  onChanged,
}: {
  companyId: string;
  initialRows: ApiCredentialRow[];
  /**
   * Hands the new list to the screen that owns the snapshot this tab was
   * rendered from, so an issued or revoked key survives leaving the tab. The
   * one-time secret is deliberately NOT part of it: nothing outside this mount
   * may hold a value the database itself cannot show twice.
   */
  onChanged: (rows: ApiCredentialRow[]) => void;
}) {
  const t = useTranslations('admin');
  const [issueState, issue, issuing] = useActionState(issueApiKeyAction, IDLE);
  const [revokeState, revoke, revoking] = useActionState(revokeApiKeyAction, IDLE);
  const [copied, setCopied] = useState(false);

  // Whichever action last returned a list wins; neither revalidates the page,
  // for the reason this file's siblings all carry — a fresh render would close
  // the record this tab lives inside.
  const rows = revokeState.rows ?? issueState.rows ?? initialRows;

  // Reported upward for the reason `onChanged` gives. Both actions are watched:
  // revoking changes the list exactly as issuing does.
  useEffect(() => {
    if (issueState.rows) onChanged(issueState.rows);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [issueState]);

  useEffect(() => {
    if (revokeState.rows) onChanged(revokeState.rows);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revokeState]);
  const problem =
    issueState.status === 'error' ? issueState.message : revokeState.status === 'error' ? revokeState.message : null;

  return (
    <div className="flex flex-col gap-5" data-testid="api-keys-tab">
      {issueState.status === 'issued' && issueState.secret && (
        <div className="flex flex-col gap-2 rounded-md border border-primary/40 bg-primary/5 p-3">
          <p className="text-sm font-medium">{t('copyThisKeyNow')}</p>
          <code className="break-all rounded bg-background px-2 py-1 text-xs" data-testid="issued-secret">
            {issueState.secret}
          </code>
          <div className="flex items-center gap-3">
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                void navigator.clipboard.writeText(issueState.secret!);
                setCopied(true);
              }}
            >
              {copied ? t('copied') : t('copy')}
            </Button>
            {/* Not a formality: the database holds only the SHA-256, so there is
                nothing anywhere that could show it a second time. */}
            <span className="text-xs text-muted-foreground">{t('itWillNotBeShownAgain')}</span>
          </div>
        </div>
      )}

      <ul className="flex flex-col gap-2 text-sm">
        {rows.map((row) => (
          <li key={row.id} className="flex items-start justify-between gap-3 rounded-md border p-3">
            <div className="flex min-w-0 flex-col gap-1">
              <span className="font-medium">{row.name}</span>
              <code className="text-xs text-muted-foreground">{row.tokenPrefix}…</code>
              <span className="text-xs text-muted-foreground">{row.scopes.join(', ')}</span>
              <span className="text-xs text-muted-foreground">
                {row.revokedAt
                  ? t('revokedOn', { date: new Date(row.revokedAt).toLocaleDateString('en-GB') })
                  : row.lastUsedAt
                    ? t('lastUsedOn', { date: new Date(row.lastUsedAt).toLocaleDateString('en-GB') })
                    : t('neverUsed')}
              </span>
            </div>
            {!row.revokedAt && (
              <form action={revoke}>
                <input type="hidden" name="companyId" value={companyId} />
                <input type="hidden" name="credentialId" value={row.id} />
                <Button type="submit" variant="outline" disabled={revoking} data-testid={`revoke-${row.id}`}>
                  {t('revoke')}
                </Button>
              </form>
            )}
          </li>
        ))}
        {rows.length === 0 && (
          <li className="text-sm text-muted-foreground">{t('thisStationHasNoKeys')}</li>
        )}
      </ul>

      <form action={issue} className="flex flex-col gap-3 border-t pt-4" data-testid="issue-key-form">
        <input type="hidden" name="companyId" value={companyId} />
        <label className="flex flex-col gap-1 text-sm">
          {t('keyName')}
          <Input name="name" required disabled={issuing} data-testid="key-name" />
        </label>

        <fieldset className="flex flex-col gap-2">
          <legend className="text-sm">{t('whatThisKeyMayDo')}</legend>
          {OFFERED_SCOPES.map((scope) => (
            <label key={scope} className="flex items-center gap-2 text-sm">
              <input type="checkbox" name="scopes" value={scope} disabled={issuing} />
              <code className="text-xs">{scope}</code>
            </label>
          ))}
        </fieldset>

        <label className="flex flex-col gap-1 text-sm">
          {t('expiresOptional')}
          <Input name="expiresAt" type="date" disabled={issuing} data-testid="key-expires" />
        </label>

        <div className="flex items-center gap-3">
          <Button type="submit" disabled={issuing} data-testid="issue-key">
            {issuing ? t('issuing') : t('issueAKey')}
          </Button>
          {problem && (
            <span className="text-sm text-destructive" data-testid="key-error">
              {problem}
            </span>
          )}
        </div>
      </form>
    </div>
  );
}
