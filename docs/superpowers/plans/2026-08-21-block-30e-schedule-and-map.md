# Block 30e Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver items 12, 18 and 19 of the owner's 19-item list — the Programmes week grid, the Participations window bounded by a Programme's band, and the map on the Promotions dashboard.

**Architecture:** Three independent slices sharing one existing foundation. The week grid is pure geometry over `show_schedules` rows the screen already reads, rendered by one client component that also owns the record dialog. The Programme window is a new SECURITY DEFINER door (because the Participations screen cannot read `shows`) plus pure band selection, resolved on the server into the `from`/`to` the list, the draw hat and the send-list filters already consume. The map is a fourth dashboard aggregate mirroring `0215`, rendered by the existing `GeographyPanel`.

**Tech Stack:** Next.js App Router (Server Components + Server Actions), TypeScript, Supabase/Postgres with RLS, next-intl, Vitest, Playwright, pgTAP.

**Spec:** `docs/superpowers/specs/2026-08-21-block-30e-schedule-and-map-design.md`

## Global Constraints

- **Branch:** `block-30e-schedule-and-map`, already created from `main` at `dd8135c`.
- **Migrations are sequential and immutable once merged:** this block adds `0269` and `0270` and edits no earlier file.
- **Every new function restates its grants in full** — `revoke execute … from public; grant execute … to authenticated;`. A function that loses its ACL is a defect this project has shipped twice.
- **Every `t('key')` must exist in all three catalogues** — `messages/en.json`, `messages/es.json`, `messages/pt.json`. `tests/unit/i18n/catalogue.test.ts` fails when they disagree; `tests/unit/i18n/usage.test.ts` fails when code reads a key no catalogue holds. next-intl renders the key itself when a message is missing, so nothing else catches it.
- **The e2e suite runs in `en-US`** (`playwright.config.ts`), so Playwright selectors must use the English strings.
- **Code, comments, docs and commit messages in English.** Conversation with the owner is in Portuguese.
- **Comments state what is true of the door in front of them**, per file. A truth generalised to a neighbouring door is the defect class this project has counted three ways.
- **Never cite a line number in a comment** — cite the symbol.
- **Do not run `npm run db:test` immediately after the e2e or isolation suites**: both leave rows behind and pgTAP reads two false reds from them. Run `npm run db:reset && npm run seed:branding` first.
- **After `npm run db:reset`, run `npm run seed:branding`**, or `login.spec.ts` fails on a 400 for the branding image.
- **Kill stray `next dev` processes before an e2e run.** A zombie holds port 3000 and ~2 GB, and Playwright workers then die with `STATUS_DLL_INIT_FAILED` (`code=3221225794`) — a failure whose *test names* look like application defects and whose error code is the only thing that says otherwise.

---

### Task 1: `bandsByMarker` — one reconstruction, two shapes

The week grid needs the band a `show_schedules` row belongs to, so it can label an
overnight tail `23:00–02:00` rather than `00:00–02:00`. `toBands` already computes
exactly that but throws the marker away. Expose the map it builds internally rather
than writing the reconstruction a second time.

**Files:**
- Modify: `src/lib/shows/bands.ts`
- Test: `tests/unit/show-bands.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `bandsByMarker(rows: ScheduleRow[]): Map<number, Band>`; `toBands(rows: ScheduleRow[]): Band[]` keeps its exact current behaviour and return order.

- [ ] **Step 1: Write the failing test**

Append to `tests/unit/show-bands.test.ts`:

```ts
describe('bandsByMarker', () => {
  it('keys each reconstructed band by the marker its rows carry', () => {
    const byMarker = bandsByMarker([
      { band: 1, weekday: 1, starts_at: '10:00:00', ends_at: '12:30:00' },
      { band: 1, weekday: 2, starts_at: '10:00:00', ends_at: '12:30:00' },
      { band: 2, weekday: 6, starts_at: '13:20:00', ends_at: '15:20:00' },
    ]);

    expect([...byMarker.keys()]).toEqual([1, 2]);
    expect(byMarker.get(1)).toEqual({ days: [1, 2], starts: '10:00', ends: '12:30' });
    expect(byMarker.get(2)).toEqual({ days: [6], starts: '13:20', ends: '15:20' });
  });

  it('gives an overnight head and its tail the same band, ending at the hour typed', () => {
    const byMarker = bandsByMarker([
      { band: 1, weekday: 5, starts_at: '23:00:00', ends_at: '24:00:00' },
      { band: 1, weekday: 6, starts_at: '00:00:00', ends_at: '02:00:00' },
    ]);

    // One band, not two: the 24:00 row is this schema's bookkeeping.
    expect(byMarker.size).toBe(1);
    expect(byMarker.get(1)).toEqual({ days: [5], starts: '23:00', ends: '02:00' });
  });

  it('agrees with toBands on the same rows', () => {
    const rows = [
      { band: 1, weekday: 5, starts_at: '23:00:00', ends_at: '24:00:00' },
      { band: 1, weekday: 6, starts_at: '00:00:00', ends_at: '02:00:00' },
      { band: 2, weekday: 3, starts_at: '08:00:00', ends_at: '09:00:00' },
    ];
    expect([...bandsByMarker(rows).values()]).toEqual(toBands(rows));
  });
});
```

Add `bandsByMarker` to the existing import from `@/lib/shows/bands` at the top of the file.

- [ ] **Step 2: Run it and watch it fail**

Run: `npm run test -- tests/unit/show-bands.test.ts`
Expected: FAIL — `bandsByMarker is not a function`.

- [ ] **Step 3: Implement it**

In `src/lib/shows/bands.ts`, rename the body of `toBands` into `bandsByMarker`, keying the
result instead of pushing to an array, and rebuild `toBands` on top of it:

```ts
/**
 * The bands of a schedule, keyed by the marker their rows carry.
 *
 * The reconstruction lives HERE rather than in `toBands` because two callers need
 * two different shapes of the same answer: the record dialog wants the bands in
 * order, and the week grid wants the band a given ROW belongs to, so it can label
 * an overnight tail with the hours the operator typed instead of with the 00:00
 * this schema splits at. A second reconstruction would be a second thing to keep
 * in step with `save_show`.
 */
export function bandsByMarker(rows: ScheduleRow[]): Map<number, Band> {
  const byMarker = new Map<number, ScheduleRow[]>();
  for (const row of rows) {
    const group = byMarker.get(row.band);
    if (group) group.push(row);
    else byMarker.set(row.band, [row]);
  }

  const bands = new Map<number, Band>();

  // Ordered by marker, so the caller that wants a list gets the bands in the
  // order they were added. A Map preserves insertion order, which is what makes
  // `toBands` below a projection rather than a second sort.
  for (const marker of [...byMarker.keys()].sort((a, b) => a - b)) {
    const group = byMarker.get(marker) ?? [];

    // ... the existing head/tail identification, unchanged, down to `overnightTail`

    bands.set(marker, {
      days: starting.map((row) => row.weekday).sort((a, b) => a - b),
      starts: toClock(first.starts_at),
      ends: toClock(overnightTail ? overnightTail.ends_at : first.ends_at),
    });
  }

  return bands;
}

export function toBands(rows: ScheduleRow[]): Band[] {
  return [...bandsByMarker(rows).values()];
}
```

Keep every existing comment inside the loop — the head/tail identification and the
`overnightTail` explanation are the two things that make this function correct, and
they belong where the code they explain is.

- [ ] **Step 4: Run the whole unit file, old cases included**

Run: `npm run test -- tests/unit/show-bands.test.ts`
Expected: PASS, including every case that existed before this task.

- [ ] **Step 5: Commit**

```bash
git add src/lib/shows/bands.ts tests/unit/show-bands.test.ts
git commit -m "refactor(30e): expose the band reconstruction by marker, so a row can name its own band"
```

---

### Task 2: The week grid's geometry, as a pure module

Everything the grid needs to be *correct* — which programme is drawn on which date,
where a block starts, how tall it is, what it is labelled — computed without a
browser, a database or a clock.

**Files:**
- Create: `src/lib/shows/week-grid.ts`
- Test: `tests/unit/week-grid.test.ts`

**Interfaces:**
- Consumes: `bandsByMarker`, `isOvernight`, `ScheduleRow`, `Band` from `@/lib/shows/bands` (Task 1).
- Produces:
  - `isoWeekStart(date: string): string` — the Monday of the ISO week containing `YYYY-MM-DD`.
  - `shiftWeek(monday: string, weeks: number): string`
  - `weekDays(monday: string): WeekDay[]` where `WeekDay = { date: string; weekday: number }` (ISO 1–7).
  - `minutesOfClock(time: string): number` — `'24:00:00'` is 1440.
  - `layOutWeek(shows: GridShow[], days: WeekDay[]): GridBlock[]`
  - `GridShow = { id: string; name: string; kind: string | null; startsOn: string | null; endsOn: string | null; schedules: ScheduleRow[] }`
  - `GridBlock = { key: string; showId: string; showName: string; kind: string | null; date: string; topPercent: number; heightPercent: number; bandLabel: string; overnight: boolean }`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/week-grid.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  isoWeekStart,
  layOutWeek,
  minutesOfClock,
  shiftWeek,
  weekDays,
  type GridShow,
} from '@/lib/shows/week-grid';

/** 2026-08-17 is a Monday; 2026-08-23 is the Sunday that closes its week. */
const MONDAY = '2026-08-17';

function show(over: Partial<GridShow> = {}): GridShow {
  return {
    id: 'show-1',
    name: 'Manhã Total',
    kind: 'MUSICAL',
    startsOn: null,
    endsOn: null,
    schedules: [],
    ...over,
  };
}

describe('the week the grid draws', () => {
  it('starts on Monday whichever day of the week it is handed', () => {
    expect(isoWeekStart('2026-08-17')).toBe('2026-08-17');
    expect(isoWeekStart('2026-08-19')).toBe('2026-08-17');
    // Sunday belongs to the week that STARTED, not to the one about to.
    expect(isoWeekStart('2026-08-23')).toBe('2026-08-17');
    expect(isoWeekStart('2026-08-24')).toBe('2026-08-24');
  });

  it('walks whole weeks in both directions, across a month boundary', () => {
    expect(shiftWeek(MONDAY, 1)).toBe('2026-08-24');
    expect(shiftWeek(MONDAY, -1)).toBe('2026-08-10');
    expect(shiftWeek('2026-08-31', 1)).toBe('2026-09-07');
  });

  it('numbers its days the way the schema does', () => {
    const days = weekDays(MONDAY);
    expect(days).toHaveLength(7);
    expect(days[0]).toEqual({ date: '2026-08-17', weekday: 1 });
    expect(days[6]).toEqual({ date: '2026-08-23', weekday: 7 });
  });

  it('reads the end-of-day the schema writes as the end of the day', () => {
    expect(minutesOfClock('00:00:00')).toBe(0);
    expect(minutesOfClock('10:30:00')).toBe(630);
    expect(minutesOfClock('24:00:00')).toBe(1440);
  });
});

describe('laying a programme over the week', () => {
  const days = weekDays(MONDAY);

  it('positions a band at its own hours', () => {
    const blocks = layOutWeek(
      [show({ schedules: [{ band: 1, weekday: 1, starts_at: '10:00:00', ends_at: '12:30:00' }] })],
      days,
    );

    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.date).toBe('2026-08-17');
    expect(blocks[0]?.topPercent).toBeCloseTo((600 / 1440) * 100, 6);
    expect(blocks[0]?.heightPercent).toBeCloseTo((150 / 1440) * 100, 6);
    expect(blocks[0]?.bandLabel).toBe('10:00–12:30');
    expect(blocks[0]?.overnight).toBe(false);
  });

  it('draws two blocks on a day that carries two bands', () => {
    const blocks = layOutWeek(
      [
        show({
          schedules: [
            { band: 1, weekday: 2, starts_at: '10:00:00', ends_at: '12:30:00' },
            { band: 2, weekday: 2, starts_at: '13:20:00', ends_at: '15:20:00' },
          ],
        }),
      ],
      days,
    );

    expect(blocks.map((b) => [b.date, b.bandLabel])).toEqual([
      ['2026-08-18', '10:00–12:30'],
      ['2026-08-18', '13:20–15:20'],
    ]);
  });

  it('draws an overnight band as two blocks, both labelled with the hours typed', () => {
    const blocks = layOutWeek(
      [
        show({
          schedules: [
            { band: 1, weekday: 5, starts_at: '23:00:00', ends_at: '24:00:00' },
            { band: 1, weekday: 6, starts_at: '00:00:00', ends_at: '02:00:00' },
          ],
        }),
      ],
      days,
    );

    expect(blocks).toHaveLength(2);
    // Friday night, from 23:00 to the foot of the column.
    expect(blocks[0]?.date).toBe('2026-08-21');
    expect(blocks[0]?.topPercent).toBeCloseTo((1380 / 1440) * 100, 6);
    expect(blocks[0]?.heightPercent).toBeCloseTo((60 / 1440) * 100, 6);
    // Saturday morning, from the head of the column to 02:00.
    expect(blocks[1]?.date).toBe('2026-08-22');
    expect(blocks[1]?.topPercent).toBe(0);
    // The label is the band, never the segment: 00:00–02:00 would read as a
    // different programme from the one that started the night before.
    expect(blocks.map((b) => b.bandLabel)).toEqual(['23:00–02:00', '23:00–02:00']);
    expect(blocks.every((b) => b.overnight)).toBe(true);
  });

  it('draws nothing before the run starts', () => {
    const blocks = layOutWeek(
      [
        show({
          startsOn: '2026-08-20',
          schedules: [
            { band: 1, weekday: 1, starts_at: '08:00:00', ends_at: '09:00:00' },
            { band: 1, weekday: 4, starts_at: '08:00:00', ends_at: '09:00:00' },
          ],
        }),
      ],
      days,
    );

    // Monday the 17th is before the run; Thursday the 20th is its first day.
    expect(blocks.map((b) => b.date)).toEqual(['2026-08-20']);
  });

  it('draws nothing after the run ends, and still draws the week it ended in', () => {
    const blocks = layOutWeek(
      [
        show({
          endsOn: '2026-08-19',
          schedules: [
            { band: 1, weekday: 2, starts_at: '08:00:00', ends_at: '09:00:00' },
            { band: 1, weekday: 3, starts_at: '08:00:00', ends_at: '09:00:00' },
            { band: 1, weekday: 4, starts_at: '08:00:00', ends_at: '09:00:00' },
          ],
        }),
      ],
      days,
    );

    // Tuesday and Wednesday aired; Thursday is past the end.
    expect(blocks.map((b) => b.date)).toEqual(['2026-08-18', '2026-08-19']);
  });

  it('orders blocks by day and then by hour, so two renders paint the same picture', () => {
    const blocks = layOutWeek(
      [
        show({ id: 'b', name: 'Tarde', schedules: [{ band: 1, weekday: 2, starts_at: '14:00:00', ends_at: '15:00:00' }] }),
        show({ id: 'a', name: 'Manhã', schedules: [{ band: 1, weekday: 2, starts_at: '08:00:00', ends_at: '09:00:00' }] }),
      ],
      days,
    );

    expect(blocks.map((b) => b.showName)).toEqual(['Manhã', 'Tarde']);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm run test -- tests/unit/week-grid.test.ts`
