# Block 31a Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver the six screen adjustments of the owner's 2026-08-22 request — everything in it except moving a Station between Organizations.

**Architecture:** Five independent screen slices plus one integration change, sharing no state. The only server-side change is what two list reads project; everything else is components, catalogue keys and one Deezer field that was never read. No migrations.

**Tech Stack:** Next.js App Router (Server Components + Server Actions), TypeScript, Supabase/PostgREST with RLS, next-intl, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-08-22-block-31a-screens-design.md`
**Owner's request, verbatim:** `docs/superpowers/specs/2026-08-22-block-31-brief.md`

## Global Constraints

- **Branch:** `block-31a-screens`, already created from `main` at `1538f5e`.
- **No migrations in this block.** `birth_md` (`0257`), `promotions.show_id` (`0258`) and `reveal_member_field` (`0253`) all already exist. If a task seems to need one, stop and re-read the spec — it does not.
- **Every `t('key')` must exist in all three catalogues** — `messages/en.json`, `messages/es.json`, `messages/pt.json`. `tests/unit/i18n/catalogue.test.ts` fails when they disagree; `tests/unit/i18n/usage.test.ts` fails when code reads a key no catalogue holds. next-intl renders the key itself when a message is missing, so nothing else catches it.
- **The renamed buttons are `Member` / `Membro` / `Miembro`** — the owner's ruling of 2026-08-22, deliberately against the `Ouvinte` / `Oyente` the rest of the product uses for the same person (spec D8). Do not "fix" this to match the neighbouring column.
- **The e2e suite runs in `en-US`** (`playwright.config.ts`), so Playwright selectors use the English strings.
- **Code, comments, docs and commit messages in English.** Conversation with the owner is in Portuguese.
- **Never cite a line number in a comment** — cite the symbol.
- **Do not run `npm run db:test` immediately after the e2e or isolation suites** — both leave rows behind and pgTAP reads false reds from them. `npm run db:reset && npm run seed:branding` first.
- **Never edit a source file while the e2e suite is running.** Local runs use `next dev`; each edit recompiles, and a client-side navigation in flight during a recompile never receives its RSC payload, so `toHaveURL` times out in specs that have nothing to do with the edit.
- **Kill stray `next dev` processes before an e2e run.** A zombie holds port 3000 and grows past 6 GB; the suite then fails by TIMEOUT across unrelated specs, which reads as regression and is not.

---

### Task 1: The telephone number stops travelling with the Members list

Spec D1. Masking in the component would leave the whole number in the RSC payload of every page.

**Files:**
- Modify: `src/services/members.ts` (`MemberListRow`, `MEMBER_LIST_COLUMNS`, the row builder)
- Modify: `src/app/(app)/members/members-grid.tsx` (the column, `patchFromDetail`, `prependFromRecord`)
- Test: `tests/isolation/members.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `MemberListRow` loses `phone: string | null` and gains `phoneLast4: string | null`. Every later task reads the row by that name.

- [ ] **Step 1: Write the failing isolation test**

Append a case to `tests/isolation/members.test.ts`, inside the existing describe:

```ts
it('sends four digits of a telephone number to the browser, and never the number', async () => {
  const label = `members-last4-${Date.now()}`;
  const customer = await provisionCustomer(label);
  const owner = await signInAs(customer.email, customer.password);

  const created = await owner.rpc('create_member', {
    p_company_id: customer.companyId,
    p_full_name: `Phone Owner ${label}`,
    p_phone: '+5598999884321',
  });
  expect(created.error).toBeNull();

  const page = await listOrganizationMembers({ companyId: customer.companyId, /* … the shape this file's other calls use … */ });
  const row = page.rows.find((r) => r.fullName === `Phone Owner ${label}`);

  expect(row?.phoneLast4).toBe('4321');
  // THE ASSERTION THAT MATTERS, and the reason this is a service test rather
  // than a screen one: a row that still carried the whole number would render
  // identically once the column sliced it, and nothing on screen would fail.
  expect(row).not.toHaveProperty('phone');
  expect(JSON.stringify(row)).not.toContain('999884321');
});
```

Read the file first and match how its neighbours call the service — this suite drives services directly with a signed-in caller's token; copy that call shape rather than inventing one.

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run --config vitest.isolation.config.ts tests/isolation/members.test.ts`
Expected: FAIL — `row.phoneLast4` is undefined and the row still has `phone`.

- [ ] **Step 3: Narrow what the service returns**

In `src/services/members.ts`:

```ts
export interface MemberListRow {
  id: string;
  fullName: string | null;
  /**
   * Block 31a, D1. FOUR DIGITS, never the number.
   *
   * The list is narrowed HERE rather than masked in the grid, because a grid
   * that renders four digits out of a whole number leaves the whole number in
   * the payload that reached the browser — which is what `0254` exists to
   * prevent on Pickups, Participations and Requests, and what this screen was
   * deliberately left out of until the owner asked for it on 2026-08-22.
   *
   * THE SEARCH IS UNAFFECTED: it FILTERS on `phone` and `phone_normalized`
   * inside a query Postgres runs (see the `or` clauses below), and narrowing
   * what comes back narrows nothing about what can be looked for.
   */
  phoneLast4: string | null;
  email: string | null;
  // … the rest unchanged
}
```

Keep `phone` in `MEMBER_LIST_COLUMNS` — the column is what the search filters on, and PostgREST needs it selected for the row to be readable by the `or` clause. Slice it where the row is built:

```ts
    rows: rows.map((m) => ({
      id: m.id,
      fullName: m.full_name,
      // The one place the number becomes four digits. `slice(-4)` on a null is
      // not a thing, so the null survives as a null and the grid renders a dash.
      phoneLast4: m.phone ? m.phone.slice(-4) : null,
      email: m.email,
      // … the rest unchanged
    })),
