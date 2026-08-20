# Block 30b — Refresh and Birthdays Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Refresh button that re-runs the query already on screen, on Participations, Members and Requests; and a Birthday mode on Members that answers "whose birthday falls in this window", including a window that crosses new year.

**Architecture:** The birthday comparison needs a column, because the Members listing is PostgREST and not an RPC — so a generated stored `birth_md smallint`, the same device `phone_normalized` already is on that table, with a partial index. The wrap/no-wrap decision is a pure function tested without a database. Refresh is `router.refresh()` from one shared component, which re-runs the Server Component for the current URL and leaves filters, sort and cursor exactly where they were.

**Tech Stack:** PostgreSQL 17 (RLS, pgTAP), Next.js 15 App Router (Server Components, `typedRoutes`), TypeScript, next-intl, Playwright, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-20-block-30b-refresh-and-birthdays-design.md`

## Global Constraints

- Comments explain WHY, never WHAT. **A comment that states something false is a defect of the same severity as false code.** Block 30a closed **six** of these in eight tasks, four of them in text its plan supplied. Every factual claim you write must be true at the commit that carries it, and a citation that names a file:line must resolve.
- No new user-facing English strings outside `messages/{en,pt,es}.json`. All three catalogues get every key; `catalogue.test.ts` is the guard. A duplicate key in one JSON object is not a compiler error — the later one silently wins, so check before adding.
- `src/lib/supabase/database.types.ts` is generated, never hand-edited. Regenerate with `npm run db:types`.
- One string literal for a PostgREST `.select(...)`, never a concatenation — the types are inferred from the literal.
- pgTAP `plan(N)` is the file's **running total**, not the number a task adds.
- Gate order is `npm run db:reset` → `npm run db:test` → `npm run test:isolation`, then `npm run test:e2e`. `db:test` after either of the other two gives a red that is not code.
- **`npm run db:reset` wipes the storage bucket.** Run `npm run seed:branding` before any e2e run, or `login.spec.ts` fails on a 400 that is not code.
- Every conditionally rendered `<Button>` gets a distinct `key`. Two in one JSX slot let React reuse the DOM node and the survivor inherits `type="submit"` — this project has shipped that defect and it recorded participations on click.
- Migrations already merged are never edited in place. Next free migration number: **0257**. Next free pgTAP file number: **70**.

## Run every suite in the FOREGROUND

Never background a suite and never poll for one. In Block 30a a suite was auto-moved to the background at the ten-second mark and the agent waited for a completion notification that could not arrive. **If a command is auto-backgrounded on you, stop immediately and report `NEEDS_CONTEXT` naming it** — the controller will run it and hand you the result. That is a normal outcome, not a failure.

## The trap this plan exists to avoid

**A control bound to server state un-selects itself on click.** This project has shipped it: a checkbox whose `checked` came from the URL state reverted the moment the operator clicked, because the click changed nothing the server sent back. The mode selector here has exactly that shape — choose **Birthday**, type no dates yet, and if the mode were *derived* from "are there birthday parameters in the URL", the selector would snap back to **Registered** on the next navigation.

So the mode is an **explicit URL parameter** (`dates=birthday`), not an inference from which dates are present. Task 3 states this in the code; do not "simplify" it away.

## File Structure

| File | Responsibility |
|---|---|
| `supabase/migrations/0257_members_birth_md.sql` | The generated column, its partial index, its `comment on column` |
| `supabase/tests/70_birthday_window.test.sql` | pgTAP for the column and the index |
| `src/lib/members/birthday.ts` | Pure: `MM-DD` → `smallint`, and the window's five shapes. No React, no Next, no database |
| `src/services/members.ts` | The four query branches |
| `src/app/(app)/members/list-params.ts` | `dateMode`, `birthdayFrom`, `birthdayTo`, and their URL round trip |
| `src/app/(app)/members/members-filters.tsx` | The mode selector and the relabelled boxes |
| `src/components/ui/refresh-button.tsx` | One button, three screens |

---

### Task 1: The column a birthday can be compared on

**Files:**
- Create: `supabase/migrations/0257_members_birth_md.sql`, `supabase/tests/70_birthday_window.test.sql`
- Modify: `src/lib/supabase/database.types.ts` (regenerated)

**Interfaces:**
- Produces: `public.members.birth_md smallint` (generated, stored, nullable) and `members_birth_md_idx`.

- [ ] **Step 1: Write the failing pgTAP**

Create `supabase/tests/70_birthday_window.test.sql`:

```sql
begin;
select plan(7);