Expected: FAIL — the module does not exist.

- [ ] **Step 3: Implement the module**

Create `src/lib/shows/week-grid.ts`:

```ts
import { bandsByMarker, isOvernight, type ScheduleRow } from './bands';

/**
 * Block 30e, item 12. Where each band sits on a week, computed with no browser,
 * no database and no clock.
 *
 * ALL DATE ARITHMETIC IS ON `YYYY-MM-DD` STRINGS THROUGH UTC. A local `new
 * Date('2026-08-17')` is parsed as UTC midnight and then read back in the
 * machine's own zone, which in any zone west of Greenwich answers the 16th —
 * a week that starts on Sunday for half the world. The Station's zone decides
 * which DAY is today (that lives in the screen, beside `companies.timezone`);
 * this module only walks a calendar, and a calendar has no zone.
 */

/** One column of the grid: a real date, and the ISO weekday `show_schedules` stores. */
export interface WeekDay {
  date: string;
  /** 1 = Monday … 7 = Sunday, matching `extract(isodow …)`. */
  weekday: number;
}

/** One programme, with the schedule rows and the run bounds that decide where it is drawn. */
export interface GridShow {
  id: string;
  name: string;
  kind: string | null;
  startsOn: string | null;
  endsOn: string | null;
  schedules: ScheduleRow[];
}

/** One drawn rectangle: one `show_schedules` row on one date. */
export interface GridBlock {
  key: string;
  showId: string;
  showName: string;
  kind: string | null;
  date: string;
  /** Percentages of the day, so the column can be any height the layout wants. */
  topPercent: number;
  heightPercent: number;
  /**
   * The whole band as the operator typed it — `23:00–02:00` on BOTH halves of an
   * overnight band. The segment's own hours are this schema's bookkeeping.
   */
  bandLabel: string;
  overnight: boolean;
}

const MINUTES_IN_DAY = 1440;
const MS_IN_DAY = 86_400_000;

function asUtc(date: string): Date {
  return new Date(`${date}T00:00:00.000Z`);
}

function asDate(at: Date): string {
  return at.toISOString().slice(0, 10);
}

/** 1 = Monday … 7 = Sunday. `getUTCDay` counts Sunday as 0, which is the other convention. */
function isoWeekday(date: string): number {
  const day = asUtc(date).getUTCDay();
  return day === 0 ? 7 : day;
}

export function isoWeekStart(date: string): string {
  return asDate(new Date(asUtc(date).getTime() - (isoWeekday(date) - 1) * MS_IN_DAY));
}

export function shiftWeek(monday: string, weeks: number): string {
  return asDate(new Date(asUtc(monday).getTime() + weeks * 7 * MS_IN_DAY));
}

export function weekDays(monday: string): WeekDay[] {
  return Array.from({ length: 7 }, (_, i) => {
    const date = asDate(new Date(asUtc(monday).getTime() + i * MS_IN_DAY));
    return { date, weekday: isoWeekday(date) };
  });
}

/** Postgres writes the end of a day as `24:00:00`, which is 1440 and not zero. */
export function minutesOfClock(time: string): number {
  const [hours = '0', minutes = '0'] = time.split(':');
  return Number(hours) * 60 + Number(minutes);
}

/**
 * Whether a programme is on the air on a given DATE — the same rule
 * `shows_on_air` (0175) applies, deliberately: run bounds inclusive at both
 * ends, and the schedule consulted per weekday. It means the small hours of the
 * morning after a run's last day are not drawn, which is what that function
 * answers too, and one rule that two readers share beats two that nearly agree.
 */
function running(show: GridShow, date: string): boolean {
  if (show.startsOn && show.startsOn > date) return false;
  if (show.endsOn && show.endsOn < date) return false;
  return true;
}

export function layOutWeek(shows: GridShow[], days: WeekDay[]): GridBlock[] {
  const blocks: GridBlock[] = [];

  for (const show of shows) {
    const bands = bandsByMarker(show.schedules);

    for (const day of days) {
      if (!running(show, day.date)) continue;

      for (const row of show.schedules) {
        if (row.weekday !== day.weekday) continue;

        const band = bands.get(row.band);
        // A row whose marker reconstructed to nothing is a row `toBands`
        // identified as an overnight TAIL of a band drawn elsewhere; it is still
        // drawn, and it borrows its label from the head it belongs to.
        const label = band ? `${band.starts}–${band.ends}` : null;

        const start = minutesOfClock(row.starts_at);
        const end = minutesOfClock(row.ends_at);
        if (end <= start) continue;

        blocks.push({
          key: `${show.id}:${day.date}:${row.band}:${row.starts_at}`,
          showId: show.id,
          showName: show.name,
          kind: show.kind,
          date: day.date,
          topPercent: (start / MINUTES_IN_DAY) * 100,
          heightPercent: ((end - start) / MINUTES_IN_DAY) * 100,
          bandLabel: label ?? `${row.starts_at.slice(0, 5)}–${row.ends_at.slice(0, 5)}`,
          overnight: band ? isOvernight(band) : false,
        });
      }
    }
  }

  // Deterministic, so two loads of one week paint the same picture: by day, then
  // by hour, then by name for two programmes starting at the same minute.
  return blocks.sort(
    (a, b) =>
      a.date.localeCompare(b.date) ||
      a.topPercent - b.topPercent ||
      a.showName.localeCompare(b.showName),
  );
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `npm run test -- tests/unit/week-grid.test.ts`
Expected: PASS, all cases.

- [ ] **Step 5: Commit**

```bash
git add src/lib/shows/week-grid.ts tests/unit/week-grid.test.ts
git commit -m "feat(30e): the week grid's geometry, computed without a browser or a clock"
```

---

### Task 3: The Programmes screen stops paging

Spec D1. Both views show every programme of the Station, up to a ceiling that says so.

**Files:**
- Modify: `src/services/shows.ts` (`listShowsPage` → `listShows`)
- Modify: `src/app/(app)/shows/list-params.ts` (cursor out)
- Modify: `src/app/(app)/shows/page.tsx`
- Modify: `src/app/(app)/shows/shows-grid.tsx`
- Modify: `messages/en.json`, `messages/es.json`, `messages/pt.json`
- Test: `tests/e2e/shows.spec.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `SHOW_LIST_MAX = 500`; `listShows(params: ShowListParams): Promise<ShowList>` with `ShowList = { rows: ShowSummary[]; total: number; capped: boolean }`; `ShowListParams` loses `cursor` and `cursorSide`; `showHref(state: ShowListState): string` takes no cursor argument.

- [ ] **Step 1: Find every assertion that depends on paging**

Run: `grep -n "shows-page\|PageControls\|next\|previous" tests/e2e/shows.spec.ts`
Read whatever it prints. Any assertion about Previous/Next on this screen is about to
stop being true, and it must be *changed to assert the new truth*, never deleted: a
deleted assertion is coverage this block silently gave up.

- [ ] **Step 2: Write the failing e2e assertion**

In `tests/e2e/shows.spec.ts`, inside the existing describe that opens the Programmes
screen, add:

```ts
test('lists every programme with no pages to walk', async ({ page }) => {
  await gotoProgrammes(page); // the helper this file already uses to reach /shows

  await expect(page.getByTestId('shows-table')).toBeVisible();
  // D1: there is nothing to page through, so there is nothing to click.
  await expect(page.getByRole('link', { name: 'Next' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Previous' })).toHaveCount(0);
  // The count stays: without paging it is the only thing that says how many there are.
  await expect(page.getByTestId('shows-count')).toBeVisible();
});
```

If the file has no `gotoProgrammes` helper, use the navigation the neighbouring tests
in the same file use — do not invent a second way to reach the screen.

- [ ] **Step 3: Run it and watch it fail**

Run: `npm run test:e2e -- tests/e2e/shows.spec.ts`
Expected: FAIL — the Next link is still rendered, or `shows-count` does not exist yet.

- [ ] **Step 4: Rewrite the service read**

In `src/services/shows.ts`, replace `listShowsPage` with `listShows`, keeping
`SHOW_COLUMNS`, `toSummary` and the filter predicates exactly as they are:

```ts
/**
 * Block 30e, D1. The screen shows every programme a Station has, so this reads
 * them all — and the ceiling below is the honest half of that sentence.
 *
 * A keyset cursor was the wrong apparatus for a list a week grid also has to
 * draw: a grid cannot page (a week is a week), and paging the list while the
 * grid showed everything would leave the two views disagreeing about how many
 * programmes exist.
 */
export const SHOW_LIST_MAX = 500;

export interface ShowList {
  rows: ShowSummary[];
  total: number;
  /**
   * Whether the ceiling cut the list. Rendered as a line above the table, never
   * swallowed: a cap nobody is told about is how a screen comes to claim a
   * completeness it does not have.
   */
  capped: boolean;
}

export async function listShows(params: ShowListParams): Promise<ShowList> {
  const supabase = await createUserClient();
  const today = new Date().toISOString().slice(0, 10);

  const build = (options?: { count: 'exact'; head: true }) => {
    let q = supabase
      .from('shows')
      .select(SHOW_COLUMNS, options)
      .eq('company_id', params.companyId)
      .is('deleted_at', null);

    if (!params.includeEnded) q = q.or(`ends_on.is.null,ends_on.gte.${today}`);
    if (params.kind) q = q.eq('kind', params.kind);
    if (params.search) {
      const term = escapeLikePattern(params.search.slice(0, SHOW_SEARCH_MAX_LENGTH));
      q = q.ilike('name', `%${term}%`);
    }
    return q;
  };

  const column = params.sort === 'name' ? 'name' : 'created_at';
  const ascending = params.direction === 'asc';

  // One past the ceiling, which is how `capped` knows there was more.
  const { data, error } = await build()
    .order(column, { ascending })
    .order('id', { ascending })
    .limit(SHOW_LIST_MAX + 1);
  if (error) throw new InternalError(`Could not read programmes: ${error.message}`);

  const rows = (data ?? []) as unknown as ShowRow[];
  const capped = rows.length > SHOW_LIST_MAX;

  const { count, error: countError } = await build({ count: 'exact', head: true });
  if (countError) throw new InternalError(`Could not count programmes: ${countError.message}`);

  return {
    rows: rows.slice(0, SHOW_LIST_MAX).map((row) => toSummary(row, today)),
    total: count ?? 0,
    capped,
  };
}
```

Drop `cursor` and `cursorSide` from `ShowListParams`, delete `ShowListPage`, and remove
the now-unused `keysetFilter` / `keysetPage` / `Cursor` imports.

- [ ] **Step 5: Take the cursor out of the URL contract**

In `src/app/(app)/shows/list-params.ts`: delete `ShowCursor`, `parseShowCursor`, and the
`after`/`before` fields of `ShowSearchParams`; change `showHref(state: ShowListState)` to
take no second argument and drop the `if (cursor)` line; `showSortHref` keeps working
unchanged. Replace the paging comment above `showHref` with:

```ts
/**
 * The whole address, rebuilt from the state every time. There is no cursor to
 * omit any more (D1): the screen shows every programme, so a link only ever
 * carries the Station, the filters and the sort.
 */
```

- [ ] **Step 6: Rewire the page and the grid**

In `src/app/(app)/shows/page.tsx`: drop `decodeCursor`, `parseShowCursor` and the cursor
arguments; call `listShows`; pass `capped` down; delete `previousHref`/`nextHref`.

In `src/app/(app)/shows/shows-grid.tsx`: accept `capped: boolean` instead of the two
hrefs, drop the `PageControls` import, and render in its place:

```tsx
<div className="flex flex-wrap items-center justify-between gap-2 border-t px-4 py-3">
  <p className="text-sm text-muted-foreground" data-testid="shows-count">
    {t('programmesLabel', { count: grid.total ?? 0 })}
  </p>
  {/* D1. The ceiling exists so a runaway import cannot turn this screen into a
      full-table render, and it says so rather than letting the list look whole. */}
  {capped && (
    <p className="text-sm text-muted-foreground" data-testid="shows-capped">
      {t('showingTheFirstProgrammes', { count: SHOW_LIST_MAX })}
    </p>
  )}
</div>
```

Import `SHOW_LIST_MAX` from `@/services/shows` — it is a plain constant, and the type-only
import already in this file shows the boundary is fine for values that are not server code.
If the linter objects to importing a value from a `server-only` module into a client
component, move the constant to `src/lib/shows/limits.ts` and import it from there in both
places.

- [ ] **Step 7: Add the three catalogue keys**

Add `showingTheFirstProgrammes` to the `shows` namespace of all three catalogues:

- `messages/en.json`: `"showingTheFirstProgrammes": "Showing the first {count} programmes."`
- `messages/pt.json`: `"showingTheFirstProgrammes": "Mostrando os primeiros {count} programas."`
- `messages/es.json`: `"showingTheFirstProgrammes": "Mostrando los primeros {count} programas."`

- [ ] **Step 8: Run the guards, then the screen**

Run: `npm run test -- tests/unit/i18n && npm run typecheck`
Expected: PASS both.

Run: `npm run test:e2e -- tests/e2e/shows.spec.ts`
Expected: PASS, the new case included.

- [ ] **Step 9: Commit**

```bash
git add src/services/shows.ts "src/app/(app)/shows" messages tests/e2e/shows.spec.ts
git commit -m "feat(30e): the Programmes screen shows every programme, and says when a ceiling cut it"
```

---

### Task 4: The week view

Spec D2–D6. The toggle, the grid, the legend, the now-line, and the record dialog over it.

**Files:**
- Modify: `src/app/(app)/shows/list-params.ts` (`view`, `week`)
- Modify: `src/services/shows.ts` (`listShowsForWeek`)
- Create: `src/app/(app)/shows/schedule-board.tsx` (client)
- Modify: `src/app/(app)/shows/shows-filters.tsx` (the toggle)
- Modify: `src/app/(app)/shows/page.tsx`
- Modify: `messages/*.json`
- Test: `tests/e2e/shows.spec.ts`

**Interfaces:**
- Consumes: `layOutWeek`, `weekDays`, `isoWeekStart`, `shiftWeek`, `GridShow`, `GridBlock` (Task 2); `showHref` (Task 3).
- Produces: `ShowListState` gains `view: 'list' | 'schedule'` and `week?: string`; `listShowsForWeek(params): Promise<{ rows: GridShow[]; capped: boolean }>`.

- [ ] **Step 1: Write the failing e2e journey**

In `tests/e2e/shows.spec.ts`:

```ts
test('draws the week, keeps the filters across the switch, and opens a record from a block', async ({ page }) => {
  await gotoProgrammes(page);

  // A filter set in the list has to survive the switch — item 12's own requirement.
  await page.getByTestId('shows-search').fill('Manh');
  await page.getByTestId('shows-view-schedule').click();

  await expect(page.getByTestId('shows-week')).toBeVisible();
  await expect(page.getByTestId('shows-search')).toHaveValue('Manh');

  // The week arrows move a whole week and stay on the grid.
  await page.getByTestId('shows-week-next').click();
  await expect(page.getByTestId('shows-week')).toBeVisible();
  await page.getByTestId('shows-week-today').click();

  // A block opens the same record dialog the list opens.
  const block = page.getByTestId('show-block').first();
  await expect(block).toBeVisible();
  await block.click();
  await expect(page.getByRole('dialog')).toBeVisible();
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm run test:e2e -- tests/e2e/shows.spec.ts`
Expected: FAIL — `shows-view-schedule` does not exist.

- [ ] **Step 3: Put the view and the week in the URL contract**

In `src/app/(app)/shows/list-params.ts`:

```ts
export type ShowView = 'list' | 'schedule';

export interface ShowSearchParams {
  // ... the existing fields
  view?: string;
  week?: string;
}

export interface ShowListState {
  // ... the existing fields
  /**
   * D6. Two views of ONE list, under one set of filters, which is why this is a
   * parameter and not a second route: every filter link is built by `showHref`,
   * and a second route would need this screen's whole filter contract copied
   * into it. Block 20b's `?tab=` mistake was the opposite situation — an item
   * that asked for tabs to STOP EXISTING, kept alive under another name.
   */
  view: ShowView;
  /** The Monday of the week the grid draws. Meaningless in the list view, and absent there. */
  week?: string;
}
```

In `parseShowListState`, add — and note that `parseShowListState` cannot know the
Station's today, so `week` is left undefined here and defaulted by the page, which does:

```ts
  // Anything the vocabulary does not name is the list, the same way an unknown
  // `kind` is no filter at all: a URL is hostile input and a typo must not be an
  // error page.
  const view: ShowView = raw.view === 'schedule' ? 'schedule' : 'list';
  // A hand-edited week that is not a date is dropped rather than refused; the
  // page then falls back to the week containing the Station's today.
  const week = /^\d{4}-\d{2}-\d{2}$/.test(raw.week?.trim() ?? '')
    ? isoWeekStart(raw.week!.trim())
    : undefined;
```

In `showHref`, after the sort parameters:

```ts
  if (state.view === 'schedule') query.set('view', 'schedule');
  if (state.view === 'schedule' && state.week) query.set('week', state.week);
```

In `hasActiveShowFilters`, leave the view and the week out: they are not filters, and
counting them would make "Clear filters" throw the operator back into the list.

- [ ] **Step 4: Read the week from the database**

In `src/services/shows.ts`:

```ts
/**
 * Block 30e, D4. The programmes to draw over one week: every live programme of
 * the Station whose RUN OVERLAPS that week, which is a different question from
 * the list's "is it over yet".
 *
 * The `includeEnded` filter deliberately has no part here. A programme that
 * ended last month did air in the weeks it ran, and a past week drawn without it
 * would be a false picture of that week; a programme that has not started does
 * not appear, because its run has not reached this week yet. Those two facts are
 * the whole of the predicate below, and they are why this read exists beside
 * `listShows` rather than as a flag on it.
 */
export interface ShowWeekParams {
  companyId: string;
  search?: string;
  kind?: ShowKind;
  /** `YYYY-MM-DD`, the Monday and the Sunday of the week being drawn. */
  weekStart: string;
  weekEnd: string;
}

export async function listShowsForWeek(
  params: ShowWeekParams,
): Promise<{ rows: GridShow[]; capped: boolean }> {
  const supabase = await createUserClient();

  let query = supabase
    .from('shows')
    .select('id,name,kind,starts_on,ends_on,show_schedules(band,weekday,starts_at,ends_at)')
    .eq('company_id', params.companyId)
    .is('deleted_at', null)
    .or(`starts_on.is.null,starts_on.lte.${params.weekEnd}`)
    .or(`ends_on.is.null,ends_on.gte.${params.weekStart}`);

  if (params.kind) query = query.eq('kind', params.kind);
  if (params.search) {
    const term = escapeLikePattern(params.search.slice(0, SHOW_SEARCH_MAX_LENGTH));
    query = query.ilike('name', `%${term}%`);
  }

  const { data, error } = await query.order('name').limit(SHOW_LIST_MAX + 1);
  if (error) throw new InternalError(`Could not read the week's programmes: ${error.message}`);

  const rows = (data ?? []) as unknown as {
    id: string;
    name: string;
    kind: ShowKind | null;
    starts_on: string | null;
    ends_on: string | null;
    show_schedules: ScheduleRow[] | null;
  }[];

  return {
    capped: rows.length > SHOW_LIST_MAX,
    rows: rows.slice(0, SHOW_LIST_MAX).map((row) => ({
      id: row.id,
      name: row.name,
      kind: row.kind,
      startsOn: row.starts_on,
      endsOn: row.ends_on,
      schedules: row.show_schedules ?? [],
    })),
  };
}
```

Import `GridShow` from `@/lib/shows/week-grid` and `ScheduleRow` from `@/lib/shows/bands`.

**Two `.or()` calls are ANDed together by PostgREST**, which is what this predicate needs
("starts early enough" AND "ends late enough"). Confirm it in Step 8 by loading a week
before a programme's `starts_on` and seeing it absent.

- [ ] **Step 5: Build the board**

Create `src/app/(app)/shows/schedule-board.tsx`:

```tsx
'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import type { Route } from 'next';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { SHOW_KINDS } from '@/schemas/shows';
import { useRecordDialog } from '@/hooks/use-record-dialog';
import { SHOW_TABS } from '@/lib/record-params';
import { shiftWeek, type GridBlock, type WeekDay } from '@/lib/shows/week-grid';
import { showHref } from './list-params';
import type { ShowListState } from './list-params';
import { ShowRecordDialog } from './show-record-dialog';

