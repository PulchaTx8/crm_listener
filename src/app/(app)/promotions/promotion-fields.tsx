'use client';

import { useState } from 'react';
import { Input, Textarea } from '@/components/ui/input';
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
  // The visible inputs speak the Station's wall-clock; the hidden ones beside
  // them carry the instant the action parses. Two fields rather than a
  // conversion on the server, because only the browser knows which Station's
  // zone was on screen when the operator typed — and shipping the wall-clock
  // alone would let a Station switch between render and submit reinterpret it.
  const [startsLocal, setStartsLocal] = useState(toZonedDateTime(record?.startsAt, timeZone));
  const [endsLocal, setEndsLocal] = useState(toZonedDateTime(record?.endsAt, timeZone));

  return (
    <div className="flex flex-col gap-5" onInput={onDirty} onChange={onDirty}>
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-sm sm:col-span-2">
          <span className="text-muted-foreground">Promotion</span>
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
          <span className="text-muted-foreground">Site integration code</span>
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
            How the Station&apos;s own website refers to this promotion. Optional, and no two live
            promotions here may share one.
          </span>
        </label>

        <div className="hidden sm:block" aria-hidden="true" />

        {/* Both instants are typed and read in the STATION's timezone, which is
            the one the promotion actually runs in — an operator in another
            state reading their own local time would see a window an hour off
            from the one the bot enforces. */}
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted-foreground">Starts</span>
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
          <span className="text-muted-foreground">Ends</span>
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
          Times are this Station&apos;s local time ({timeZone}).
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
          <span>Allow more than one entry per listener</span>
        </label>

        {/* Shown only when repetition is on, and required then. Unticked, the
            promotion takes one entry per listener for its whole run; ticked
            with no interval, one person could send the hashtag five hundred
            times and occupy five hundred places in the draw. */}
        {repeats && (
          <label className="flex w-64 flex-col gap-1 text-sm">
            <span className="text-muted-foreground">At least this many hours apart</span>
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
          Require the right answer to take part
          <span className="block text-xs text-muted-foreground">
            Applies to quiz questions only. Off, a wrong answer is recorded and the listener still
            goes into the draw.
          </span>
        </span>
      </label>

      <label className="flex flex-col gap-1 text-sm">
        <span className="text-muted-foreground">Call to action</span>
        <Textarea
          name="callToAction"
          rows={3}
          maxLength={2000}
          defaultValue={record?.callToAction ?? ''}
          disabled={disabled}
          data-testid="promotion-call-to-action"
        />
      </label>
    </div>
  );
}
