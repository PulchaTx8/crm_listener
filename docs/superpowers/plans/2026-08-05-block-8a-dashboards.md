# Block 8a — Three dashboards Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Audience, Music and Promotions dashboards — figures, comparisons and charts over a Station or a consolidated set of Stations, sliced by a period computed in each Station's own timezone.

**Architecture:** One `SECURITY INVOKER` PL/pgSQL function per dashboard returns a single `jsonb` payload holding both the chosen window and the comparison window, so RLS keeps applying inside the aggregate and each page costs one round trip. A shared `resolve_dashboard_period` owns all preset and comparison arithmetic. Three Server Component pages read the payload through a Zod-validated service and hand plain props to four Recharts client components.

**Tech Stack:** PostgreSQL 15 / PL/pgSQL, Supabase CLI migrations, pgTAP, Next.js 15 App Router (React 19, Server Components), TypeScript strict, Zod, Recharts 3, Tailwind, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-08-05-block-8a-dashboards-design.md`. Every decision reference below (D1–D13) points there.

## Global Constraints

- **Migrations are append-only across merges**, and numbered `0115`–`0120` in this block. Within this unmerged branch a migration may be edited in place — `0045_promotion_prizes.sql` states the same rule.
- **Every aggregate function is `security invoker`** (D4), `stable`, `set search_path = pg_catalog, public`, with `grant execute ... to authenticated` and a `comment on function` stating what it counts and what it excludes.
- **No permission check may be replaced by RLS alone, and no RLS predicate may be restated by hand.** The functions check permission explicitly for the 42501; everything else is inherited.
- **TypeScript strict, no unjustified `any`.** A `jsonb` return is `unknown` until Zod validates it.
- **Portuguese never appears in code, comments, commits or identifiers.** UI copy is English, as every other screen in this codebase.
- **Period bounds are dates, never instants**, converted per Station inside SQL (D5).
- **Every "top" list is the top ten**, ordered by count descending with the record's own name as the tie-break.
- **The gate before any PR:** `npm run lint`, `npm run typecheck`, `npm test`, `npm run db:test`, `npm run test:isolation`, `npm run build`, `npm run test:e2e`.
- **Fixture UUIDs in pgTAP** follow the existing convention: `00000000-0000-0000-0000-0000000<hex tag>`. This block uses the `d8` tag (`...0000d8xx`) so it collides with no existing test file.
- **pgTAP exercises these functions as a real authenticated caller, never as the migration role, and never against a stubbed `has_permission`.** No test file in this repository replaces that function, and here the house pattern is not merely convention: the aggregates are `SECURITY INVOKER`, so the migration role — which bypasses RLS — would prove the arithmetic and nothing whatever about isolation, which is the property D4 exists to buy. The pattern, copied from `02_permissions.test.sql:295-336`, is: insert `roles` + `role_permissions` + `auth.users` + `company_memberships` as the migration role, then

  ```sql
  set local role authenticated;
  set local request.jwt.claims = '{"sub": "<user uuid>", "role": "authenticated"}';
  -- assertions
  reset role;
  ```

  Fixtures are always inserted **before** switching role; `reset role` always follows the assertions.
- **Test timezone is `America/Sao_Paulo`** — UTC−3 with no DST since 2019, so a fixed expected instant stays fixed. Never write a timezone test against a zone that observes DST unless the test is about DST.

---

## File Structure

**Database**
- `supabase/migrations/0115_reports_consolidated_permission.sql` — the one new permission code
- `supabase/migrations/0116_dashboard_indexes.sql` — the three missing indexes
- `supabase/migrations/0117_resolve_dashboard_period.sql` — preset + comparison arithmetic, one place
- `supabase/migrations/0118_audience_dashboard.sql` — `get_audience_dashboard`
- `supabase/migrations/0119_music_dashboard.sql` — `get_music_dashboard`
- `supabase/migrations/0120_promotions_dashboard.sql` — `get_promotions_dashboard`
- `supabase/tests/20_dashboards.test.sql` — pgTAP for all of the above

**Application**
- `src/schemas/dashboards.ts` — Zod schemas for the three payloads; the only place that trusts nothing
- `src/services/dashboards.ts` — `server-only`; calls the RPCs and validates
- `src/app/(app)/dashboards/period.ts` — parses/serialises the period search params, shared by all three pages
- `src/app/(app)/dashboards/errors.ts` — maps Postgres error codes to sentences
- `src/app/(app)/dashboards/period-control.tsx` — client component, the preset buttons and the custom range
- `src/app/(app)/dashboards/consolidated-toggle.tsx` — client component, the all-Stations switch
- `src/app/(app)/dashboards/dashboard-cards.tsx` — server component, renders `cards` + `withheld`
- `src/app/(app)/dashboards/audience/page.tsx`
- `src/app/(app)/dashboards/music/page.tsx`
- `src/app/(app)/dashboards/promotions/page.tsx`
- `src/components/charts/chart-colors.ts` — the CSS variables every chart reads
- `src/components/charts/monthly-bars.tsx`
- `src/components/charts/breakdown-bars.tsx`
- `src/components/charts/top-list.tsx`
- `src/components/charts/split-donut.tsx`
- `src/components/layout/app-shell.tsx:5` — one new glyph in `ICONS`
- `src/lib/auth/shell.ts:26` — the new nav section
- `src/lib/promotion-situation.ts` — one comment naming its SQL twin (D11)

**Tests**
- `tests/unit/dashboards-period.test.ts` — the period search-param parser
- `tests/unit/promotion-situation-boundary.test.ts` — the TypeScript half of D11's paired proof
- `tests/isolation/dashboards.test.ts` — real JWTs, the D2/D3/D13 boundaries
- `tests/e2e/dashboards.spec.ts` — one dashboard end to end

**Docs**
- `docs/block-8a-report.md`, `docs/block-8a-runbook.md`

---

### Task 1: The permission and the three indexes

**Files:**
- Create: `supabase/migrations/0115_reports_consolidated_permission.sql`
- Create: `supabase/migrations/0116_dashboard_indexes.sql`
- Create: `supabase/tests/20_dashboards.test.sql`

**Interfaces:**
- Consumes: nothing.
- Produces: the permission code `reports.consolidated` (usable by `has_permission('reports.consolidated', <company_id>)`) and three indexes named `participations_company_period_idx`, `member_links_company_linked_idx`, `winners_company_created_idx`.

- [ ] **Step 1: Write the failing test**

Create `supabase/tests/20_dashboards.test.sql`:

```sql
begin;
select plan(5);

-- 1: the code exists, or has_permission returns false for every caller and
-- every consolidated call in this block refuses everybody (0010's first line).
select is(
  (select count(*)::int from public.permissions where code = 'reports.consolidated'),
  1,
  'reports.consolidated is in the catalogue');

-- 2: it is Company-scoped, because D3 checks it per Station and an
-- organization-scoped code would be satisfied by holding it anywhere.
select is(
  (select scope::text from public.permissions where code = 'reports.consolidated'),
  'company',
  'reports.consolidated is company-scoped');

-- 3-5: the three indexes the aggregates need. Each source table is filtered by
-- Station AND a date range; without these the aggregate scans.
select has_index('public', 'participations', 'participations_company_period_idx',
  'participations is indexed by station and date');
select has_index('public', 'member_company_links', 'member_links_company_linked_idx',
  'member_company_links is indexed by station and linked_at');
select has_index('public', 'winners', 'winners_company_created_idx',
  'winners is indexed by station and created_at');

select * from finish();
rollback;
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npm run db:test`
Expected: FAIL — `20_dashboards.test.sql` reports 5 failing assertions (no such permission row, no such indexes).

- [ ] **Step 3: Write the permission migration**

Create `supabase/migrations/0115_reports_consolidated_permission.sql`:

```sql
-- supabase/migrations/0115_reports_consolidated_permission.sql

-- Block 8a, Task 1: the one permission this block introduces.
--
-- Design spec D2 and D3. Each dashboard is gated by its own domain's code --
-- members.view, music.view, promotions.view -- because a counter is a small
-- leak of a fact the caller was not allowed to see, and a single dashboards.view
-- would hand somebody the size, origin and growth of an audience they cannot
-- list. This code buys exactly one thing on top of those: summing more than one
-- Station into a single screen.
--
-- Company-scoped, not organization-scoped, and the difference is the whole
-- design: a consolidated call requires this code in EVERY Station it names
-- (D3), so the total can never contain a Station the caller could not have
-- visited one at a time. An organization-scoped code would be satisfied by
-- holding it in any single Station, which is the opposite of the rule.
--
-- THE DAY THIS SHIPS IT IS LIVE. Unlike music.request in 7a -- which shipped
-- assignable at zero capability and acquired a real one a block later -- any
-- role granted this code reads the whole group's numbers in one screen from
-- the moment 0118-0120 land.
insert into public.permissions
  (code, description, introduced_by_block, module, label, scope, display_order)
values
  ('reports.consolidated',
   'Sum several Stations into one dashboard',
   '8a', 'reports', 'See a consolidated dashboard', 'company', 10);
```

- [ ] **Step 4: Write the index migration**

Create `supabase/migrations/0116_dashboard_indexes.sql`:

```sql
-- supabase/migrations/0116_dashboard_indexes.sql

-- Block 8a, Task 1: the three indexes the aggregates need, and none of them is
-- a precaution -- each is a gap found by reading the existing DDL.
--
-- Every figure in this block filters one table by Station AND a date range.
-- Three of the four source tables have no index that supports that pair, and
-- music_requests -- the fourth -- already has (company_id, requested_at) from
-- 0098 and is deliberately untouched here.

-- participations' only listing index is (promotion_id, participated_at desc,
-- id desc) from 0052, which serves the participants screen: that screen always
-- knows its promotion. A Station-wide count over a period has no promotion to
-- start from and would scan.
create index participations_company_period_idx
  on public.participations (company_id, participated_at);

-- member_company_links has (company_id) alone from 0031. linked_at is the
-- column every arrival figure filters on -- design spec D9, a listener is new
-- at a Station when the LINK is new, because members themselves are
-- Organization-scoped and members.created_at would date them to another
-- Station's first sight of them.
create index member_links_company_linked_idx
  on public.member_company_links (company_id, linked_at);

-- winners has (draw_id, awarded_rank) and a partial (deadline_at) from 0075.
-- Neither serves "prizes awarded at this Station during this period"; the
-- deadline index serves the overdue figure and stays as it is.
create index winners_company_created_idx
  on public.winners (company_id, created_at);
```

- [ ] **Step 5: Run the tests to make sure they pass**

Run: `npm run db:reset && npm run db:test`
Expected: PASS — `20_dashboards.test.sql .... ok`, `Result: PASS`.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/0115_reports_consolidated_permission.sql supabase/migrations/0116_dashboard_indexes.sql supabase/tests/20_dashboards.test.sql
git commit -m "feat(dashboards): the one new permission, and the three indexes the aggregates were missing"
```

---

### Task 2: The period resolver

The single place that knows what "previous month" means. All three aggregates call it once per Station.

**Files:**
- Create: `supabase/migrations/0117_resolve_dashboard_period.sql`
- Modify: `supabase/tests/20_dashboards.test.sql` (raise `plan(5)` to `plan(21)`, append assertions)

