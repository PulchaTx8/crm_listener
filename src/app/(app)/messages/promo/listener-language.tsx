'use client';

import { useActionState, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/input';
import { saveListenerLocaleAction, type ListenerLocaleState } from './actions';
import { nextShowSavedConfirmation } from './hashtag-fields';

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
  const [showSaved, setShowSaved] = useState(false);

  // THE SAME CONFIRMATION THE CARD ABOVE SHOWS, and by the same rule rather
  // than a second copy of it: `nextShowSavedConfirmation` (hashtag-fields.tsx)
  // carries the finding that a save must win over a prior edit, which is the
  // bug that made that card's own confirmation unreachable. Two cards on one
  // screen answering "did my save land?" differently is how one of them rots.
  //
  // WHY ANYTHING IS NEEDED AT ALL, since the form re-keys on `locale`: the
  // remount only reseeds the <select>, and an operator re-saving the language
  // the Station already has changes no value, so nothing on screen moves. That
  // is precisely the case that reads as a dead button — the sibling's own
  // header records that the key remount alone was not visible feedback.
  useEffect(() => {
    if (state.status === 'saved') {
      setShowSaved((previous) => nextShowSavedConfirmation(previous, 'saved'));
    }
  }, [state]);

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
          // The other half of the sibling's rule: a confirmation must not
          // outlive the value it confirmed, or it reads as "this new choice is
          // saved" over a choice nobody has submitted yet.
          onChange={() => setShowSaved((previous) => nextShowSavedConfirmation(previous, 'edited'))}
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
          {showSaved && (
            // `hashtagsSaved`, the sibling's key, rather than a second one:
            // its value is the bare word "Saved" in all three catalogues and
            // both cards confirm the same act. A duplicate key with an
            // identical value is a translation free to drift apart for no
            // reason. Its NAME is the accident -- it was written when only
            // the hashtag card confirmed anything.
            <span className="text-sm text-muted-foreground" data-testid="listener-language-saved">
              {t('hashtagsSaved')}
            </span>
          )}
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
