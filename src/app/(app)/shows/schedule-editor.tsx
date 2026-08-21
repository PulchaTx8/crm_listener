'use client';

import { useTranslations } from 'next-intl';
import { Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { isOvernight, type Band } from '@/lib/shows/bands';
import { WEEKDAY_LABEL_KEYS } from '@/lib/shows/weekday-labels';

/**
 * Block 18. The weekly schedule, edited as the operator describes it: a list of
 * bands, each a set of days and a pair of times.
 *
 * "De segunda a sexta 10:00 às 12:30, sábados e domingos 13:20 às 15:20" is two
 * bands, and that is exactly what this holds. `save_show` expands each into one
 * row per day and splits any that crosses midnight; `toBands` puts them back
 * together for this editor to show.
 *
 * AN END EARLIER THAN A START IS NOT AN ERROR HERE. It is how a station writes
 * a programme that runs past midnight, and the hint says so rather than the
 * field refusing it — the whole overnight machinery downstream exists to make
 * this the natural thing to type.
 */

/** ISO, so the values match `extract(isodow from …)` with nothing to convert. */
const WEEKDAYS = [1, 2, 3, 4, 5, 6, 7] as const;

export function ScheduleEditor({
  bands,
  onChange,
  disabled,
}: {
  bands: Band[];
  onChange: (next: Band[]) => void;
  disabled: boolean;
}) {
  const t = useTranslations('shows');

  const update = (index: number, patch: Partial<Band>) => {
    onChange(bands.map((band, i) => (i === index ? { ...band, ...patch } : band)));
  };

  const toggleDay = (index: number, day: number) => {
    const band = bands[index];
    if (!band) return;
    const days = band.days.includes(day)
      ? band.days.filter((d) => d !== day)
      : [...band.days, day].sort((a, b) => a - b);
    update(index, { days });
  };

  return (
    <fieldset className="flex flex-col gap-3" data-testid="show-schedule">
      <legend className="text-sm text-muted-foreground">{t('schedule')}</legend>

      {bands.length === 0 && (
        <p className="text-sm text-muted-foreground">{t('aProgrammeNeedsAtLeastOneBand')}</p>
      )}

      {bands.map((band, index) => (
        <div key={index} className="flex flex-col gap-2 rounded-md border p-3" data-testid="show-band">
          <div className="flex flex-wrap gap-2">
            {WEEKDAYS.map((day) => (
              <label key={day} className="flex items-center gap-1 text-sm">
                <input
                  type="checkbox"
                  checked={band.days.includes(day)}
                  onChange={() => toggleDay(index, day)}
                  disabled={disabled}
                  className="h-4 w-4 rounded border-input"
                  data-testid={`show-band-${index}-day-${day}`}
                />
                <span>{t(WEEKDAY_LABEL_KEYS[day] ?? 'monday')}</span>
              </label>
            ))}
          </div>

          <div className="flex flex-wrap items-end gap-2">
            <label className="flex flex-col gap-1 text-xs">
              {t('from')}
              <Input
                type="time"
                value={band.starts}
                onChange={(e) => update(index, { starts: e.target.value })}
                disabled={disabled}
                className="w-32"
                data-testid={`show-band-${index}-starts`}
              />
            </label>
            <label className="flex flex-col gap-1 text-xs">
              {t('to')}
              <Input
                type="time"
                value={band.ends}
                onChange={(e) => update(index, { ends: e.target.value })}
                disabled={disabled}
                className="w-32"
                data-testid={`show-band-${index}-ends`}
              />
            </label>
            <Button
              type="button"
              variant="outline"
              onClick={() => onChange(bands.filter((_, i) => i !== index))}
              disabled={disabled}
              aria-label={t('removeThisBand')}
              data-testid={`show-band-${index}-remove`}
            >
              <Trash2 className="size-4" aria-hidden="true" />
            </Button>
          </div>

          {isOvernight(band) && (
            <p className="text-xs text-muted-foreground" data-testid={`show-band-${index}-overnight`}>
              {t('thisBandRunsPastMidnight')}
            </p>
          )}
        </div>
      ))}

      <div>
        <Button
          type="button"
          variant="outline"
          onClick={() => onChange([...bands, { days: [], starts: '', ends: '' }])}
          disabled={disabled}
          data-testid="show-band-add"
        >
          <Plus className="mr-1 size-4" aria-hidden="true" />
          {t('addABand')}
        </Button>
      </div>
    </fieldset>
  );
}
