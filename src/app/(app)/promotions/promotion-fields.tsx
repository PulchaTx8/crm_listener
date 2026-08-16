'use client';

import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { Input } from '@/components/ui/input';
import { ImageUploadField } from '@/components/media/image-upload-field';
import type { PromotionDetail } from '@/services/promotions';
import { fromZonedWallClock, toZonedDateTime } from './zone';

/**
 * The Promotion tab's fields. Presentational: the dialog owns the `<form>`,
 * because these and the WhatsApp tab's fields are ONE submission —
 * update_promotion replaces every field on every call, so anything not posted
 * is cleared.
 */
export function PromotionFields({
  record,
  timeZone,
  disabled,
  repeats,
  onRepeatsChange,
  onDirty,
}: {
  record: PromotionDetail | null;
  timeZone: string;
  disabled: boolean;
  repeats: boolean;
  onRepeatsChange: (next: boolean) => void;
  onDirty: () => void;
}) {
  const t = useTranslations('promotions');
  // The visible inputs speak the Station's wall-clock; the hidden ones beside
  // them carry the instant the action parses. Two fields rather than a
  // conversion on the server, because only the browser knows which Station's
  // zone was on screen when the operator typed — and shipping the wall-clock
  // alone would let a Station switch between render and submit reinterpret it.
  const [startsLocal, setStartsLocal] = useState(toZonedDateTime(record?.startsAt, timeZone));
  const [endsLocal, setEndsLocal] = useState(toZonedDateTime(record?.endsAt, timeZone));

  return (
    <div className="flex flex-col gap-5" onInput={onDirty} onChange={onDirty}>
      {/* The promotion's own picture, and NOT the banner. This one identifies
          the promotion inside the system — the list, this record — and is never
          sent to anybody; the banner Meta fetches lives on the WhatsApp tab,
          where the rest of what Meta sees lives. Two different pictures with
          two different limits, which is why they are two fields. */}
      <ImageUploadField
        name="thumb"
        kind="thumb"
        currentUrl={record?.thumbUrl ?? null}
        disabled={disabled}
        onDirty={onDirty}
        label={t('promotionPicture')}
        hint={t('shownOnTheListAndTheRecord')}
      />

      <div className="grid gap-4 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-sm sm:col-span-2">
          <span className="text-muted-foreground">{t('promotion')}</span>
          <Input
            name="name"
            defaultValue={record?.name ?? ''}
            maxLength={120}
            required
            disabled={disabled}
            data-testid="promotion-name"
          />
        </label>

        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted-foreground">{t('siteIntegrationCode')}</span>
          <Input
            name="siteIntegrationCode"
            type="number"
            min={0}
            step={1}
            defaultValue={record?.siteIntegrationCode ?? ''}
            disabled={disabled}
            data-testid="promotion-site-code"
          />
          <span className="text-xs text-muted-foreground">
            {t('howTheStationSOwnWebsite')}</span>
        </label>

        <div className="hidden sm:block" aria-hidden="true" />

        {/* Both instants are typed and read in the STATION's timezone, which is
            the one the promotion actually runs in — an operator in another
            state reading their own local time would see a window an hour off
            from the one the bot enforces. */}
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted-foreground">{t('starts')}</span>
          <Input
            type="datetime-local"
            value={startsLocal}
            onChange={(e) => setStartsLocal(e.target.value)}
            required
            disabled={disabled}
            data-testid="promotion-starts"
          />
          <input
            type="hidden"
            name="startsAt"
            value={fromZonedWallClock(startsLocal, timeZone) ?? ''}
          />
        </label>

        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted-foreground">{t('ends')}</span>
          <Input
            type="datetime-local"
            value={endsLocal}
            onChange={(e) => setEndsLocal(e.target.value)}
            required
            disabled={disabled}
            data-testid="promotion-ends"
          />
          <input type="hidden" name="endsAt" value={fromZonedWallClock(endsLocal, timeZone) ?? ''} />
        </label>

        <p className="text-xs text-muted-foreground sm:col-span-2" data-testid="promotion-timezone">
          {t('timesAreThisStationSLocal')}{timeZone}).
        </p>
      </div>

      <div className="flex flex-col gap-3 rounded-md border p-4">
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            name="allowMultipleEntries"
            checked={repeats}
            onChange={(e) => onRepeatsChange(e.target.checked)}
            disabled={disabled}
            className="h-4 w-4 rounded border-input"
            data-testid="promotion-allow-multiple"
          />
          <span>{t('allowMoreThanOneEntryPer')}</span>
        </label>

        {/* Shown only when repetition is on, and required then. Unticked, the
            promotion takes one entry per listener for its whole run; ticked
            with no interval, one person could send the hashtag five hundred
            times and occupy five hundred places in the draw. */}
        {repeats && (
          <label className="flex w-64 flex-col gap-1 text-sm">
            <span className="text-muted-foreground">{t('atLeastThisManyHoursApart')}</span>
            <Input
              name="minHoursBetweenEntries"
              type="number"
              min={1}
              max={8760}
              step={1}
              defaultValue={record?.minHoursBetweenEntries ?? 24}
              required
              disabled={disabled}
              data-testid="promotion-min-hours"
            />
          </label>
        )}

        {/* The per-person ceiling (design spec D1), beside the interval it
            depends on.

            Rendered only while repetition is on, and unmounted rather than
            disabled when it is off, because an unmounted input posts nothing:
            promotions_entry_ceiling_shape (0052) and promotionFormSchema both
            refuse a ceiling without `allow_multiple_entries`, so offering the
            field there would be offering something the database will reject —
            and worse, a value left in a disabled input would still be in the
            DOM for a stale form to post.

            Optional where the interval is required, and the asymmetry is the
            constraint's own: a promotion that allows repeats without any limit
            is the ordinary case, while one that allows them with no interval is
            the five-hundred-entries-in-a-minute case the interval exists to
            stop. Blank means no ceiling.

            `min={2}` matches the schema's message rather than the column's
            type: a ceiling of one is what turning repeats off already says. */}
        {repeats && (
          <label className="flex w-64 flex-col gap-1 text-sm">
            <span className="text-muted-foreground">{t('atMostThisManyEntriesEach')}</span>
            <Input
              name="maxEntriesPerMember"
              type="number"
              min={2}
              step={1}
              defaultValue={record?.maxEntriesPerMember ?? ''}
              disabled={disabled}
              data-testid="promotion-max-entries"
            />
            <span className="text-xs text-muted-foreground">
              {t('optionalLeaveItBlankForNo')}</span>
          </label>
        )}
      </div>

      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          name="requireCorrectAnswer"
          defaultChecked={record?.requireCorrectAnswer ?? false}
          disabled={disabled}
          className="mt-0.5 h-4 w-4 rounded border-input"
          data-testid="promotion-require-correct"
        />
        <span>
          {t('requireTheRightAnswerToTake')}<span className="block text-xs text-muted-foreground">
            {t('appliesToQuizQuestionsOnlyOff')}</span>
        </span>
      </label>

      {/* THE CALL TO ACTION IS GONE (Block 24, D2). It was the sentence printed
          under the promotion's name in the WhatsApp consent message, and the
          owner took it off this form once the widget became the door most
          Stations use. buildConsentInteractive already renders the name alone
          when the column is null, so nothing about that message needed changing.

          The column is not dropped. update_promotion replaces every field on
          every call, so each promotion's value goes to null the next time it is
          saved. */}
    </div>
  );
}
