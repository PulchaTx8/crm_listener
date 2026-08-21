'use client';

import { useTranslations } from 'next-intl';
import { Input } from '@/components/ui/input';
import { ImageUploadField } from '@/components/media/image-upload-field';
import { REQUESTED_FIELD_ORDER } from '@/schemas/promotions';
import type { PromotionDetail } from '@/services/promotions';
import { REQUESTED_FIELD_LABEL_KEYS } from './format';

/**
 * Where a promotion says which doors it takes part through, and what it needs
 * for each.
 *
 * Presentational, like PromotionFields, and part of the same submission: these
 * are hidden rather than unmounted when another tab is showing, because
 * update_promotion replaces every field on every call and unmounting would
 * silently clear the hashtag, the art, the rules and the whole requested list.
 *
 * THE FILE AND THE TAB ARE STILL CALLED "whatsapp", AND THAT IS DELIBERATE
 * RATHER THAN LEFTOVER. The tab key is a URL parameter — a link somebody saved
 * to a promotion's WhatsApp tab still opens it — and renaming the file is churn
 * across two importers for no behaviour. What the OPERATOR reads is the tab
 * label, which now says participation rather than WhatsApp. Renaming the key
 * and the file is worth doing on a quiet day; leaving the label lying was not.
 *
 * Block 17c split what is inside into two halves:
 *
 *   * EITHER DOOR: the rules, the art and the requested fields. Anything a
 *     listener can be shown or asked, whichever conversation asks it.
 *   * WHATSAPP ALONE: the hashtag and the two button labels, which are objects
 *     of that conversation and of nothing else — promotions_whatsapp_fields
 *     (0171) says the same in SQL.
 *
 * Block 24 emptied the second half down to the hashtag. See the comment above
 * that field for what happened to the two button labels.
 */
export function WhatsappFields({
  record,
  enabled,
  onEnabledChange,
  webEnabled,
  onWebEnabledChange,
  disabled,
  onDirty,
}: {
  record: PromotionDetail | null;
  enabled: boolean;
  onEnabledChange: (next: boolean) => void;
  webEnabled: boolean;
  onWebEnabledChange: (next: boolean) => void;
  disabled: boolean;
  onDirty: () => void;
}) {
  const t = useTranslations('promotions');
  const conversational = enabled || webEnabled;

  return (
    <div className="flex flex-col gap-5" onInput={onDirty} onChange={onDirty}>
      <div className="flex flex-col gap-2">
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

        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            name="webEnabled"
            checked={webEnabled}
            onChange={(e) => onWebEnabledChange(e.target.checked)}
            disabled={disabled}
            className="h-4 w-4 rounded border-input"
            data-testid="promotion-web-enabled"
          />
          <span>{t('takePartByWeb')}</span>
        </label>
      </div>

      {!conversational && (
        <p className="text-sm text-muted-foreground">{t('turnThisOnToGiveThe')}</p>
      )}

      {conversational && (
        <>
          {/* Item 15. Final review, Important #1: NO `required` here, and
              that is not an oversight — the earlier `required={conversational}`
              was both stricter and more silent than the gate it meant to
              echo, in two different directions.

              STRICTER: 0259's gate (D2) refuses a TRANSITION into
              door-on/rules-blank, not the STATE — a promotion already
              door-on with blank rules (reachable since 0171 made rules
              nullable) stays saveable ON PURPOSE, so an operator correcting a
              closing date is not held hostage to a text they may not have.
              `71_promotion_rules_gate.test.sql`'s own `lives_ok` case exists
              to protect exactly that shape. `required` cannot express a
              transition — it only ever sees the form in front of it, never
              whether the row about to be replaced was already in that shape
              — so it refused the one case the gate design goes out of its
              way to permit.

              SILENT: this textarea lives inside a `hidden` tab
              (promotion-record-dialog.tsx), and Save is a button OUTSIDE the
              `<form>`, wired in only by `form="promotion-record-form"`.
              Ticking "take part on the website" on the Participation tab,
              leaving this textarea blank, switching to the Promotion tab to
              change a date, and pressing Save asked the browser to run
              constraint validation on a control that was not being rendered
              — it silently refused to submit, and nothing on screen said why.

              The database is the one boundary here, checked at three levels
              (0259 itself, its pgTAP, the isolation suite), and its refusal
              already reaches the operator as a sentence through
              describePromotionsWriteError. The hint just below already warns
              them before they save, for the shape the gate actually refuses.
              A client-side `required` that disagreed with the server in both
              directions was worse than none. */}
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-muted-foreground">{t('rules')}</span>
            <textarea
              name="rules"
              defaultValue={record?.rules ?? ''}
              rows={8}
              maxLength={20000}
              disabled={disabled}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              data-testid="promotion-rules"
            />
            <span className="text-xs text-muted-foreground">
              {conversational && !record?.rules
                ? t('rulesRequiredWhenADoorIsOpen')
                : t('whatAListenerAgreesToBeforeEntering')}
            </span>
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

          <fieldset className="flex flex-col gap-2" data-testid="promotion-requested-fields">
            <legend className="text-sm text-muted-foreground">{t('askTheListenerFor')}</legend>
            <p className="text-xs text-muted-foreground">{t('theBotAsksForEachTicked')}</p>
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

      {/* THE HASHTAG IS ALL THAT IS LEFT OF WHATSAPP'S OWN HALF. Block 24 took
          the two button labels off this tab: they titled the Yes and No buttons
          of the consent message, and engine.ts has always answered a blank one
          with DEFAULT_YES_BUTTON_LABEL / DEFAULT_NO_BUTTON_LABEL — "the default
          is copy, not data", as that file puts it. So every promotion now takes
          the default, and a listener sees exactly what they saw on any promotion
          whose operator never filled these in, which was most of them.

          The columns are not dropped (design D2). update_promotion replaces
          every field on every call, so each promotion's pair goes to null the
          next time it is saved. */}
      {enabled && (
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
          <span className="text-xs text-muted-foreground">{t('whatAListenerTextsToTake')}</span>
        </label>
      )}
    </div>
  );
}