```

- [ ] **Step 4: Render four digits, and slice in the two patch builders too**

In `src/app/(app)/members/members-grid.tsx`, the cell:

```tsx
                    <TableCell data-testid="member-phone">
                      {member.phoneLast4 ? `···${member.phoneLast4}` : '—'}
                    </TableCell>
```

`···` rather than a bare `4321`, matching the CPF cell one column over, which already reads `···${member.cpfLastDigits}`.

Then `patchFromDetail` and `prependFromRecord` — both build a `MemberListRow` out of a `MemberDetail`, which carries the whole number because the record dialog legitimately reads it:

```tsx
        // The DIALOG holds the whole number — it is the screen that administers
        // this listener and shows it unmasked. The LIST is what stopped carrying
        // it (D1), so the row this builds carries four digits like every other.
        phoneLast4: detail.phone ? detail.phone.slice(-4) : null,
```

- [ ] **Step 5: Run the isolation case and the typecheck**

Run: `npx vitest run --config vitest.isolation.config.ts tests/isolation/members.test.ts && npm run typecheck`
Expected: PASS both. The typecheck is what finds any other reader of `MemberListRow.phone`.

- [ ] **Step 6: Raise the isolation floor**

`scripts/verify-isolation-suite.mjs` carries a `minTests` floor per file, and it is a guard against deleted cases. Find the `tests/isolation/members.test.ts` entry, raise the number by one, and add a line to its comment saying what the new case pins: four digits reach the browser and the number does not.

- [ ] **Step 7: Commit**

```bash
git add src/services/members.ts "src/app/(app)/members/members-grid.tsx" tests/isolation/members.test.ts scripts/verify-isolation-suite.mjs
git commit -m "feat(31a): the Members list carries four digits, not a telephone number"
```

---

### Task 2: The birthday column, and the spec sentence it corrects

Spec D3 — with one correction the code forced, applied to the spec in this task.

**Files:**
- Modify: `src/app/(app)/members/members-grid.tsx`
- Modify: `docs/superpowers/specs/2026-08-22-block-31a-screens-design.md` (D3)
- Modify: `messages/en.json`, `messages/es.json`, `messages/pt.json`
- Test: `tests/e2e/birthday-filter.spec.ts`

**Interfaces:**
- Consumes: `MemberListRow` from Task 1 — unchanged by this task.
- Produces: nothing later tasks read.

- [ ] **Step 1: Correct D3 in the spec, before writing the code it describes**

The spec says the column reads `birth_md`. It should not, and the reason is worth writing down rather than silently doing something else: **the row already carries `birthDate`**, because the Age column is computed from it. Adding `birth_md` to the projection would send the same fact twice.

Replace D3's second paragraph with:

```markdown
The column is derived from `birth_date`, which the row ALREADY CARRIES — the Age
column beside it is computed from exactly that field. Adding `birth_md` to the
projection would put the same fact on the wire twice.

`members.birth_md` (`0257`, a generated `smallint` holding `MMDD`) stays what it
has been since Block 30b: the column the birthday WINDOW compares against in
SQL, where extracting month and day per row would cost an index. It is the
filter's column, not the display's, and this block does not touch it.
```

And add to the spec's Debt section:

```markdown
- **The grid still receives each listener's whole date of birth**, because the
  Age column has always been computed in the browser from it. Nobody asked for
  that to change and this block did not change it — but it is the same shape of
  fact D1 just narrowed one column over.
```

- [ ] **Step 2: Write the failing e2e assertion**

`tests/e2e/birthday-filter.spec.ts` already registers three listeners with known birth dates (31 December, 5 January, 4 July) and signs in. Add to that journey, right after the three rows are first asserted visible:

```ts
  // BLOCK 31a. The birthday itself, day and month, in the grid — so an operator
  // reading a filtered list can see WHY each row matched.
  await expect(rowFor(NYE_NAME)).toContainText('31/12');
  await expect(rowFor(JAN_NAME)).toContainText('05/01');

  // And the telephone column carries four digits at most (Task 1, D1).
  await expect(page.getByTestId('member-phone').first()).not.toContainText('999');
```

- [ ] **Step 3: Run it and watch it fail**

Run: `npx playwright test tests/e2e/birthday-filter.spec.ts`
Expected: FAIL — no cell contains `31/12`.

- [ ] **Step 4: Add the column**

In `src/app/(app)/members/members-grid.tsx`, a heading after `{t('age')}`:

```tsx
              <TableHead>{t('birthday')}</TableHead>
```

`COLUMN_COUNT` at the top of the file is the empty row's `colSpan` and must be raised by one — a number that has to be changed by hand with every column, and the "no listeners" row stops spanning the table when it is not.

The cell, beside the age one:

```tsx
                    <TableCell data-testid="member-birthday">{birthdayOf(member.birthDate)}</TableCell>