**Interfaces:**
- Consumes: nothing.
- Produces:
  ```
  public.resolve_dashboard_period(p_preset text, p_from date, p_to date, p_timezone text)
    returns table (
      from_at timestamptz, to_at timestamptz,
      previous_from_at timestamptz, previous_to_at timestamptz,
      from_date date, to_date date,
      previous_from_date date, previous_to_date date
    )
  ```
  `p_preset` is one of `current_month`, `previous_month`, `current_year`, `custom`. All bounds are half-open: `from` inclusive, `to` exclusive.

- [ ] **Step 1: Write the failing test**

Append to `supabase/tests/20_dashboards.test.sql`, before `select * from finish();`, and change `select plan(5);` to `select plan(21);`:

```sql
-- ---------------------------------------------------------------------------
-- The period resolver (Task 2). Every assertion below uses America/Sao_Paulo,
-- which has been UTC-3 with no DST since 2019, so an expected instant written
-- here stays correct.
-- ---------------------------------------------------------------------------

-- 6-9: a custom period is converted at the Station's timezone, not the
-- server's. This is requirement L2 in one assertion: midnight local on the 1st
-- of August in Sao Paulo is 03:00Z, and a server running UTC that skipped the
-- conversion would place three hours of that day in July.
select is(from_at, '2026-08-01 03:00:00+00'::timestamptz,
          'a custom start is midnight at the Station, not at the server')
  from public.resolve_dashboard_period('custom', '2026-08-01', '2026-09-01', 'America/Sao_Paulo');
select is(to_at, '2026-09-01 03:00:00+00'::timestamptz,
          'a custom end is midnight at the Station too, exclusive')
  from public.resolve_dashboard_period('custom', '2026-08-01', '2026-09-01', 'America/Sao_Paulo');

-- The comparison is the immediately preceding window of the same length (D6).
-- August 2026 is 31 days, so the previous window opens on 1 July.
select is(previous_from_date, '2026-07-01'::date,
          'the comparison window is the preceding window of equal length')
  from public.resolve_dashboard_period('custom', '2026-08-01', '2026-09-01', 'America/Sao_Paulo');
select is(previous_to_date, '2026-08-01'::date,
          'the comparison window ends where the chosen one begins')
  from public.resolve_dashboard_period('custom', '2026-08-01', '2026-09-01', 'America/Sao_Paulo');

-- 10-11: the same period read at a different timezone yields different
-- instants. If this ever passes with equal values, the conversion was dropped.
select isnt(
  (select from_at from public.resolve_dashboard_period('custom', '2026-08-01', '2026-09-01', 'America/Sao_Paulo')),
  (select from_at from public.resolve_dashboard_period('custom', '2026-08-01', '2026-09-01', 'UTC')),
  'two Stations in different zones do not share the same instant');
select is(
  (select from_at from public.resolve_dashboard_period('custom', '2026-08-01', '2026-09-01', 'UTC')),
  '2026-08-01 00:00:00+00'::timestamptz,
  'a UTC Station starts at midnight UTC');

-- 12-15: the presets. Their absolute values depend on when the suite runs, so
-- what is asserted is the SHAPE, which does not.
select is(
  (select to_date from public.resolve_dashboard_period('current_month', null, null, 'America/Sao_Paulo')),
  (select (from_date + interval '1 month')::date from public.resolve_dashboard_period('current_month', null, null, 'America/Sao_Paulo')),
  'current_month spans exactly one month');
select is(
  (select extract(day from from_date)::int from public.resolve_dashboard_period('current_month', null, null, 'America/Sao_Paulo')),
  1,
  'current_month starts on the first of the month');
-- The comparison window of a calendar preset must be the previous CALENDAR
-- unit, and this is the assertion that says so without depending on the month
-- the suite happens to run in: stepping the comparison window forward by one
-- month must land exactly on the chosen window's start. Subtracting a day-count
-- instead -- 31 days off a 31-day May, landing on 31 March -- fails this for
-- every pair of adjacent months with different lengths, and passes only when
-- the value is genuinely right.
select is(
  (select (previous_from_date + interval '1 month')::date from public.resolve_dashboard_period('previous_month', null, null, 'America/Sao_Paulo')),
  (select previous_to_date from public.resolve_dashboard_period('previous_month', null, null, 'America/Sao_Paulo')),
  'previous_month compares against exactly the calendar month before it');
select is(
  (select (previous_from_date + interval '1 month')::date from public.resolve_dashboard_period('current_month', null, null, 'America/Sao_Paulo')),
  (select from_date from public.resolve_dashboard_period('current_month', null, null, 'America/Sao_Paulo')),
  'current_month compares against exactly the calendar month before it');
select is(
  (select (previous_from_date + interval '1 year')::date from public.resolve_dashboard_period('current_year', null, null, 'America/Sao_Paulo')),
  (select from_date from public.resolve_dashboard_period('current_year', null, null, 'America/Sao_Paulo')),
  'current_year compares against exactly the calendar year before it — which a day-count subtraction gets wrong after every leap year');
select is(
  (select to_date from public.resolve_dashboard_period('current_year', null, null, 'America/Sao_Paulo')),
  (select (from_date + interval '1 year')::date from public.resolve_dashboard_period('current_year', null, null, 'America/Sao_Paulo')),
  'current_year spans exactly one year');

-- 16: the preset is resolved at the STATION's clock. Kiritimati is UTC+14 and
-- Niue is UTC-11, twenty-five hours apart, so for part of every day the two
-- are in different months -- and on those days this assertion is the only
-- thing that would catch a resolver that used the server's date.
select ok(
  (select from_date from public.resolve_dashboard_period('current_month', null, null, 'Pacific/Kiritimati'))
  >=
  (select from_date from public.resolve_dashboard_period('current_month', null, null, 'Pacific/Niue')),
  'the month is the Station''s own, so a zone ahead is never behind');

-- 17-19: the refusals. Each is a caller error, not a wrong number.
select throws_ok(
  $$ select * from public.resolve_dashboard_period('custom', null, null, 'America/Sao_Paulo') $$,
  '22023', null, 'a custom period without bounds is refused');
select throws_ok(
  $$ select * from public.resolve_dashboard_period('custom', '2026-09-01', '2026-08-01', 'America/Sao_Paulo') $$,
  '22023', null, 'a period that ends before it starts is refused');
select throws_ok(
  $$ select * from public.resolve_dashboard_period('last_tuesday', null, null, 'America/Sao_Paulo') $$,
  '22023', null, 'an unknown preset is refused rather than defaulted');
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npm run db:test`
Expected: FAIL — `function public.resolve_dashboard_period(...) does not exist`.

- [ ] **Step 3: Write the migration**

Create `supabase/migrations/0117_resolve_dashboard_period.sql`:

```sql
-- supabase/migrations/0117_resolve_dashboard_period.sql

-- Block 8a, Task 2: what a period IS, in one place.
--
-- Design spec D5 and D6. Three aggregates need the same two windows -- the one
-- the operator chose and the one immediately before it -- and each needs them
-- per Station, because a group's radios do not share a clock. Three copies of
-- "what the previous month is" is three chances to disagree, and a disagreement
-- here does not look like a defect: it looks like a number.
--
-- WHY THE ARITHMETIC IS HERE AND NOT IN NODE. The server runs UTC. Resolving
-- 'current month' in TypeScript would take the server's date, and for the three
-- hours either side of midnight in Sao Paulo -- and for a full day at the edges
-- of the Pacific -- that is a different month. Every card on the page would be
-- wrong together, which is the hardest kind of wrong to notice. 0062 and 0112
-- already carry this rule for what a listener is TOLD; this is the same rule
-- for what the owner is SHOWN.
--
-- Every bound is half-open: from inclusive, to exclusive. That matches 0040's
-- exclusion constraint on a promotion's own window and the rule
-- src/lib/promotion-situation.ts restates -- a period is over at the instant it
-- ends, not a moment after -- so a row cannot fall in two adjacent periods or
-- in neither.
--
-- SECURITY INVOKER (the default, stated for the reader): it reads no table and
-- so has nothing to bypass. It is pure arithmetic over its arguments.
create or replace function public.resolve_dashboard_period(
  p_preset   text,
  p_from     date,
  p_to       date,
  p_timezone text
)
returns table (
  from_at            timestamptz,
  to_at              timestamptz,
  previous_from_at   timestamptz,
  previous_to_at     timestamptz,
  from_date          date,
  to_date            date,
  previous_from_date date,
  previous_to_date   date
)
language plpgsql
stable
set search_path = pg_catalog, public
as $$
declare
  v_today date;
  v_from  date;
  v_to    date;
  v_pfrom date;
  v_pto   date;
begin
  if p_timezone is null or btrim(p_timezone) = '' then
    raise exception 'a station timezone is required' using errcode = '22023';
  end if;

  -- The Station's today, never the server's.
  v_today := (now() at time zone p_timezone)::date;

  -- Each branch sets its OWN comparison window, and that is the whole point of
  -- the shape below. A calendar preset compares against the previous CALENDAR
  -- unit, which is not the same thing as subtracting the current unit's length:
  -- `date - date` in Postgres is a count of days, so subtracting the span of a
  -- 31-day May would place the comparison window at 31 March, giving one day of
  -- March plus all of April and calling it "the previous month". That is right
  -- only when two adjacent units happen to share a length -- true for July into
  -- August, false for ten month pairs in twelve and for every year after a leap
  -- year -- and it fails as a plausible number rather than an error.
  v_pto := null;
  case p_preset
    when 'current_month' then
      v_from  := date_trunc('month', v_today::timestamp)::date;
      v_to    := (v_from + interval '1 month')::date;
      v_pfrom := (v_from - interval '1 month')::date;
    when 'previous_month' then
      v_to    := date_trunc('month', v_today::timestamp)::date;
      v_from  := (v_to - interval '1 month')::date;
      v_pfrom := (v_from - interval '1 month')::date;
    when 'current_year' then
      v_from  := date_trunc('year', v_today::timestamp)::date;
      v_to    := (v_from + interval '1 year')::date;
      v_pfrom := (v_from - interval '1 year')::date;
    when 'custom' then
      if p_from is null or p_to is null then
        raise exception 'a custom period needs both bounds' using errcode = '22023';
      end if;
      if p_to <= p_from then
        raise exception 'a period cannot end before it starts' using errcode = '22023';
      end if;
      v_from := p_from;
      v_to   := p_to;
      -- The only preset where subtracting the span IS the right answer: an
      -- arbitrary range of N days has no calendar unit to step back by, so the
      -- immediately preceding N days is the only sensible comparison.
      v_pfrom := (v_from - (v_to - v_from))::date;
    else
      -- Not defaulted to a month. A typo in a search param must be an error the
      -- screen can name, not a silently different question answered correctly.
      raise exception 'unknown period preset: %', p_preset using errcode = '22023';
  end case;

  -- Common to every preset: the comparison window ends where the chosen one
  -- begins, so the two are adjacent and never overlap.
  v_pto := v_from;

  return query select
    (v_from::timestamp  at time zone p_timezone),
    (v_to::timestamp    at time zone p_timezone),
    (v_pfrom::timestamp at time zone p_timezone),
    (v_pto::timestamp   at time zone p_timezone),
    v_from, v_to, v_pfrom, v_pto;
end;
$$;

comment on function public.resolve_dashboard_period(text, date, date, text) is
  'The two windows every Block 8a dashboard measures: the one chosen and the one immediately before it, of equal length, both half-open (from inclusive, to exclusive). Takes the Station''s timezone and returns BOTH the local dates and the instants they bound, because the screen shows dates and the queries filter timestamptz. Presets (current_month, previous_month, current_year) are resolved from now() at the STATION''s clock -- the server runs UTC, and resolving them there would misplace the hours either side of local midnight into the neighbouring period, wrongly and in every card at once. An unknown preset raises 22023 rather than defaulting, so a bad search param is an error the screen can name instead of a different question answered correctly. Pure arithmetic over its arguments: it reads no table.';

grant execute on function public.resolve_dashboard_period(text, date, date, text) to authenticated;
```

