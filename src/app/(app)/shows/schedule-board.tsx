'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { Route } from 'next';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { SHOW_KINDS } from '@/schemas/shows';
import { useRecordDialog } from '@/hooks/use-record-dialog';
import { SHOW_TABS } from '@/lib/record-params';
import { SHOW_LIST_MAX } from '@/lib/shows/limits';
import { WEEKDAY_LABEL_KEYS } from '@/lib/shows/weekday-labels';
import { shiftWeek, type GridBlock, type WeekDay } from '@/lib/shows/week-grid';
import { showHref } from './list-params';
import type { ShowListState } from './list-params';
import { ShowRecordDialog } from './show-record-dialog';

/**
 * Block 30e, item 12. The week, drawn.
 *
 * A CLIENT COMPONENT, for one reason worth stating: it owns the record dialog,
 * exactly as `ShowsGrid` does. A block that opens a programme has to open the
 * SAME dialog the list opens, and that dialog is driven by `useRecordDialog`.
 * Everything this file draws was computed on the server by a pure module
 * (`@/lib/shows/week-grid`) — no date is derived here.
 *
 * THE NOW-LINE IS THE ONLY THING THAT MOVES, and it is positioned from the minute
 * THE SERVER read in the STATION's zone, ticking forward locally from there.
 * Reading the browser's own clock would put the line where the operator is rather
 * than where the Station is — the trap `shows_on_air` (0175) documents on itself:
 * against a bare clock a schedule passes every suite run in the afternoon and is
 * wrong at 21:00.
 */
const HOURS = Array.from({ length: 24 }, (_, hour) => hour);
const MINUTES_IN_DAY = 1440;

/**
 * D5. One colour per kind, keyed by enum value rather than by position in a
 * result, so two loads of one week paint the same picture. Both halves of each
 * pair are stated, because a background with an inherited foreground is a block
 * that reads white-on-yellow in one theme.
 */
const KIND_CLASS: Record<string, string> = {
  MUSICAL: 'bg-sky-600 text-white',
  NEWS: 'bg-amber-500 text-black',
  TALK_SHOW: 'bg-violet-600 text-white',
  SPORTS: 'bg-emerald-600 text-white',
  ENTERTAINMENT: 'bg-rose-600 text-white',
};

/** The four programmes that predate Block 18 carry no kind, and the legend names that state too. */
const NO_KIND_CLASS = 'bg-muted text-foreground';