```

And the helper, beside `ageFromBirthDate` in the same file:

```tsx
/**
 * Block 31a. The day and month of a birth date, as `DD/MM`.
 *
 * SLICED FROM THE STRING rather than parsed into a Date: `birth_date` is a
 * Postgres `date` and arrives as `YYYY-MM-DD`, and `new Date('1990-12-31')` is
 * read as UTC midnight and then rendered in the browser's own zone — which
 * anywhere west of Greenwich prints the 30th. A birthday has no timezone.
 */
function birthdayOf(birthDate: string | null): string {
  if (!birthDate) return '—';
  const [, month, day] = birthDate.split('-');
  return month && day ? `${day}/${month}` : '—';
}
```

- [ ] **Step 5: Add the catalogue key**

`members` namespace, all three files: `birthday` → `"Birthday"` / `"Aniversário"` / `"Cumpleaños"`.

Check first whether the namespace already holds a `birthday` key — `birthdaysFrom` and `birthdaysTo` exist, and a bare `birthday` may too. Reuse it if it is there rather than adding a second.

- [ ] **Step 6: Run the guards and the journey**

Run: `npm run test -- tests/unit/i18n && npm run typecheck`
Run: `npx playwright test tests/e2e/birthday-filter.spec.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add "src/app/(app)/members/members-grid.tsx" messages docs tests/e2e/birthday-filter.spec.ts
git commit -m "feat(31a): the birthday, day and month, in the Members grid"
```

---

### Task 3: Day and month become two selects, and only in Birthday mode

Spec D4.

**Files:**
- Create: `src/app/(app)/members/month-day-fields.tsx`
- Modify: `src/app/(app)/members/members-filters.tsx`
- Modify: `messages/*.json`
- Test: `tests/unit/month-day-fields.test.ts`, `tests/e2e/birthday-filter.spec.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `MonthDayFields` — a client component taking `{ label: string; value: string | undefined; onChange: (monthDay: string | undefined) => void; testId: string }`, where `value` and the argument to `onChange` are the `MM-DD` the URL already carries, and `splitMonthDay(value)` / `joinMonthDay(month, day)` — the pure pair the test drives.

- [ ] **Step 1: Write the failing unit test**

Create `tests/unit/month-day-fields.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { joinMonthDay, splitMonthDay } from '@/app/(app)/members/month-day-fields';

/**
 * Block 31a, D4. The two selects speak the `MM-DD` the URL has carried since
 * Block 30b — a change of control, not of vocabulary.
 */