/**
 * Block 30e, item 12. The week, drawn.
 *
 * A CLIENT COMPONENT, and for one reason worth stating: it owns the record
 * dialog, exactly as `ShowsGrid` does. A block that opens a programme has to
 * open the SAME dialog the list opens, and that dialog is driven by
 * `useRecordDialog`. The geometry it renders is computed on the server by a pure
 * module (`@/lib/shows/week-grid`), so what lives here is drawing and nothing
 * else — no dates are derived in this file.
 *
 * THE NOW-LINE IS THE ONLY THING THAT MOVES, and it is positioned from the
 * MINUTE THE SERVER READ IN THE STATION'S ZONE, ticking forward locally from
 * there. Reading the browser's own clock would put the line where the operator
 * is rather than where the Station is, which is the trap `shows_on_air` (0175)
 * documents on itself: a bare clock passes every test run in the afternoon and
 * is wrong at 21:00.
 */
const HOURS = Array.from({ length: 24 }, (_, hour) => hour);

/** D5. One colour per kind, by enum value rather than by position, so two loads paint the same picture. */
const KIND_CLASS: Record<string, string> = {
  MUSICAL: 'bg-sky-500/85 text-white',
  NEWS: 'bg-amber-500/85 text-black',
  TALK_SHOW: 'bg-violet-500/85 text-white',
  SPORTS: 'bg-emerald-500/85 text-white',
  ENTERTAINMENT: 'bg-rose-500/85 text-white',
};
const NO_KIND_CLASS = 'bg-muted text-muted-foreground';