-- Block 30b. A birthday is a day of the year, so the screen needs a day of the
-- year to compare against. This file proves the derivation and the index, not
-- the filter -- the filter is a PostgREST predicate and belongs to
-- tests/isolation/members.test.ts, which can run it as a real caller.

insert into public.organizations (id, name) values
  ('00000000-0000-0000-0000-00000000b0f1', 'Org 30b');

insert into public.members (id, organization_id, full_name, birth_date) values
  ('00000000-0000-0000-0000-00000000b0d1', '00000000-0000-0000-0000-00000000b0f1', 'Fim de ano',    '1990-12-31'),
  ('00000000-0000-0000-0000-00000000b0d2', '00000000-0000-0000-0000-00000000b0f1', 'Comeco de ano', '1988-01-05'),
  ('00000000-0000-0000-0000-00000000b0d3', '00000000-0000-0000-0000-00000000b0f1', 'Bissexto',      '2000-02-29'),
  ('00000000-0000-0000-0000-00000000b0d4', '00000000-0000-0000-0000-00000000b0f1', 'Sem data',      null);

-- 1-4: the derivation, including the two cases that are easy to get wrong.
select is((select birth_md from public.members where id = '00000000-0000-0000-0000-00000000b0d1'),
  1231::smallint, '31 December is 1231');
select is((select birth_md from public.members where id = '00000000-0000-0000-0000-00000000b0d2'),
  105::smallint, '5 January is 105, not 501 -- month first, and no zero padding to worry about');
-- 29 FEBRUARY NEEDS NO SPECIAL CASE, and this assertion is what says so: it is
-- 229, and any window spanning 28 February to 1 March contains it.
select is((select birth_md from public.members where id = '00000000-0000-0000-0000-00000000b0d3'),
  229::smallint, '29 February is 229 like any other day');
select is((select birth_md from public.members where id = '00000000-0000-0000-0000-00000000b0d4'),
  null, 'no birth date derives no day -- this listener is invisible to the filter, by construction');

-- 5: it is GENERATED, so it cannot be written by hand and cannot drift from
-- birth_date. A plain column maintained by whoever remembers is the failure
-- 0031 already argues about phone_normalized.
select throws_ok($$
  update public.members set birth_md = 101
   where id = '00000000-0000-0000-0000-00000000b0d1'
$$, '428C9', null, 'birth_md cannot be written directly');

-- 6: and it follows birth_date when that changes.
update public.members set birth_date = '1975-07-04'
 where id = '00000000-0000-0000-0000-00000000b0d1';
select is((select birth_md from public.members where id = '00000000-0000-0000-0000-00000000b0d1'),
  704::smallint, 'the derivation follows its source');

-- 7: the index the filter leans on. Asserted by name because a query plan is
-- not stable enough to assert and the absence of the index would show up as a
-- whole-Organization scan nobody notices until the audience is large.
select is(
  (select count(*)::int from pg_indexes
    where schemaname = 'public' and indexname = 'members_birth_md_idx'),
  1, 'members_birth_md_idx exists');

select * from finish();
rollback;
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm run db:reset && npm run db:test`
Expected: FAIL — `column "birth_md" does not exist`.

- [ ] **Step 3: Write the migration**

Create `supabase/migrations/0257_members_birth_md.sql`:

```sql
-- supabase/migrations/0257_members_birth_md.sql

-- Block 30b, D2/D3. The day of the year a listener was born, so that "whose
-- birthday falls in this window" can be asked of an index instead of of every
-- row in the Organization.
--
-- A BIRTHDAY IS NOT A BIRTH DATE, and that distinction is the whole reason this
-- column exists. "Born between two dates" is already answerable on this screen:
-- the age band converts a band into a birth_date range and leans on
-- members_birth_date_idx (0036). What could NOT be asked was the question
-- somebody has before sending a greeting -- who has a birthday next week --
-- because that ignores the year.
--
-- GENERATED, NOT MAINTAINED. The same device phone_normalized and
-- email_normalized already are on this table, for the reason 0031 states in
-- writing: "a normalisation applied by whoever remembers is a normalisation
-- that drifts". A month-and-day derived in the browser, in the service and in
-- SQL would be three places to disagree.
--
-- A COLUMN RATHER THAN AN EXPRESSION INDEX, because the Members listing is
-- PostgREST (services/members.ts, `.from('members').select(...)`) and a
-- predicate there must name a column. An expression index would be unreachable
-- from the only caller, and moving the whole listing to an RPC to gain one
-- would be a far larger change than the feature.
--
-- smallint: the largest value this can hold is 1231.
--
-- THIS REWRITES THE TABLE. `add column ... generated always as ... stored` takes
-- an ACCESS EXCLUSIVE lock for the duration. Accepted rather than discovered:
-- this product's installations are one Station or a small group, and 0031 did
-- the same rewrite twice for the two normalisation columns.
alter table public.members
  add column birth_md smallint
  generated always as (
    (extract(month from birth_date) * 100 + extract(day from birth_date))::smallint
  ) stored;

