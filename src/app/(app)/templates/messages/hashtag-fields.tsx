'use client';

import { useActionState, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { ServiceHashtags } from '@/services/templates';
import { saveServiceHashtagsAction, type ServiceHashtagsState } from './actions';

const INITIAL: ServiceHashtagsState = { status: 'idle' };

/**
 * The two hashtags a Station answers with a link straight on WhatsApp,
 * before any conversation opens (Block 19a, D6). A card above the thirteen
 * system texts rather than a fourteenth row: `set_service_hashtags` (0177)
 * writes onto `widget_installations`, which is the Station's service
 * configuration, not a message — the same division the spec's section 5
 * draws and the reason a third permission was refused for these two fields.
 *
 * THE TWO STATES THAT MUST LOOK DIFFERENT ON SCREEN. A Station with no
 * widget installation gets the fields DISABLED, WITH THE REASON — never
 * hidden, because creating an installation is a console act (0159) this
 * screen cannot perform, and hiding the fields would read as "this feature
 * does not exist" to an operator who simply has not been given a widget yet.
 * A Station that has a widget and simply has not typed a hashtag gets empty,
 * editable fields — `hashtags.installed` is what tells the two apart, since
 * both carry null hashtags (`service_hashtags_for`'s own comment, 0182).
 */
export function HashtagFields({
  companyId,
  hashtags,
  manage,
}: {
  companyId: string;
  hashtags: ServiceHashtags;
  /** Whether the caller holds templates.manage at this Station. */
  manage: boolean;
}) {
  const t = useTranslations('templates');
  const [state, action, pending] = useActionState(saveServiceHashtagsAction, INITIAL);
  const [touched, setTouched] = useState(false);

  const disabled = pending || !hashtags.installed;

  return (
    <div
      className="mb-6 flex flex-col gap-3 rounded-lg border bg-card p-4"
      data-testid="service-hashtags-card"
    >
      <div className="flex flex-col gap-1">
        <h2 className="text-sm font-medium">{t('serviceHashtagsTitle')}</h2>
        <p className="text-xs text-muted-foreground">{t('serviceHashtagsDescription')}</p>
      </div>

      {!hashtags.installed && (
        <p className="text-sm text-muted-foreground" data-testid="service-hashtags-no-installation">
          {t('serviceHashtagsNoInstallation')}
        </p>
      )}

      {manage ? (
        <form
          // Re-keyed on the pair that came back from the database, the same
          // trick system-message-list.tsx's Textarea uses for its own field:
          // a successful save re-reads `hashtags` and remounts these
          // uncontrolled inputs from the fresh values, while a FAILED save
          // leaves the row untouched, so the key does not change and the
          // operator's just-typed text stays on screen beside the error
          // saying why it was not saved.
          key={`${hashtags.music ?? ''}:${hashtags.service ?? ''}`}
          action={action}
          className="flex flex-col gap-3"
        >
          <input type="hidden" name="companyId" value={companyId} />

          <div className="grid gap-3 sm:grid-cols-2">
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-muted-foreground">{t('musicHashtagLabel')}</span>
              <Input
                name="music"
                defaultValue={hashtags.music ?? ''}
                placeholder="#TOCAAGORA"
                maxLength={40}
                disabled={disabled}
                onChange={() => setTouched(true)}
                data-testid="service-hashtag-music"
              />
              <span className="text-xs text-muted-foreground">{t('musicHashtagHelp')}</span>
            </label>

            <label className="flex flex-col gap-1 text-sm">
              <span className="text-muted-foreground">{t('serviceHashtagLabel')}</span>
              <Input
                name="service"
                defaultValue={hashtags.service ?? ''}
                placeholder="#MENUAJUDA"
                maxLength={40}
                disabled={disabled}
                onChange={() => setTouched(true)}
                data-testid="service-hashtag-service"
              />
              <span className="text-xs text-muted-foreground">{t('serviceHashtagHelp')}</span>
            </label>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" size="sm" disabled={disabled} data-testid="service-hashtags-save">
              {pending ? t('saving') : t('save')}
            </Button>
            {state.status === 'saved' && !touched && (
              <span className="text-sm text-muted-foreground">{t('hashtagsSaved')}</span>
            )}
          </div>
        </form>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="flex flex-col gap-1">
            <span className="text-xs font-medium text-muted-foreground">{t('musicHashtagLabel')}</span>
            <p className="text-sm" data-testid="service-hashtag-music-readonly">
              {hashtags.music ?? t('notSet')}
            </p>
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-xs font-medium text-muted-foreground">{t('serviceHashtagLabel')}</span>
            <p className="text-sm" data-testid="service-hashtag-service-readonly">
              {hashtags.service ?? t('notSet')}
            </p>
          </div>
        </div>
      )}

      {state.status === 'error' && (
        <p className="text-sm text-destructive" data-testid="service-hashtags-error">
          {state.message}
        </p>
      )}
    </div>
  );
}
