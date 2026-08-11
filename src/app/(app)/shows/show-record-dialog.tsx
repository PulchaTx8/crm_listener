'use client';

import { useActionState, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Input, Select } from '@/components/ui/input';
import { SHOW_AGE_RATINGS, SHOW_KINDS } from '@/schemas/shows';
import type { Band } from '@/lib/shows/bands';
import type { ShowSummary } from '@/services/shows';
import { SHOW_FORM_IDLE, endShowAction, saveShowAction } from './actions';
import { ScheduleEditor } from './schedule-editor';

/**
 * Block 18. The programme's record, on the shape of `song-record-dialog.tsx`:
 * a popup over the list, saving through a server action and handing the saved
 * row back so the grid can patch it without re-reading the page.
 *
 * THERE IS NO DELETE, and its absence is D8 rather than an omission. The only
 * way a programme leaves circulation is Encerrar, which asks for a date — a
 * record with relationships is archived, and `shows` has no cascade on anything
 * pointing at it, so a delete would be refused by the database anyway.
 */
export function ShowRecordDialog({
  companyId,
  record,
  onClose,
  onSaved,
}: {
  companyId: string;
  record: ShowSummary | null;
  onClose: () => void;
  onSaved: (show: ShowSummary) => void;
}) {
  const t = useTranslations('shows');
  const [state, save, saving] = useActionState(saveShowAction, SHOW_FORM_IDLE);
  const [ending, endAction, endingPending] = useActionState(endShowAction, SHOW_FORM_IDLE);
  const [bands, setBands] = useState<Band[]>(record?.bands ?? []);
  const [askingEnd, setAskingEnd] = useState(false);

  useEffect(() => {
    if (state.status === 'saved' && state.record) onSaved(state.record);
  }, [state, onSaved]);

  useEffect(() => {
    if (ending.status === 'saved' && ending.record) onSaved(ending.record);
  }, [ending, onSaved]);

  const problem = state.status === 'error' ? state.message : ending.status === 'error' ? ending.message : null;

  return (
    <div className="rounded-lg border bg-card p-4 text-card-foreground shadow-sm" data-testid="show-dialog">
      <form action={save} className="flex flex-col gap-4">
        <input type="hidden" name="companyId" value={companyId} />
        {record && <input type="hidden" name="showId" value={record.id} />}
        {/* The bands travel as one JSON field: the editor holds objects and
            save_show takes objects, so a form encoding in between would be a
            third representation of the same thing to keep in step. */}
        <input type="hidden" name="bands" value={JSON.stringify(bands)} />

        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted-foreground">{t('name')}</span>
          <Input
            name="name"
            defaultValue={record?.name ?? ''}
            maxLength={200}
            required
            disabled={saving}
            data-testid="show-name"
          />
        </label>

        <div className="grid gap-4 sm:grid-cols-2">
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-muted-foreground">{t('kind')}</span>
            <Select name="kind" defaultValue={record?.kind ?? ''} required disabled={saving} data-testid="show-kind">
              <option value="" disabled>
                {t('chooseAKind')}
              </option>
              {SHOW_KINDS.map((kind) => (
                <option key={kind} value={kind}>
                  {t(`kind_${kind}`)}
                </option>
              ))}
            </Select>
          </label>

          <label className="flex flex-col gap-1 text-sm">
            <span className="text-muted-foreground">{t('ageRating')}</span>
            <Select
              name="ageRating"
              defaultValue={record?.ageRating ?? ''}
              required
              disabled={saving}
              data-testid="show-age-rating"
            >
              <option value="" disabled>
                {t('chooseAnAgeRating')}
              </option>
              {SHOW_AGE_RATINGS.map((rating) => (
                <option key={rating} value={rating}>
                  {t(`age_${rating}`)}
                </option>
              ))}
            </Select>
          </label>

          <label className="flex flex-col gap-1 text-sm">
            <span className="text-muted-foreground">{t('presenter')}</span>
            <Input
              name="presenterName"
              defaultValue={record?.presenterName ?? ''}
              maxLength={200}
              disabled={saving}
              data-testid="show-presenter"
            />
          </label>

          <label className="flex flex-col gap-1 text-sm">
            <span className="text-muted-foreground">{t('producer')}</span>
            <Input
              name="producerName"
              defaultValue={record?.producerName ?? ''}
              maxLength={200}
              disabled={saving}
              data-testid="show-producer"
            />
          </label>

          <label className="flex flex-col gap-1 text-sm">
            <span className="text-muted-foreground">{t('startsOn')}</span>
            <Input
              type="date"
              name="startsOn"
              defaultValue={record?.startsOn ?? ''}
              required
              disabled={saving}
              data-testid="show-starts-on"
            />
          </label>

          <label className="flex flex-col gap-1 text-sm">
            <span className="text-muted-foreground">{t('endsOn')}</span>
            <Input
              type="date"
              name="endsOn"
              defaultValue={record?.endsOn ?? ''}
              disabled={saving}
              data-testid="show-ends-on"
            />
            {/* D7: empty is the indeterminate case, and the hint says so rather
                than leaving an operator to wonder whether they forgot it. */}
            <span className="text-xs text-muted-foreground">{t('leaveEmptyWhileItIsOnAir')}</span>
          </label>
        </div>

        <ScheduleEditor bands={bands} onChange={setBands} disabled={saving} />

        {problem && (
          <p className="text-sm text-destructive" data-testid="show-error">
            {problem}
          </p>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" disabled={saving} data-testid="show-save">
            {saving ? t('saving') : t('save')}
          </Button>
          <Button type="button" variant="outline" onClick={onClose} disabled={saving}>
            {t('close')}
          </Button>
          {record && !askingEnd && (
            <Button
              type="button"
              variant="outline"
              onClick={() => setAskingEnd(true)}
              disabled={saving}
              data-testid="show-end"
            >
              {t('endThisProgramme')}
            </Button>
          )}
        </div>
      </form>

      {record && askingEnd && (
        <form action={endAction} className="mt-4 flex flex-wrap items-end gap-2 rounded-md border p-3">
          <input type="hidden" name="showId" value={record.id} />
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-muted-foreground">{t('endsOn')}</span>
            <Input type="date" name="endsOn" required disabled={endingPending} data-testid="show-end-date" />
          </label>
          <Button type="submit" disabled={endingPending} data-testid="show-end-confirm">
            {endingPending ? t('saving') : t('endThisProgramme')}
          </Button>
          <Button type="button" variant="outline" onClick={() => setAskingEnd(false)} disabled={endingPending}>
            {t('cancel')}
          </Button>
          <p className="w-full text-xs text-muted-foreground">{t('endingKeepsEveryPastLink')}</p>
        </form>
      )}
    </div>
  );
}
