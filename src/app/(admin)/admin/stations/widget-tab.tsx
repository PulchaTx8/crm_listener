'use client';

import { useActionState, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import type { WidgetInstallationRow } from '@/services/widget-installations';
import { saveWidgetInstallationAction, type WidgetInstallationState } from './actions';

const IDLE: WidgetInstallationState = { status: 'idle' };

/**
 * The ready-made snippet a Station's webmaster pastes onto their own site
 * (spec §5). Plain text, not a live preview: this screen configures the
 * widget, the widget itself is what runs at `/w/<publicKey>` (D9 of Block
 * 15 -- the console edits, the product displays).
 */
function embedSnippet(siteUrl: string, publicKey: string): string {
  return `<iframe
  src="${siteUrl}/w/${publicKey}"
  width="360"
  height="520"
  style="border:0"
></iframe>`;
}

/**
 * One Station's widget: whether it is on, which sites may frame it, the key
 * that names it, and whether it can actually send anybody a code.
 *
 * THE KEY AND THE SNIPPET ONLY APPEAR AFTER A FIRST SAVE. Before that there is
 * no installation row and so no public key to show -- `generatePublicKey()`
 * runs once, in the service, on the first call that finds none (see
 * `upsertWidgetInstallation`'s comment). Rendering a placeholder key here
 * would invite copying something that is not the one the database will
 * actually mint.
 */
export function WidgetTab({
  companyId,
  initialInstallation,
  siteUrl,
  onSaved,
}: {
  companyId: string;
  /** Null when nobody has configured a widget for this Station yet. */
  initialInstallation: WidgetInstallationRow | null;
  /**
   * Hands the saved installation to the screen that owns the snapshot this tab
   * was rendered from. It matters most here: the first save is what MINTS the
   * public key, so without this, closing the record and reopening it would take
   * the operator back to "no key yet" for a widget that already has one.
   */
  onSaved: (installation: WidgetInstallationRow) => void;
  /** NEXT_PUBLIC_SITE_URL, resolved on the server (page.tsx) and handed down
   * rather than read from `process.env` in this client component -- Next
   * inlines `NEXT_PUBLIC_*` at build time either way, but computing it once on
   * the server keeps every screen that needs a site URL reading it the same
   * way `invitations.ts`'s `siteUrl()` already does for its own links. */
  siteUrl: string;
}) {
  const t = useTranslations('admin');
  const [state, save, saving] = useActionState(saveWidgetInstallationAction, IDLE);
  const [touched, setTouched] = useState(false);
  const [copied, setCopied] = useState<'key' | 'snippet' | null>(null);

  // `undefined` means the write landed and only the read-back failed, so what
  // is on screen stays -- the same contract IntegrationTab's `row` carries.
  const installation = state.installation !== undefined ? state.installation : initialInstallation;

  // Reported upward for the reason `onSaved` gives. The `null` arm is
  // unreachable by `WidgetInstallationState`'s own contract -- a successful
  // save always leaves a row behind -- and is tested rather than asserted
  // because a wrong assumption here would be a crash on a save that worked.
  useEffect(() => {
    if (state.installation) onSaved(state.installation);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  const problem = state.status === 'error' ? state.message : null;

  return (
    <div className="flex flex-col gap-5" data-testid="widget-tab">
      <form
        // Re-keyed on what the form is showing, so a save refills the
        // uncontrolled inputs from the row that came back rather than leaving
        // the operator looking at stale defaults -- IntegrationTab's own form
        // uses this same trick for the same reason.
        key={`${installation?.id ?? 'new'}-${installation?.updatedAt ?? ''}`}
        action={save}
        className="flex flex-col gap-3"
      >
        <input type="hidden" name="companyId" value={companyId} />

        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            name="enabled"
            defaultChecked={installation?.enabled ?? false}
            className="h-4 w-4"
            disabled={saving}
            onChange={() => setTouched(true)}
            data-testid="widget-enabled"
          />
          {t('enabled')}
        </label>

        <label className="flex flex-col gap-1 text-sm">
          {t('allowedOrigins')}
          <textarea
            name="allowedOrigins"
            defaultValue={(installation?.allowedOrigins ?? []).join('\n')}
            rows={4}
            disabled={saving}
            onChange={() => setTouched(true)}
            placeholder="https://radio.com.br"
            className="w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-xs"
            data-testid="widget-origins"
          />
        </label>
        <p className="text-xs text-muted-foreground">{t('originsOnePerLineOrComma')}</p>
        <p className="text-xs text-muted-foreground">{t('emptyOriginsMeansNowhere')}</p>

        {/*
          Block 17b. THREE FIELDS AND NOT ONE, because "wait 90 minutes" and
          "wait an hour and a half" are the same interval and an operator
          should be able to write whichever one they mean. Postgres does not
          normalise across these units, so what is typed is what reads back.
        */}
        <fieldset className="flex flex-col gap-1">
          <legend className="text-sm">{t('musicRequestCooldown')}</legend>
          <div className="flex gap-2">
            {(
              [
                ['cooldownDays', t('days'), installation?.cooldownDays ?? 0],
                ['cooldownHours', t('hours'), installation?.cooldownHours ?? 0],
                ['cooldownMinutes', t('minutes'), installation?.cooldownMinutes ?? 0],
              ] as const
            ).map(([name, label, value]) => (
              <label key={name} className="flex flex-col gap-1 text-xs">
                {label}
                <input
                  type="number"
                  name={name}
                  min={0}
                  defaultValue={value}
                  disabled={saving}
                  onChange={() => setTouched(true)}
                  className="w-24 rounded-md border border-input bg-background px-3 py-2 text-sm"
                  data-testid={`widget-${name}`}
                />
              </label>
            ))}
          </div>
        </fieldset>
        <p className="text-xs text-muted-foreground">{t('zeroMeansNoLimit')}</p>

        <div className="flex items-center gap-3">
          <Button type="submit" disabled={saving} data-testid="widget-save">
            {saving ? t('saving') : t('save')}
          </Button>
          {state.status === 'saved' && !touched && (
            <span className="text-sm text-muted-foreground">{t('saved')}</span>
          )}
          {problem && (
            <span className="text-sm text-destructive" data-testid="widget-error">
              {problem}
            </span>
          )}
        </div>
      </form>

      {/*
        THE WARNING THE WHOLE TAB EXISTS TO SHOW (spec §5). `hasTemplate` comes
        from `widget_installation_for`'s own correlated subquery, computed in
        the SAME select as `enabled` (0162's comment), so this cannot disagree
        with what the checkbox above shows. It is shown regardless of the
        enabled state on purpose: an operator about to flip this Station on is
        exactly who benefits from seeing it first.
      */}
      {installation && !installation.hasTemplate && (
        <div
          role="alert"
          className="rounded-md border border-warning/50 bg-warning/10 p-3 text-sm text-warning"
          data-testid="widget-missing-template-warning"
        >
          <p>{t('noApprovedVerificationTemplate')}</p>
          <p className="mt-1">
            {t('registerOneOnTheTemplatesScreenFor')} <code className="text-xs">WEB_VERIFICATION</code>.
          </p>
        </div>
      )}

      {installation ? (
        <div className="flex flex-col gap-4 border-t pt-4">
          <div className="flex flex-col gap-1">
            <p className="text-xs font-medium text-muted-foreground">{t('publicKey')}</p>
            <div className="flex items-center gap-3">
              <code className="break-all rounded bg-background px-2 py-1 text-xs" data-testid="widget-public-key">
                {installation.publicKey}
              </code>
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  void navigator.clipboard.writeText(installation.publicKey);
                  setCopied('key');
                }}
              >
                {copied === 'key' ? t('copied') : t('copy')}
              </Button>
            </div>
            {/* Not the ApiKeysTab urgency ("copy this key now, it will never be
                shown again") -- this key is not a secret and this tab can be
                reopened to see it any time, so the reassurance is different. */}
            <p className="text-xs text-muted-foreground">{t('thisKeyIsNotASecretItAppears')}</p>
          </div>

          <div className="flex flex-col gap-1">
            <p className="text-xs font-medium text-muted-foreground">{t('embedSnippet')}</p>
            <pre
              className="overflow-x-auto rounded-md border bg-background p-3 text-xs"
              data-testid="widget-embed-snippet"
            >
              <code>{embedSnippet(siteUrl, installation.publicKey)}</code>
            </pre>
            <div>
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  void navigator.clipboard.writeText(embedSnippet(siteUrl, installation.publicKey));
                  setCopied('snippet');
                }}
              >
                {copied === 'snippet' ? t('copied') : t('copy')}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">{t('pasteThisOnTheStationsWebsite')}</p>
          </div>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground" data-testid="widget-no-key-yet">
          {t('noWidgetKeyYetSaveToCreateOne')}
        </p>
      )}
    </div>
  );
}