comment on column public.members.birth_md is
  'The birthday as MMDD (31 December is 1231, 5 January is 105), derived from birth_date and never written by hand. Exists because the Members listing is PostgREST and a birthday window -- which ignores the year -- cannot be expressed there as a predicate on birth_date itself. Null when birth_date is null, which is why a listener nobody asked for a birth date is absent from the birthday filter rather than wrongly included. 29 February is 229 and needs no special case.';

-- PARTIAL, on exactly the rows the screen can reach: a null birth_md can never
-- satisfy the filter, and a soft-deleted listener is already unselectable
-- (members_select_reachable, 0035).
create index members_birth_md_idx on public.members (birth_md)
  where birth_md is not null and deleted_at is null;
```

- [ ] **Step 4: Run it and watch it pass**

Run: `npm run db:reset && npm run db:test`
Expected: PASS, including `70_birthday_window`.

> `428C9` is verified, not assumed: probed against the local database on a throwaway generated column, Postgres answers `428C9 — column "md" can only be updated to DEFAULT`.

- [ ] **Step 5: Regenerate the types**

Run: `npm run db:types && npm run typecheck`
Expected: `birth_md` appears on the `members` row type; typecheck green.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/0257_members_birth_md.sql supabase/tests/70_birthday_window.test.sql src/lib/supabase/database.types.ts
git commit -m "feat(30b): the day of the year a listener was born"
```

---

### Task 2: The window, as a pure function

**Files:**
- Create: `src/lib/members/birthday.ts`, `tests/unit/members-birthday.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type BirthdayWindow =
    | { kind: 'none' }
    | { kind: 'from'; from: number }
    | { kind: 'to'; to: number }
    | { kind: 'between'; from: number; to: number }
    | { kind: 'wraps'; from: number; to: number };
  export function birthdayCode(monthDay: string | undefined): number | null;
  export function birthdayWindow(from: string | undefined, to: string | undefined): BirthdayWindow;
  ```

- [ ] **Step 1: Write the failing test**

Create `tests/unit/members-birthday.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { birthdayCode, birthdayWindow } from '@/lib/members/birthday';

describe('birthdayCode', () => {
  it('reads MM-DD as the number the column holds', () => {
    expect(birthdayCode('12-31')).toBe(1231);
    expect(birthdayCode('01-05')).toBe(105);
    expect(birthdayCode('02-29')).toBe(229);
  });

  it('refuses anything that is not a real day, rather than guessing', () => {
    expect(birthdayCode('13-01')).toBeNull();
    expect(birthdayCode('00-10')).toBeNull();
    expect(birthdayCode('01-32')).toBeNull();
    expect(birthdayCode('1-5')).toBeNull();
    expect(birthdayCode('nonsense')).toBeNull();
    expect(birthdayCode(undefined)).toBeNull();
  });

  it('accepts 29 February, because the column stores a day and not a date', () => {
    expect(birthdayCode('02-29')).toBe(229);
  });

  it('accepts 31 of a 30-day month rather than validating a calendar it does not have', () => {
    // A hand-edited URL saying 04-31 is nobody's birthday, so it matches
    // nothing. Refusing it here would be a second calendar to keep correct.
    expect(birthdayCode('04-31')).toBe(431);
  });
});

describe('birthdayWindow', () => {
  it('is none when neither end is set', () => {
    expect(birthdayWindow(undefined, undefined)).toEqual({ kind: 'none' });
  });

  it('is open-ended when only one end is set', () => {
    expect(birthdayWindow('12-20', undefined)).toEqual({ kind: 'from', from: 1220 });
    expect(birthdayWindow(undefined, '01-05')).toEqual({ kind: 'to', to: 105 });
  });

  it('is a plain range when the days are in calendar order', () => {
    expect(birthdayWindow('03-01', '03-31')).toEqual({ kind: 'between', from: 301, to: 331 });
  });

  it('WRAPS when the end falls before the start — the end-of-year window', () => {
    expect(birthdayWindow('12-20', '01-05')).toEqual({ kind: 'wraps', from: 1220, to: 105 });
  });

  it('treats one day as a range of one, not as a wrap', () => {
    expect(birthdayWindow('07-04', '07-04')).toEqual({ kind: 'between', from: 704, to: 704 });
  });

  it('drops an unreadable end rather than filtering on a guess', () => {
    expect(birthdayWindow('13-01', '01-05')).toEqual({ kind: 'to', to: 105 });
    expect(birthdayWindow('12-20', 'nope')).toEqual({ kind: 'from', from: 1220 });
    expect(birthdayWindow('13-01', 'nope')).toEqual({ kind: 'none' });
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm test -- tests/unit/members-birthday.test.ts`
Expected: FAIL — `Failed to resolve import "@/lib/members/birthday"`.

