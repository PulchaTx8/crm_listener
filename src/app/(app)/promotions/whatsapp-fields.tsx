'use client';

import { useState } from 'react';
import { Input } from '@/components/ui/input';
import { REQUESTED_FIELD_ORDER } from '@/schemas/promotions';
import type { PromotionDetail } from '@/services/promotions';
import { REQUESTED_FIELD_LABELS } from './format';

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
  const [useArt, setUseArt] = useState(record?.useArt ?? false);
  const [artUrl, setArtUrl] = useState(record?.artUrl ?? '');

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
        <span>Take part by WhatsApp</span>
      </label>

      {!enabled && (
        <p className="text-sm text-muted-foreground">
          Turn this on to give the promotion a hashtag, a banner and the questions the bot asks.
        </p>
      )}

      {enabled && (
        <>
          <label className="flex w-72 flex-col gap-1 text-sm">
            <span className="text-muted-foreground">Hashtag</span>
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
              What a listener texts to take part. No two promotions running at the same time in
              this Station may share one.
            </span>
          </label>

          <div className="flex flex-col gap-3 rounded-md border p-4">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                name="useArt"
                checked={useArt}
                onChange={(e) => {
                  setUseArt(e.target.checked);
                  // Unticking clears the address rather than leaving it behind:
                  // the tick and the field move together, so the row can never
                  // say one thing and show another.
                  if (!e.target.checked) setArtUrl('');
                }}
                disabled={disabled}
                className="h-4 w-4 rounded border-input"
                data-testid="promotion-use-art"
              />
              <span>Send a banner with the reply</span>
            </label>

            {useArt && (
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
                <label className="flex flex-1 flex-col gap-1 text-sm">
                  <span className="text-muted-foreground">Banner address</span>
                  <Input
                    name="artUrl"
                    type="url"
                    value={artUrl}
                    onChange={(e) => setArtUrl(e.target.value)}
                    placeholder="https://…"
                    required
                    disabled={disabled}
                    data-testid="promotion-art-url"
                  />
                  <span className="text-xs text-muted-foreground">
                    WhatsApp fetches this image itself and only over https.
                  </span>
                </label>

                {/* The preview is how a broken address is noticed here rather
                    than by a listener receiving a message with no banner. */}
                {artUrl.startsWith('https://') && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={artUrl}
                    alt="Banner preview"
                    className="h-24 w-40 rounded-md border object-contain"
                    data-testid="promotion-art-preview"
                  />
                )}
              </div>
            )}
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-muted-foreground">“Yes” button</span>
              <Input
                name="yesButtonLabel"
                defaultValue={record?.yesButtonLabel ?? ''}
                placeholder="Quero!"
                maxLength={20}
                disabled={disabled}
                data-testid="promotion-yes-label"
              />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-muted-foreground">“No” button</span>
              <Input
                name="noButtonLabel"
                defaultValue={record?.noButtonLabel ?? ''}
                placeholder="Agora não"
                maxLength={20}
                disabled={disabled}
                data-testid="promotion-no-label"
              />
            </label>
          </div>

          <fieldset className="flex flex-col gap-2" data-testid="promotion-requested-fields">
            <legend className="text-sm text-muted-foreground">Ask the listener for</legend>
            <p className="text-xs text-muted-foreground">
              The bot asks for each ticked field, in this order, and writes the answer to the
              listener&apos;s record.
            </p>
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
                  <span>{REQUESTED_FIELD_LABELS[field]}</span>
                </label>
              ))}
            </div>
          </fieldset>
        </>
      )}
    </div>
  );
}
