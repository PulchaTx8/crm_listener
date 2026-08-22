'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Select } from '@/components/ui/input';

/**
 * Block 31a, D4. A day and a month, with no year anywhere.
 *
 * HTML has no day-and-month control. Block 30b used `<input type="date">` with a
 * fixed placeholder year that the code sliced off — which works, and puts a year
 * on the screen that the filter ignores, which is the owner's own complaint.
 *
 * THE VALUE IS STILL `MM-DD`, the shape `bfrom` and `bto` have carried since
 * Block 30b, so this is a change of control and not of vocabulary: a link pasted
 * yesterday means today what it meant then.
 *
 * EVERY MONTH OFFERS 31 DAYS, deliberately. This is a filter BOUND, not a date:
 * `birth_md` holds nothing between 0931 and 1001, so a 31 September bound
 * narrows to exactly the set a 30 September one does. Shortening the day list
 * per month would make it change under the operator's hand every time they
 * changed the month, to prevent an input that already means nothing.
 */
const DAYS = Array.from({ length: 31 }, (_, index) => String(index + 1).padStart(2, '0'));
const MONTHS = Array.from({ length: 12 }, (_, index) => String(index + 1).padStart(2, '0'));

/** The catalogue keys for the months, in order. */
const MONTH_LABEL_KEYS = [
  'monthJanuary',
  'monthFebruary',
  'monthMarch',
  'monthApril',
  'monthMay',
  'monthJune',
  'monthJuly',
  'monthAugust',
  'monthSeptember',
  'monthOctober',
  'monthNovember',
  'monthDecember',
] as const;

/**
 * `MM-DD` into its two halves, or two empty strings.
 *
 * Anything that is not exactly two digits, a hyphen and two digits comes back
 * empty rather than being repaired: a hand-edited URL is hostile input, and a
 * select whose value matches no option renders blank in one browser and picks
 * the first option in another.
 */
export function splitMonthDay(value: string | undefined): { month: string; day: string } {
  if (!value || !/^\d{2}-\d{2}$/.test(value)) return { month: '', day: '' };
  const [month = '', day = ''] = value.split('-');
  return { month, day };
}

/** Undefined until both halves are chosen: half a date is not a bound. */
export function joinMonthDay(month: string, day: string): string | undefined {
  if (!month || !day) return undefined;
  return `${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
}

export function MonthDayFields({
  label,
  value,
  onChange,
  testId,
}: {
  label: string;
  /** `MM-DD`, or undefined for "no bound at this end". */
  value: string | undefined;
  onChange: (monthDay: string | undefined) => void;
  testId: string;
}) {
  const t = useTranslations('members');

  /**
   * HALF A CHOICE HAS TO LIVE SOMEWHERE, and the URL cannot hold it.
   *
   * `bfrom` carries `MM-DD` or nothing — there is no shape for "December, day
   * not yet chosen". So the two selects keep their own state: without it,
   * picking the day sends nothing (correctly — half a date is not a bound),
   * and picking the month a moment later reads a day that was never
   * remembered, so the bound never forms and the list never narrows. Measured,
   * not reasoned: the journey failed on exactly that.
   *
   * Resynced from the prop, because back and forward are navigations this
   * component did not cause — the same rule the registered boxes beside it
   * follow, for the same reason.
   */
  const [chosen, setChosen] = useState(() => splitMonthDay(value));
  useEffect(() => setChosen(splitMonthDay(value)), [value]);

  function choose(next: { month: string; day: string }) {
    setChosen(next);
    onChange(joinMonthDay(next.month, next.day));
  }

  return (
    <label className="flex w-48 flex-col gap-1 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="flex gap-1">
        <Select
          value={chosen.day}
          onChange={(e) => choose({ month: chosen.month, day: e.target.value })}
          aria-label={`${label} — ${t('day')}`}
          data-testid={`${testId}-day`}
        >
          <option value="">{t('day')}</option>
          {DAYS.map((eachDay) => (
            <option key={eachDay} value={eachDay}>
              {eachDay}
            </option>
          ))}
        </Select>
        <Select
          value={chosen.month}
          onChange={(e) => choose({ month: e.target.value, day: chosen.day })}
          aria-label={`${label} — ${t('month')}`}
          data-testid={`${testId}-month`}
        >
          <option value="">{t('month')}</option>
          {MONTHS.map((eachMonth, index) => (
            <option key={eachMonth} value={eachMonth}>
              {t(MONTH_LABEL_KEYS[index] ?? 'monthJanuary')}
            </option>
          ))}
        </Select>
      </span>
    </label>
  );
}