export function ScheduleBoard({
  blocks,
  days,
  state,
  manage,
  initialRecord,
  capped,
  nowMinutes,
  todayDate,
}: {
  blocks: GridBlock[];
  days: WeekDay[];
  /** Carries the week actually drawn, so every arrow and every filter link agrees with the picture. */
  state: ShowListState;
  manage: boolean;
  initialRecord: { recordId: string | null; tab: string | null };
  capped: boolean;
  /** Minutes since the Station's midnight, or null when the week on screen is not the Station's current week. */
  nowMinutes: number | null;
  /** The date to mark as today, in the Station's zone — null when it falls outside this week. */
  todayDate: string | null;
}) {
  const t = useTranslations('shows');
  const router = useRouter();
  const { recordId, open, close } = useRecordDialog(SHOW_TABS, initialRecord);

  // Ticks forward from the server's reading rather than re-deriving the time, so
  // the line cannot drift into the browser's zone between renders.
  const [minutes, setMinutes] = useState(nowMinutes);
  useEffect(() => setMinutes(nowMinutes), [nowMinutes]);
  useEffect(() => {
    if (nowMinutes === null) return;
    const timer = setInterval(
      () => setMinutes((current) => (current === null ? null : Math.min(current + 1, MINUTES_IN_DAY))),
      60_000,
    );
    return () => clearInterval(timer);
  }, [nowMinutes]);

  const week = state.week ?? '';

  return (
    <>
      <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Link
            href={showHref({ ...state, week: shiftWeek(week, -1) }) as Route}
            aria-label={t('theWeekBefore')}
            data-testid="shows-week-previous"
            className="rounded-md border p-1.5 hover:bg-accent"
          >
            <ChevronLeft className="size-4" aria-hidden="true" />
          </Link>
          <Link
            href={showHref({ ...state, week: undefined }) as Route}
            data-testid="shows-week-today"
            className="rounded-md border px-3 py-1.5 text-sm hover:bg-accent"
          >
            {t('thisWeek')}
          </Link>
          <Link
            href={showHref({ ...state, week: shiftWeek(week, 1) }) as Route}
            aria-label={t('theWeekAfter')}
            data-testid="shows-week-next"
            className="rounded-md border p-1.5 hover:bg-accent"
          >
            <ChevronRight className="size-4" aria-hidden="true" />
          </Link>
          <p className="text-sm text-muted-foreground" data-testid="shows-week-range">
            {days[0]?.date} → {days[6]?.date}
          </p>
        </div>
        {/* D4, said on the screen. An operator who ticked "show ended programmes"
            on the list and switched here must not be left wondering why the tick
            changed nothing: the grid answers a question about DATES, and a past
            week drawn without the programmes that ended since would be a false
            picture of that week. */}
        <p className="text-xs text-muted-foreground" data-testid="shows-week-note">
          {t('theWeekShowsWhatAired')}
        </p>
      </div>

      {capped && (
        <p className="mt-2 text-sm text-muted-foreground" data-testid="shows-week-capped">
          {t('showingTheFirstProgrammes', { count: SHOW_LIST_MAX })}
        </p>
      )}

      <div className="mt-4 overflow-x-auto rounded-lg border" data-testid="shows-week">
        <div className="grid min-w-[56rem] grid-cols-[4rem_repeat(7,1fr)]">
          <div className="border-b border-r bg-muted/40 p-2 text-xs text-muted-foreground">
            {t('hour')}
          </div>
          {days.map((day) => (
            <div
              key={day.date}
              className={`border-b border-r p-2 text-center text-xs last:border-r-0 ${
                day.date === todayDate ? 'bg-accent font-semibold' : 'text-muted-foreground'
              }`}
              data-testid="shows-week-day"
            >
              {t(WEEKDAY_LABEL_KEYS[day.weekday] ?? 'monday')} {day.date.slice(8)}
            </div>
          ))}

          <div className="border-r">
            {HOURS.map((hour) => (
              <div key={hour} className="h-12 border-b px-2 text-[10px] text-muted-foreground">
                {String(hour).padStart(2, '0')}:00
              </div>
            ))}
          </div>

          {days.map((day) => (
            <div key={day.date} className="relative border-r last:border-r-0">
              {HOURS.map((hour) => (
                <div key={hour} className="h-12 border-b" />
              ))}

              {day.date === todayDate && minutes !== null && (
                <div
                  className="pointer-events-none absolute inset-x-0 z-10 border-t-2 border-red-500"
                  style={{ top: `${(minutes / MINUTES_IN_DAY) * 100}%` }}
                  data-testid="shows-week-now"
                  aria-hidden="true"
                />
              )}

              {blocks
                .filter((block) => block.date === day.date)
                .map((block) => (
                  <button
                    key={block.key}
                    type="button"
                    onClick={() => open(block.showId)}
                    data-testid="show-block"
                    title={`${block.showName} · ${block.bandLabel}`}
                    className={`absolute inset-x-1 overflow-hidden rounded px-1 py-0.5 text-left text-[10px] leading-tight ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 ${
                      (block.kind ? KIND_CLASS[block.kind] : undefined) ?? NO_KIND_CLASS
                    }`}
                    style={{ top: `${block.topPercent}%`, height: `${block.heightPercent}%` }}
                  >
                    <span className="block truncate font-medium">{block.showName}</span>
                    <span className="block truncate">{block.bandLabel}</span>
                  </button>
                ))}
            </div>
          ))}
        </div>
      </div>

      {blocks.length === 0 && (
        <p className="mt-3 text-sm text-muted-foreground" data-testid="shows-week-empty">
          {t('nothingIsScheduledThisWeek')}
        </p>
      )}

      {/* D5. A colour with no legend is decoration. */}
      <div className="mt-3 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
        {SHOW_KINDS.map((kind) => (
          <span key={kind} className="flex items-center gap-1">
            <span className={`inline-block size-3 rounded ${KIND_CLASS[kind]}`} aria-hidden="true" />
            {t(`kind_${kind}`)}
          </span>
        ))}
        <span className="flex items-center gap-1">
          <span className={`inline-block size-3 rounded border ${NO_KIND_CLASS}`} aria-hidden="true" />
          {t('noKindRecorded')}
        </span>
      </div>

      {/*
        The same dialog the list opens, reached the same way — and the ONE place
        this view departs from `ShowsGrid`. The list patches the saved row in
        place; a week cannot, because a saved schedule can move a block to
        another hour or another DAY, which is a re-layout rather than a row edit.
        `save_show` writes no `revalidatePath` (see ./actions.ts), so the refresh
        is asked for here: without it the grid would keep drawing the schedule
        that was replaced.
      */}
      <ShowRecordDialog
        open={recordId !== null}
        recordId={recordId}
        companyId={state.companyId}
        manage={manage}
        onClose={close}
        onSaved={() => {
          close();
          router.refresh();
        }}
      />
    </>
  );
}