- [ ] **Step 3: Write the module**

Create `src/lib/members/birthday.ts`:

```ts
/**
 * Block 30b. A birthday window, as the Members screen asks it.
 *
 * PURE, so the branch that decides wrap-or-not can be proved without a database
 * or a browser. That branch is where the off-by-one lives: `from > to` is not a
 * mistake to reject but the end-of-year window — 20 December to 5 January — and
 * a filter that refused it would be wrong for the season it exists to serve.
 *
 * NOTHING HERE IS A BOUNDARY. What a caller may read is decided by
 * members_select_reachable (0035); this module only decides which days the
 * question is about.
 */

/** The five shapes the two boxes can produce. */
export type BirthdayWindow =
  | { kind: 'none' }
  | { kind: 'from'; from: number }
  | { kind: 'to'; to: number }
  | { kind: 'between'; from: number; to: number }
  | { kind: 'wraps'; from: number; to: number };

const MONTH_DAY = /^(\d{2})-(\d{2})$/;

/**
 * `MM-DD` as the number `members.birth_md` holds (0257), or null.
 *
 * IT DOES NOT VALIDATE A CALENDAR, and that is deliberate rather than lax. The
 * column stores a DAY OF THE YEAR, not a date, so 29 February is an ordinary
 * value that must be accepted; and 31 April, which nobody is born on, simply
 * matches nothing. Rejecting impossible days here would mean carrying a second
 * calendar and keeping it in step with Postgres's, to prevent an empty result
 * that is already empty.
 *
 * What it DOES reject is anything that is not two digits, a dash and two
 * digits, with the month in 01-12 and the day in 01-31 — because those reach a
 * numeric comparison, and a value outside that range would silently widen or
 * narrow the window rather than being ignored.
 */
export function birthdayCode(monthDay: string | undefined): number | null {
  const match = MONTH_DAY.exec(monthDay ?? '');
  if (!match) return null;

  const month = Number(match[1]);
  const day = Number(match[2]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;

  return month * 100 + day;
}

/**
 * The two boxes as one window.
 *
 * An unreadable end is DROPPED rather than failing the whole filter: the two
 * boxes are independent, and a hand-edited URL with one broken value should
 * still answer the half that is readable rather than silently listing everybody.
 */
export function birthdayWindow(
  from: string | undefined,
  to: string | undefined,
): BirthdayWindow {
  const start = birthdayCode(from);
  const end = birthdayCode(to);

  if (start === null && end === null) return { kind: 'none' };
  if (start === null) return { kind: 'to', to: end as number };
  if (end === null) return { kind: 'from', from: start };

  // EQUAL IS A RANGE OF ONE, NOT A WRAP. `from > to` is the wrap; `from === to`
  // is somebody asking about a single day, and routing it through the wrap
  // branch would answer "every day of the year except the ones in between",
  // which is the exact opposite.
  return start <= end
    ? { kind: 'between', from: start, to: end }
    : { kind: 'wraps', from: start, to: end };
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `npm test -- tests/unit/members-birthday.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/members/birthday.ts tests/unit/members-birthday.test.ts
git commit -m "feat(30b): the window, and the wrap that is not a mistake"
```

---

### Task 3: The filter reaches the database

**Files:**
- Modify: `src/services/members.ts`, `src/app/(app)/members/list-params.ts`, `tests/isolation/members.test.ts`, `scripts/verify-isolation-suite.mjs`

**Interfaces:**
- Consumes: `birthdayWindow` from Task 2; `members.birth_md` from Task 1.
- Produces: `MemberListState.dateMode: 'registered' | 'birthday'`, `MemberListState.birthdayFrom?: string`, `MemberListState.birthdayTo?: string`; URL parameters `dates`, `bfrom`, `bto`; `MemberListParams.birthdayFrom` / `.birthdayTo` on the service.

- [ ] **Step 1: Write the failing isolation cases**

Append to `tests/isolation/members.test.ts`, inside the existing listing describe:

```ts
  /**
   * Block 30b D2. The wrap is the case worth a live database: it is the one
   * the two-branch predicate exists for, and folding the branches into a single
   * `between` would answer the exact complement of the right set — every day of
   * the year EXCEPT the ones asked for — while still looking like a working
   * filter on a mid-year window.
   */
  it('finds birthdays across new year, and only those', async () => {
    const label = `birthday-${Date.now()}`;
    const customer = await provisionCustomer(label);
    const owner = await signInAs(customer.email, customer.password);

    const inWindow = [
      await createMemberAs(customer, `${label} NYE`, { birthDate: '1990-12-31' }),
      await createMemberAs(customer, `${label} Jan`, { birthDate: '1988-01-05' }),
    ];
    const outside = await createMemberAs(customer, `${label} Jul`, { birthDate: '1979-07-04' });

    const wrapped = await listMembersPageAs(owner, customer, {
      birthdayFrom: '12-20',
      birthdayTo: '01-05',
    });
    const ids = wrapped.rows.map((r) => r.id);
    for (const id of inWindow) expect(ids).toContain(id);
    expect(ids).not.toContain(outside);

    // The same predicate, not wrapping, must NOT behave like the wrap branch.
    const plain = await listMembersPageAs(owner, customer, {
      birthdayFrom: '07-01',
      birthdayTo: '07-31',
    });
    const plainIds = plain.rows.map((r) => r.id);
    expect(plainIds).toContain(outside);
    for (const id of inWindow) expect(plainIds).not.toContain(id);
  });

  /**
   * A listener nobody asked for a birth date is absent, not wrongly included.
   * The column is null for them (0257) and null satisfies neither branch — but
   * a future "improvement" that coalesced it to 0 would sweep every such
   * listener into every January window.
   */
  it('leaves out a listener with no birth date on file', async () => {
    const label = `birthday-none-${Date.now()}`;
    const customer = await provisionCustomer(label);
    const owner = await signInAs(customer.email, customer.password);
    const nameless = await createMemberAs(customer, `${label} unknown`, {});

    const page = await listMembersPageAs(owner, customer, {
      birthdayFrom: '01-01',
      birthdayTo: '12-31',
    });
    expect(page.rows.map((r) => r.id)).not.toContain(nameless);
  });