- [ ] **Step 4: Run the tests to make sure they pass**

Run: `npm run db:reset && npm run db:test`
Expected: PASS — 21 assertions in `20_dashboards.test.sql`, `Result: PASS`.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/0117_resolve_dashboard_period.sql supabase/tests/20_dashboards.test.sql
git commit -m "feat(dashboards): what a period is, resolved once and at the Station's own clock"
```

---

### Task 3: `get_audience_dashboard`

**Files:**
- Create: `supabase/migrations/0118_audience_dashboard.sql`
- Modify: `supabase/tests/20_dashboards.test.sql` (raise `plan(21)` to `plan(34)`, append assertions)

**Interfaces:**
- Consumes: `public.resolve_dashboard_period` (Task 2), `public.has_permission(text, uuid)` (0010/0015/0016).
- Produces: `public.get_audience_dashboard(p_company_ids uuid[], p_preset text, p_from date, p_to date) returns jsonb`, whose payload carries the keys `period`, `stations`, `cards`, `monthly`, `breakdowns`, `top`, `withheld`. `cards` holds `listeners`, `new_listeners`, `took_part` (withheld without `participations.view`), `barred`. `breakdowns` holds `blocks_by_kind`. `top` holds `discovery_source` and `first_contact_origin`.

- [ ] **Step 1: Write the failing test**

Append to `supabase/tests/20_dashboards.test.sql` before `finish()`, and change `plan(21)` to `plan(34)`:

```sql
-- ---------------------------------------------------------------------------
-- get_audience_dashboard (Task 3). Fixtures use the d8 tag.
-- ---------------------------------------------------------------------------
insert into public.organizations (id, name) values
  ('00000000-0000-0000-0000-0000000d8f01', 'Org dashboards');
insert into public.companies (id, organization_id, name, timezone) values
  ('00000000-0000-0000-0000-0000000d8c01', '00000000-0000-0000-0000-0000000d8f01',
   'Station SP', 'America/Sao_Paulo'),
  ('00000000-0000-0000-0000-0000000d8c02', '00000000-0000-0000-0000-0000000d8f01',
   'Station UTC', 'UTC');

insert into public.members (id, organization_id, full_name, discovery_source) values
  ('00000000-0000-0000-0000-0000000d8m01', '00000000-0000-0000-0000-0000000d8f01', 'Ana',  'Instagram'),
  ('00000000-0000-0000-0000-0000000d8m02', '00000000-0000-0000-0000-0000000d8f01', 'Bruno','Instagram'),
  ('00000000-0000-0000-0000-0000000d8m03', '00000000-0000-0000-0000-0000000d8f01', 'Célia', null);

-- THE ASSERTION THIS WHOLE BLOCK EXISTS TO GET RIGHT. Ana is linked at 23:30
-- on 31 August, Sao Paulo time -- which is 02:30Z on 1 September. Counted at
-- the Station's clock she belongs to August; counted at the server's she
-- belongs to September.
insert into public.member_company_links (member_id, company_id, organization_id, linked_at) values
  ('00000000-0000-0000-0000-0000000d8m01', '00000000-0000-0000-0000-0000000d8c01',
   '00000000-0000-0000-0000-0000000d8f01', '2026-09-01 02:30:00+00'),
  -- Bruno lands squarely inside August at either clock.
  ('00000000-0000-0000-0000-0000000d8m02', '00000000-0000-0000-0000-0000000d8c01',
   '00000000-0000-0000-0000-0000000d8f01', '2026-08-15 12:00:00+00'),
  -- Célia arrives in July: she counts toward the comparison window, not August.
  ('00000000-0000-0000-0000-0000000d8m03', '00000000-0000-0000-0000-0000000d8c01',
   '00000000-0000-0000-0000-0000000d8f01', '2026-07-20 12:00:00+00');

-- TWO CALLERS, built once here and reused by Tasks 4 and 5. Both are ordinary
-- role holders -- roles, role_permissions, auth.users, company_memberships --
-- exactly as 02_permissions.test.sql:295-336 builds them, because these
-- functions are SECURITY INVOKER and a caller that bypasses RLS would prove
-- nothing about the property D4 buys.
--
--   d8u01  everything: members.view, music.view, promotions.view,
--          participations.view, reports.consolidated, in BOTH Stations.
--   d8u02  members.view, music.view and promotions.view in Station SP, and
--          deliberately NOT participations.view -- the withheld case (D13).
insert into public.roles (id, organization_id, name) values
  ('00000000-0000-0000-0000-0000000d8r01', '00000000-0000-0000-0000-0000000d8f01', 'Everything'),
  ('00000000-0000-0000-0000-0000000d8r02', '00000000-0000-0000-0000-0000000d8f01', 'No entries');
insert into public.role_permissions (role_id, permission_code) values
  ('00000000-0000-0000-0000-0000000d8r01', 'members.view'),
  ('00000000-0000-0000-0000-0000000d8r01', 'music.view'),
  ('00000000-0000-0000-0000-0000000d8r01', 'promotions.view'),
  ('00000000-0000-0000-0000-0000000d8r01', 'participations.view'),
  ('00000000-0000-0000-0000-0000000d8r01', 'reports.consolidated'),
  ('00000000-0000-0000-0000-0000000d8r02', 'members.view'),
  ('00000000-0000-0000-0000-0000000d8r02', 'music.view'),
  ('00000000-0000-0000-0000-0000000d8r02', 'promotions.view');
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000d8u01', 'dash-all@example.test'),
  ('00000000-0000-0000-0000-0000000d8u02', 'dash-no-entries@example.test');
insert into public.company_memberships (user_id, company_id, organization_id, role_id) values
  ('00000000-0000-0000-0000-0000000d8u01', '00000000-0000-0000-0000-0000000d8c01',
   '00000000-0000-0000-0000-0000000d8f01', '00000000-0000-0000-0000-0000000d8r01'),
  ('00000000-0000-0000-0000-0000000d8u01', '00000000-0000-0000-0000-0000000d8c02',
   '00000000-0000-0000-0000-0000000d8f01', '00000000-0000-0000-0000-0000000d8r01'),
  ('00000000-0000-0000-0000-0000000d8u02', '00000000-0000-0000-0000-0000000d8c01',
   '00000000-0000-0000-0000-0000000d8f01', '00000000-0000-0000-0000-0000000d8r02');

-- 20-21: the refusals, asserted as a signed-in user who simply is not a member
-- of this Organization at all. 42501, never an empty payload -- zero and "you
-- may not see this" must not render alike.
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000d8u03', 'dash-outsider@example.test');
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-0000000d8u03", "role": "authenticated"}';
select throws_ok(
  $$ select public.get_audience_dashboard(array['00000000-0000-0000-0000-0000000d8c01']::uuid[], 'current_month', null, null) $$,
  '42501', null, 'a caller without members.view is refused, not given zeros');
select throws_ok(
  $$ select public.get_audience_dashboard(array[]::uuid[], 'current_month', null, null) $$,
  '22023', null, 'a call naming no station is refused');
reset role;

-- Everything below runs as d8u01 unless a block says otherwise.
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-0000000d8u01", "role": "authenticated"}';