export function ScheduleBoard({
  blocks,
  days,
  state,
  manage,
  initialRecord,
  capped,
  /** Minutes since the Station's midnight, or null when the week on screen is not the Station's current week. */
  nowMinutes,
  /** The date, in the Station's zone, that should be marked as today — null when it is not in this week. */
  todayDate,
}: {
  blocks: GridBlock[];
  days: WeekDay[];
  state: ShowListState;
  manage: boolean;
  initialRecord: { recordId: string | null; tab: string | null };
  capped: boolean;
  nowMinutes: number | null;
  todayDate: string | null;
}) {
  const t = useTranslations('shows');
  const { recordId, open, close } = useRecordDialog(SHOW_TABS, initialRecord);

  // Ticks forward from the server's reading rather than re-deriving the time, so
  // the line cannot drift into the browser's zone between renders.
  const [minutes, setMinutes] = useState(nowMinutes);
  useEffect(() => setMinutes(nowMinutes), [nowMinutes]);
  useEffect(() => {
    if (nowMinutes === null) return;
    const timer = setInterval(() => setMinutes((m) => (m === null ? null : m + 1)), 60_000);
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
        </div>
        {/* D4, said on the screen: an operator who ticked "show ended programmes"
            on the list and switched here must not be left wondering. */}
        <p className="text-xs text-muted-foreground">{t('theWeekShowsWhatAired')}</p>
      </div>

      {capped && (
        <p className="mt-2 text-sm text-muted-foreground" data-testid="shows-week-capped">
          {t('showingTheFirstProgrammes', { count: blocks.length })}
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
              className={`border-b p-2 text-center text-xs ${
                day.date === todayDate ? 'bg-accent font-semibold' : 'text-muted-foreground'
              }`}
              data-testid="shows-week-day"
            >
              {t(`weekday_${day.weekday}`)} {day.date.slice(8)}
            </div>
          ))}

          <div className="relative border-r">
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
                  style={{ top: `${(minutes / 1440) * 100}%` }}
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
                    className={`absolute inset-x-1 overflow-hidden rounded px-1 py-0.5 text-left text-[10px] leading-tight ${
                      block.kind ? KIND_CLASS[block.kind] ?? NO_KIND_CLASS : NO_KIND_CLASS
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
          <span className={`inline-block size-3 rounded ${NO_KIND_CLASS}`} aria-hidden="true" />
          {t('noKindRecorded')}
        </span>
      </div>

      <ShowRecordDialog
        open={recordId !== null}
        recordId={recordId}
        companyId={state.companyId}
        manage={manage}
        onClose={close}
      />
    </>
  );
}
```

Match `ShowRecordDialog`'s real prop list — read it in `show-record-dialog.tsx` and pass
exactly what `ShowsGrid` passes, including any `onSaved` callback it expects.

- [ ] **Step 6: Add the toggle**

In `src/app/(app)/shows/shows-filters.tsx`, before the "Clear filters" link:

```tsx
      {/* D6. Two views of one list. Links rather than buttons: the view is part of
          the address, so it is shareable, and the server renders whichever one it
          names. */}
      <div className="mb-1 flex items-center gap-1 rounded-md border p-1">
        <Link
          href={showHref({ ...state, view: 'list', week: undefined }) as Route}
          aria-current={state.view === 'list' ? 'page' : undefined}
          data-testid="shows-view-list"
          className={
            state.view === 'list'
              ? 'rounded px-3 py-1 text-sm bg-primary text-primary-foreground'
              : 'rounded px-3 py-1 text-sm text-muted-foreground hover:bg-accent'
          }
        >
          {t('listView')}
        </Link>
        <Link
          href={showHref({ ...state, view: 'schedule' }) as Route}
          aria-current={state.view === 'schedule' ? 'page' : undefined}
          data-testid="shows-view-schedule"
          className={
            state.view === 'schedule'
              ? 'rounded px-3 py-1 text-sm bg-primary text-primary-foreground'
              : 'rounded px-3 py-1 text-sm text-muted-foreground hover:bg-accent'
          }
        >
          {t('weekView')}
        </Link>
      </div>
```

The `navigate` helper in this file spreads `state`, so the view and the week ride along
with every filter change already — no change needed there.

- [ ] **Step 7: Branch the page**

In `src/app/(app)/shows/page.tsx`, after `state` is parsed:

```tsx
  // WHOSE TODAY, decided once. `companies.timezone` is the Station's, and every
  // date on this screen — the default week, the column that is marked, the minute
  // the now-line sits at — is read from it. The server's own midnight would put
  // the grid a day out for half the Stations and the line an hour out twice a year.
  const stationNow = new Date();
  const stationToday = new Intl.DateTimeFormat('en-CA', {
    timeZone: selected.timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(stationNow);
  const stationClock = new Intl.DateTimeFormat('en-GB', {
    timeZone: selected.timezone,
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
  }).format(stationNow);

  const weekStart = state.week ?? isoWeekStart(stationToday);
  const days = weekDays(weekStart);
  const weekEnd = days[6]!.date;
```

Then, when `state.view === 'schedule'`, read the week and render the board instead of the
filters' list half:

```tsx
    const week = await listShowsForWeek({
      companyId: state.companyId,
      search: state.search?.slice(0, SHOW_SEARCH_MAX_LENGTH),
      kind: state.kind,
      weekStart,
      weekEnd,
    });

    const blocks = layOutWeek(week.rows, days);
    const inThisWeek = stationToday >= weekStart && stationToday <= weekEnd;
    const [hours = '0', minutes = '0'] = stationClock.split(':');
```

and pass `blocks`, `days`, `state: { ...state, week: weekStart }`, `manage`, `capped: week.capped`,
`todayDate: inThisWeek ? stationToday : null`,
`nowMinutes: inThisWeek ? Number(hours) * 60 + Number(minutes) : null`,
`initialRecord`.

Keep `<ShowsFilters state={{ ...state, week: weekStart }} />` above both views, so the
toggle and the arrows always carry the week the page actually drew.

- [ ] **Step 8: Add the catalogue keys**

New keys in the `shows` namespace of all three files: `listView`, `weekView`, `thisWeek`,
`theWeekBefore`, `theWeekAfter`, `theWeekShowsWhatAired`, `hour`, `noKindRecorded`,
`nothingIsScheduledThisWeek`, and `weekday_1` … `weekday_7`.

English values: `"List"`, `"Week"`, `"This week"`, `"The week before"`, `"The week after"`,
`"This grid shows what aired in the week on screen, ended programmes included."`,
`"Hour"`, `"No kind recorded"`, `"Nothing is scheduled this week."`,
`"Mon"`, `"Tue"`, `"Wed"`, `"Thu"`, `"Fri"`, `"Sat"`, `"Sun"`.

Portuguese: `"Lista"`, `"Semana"`, `"Esta semana"`, `"A semana anterior"`, `"A semana seguinte"`,
`"Esta grade mostra o que foi ao ar na semana em tela, encerrados inclusive."`, `"Hora"`,
`"Sem tipo registrado"`, `"Nada programado nesta semana."`, `"Seg"`, `"Ter"`, `"Qua"`,
`"Qui"`, `"Sex"`, `"Sáb"`, `"Dom"`.

Spanish: `"Lista"`, `"Semana"`, `"Esta semana"`, `"La semana anterior"`, `"La semana siguiente"`,
`"Esta cuadrícula muestra lo que se emitió en la semana en pantalla, incluidos los finalizados."`,
`"Hora"`, `"Sin tipo registrado"`, `"Nada programado esta semana."`, `"Lun"`, `"Mar"`, `"Mié"`,
`"Jue"`, `"Vie"`, `"Sáb"`, `"Dom"`.

- [ ] **Step 9: Run the guards and the journey**

Run: `npm run test -- tests/unit/i18n && npm run typecheck && npm run lint`
Expected: PASS.

Run: `npm run test:e2e -- tests/e2e/shows.spec.ts`
Expected: PASS, both new cases included.

- [ ] **Step 10: Commit**

```bash
git add "src/app/(app)/shows" src/services/shows.ts messages tests/e2e/shows.spec.ts
git commit -m "feat(30e): the Programmes week, drawn in the Station's own zone"
```

---

### Task 5: `0269` — the door that reads a Programme's schedule without `music.view`

Spec D7.

**Files:**
- Create: `supabase/migrations/0269_promotion_show_schedule.sql`
- Create: `supabase/tests/75_promotion_show_schedule.test.sql`

**Interfaces:**
- Consumes: nothing.
- Produces: `public.promotion_show_schedule(p_promotion_id uuid) returns table(show_id uuid, show_name text, band smallint, weekday smallint, starts_at time, ends_at time)`.

- [ ] **Step 1: Write the migration**

```sql
-- supabase/migrations/0269_promotion_show_schedule.sql

-- Block 30e, item 18. A promotion's Programme schedule, read by a caller who
-- administers Promotions.
--
-- WHY THIS EXISTS AT ALL. `shows` and `show_schedules` each carry exactly one
-- select policy, and both are gated on `music.view` (0099, 0175). The
-- Participations screen needs a Programme's bands to offer the window item 18
-- describes, and the operator who uses that screen need not hold anything in
-- music. Left to RLS the band combo would be permanently EMPTY for exactly
-- those operators -- and an empty combo does not say "you may not see this", it
-- says "this Programme never airs". A filter that silently answers nothing is
-- worse than one that refuses.
--
-- SECURITY DEFINER, so it must re-check by hand what RLS would have checked. It
-- checks `participations.view` at the promotion's own Station: this is a read in
-- service of that screen, and it grants nothing about the Music section.
--
-- IT RETURNS ROWS, NOT A WINDOW. Reconstructing a band from its rows and turning
-- a wall-clock into an instant are both already written and already tested on
-- the other side (`toBands`, `fromZonedWallClock`), and the week grid draws from
-- the same reconstruction. A second implementation here would be a second thing
-- to keep in step with `save_show`.

create function public.promotion_show_schedule(p_promotion_id uuid)
returns table (
  show_id   uuid,
  show_name text,
  band      smallint,
  weekday   smallint,
  starts_at time,
  ends_at   time
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  v_company uuid;
  v_show    uuid;
begin
  select p.company_id, p.show_id
    into v_company, v_show
    from public.promotions p
   where p.id = p_promotion_id
     and p.deleted_at is null;

  -- No such promotion: nothing to say, and nothing said about whether it exists
  -- somewhere this caller cannot see.
  if v_company is null then
    return;
  end if;

  if not public.has_permission('participations.view', v_company) then
    raise exception 'participations.view is required to read this promotion''s programme'
      using errcode = '42501';
  end if;

  -- A promotion with no Programme is the ordinary case, and it is NOT the same
  -- answer as the refusal above: the screen shows its two date filters and never
  -- mentions a Programme at all.
  if v_show is null then
    return;
  end if;

  -- ARCHIVED PROGRAMMES INCLUDED, deliberately. 0258's own comment on
  -- promotions.show_id says the link survives archiving "so that a promotion
  -- which ran inside a Programme still says so and Block 30e can still read that
  -- Programme's schedule". Filtering deleted_at here would silently break that
  -- promise for exactly the promotions that are most likely to be looked back at.
  return query
    select s.id, s.name, sc.band, sc.weekday, sc.starts_at, sc.ends_at
      from public.shows s
      join public.show_schedules sc on sc.show_id = s.id
     where s.id = v_show
       and s.company_id = v_company
     order by sc.band, sc.weekday, sc.starts_at;
end;
$$;

comment on function public.promotion_show_schedule(uuid) is
  'Block 30e, item 18. The weekly schedule of the Programme a promotion belongs to, for a caller holding participations.view at that promotion''s Station. SECURITY DEFINER because shows and show_schedules are gated on music.view, which the Participations operator need not hold; without this door the band combo would be permanently empty for them, which reads as "this Programme never airs" rather than as a permission they lack. Returns no rows for a promotion that does not exist and for one with no Programme -- two ordinary answers -- and raises 42501 for a caller without the permission. Archived Programmes are included, because promotions.show_id outlives the archive by design (0258).';

revoke execute on function public.promotion_show_schedule(uuid) from public;
grant execute on function public.promotion_show_schedule(uuid) to authenticated;
```

- [ ] **Step 2: Write the pgTAP file**

`supabase/tests/75_promotion_show_schedule.test.sql`, following the house shape
(`begin; select plan(N); … select finish(); rollback;`) and the fixture idiom of
`73_fast_entry.test.sql`. Cases, each named for what it checks rather than by number:

```sql
begin;
select plan(11);

-- Block 30e, item 18 (D7). The door that lets the Participations screen read a
-- Programme's schedule without holding anything in the Music section.
--
-- THE POINT OF THE FIXTURE is a member who holds participations.view and NO
-- music.view anywhere: that is the operator the door exists for, and a test that
-- granted both would pass against a door that did not exist.

-- Fixtures: one Organization, two Stations (A and B), a Programme at A with two
-- bands (one of them overnight), a promotion at A pointing at it, a promotion at
-- A with no Programme, an archived Programme at A with a promotion pointing at
-- it, and a promotion at B. Two members: `entrant` holds participations.view at
-- A only; `outsider` holds nothing at A.

-- the function exists and is SECURITY DEFINER
select has_function('public', 'promotion_show_schedule', array['uuid'], 'the door exists');
select is(
  (select prosecdef from pg_proc where proname = 'promotion_show_schedule'),
  true,
  'it is SECURITY DEFINER, which is why it re-checks by hand'
);
select is(
  (select proacl::text from pg_proc where proname = 'promotion_show_schedule'),
  '{postgres=X/postgres,authenticated=X/postgres}',
  'authenticated may execute it and public may not'
);

set local role authenticated;
set local request.jwt.claims = '{"sub": "…entrant…", "role": "authenticated"}';

-- the schedule comes back for the operator the door exists for
select is(
  (select count(*)::int from public.promotion_show_schedule('…promotion at A…')),
  3,
  'the Programme''s three schedule rows come back for a caller with participations.view and no music.view'
);
select is(
  (select show_name from public.promotion_show_schedule('…promotion at A…') limit 1),
  'Manhã Total',
  'and it names the Programme, so the screen can say whose schedule it is'
);

-- the two ordinary empty answers
select is(
  (select count(*)::int from public.promotion_show_schedule('…promotion with no show…')),
  0,
  'a promotion with no Programme answers with no rows rather than an error'
);
select is(
  (select count(*)::int from public.promotion_show_schedule('00000000-0000-0000-0000-000000000000')),
  0,
  'a promotion that does not exist answers the same way, saying nothing about whether it exists elsewhere'
);

-- an archived Programme is still readable (0258's promise)
select is(
  (select count(*)::int from public.promotion_show_schedule('…promotion whose show is archived…')),
  2,
  'an archived Programme still answers, because promotions.show_id outlives the archive'
);

-- the refusals
select throws_ok(
  $$select * from public.promotion_show_schedule('…promotion at B…')$$,
  '42501',
  null,
  'a Station where this caller holds no participations.view is refused, not answered emptily'
);

set local request.jwt.claims = '{"sub": "…outsider…", "role": "authenticated"}';
select throws_ok(
  $$select * from public.promotion_show_schedule('…promotion at A…')$$,
  '42501',
  null,
  'a caller with no permission at that Station is refused'
);

-- and the door grants nothing in the Music section
select is(
  (select count(*)::int from public.shows),
  0,
  'the same caller still cannot read shows directly: the door widened one read, not the section'
);

select finish();
rollback;
```

Fill every `…` with the real fixture ids. Read `73_fast_entry.test.sql`'s fixture block
and copy its style of literal uuids.

- [ ] **Step 3: Run it and watch it fail**

Run: `npm run db:reset && npm run seed:branding && npm run db:test`
Expected: FAIL — `function public.promotion_show_schedule(uuid) does not exist`, until the
migration from Step 1 is applied by the reset.

(If the reset already applied it, the first failing run is the pgTAP file itself against
the not-yet-written migration — write the test first, run, then add the migration and
reset again.)

- [ ] **Step 4: Apply and re-run**

Run: `npm run db:reset && npm run seed:branding && npm run db:test`
Expected: PASS, 11 of 11 in file 75, and every other file still green.

- [ ] **Step 5: Regenerate the database types**

Run: `npm run db:types`
Expected: `src/lib/supabase/database.types.ts` now declares `promotion_show_schedule`.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/0269_promotion_show_schedule.sql supabase/tests/75_promotion_show_schedule.test.sql src/lib/supabase/database.types.ts
git commit -m "feat(30e): a door to a promotion's Programme schedule, gated on participations.view"
```

---

### Task 6: Reading the schedule, and turning a band into a window

Spec D8 and D9, as pure functions plus one service read.

**Files:**
- Create: `src/lib/shows/programme-bands.ts`
- Create: `src/app/(app)/participations/programme-window.ts`
- Modify: `src/services/shows.ts` (`getPromotionShowSchedule`)
- Test: `tests/unit/programme-window.test.ts`

**Interfaces:**
- Consumes: `bandsByMarker`, `isOvernight`, `ScheduleRow` (Task 1); `promotion_show_schedule` (Task 5); `fromZonedWallClock` from `@/app/(app)/promotions/zone`.
- Produces:
  - `ProgrammeBand = { marker: number; starts: string; ends: string; overnight: boolean; label: string }`
  - `bandsOnDay(rows: ScheduleRow[], day: string): ProgrammeBand[]`
  - `windowFor(band: ProgrammeBand, day: string, timeZone: string): { from: string; to: string } | null`
  - `getPromotionShowSchedule(promotionId: string): Promise<{ showId: string; showName: string; rows: ScheduleRow[] } | null>`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/programme-window.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { bandsOnDay } from '@/lib/shows/programme-bands';
import { windowFor } from '@/app/(app)/participations/programme-window';

const SAO_PAULO = 'America/Sao_Paulo';

/** Monday–Friday 10:00–12:30, and a Friday night that runs to 02:00. */
const ROWS = [
  { band: 1, weekday: 1, starts_at: '10:00:00', ends_at: '12:30:00' },
  { band: 1, weekday: 2, starts_at: '10:00:00', ends_at: '12:30:00' },
  { band: 1, weekday: 3, starts_at: '10:00:00', ends_at: '12:30:00' },
  { band: 1, weekday: 4, starts_at: '10:00:00', ends_at: '12:30:00' },
  { band: 1, weekday: 5, starts_at: '10:00:00', ends_at: '12:30:00' },
  { band: 2, weekday: 5, starts_at: '23:00:00', ends_at: '24:00:00' },
  { band: 2, weekday: 6, starts_at: '00:00:00', ends_at: '02:00:00' },
];

describe('the bands a Programme airs on a day', () => {
  it('offers the bands that START that day', () => {
    // 2026-08-21 is a Friday: both bands begin on it.
    expect(bandsOnDay(ROWS, '2026-08-21').map((b) => b.label)).toEqual([
      '10:00–12:30',
      '23:00–02:00',
    ]);
  });

  it('offers nothing on a day the Programme does not air', () => {
    // 2026-08-23 is a Sunday. The Saturday tail of the overnight band is NOT an
    // offer: it is the second half of a band that started on Friday.
    expect(bandsOnDay(ROWS, '2026-08-23')).toEqual([]);
    expect(bandsOnDay(ROWS, '2026-08-22')).toEqual([]);
  });

  it('marks the band that runs past midnight', () => {
    const [, overnight] = bandsOnDay(ROWS, '2026-08-21');
    expect(overnight?.overnight).toBe(true);
    expect(overnight?.marker).toBe(2);
  });
});

describe('the window a band names on a date', () => {
  it('is half-open, ending one millisecond before the band does', () => {
    const [morning] = bandsOnDay(ROWS, '2026-08-21');
    const window = windowFor(morning!, '2026-08-21', SAO_PAULO);

    // 10:00 in São Paulo is 13:00Z on that date.
    expect(window?.from).toBe('2026-08-21T13:00:00.000Z');
    // 12:30 is 15:30Z; the last instant inside the band is one millisecond before,
    // because list_participations compares `participated_at <= p_to`.
    expect(window?.to).toBe('2026-08-21T15:29:59.999Z');
  });

  it('ends on the following day when the band runs past midnight', () => {
    const [, overnight] = bandsOnDay(ROWS, '2026-08-21');
    const window = windowFor(overnight!, '2026-08-21', SAO_PAULO);

    expect(window?.from).toBe('2026-08-22T02:00:00.000Z');
    expect(window?.to).toBe('2026-08-22T04:59:59.999Z');
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm run test -- tests/unit/programme-window.test.ts`
Expected: FAIL — neither module exists.

- [ ] **Step 3: Write the two modules**

`src/lib/shows/programme-bands.ts`:

```ts
import { bandsByMarker, isOvernight, type ScheduleRow } from './bands';

/**
 * Block 30e, item 18. Which bands of a Programme START on a given date.
 *
 * "Start" is the whole of it. `save_show` splits a band that crosses midnight
 * into a head and a tail on the next weekday, and the tail must NOT be offered
 * as a band of its own: an operator choosing Saturday is not choosing the
 * Friday-night programme's small hours, and offering it would give them a window
 * that starts at 00:00 with no name they recognise. `toBands` already resolves
 * heads and tails into one band whose `days` are the days it starts on, and this
 * function is a filter over that answer.
 */
export interface ProgrammeBand {
  /** The `show_schedules.band` marker, which is what the URL carries. */
  marker: number;
  starts: string;
  ends: string;
  overnight: boolean;
  /** `10:00–12:30`, as the operator typed it. */
  label: string;
}

/** 1 = Monday … 7 = Sunday, from a `YYYY-MM-DD` read as a calendar date rather than an instant. */
function isoWeekday(day: string): number {
  const weekday = new Date(`${day}T00:00:00.000Z`).getUTCDay();
  return weekday === 0 ? 7 : weekday;
}

export function bandsOnDay(rows: ScheduleRow[], day: string): ProgrammeBand[] {
  const weekday = isoWeekday(day);

  return [...bandsByMarker(rows).entries()]
    .filter(([, band]) => band.days.includes(weekday))
    .map(([marker, band]) => ({
      marker,
      starts: band.starts,
      ends: band.ends,
      overnight: isOvernight(band),
      label: `${band.starts}–${band.ends}`,
    }));
}
```

`src/app/(app)/participations/programme-window.ts`:

```ts
import { fromZonedWallClock } from '../promotions/zone';
import type { ProgrammeBand } from '@/lib/shows/programme-bands';

/**
 * Block 30e, D8. The two instants a band names on a date, in the STATION's zone.
 *
 * HALF-OPEN, which is the rule `shows_on_air` states so that two consecutive
 * bands never both claim the same minute. `list_participations` (0090) compares
 * `participated_at <= p_to`, so the last instant inside the band is one
 * millisecond before its end — the same move `fromZonedDay(day, tz, true)`
 * already makes with `23:59:59.999`, made here rather than by changing a
 * predicate the list, the draw hat and the send-list filters all read through.
 *
 * It lives beside the screen rather than in `@/lib` because it is the only thing
 * in this block that needs a Station's zone, and the zone module it needs is the
 * one the filter bar beside it already uses.
 */
const ONE_MILLISECOND = 1;

/** The next calendar day. UTC arithmetic on a date string, which has no zone of its own. */
function nextDay(day: string): string {
  return new Date(new Date(`${day}T00:00:00.000Z`).getTime() + 86_400_000)
    .toISOString()
    .slice(0, 10);
}

export function windowFor(
  band: ProgrammeBand,
  day: string,
  timeZone: string,
): { from: string; to: string } | null {
  const from = fromZonedWallClock(`${day}T${band.starts}`, timeZone);
  const endDay = band.overnight ? nextDay(day) : day;
  const end = fromZonedWallClock(`${endDay}T${band.ends}`, timeZone);
  if (!from || !end) return null;

  return { from, to: new Date(Date.parse(end) - ONE_MILLISECOND).toISOString() };
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `npm run test -- tests/unit/programme-window.test.ts`
Expected: PASS.

If the two São Paulo instants differ from the expectations, do not "fix" the test by
copying what the code produced: check the offset by hand (`America/Sao_Paulo` is UTC−03:00
with no daylight saving since 2019) and find out which side is wrong.

- [ ] **Step 5: Add the service read**

In `src/services/shows.ts`:

```ts
export interface PromotionSchedule {
  showId: string;
  showName: string;
  rows: ScheduleRow[];
}

/**
 * Block 30e, item 18. The schedule of the Programme a promotion belongs to.
 *
 * Through `promotion_show_schedule` (0269) rather than through the tables,
 * because this screen's caller need not hold `music.view` — see that migration's
 * header. `null` means the promotion has no Programme, which is the ordinary
 * case and not a failure; a refusal arrives as `42501` and is mapped by
 * `mapShowError` into an UnauthorizedError the page can tell apart.
 */
export async function getPromotionShowSchedule(
  promotionId: string,
): Promise<PromotionSchedule | null> {
  const supabase = await createUserClient();
  const { data, error } = await supabase.rpc('promotion_show_schedule', {
    p_promotion_id: promotionId,
  });
  if (error) throw mapShowError(error.code, error.message);

  const rows = (data ?? []) as {
    show_id: string;
    show_name: string;
    band: number;
    weekday: number;
    starts_at: string;
    ends_at: string;
  }[];
  const first = rows[0];
  if (!first) return null;

  return {
    showId: first.show_id,
    showName: first.show_name,
    rows: rows.map((row) => ({
      band: row.band,
      weekday: row.weekday,
      starts_at: row.starts_at,
      ends_at: row.ends_at,
    })),
  };
}
```

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: PASS. If `promotion_show_schedule` is unknown to the client type, Task 5 Step 5
(`npm run db:types`) was skipped.

- [ ] **Step 7: Commit**

```bash
git add src/lib/shows/programme-bands.ts "src/app/(app)/participations/programme-window.ts" src/services/shows.ts tests/unit/programme-window.test.ts
git commit -m "feat(30e): a band on a date, and the half-open window it names in the Station's zone"
```

---

### Task 7: Participations, filtered by the band

Spec D8, D9, D10. The URL contract, the filter bar, the page, and the draw.

**Files:**
- Modify: `src/app/(app)/participations/list-params.ts`
- Modify: `src/app/(app)/participations/participations-filters.tsx`
- Modify: `src/app/(app)/participations/page.tsx`
- Modify: `messages/*.json`
- Test: `tests/e2e/participations-flow.spec.ts`

**Interfaces:**
- Consumes: `bandsOnDay`, `windowFor`, `getPromotionShowSchedule` (Task 6).
- Produces: `ParticipationListState` gains `day?: string` and `bandMarker?: number`; `participationsHref` writes `day`/`band` and omits `from`/`to` whenever `day` is set.

- [ ] **Step 1: Write the failing e2e journey**

In `tests/e2e/participations-flow.spec.ts`:

```ts
test('a promotion with a Programme is filtered by day and band, and the draw inherits it', async ({ page }) => {
  await gotoParticipations(page); // the helper this file already uses

  await page.getByTestId('participation-promotion-filter').selectOption({ label: 'Promoção do Programa' });

  // D8: the second instant is gone; a day and a band take its place.
  await expect(page.getByTestId('participation-to-filter')).toHaveCount(0);
  await page.getByTestId('participation-day-filter').fill('2026-08-21');
  await expect(page.getByTestId('participation-band-filter')).toBeVisible();
  await page.getByTestId('participation-band-filter').selectOption({ index: 0 });

  // The window is named on the screen, so the operator can see what they are in.
  await expect(page.getByTestId('participation-programme-window')).toBeVisible();

  // D10: the hat the draw offers is the narrowed list, not the whole promotion.
  const listed = await page.getByTestId('participation-row').count();
  await page.getByTestId('participation-draw').click();
  await expect(page.getByTestId('draw-hat-size')).toContainText(String(listed));
});

test('a day the Programme does not air lists nothing and says why', async ({ page }) => {
  await gotoParticipations(page);
  await page.getByTestId('participation-promotion-filter').selectOption({ label: 'Promoção do Programa' });
  await page.getByTestId('participation-day-filter').fill('2026-08-23'); // a Sunday

  await expect(page.getByTestId('participation-programme-silent')).toBeVisible();
  await expect(page.getByTestId('participation-row')).toHaveCount(0);
  // D9 + D10: with no window there is nothing to draw from, so the button is not offered.
  await expect(page.getByTestId('participation-draw')).toHaveCount(0);
});
```

Use the real test ids this file already uses for the promotion filter, the rows and the
draw button — read the file first and match them; the ids above are the names this plan
assumes, and where the file already has a different one, its own wins.

The fixture needs a promotion with a `show_id` at the seeded Station, and at least one
participation inside a band. Add it where this file's other fixtures are provisioned
(`tests/e2e/provision.ts`), and give the Programme a Monday–Friday band so the Sunday case
is genuinely empty.

- [ ] **Step 2: Run it and watch it fail**

Run: `npm run test:e2e -- tests/e2e/participations-flow.spec.ts`
Expected: FAIL — `participation-day-filter` does not exist.

- [ ] **Step 3: Extend the URL contract**

In `src/app/(app)/participations/list-params.ts`:

```ts
export interface ParticipationSearchParams {
  // ... existing
  /** Block 30e, item 18. The calendar day, in the Station's zone, whose band bounds the list. */
  day?: string;
  /** The `show_schedules.band` marker chosen for that day. */
  band?: string;
}

export interface ParticipationListState {
  // ... existing
  day?: string;
  bandMarker?: number;
}
```

In `parseParticipationListState`:

```ts
    // Block 30e, D8. A DAY and a BAND rather than two instants, so that a pasted
    // link still means "Saturday's morning show" tomorrow. The instants are
    // derived on the server, where the Station's zone and the Programme's
    // schedule are both in reach; nothing is derived here, because this function
    // is pure and has neither.
    day: /^\d{4}-\d{2}-\d{2}$/.test(raw.day?.trim() ?? '') ? raw.day!.trim() : undefined,
    bandMarker: Number.isInteger(Number(raw.band)) ? Number(raw.band) : undefined,
```

In `participationsHref`, replace the two date lines with:

```ts
  // D8. The day and the band REPLACE the instants rather than joining them: the
  // server derives `from`/`to` from these two, and writing both would put a stale
  // instant beside the band that produced it, which is how the two come to
  // disagree.
  if (state.day) {
    query.set('day', state.day);
    if (state.bandMarker !== undefined) query.set('band', String(state.bandMarker));
  } else {
    if (state.from) query.set('from', state.from);
    if (state.to) query.set('to', state.to);
  }
```

In `hasActiveParticipationFilters`, add `state.day ||` to the disjunction.

- [ ] **Step 4: Resolve the window on the server**

In `src/app/(app)/participations/page.tsx`, after `state` is parsed and before the list
read:

```tsx
  /**
   * Block 30e, item 18. The Programme this promotion belongs to, if any.
   *
   * A DELIBERATELY NARROW failure, like the promotion picker below it: this
   * screen's purpose is the list, and a Programme schedule that cannot be read
   * must cost the band combo and nothing else.
   */
  let programme: PromotionSchedule | null = null;
  if (state.promotionId) {
    try {
      programme = await getPromotionShowSchedule(state.promotionId);
    } catch (cause) {
      logger.error({ err: cause, promotionId: state.promotionId }, 'could not read the promotion programme');
    }
  }

  const dayBands = programme && state.day ? bandsOnDay(programme.rows, state.day) : [];
  const chosenBand =
    dayBands.find((band) => band.marker === state.bandMarker) ?? dayBands[0] ?? null;
  const programmeWindow =
    chosenBand && state.day ? windowFor(chosenBand, state.day, selected.timezone) : null;

  /**
   * D9. A day the Programme does not air is not "no filter": it is a window with
   * nothing in it. The list is not read at all, and — D10 — the draw is not
   * offered, because a hat built from a state with no window would hold the whole
   * promotion. This is the fail-open shape this project keeps finding, and this
   * is where it would have been.
   */
  const programmeSilent = Boolean(programme && state.day && dayBands.length === 0);

  /**
   * D8. The state every consumer reads. `day`/`band` stay on it for the links,
   * and `from`/`to` carry the window they name for the list, the draw hat and
   * the send-list filters — all three of which already read exactly these two
   * fields, which is what makes D10 true with no second mechanism.
   */
  const effective: ParticipationListState = programme
    ? { ...state, from: programmeWindow?.from, to: programmeWindow?.to }
    : state;
```

Then use `effective` — not `state` — for `listParticipationsPage`, for
`participationSendListFilters`, for `<ParticipationsFilters state={…}>` and for the
`DrawPanel`'s `state` prop. When `programmeSilent` is true, skip the list read entirely and
render an empty page object:

```tsx
  page = programmeSilent
    ? { rows: [], nextCursor: null, previousCursor: null, total: 0 }
    : await listParticipationsPage({ /* … as today, but reading `effective` */ }, accessToken);
```

and render the notice above the grid:

```tsx
  {programmeSilent && (
    <p className="mt-4 text-sm text-muted-foreground" data-testid="participation-programme-silent">
      {t('theProgrammeDoesNotAirOnThatDate', { programme: programme!.showName })}
    </p>
  )}
```

Guard the draw panel with `{!programmeSilent && canDraw && …}` wherever it renders today.

- [ ] **Step 5: Change the filter bar**

In `src/app/(app)/participations/participations-filters.tsx`, add two props —
`programme?: { showName: string; bands: ProgrammeBand[]; silent: boolean }` and keep
`timeZone` — and replace the two date labels with a conditional:

```tsx
      {programme ? (
        <>
          {/*
            Item 18. With a Programme, the range is not two instants: it is a DAY
            and one of that Programme's bands on it. "Entered until" is gone
            because the band's own end is the end — a second control would be a
            way to contradict it.
          */}
          <label className="flex w-44 flex-col gap-1 text-sm">
            <span className="text-muted-foreground">{t('enteredOn')}</span>
            <Input
              type="date"
              value={state.day ?? ''}
              onChange={(e) => navigate({ day: e.target.value || undefined, bandMarker: undefined })}
              aria-label={t('showEntriesMadeOnThisDate')}
              data-testid="participation-day-filter"
            />
          </label>

          <label className="flex w-56 flex-col gap-1 text-sm">
            <span className="text-muted-foreground">{t('programmeBand')}</span>
            <Select
              value={state.bandMarker !== undefined ? String(state.bandMarker) : ''}
              disabled={programme.bands.length === 0}
              onChange={(e) => navigate({ bandMarker: Number(e.target.value) })}
              data-testid="participation-band-filter"
            >
              {programme.bands.map((band) => (
                <option key={band.marker} value={band.marker}>
                  {band.label}
                  {band.overnight ? ` ${t('intoTheNextDay')}` : ''}
                </option>
              ))}
            </Select>
          </label>

          <p className="pb-2 text-xs text-muted-foreground" data-testid="participation-programme-window">
            {programme.silent
              ? t('theProgrammeDoesNotAirOnThatDate', { programme: programme.showName })
              : t('entriesInsideTheBandOf', { programme: programme.showName })}
          </p>
        </>
      ) : (
        <>{/* the two existing date labels, unchanged */}</>
      )}
```

`navigate` spreads `state`, so `day` and `bandMarker` reach `participationsHref` with
everything else. Clearing the day clears the band with it — a band marker with no day
names nothing.

- [ ] **Step 6: Add the catalogue keys**

`participations` namespace, all three files: `enteredOn`, `showEntriesMadeOnThisDate`,
`programmeBand`, `intoTheNextDay`, `entriesInsideTheBandOf`,
`theProgrammeDoesNotAirOnThatDate`.

English: `"Entered on"`, `"Show entries made on this date"`, `"Programme band"`,
`"(into the next day)"`, `"Only entries made inside this band of {programme}."`,
`"{programme} does not air on that date, so nothing was entered inside it."`

Portuguese: `"Participou em"`, `"Mostrar participações feitas nesta data"`, `"Faixa do programa"`,
`"(entra no dia seguinte)"`, `"Apenas participações feitas dentro desta faixa de {programme}."`,
`"{programme} não vai ao ar nessa data, então nada foi registrado dentro dela."`

Spanish: `"Participó el"`, `"Mostrar participaciones hechas en esta fecha"`, `"Franja del programa"`,
`"(entra en el día siguiente)"`, `"Solo participaciones hechas dentro de esta franja de {programme}."`,
`"{programme} no se emite en esa fecha, así que no se registró nada dentro de ella."`

- [ ] **Step 7: Run the guards and the journeys**

Run: `npm run test -- tests/unit && npm run typecheck && npm run lint`
Expected: PASS.

Run: `npm run test:e2e -- tests/e2e/participations-flow.spec.ts tests/e2e/filtered-draw.spec.ts`
Expected: PASS — both new cases, and every case `filtered-draw.spec.ts` already had.

- [ ] **Step 8: Commit**

```bash
git add "src/app/(app)/participations" messages tests/e2e
git commit -m "feat(30e): participations bounded by a Programme's band, and a draw that inherits it"
```

---

### Task 8: `0270` — where the entries come from

Spec D11, D12.

**Files:**
- Create: `supabase/migrations/0270_promotions_geography.sql`
- Create: `supabase/tests/76_promotions_geography.test.sql`

**Interfaces:**
- Consumes: `resolve_dashboard_period` (0117), `member_place_key` (0214), `geocoded_places` (0214).
- Produces: `public.get_promotions_geography(uuid[], text, date, date) returns jsonb`, payload `{ places, with_place, total, withheld }`.

- [ ] **Step 1: Write the migration**

Copy `0215`'s structure. The parts that differ, and must be written as they are here:

```sql
-- supabase/migrations/0270_promotions_geography.sql

-- Block 30e, item 19. Where a Station's entries come from.
--
-- SECURITY INVOKER, like the four aggregates before it: the caller's own RLS
-- still cuts every participation and every member this reads, so the function
-- cannot widen anybody's reach even if its own guard were wrong.
--
-- IT COUNTS THE PARTICIPATIONS CARD'S POPULATION, and that is the whole of D11:
-- every entry in the window, of EVERY status, exactly as get_promotions_dashboard
-- (0120) counts for the card the panel renders above this map. Counting only
-- VALID here would put a number under the map that no card on the panel agrees
-- with, while the coverage line compared two populations and looked like one --
-- the failure Block 8a's D12b exists to prevent.
--
-- TWO PERMISSIONS, AND NEITHER REFUSES. The panel's own gate is promotions.view,
-- and that one does refuse. participations.view decides whether the entries may
-- be counted at all, and members.view decides whether the listeners behind them
-- may be read: without EITHER, this returns a withheld payload naming the one
-- that is missing, rather than an empty map. An empty map would say "this
-- Station has no geography", which is a different and false claim.

create function public.get_promotions_geography(
  p_company_ids uuid[],
  p_preset      text default 'current_month',
  p_from        date default null,
  p_to          date default null
)
returns jsonb
language plpgsql
stable
set search_path = pg_catalog, public
as $$
declare
  v_ids          uuid[];
  v_id           uuid;
  v_consolidated boolean;
  v_missing      text := null;
  v_result       jsonb;
begin
  if p_company_ids is null or cardinality(p_company_ids) = 0 then
    raise exception 'at least one station is required' using errcode = '22023';
  end if;

  select array_agg(distinct s) into v_ids from unnest(p_company_ids) as t(s);
  v_consolidated := cardinality(v_ids) > 1;

  foreach v_id in array v_ids loop
    if not public.has_permission('promotions.view', v_id) then
      raise exception 'promotions.view is required in every station requested'
        using errcode = '42501';
    end if;
    if v_consolidated and not public.has_permission('reports.consolidated', v_id) then
      raise exception 'reports.consolidated is required in every station of a consolidated view'
        using errcode = '42501';
    end if;
    -- Not a refusal: the panel is withheld instead (D12), and it names which of
    -- the two is missing rather than a generic apology.
    if not public.has_permission('participations.view', v_id) then
      v_missing := 'participations.view';
    elsif v_missing is null and not public.has_permission('members.view', v_id) then
      v_missing := 'members.view';
    end if;
  end loop;

  if v_missing is not null then
    return jsonb_build_object(
      'places', '[]'::jsonb, 'with_place', 0, 'total', 0,
      'withheld', jsonb_build_array(jsonb_build_object('figure', 'places', 'needs', v_missing)));
  end if;

  with station as (
    select c.id, c.organization_id, c.name, c.timezone, c.country, p.*
      from public.companies c
      cross join lateral public.resolve_dashboard_period(p_preset, p_from, p_to, c.timezone) p
     where c.id = any(v_ids)
  ),
  -- The card's own predicate, copied rather than rewritten (D11): every status,
  -- the window half-open at both ends the way 0120 reads it.
  entry as (
    select p.id, p.member_id, p.promotion_id, s.country
      from public.participations p
      join station s on s.id = p.company_id
     where p.participated_at >= s.from_at
       and p.participated_at <  s.to_at
  ),
  -- The listener behind each entry, and the place that listener resolves to.
  -- `member_place_key` is called with exactly the arguments enqueue_missing_places
  -- (0214) uses, which is what makes the key here the key that was geocoded.
  placed as (
    select e.id, e.promotion_id,
           public.member_place_key(coalesce(m.country, e.country), m.state, m.city, m.neighbourhood) as place_key
      from entry e
      join public.members m
        on m.id = e.member_id and m.deleted_at is null and m.anonymized_at is null
  ),
  resolved as (
    select pl.id, pl.promotion_id, pl.place_key,
           g.city as place_city, g.neighbourhood as place_neighbourhood,
           g.latitude, g.longitude, g.precision
      from placed pl
      join public.geocoded_places g
        on g.place_key = pl.place_key and g.resolved_at is not null
  ),
  per_promotion as (
    select r.place_key, r.promotion_id, count(*)::int as n
      from resolved r group by r.place_key, r.promotion_id
  ),
  -- The one promotion a place played most. Ties broken by name, so two loads
  -- name the same one.
  top as (
    select distinct on (pp.place_key)
           pp.place_key, pr.name as top_promotion, pp.n as top_promotion_count
      from per_promotion pp
      join public.promotions pr on pr.id = pp.promotion_id
     order by pp.place_key, pp.n desc, pr.name
  ),
  places as (
    select jsonb_agg(row_to_json(t)::jsonb order by t.count desc, t.key) as rows
      from (
        select r.place_key           as key,
               r.place_city          as city,
               r.place_neighbourhood as neighbourhood,
               r.latitude::float8    as latitude,
               r.longitude::float8   as longitude,
               r.precision           as precision,
               count(*)::int         as count,
               max(tp.top_promotion) as top_promotion,
               max(tp.top_promotion_count) as top_promotion_count
          from resolved r
          join top tp on tp.place_key = r.place_key
         group by r.place_key, r.place_city, r.place_neighbourhood,
                  r.latitude, r.longitude, r.precision
      ) t
  )
  select jsonb_build_object(
    'places',     coalesce((select rows from places), '[]'::jsonb),
    -- `with_place` counts entries that reached a coordinate; `total` counts the
    -- entries the card counts, and is taken from `entry` — BEFORE the join to
    -- members — precisely so that an entry whose listener was deleted or
    -- anonymised still counts in the total. Taking it from `placed` would make
    -- this map's own denominator smaller than the card's number, which is the
    -- disagreement D11 forbids.
    'with_place', (select count(*)::int from resolved),
    'total',      (select count(*)::int from entry),
    'withheld',   '[]'::jsonb
  ) into v_result;

  return v_result;
end;
$$;

comment on function public.get_promotions_geography(uuid[], text, date, date) is
  'Block 30e, item 19. Where a Station''s entries come from: the places with a coordinate, how many entries those cover, the promotion most played in each, and the total the participations card counts. SECURITY INVOKER, so the caller''s own RLS cuts every row. `total` IS get_promotions_dashboard''s participations figure for the same window, every status included and counted before the join to members, because Block 8a''s D12b makes "every figure on this panel counts the same people" a rule. promotions.view refuses; participations.view and members.view withhold, naming which is missing, because an empty map would claim the Station has no geography.';

revoke execute on function public.get_promotions_geography(uuid[], text, date, date) from public;
grant execute on function public.get_promotions_geography(uuid[], text, date, date) to authenticated;
```

- [ ] **Step 2: Write the pgTAP file**

`supabase/tests/76_promotions_geography.test.sql`, `plan(8)`:

- `total` equals `(get_promotions_dashboard(...)->'cards'->'participations'->>'current')::int`
  for the same arguments — computed in the test from both functions, never hard-coded.
- an entry by a listener with no `geocoded_places` row is in `total` and not in `with_place`.
- an entry by a listener who was anonymised is in `total` and not in `with_place`.
- two entries from the same place group into one place with `count = 2`.
- `top_promotion` names the promotion with more entries in that place.
- without `participations.view`: `withheld` names `participations.view` and `places` is empty.
- without `members.view` (but with participations.view): `withheld` names `members.view`.
- without `promotions.view`: `throws_ok(..., '42501', ...)`.

- [ ] **Step 3: Run it and watch it fail, then pass**

Run: `npm run db:reset && npm run seed:branding && npm run db:test`
Expected: first FAIL on the missing function, then PASS 8 of 8 once the migration is in
place and the reset has applied it.

- [ ] **Step 4: Regenerate the types**

Run: `npm run db:types`

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/0270_promotions_geography.sql supabase/tests/76_promotions_geography.test.sql src/lib/supabase/database.types.ts
git commit -m "feat(30e): where a Station's entries come from, counted as the card beside it counts"
```

---

### Task 9: The map on the Promotions dashboard

Spec D11, D12, rendered.

**Files:**
- Modify: `src/schemas/geography.ts`
- Modify: `src/services/geography.ts`
- Modify: `src/app/(app)/dashboards/geography-panel.tsx`
- Modify: `src/app/(app)/dashboards/promotions/page.tsx`
- Modify: `messages/*.json`
- Test: `tests/e2e/dashboards-geography.spec.ts`

**Interfaces:**
- Consumes: `get_promotions_geography` (Task 8).
- Produces: `promotionsGeographySchema`; `PromotionsGeography`; `getPromotionsGeography(companyIds, period)`; `GeographyPanel` gains `subject?: 'listeners' | 'entries'` and accepts places carrying `top_promotion`.

- [ ] **Step 1: Write the failing e2e assertion**

In `tests/e2e/dashboards-geography.spec.ts`, beside the audience and music cases:

```ts
test('the promotions dashboard says where its entries came from', async ({ page }) => {
  await gotoPromotionsDashboard(page); // the helper this file already uses for the other panels

  const panel = page.getByTestId('geography-panel');
  await expect(panel).toBeVisible();
  // The coverage line names both numbers, and this panel's noun is entries.
  await expect(page.getByTestId('geography-coverage')).toContainText('entries');
  // Without a Maps key the tables carry the answer and one line says why.
  await expect(page.getByTestId('geography-map-unconfigured')).toBeVisible();
});
```

Match the existing testids in this file for the unconfigured line — if it has a different
name, use that one.

- [ ] **Step 2: Run it and watch it fail**

Run: `npm run test:e2e -- tests/e2e/dashboards-geography.spec.ts`
Expected: FAIL — no geography panel on that page.

- [ ] **Step 3: Add the schema**

In `src/schemas/geography.ts`:

```ts
export const promotionsGeographySchema = z.object({
  places: z.array(
    geographyPlace.extend({
      /** The promotion most played in this place — the line that makes this map differ from the audience one. */
      top_promotion: z.string().nullable(),
      top_promotion_count: z.number().int().nullable(),
    }),
  ),
  with_place: z.number().int(),
  /** D11: the participations card's own figure for the same window. */
  total: z.number().int(),
  /**
   * D12. Empty when both permissions are held; one entry naming
   * `participations.view` or `members.view` when one is not, so the panel can say
   * WHICH rather than rendering an empty map that claims the Station has none.
   */
  withheld: z.array(z.object({ figure: z.string(), needs: z.string() })),
});

export type PromotionsGeography = z.infer<typeof promotionsGeographySchema>;
export type PromotionsGeographyPlace = PromotionsGeography['places'][number];
```

- [ ] **Step 4: Add the service read**

In `src/services/geography.ts`, beside its two siblings:

```ts
export async function getPromotionsGeography(
  companyIds: string[],
  period: PeriodSelection,
): Promise<PromotionsGeography> {
  const supabase = await createUserClient();
  const { data, error } = await supabase.rpc(
    'get_promotions_geography',
    periodArgs(companyIds, period),
  );
  if (error) throw mapGeographyError(error.code, error.message);
  return promotionsGeographySchema.parse(data);
}
```

- [ ] **Step 5: Widen the panel by one noun and one line**

In `src/app/(app)/dashboards/geography-panel.tsx`, add a `subject` prop and a
`promotions` source:

```tsx
export async function GeographyPanel({
  title,
  places,
  withPlace,
  total,
  songs,
  /**
   * WHAT THE NUMBERS COUNT, named because the sentence changes with it: the
   * Audience and Music panels count listeners, and the Promotions panel counts
   * entries. A coverage line reading "412 of 1,208 listeners" under a map of
   * entries would be the same false claim the line exists to prevent.
   */
  subject = 'listeners',
}: {
  // ... existing props
  subject?: 'listeners' | 'entries';
}) {
```

- use `t(subject === 'entries' ? 'entriesCoverage' : 'placesCoverage', { withPlace, total })`
  for the coverage line;
- widen `mapSource`'s type with `top_promotion?: string | null; top_promotion_count?: number | null`;
- the first bubble line becomes
  `t(subject === 'entries' ? 'entriesHere' : 'listenersHere', { count: place.count })`;
- add the promotions line beside the song one:

```tsx
      ...(place.top_promotion && place.top_promotion_count
        ? [t('mostPlayedHere', { promotion: place.top_promotion, count: place.top_promotion_count })]
        : []),
```

- [ ] **Step 6: Render it on the page**

In `src/app/(app)/dashboards/promotions/page.tsx`, mirroring the audience page's narrow
read and the withheld idiom this page already uses for its five figures:

```tsx
  // A narrower failure than the cards above, deliberately: a geography read that
  // throws must cost the map and nothing else — the reasoning services/geography.ts
  // gives for living apart from services/dashboards.ts.
  let geography: PromotionsGeography | null = null;
  try {
    geography = await getPromotionsGeography(companyIds, selection);
  } catch (cause) {
    logger.error({ err: cause, companyIds }, 'could not load the promotions geography');
  }
```

and, below the existing panels:

```tsx
      {geography &&
        (geography.withheld.length > 0 ? (
          <Card className="mt-6" data-testid="geography-panel">
            <CardHeader>
              <CardTitle>{t('whereTheEntriesCameFrom')}</CardTitle>
            </CardHeader>
            <CardContent>
              {/* D12. Withheld rather than hidden: a panel that vanishes teaches
                  the operator that the Station has no geography. */}
              <WithheldFigure needs={geography.withheld[0]?.needs} />
            </CardContent>
          </Card>
        ) : (
          <GeographyPanel
            title={t('whereTheEntriesCameFrom')}
            places={geography.places}
            withPlace={geography.with_place}
            total={geography.total}
            songs={geography.places as never}
            subject="entries"
          />
        ))}
```

If passing the promotions places through the `songs` prop reads badly — it does — rename
that prop in the panel to `mapPlaces` in this same step and update the two existing
callers. One widened prop beats two shapes for one array.

- [ ] **Step 7: Add the catalogue keys**

`dashboards` namespace, all three files: `whereTheEntriesCameFrom`, `entriesCoverage`,
`entriesHere`, `mostPlayedHere`.

English: `"Where the entries came from"`,
`"{withPlace} of {total} entries are on this map."`, `"{count} entries here"`,
`"Most played here: {promotion} ({count})"`.

Portuguese: `"De onde vieram as participações"`,
`"{withPlace} de {total} participações estão neste mapa."`, `"{count} participações aqui"`,
`"Mais jogada aqui: {promotion} ({count})"`.

Spanish: `"De dónde vinieron las participaciones"`,
`"{withPlace} de {total} participaciones están en este mapa."`, `"{count} participaciones aquí"`,
`"Más jugada aquí: {promotion} ({count})"`.

- [ ] **Step 8: Run the guards and the journey**

Run: `npm run test -- tests/unit/i18n && npm run typecheck && npm run lint`
Run: `npm run test:e2e -- tests/e2e/dashboards-geography.spec.ts tests/e2e/dashboards.spec.ts`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/schemas/geography.ts src/services/geography.ts "src/app/(app)/dashboards" messages tests/e2e/dashboards-geography.spec.ts
git commit -m "feat(30e): the promotions dashboard says where its entries came from"
```

---

### Task 10: The documents, and the whole gate

**Files:**
- Modify: `docs/DATABASE.md` (a Block 30e section)
- Modify: `docs/PERMISSIONS.md` (the third surface of the Programmes gate)
- Test: every suite

- [ ] **Step 1: Write the DATABASE.md section**

After the `## Block 30d` section, add `## Block 30e — a week you can see, and a band that bounds a draw`,
covering, in the voice the neighbouring sections use:

- `promotion_show_schedule` (0269): what it is for, why SECURITY DEFINER, which permission
  it checks, and the two ordinary empty answers.
- `get_promotions_geography` (0270): SECURITY INVOKER, the two withholding permissions, and
  `total` being the participations card's own number.
- **Deploying this one:** both are read on the first render of a screen, so `npx supabase
  db push --linked` must run before anyone opens Participations with a Programme promotion
  or the Promotions dashboard.

- [ ] **Step 2: Add the third surface to PERMISSIONS.md**

In the existing "Programmes are gated on music" section, add a paragraph: Block 30e met the
same mismatch a third time, on the Participations band combo, and routed one read around it
with `promotion_show_schedule` rather than moving the gate. Name the three surfaces (the
screen, the promotion's Programme combobox, this combo) and say that the fourth should be
the one that decides it.

- [ ] **Step 3: Run every gate, in the order that gives an honest verdict**

```bash
npm run lint
npm run typecheck
npm run test
npm run db:reset && npm run seed:branding && npm run db:test
npm run test:isolation
npm run test:e2e
```

`db:test` goes BEFORE the e2e and isolation suites here on purpose: run after them it reads
rows they left behind and reports two false reds. `test:isolation` rarely reports all of its
files in one run — different files drop out each time with zero failures — so run the
missing ones separately and add up.

Expected: green everywhere. A red that names a test rather than a code path is suspect
before it is believed — check for a zombie `next dev` first.

- [ ] **Step 4: Commit and open the PR**

```bash
git add docs
git commit -m "docs(30e): the two new doors, and the third surface of the Programmes gate"
git push -u origin block-30e-schedule-and-map
gh pr create --title "Block 30e — the week you can see, the band that bounds a draw, and where the entries come from" --body "…"
```

The PR body states: the three items, the two migrations, and — first line — that `0269`
and `0270` must be pushed to the hosted database after the merge.

---

## Self-Review

**Spec coverage.** D1 → Task 3. D2 → Task 4 (page + board). D3 → Tasks 1, 2, 4. D4 → Tasks 2, 4.
D5 → Task 4. D6 → Task 4. D7 → Task 5. D8 → Tasks 6, 7. D9 → Task 7 (`programmeSilent`).
D10 → Task 7 (`effective` state reaching `DrawPanel`). D11 → Tasks 8, 9. D12 → Tasks 8, 9.
Migrations → Tasks 5, 8. Testing → each task's own steps, plus Task 10. Owner actions → Task 10.

**Two spec amendments this plan makes, both to be applied to the spec file in Task 4 and
Task 8 respectively:**

1. **D2** says the now-line is the one client component. It is not: the board is, because a
   block has to open the same record dialog the list opens and that dialog is driven by
   `useRecordDialog`. The geometry stays pure and server-computed; only drawing is client-side.
2. **D12** says the panel is withheld without `participations.view`. It must also be
   withheld without `members.view`: the map plots the listeners behind the entries, and a
   caller who cannot read members would otherwise get an empty map under a coverage line
   claiming a total — an empty map that says "no geography here" rather than "you may not
   see this".

**Type consistency.** `ScheduleRow` is `@/lib/shows/bands`' throughout. `GridShow` /
`GridBlock` / `WeekDay` come from `@/lib/shows/week-grid` and are used by that name in
Tasks 2, 4. `ProgrammeBand` is `@/lib/shows/programme-bands`' and is used by that name in
Tasks 6, 7. `showHref(state)` takes one argument from Task 3 on, and Task 4 calls it that
way. `ParticipationListState.bandMarker` is a number in both the parser and the filter bar.