```

> **Two corrections to the snippet above, both verified — apply them rather than the snippet's shorthand.**
>
> `createMemberAs` is `(customer, companyId, fields)` — **three** arguments, with the Station id second (`tests/isolation/harness.ts:304-315`). The calls above omit it; write `createMemberAs(customer, customer.companyId, { fullName: … })`.
>
> Its `fields` object has **no birth date**: it carries `fullName`, `phone`, `email`, `cpfHash`, `cpfLastDigits`, `passport`. Add `birthDate?: string` to it and pass it through as `p_birth_date` — the underlying `create_member` RPC already accepts that parameter (`supabase/migrations/0034_member_rpcs.sql:68`), so this is widening the helper to reach a door that is already open, not changing the door. Do **not** reach for `admin.from('members').update(...)`: it has no grant, because `0035_rls_members.sql:209` revokes write on `members` from `service_role` — Block 30a's Task 3 hit exactly that.
>
> `listMembersPageAs` is this plan's shorthand for however `tests/isolation/members.test.ts` already calls the listing. Use that file's own idiom rather than introducing a helper.

- [ ] **Step 2: Run them and watch them fail**

Run: `npm run test:isolation`
Expected: FAIL — the birthday parameters are not read, so every listener comes back.

- [ ] **Step 3: Widen the service**

In `src/services/members.ts`, add to `MemberListParams` beside `ageMin`/`ageMax`:

```ts
  /**
   * `MM-DD`, inclusive. A DAY OF THE YEAR, not a date — see birthday.ts. The
   * age band above answers "born between two dates"; this answers "has a
   * birthday in this window", which is a different question and the one a
   * greeting is sent from.
   */
  birthdayFrom?: string;
  birthdayTo?: string;
```

and inside `build`, immediately after the age band block so the two read together:

```ts
    // Block 30b D2. Two branches, and the second is the point: a window whose
    // end falls before its start is the end-of-year window (20 December to 5
    // January), not an operator mistake. Collapsing these into one `between`
    // would return the complement of the right set.
    //
    // birth_md is GENERATED from birth_date (0257) and indexed partially, so
    // this is an index scan rather than a per-row derivation — the same reason
    // the age band above is a range and not a computed age.
    const window = birthdayWindow(params.birthdayFrom, params.birthdayTo);
    if (window.kind === 'from') q = q.gte('birth_md', window.from);
    else if (window.kind === 'to') q = q.lte('birth_md', window.to);
    else if (window.kind === 'between')
      q = q.gte('birth_md', window.from).lte('birth_md', window.to);
    else if (window.kind === 'wraps')
      // Interpolated without quoting because both values are integers this
      // module produced from a matched /^\d{2}-\d{2}$/ — never operator text.
      q = q.or(`birth_md.gte.${window.from},birth_md.lte.${window.to}`);