-- 22-23: August at the Sao Paulo Station. Ana (23:30 local on the 31st) and
-- Bruno are in; Célia is not. Counted in UTC this would be 1, and that single
-- difference is requirement L2.
select is(
  (public.get_audience_dashboard(array['00000000-0000-0000-0000-0000000d8c01']::uuid[],
     'custom', '2026-08-01', '2026-09-01') #>> '{cards,new_listeners,current}')::int,
  2,
  'a link at 23:30 local on the last day counts in that month');
select is(
  (public.get_audience_dashboard(array['00000000-0000-0000-0000-0000000d8c01']::uuid[],
     'custom', '2026-08-01', '2026-09-01') #>> '{cards,new_listeners,previous}')::int,
  1,
  'July''s arrival is the comparison figure, not August''s');

-- 24: the same window at a UTC Station puts Ana in September. Proved against
-- the same rows by moving the links, so the only variable is the timezone.
insert into public.member_company_links (member_id, company_id, organization_id, linked_at)
select member_id, '00000000-0000-0000-0000-0000000d8c02', organization_id, linked_at
  from public.member_company_links
 where company_id = '00000000-0000-0000-0000-0000000d8c01';
select is(
  (public.get_audience_dashboard(array['00000000-0000-0000-0000-0000000d8c02']::uuid[],
     'custom', '2026-08-01', '2026-09-01') #>> '{cards,new_listeners,current}')::int,
  1,
  'the same rows counted at a UTC Station exclude the 02:30Z link');

-- 25: the stock figure is measured as of the window's end (D6), so a
-- historical period reports what was true then.
select is(
  (public.get_audience_dashboard(array['00000000-0000-0000-0000-0000000d8c01']::uuid[],
     'custom', '2026-08-01', '2026-09-01') #>> '{cards,listeners,current}')::int,
  3,
  'the listener total is measured at the end of the window');

-- 26: an anonymised member is not audience any more. The write is done as the
-- migration role -- an authenticated caller has no grant to update members
-- directly, and this is fixture surgery, not the behaviour under test.
reset role;
update public.members set anonymized_at = now()
 where id = '00000000-0000-0000-0000-0000000d8m02';
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-0000000d8u01", "role": "authenticated"}';
select is(
  (public.get_audience_dashboard(array['00000000-0000-0000-0000-0000000d8c01']::uuid[],
     'custom', '2026-08-01', '2026-09-01') #>> '{cards,listeners,current}')::int,
  2,
  'an anonymised member leaves the audience total');
reset role;
update public.members set anonymized_at = null
 where id = '00000000-0000-0000-0000-0000000d8m02';
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-0000000d8u01", "role": "authenticated"}';

-- 27: the discovery breakdown names the unfilled rather than dropping it, so
-- its buckets sum to the total beside them (D8's rule, applied here).
select is(
  (select sum((value ->> 'count')::int)::int
     from jsonb_array_elements(
       public.get_audience_dashboard(array['00000000-0000-0000-0000-0000000d8c01']::uuid[],
         'custom', '2026-08-01', '2026-09-01') #> '{top,discovery_source}')),
  3,
  'the discovery buckets, including "not stated", sum to the audience');

-- 28-29: two Stations at once needs reports.consolidated in both, and the
-- payload names both Stations with their own timezones.
select is(
  jsonb_array_length(
    public.get_audience_dashboard(
      array['00000000-0000-0000-0000-0000000d8c01','00000000-0000-0000-0000-0000000d8c02']::uuid[],
      'custom', '2026-08-01', '2026-09-01') #> '{stations}'),
  2,
  'a consolidated payload names every Station it summed');
select is(
  (public.get_audience_dashboard(
      array['00000000-0000-0000-0000-0000000d8c01','00000000-0000-0000-0000-0000000d8c01']::uuid[],
      'custom', '2026-08-01', '2026-09-01') #>> '{cards,new_listeners,current}')::int,
  2,
  'a repeated Station id is deduplicated, not double-counted');

-- 30-31: the withheld contract (D13). With participations.view the figure is a
-- card; without it, it is named in withheld and absent from cards -- never a
-- zero, which would read as "nobody took part".
select is(
  (public.get_audience_dashboard(array['00000000-0000-0000-0000-0000000d8c01']::uuid[],
     'custom', '2026-08-01', '2026-09-01') #> '{withheld}'),
  '[]'::jsonb,
  'nothing is withheld from a caller holding participations.view');

-- Switch to the caller who lacks participations.view. Same rows, same window,
-- different permissions: the figure must be ABSENT, not zero. A zero would say
-- "nobody took part", which is a claim about the audience rather than about
-- this caller.
reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-0000000d8u02", "role": "authenticated"}';
select is(
  (public.get_audience_dashboard(array['00000000-0000-0000-0000-0000000d8c01']::uuid[],
     'custom', '2026-08-01', '2026-09-01') #> '{cards,took_part}'),
  null,
  'without participations.view the figure is absent, not zero');
select is(
  (public.get_audience_dashboard(array['00000000-0000-0000-0000-0000000d8c01']::uuid[],
     'custom', '2026-08-01', '2026-09-01') #>> '{withheld,0,needs}'),
  'participations.view',
  'and the payload names the permission that would fill it');
reset role;
```

> **Note for the implementer:** assertion numbers in the comments are guidance, not a contract — what must hold is that `plan(N)` equals the number of assertions actually in the file (34 after this task). The two callers built at the top of this section are reused by Tasks 4 and 5; do not rebuild them there.

- [ ] **Step 2: Run it to make sure it fails**

Run: `npm run db:test`
Expected: FAIL — `function public.get_audience_dashboard(...) does not exist`.

- [ ] **Step 3: Write the migration**

Create `supabase/migrations/0118_audience_dashboard.sql`:

```sql
-- supabase/migrations/0118_audience_dashboard.sql

-- Block 8a, Task 3: the Audience dashboard, as one function.
--
-- Design spec §3.1. One jsonb, both windows, one round trip -- Block 3b
-- measured what the alternative costs (102 queries to 5) and this screen would
-- otherwise ask ten questions to fill one page.
--
-- SECURITY INVOKER, and that is the decision worth reading (D4). Every other
-- read RPC here is SECURITY DEFINER and therefore has to restate by hand each
-- predicate RLS used to apply -- 0095's header lists four such rules and
-- records that one of them went five commits missing, caught only by the
-- isolation suite. An aggregate carries the same risk with a worse symptom: a
-- list that leaks a row looks wrong, while a count that includes rows the
-- caller may not read looks like a number. Running as the caller means
-- members_select_reachable (0035) and its siblings apply INSIDE this function
-- and cannot be forgotten.
--
-- What is still done by hand is the permission check below, because RLS
-- answers "which rows" and not "may this person be here at all", and a caller
-- without members.view must be told 42501 rather than shown a screen of
-- zeros. Zero and "you may not see this" must never render alike.
--
-- ONE FIGURE CROSSES A PERMISSION LINE (D13). "Took part" reads participations,
-- gated by participations.view (0053), which members.view does not imply. It is
-- not zeroed for a caller lacking it -- it is omitted from cards and named in
-- withheld, so the screen can render an em dash and say which permission fills
-- it.
create or replace function public.get_audience_dashboard(
  p_company_ids uuid[],
  p_preset      text default 'current_month',
  p_from        date default null,
  p_to          date default null
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_ids            uuid[];
  v_id             uuid;
  v_consolidated   boolean;
  v_participations boolean := true;
  v_result         jsonb;
begin
  if p_company_ids is null or cardinality(p_company_ids) = 0 then
    raise exception 'at least one station is required' using errcode = '22023';
  end if;

  -- Deduplicated before anything counts, so naming a Station twice cannot
  -- double its rows.
  select array_agg(distinct s) into v_ids from unnest(p_company_ids) as t(s);
  v_consolidated := cardinality(v_ids) > 1;

  foreach v_id in array v_ids loop
    if not public.has_permission('members.view', v_id) then
      raise exception 'members.view is required in every station requested'
        using errcode = '42501';
    end if;
    if v_consolidated and not public.has_permission('reports.consolidated', v_id) then
      raise exception 'reports.consolidated is required in every station of a consolidated view'
        using errcode = '42501';
    end if;
    -- Not a refusal: the figures it feeds are withheld instead (D13).
    if not public.has_permission('participations.view', v_id) then
      v_participations := false;
    end if;
  end loop;

  with station as (
    -- organization_id is selected here and not looked up again below: the
    -- Organization-wide block branch needs it per Station, and a correlated
    -- subquery back to companies would re-read a row this CTE already holds.
    select c.id, c.organization_id, c.name, c.timezone, p.*
      from public.companies c
      cross join lateral public.resolve_dashboard_period(p_preset, p_from, p_to, c.timezone) p
     where c.id = any(v_ids)
  ),
  -- Deleted and anonymised members are not audience; an anonymised row is a
  -- person whose data was erased under LGPD, and counting them as reachable
  -- listeners would overstate every figure on this page.
  link as (
    select l.member_id, l.linked_at, s.*
      from public.member_company_links l
      join station s on s.id = l.company_id
      join public.members m
        on m.id = l.member_id and m.deleted_at is null and m.anonymized_at is null
  ),
  cards as (
    select
      -- Stock figures, measured as of the end of each window (D6).
      count(distinct member_id) filter (where linked_at < to_at)             as listeners_current,
      count(distinct member_id) filter (where linked_at < previous_to_at)    as listeners_previous,
      -- Flow figures.
      count(distinct member_id) filter (where linked_at >= from_at and linked_at < to_at)
                                                                            as new_current,
      count(distinct member_id) filter (where linked_at >= previous_from_at and linked_at < previous_to_at)
                                                                            as new_previous
      from link
  ),
  took_part as (
    select
      count(distinct p.member_id) filter (where p.participated_at >= s.from_at and p.participated_at < s.to_at)
        as current,
      count(distinct p.member_id) filter (where p.participated_at >= s.previous_from_at and p.participated_at < s.previous_to_at)
        as previous
      from public.participations p
      join station s on s.id = p.company_id
  ),
  -- Distinct MEMBERS, not block rows: member_blocks.company_id is nullable and
  -- 0032 states that null means the whole Organization, so a group-wide bar
  -- would otherwise be counted once per Station in a consolidated view. The
  -- consequence is deliberate and documented in the spec: a consolidated bar
  -- figure is not always the sum of its parts.
  barred as (
    select
      count(distinct b.member_id) filter (where b.starts_at >= s.from_at and b.starts_at < s.to_at)
        as current,
      count(distinct b.member_id) filter (where b.starts_at >= s.previous_from_at and b.starts_at < s.previous_to_at)
        as previous
      from public.member_blocks b
      join station s
        on s.id = b.company_id
        or (b.company_id is null and b.organization_id = s.organization_id)
     where b.lifted_at is null
  ),
  blocks_by_kind as (
    select jsonb_agg(jsonb_build_object('key', k.kind, 'label', k.kind, 'count', k.n)
                     order by k.n desc, k.kind) as rows
      from (
        select b.kind::text as kind, count(distinct b.member_id) as n
          from public.member_blocks b
          join station s
            on s.id = b.company_id
            or (b.company_id is null and b.organization_id = s.organization_id)
         where b.lifted_at is null
           and b.starts_at >= s.from_at and b.starts_at < s.to_at
         group by b.kind
      ) k
  ),
  monthly as (
    select jsonb_agg(jsonb_build_object('month', m.bucket, 'count', m.n) order by m.bucket) as rows
      from (
        select to_char(date_trunc('month', l.linked_at at time zone l.timezone), 'YYYY-MM') as bucket,
               count(distinct l.member_id) as n
          from link l
         where l.linked_at < l.to_at
           and l.linked_at >= (l.to_at - interval '12 months')
         group by 1
      ) m
  ),
  discovery as (
    select jsonb_agg(jsonb_build_object('id', d.value, 'label', d.label, 'count', d.n)
                     order by d.n desc, d.label) as rows
      from (
        select coalesce(m.discovery_source, '') as value,
               coalesce(nullif(btrim(m.discovery_source), ''), 'Not stated') as label,
               count(distinct l.member_id) as n
          from link l
          join public.members m on m.id = l.member_id
         where l.linked_at < l.to_at
         group by 1, 2
         order by count(distinct l.member_id) desc, 2
         limit 10
      ) d
  ),
  first_contact as (
    select jsonb_agg(jsonb_build_object('id', f.value, 'label', f.label, 'count', f.n)
                     order by f.n desc, f.label) as rows
      from (
        select coalesce(m.first_contact_origin, '') as value,
               coalesce(nullif(btrim(m.first_contact_origin), ''), 'Not stated') as label,
               count(distinct l.member_id) as n
          from link l
          join public.members m on m.id = l.member_id
         where l.linked_at < l.to_at
         group by 1, 2
         order by count(distinct l.member_id) desc, 2
         limit 10
      ) f
  )
  select jsonb_build_object(
    'period', (
      select jsonb_build_object(
        'preset', p_preset,
        'from', min(from_date), 'to', min(to_date),
        'previous_from', min(previous_from_date), 'previous_to', min(previous_to_date))
        from station),
    'stations', (
      select jsonb_agg(jsonb_build_object('id', id, 'name', name, 'timezone', timezone) order by name)
        from station),
    'cards', (
      select jsonb_strip_nulls(jsonb_build_object(
        'listeners',     jsonb_build_object('current', c.listeners_current, 'previous', c.listeners_previous),
        'new_listeners', jsonb_build_object('current', c.new_current,       'previous', c.new_previous),
        'took_part',     case when v_participations
                              then jsonb_build_object('current', t.current, 'previous', t.previous)
                              else null end,
        'barred',        jsonb_build_object('current', b.current, 'previous', b.previous)))
        from cards c, took_part t, barred b),
    'monthly',    coalesce((select rows from monthly), '[]'::jsonb),
    'breakdowns', jsonb_build_object(
                    'blocks_by_kind', coalesce((select rows from blocks_by_kind), '[]'::jsonb)),
    'top',        jsonb_build_object(
                    'discovery_source',      coalesce((select rows from discovery), '[]'::jsonb),
                    'first_contact_origin',  coalesce((select rows from first_contact), '[]'::jsonb)),
    'withheld',   case when v_participations then '[]'::jsonb
                       else jsonb_build_array(jsonb_build_object(
                              'figure', 'took_part', 'needs', 'participations.view')) end
  ) into v_result;

  return v_result;
end;
$$;

comment on function public.get_audience_dashboard(uuid[], text, date, date) is
  'The Audience dashboard for one Station or a consolidated set, both windows in one call. SECURITY INVOKER by design (spec D4): the select policies of 0035 apply inside it, so the multi-tenant cut is structural rather than restated -- the failure mode a DEFINER aggregate carries is a count that silently includes rows the caller may not read, which looks like a number rather than a defect. Refuses with 42501 unless the caller holds members.view in EVERY station named, and reports.consolidated in every one when more than one is named (D3), so a consolidated total can never contain a Station the caller could not have visited alone. New listeners are counted from member_company_links.linked_at, not members.created_at (D9): members are Organization-scoped and a listener arriving here from a sister Station is new HERE. Stock figures are measured as of each window''s end, so a historical period compares two true totals. The bar figure counts distinct MEMBERS and treats a null member_blocks.company_id as the Organization-wide block 0032 says it is, which is why a consolidated bar figure is not always the sum of its parts. Deleted and anonymised members are excluded throughout. took_part reads participations, gated by participations.view, which members.view does not imply: a caller lacking it gets the figure OMITTED and named in withheld, never zeroed (D13).';

grant execute on function public.get_audience_dashboard(uuid[], text, date, date) to authenticated;
```

- [ ] **Step 4: Run the tests to make sure they pass**

Run: `npm run db:reset && npm run db:test`
Expected: PASS — 34 assertions, `Result: PASS`.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/0118_audience_dashboard.sql supabase/tests/20_dashboards.test.sql
git commit -m "feat(dashboards): the audience panel, counted at the Station's clock"
```

---

### Task 4: `get_music_dashboard`

**Files:**
- Create: `supabase/migrations/0119_music_dashboard.sql`
- Modify: `supabase/tests/20_dashboards.test.sql` (raise `plan(34)` to `plan(42)`)

**Interfaces:**
- Consumes: `public.resolve_dashboard_period` (Task 2). Follows `get_audience_dashboard`'s payload contract exactly (Task 3).
- Produces: `public.get_music_dashboard(p_company_ids uuid[], p_preset text, p_from date, p_to date) returns jsonb`. `cards`: `catalogue`, `new_songs`, `requests`. `breakdowns`: `nationality`, `vocal`. `top`: `songs`, `genres`. `withheld` is always `[]` — every figure reads a table gated by `music.view`, the panel's own gate.

- [ ] **Step 1: Write the failing test**

Append to `supabase/tests/20_dashboards.test.sql` before `finish()`, and change `plan(34)` to `plan(42)`. Assertions are numbered from wherever Task 3 left off; keep `plan(N)` equal to the real count (42 after this task). The two callers already exist from Task 3; fixtures are inserted as the migration role and the assertions run as `d8u01` unless stated.

```sql
-- ---------------------------------------------------------------------------
-- get_music_dashboard (Task 4). Fixtures first, as the migration role.
-- ---------------------------------------------------------------------------
insert into public.artists (id, organization_id, company_id, name) values
  ('00000000-0000-0000-0000-0000000d8a01', '00000000-0000-0000-0000-0000000d8f01',
   '00000000-0000-0000-0000-0000000d8c01', 'Artist One');
insert into public.music_genres (id, organization_id, company_id, name) values
  ('00000000-0000-0000-0000-0000000d8g01', '00000000-0000-0000-0000-0000000d8f01',
   '00000000-0000-0000-0000-0000000d8c01', 'Samba');

-- Four songs covering the two nullable attributes and three of the five vocal
-- values, so the breakdowns below have something to drop if they are written
-- as a two-slice chart.
insert into public.songs (id, organization_id, company_id, title, artist_id, genre_id, nationality, vocal) values
  ('00000000-0000-0000-0000-0000000d8s01', '00000000-0000-0000-0000-0000000d8f01',
   '00000000-0000-0000-0000-0000000d8c01', 'One',   '00000000-0000-0000-0000-0000000d8a01',
   '00000000-0000-0000-0000-0000000d8g01', 'DOMESTIC', 'MALE'),
  ('00000000-0000-0000-0000-0000000d8s02', '00000000-0000-0000-0000-0000000d8f01',
   '00000000-0000-0000-0000-0000000d8c01', 'Two',   '00000000-0000-0000-0000-0000000d8a01',
   '00000000-0000-0000-0000-0000000d8g01', 'INTERNATIONAL', 'INSTRUMENTAL'),
  ('00000000-0000-0000-0000-0000000d8s03', '00000000-0000-0000-0000-0000000d8f01',
   '00000000-0000-0000-0000-0000000d8c01', 'Three', '00000000-0000-0000-0000-0000000d8a01',
   '00000000-0000-0000-0000-0000000d8g01', null, null),
  ('00000000-0000-0000-0000-0000000d8s04', '00000000-0000-0000-0000-0000000d8f01',
   '00000000-0000-0000-0000-0000000d8c01', 'Four',  '00000000-0000-0000-0000-0000000d8a01',
   '00000000-0000-0000-0000-0000000d8g01', 'DOMESTIC', 'DUO');

-- Five requests in August: song One three times, the rest once each.
insert into public.music_requests (organization_id, company_id, member_id, song_id, requested_at)
values
  ('00000000-0000-0000-0000-0000000d8f01','00000000-0000-0000-0000-0000000d8c01',
   '00000000-0000-0000-0000-0000000d8m01','00000000-0000-0000-0000-0000000d8s01','2026-08-10 12:00:00+00'),
  ('00000000-0000-0000-0000-0000000d8f01','00000000-0000-0000-0000-0000000d8c01',
   '00000000-0000-0000-0000-0000000d8m01','00000000-0000-0000-0000-0000000d8s01','2026-08-11 12:00:00+00'),
  ('00000000-0000-0000-0000-0000000d8f01','00000000-0000-0000-0000-0000000d8c01',
   '00000000-0000-0000-0000-0000000d8m01','00000000-0000-0000-0000-0000000d8s01','2026-08-12 12:00:00+00'),
  ('00000000-0000-0000-0000-0000000d8f01','00000000-0000-0000-0000-0000000d8c01',
   '00000000-0000-0000-0000-0000000d8m01','00000000-0000-0000-0000-0000000d8s02','2026-08-13 12:00:00+00'),
  ('00000000-0000-0000-0000-0000000d8f01','00000000-0000-0000-0000-0000000d8c01',
   '00000000-0000-0000-0000-0000000d8m01','00000000-0000-0000-0000-0000000d8s03','2026-08-14 12:00:00+00');

set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-0000000d8u01", "role": "authenticated"}';

-- 33: requests in the window.
select is(
  (public.get_music_dashboard(array['00000000-0000-0000-0000-0000000d8c01']::uuid[],
     'custom', '2026-08-01', '2026-09-01') #>> '{cards,requests,current}')::int,
  5, 'the request count is the requests in the window');

-- 33: the catalogue and the requests are separate numbers, because §4.2 does
-- not say which "total" it meant and the two answer different questions.
select is(
  (public.get_music_dashboard(array['00000000-0000-0000-0000-0000000d8c01']::uuid[],
     'custom', '2026-08-01', '2026-09-01') #>> '{cards,catalogue,current}')::int,
  4, 'the catalogue total counts songs, not requests');

-- 34: most requested.
select is(
  (public.get_music_dashboard(array['00000000-0000-0000-0000-0000000d8c01']::uuid[],
     'custom', '2026-08-01', '2026-09-01') #>> '{top,songs,0,label}'),
  'One', 'the most requested song leads the list');

-- 35-36: THE BREAKDOWN THAT §4.2 WOULD HAVE GOT WRONG. Five requests: two
-- domestic (One x2... in fact One x3 = domestic 3, Four unrequested), one
-- international, one not stated. Whatever the split, the buckets must sum to
-- the request total -- a two-slice chart would sum to 4 and still show "5
-- requests" beside it.
select is(
  (select sum((value ->> 'count')::int)::int
     from jsonb_array_elements(
       public.get_music_dashboard(array['00000000-0000-0000-0000-0000000d8c01']::uuid[],
         'custom', '2026-08-01', '2026-09-01') #> '{breakdowns,nationality}')),
  5, 'the nationality buckets sum to the requests, including "not stated"');
select is(
  (select sum((value ->> 'count')::int)::int
     from jsonb_array_elements(
       public.get_music_dashboard(array['00000000-0000-0000-0000-0000000d8c01']::uuid[],
         'custom', '2026-08-01', '2026-09-01') #> '{breakdowns,vocal}')),
  5, 'the vocal buckets sum to the requests, all five values plus "not stated"');

-- 38: a soft-deleted request leaves every figure (0098's partial indexes and
-- policies treat deleted_at as gone, and so must this).
reset role;
update public.music_requests set deleted_at = now()
 where song_id = '00000000-0000-0000-0000-0000000d8s03';
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-0000000d8u01", "role": "authenticated"}';
select is(
  (public.get_music_dashboard(array['00000000-0000-0000-0000-0000000d8c01']::uuid[],
     'custom', '2026-08-01', '2026-09-01') #>> '{cards,requests,current}')::int,
  4, 'a soft-deleted request is not counted');

-- 39: nothing is ever withheld here -- every figure reads a table gated by
-- music.view, which is this panel's own gate (D13). d8u02 lacks
-- participations.view and is used deliberately: even the caller who loses
-- figures on the other two panels loses none here.
reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-0000000d8u02", "role": "authenticated"}';
select is(
  (public.get_music_dashboard(array['00000000-0000-0000-0000-0000000d8c01']::uuid[],
     'custom', '2026-08-01', '2026-09-01') #> '{withheld}'),
  '[]'::jsonb, 'the music panel withholds nothing');
reset role;

-- 40: and the gate is still a gate -- the outsider from assertion 20, who is
-- a signed-in user of no Station at all.
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-0000000d8u03", "role": "authenticated"}';
select throws_ok(
  $$ select public.get_music_dashboard(array['00000000-0000-0000-0000-0000000d8c01']::uuid[], 'custom', '2026-08-01', '2026-09-01') $$,
  '42501', null, 'a caller without music.view is refused');
reset role;
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npm run db:test`
Expected: FAIL — `function public.get_music_dashboard(...) does not exist`.

- [ ] **Step 3: Write the migration**

Create `supabase/migrations/0119_music_dashboard.sql`. It follows `0118` exactly in shape — the same argument list, the same deduplication, the same permission loop with `music.view` in place of `members.view`, the same `station` CTE — and differs only in what it counts. Write the header to say what is specific here:

```sql
-- supabase/migrations/0119_music_dashboard.sql

-- Block 8a, Task 4: the Music dashboard. Same shape as 0118 (same arguments,
-- same station CTE, same permission loop, same payload contract); what follows
-- is only what is specific to music.
--
-- WHAT MASTER SPEC §4.2 GOT WRONG, and this function does not. It describes the
-- last two indicators as "domestic/international" and "male/female".
-- music_vocal has FIVE values -- MALE, FEMALE, DUO, GROUP, INSTRUMENTAL -- and
-- songs.vocal and songs.nationality are both nullable. A two-slice chart would
-- silently drop duets, groups, instrumentals and every song whose attribute was
-- never filled in, and the slices would not add up to the request total printed
-- beside them. Both breakdowns therefore carry every value of their enum plus an
-- explicit "not stated" bucket, and the pgTAP suite asserts the sum rather than
-- the slices, because it is the sum that a future edit would break silently.
--
-- Nothing here is ever withheld (D13): every table this reads -- songs,
-- music_requests, music_genres -- is gated by music.view, which is this panel's
-- own gate. The withheld key is still present and empty, so the three payloads
-- share one shape and one Zod schema.
--
-- "Total" is reported twice, separately labelled: §4.2 does not say whether it
-- meant the catalogue or the requests, and the two answer different questions.
```

The body follows `0118`'s structure: the same `station` CTE, then `song` (joined to `station`, `deleted_at is null`), `request` (same, plus the join to `song`), `cards` (`catalogue` as of each window's end from `songs.created_at`, `new_songs` in each window, `requests` in each window), `monthly` over requests, and `top.songs` / `top.genres` (top ten by request count in the window, tie-broken by title and name).

The two breakdowns are the part that is **not** like `0118` and the part D8 exists for, so they are written out here rather than described:

```sql
  -- Every value of the enum, whether or not it was requested, plus the rows
  -- whose song never had the attribute filled in. Built by LEFT JOINing the
  -- enum to the counts, so a value with no requests reports 0 instead of
  -- vanishing from the chart -- and by UNIONing an explicit null bucket, so
  -- the slices sum to the request total printed beside them. A chart whose
  -- parts do not sum to its whole is a chart that lies quietly.
  nationality as (
    select jsonb_agg(jsonb_build_object('key', b.key, 'label', b.label, 'count', b.n)
                     order by b.sort, b.label) as rows
      from (
        select v::text as key, v::text as label, 0 as sort,
               count(r.id) as n
          from unnest(enum_range(null::public.music_nationality)) as v
          left join request r on r.nationality = v
         group by v
        union all
        select 'NOT_STATED', 'Not stated', 1,
               count(r.id)
          from request r
         where r.nationality is null
      ) b
  ),
  -- Identical shape over music_vocal, which has FIVE values -- MALE, FEMALE,
  -- DUO, GROUP, INSTRUMENTAL -- and not the two master spec §4.2 named.
  vocal as (
    select jsonb_agg(jsonb_build_object('key', b.key, 'label', b.label, 'count', b.n)
                     order by b.sort, b.label) as rows
      from (
        select v::text as key, v::text as label, 0 as sort,
               count(r.id) as n
          from unnest(enum_range(null::public.music_vocal)) as v
          left join request r on r.vocal = v
         group by v
        union all
        select 'NOT_STATED', 'Not stated', 1,
               count(r.id)
          from request r
         where r.vocal is null
      ) b
  ),
```

This requires `request` to carry `nationality` and `vocal` from the joined song — select them in that CTE rather than joining `songs` twice.

`comment on function` must state: the five vocal values and the null bucket, that the buckets sum to the request total, that both "totals" are reported, and that `withheld` is always empty here and why.

- [ ] **Step 4: Run the tests to make sure they pass**

Run: `npm run db:reset && npm run db:test`
Expected: PASS — 42 assertions, `Result: PASS`.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/0119_music_dashboard.sql supabase/tests/20_dashboards.test.sql
git commit -m "feat(dashboards): the music panel, with the three vocal values the spec forgot"
```

---

### Task 5: `get_promotions_dashboard`, and the rule that now lives twice

**Files:**
- Create: `supabase/migrations/0120_promotions_dashboard.sql`
- Create: `tests/unit/promotion-situation-boundary.test.ts`
- Modify: `src/lib/promotion-situation.ts` (comment only)
- Modify: `supabase/tests/20_dashboards.test.sql` (raise `plan(42)` to `plan(53)`)

**Interfaces:**
- Consumes: `public.resolve_dashboard_period` (Task 2); the payload contract of Task 3.
- Produces: `public.get_promotions_dashboard(p_company_ids uuid[], p_preset text, p_from date, p_to date) returns jsonb`. `cards`: `live_now`, `ended`, `participations`†, `distinct_participants`†, `awarded`, `overdue`. `breakdowns`: `participation_status`†, `prize_cycle`. `top`: `promotions`†. († withheld without `participations.view`.) `live_now` and `overdue` carry no `previous`.

- [ ] **Step 1: Write the failing tests — SQL and TypeScript, at the same instants**

D11 accepts a second copy of the situation rule on the condition that both copies are proved at the same boundary instants. Write both halves now.

Append to `supabase/tests/20_dashboards.test.sql` (change `plan(42)` to `plan(53)`) — fixtures plus these assertions, numbered from wherever Task 4 left off, keeping `plan(N)` equal to the real count (53 after this task). The `promotion_is_live` assertions need no role switch: it reads no table. Everything calling `get_promotions_dashboard` runs as `d8u01` unless stated.

```sql
-- FIXTURES: do not invent these inserts. supabase/tests/13_pickup_reads.test.sql
-- lines 42-130 already build the whole chain -- promotion, prize,
-- promotion_prizes, participations, draws, winners -- with the exact column
-- lists those tables require. Copy that block, retag every id to the d8 range,
-- and change three things:
--   * the promotion runs 2026-08-10 to 2026-08-20 (inside the test window);
--   * add four participations, one per participation_status value
--     (VALID, DUPLICATE, TOO_SOON, OVER_LIMIT), all with participated_at
--     inside August 2026;
--   * add a SECOND draw marked CANCELLED with its own winner left at
--     AWAITING_PICKUP -- that row is what assertion 43 below proves is
--     counted nowhere, and without it the assertion passes vacuously.

-- The situation rule, at the three instants that matter. The window is
-- half-open, so a promotion is live AT its start and over AT its end.
select is(public.promotion_is_live('2026-08-10 00:00:00+00'::timestamptz,
                                   '2026-08-20 00:00:00+00'::timestamptz,
                                   null,
                                   '2026-08-10 00:00:00+00'::timestamptz),
          true,  'a promotion is live at the instant it starts');
select is(public.promotion_is_live('2026-08-10 00:00:00+00'::timestamptz,
                                   '2026-08-20 00:00:00+00'::timestamptz,
                                   null,
                                   '2026-08-20 00:00:00+00'::timestamptz),
          false, 'a promotion is over at the instant it ends');
select is(public.promotion_is_live('2026-08-10 00:00:00+00'::timestamptz,
                                   '2026-08-20 00:00:00+00'::timestamptz,
                                   '2026-08-15 00:00:00+00'::timestamptz,
                                   '2026-08-16 00:00:00+00'::timestamptz),
          false, 'a cancelled promotion is never live');

-- A cancelled draw awards nothing (D12), the same exclusion 0094 and 0095 both
-- carry and for the same reason: cancel_draw reverses the unit but leaves
-- winners.status at AWAITING_PICKUP, so this -- the third reader to treat that
-- status as live -- must say so itself.
select is(
  (public.get_promotions_dashboard(array['00000000-0000-0000-0000-0000000d8c01']::uuid[],
     'custom', '2026-08-01', '2026-09-01') #>> '{cards,awarded,current}')::int,
  1, 'a winner of a cancelled draw is not counted as awarded');

-- The refusal breakdown, which is why this panel covers the entry side at all:
-- it is the number that shows a per-person rule turning real people away.
select is(
  (select sum((value ->> 'count')::int)::int
     from jsonb_array_elements(
       public.get_promotions_dashboard(array['00000000-0000-0000-0000-0000000d8c01']::uuid[],
         'custom', '2026-08-01', '2026-09-01') #> '{breakdowns,participation_status}')),
  (public.get_promotions_dashboard(array['00000000-0000-0000-0000-0000000d8c01']::uuid[],
     'custom', '2026-08-01', '2026-09-01') #>> '{cards,participations,current}')::int,
  'the four refusal buckets sum to the participation total');

-- D13 again, on the panel where it bites hardest: no participations.view means
-- the entry side is withheld and the PRIZE CYCLE SURVIVES, because winners is
-- gated by promotions.view -- this panel's own gate. d8u02 is exactly that
-- caller, and this pair of assertions is the whole reason the distinction
-- exists: one number goes away, the other must not.
reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-0000000d8u02", "role": "authenticated"}';
select is(
  (public.get_promotions_dashboard(array['00000000-0000-0000-0000-0000000d8c01']::uuid[],
     'custom', '2026-08-01', '2026-09-01') #> '{cards,participations}'),
  null, 'the entry figures are withheld without participations.view');
select isnt(
  (public.get_promotions_dashboard(array['00000000-0000-0000-0000-0000000d8c01']::uuid[],
     'custom', '2026-08-01', '2026-09-01') #> '{cards,awarded}'),
  null, 'the prize cycle survives, because winners is gated by promotions.view');
reset role;
```

Create `tests/unit/promotion-situation-boundary.test.ts` — the TypeScript half, at the identical instants:

```typescript
import { describe, expect, it } from 'vitest';
import { situationOf } from '@/lib/promotion-situation';

/**
 * The pair to supabase/tests/20_dashboards.test.sql's promotion_is_live
 * assertions. The Promotions dashboard has to classify a promotion in SQL,
 * while the grid and the record dialog classify it here, so the rule exists
 * twice — accepted in the design spec's D11 on the condition that both copies
 * are proved at the SAME instants. These are those instants. If either file
 * changes alone, one of them fails.
 */
const STARTS = '2026-08-10T00:00:00.000Z';
const ENDS = '2026-08-20T00:00:00.000Z';

describe('the promotion window is half-open, in TypeScript as in SQL', () => {
  it('is live at the instant it starts', () => {
    expect(
      situationOf({ startsAt: STARTS, endsAt: ENDS, cancelledAt: null }, new Date(STARTS)),
    ).toBe('live');
  });

  it('is ended at the instant it ends, not a moment after', () => {
    expect(
      situationOf({ startsAt: STARTS, endsAt: ENDS, cancelledAt: null }, new Date(ENDS)),
    ).toBe('ended');
  });

  it('is cancelled regardless of where the clock is', () => {
    expect(
      situationOf(
        { startsAt: STARTS, endsAt: ENDS, cancelledAt: '2026-08-15T00:00:00.000Z' },
        new Date('2026-08-16T00:00:00.000Z'),
      ),
    ).toBe('cancelled');
  });
});
```

- [ ] **Step 2: Run both to make sure they fail**

Run: `npm run db:test` → FAIL, `function public.promotion_is_live(...) does not exist`.
Run: `npx vitest run tests/unit/promotion-situation-boundary.test.ts` → this one may PASS immediately, because `situationOf` already exists and is already correct. **That is expected and fine**: its job is not to drive new code but to freeze the boundary so the SQL copy cannot drift from it. Note it in the commit message rather than inventing a failure.

- [ ] **Step 3: Write the migration**

Create `supabase/migrations/0120_promotions_dashboard.sql`, containing first the small classifier the tests call:

```sql
-- The situation rule, in SQL, for the second time in this codebase.
--
-- src/lib/promotion-situation.ts:14 is the first copy: the promotions grid and
-- the record dialog are client components and cannot call this. An aggregate
-- has to classify in the database, so the rule exists twice -- accepted in the
-- design spec's D11 on three conditions, all met here: the same half-open
-- window; each copy naming the other; and BOTH proved at the same boundary
-- instants (supabase/tests/20_dashboards.test.sql and
-- tests/unit/promotion-situation-boundary.test.ts).
--
-- Half-open, matching 0040's exclusion constraint: a promotion is live at the
-- instant it starts and over at the instant it ends.
create or replace function public.promotion_is_live(
  p_starts_at    timestamptz,
  p_ends_at      timestamptz,
  p_cancelled_at timestamptz,
  p_at           timestamptz
)
returns boolean
language sql
immutable
set search_path = pg_catalog, public
as $$
  select p_cancelled_at is null
     and p_at >= p_starts_at
     and p_at <  p_ends_at;
$$;

comment on function public.promotion_is_live(timestamptz, timestamptz, timestamptz, timestamptz) is
  'Whether a promotion is on air at a given instant: not cancelled, started, and not yet ended, over a half-open window matching 0040''s exclusion constraint. THE SECOND COPY of a rule src/lib/promotion-situation.ts also holds -- the grid and the record dialog are client components and cannot call a database function, and an aggregate cannot call TypeScript. Design spec D11 accepts the duplication only because both copies are pinned at the same three boundary instants by paired tests; change one and the other fails.';
```

then `get_promotions_dashboard`, in the shape of `0118`, with `promotions.view` as the gate, `participations.view` driving `withheld`, `promotion_is_live(..., now())` behind `live_now`, and the cancelled-draw exclusion applied to every winner-derived figure:

```sql
  -- D12. cancel_draw (0079) reverses the prize unit but deliberately leaves
  -- winners.status at AWAITING_PICKUP -- 6a has no vocabulary for "un-awarded".
  -- list_pickups (0095) and sweep_pickup_deadlines (0094) both exclude these
  -- rows and each says why in its own header; this is the third reader to treat
  -- AWAITING_PICKUP as live and so the third that has to. Counting them would
  -- report prizes handed out that were taken back before anyone was told.
  winner as (
    select w.*, s.*
      from public.winners w
      join station s on s.id = w.company_id
      join public.draws d on d.id = w.draw_id and d.status <> 'CANCELLED'
  ),
```

- [ ] **Step 4: Run everything to make sure it passes**

Run: `npm run db:reset && npm run db:test` → PASS, 53 assertions.
Run: `npx vitest run tests/unit/promotion-situation-boundary.test.ts` → PASS, 3 tests.

- [ ] **Step 5: Add the comment pointing back**

In `src/lib/promotion-situation.ts`, extend the doc comment above `situationOf` with:

```typescript
 * A SECOND COPY of this rule lives in SQL, in
 * supabase/migrations/0120_promotions_dashboard.sql's promotion_is_live: the
 * Promotions dashboard aggregates in the database and cannot call this, exactly
 * as this cannot call that. Design spec D11 accepts the duplication only
 * because both are pinned at the same boundary instants — here by
 * tests/unit/promotion-situation-boundary.test.ts and there by
 * supabase/tests/20_dashboards.test.sql. Change this rule and change both.
```

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/0120_promotions_dashboard.sql supabase/tests/20_dashboards.test.sql tests/unit/promotion-situation-boundary.test.ts src/lib/promotion-situation.ts
git commit -m "feat(dashboards): the promotions panel, and the situation rule pinned on both sides"
```

---

### Task 6: The isolation suite

The pgTAP suite proves arithmetic against a stubbed `has_permission`. This proves the real thing, with real users and real JWTs, and it is the only place that does.

**Files:**
- Create: `tests/isolation/dashboards.test.ts`

**Interfaces:**
- Consumes: `tests/isolation/harness.ts` — `provisionCustomer`, `addCompany`, `createUser`, `signInAs`, `createRoleAs`, `grantRoleWith`, `addMemberByInvitation`, `createMemberAs`, `cleanupUsers`. Read the file before writing; match the signatures exactly.
- Produces: nothing other tasks consume.

- [ ] **Step 1: Write the failing test**

Create `tests/isolation/dashboards.test.ts` covering, each with a real signed-in client calling `.rpc('get_audience_dashboard', {...})`:

1. **A Station's numbers do not cross.** A user with `members.view` in Station A only: calling for A succeeds; calling for B raises `42501`; calling for `[A, B]` raises `42501` — **not** a payload silently reduced to A.
2. **Consolidated needs the code in every Station.** A user with `members.view` and `reports.consolidated` in A, and `members.view` alone in B: `[A]` succeeds, `[A, B]` raises `42501`.
3. **The panel gates are independent.** A user holding `music.view` but not `members.view` is refused by `get_audience_dashboard` and served by `get_music_dashboard`.
4. **The withheld contract, end to end (D13).** A user with `members.view` and no `participations.view`: the payload's `withheld` names `took_part`, and `cards.took_part` is `undefined` — assert both, because a zero would satisfy neither.
5. **The prize cycle survives that same caller** on `get_promotions_dashboard`, while its entry figures are withheld.
6. **An archived promotion's rows do not reach a non-owner's totals** — archive a promotion with participations, then assert the participation figure drops for a non-owner and holds for the Organization's owner.

Each assertion in its own `it(...)`. Follow `tests/isolation/pickups.test.ts` for setup style and `cleanupUsers()` in `afterAll`.

- [ ] **Step 2: Run it to make sure it fails**

Run: `npm run test:isolation`
Expected: FAIL — before Tasks 1–5 are merged, the RPCs do not exist. After them, this must pass; if any case passes for the wrong reason (an empty payload rather than a raise), fix the function, not the test.

- [ ] **Step 3: Make it pass**

No new production code should be needed. If a case fails, the fix belongs in `0118`–`0120` — most likely a missing `has_permission` branch or a figure that returns `0` where it should be withheld.

- [ ] **Step 4: Run the full suite**

Run: `npm run test:isolation`
Expected: PASS, all cases.

- [ ] **Step 5: Commit**

```bash
git add tests/isolation/dashboards.test.ts
git commit -m "test(dashboards): the boundaries proved with real JWTs, not a stub"
```

---

### Task 7: The schemas and the service

**Files:**
- Create: `src/schemas/dashboards.ts`
- Create: `src/services/dashboards.ts`
- Create: `src/app/(app)/dashboards/period.ts`
- Create: `src/app/(app)/dashboards/errors.ts`
- Create: `tests/unit/dashboards-period.test.ts`

**Interfaces:**
- Consumes: the three RPCs (Tasks 3–5).
- Produces:
  ```typescript
  // src/app/(app)/dashboards/period.ts
  export type PeriodPreset = 'current_month' | 'previous_month' | 'current_year' | 'custom';
  export interface PeriodSelection { preset: PeriodPreset; from: string | null; to: string | null }
  export function parsePeriod(params: { preset?: string; from?: string; to?: string }): PeriodSelection;
  export function periodHref(base: string, selection: PeriodSelection, companyIds: string[]): string;

  // src/schemas/dashboards.ts
  export const audienceDashboardSchema: z.ZodType<AudienceDashboard>;
  export const musicDashboardSchema: z.ZodType<MusicDashboard>;
  export const promotionsDashboardSchema: z.ZodType<PromotionsDashboard>;
  export type AudienceDashboard = { period: Period; stations: Station[]; cards: Record<string, Card | undefined>; monthly: MonthPoint[]; breakdowns: Record<string, Slice[]>; top: Record<string, Slice[]>; withheld: Withheld[] };

  // src/services/dashboards.ts  (all 'server-only')
  export async function getAudienceDashboard(companyIds: string[], period: PeriodSelection): Promise<AudienceDashboard>;
  export async function getMusicDashboard(companyIds: string[], period: PeriodSelection): Promise<MusicDashboard>;
  export async function getPromotionsDashboard(companyIds: string[], period: PeriodSelection): Promise<PromotionsDashboard>;
  ```

- [ ] **Step 1: Write the failing test**

Create `tests/unit/dashboards-period.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { parsePeriod } from '@/app/(app)/dashboards/period';

describe('the period search params', () => {
  it('defaults to the current month when nothing is asked for', () => {
    expect(parsePeriod({})).toEqual({ preset: 'current_month', from: null, to: null });
  });

  it('keeps a known preset', () => {
    expect(parsePeriod({ preset: 'current_year' })).toEqual({
      preset: 'current_year', from: null, to: null,
    });
  });

  // A typo in a URL must not silently answer a different question. The database
  // refuses an unknown preset with 22023 (0117); this refuses it earlier, so the
  // screen can say so without a round trip.
  it('falls back to the current month for an unknown preset', () => {
    expect(parsePeriod({ preset: 'last_tuesday' })).toEqual({
      preset: 'current_month', from: null, to: null,
    });
  });

  it('keeps a custom range only when both bounds are real dates', () => {
    expect(parsePeriod({ preset: 'custom', from: '2026-08-01', to: '2026-09-01' })).toEqual({
      preset: 'custom', from: '2026-08-01', to: '2026-09-01',
    });
    expect(parsePeriod({ preset: 'custom', from: '2026-08-01' })).toEqual({
      preset: 'current_month', from: null, to: null,
    });
    expect(parsePeriod({ preset: 'custom', from: 'yesterday', to: 'today' })).toEqual({
      preset: 'current_month', from: null, to: null,
    });
  });

  it('refuses a range that ends before it starts', () => {
    expect(parsePeriod({ preset: 'custom', from: '2026-09-01', to: '2026-08-01' })).toEqual({
      preset: 'current_month', from: null, to: null,
    });
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npx vitest run tests/unit/dashboards-period.test.ts`
Expected: FAIL — cannot resolve `@/app/(app)/dashboards/period`.

- [ ] **Step 3: Write `period.ts`, then the schemas, then the service**

`period.ts` — pure, no imports beyond types. A date is accepted only if it matches `/^\d{4}-\d{2}-\d{2}$/` **and** round-trips through `Date.parse` to the same string, so `2026-02-31` is refused.

`src/schemas/dashboards.ts` — one shared `cardSchema` (`{ current: number, previous?: number }`), `sliceSchema` (`{ id?: string|null, key?: string, label: string, count: number }`), `monthPointSchema`, `periodSchema`, `stationSchema`, `withheldSchema` (`{ figure: string, needs: string }`), then one schema per dashboard naming its own `cards`, `breakdowns` and `top` keys. `cards` entries are `.optional()` — that optionality **is** the withheld contract (D13), and a `.default(0)` anywhere in this file would destroy it.

`src/services/dashboards.ts` — `import 'server-only'` first, `createUserClient()`, `.rpc('get_audience_dashboard', { p_company_ids, p_preset, p_from, p_to })`, then `schema.parse(data)`. On `error`, throw through `src/lib/errors.ts` the way `services/templates.ts` does. Never `as` a cast — `parse` is what makes the type true.

`src/app/(app)/dashboards/errors.ts` — map `42501` to "You do not have permission to see this dashboard in every station selected." and `22023` to "That period is not valid." following `src/app/(app)/templates/errors.ts`.

- [ ] **Step 4: Run the tests to make sure they pass**

Run: `npx vitest run tests/unit/dashboards-period.test.ts` → PASS.
Run: `npm run typecheck` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/schemas/dashboards.ts src/services/dashboards.ts "src/app/(app)/dashboards/period.ts" "src/app/(app)/dashboards/errors.ts" tests/unit/dashboards-period.test.ts
git commit -m "feat(dashboards): the payload nothing trusts until Zod says so"
```

---

### Task 8: Recharts and the four charts

**Files:**
- Modify: `package.json`
- Create: `src/components/charts/chart-colors.ts`
- Create: `src/components/charts/monthly-bars.tsx`
- Create: `src/components/charts/breakdown-bars.tsx`
- Create: `src/components/charts/top-list.tsx`
- Create: `src/components/charts/split-donut.tsx`

**Interfaces:**
- Consumes: the `Slice` and `MonthPoint` types from `src/schemas/dashboards.ts` (Task 7).
- Produces:
  ```typescript
  export function MonthlyBars(props: { data: MonthPoint[]; label: string }): JSX.Element;
  export function BreakdownBars(props: { data: Slice[]; label: string }): JSX.Element;
  export function TopList(props: { data: Slice[]; label: string }): JSX.Element;
  export function SplitDonut(props: { data: Slice[]; label: string }): JSX.Element;
  export const CHART_COLORS: readonly string[];
  ```

- [ ] **Step 1: Install the dependency**

```bash
npm install recharts@^3.10.1
```

`recharts@3.10.1` declares `react ^19` and `react-is` among its peers. Confirm npm resolved `react-is`; if it warns, install it explicitly. This is the project's first third-party UI dependency, so it goes in `dependencies`, not `devDependencies`.

- [ ] **Step 2: Verify the build still closes**

Run: `npm run build`
Expected: PASS. Note the reported First Load JS for the app shell in the commit message — the report in Task 10 quotes the before/after.

- [ ] **Step 3: Write the colours**

`src/components/charts/chart-colors.ts` — an array of `hsl(var(--chart-N))` strings, with the variables added to `globals.css` for both themes. **No hex literals in a chart component**: this codebase themes through CSS variables, and a hardcoded palette is a chart that is unreadable in the dark theme.

- [ ] **Step 4: Write the four components**

Each begins with `'use client'` — Recharts touches the DOM and cannot render on the server. Each takes plain serializable props, renders inside `<ResponsiveContainer>`, and carries an accessible name via the `label` prop. None of them fetches, computes or reshapes: **all arithmetic happened in SQL**, and a chart that recomputes is a second place for a number to be wrong.

Before writing them, invoke the `dataviz` skill — it is the house style for anything with an axis, and this block adds every chart the product will have.

- [ ] **Step 5: Verify**

Run: `npm run lint && npm run typecheck && npm run build`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json src/components/charts src/app/globals.css
git commit -m "feat(dashboards): the first chart dependency this project has taken, and the four shapes it draws"
```

---

### Task 9: The three pages and the navigation

**Files:**
- Create: `src/app/(app)/dashboards/period-control.tsx`
- Create: `src/app/(app)/dashboards/consolidated-toggle.tsx`
- Create: `src/app/(app)/dashboards/dashboard-cards.tsx`
- Create: `src/app/(app)/dashboards/audience/page.tsx`
- Create: `src/app/(app)/dashboards/music/page.tsx`
- Create: `src/app/(app)/dashboards/promotions/page.tsx`
- Modify: `src/components/layout/app-shell.tsx` (one new `ICONS` entry)
- Modify: `src/lib/auth/shell.ts` (the new nav section)

**Interfaces:**
- Consumes: `getAudienceDashboard` / `getMusicDashboard` / `getPromotionsDashboard` and `parsePeriod` (Task 7); the four chart components (Task 8); `listCompanyAccess`, `STATION_SEARCH_MAX_LENGTH`, `StationSearchForm`, `ViewableCompany`, `SuspendedCompany` from `src/app/(app)/inventory/station-access.ts`; `PageHeader` from `src/components/layout/app-shell`.
- Produces: three routes. Nothing consumes them.

- [ ] **Step 1: Add the glyph and the nav section**

In `src/components/layout/app-shell.tsx`, add to `ICONS` a bar-chart path, with a comment in the style of its neighbours explaining why it is new: the eleven existing glyphs are objects or people, and none of them means *a measure*.

In `src/lib/auth/shell.ts`, insert a section **first**, above Inventory:

```typescript
    {
      // Visible to every member, including those holding members.view,
      // music.view and promotions.view in no Station at all — the same
      // courtesy every section below extends. Each of the three pages
      // redirects at the top of its own render for a caller who holds its
      // permission nowhere, and the three functions in 0118–0120 re-check
      // it themselves regardless of that redirect, raising 42501 rather
      // than returning a page of zeros. Hiding a link is a courtesy; the
      // boundary is in the database.
      label: 'Dashboards',
      items: [
        { href: '/dashboards/audience', label: 'Audience', icon: ICONS.chart },
        { href: '/dashboards/music', label: 'Music', icon: ICONS.music },
        { href: '/dashboards/promotions', label: 'Promotions', icon: ICONS.megaphone },
      ],
    },
```

- [ ] **Step 2: Write the shared controls**

`period-control.tsx` (client) — four buttons plus two date inputs, each a `<Link>` built by `periodHref`, so a period is a URL somebody can send. The active preset carries `aria-current="page"`.

`consolidated-toggle.tsx` (client) — renders **only** when the caller holds `reports.consolidated` in at least two reachable Stations; the page decides that and passes a boolean. A courtesy, not the boundary (D3 is re-checked in SQL).

`dashboard-cards.tsx` (server) — takes `cards` and `withheld` and renders one tile each. A card in `withheld` renders an em dash and the sentence "Needs `<permission>`". **Never `?? 0`** anywhere in this file: that single fallback would turn the whole withheld contract back into the zero it exists to avoid.

- [ ] **Step 3: Write the three pages**

Each follows `src/app/(app)/templates/messages/page.tsx` exactly: `dynamic = 'force-dynamic'`, `getUser()` then `redirect('/login')`, `listCompanyAccess(supabase, '<domain>.view', stationSearch)`, the no-match-for-a-search branch **before** the redirect so a search can always be undone, then `redirect('/app')` when the caller holds the permission nowhere. Then `parsePeriod(await searchParams)`, one service call, and the cards, charts and top lists.

A page renders a note when the selected Stations do not share a timezone: the dates are the same everywhere, the instants are not.

- [ ] **Step 4: Verify**

Run: `npm run lint && npm run typecheck && npm run build`
Expected: all PASS. `next` typed routes will only accept the three new `href`s once the page files exist — if `Route` complains, the page file is missing or misnamed.

- [ ] **Step 5: Commit**

```bash
git add "src/app/(app)/dashboards" src/components/layout/app-shell.tsx src/lib/auth/shell.ts
git commit -m "feat(dashboards): three screens, one period in the URL, and a withheld figure that shows as a dash"
```

---

### Task 10: The round trip, the report and the runbook

**Files:**
- Create: `tests/e2e/dashboards.spec.ts`
- Create: `docs/block-8a-report.md`
- Create: `docs/block-8a-runbook.md`

- [ ] **Step 1: Write the e2e**

Create `tests/e2e/dashboards.spec.ts`, following `tests/e2e/inventory-flow.spec.ts` for sign-in and seeding: sign in, open `/dashboards/audience`, assert a known figure from the seed, switch the period to `previous_month` and assert the figure changes, assert a chart rendered (`getByRole('img')` or the container's `data-testid`), and assert the nav link is reachable by `getByRole('link', { name: 'Audience' })`.

- [ ] **Step 2: Run the whole gate**

Run, in order, and record the real output of each:

```bash
npm run lint
npm run typecheck
npm test
npm run db:reset && npm run db:test
npm run test:isolation
npm run build
npm run test:e2e
```

**On the e2e:** this machine reproduces 15 failures / 2 not run / 13 passed at default parallelism against local Supabase — sign-in contention, not code; serial is 30/30. If that pattern appears, run `npx playwright test --workers=1` and record **both** numbers. Do not report a clean run you did not get.

- [ ] **Step 3: Write the report**

`docs/block-8a-report.md`, in the shape of `docs/block-7b-report.md`: what shipped, the gate table with **this block's own measured numbers**, the decisions that changed during implementation (D10's narrowing and D13 were both found while writing this plan, not during brainstorming — say so), and what Block 8b inherits.

- [ ] **Step 4: Write the runbook**

`docs/block-8a-runbook.md`. It **must open** with the trap 7a paid for and 8a re-arms:

> **The database and the frontend deploy separately.** `has_permission`'s first line requires the permission code to exist in `public.permissions`. `reports.consolidated` ships in `0115`, and a frontend deployed ahead of `supabase db push` will offer the consolidated control and fail every call behind it with a message that does not look like a deploy problem.

Then: apply `0115`–`0120`; verify each function exists and its grants; **assign `reports.consolidated` to the roles that should have it, knowing that unlike `music.request` in 7a this code is live the day it lands** — any role holding it reads the whole group's numbers at once; and walk each of the three screens at one Station and at two.

Add the standing check this project has now paid for twice: after every merged PR carrying a migration, run `npx supabase migration list` and `supabase db push` if the remote is behind. Nothing in `ci.yml` does this.

- [ ] **Step 5: Commit**

```bash
git add tests/e2e/dashboards.spec.ts docs/block-8a-report.md docs/block-8a-runbook.md
git commit -m "docs: what Block 8a built, what it measured, and what 8b inherits"
```

---

## Self-review — spec coverage

| spec requirement | task |
|---|---|
| D1 — 8a is the dashboards; 8b is the reports | scope of this plan; restated in Task 10's report |
| D2 — each panel gated by its domain's code | Tasks 3, 4, 5 (the permission loop); Task 6 case 3 |
| D3 — consolidated needs `reports.consolidated` in every Station | Task 1 (the code), Tasks 3–5 (the check), Task 6 cases 1–2 |
| D4 — `SECURITY INVOKER`, 42501 rather than zeros | Tasks 3–5; Task 6 case 1 asserts the raise, not a reduced payload |
| D5 — local dates, presets resolved in SQL per Station | Task 2; Task 3 assertions 22–24 |
| D6 — comparison window, stock measured at window end | Task 2 assertions 8–9; Task 3 assertion 25 |
| D7 — Recharts | Task 8 |
| D8 — every enum value plus "not stated" | Task 4 assertions 35–36 |
| D9 — new listener is a new link | Task 1 (the index), Task 3 |
| D9b — a suspended Station is already refused | inherited; asserted indirectly by Task 6 case 1 |
| D10 — "took part" is participations only | Tasks 3, 5 |
| D11 — the situation rule, pinned on both sides | Task 5 steps 1, 3, 5 |
| D12 — a cancelled draw awards nothing | Task 5 |
| D13 — withheld, never zeroed | Tasks 3, 5, 6 cases 4–5; Task 9 step 2's "never `?? 0`" |
| §3.1–3.3 — the indicators | Tasks 3, 4, 5 |
| §4 — the payload shape | Task 3 (contract), Task 7 (the Zod copy of it) |
| §5 — the screens, the nav, the layering | Tasks 7, 9 |
| §6 — six migrations and three indexes | Tasks 1–5 |
| §7 — the verification gate | Tasks 1–6, 10 |
| §8 — what 8b inherits, and the deploy trap | Task 10 |

**Deliberately not in this plan:** Excel/CSV/PDF export, asynchronous generation, `saved_reports`, scheduled or emailed reports — all Block 8b. Also not here: moving `listCompanyAccess` out of `src/app/(app)/inventory/`, where it has lived since Block 2 despite now serving six features. This block adds three more importers and makes the case stronger, but it is a rename touching ten files and belongs in its own commit, not inside a block that already adds six migrations and a chart library.