describe('the month and day of a birthday filter', () => {
  it('splits what the URL carries', () => {
    expect(splitMonthDay('12-20')).toEqual({ month: '12', day: '20' });
    expect(splitMonthDay('01-05')).toEqual({ month: '01', day: '05' });
  });

  it('treats an absent or unreadable value as neither month nor day', () => {
    expect(splitMonthDay(undefined)).toEqual({ month: '', day: '' });
    expect(splitMonthDay('')).toEqual({ month: '', day: '' });
    expect(splitMonthDay('nonsense')).toEqual({ month: '', day: '' });
  });

  it('pads both halves, because the URL and birth_md are two digits each', () => {
    // 1 January is `01-01`, never `1-1`: `birth_md` is MMDD as a number, and
    // the comparison the window makes in SQL is against 101, not 11.
    expect(joinMonthDay('1', '1')).toBe('01-01');
    expect(joinMonthDay('12', '20')).toBe('12-20');
  });

  it('answers undefined until BOTH halves are chosen', () => {
    // Half a date is not a bound. Sending `12-` would narrow the list by
    // something nobody asked for.
    expect(joinMonthDay('12', '')).toBeUndefined();
    expect(joinMonthDay('', '20')).toBeUndefined();
    expect(joinMonthDay('', '')).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm run test -- tests/unit/month-day-fields.test.ts`
Expected: FAIL — the module does not exist.

- [ ] **Step 3: Write the component and its pure pair**

Create `src/app/(app)/members/month-day-fields.tsx`:

```tsx
'use client';

import { useTranslations } from 'next-intl';
import { Select } from '@/components/ui/input';

/**
 * Block 31a, D4. A day and a month, with no year anywhere.
 *
 * HTML has no day-and-month control. Block 30b used `<input type="date">` with a
 * fixed placeholder year that the code sliced off — which works, and puts a year
 * on the screen that the filter ignores, which is the owner's own complaint.
 *
 * THE VALUE IS STILL `MM-DD`, the shape `bfrom`/`bto` have carried since Block
 * 30b, so a link pasted yesterday means today what it meant then.
 *
 * EVERY MONTH OFFERS 31 DAYS, deliberately. This is a filter BOUND, not a date:
 * `birth_md` simply holds nothing between 0931 and 1001, so a 31 September bound
 * narrows to the same set a 30 September one does. Shortening the day list per
 * month would make it change under the operator's hand every time they change
 * the month, to prevent an input that already means nothing.
 */
const DAYS = Array.from({ length: 31 }, (_, i) => String(i + 1).padStart(2, '0'));
const MONTHS = Array.from({ length: 12 }, (_, i) => String(i + 1).padStart(2, '0'));

/** The catalogue keys for the months, in order. `shell` already holds no month names; these are new. */
const MONTH_LABEL_KEYS = [
  'monthJanuary', 'monthFebruary', 'monthMarch', 'monthApril',
  'monthMay', 'monthJune', 'monthJuly', 'monthAugust',
  'monthSeptember', 'monthOctober', 'monthNovember', 'monthDecember',
] as const;

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
  const { month, day } = splitMonthDay(value);

  return (
    <label className="flex w-48 flex-col gap-1 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="flex gap-1">
        <Select
          value={day}
          onChange={(e) => onChange(joinMonthDay(month, e.target.value))}
          aria-label={`${label} — ${t('day')}`}
          data-testid={`${testId}-day`}
        >
          <option value="">{t('day')}</option>
          {DAYS.map((d) => (
            <option key={d} value={d}>{d}</option>
          ))}
        </Select>
        <Select
          value={month}
          onChange={(e) => onChange(joinMonthDay(e.target.value, day))}
          aria-label={`${label} — ${t('month')}`}
          data-testid={`${testId}-month`}
        >
          <option value="">{t('month')}</option>
          {MONTHS.map((m, index) => (
            <option key={m} value={m}>{t(MONTH_LABEL_KEYS[index] ?? 'monthJanuary')}</option>
          ))}
        </Select>
      </span>
    </label>
  );
}
```

- [ ] **Step 4: Run the unit test**

Run: `npm run test -- tests/unit/month-day-fields.test.ts`
Expected: PASS.

- [ ] **Step 5: Mount them in the filter bar, in Birthday mode only**

In `src/app/(app)/members/members-filters.tsx`, replace the two `<label>` blocks holding `member-date-from` and `member-date-to` with a conditional. The Registered branch is the two existing blocks, moved verbatim — same `Input`, same `startOfLocalDay` / `endOfLocalDay`, same testids:

```tsx
        {dateMode === 'birthday' ? (
          <>
            {/* D4. The year is gone from the screen because the filter never had
                one: `bfrom`/`bto` carry MM-DD and `birth_md` is MMDD. */}
            <MonthDayFields
              label={t('birthdaysFrom')}
              value={state.birthdayFrom}
              onChange={(monthDay) => navigate({ birthdayFrom: monthDay })}
              testId="member-birthday-from"
            />
            <MonthDayFields
              label={t('birthdaysTo')}
              value={state.birthdayTo}
              onChange={(monthDay) => navigate({ birthdayTo: monthDay })}
              testId="member-birthday-to"
            />
          </>
        ) : (
          <>{/* the two existing date labels, unchanged */}</>
        )}
```

The local `fromDay` / `toDay` state and the two effects that resync them from `state.birthdayFrom` / `state.birthdayTo` become dead for the birthday half — `MonthDayFields` reads `state` directly, and it has no debounce to protect. **Delete the two birthday effects, keep the two registered ones.** A `useState` mirroring a prop that nothing writes is how the two come to disagree.

- [ ] **Step 6: Add the catalogue keys**

`members` namespace, all three files: `day`, `month`, and `monthJanuary` … `monthDecember`.

English: `"Day"`, `"Month"`, `"January"` … `"December"`.
Portuguese: `"Dia"`, `"Mês"`, `"Janeiro"` … `"Dezembro"`.
Spanish: `"Día"`, `"Mes"`, `"Enero"`, `"Febrero"`, `"Marzo"`, `"Abril"`, `"Mayo"`, `"Junio"`, `"Julio"`, `"Agosto"`, `"Septiembre"`, `"Octubre"`, `"Noviembre"`, `"Diciembre"`.

- [ ] **Step 7: Rewrite the journey's filter steps**

`tests/e2e/birthday-filter.spec.ts` fills `member-date-from` with `2000-12-20` today. In birthday mode those boxes no longer exist. Replace those two fills and their URL waits with:

```ts
  await page.getByTestId('member-birthday-from-day').selectOption('20');
  await page.getByTestId('member-birthday-from-month').selectOption('12');
  await expect(page).toHaveURL(/bfrom=12-20/);

  await page.getByTestId('member-birthday-to-day').selectOption('05');
  await page.getByTestId('member-birthday-to-month').selectOption('01');
  await expect(page).toHaveURL(/bto=01-05/);
  await expect(page).toHaveURL(/bfrom=12-20/);
  await expect(page).toHaveURL(/dates=birthday/);
```

Keep every assertion that follows — the three-way split (two listeners either side of new year, the July one absent) is the whole point of that file and none of it changes.

Note the ORDER: day first, then month. Choosing the day alone sends no bound (`joinMonthDay` answers undefined), so the URL only changes on the second select — which is why the `toHaveURL` waits sit where they do.

- [ ] **Step 8: Run the guards and the journey**

Run: `npm run test -- tests/unit && npm run test -- tests/unit/i18n && npm run typecheck && npm run lint`
Run: `npx playwright test tests/e2e/birthday-filter.spec.ts tests/e2e/members-flow.spec.ts`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add "src/app/(app)/members" messages tests
git commit -m "feat(31a): a day and a month, with no year anywhere"
```

---

### Task 4: Promotions gains Refresh and a Programme column

Spec D5 and D6.

**Files:**
- Modify: `src/services/promotions.ts` (`PromotionSummary`, the list projection, the row builder)
- Modify: `src/app/(app)/promotions/promotions-grid.tsx`
- Modify: `src/app/(app)/promotions/promotions-filters.tsx`
- Modify: `messages/*.json`
- Test: `tests/e2e/promotions-flow.spec.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `PromotionSummary` gains `showId: string | null` and `showName: string | null`.

- [ ] **Step 1: Write the failing e2e assertions**

`tests/e2e/promotions-flow.spec.ts` already provisions a Station and registers a promotion. Add, after the promotions list is on screen:

```ts
  // BLOCK 31a. A promotion with no Programme says so with a dash, and the
  // Refresh button asks the same question again without losing the filters.
  await expect(page.getByTestId('promotion-programme').first()).toHaveText('—');
  await page.getByTestId('refresh').click();
  await expect(page.getByTestId('promotion-row').first()).toBeVisible();
```

Match the row testid this file already uses; if it is not `promotion-row`, use the one that is.

- [ ] **Step 2: Run it and watch it fail**

Run: `npx playwright test tests/e2e/promotions-flow.spec.ts`
Expected: FAIL — no `promotion-programme` cell.

- [ ] **Step 3: Widen the list projection**

In `src/services/promotions.ts`, in `listPromotionsPage`'s `build`, add the two fields to the select string:

```ts
        'id,name,starts_at,ends_at,cancelled_at,whatsapp_enabled,web_enabled,rules,hashtag,site_integration_code,thumb_url,deleted_at,show_id,shows(name)',
```

and on the row built from it:

```ts
      showId: row.show_id,
      // NULL FOR TWO DIFFERENT REASONS, and the column downstream tells them
      // apart (D6): this promotion has no Programme, or `shows` was cut by the
      // caller's own RLS. `shows_select_music_view` (0099) gates that table on
      // `music.view`, which somebody who administers Promotions need not hold.
      showName: row.shows?.name ?? null,
```

Add both fields to `PromotionSummary` with that same comment on `showName`, and widen the row type the select is cast through.

- [ ] **Step 4: Render three states, not two**

In `src/app/(app)/promotions/promotions-grid.tsx`, a heading beside the others:

```tsx
              <TableHead>{t('programme')}</TableHead>
```

and the cell:

```tsx
                  <TableCell data-testid="promotion-programme">
                    {/* D6. An empty cell would claim this promotion has no
                        Programme, which for a caller without `music.view` is
                        false — the name is what they cannot read, not the link.
                        `show_id` comes back either way, so the two are told
                        apart here rather than collapsed into one dash. */}
                    {promotion.showId === null ? (
                      '—'
                    ) : promotion.showName ? (
                      promotion.showName
                    ) : (
                      <span className="text-muted-foreground" title={t('theProgrammeNameNeedsMusicView')}>
                        {t('notVisible')}
                      </span>
                    )}
                  </TableCell>
```

Raise this grid's own empty-row `colSpan` constant by one.

- [ ] **Step 5: Mount Refresh**

In `src/app/(app)/promotions/promotions-filters.tsx`: import `RefreshButton` from `@/components/ui/refresh-button` and render `<RefreshButton />` as the last child of the filter row, exactly where `participations-filters.tsx` puts it — after the Clear filters link, inside the same flex container.

- [ ] **Step 6: Add the catalogue keys**

`promotions` namespace, all three files: `programme`, `notVisible`, `theProgrammeNameNeedsMusicView`.

English: `"Programme"`, `"Not visible"`, `"This promotion belongs to a Programme whose name needs the music.view permission."`
Portuguese: `"Programa"`, `"Não visível"`, `"Esta promoção pertence a um Programa cujo nome exige a permissão music.view."`
Spanish: `"Programa"`, `"No visible"`, `"Esta promoción pertenece a un Programa cuyo nombre requiere el permiso music.view."`

- [ ] **Step 7: Run the guards and the journey**

Run: `npm run test -- tests/unit/i18n && npm run typecheck && npm run lint`
Run: `npx playwright test tests/e2e/promotions-flow.spec.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/services/promotions.ts "src/app/(app)/promotions" messages tests/e2e/promotions-flow.spec.ts
git commit -m "feat(31a): the Programme a promotion belongs to, and a Refresh beside its filters"
```

---

### Task 5: The pencil, and the two actions that move into it

Spec D7. The request's items 3 to 6 for Pickups, plus its Refresh and its rename.

**Files:**
- Create: `src/app/(app)/pickups/pickup-record-dialog.tsx`
- Modify: `src/app/(app)/pickups/pickups-grid.tsx`
- Modify: `src/app/(app)/pickups/pickups-filters.tsx`
- Modify: `messages/*.json`
- Test: `tests/e2e/delivery-flow.spec.ts`

**Interfaces:**
- Consumes: `WinnerActions` and `WinnerPowers` from `@/components/draws/winner-actions` — unchanged by this block.
- Produces: `PickupRecordDialog`, taking `{ row, powers, drawStatus, timeZone, onAct, onClose }` where `row` is the pickup row type `pickups-grid.tsx` already maps and `onAct` is the grid's existing `(winnerId, action, reason) => Promise<string | null>`.

- [ ] **Step 1: Write the failing e2e assertions**

In `tests/e2e/delivery-flow.spec.ts`, in the journey that reaches `/pickups`:

```ts
  // BLOCK 31a. The two destructive actions leave the row and move behind a
  // pencil, in front of a summary that names what they would act on.
  await expect(page.getByTestId('pickup-row').first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Return to stock' })).toHaveCount(0);

  await page.getByTestId('pickup-edit').first().click();
  await expect(page.getByTestId('pickup-record-dialog')).toBeVisible();
  // The summary names the prize and the promotion before anything is pressed.
  await expect(page.getByTestId('pickup-record-dialog')).toContainText(prizeName);
  await expect(page.getByTestId('pickup-record-dialog')).toContainText(promotionName);
  await expect(page.getByRole('button', { name: 'Return to stock' })).toBeVisible();

  // And the renamed button is the one that opens the listener.
  await page.getByRole('button', { name: 'Close' }).click();
  await expect(page.getByTestId('pickup-view-listener')).toHaveText('Member');
```

Use the `prizeName` / `promotionName` variables this file already defines for its fixture; if the strings differ, use its own.

- [ ] **Step 2: Run it and watch it fail**

Run: `npx playwright test tests/e2e/delivery-flow.spec.ts`
Expected: FAIL — `pickup-edit` does not exist.

- [ ] **Step 3: Write the dialog**

Create `src/app/(app)/pickups/pickup-record-dialog.tsx`:

```tsx
'use client';

import { useTranslations } from 'next-intl';
import { Dialog, DialogBody, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { WinnerActions, type WinnerAction, type WinnerPowers } from '@/components/draws/winner-actions';

/**
 * Block 31a, item 4 of the owner's Pickups list. What a prize is, before
 * anything is done to it.
 *
 * IT MOUNTS `WinnerActions` RATHER THAN REIMPLEMENTING IT (D7). Return to stock
 * and Write off as lost keep their own confirmation, their mandatory reason,
 * their refusal messages and their audit rows, because they are still the same
 * component calling the same server action into `apply_winner_transition`. What
 * changed is WHERE it is mounted: on the row there was nothing on screen naming
 * what was about to be returned or written off, and the strip's reason box was
 * shared per row — the defect Block 30a recorded and left alone.
 *
 * `deliver` and `reopenDeadline` stay false here for the reason the row already
 * gives: this screen hands over through `hand-over-dialog.tsx`, which carries the
 * receipt field, and reopens through `ReopenForm`, which carries the new date.
 */
export interface PickupRecordRow {
  winnerId: string;
  promotionName: string;
  memberName: string | null;
  memberPhoneLast4: string | null;
  prizeName: string;
  status: string;
  deadlineLabel: string;
  allowsReturnToStock: boolean;
  drawStatus: 'COMPLETED' | 'CANCELLED';
}

export function PickupRecordDialog({
  row,
  powers,
  onAct,
  onClose,
}: {
  row: PickupRecordRow;
  powers: WinnerPowers;
  onAct: (action: WinnerAction, reason: string) => Promise<string | null>;
  onClose: () => void;
}) {
  const t = useTranslations('pickups');
  const tv = useTranslations('vocab');

  return (
    <Dialog open onClose={onClose} data-testid="pickup-record-dialog">
      <DialogHeader>
        <DialogTitle>{t('thePrize')}</DialogTitle>
      </DialogHeader>
      <DialogBody className="flex flex-col gap-4">
        <dl className="grid grid-cols-2 gap-3 text-sm">
          <Field label={t('promotion')} value={row.promotionName} />
          <Field label={t('prize')} value={row.prizeName} />
          {/* Four digits, like the grid behind it: this window is not a way
              around this screen's own masking. */}
          <Field
            label={t('listener')}
            value={`${row.memberName ?? '—'}${row.memberPhoneLast4 ? ` ···${row.memberPhoneLast4}` : ''}`}
          />
          <Field label={t('status')} value={tv(row.status)} />
          <Field label={t('deadline')} value={row.deadlineLabel} />
        </dl>

        <WinnerActions
          status={row.status}
          allowsReturnToStock={row.allowsReturnToStock}
          powers={{ ...powers, deliver: false, handOver: false, reopenDeadline: false }}
          drawStatus={row.drawStatus}
          onAct={onAct}
        />
      </DialogBody>
    </Dialog>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="font-medium">{value}</dd>
    </div>
  );
}
```

Read `src/components/ui/dialog.tsx` first and match its real prop list — `ShowRecordDialog` and `HandOverDialog` are the two nearest callers, and whatever they pass is what this passes. Same for `WinnerPowers`' real field names: read `winner-actions.tsx` rather than trusting the names above.

The status label goes through the `vocab` namespace only if that is where the pickup statuses already live — `pickups-grid.tsx` renders a status badge today, and this must use the SAME translation it does, not a second one.

- [ ] **Step 4: Rewire the row**

In `src/app/(app)/pickups/pickups-grid.tsx`:

1. The listener button's label becomes `{t('member')}` and its `aria-label` `{t('openTheMember')}`. Its `data-testid` and its `onClick` do not change.
2. A pencil button beside it, only when the row has an action to offer — `availableWinnerActions` with `deliver`/`handOver`/`reopenDeadline` forced false is exactly the predicate, so it is the one to ask rather than a second rule:

```tsx
                    {availableWinnerActions({
                      status: row.status,
                      allowsReturnToStock: row.allowsReturnToStock,
                      powers: { ...winnerPowers, deliver: false, handOver: false, reopenDeadline: false },
                      drawStatus: row.drawStatus,
                    }).length > 0 && (
                      <button
                        type="button"
                        aria-label={t('openThisPrize')}
                        onClick={() => setRecordWinnerId(row.winnerId)}
                        data-testid="pickup-edit"
                        className="rounded-md p-1.5 ring-offset-background hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                      >
                        <Pencil className="size-4" aria-hidden="true" />
                      </button>
                    )}
```

3. The `<WinnerActions …>` element that sits in the row is REMOVED — that is item 5 of the request. `ReopenForm` and the Hand over button stay where they are.
4. Mount the dialog beside the other two, driven by a `recordWinnerId` state resolved against `grid.rows` the same way `handOverRow` already is.

Import `Pencil` from `lucide-react` and `availableWinnerActions` from `@/components/draws/winner-actions`.

- [ ] **Step 5: Mount Refresh**

In `src/app/(app)/pickups/pickups-filters.tsx`: `<RefreshButton />` as the last child of the filter row, as in Task 4.

- [ ] **Step 6: Add the catalogue keys**

`pickups` namespace, all three files: `member`, `openTheMember`, `openThisPrize`, `thePrize`.

English: `"Member"`, `"Open the member"`, `"Open this prize"`, `"Prize"`.
Portuguese: `"Membro"`, `"Abrir o membro"`, `"Abrir este prêmio"`, `"Prêmio"`.
Spanish: `"Miembro"`, `"Abrir el miembro"`, `"Abrir este premio"`, `"Premio"`.

`Membro` / `Miembro` is the owner's ruling (D8) and is deliberately not `Ouvinte` / `Oyente`.

- [ ] **Step 7: Run the guards and the journeys**

Run: `npm run test -- tests/unit/i18n && npm run typecheck && npm run lint`
Run: `npx playwright test tests/e2e/delivery-flow.spec.ts tests/e2e/deadline.spec.ts`
Expected: PASS. `deadline.spec.ts` drives the reopen path on this same screen and must still pass untouched.

- [ ] **Step 8: Commit**

```bash
git add "src/app/(app)/pickups" messages tests/e2e
git commit -m "feat(31a): a pencil that shows the prize before the two actions that dispose of it"
```

---

### Task 6: Two more buttons say Member

Spec D8.

**Files:**
- Modify: `src/app/(app)/music/requests/requests-grid.tsx`
- Modify: `src/app/(app)/participations/participations-grid.tsx`
- Modify: `messages/*.json`
- Test: `tests/e2e/music-requests.spec.ts`, `tests/e2e/participations-flow.spec.ts`

**Interfaces:**
- Consumes: nothing. Produces: nothing.

- [ ] **Step 1: Write the failing assertions**

In `tests/e2e/music-requests.spec.ts`, where the listener button is already exercised:

```ts
  await expect(page.getByTestId('request-view-listener')).toHaveText('Member');
```

In `tests/e2e/participations-flow.spec.ts`, likewise:

```ts
  await expect(page.getByTestId('participation-view-listener')).toHaveText('Member');
```

Use each file's own testid for that button — read it rather than assuming the names above.

- [ ] **Step 2: Run them and watch them fail**

Run: `npx playwright test tests/e2e/music-requests.spec.ts tests/e2e/participations-flow.spec.ts`
Expected: FAIL — both read `View`.

- [ ] **Step 3: Rename**

In both grids the button's text becomes `{t('member')}` and its `aria-label` `{t('openTheMember')}`. Nothing else about either button changes — same handler, same testid, same permission gate.

- [ ] **Step 4: Add the keys**

`music` (or whichever namespace `requests-grid.tsx` reads) and `participations`, all three files: `member` and `openTheMember`, with the same three values Task 5 used.

- [ ] **Step 5: Run the guards and the journeys**

Run: `npm run test -- tests/unit/i18n && npm run typecheck`
Run: `npx playwright test tests/e2e/music-requests.spec.ts tests/e2e/participations-flow.spec.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add "src/app/(app)/music/requests" "src/app/(app)/participations" messages tests/e2e
git commit -m "feat(31a): the listener button says Member on Requests and Participations"
```

---

### Task 7: The search stops offering covers Deezer marks in a field nobody read

Spec D9.

**Files:**
- Modify: `src/lib/integrations/deezer/transport.ts` (`DeezerTrack`, `EXCLUDED_TITLE_TERMS`, `isExcludedTitle`)
- Modify: `src/lib/integrations/deezer/client.ts` (`toTrack`, the search filter)
- Test: `tests/unit/deezer-*.test.ts` — the file that already covers the title exclusion

**Interfaces:**
- Consumes: nothing. Produces: `DeezerTrack` gains `version: string | null`; `isExcludedRecording(title: string, version: string | null): boolean` joins `isExcludedTitle`, which keeps its own signature and its own callers.

- [ ] **Step 1: Find the existing test and write the failing cases**

Run: `grep -rln "isExcludedTitle" tests/unit`

In that file, add:

```ts
describe('a recording Deezer marks as a cover in its version field', () => {
  it('is excluded even when the title says nothing', () => {
    // The case the owner reported: the title is clean and the mark is in the
    // field `toTrack` never read.
    expect(isExcludedRecording('Evidências', '(Cover Version)')).toBe(true);
    expect(isExcludedRecording('Evidências', 'Cover Version')).toBe(true);
  });

  it('keeps a version that is not a cover', () => {
    expect(isExcludedRecording('Evidências', '(Live)')).toBe(false);
    expect(isExcludedRecording('Evidências', 'Radio Edit')).toBe(false);
    expect(isExcludedRecording('Evidências', null)).toBe(false);
  });

  it('still judges the title, which is where Block 24 found them', () => {
    expect(isExcludedRecording('Evidências (Karaoke)', null)).toBe(true);
    expect(isExcludedRecording('Evidências (Cover)', null)).toBe(true);
  });

  it('does not take the words that contain the word', () => {
    // Block 24's own reason for bracketing: `cover` sits inside these, and a
    // real recording is called "Cover Me".
    expect(isExcludedRecording('Undercover', null)).toBe(false);
    expect(isExcludedRecording('Discovery', null)).toBe(false);
    expect(isExcludedRecording('Cover Me', null)).toBe(false);
  });
});
```

`Cover Me` is the case that decides the term list: `cover version` as two words does not match it, and a bare `cover` would.

- [ ] **Step 2: Run them and watch them fail**

Run: `npm run test -- <that file>`
Expected: FAIL — `isExcludedRecording` is not exported.

- [ ] **Step 3: Read the field, and judge the pair**

In `src/lib/integrations/deezer/transport.ts`:

```ts
export interface DeezerTrack {
  // … existing fields
  /**
   * Deezer's own version marker — `(Cover Version)`, `(Live)`, `(Radio Edit)`.
   *
   * Block 31a read it because Block 24's exclusion could not: a recording whose
   * TITLE is clean and whose version says Cover Version arrived looking like the
   * original, which is what the owner reported on 2026-08-22.
   */
  version: string | null;
}
```

```ts
/**
 * `cover version` is the one UNBRACKETED term, and it is safe where the bare
 * word is not: it is two words, so it cannot sit inside "Undercover" or
 * "Discovery", and the recording called "Cover Me" does not contain it either.
 */
const EXCLUDED_TITLE_TERMS = [
  'karaoke', 'cover)', '(cover', 'cover]', '[cover', 'cover version',
] as const;

/**
 * Whether a recording is a karaoke backing track or a cover, judged by its title
 * AND the version field beside it.
 *
 * Applied to SEARCH RESULTS ONLY — `track(id)` must keep answering, or a song
 * already registered in a Station's catalogue becomes unresolvable. That rule is
 * Block 24's and this function does not change it; see `isExcludedTitle`.
 */
export function isExcludedRecording(title: string, version: string | null): boolean {
  return isExcludedTitle(version ? `${title} ${version}` : title);
}
```

`isExcludedTitle` keeps its own signature and its own comment: it is still the rule, and `isExcludedRecording` is the pair it is now applied to.

In `src/lib/integrations/deezer/client.ts`, `toTrack` gains `version: text(track.version) ?? null`, and the search's last filter becomes:

```ts
          .filter((track) => !isExcludedRecording(track.title, track.version)),
```

- [ ] **Step 4: Run the unit tests**

Run: `npm run test -- tests/unit`
Expected: PASS, including every case the file already had.

- [ ] **Step 5: Check the fake transport**

`src/lib/integrations/deezer/fake.ts` builds `DeezerTrack` objects for the tests that do not reach the network. A new required field breaks it — add `version: null` to every literal it builds, and give one of its fixtures a `(Cover Version)` if the file has a search fixture worth extending.

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/integrations/deezer tests/unit
git commit -m "feat(31a): the search reads the field a cover hides in"
```

---

### Task 8: The documents, and the whole gate

**Files:**
- Modify: `docs/PERMISSIONS.md`
- Test: every suite

- [ ] **Step 1: Record the fourth surface**

In `docs/PERMISSIONS.md`'s "Programmes are gated on music" section, add a paragraph: Block 31a met the mismatch a fourth time, on the Promotions grid's new Programme column, and answered it by SAYING LESS rather than by opening a door — the cell distinguishes "no Programme" from "you may not read its name", because `show_id` comes back even when the embedded `shows(name)` is cut by RLS. Name the four surfaces and keep the sentence that says the decision is still owed.

- [ ] **Step 2: Run every gate, in the order that gives an honest verdict**

```bash
npm run lint
npm run typecheck
npm run test
npm run db:reset && npm run seed:branding && npm run db:test
npm run test:isolation
npm run test:e2e
```

`db:test` goes BEFORE the e2e and isolation suites on purpose: run after them it reads rows they left behind and reports false reds. `test:isolation` rarely reports all of its files in one run — different files drop out each time with zero failures — so run the missing ones separately and add up. A red that names a test rather than a code path is suspect before it is believed: check for a zombie `next dev` first.

- [ ] **Step 3: Commit and open the PR**

```bash
git add docs
git commit -m "docs(31a): the fourth surface of the Programmes gate, answered by saying less"
git push -u origin block-31a-screens
gh pr create --title "Block 31a — the number that stops travelling, the day nobody typed, and the covers the search kept offering" --body "…"
```

The PR body states the six items, and — first line — that this block has **no migrations**, so nothing has to be pushed to the hosted database after the merge.

---

## Self-Review

**Spec coverage.** D1 → Task 1. D2 → Task 1 (no reveal is what is NOT built; the spec records why). D3 → Task 2, which also corrects the spec's own mechanism. D4 → Task 3. D5 → Tasks 4 and 5. D6 → Task 4. D7 → Task 5. D8 → Tasks 5 and 6. D9 → Task 7. "No migrations" → asserted in the Global Constraints and re-stated in Task 8's PR body. Testing section → each task's own steps plus Task 8.

**One spec amendment this plan makes**, applied in Task 2 Step 1: D3 says the birthday column reads `birth_md`. It reads `birth_date`, which the row already carries for the Age column — projecting `birth_md` as well would put the same fact on the wire twice. `birth_md` remains what Block 30b built it for: the column the WINDOW compares against in SQL.

**Type consistency.** `MemberListRow.phoneLast4` is named that in Tasks 1, 2 and 3. `PromotionSummary.showId` / `showName` are named that in Task 4 only. `PickupRecordRow` and `PickupRecordDialog` are Task 5's and are read nowhere else. `isExcludedRecording(title, version)` is Task 7's, and `isExcludedTitle` keeps its own signature so Block 24's existing callers and tests are untouched.