```

with `import { birthdayWindow } from '@/lib/members/birthday';` at the top.

- [ ] **Step 4: Widen the URL state**

In `src/app/(app)/members/list-params.ts`:

Add to `MemberSearchParams`: `dates?: string; bfrom?: string; bto?: string;`

Add to `MemberListState`:

```ts
  /**
   * Which question the two date boxes ask. EXPLICIT IN THE URL, and not
   * inferred from whether `bfrom`/`bto` are present — that inference is the
   * defect this project has already shipped once, in a different control: a
   * selector whose value is derived from server state snaps back the moment
   * the operator changes it and has not yet typed anything, because nothing
   * they changed came back. Choosing Birthday with no dates yet is a real
   * state and the URL has to be able to hold it.
   */
  dateMode: 'registered' | 'birthday';
  /** `MM-DD`. A day of the year — see src/lib/members/birthday.ts. */
  birthdayFrom?: string;
  birthdayTo?: string;
```

In the parser, beside `registeredFrom`/`registeredTo`:

```ts
    dateMode: raw.dates === 'birthday' ? 'birthday' : 'registered',
    birthdayFrom: raw.bfrom,
    birthdayTo: raw.bto,
```

In `membersHref`, beside the `from`/`to` lines:

```ts
  if (state.dateMode === 'birthday') query.set('dates', 'birthday');
  if (state.birthdayFrom) query.set('bfrom', state.birthdayFrom);
  if (state.birthdayTo) query.set('bto', state.birthdayTo);
```

In `hasActiveFilters`, add `state.birthdayFrom || state.birthdayTo` to the disjunction. **`dateMode` alone is NOT an active filter** — choosing Birthday and typing nothing narrows nothing, and a Clear-filters button appearing for it would offer to clear something that is not filtering.

Thread `birthdayFrom` / `birthdayTo` from the page's state into the `listMembersPage` call, beside the existing `registeredFrom`/`registeredTo`.

- [ ] **Step 5: Raise the isolation floor**

In `scripts/verify-isolation-suite.mjs`, bump `minTests` for `tests/isolation/members.test.ts` from 21 to 23. A case added without a floor bump can later be deleted for free.

- [ ] **Step 6: Run the gate, in order**

Run: `npm run typecheck && npm run lint && npm test && npm run db:reset && npm run db:test && npm run test:isolation`
Expected: all green.

- [ ] **Step 7: Commit**

```bash
git add src/services/members.ts src/app/\(app\)/members/list-params.ts tests/isolation/members.test.ts scripts/verify-isolation-suite.mjs
git commit -m "feat(30b): the birthday window reaches the database, wrap and all"
```

---

### Task 4: The mode selector

**Files:**
- Modify: `src/app/(app)/members/members-filters.tsx`, `messages/{en,pt,es}.json`

**Interfaces:**
- Consumes: `MemberListState.dateMode`, `.birthdayFrom`, `.birthdayTo` and `membersHref` from Task 3.

- [ ] **Step 1: Add the catalogue keys**

Under `members` in all three catalogues. **Check each before adding — a duplicate silently wins.** `registeredFrom` and `registeredTo` already exist and are reused.

| key | en | pt | es |
|---|---|---|---|
| `dateFilter` | Date filter | Filtro de data | Filtro de fecha |
| `dateModeRegistered` | Registered | Cadastro | Registro |
| `dateModeBirthday` | Birthday | Aniversário | Cumpleaños |
| `birthdaysFrom` | Birthdays from | Aniversários de | Cumpleaños desde |
| `birthdaysTo` | Birthdays to | Aniversários até | Cumpleaños hasta |

- [ ] **Step 2: Add the selector and switch the labels**

In `members-filters.tsx`, above the two date boxes:

```tsx
        <label className="flex w-40 flex-col gap-1 text-sm">
          <span className="text-muted-foreground">{t('dateFilter')}</span>
          <Select
            value={state.dateMode}
            onChange={(e) => {
              const mode = e.target.value === 'birthday' ? 'birthday' : 'registered';
              // SWITCHING CLEARS THE OTHER WINDOW. Two live windows would show a
              // count nobody can account for from what is on screen, and the
              // boxes can only display one of them.
              navigate(
                mode === 'birthday'
                  ? { dateMode: mode, registeredFrom: undefined, registeredTo: undefined }
                  : { dateMode: mode, birthdayFrom: undefined, birthdayTo: undefined },
              );
            }}
            data-testid="member-date-mode"
          >
            <option value="registered">{t('dateModeRegistered')}</option>
            <option value="birthday">{t('dateModeBirthday')}</option>
          </Select>
        </label>
