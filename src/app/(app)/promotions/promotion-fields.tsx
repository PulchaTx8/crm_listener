'use client';

import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { Input, Select } from '@/components/ui/input';
import { ImageUploadField } from '@/components/media/image-upload-field';
import type { PromotionDetail } from '@/services/promotions';
import type { ShowOption } from '@/services/shows';
import { fromZonedWallClock, toZonedDateTime } from './zone';

export interface ShowSelectOption {
  id: string;
  label: string;
}

/**
 * Final review, C1. The combobox's own option list, `shows` plus (sometimes)
 * one more entry the caller cannot otherwise choose.
 *
 * `record.showId` is not always among `shows`: every caller who holds
 * promotions.edit without music.view gets `shows: []` from `listShowOptions`
 * (shows_select_music_view, 0099:55-57, has no owner exception), and an
 * archived Programme is unlisted for every caller, owner included (D3a,
 * found during this task). A native `<select>` whose `defaultValue` names no
 * option among its children falls back to the FIRST one — here, "No
 * programme" — and posting that on a save about something else entirely (the
 * closing date, say) is what update_promotion's wholesale replace
 * (0259:320) turns into a silent null. Appending an option that carries
 * `record.showId` is what gives the browser something to land on instead.
 *
 * A pure function rather than inline JSX so it can be proven without a DOM
 * (this project's unit tests run in vitest's `node` environment — see
 * `nextRecordAfterFailedRead` in `promotion-record-dialog.tsx` for the same
 * shape of reasoning): a static-markup render was tried first and does show
 * the right `<option>` gaining `selected`, but that only proves what THIS
 * function already decides, one layer down and with heavier fixtures.
 *
 * `fallbackLabel` is shown instead of a name in exactly the case that
 * matters: the embed `shows(name, deleted_at)` goes through the same policy
 * as the list, so `record.showName` is null for the one caller who needs
 * this entry at all.
 */
export function resolveShowOptions(
  shows: ShowOption[],
  record: Pick<PromotionDetail, 'showId' | 'showName'> | null,
  fallbackLabel: string,
): ShowSelectOption[] {
  const options: ShowSelectOption[] = shows.map((show) => ({ id: show.id, label: show.name }));
  if (record?.showId && !shows.some((show) => show.id === record.showId)) {
    options.push({ id: record.showId, label: record.showName ?? fallbackLabel });
  }
  return options;
}

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
  shows,
}: {
  record: PromotionDetail | null;
  timeZone: string;
  disabled: boolean;
  repeats: boolean;
  onRepeatsChange: (next: boolean) => void;
  onDirty: () => void;
  /**
   * The promotion's own Station's live Programmes (item 17) — read by the
   * page that already resolves that Station for the list behind this form,
   * and passed down rather than looked up again here. See `promotions/page.tsx`
   * and `promotion-record-dialog.tsx`'s own `companyId` prop for the same
   * "the Station is already in scope, do not re-resolve it" reasoning.
   */
  shows: ShowOption[];
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

        {/* Item 10. This cell held a spacer that existed only to keep the
            two-column grid aligned after Site integration code; the field the
            owner asked for goes exactly where the spacer was, which is what
            "to the right of Site integration code" means in a two-column grid. */}
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted-foreground">{t('authorizationCertificate')}</span>
          <Input
            name="authorizationCertificate"
            maxLength={60}
            defaultValue={record?.authorizationCertificate ?? ''}
            disabled={disabled}
            data-testid="promotion-certificate"
          />
          <span className="text-xs text-muted-foreground">{t('optionalAsIssued')}</span>
        </label>

        {/* Item 17. Its own full-width row directly under the certificate —
            the grid is only two columns, and the cell truly beside the
            certificate does not exist; the alternative (falling into row 3
            col 1 as the next item in source order) would have shoved Starts
            into col 2 of that same row and stranded Ends alone below it,
            breaking a pairing nothing in this task asked to change. NO
            ARCHIVED OPTION, and D3a of the spec says why: an archived
            Programme cannot be read at all. `shows_select_music_view`
            (0099:55-57) is `deleted_at is null and has_permission(...)` with
            no owner exception -- unlike promotions' own policy (0044:47) --
            so the embed returns null and the name never arrives. Nothing in
            the codebase sets `shows.deleted_at` either. A branch rendering
            "archived" here would be dead code that reads as a working
            feature. */}
        <label className="flex flex-col gap-1 text-sm sm:col-span-2">
          <span className="text-muted-foreground">{t('programme')}</span>
          <Select
            name="showId"
            defaultValue={record?.showId ?? ''}
            disabled={disabled}
            data-testid="promotion-show"
          >
            <option value="">{t('noProgramme')}</option>
            {/* Final review, C1. `resolveShowOptions` (above) appends the
                linked Programme when `shows` does not carry it -- a member
                holding promotions.edit without music.view, or a Programme
                D3a already found archived out of this list for everyone --
                so `defaultValue` above always names something the browser can
                select, and an unrelated save (the closing date, say) never
                falls back to "No programme" and nulls show_id through
                update_promotion's wholesale replace (0259:320). The select
                stays enabled throughout: an operator who can see Programmes
                still has "No programme" to clear the link on purpose. */}
            {resolveShowOptions(
              shows,
              record,
              t('aProgrammeIsLinkedThisOperatorCannotSeeProgrammes'),
            ).map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </Select>
        </label>

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
            times and occupy five hundred places in the draw.

            Item 16. One `flex-wrap` row for both this field and the ceiling
            beside it, replacing what used to be two separate `{repeats && …}`
            guards stacked in the enclosing `flex-col` box — `flex-wrap` so the
            two `w-64` fields drop to two rows on a narrow screen rather than
            overflowing it. */}
        {repeats && (
          <div className="flex flex-wrap gap-4">
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
          </div>
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
