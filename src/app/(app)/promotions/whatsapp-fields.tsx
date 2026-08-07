'use client';

import { useTranslations } from 'next-intl';
import { Input } from '@/components/ui/input';
import { ImageUploadField } from '@/components/media/image-upload-field';
import { REQUESTED_FIELD_ORDER } from '@/schemas/promotions';
import type { PromotionDetail } from '@/services/promotions';
import { REQUESTED_FIELD_LABEL_KEYS } from './format';

/**
 * The WhatsApp tab's fields. Presentational, like PromotionFields, and part of
 * the same submission: these are hidden rather than unmounted when another tab
 * is showing, because update_promotion replaces every field on every call and
 * unmounting would silently clear the hashtag, the art and the whole requested
 * list.
 */
export function WhatsappFields({
  record,
  enabled,
  onEnabledChange,
  disabled,
  onDirty,
}: {
  record: PromotionDetail | null;
  enabled: boolean;
  onEnabledChange: (next: boolean) => void;
  disabled: boolean;
  onDirty: () => void;
}) {
  const t = useTranslations('promotions');

  return (
    <div className="flex flex-col gap-5" onInput={onDirty} onChange={onDirty}>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          name="whatsappEnabled"
          checked={enabled}
          onChange={(e) => onEnabledChange(e.target.checked)}
          disabled={disabled}
          className="h-4 w-4 rounded border-input"
          data-testid="promotion-whatsapp-enabled"
        />
        <span>{t('takePartByWhatsapp')}</span>
      </label>

      {!enabled && (
        <p className="text-sm text-muted-foreground">
          {t('turnThisOnToGiveThe')}</p>
      )}

      {enabled && (
        <>
          <label className="flex w-72 flex-col gap-1 text-sm">
            <span className="text-muted-foreground">{t('hashtag')}</span>
            <Input
              name="hashtag"
              defaultValue={record?.hashtag ?? ''}
              placeholder="#EUQUERO"
              maxLength={40}
              required
              disabled={disabled}
              data-testid="promotion-hashtag"
            />
            <span className="text-xs text-muted-foreground">
              {t('whatAListenerTextsToTake')}</span>
          </label>

          {/* THE TICK IS GONE, and it is not an oversight. It used to set
              `use_art`, which promotions_art_shape (0040) has always forced to
              agree with `art_url` — so it was never a second state, only a
              second place to say the same thing. Having a banner IS the tick
              now: set_promotion_art writes both columns from the presence of
              the address (0144).

              The address input is gone with it. A banner is uploaded rather
              than typed, so nothing on this form can post an address, and the
              only place one is built is the server, from the upload's own
              result. */}
          <div className="flex flex-col gap-3 rounded-md border p-4">
            <ImageUploadField
              name="art"
              kind="banner"
              currentUrl={record?.artUrl ?? null}
              disabled={disabled}
              onDirty={onDirty}
              label={t('bannerSentWithTheReply')}
              hint={t('whatsappFetchesThisImageItselfAnd')}
            />
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-muted-foreground">“Yes” button</span>
              <Input
                name="yesButtonLabel"
                defaultValue={record?.yesButtonLabel ?? ''}
                placeholder={t('quero')}
                maxLength={20}
                disabled={disabled}
                data-testid="promotion-yes-label"
              />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-muted-foreground">{t('noButton')}</span>
              <Input
                name="noButtonLabel"
                defaultValue={record?.noButtonLabel ?? ''}
                placeholder={t('agoraNO')}
                maxLength={20}
                disabled={disabled}
                data-testid="promotion-no-label"
              />
            </label>
          </div>

          <fieldset className="flex flex-col gap-2" data-testid="promotion-requested-fields">
            <legend className="text-sm text-muted-foreground">{t('askTheListenerFor')}</legend>
            <p className="text-xs text-muted-foreground">
              {t('theBotAsksForEachTicked')}</p>
            <div className="grid gap-1 sm:grid-cols-2">
              {REQUESTED_FIELD_ORDER.map((field) => (
                <label key={field} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    name="requestedFields"
                    value={field}
                    defaultChecked={record?.requestedFields.includes(field) ?? false}
                    disabled={disabled}
                    className="h-4 w-4 rounded border-input"
                  />
                  <span>{t(REQUESTED_FIELD_LABEL_KEYS[field])}</span>
                </label>
              ))}
            </div>
          </fieldset>
        </>
      )}
    </div>
  );
}