```

The two existing boxes become mode-aware. Their label and their `navigate` payload change; **the `type="date"` input does not**, because an operator picks a day from a calendar either way — only the year is ignored in Birthday mode:

```tsx
        <label className="flex w-48 flex-col gap-1 text-sm">
          <span className="text-muted-foreground">
            {state.dateMode === 'birthday' ? t('birthdaysFrom') : t('registeredFrom')}
          </span>
          <Input
            type="date"
            value={fromDay}
            onChange={(e) => {
              const day = e.target.value;
              setFromDay(day);
              navigate(
                state.dateMode === 'birthday'
                  ? { birthdayFrom: monthDayOf(day) }
                  : { registeredFrom: startOfLocalDay(day) },
              );
            }}
            data-testid="member-date-from"
          />
        </label>
```

and the same shape for the `to` box with `birthdaysTo` / `registeredTo`, `monthDayOf(day)` / `endOfLocalDay(day)`, `data-testid="member-date-to"`.

> **Renaming those two test ids is safe, and checked:** `grep -rn "member-registered-" tests/ src/` returns only the two `data-testid` attributes in `members-filters.tsx` itself — no spec references them. The rename to `member-date-*` is worth making, because after this task the boxes are no longer about registration alone and an id that says they are would be the same kind of lie this project treats a false comment as.

Add the two local-state effects for the birthday values, mirroring the existing `fromDay`/`toDay` effects, so browser back/forward leaves the boxes agreeing with the list — the reason the existing ones exist, stated in that file at the `fromDay` declaration.

And the pure helper, beside `toDayInput` in the same file:

```tsx
/**
 * A `<input type="date">` value as the day of the year the URL carries.
 *
 * The year is DISCARDED here rather than on the server, for the same reason the
 * registration range is converted here: the input's value is a wall-clock day
 * with no zone, and anything that re-parses it elsewhere risks interpreting it
 * in a different one. Slicing the string touches no clock at all.
 */
function monthDayOf(value: string): string | undefined {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value.slice(5) : undefined;
}
```

- [ ] **Step 3: Prove it**

Run: `npm run typecheck && npm run lint && npm test`
Expected: green, including `catalogue.test.ts`.

- [ ] **Step 4: Commit**

```bash
git add src/app/\(app\)/members/members-filters.tsx messages
git commit -m "feat(30b): the two date boxes learn a second question"
```

---

### Task 5: One button, three screens

**Files:**
- Create: `src/components/ui/refresh-button.tsx`
- Modify: `src/app/(app)/members/members-filters.tsx`, `src/app/(app)/participations/participations-filters.tsx`, `src/app/(app)/music/requests/requests-filters.tsx`, `messages/{en,pt,es}.json`

**Interfaces:**
- Produces: `<RefreshButton />` — no props.

- [ ] **Step 1: Write the component**

Create `src/components/ui/refresh-button.tsx`:

```tsx
'use client';

import { useTranslations } from 'next-intl';
import { useTransition } from 'react';
import { useRouter } from 'next/navigation';

/**
 * Block 30b D1. Ask the same question again.
 *
 * `router.refresh()` RATHER THAN A NAVIGATION TO THE SAME URL: Next treats
 * navigating to an identical URL as a no-op, while `refresh()` re-fetches the
 * Server Components for the current route and re-renders them with client state
 * intact. It also drives the effect each grid already has — every one of them
 * resets its locally patched rows from `initialRows` when a new page arrives —
 * so nothing new has to be taught about when local state yields to server
 * state.
 *
 * IT PRESERVES THE CURSOR, and that is the decision rather than an omission. An
 * operator three pages into a list who presses this is asking about THIS page;
 * returning them to the first one would lose their place to answer a question
 * they did not ask.
 *
 * The pending state is not decoration. A refresh that looks like nothing
 * happened gets pressed again, and again.
 */
