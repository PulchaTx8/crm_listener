'use client';

import { useActionState } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/input';
import { saveListenerLocaleAction, type ListenerLocaleState } from './actions';

const INITIAL: ListenerLocaleState = { status: 'idle' };

/**
 * Block 30d, item 2 (D6, D7). The Station's own language for what its
 * LISTENERS read on its widget -- distinct from the console's own language
 * gear (settings-menu.tsx), which stays on profiles.locale by the owner's
 * ruling of 2026-08-21: a Station decides what its listeners read, not what
 * its operators read.
 *
 * A card beside the service hashtags rather than a fifteenth system-message
 * row: like those two fields, this is Station CONFIGURATION and not a message
 * an operator writes -- the same division HashtagFields' own header draws for
 * itself, and the reason both live on /messages/promo rather than the
 * platform console's Station panel, which this Station's own staff never
 * opens (D6).
 */
export function ListenerLanguage({
  companyId,
  locale,
  manage,
}: {
  companyId: string;
  locale: string | null;
  /** Whether the caller holds templates.manage at this Station. */
  manage: boolean;
}) {
  const t = useTranslations('templates');
  const [state, action, pending] = useActionState(saveListenerLocaleAction, INITIAL);
  const disabled = pending || !manage;

  return (
    <div
      className="mb-6 flex flex-col gap-3 rounded-lg border bg-card p-4"
      data-testid="listener-language-card"
    >
      <div className="flex flex-col gap-1">
        <h2 className="text-sm font-medium">{t('listenerLanguage')}</h2>
        <p className="text-xs text-muted-foreground">{t('listenerLanguageHelp')}</p>
      </div>

      <form
        // Re-keyed on the value that came back from the database, the same
        // trick hashtag-fields.tsx:107 uses for its own pair of inputs: a
        // successful save re-reads `locale` and remounts this uncontrolled
        // <select> from the fresh value, while a FAILED save leaves the row
        // untouched, so the key does not change and the operator's
        // just-picked option stays on screen beside the error saying why it
        // was not saved.
        key={locale ?? ''}
        action={action}
        className="flex flex-col gap-3"
      >
        <input type="hidden" name="companyId" value={companyId} />

        {/*
          The three language NAMES are not catalogue keys, deliberately: a
          language is written in its own language in a picker, the same rule
          settings-menu.tsx's LOCALE_NAMES states for the console's own gear
          -- translating "Português" into English helps nobody choosing it.
        */}
        <Select
          name="locale"
          defaultValue={locale ?? ''}
          disabled={disabled}
          className="max-w-xs"
          data-testid="listener-locale-select"
        >
          <option value="">{t('listenerLanguageSystem')}</option>
          <option value="pt">Português</option>
          <option value="en">English</option>
          <option value="es">Español</option>
        </Select>

        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" size="sm" disabled={disabled} data-testid="listener-language-save">
            {pending ? t('saving') : t('save')}
          </Button>
        </div>
      </form>

      {state.status === 'error' && (
        <p className="text-sm text-destructive" data-testid="listener-language-error">
          {state.message}
        </p>
      )}
    </div>
  );
}