export function RefreshButton() {
  // `shell`, verified: it is this product's cross-cutting UI namespace — it
  // already holds `sortedAscending`, `noPictureYet`, `settings` and the theme
  // labels, all strings that belong to no one screen. There is no `common`
  // namespace in this repository.
  const t = useTranslations('shell');
  const router = useRouter();
  const [pending, start] = useTransition();

  return (
    <button
      type="button"
      onClick={() => start(() => router.refresh())}
      disabled={pending}
      className="rounded-md border px-3 py-1.5 text-sm ring-offset-background hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:opacity-60"
      data-testid="refresh"
    >
      {pending ? t('refreshing') : t('refresh')}
    </button>
  );
}
```

- [ ] **Step 2: Add the catalogue keys**

Under **`shell`** in all three catalogues — verified as the cross-cutting namespace, and verified that neither key is already there:

`refresh` — en *Refresh* / pt *Atualizar* / es *Actualizar*.
`refreshing` — en *Refreshing…* / pt *Atualizando…* / es *Actualizando…*.

- [ ] **Step 3: Mount it on all three bars**

In each of `members-filters.tsx`, `participations-filters.tsx` and `requests-filters.tsx`, beside the existing Clear-filters control at the end of the bar:

```tsx
      <RefreshButton />
```

**Unconditional**, unlike Clear filters — there is always a current query to re-run. It is a `<button>` next to a conditional `<Link>`, which are different element types and so cannot collide in the way two conditional `<Button>`s can; add nothing to work around a hazard that is not there.

- [ ] **Step 4: Prove it**

Run: `npm run typecheck && npm run lint && npm test`
Expected: green.

- [ ] **Step 5: Commit**

```bash
git add src/components/ui/refresh-button.tsx src/app/\(app\)/members src/app/\(app\)/participations src/app/\(app\)/music/requests messages
git commit -m "feat(30b): a button that re-asks, on the three screens that asked for one"
```

---

### Task 6: The journey, and the documents

**Files:**
- Create: `tests/e2e/birthday-filter.spec.ts`
- Modify: `docs/DATABASE.md`

**Interfaces:**
- Consumes: `member-date-mode`, `member-date-from`, `member-date-to` (or the preserved `member-registered-*` ids — read Task 4's report), and `refresh`.

- [ ] **Step 1: Write the journey**

Create `tests/e2e/birthday-filter.spec.ts`, following a neighbouring spec's sign-in and seeding idiom. One journey:

1. Register three listeners: born 31 December, 5 January, 4 July.
2. Open `/members`, switch `member-date-mode` to Birthday, set the window 20 December → 5 January.
3. Assert the two end-of-year listeners are listed and the July one is not. **This is the assertion the whole block turns on** — a single-branch predicate would show the July listener and hide the other two.
4. Press `refresh`. Assert the same three-way result still holds and the URL is unchanged — the filter survived, and so did the page.

- [ ] **Step 2: Run it**

Run: `npm run db:reset && npm run seed:branding && npm run test:e2e -- birthday-filter`
Expected: PASS.

> `db:reset` wipes the storage bucket; without `seed:branding` a later `login.spec.ts` fails on a 400 that is not code. A first Playwright run can also fail on a cold Next compile rather than an assertion — read the failure before concluding anything. If a stale `next dev` holds the port and answers 500s, kill the **server** process, not a task wrapper.

- [ ] **Step 3: Document the column**

In `docs/DATABASE.md`, beside the `members` table's other generated columns, record `birth_md`: what it holds, that it is generated and cannot be written, that it is null when `birth_date` is null and what that means for the filter, and why it exists rather than an expression index.

- [ ] **Step 4: Run the whole gate, in order**

Run: `npm run typecheck && npm run lint && npm test && npm run db:reset && npm run db:test && npm run test:isolation && npm run seed:branding && npm run test:e2e`
Expected: all green. **The order matters** — `db:test` after `test:isolation` or `test:e2e` gives a red that is not code.

> The full e2e suite is load-flaky on the development machine — Block 30a saw 104–105 of 107 across three runs with different failures each time, all passing on isolated re-run, and CI green. Report what you observe; do not chase a local failure in a spec this branch does not touch.

- [ ] **Step 5: Commit**

```bash
git add tests/e2e/birthday-filter.spec.ts docs/DATABASE.md
git commit -m "test(30b): the window that crosses new year, proved in a browser"
```

---

## What this plan does not do, on purpose

- **No Refresh on Pickups.** The owner's list does not ask for one; adding it because the neighbours have one would be inventing scope.
- **No calendar validation in `birthdayCode`.** 31 April matches nothing, which is the right answer, and rejecting it would mean keeping a second calendar in step with Postgres's.
- **No "N new since you last looked" affordance.** Refresh re-runs and re-renders; telling the operator what changed is a different feature.
