# Block 8b — The Report Engine — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn every question the dashboards and listing screens can answer into a downloadable file, generated asynchronously by the worker, scoped to exactly what the requester was entitled to read.

**Architecture:** A request becomes a `report_runs` row. The worker tick claims one run, loops keyset pages out of a `SECURITY DEFINER` page function that re-checks the *requester's* permission on every page, streams them into CSV or XLSX, and uploads to a private bucket. Panels are different: their numbers are captured at request time by the same aggregate call the screen makes, and the worker only renders the stored payload into a PDF.

**Tech Stack:** Postgres 15 / Supabase, `pg_cron` → `pg_net` → Next.js route handler, `exceljs` (streaming writer), `@react-pdf/renderer`, Zod, Vitest, pgTAP, Playwright.

**Spec:** `docs/superpowers/specs/2026-08-05-block-8b-report-engine-design.md`

## Global Constraints

- **Migrations are `0121`–`0128`, in that order, and the order has no forward references.** The page functions precede the lifecycle RPCs because `request_report` calls the dispatcher.
- **Never edit a migration in place once it is pushed to the hosted project.** Migrations go up only after the PR merges (see the Block 8a note in memory); until then, in-place editing on the branch is correct and expected.
- **No export carries a full CPF.** `0031_members.sql` stores `cpf_hash` (SHA-256) and `cpf_last_digits` (3 digits). The raw number does not exist in the database.
- **A withheld column is absent from the file, never present-and-empty.** An empty `phone` column is a false statement about people.
- **`SECURITY DEFINER` functions pin `set search_path = pg_catalog, public`.** Procedures that `commit` do not, and must not — `0094`'s header gives the reason.
- **Row ceiling: 50 000.** Refuse, never truncate.
- **All identifiers, comments, commit messages and documentation in English.** Owner-facing conversation is in Portuguese; the code is not.
- **Every task ends with its own gate green** (`npm run lint`, `npm run typecheck`, `npm test`, `npm run db:test` as applicable) and its own commit.
- **`npm run db:test` requires a running local stack** (`npx supabase start`). After `supabase db reset`, Kong can go blind to new functions — restart the stack if a freshly created RPC 404s (memory: Block 3c).

---

## File Structure

**Migrations** (`supabase/migrations/`)

| file | responsibility |
| --- | --- |
| `0121_permission_for.sql` | `is_platform_admin_for`, `is_owner_for`, `has_company_access_for`, `has_permission_for`; the four existing signatures become one-line wrappers |
| `0122_report_runs.sql` | `report_type` and `report_status` enums, `report_runs`, indexes, RLS |
| `0123_reports_bucket.sql` | the private `reports` bucket and its `storage.objects` policies |
| `0124_report_pages_a.sql` | `report_page_listeners`, `report_page_participations` |
| `0125_report_pages_b.sql` | `report_page_winners`, `report_page_music_requests`, `report_page_movements` |
| `0126_report_page.sql` | the `report_page` dispatcher |
| `0127_report_run_rpcs.sql` | `request_report`, `claim_report_run`, `finish_report_run`, `fail_report_run`, `requeue_stalled_report_runs` |
| `0128_expire_report_runs.sql` | the expiry procedure and its `cron.schedule` |

**Node** (`src/`)

| file | responsibility |
| --- | --- |
| `schemas/reports.ts` | Zod: the eight report types, per-type filter schemas as a discriminated union, the run row, the page row |
| `services/reports.ts` | `requestReport`, `listMyReportRuns`, `signedUrlForRun` — the caller-side surface |
| `lib/reports/types.ts` | shared types and the column definitions per report type |
| `lib/reports/provenance.ts` | the provenance block, in the three renderings |
| `lib/reports/csv.ts` | RFC 4180 escaping and the CSV writer |
| `lib/reports/xlsx.ts` | the streaming `WorkbookWriter` |
| `lib/reports/pdf.tsx` | the panel PDF document |
| `lib/reports/generate.ts` | the page loop, the ceiling re-check, the upload, the status transitions |
| `app/api/worker/tick/route.ts` | the third drain |
| `app/(app)/reports/*` | the `/reports` screen, its actions, the pending-run refresher |
| `app/(app)/*/export-button.tsx` | the export entry point on each listing screen and panel |

**Tests**

| file | responsibility |
| --- | --- |
| `supabase/tests/21_permission_for.test.sql` | the wrapper-equivalence matrix |
| `supabase/tests/22_reports.test.sql` | runs, bucket, page functions, lifecycle, expiry |
| `tests/isolation/reports.test.ts` | real JWTs across Stations, the withheld set, cross-user run access |
| `tests/unit/reports/*.test.ts` | schemas, CSV escaping, provenance, the page loop, the PDF renderer |
| `tests/e2e/reports.spec.ts` | filter → export → tick → download |

---

## Task 1: The two dependencies, proven rather than assumed

`@react-pdf/renderer@4.5.1` declares `react: ^19.0.0` in its peer dependencies and `exceljs` is at `4.4.0`. A declaration is not a proof: this task renders a real PDF to a Buffer and streams a real workbook, in Node, under this project's TypeScript settings, before anything else in the block depends on either.

**Files:**
- Modify: `package.json`
- Create: `tests/unit/reports/dependencies.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `exceljs` and `@react-pdf/renderer` installed and proven usable from Node under `tsx`/Vitest.

- [ ] **Step 1: Install both**

```bash
npm install exceljs@^4.4.0 @react-pdf/renderer@^4.5.1
```

- [ ] **Step 2: Write the failing test**

Create `tests/unit/reports/dependencies.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { PassThrough } from 'node:stream';

/**
 * Block 8b, Task 1. The Block 0 spec named both of these libraries and neither
 * was ever installed, so this block installs them — and this file is why the
 * install is a task rather than a line in another task's setup.
 *
 * @react-pdf/renderer renders through a React reconciler of its own. Its peer
 * range admits React 19, but a peer range is a promise about resolution, not
 * about behaviour, and the fallback if it is wrong (rendering the panel PDF
 * through the browser's print pipeline) is a different design that must be
 * chosen BEFORE the block is spent, not after.
 */
describe('Block 8b dependencies', () => {
  it('renders a PDF to a Buffer under React 19', async () => {
    const { Document, Page, Text, View, renderToBuffer } = await import('@react-pdf/renderer');
    const React = await import('react');

    const doc = React.createElement(
      Document,
      null,
      React.createElement(
        Page,
        { size: 'A4' },
        React.createElement(View, null, React.createElement(Text, null, 'PulchaTX')),
      ),
    );

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const buffer = await renderToBuffer(doc as any);
    expect(buffer.byteLength).toBeGreaterThan(0);
    // Every PDF begins with this. A renderer that silently produced an empty
    // or HTML body would still return a non-empty buffer.
    expect(buffer.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  });

  it('streams an XLSX workbook without building it in memory', async () => {
    const ExcelJS = (await import('exceljs')).default;

    const sink = new PassThrough();
    const chunks: Buffer[] = [];
    sink.on('data', (chunk: Buffer) => chunks.push(chunk));
    const done = new Promise<void>((resolve) => sink.on('end', () => resolve()));

    const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({ stream: sink });
    const sheet = workbook.addWorksheet('Rows');
    sheet.addRow(['a', 'b']).commit();
    sheet.commit();
    await workbook.commit();
    await done;

    const out = Buffer.concat(chunks);
    expect(out.byteLength).toBeGreaterThan(0);
    // XLSX is a ZIP container; 'PK' is the local file header signature.
    expect(out.subarray(0, 2).toString('latin1')).toBe('PK');
  });
});
```

- [ ] **Step 3: Run it**

Run: `npx vitest run tests/unit/reports/dependencies.test.ts`
Expected: PASS. **If the PDF test fails**, stop the block and report to the owner — the fallback (panel PDF through the print pipeline) changes Tasks 11 and 13 and is the owner's call, not the implementer's.

- [ ] **Step 4: Gate and commit**

```bash
npm run lint && npm run typecheck && npm test
git add package.json package-lock.json tests/unit/reports/dependencies.test.ts
git commit -m "build(reports): install exceljs and @react-pdf/renderer, and prove both run"
```

---

## Task 2: `has_permission_for` — the identity the worker can carry

The whole block rests on this. Four functions every RLS policy in the installation depends on gain a `_for` sibling taking an explicit user id, and the existing four become one-line wrappers over them. One body, two doors — two independent implementations would agree the day they were written and drift afterwards, and the drift would look like a number rather than a defect.

**Files:**
- Create: `supabase/migrations/0121_permission_for.sql`
- Create: `supabase/tests/21_permission_for.test.sql`

**Interfaces:**
- Consumes: `is_platform_admin()`, `is_owner(uuid)`, `has_company_access(uuid)`, `has_permission(text, uuid)` as they stand at `0024`.
- Produces: `public.has_permission_for(p_user_id uuid, p_permission text, p_company_id uuid) returns boolean`, plus `is_platform_admin_for(uuid)`, `is_owner_for(uuid, uuid)`, `has_company_access_for(uuid, uuid)`. All four `SECURITY DEFINER`, `stable`, granted to `authenticated` and `service_role`.

- [ ] **Step 1: Write the failing pgTAP test**

Create `supabase/tests/21_permission_for.test.sql`:

```sql
begin;
select plan(14);

-- Block 8b, Task 2. The wrapper-equivalence suite.
--
-- This file exists because 0121 splits four functions that every policy in the
-- installation depends on. The split is safe only while the two entry points
-- cannot disagree, and the only structural guarantee of that is that the old
-- signature has NO BODY OF ITS OWN. So the first four assertions check the
-- shape of the refactor, not its behaviour: a future editor who "optimises"
-- the wrapper by inlining its body reintroduces exactly the drift this design
-- rejected, and these assertions are what stops them.

select has_function('public', 'is_platform_admin_for', array['uuid'],
  'is_platform_admin_for(uuid) exists');
select has_function('public', 'is_owner_for', array['uuid', 'uuid'],
  'is_owner_for(uuid, uuid) exists');
select has_function('public', 'has_company_access_for', array['uuid', 'uuid'],
  'has_company_access_for(uuid, uuid) exists');
select has_function('public', 'has_permission_for', array['uuid', 'text', 'uuid'],
  'has_permission_for(uuid, text, uuid) exists');

-- The four old signatures delegate. `prosrc` of each must mention its sibling
-- and must NOT mention the tables the body used to read: the moment
-- has_permission's own source names company_memberships again, there are two
-- implementations.
select ok(
  (select prosrc from pg_proc where proname = 'has_permission'
     and pronargs = 2) like '%has_permission_for%',
  'has_permission delegates to has_permission_for');
select ok(
  (select prosrc from pg_proc where proname = 'has_permission'
     and pronargs = 2) not like '%company_memberships%',
  'has_permission keeps no body of its own');
select ok(
  (select prosrc from pg_proc where proname = 'has_company_access'
     and pronargs = 1) like '%has_company_access_for%',
  'has_company_access delegates');
select ok(
  (select prosrc from pg_proc where proname = 'is_owner'
     and pronargs = 1) like '%is_owner_for%',
  'is_owner delegates');

-- Behaviour. A null user id is not "everybody" -- it is the worker before it
-- has been told whose report it is generating, and it must be refused.
select ok(
  not public.has_permission_for(null, 'members.view',
    (select id from public.companies limit 1)),
  'a null user id holds nothing');

select ok(
  not public.has_permission_for(gen_random_uuid(), 'members.view',
    (select id from public.companies limit 1)),
  'an unknown user id holds nothing');

-- A code that does not exist is refused even for a user who holds everything.
-- This is 0010's rule and the split must not lose it: the existence check sits
-- OUTSIDE the platform-admin bypass.
select ok(
  not public.has_permission_for(
    (select user_id from public.platform_admins limit 1),
    'members.viwe',
    (select id from public.companies limit 1)),
  'a typo''d code is refused even for a platform admin');

select ok(
  public.has_permission_for(
    (select user_id from public.platform_admins limit 1),
    'members.view',
    (select id from public.companies where status = 'active' limit 1)),
  'a platform admin holds a real code on an active Station');

-- A suspended Station refuses everybody, admin included: has_company_access_for
-- carries the subscription term and has_permission_for must call it.
select ok(
  not public.has_permission_for(
    (select user_id from public.platform_admins limit 1),
    'members.view',
    (select id from public.companies where status <> 'active' limit 1)),
  'a suspended Station refuses even a platform admin')
  from (select 1) s
  where exists (select 1 from public.companies where status <> 'active');

select ok(
  public.is_platform_admin_for((select user_id from public.platform_admins limit 1)),
  'is_platform_admin_for recognises a seeded admin');

select ok(
  not public.is_platform_admin_for(gen_random_uuid()),
  'is_platform_admin_for refuses an unknown user');

select * from finish();
rollback;
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run db:test`
Expected: FAIL — `has_function` reports the four `_for` functions do not exist.

- [ ] **Step 3: Write the migration**

Create `supabase/migrations/0121_permission_for.sql`:

```sql
-- supabase/migrations/0121_permission_for.sql

-- Block 8b, Task 1: the identity the worker does not have.
--
-- THE FACT THIS FILE EXISTS FOR. The worker tick (src/app/api/worker/tick)
-- holds a service_role client. In it, auth.uid() is null -- a service_role JWT
-- carries no `sub` claim -- so is_platform_admin() is false, has_company_access
-- is false, and has_permission is false for every code and every Station. That
-- is correct behaviour and it is also why a background job cannot ask the
-- existing helpers anything useful: they can only answer about the caller, and
-- the worker is never the person whose report it is generating.
--
-- So each helper gains a sibling taking the user id explicitly, and each
-- EXISTING helper becomes a one-line wrapper passing auth.uid(). The wrapper
-- shape is the entire safety argument: two independent implementations of
-- "may this user read this" would agree on the day they were written and drift
-- afterwards, and a drift here does not look like a defect -- it looks like a
-- report with the wrong rows in it. 21_permission_for.test.sql asserts the old
-- signatures keep NO body of their own, so an editor who inlines one for
-- "performance" fails the suite rather than silently forking the rule.
--
-- Nothing about the AUTHORISATION RULES changes in this file. Every body below
-- is the body that stood after 0024, with `auth.uid()` replaced by the
-- parameter. If a reader diffs this against 0016/0024 and finds a difference
-- that is not that substitution, it is a defect in this migration.

-- ---------------------------------------------------------------------------
-- 1. is_platform_admin_for
-- ---------------------------------------------------------------------------

create or replace function public.is_platform_admin_for(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select exists (
    select 1 from public.platform_admins pa
    where pa.user_id = p_user_id
  );
$$;

comment on function public.is_platform_admin_for(uuid) is
  'Block 8b. Whether a NAMED user is a platform admin. is_platform_admin() is this with auth.uid(). A null p_user_id matches nothing, because platform_admins.user_id is NOT NULL -- which is the behaviour the worker needs: no identity means no rights.';

create or replace function public.is_platform_admin()
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select public.is_platform_admin_for(auth.uid());
$$;

-- ---------------------------------------------------------------------------
-- 2. is_owner_for
-- ---------------------------------------------------------------------------

create or replace function public.is_owner_for(p_user_id uuid, p_organization_id uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select exists (
    select 1 from public.organization_memberships om
    where om.user_id = p_user_id
      and om.organization_id = p_organization_id
      and om.role = 'owner'
      and om.deleted_at is null
  );
$$;

comment on function public.is_owner_for(uuid, uuid) is
  'Block 8b. Whether a NAMED user owns the Organization. is_owner(uuid) is this with auth.uid().';

create or replace function public.is_owner(p_organization_id uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select public.is_owner_for(auth.uid(), p_organization_id);
$$;

-- ---------------------------------------------------------------------------
-- 3. has_company_access_for
--
-- The subscription term (`c.status = 'active'`) stays INSIDE, exactly where
-- 0016 put it. It is what stops a lapsed customer from reading through a role
-- that still exists, and a background job is the last place it should be
-- optional.
-- ---------------------------------------------------------------------------

create or replace function public.has_company_access_for(p_user_id uuid, p_company_id uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select exists (
    select 1
    from public.companies c
    where c.id = p_company_id
      and c.status = 'active'
      and c.deleted_at is null
      and (
        public.is_platform_admin_for(p_user_id)
        or public.is_owner_for(p_user_id, c.organization_id)
        or exists (
          select 1 from public.company_memberships cm
          where cm.user_id = p_user_id
            and cm.company_id = c.id
            and cm.deleted_at is null
        )
      )
  );
$$;

comment on function public.has_company_access_for(uuid, uuid) is
  'Block 8b. Active subscription AND (platform admin OR owner of the Organization OR a live membership), for a NAMED user. has_company_access(uuid) is this with auth.uid(). The owner holds no membership row by design.';

create or replace function public.has_company_access(p_company_id uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select public.has_company_access_for(auth.uid(), p_company_id);
$$;

-- ---------------------------------------------------------------------------
-- 4. has_permission_for
--
-- The permission-existence check stays OUTSIDE every bypass, which is 0010's
-- rule and the one most easily lost in a refactor: written the obvious way,
-- `is_platform_admin_for(u) or exists(...)` short-circuits before
-- permission_code is ever compared, and a typo'd code would return true for an
-- admin on any active Company. 21_permission_for.test.sql asserts exactly that
-- case.
--
-- The live-role join (r.deleted_at is null) is 0024's Minor 2 and is carried
-- forward verbatim.
-- ---------------------------------------------------------------------------

create or replace function public.has_permission_for(
  p_user_id     uuid,
  p_permission  text,
  p_company_id  uuid
)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select exists (select 1 from public.permissions p where p.code = p_permission)
     and public.has_company_access_for(p_user_id, p_company_id)
     and (
       public.is_platform_admin_for(p_user_id)
       or exists (
         select 1 from public.companies c
         where c.id = p_company_id and public.is_owner_for(p_user_id, c.organization_id)
       )
       or exists (
         select 1
         from public.company_memberships cm
         join public.roles r on r.id = cm.role_id and r.deleted_at is null
         join public.role_permissions rp on rp.role_id = cm.role_id
         where cm.user_id = p_user_id
           and cm.company_id = p_company_id
           and cm.deleted_at is null
           and rp.permission_code = p_permission
       )
     );
$$;

comment on function public.has_permission_for(uuid, text, uuid) is
  'Block 8b. Valid code AND active subscription AND (admin OR owner OR the role assigned in THAT Company grants it) -- for a NAMED user rather than the caller. has_permission(text, uuid) is this with auth.uid(), and keeps no body of its own so the two can never disagree. This is what lets the worker tick generate a report scoped to the person who asked for it, having no identity of its own.';

create or replace function public.has_permission(p_permission text, p_company_id uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select public.has_permission_for(auth.uid(), $1, $2);
$$;

-- ---------------------------------------------------------------------------
-- Grants. The `_for` siblings go to service_role as well as authenticated,
-- which is the entire point of them; the wrappers keep exactly the grants
-- 0005 gave them and gain nothing.
-- ---------------------------------------------------------------------------

revoke execute on function public.is_platform_admin_for(uuid) from public;
revoke execute on function public.is_owner_for(uuid, uuid) from public;
revoke execute on function public.has_company_access_for(uuid, uuid) from public;
revoke execute on function public.has_permission_for(uuid, text, uuid) from public;

grant execute on function public.is_platform_admin_for(uuid) to authenticated, service_role;
grant execute on function public.is_owner_for(uuid, uuid) to authenticated, service_role;
grant execute on function public.has_company_access_for(uuid, uuid) to authenticated, service_role;
grant execute on function public.has_permission_for(uuid, text, uuid) to authenticated, service_role;
```

- [ ] **Step 4: Run the whole database suite, not just the new file**

Run: `npm run db:test`
Expected: PASS — `21_permission_for` green **and all twenty existing files still green**. This migration is a pure refactor of the functions every other test depends on; a regression here shows up as failures scattered across `02_rls`, `05_inventory`, `20_dashboards` and everything between. Those failures are the real signal, not the new file.

- [ ] **Step 5: Run the isolation suite**

Run: `npm run test:isolation`
Expected: 261/261 pass. pgTAP runs as superuser with a null `auth.uid()`, so it cannot see a permission regression at all — the isolation suite, with real JWTs, is the only thing in the repository that can.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/0121_permission_for.sql supabase/tests/21_permission_for.test.sql
git commit -m "feat(reports): give the permission helpers an explicit-identity door"
```

---

## Task 3: `report_runs` — the queue and the history in one table

**Files:**
- Create: `supabase/migrations/0122_report_runs.sql`
- Create: `supabase/tests/22_reports.test.sql` (grown by Tasks 4–9)

**Interfaces:**
- Consumes: `has_company_access_for` (Task 2).
- Produces: enums `public.report_type` (`LISTENERS`, `PARTICIPATIONS`, `WINNERS`, `MUSIC_REQUESTS`, `MOVEMENTS`, `AUDIENCE_PANEL`, `MUSIC_PANEL`, `PROMOTIONS_PANEL`), `public.report_format` (`CSV`, `XLSX`, `PDF`), `public.report_status` (`QUEUED`, `RUNNING`, `READY`, `FAILED`), and table `public.report_runs`.

- [ ] **Step 1: Write the failing pgTAP test**

Create `supabase/tests/22_reports.test.sql`:

```sql
begin;
select plan(12);

-- Block 8b. The report engine, from the table outward. Tasks 4-9 append to
-- this file and raise the plan count as they go.

select has_type('public', 'report_type',   'report_type exists');
select has_type('public', 'report_format', 'report_format exists');
select has_type('public', 'report_status', 'report_status exists');

select is(
  (select count(*)::int from pg_enum e
     join pg_type t on t.oid = e.enumtypid where t.typname = 'report_type'),
  8, 'report_type has the five listings and the three panels');

select has_table('public', 'report_runs', 'report_runs exists');

-- RLS on, and no policy that lets a client write status. The engine's whole
-- integrity rests on only service_role moving a run through its lifecycle: a
-- client that could set status = READY could point storage_path at another
-- Station's file.
select ok(
  (select relrowsecurity from pg_class where relname = 'report_runs'),
  'report_runs has RLS enabled');

select ok(
  not exists (
    select 1 from pg_policies
    where tablename = 'report_runs' and cmd in ('UPDATE', 'DELETE')
      and 'authenticated' = any(roles)
  ),
  'authenticated cannot update or delete a run');

select table_privs_are('public', 'report_runs', 'authenticated',
  array['SELECT'],
  'authenticated may only read runs');

-- A run is inserted by request_report (0127), never by a client directly.
select table_privs_are('public', 'report_runs', 'service_role',
  array['SELECT', 'INSERT', 'UPDATE', 'DELETE'],
  'service_role holds the DML the engine needs');

select has_index('public', 'report_runs', 'report_runs_claimable_idx',
  'the claim path is indexed');
select has_index('public', 'report_runs', 'report_runs_requester_idx',
  'the /reports screen is indexed');

-- A panel run carries a payload and a listing run does not. The CHECK is what
-- stops a panel reaching the worker with nothing to render, which would fail
-- ten seconds later instead of at the insert.
select throws_ok(
  $$insert into public.report_runs
      (organization_id, company_ids, requested_by, report_type, format, filters)
    values (gen_random_uuid(), array[gen_random_uuid()], gen_random_uuid(),
            'AUDIENCE_PANEL', 'PDF', '{}'::jsonb)$$,
  '23514',
  null,
  'a panel run without a payload is refused');

select * from finish();
rollback;
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run db:test`
Expected: FAIL — `has_type` reports `report_type` does not exist.

- [ ] **Step 3: Write the migration**

Create `supabase/migrations/0122_report_runs.sql`:

```sql
-- supabase/migrations/0122_report_runs.sql

-- Block 8b, Task 2: one table, which is both the queue and the history.
--
-- THE NAME. The master spec §11 calls this `saved_reports`. It is not called
-- that here, deliberately: the owner ruled that what gets saved is the record
-- of a GENERATION -- who asked for what, when, and where the file went -- and
-- not a named, re-runnable filter definition. A table called "saved reports"
-- holding a work queue misleads every future reader about what it is for.
-- §11's term maps to this table and to nothing else.
--
-- QUEUE AND HISTORY TOGETHER, rather than a jobs table draining into an
-- archive. A finished run is exactly a queued run with an outcome, and the two
-- questions an operator asks ("is it ready?" and "what did I export last
-- month?") are one query against one table. Splitting them would mean a
-- migration between two shapes at the moment of completion -- one more place
-- for a run to be lost.

create type public.report_type as enum (
  'LISTENERS',
  'PARTICIPATIONS',
  'WINNERS',
  'MUSIC_REQUESTS',
  'MOVEMENTS',
  'AUDIENCE_PANEL',
  'MUSIC_PANEL',
  'PROMOTIONS_PANEL'
);

create type public.report_format as enum ('CSV', 'XLSX', 'PDF');

create type public.report_status as enum ('QUEUED', 'RUNNING', 'READY', 'FAILED');

create table public.report_runs (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations(id),
  company_ids      uuid[] not null,
  requested_by     uuid not null references auth.users(id),
  report_type      public.report_type not null,
  format           public.report_format not null,
  filters          jsonb not null default '{}'::jsonb,
  payload          jsonb,
  status           public.report_status not null default 'QUEUED',
  storage_path     text,
  row_count        integer,
  byte_size        integer,
  withheld         text[] not null default '{}',
  attempts         integer not null default 0,
  last_error       text,
  requested_at     timestamptz not null default now(),
  started_at       timestamptz,
  finished_at      timestamptz,
  expires_at       timestamptz,

  constraint report_runs_companies_not_empty
    check (cardinality(company_ids) > 0),

  constraint report_runs_filters_is_object
    check (jsonb_typeof(filters) = 'object'),

  -- A panel's numbers are captured at request time, as the caller (design D2),
  -- because the aggregates are SECURITY INVOKER and granted to authenticated
  -- only -- the worker cannot call them at all. A panel run with no payload is
  -- therefore unrenderable, and this refuses it at the insert rather than ten
  -- seconds later in the tick.
  constraint report_runs_panel_carries_payload
    check (
      (report_type in ('AUDIENCE_PANEL', 'MUSIC_PANEL', 'PROMOTIONS_PANEL'))
        = (payload is not null)
    ),

  -- Panels render to PDF; listings render to a spreadsheet. Neither direction
  -- is meaningful reversed: a PDF of forty thousand participations is not a
  -- report, and a panel in CSV is three numbers in a grid.
  constraint report_runs_format_matches_type
    check (
      case
        when report_type in ('AUDIENCE_PANEL', 'MUSIC_PANEL', 'PROMOTIONS_PANEL')
          then format = 'PDF'
        else format in ('CSV', 'XLSX')
      end
    ),

  -- READY means there is a file. The three fields arrive together or the run
  -- is not READY, so no screen has to handle a ready run with nothing to show.
  constraint report_runs_ready_has_a_file
    check (
      status <> 'READY'
      or (storage_path is not null and row_count is not null and expires_at is not null)
    ),

  constraint report_runs_failed_says_why
    check (status <> 'FAILED' or last_error is not null)
);

-- The claim path (0127). Partial, because QUEUED rows are a vanishing fraction
-- of this table after a month of use and the tick reads it every ten seconds.
create index report_runs_claimable_idx
  on public.report_runs (requested_at)
  where status = 'QUEUED';

-- The stall sweep reads RUNNING rows by age.
create index report_runs_running_idx
  on public.report_runs (started_at)
  where status = 'RUNNING';

-- The /reports screen: one requester's runs, newest first.
create index report_runs_requester_idx
  on public.report_runs (requested_by, requested_at desc);

-- The expiry sweep (0128).
create index report_runs_expiring_idx
  on public.report_runs (expires_at)
  where storage_path is not null;

comment on table public.report_runs is
  'Every report ever asked for: the queue and the history in one table. §11 calls this saved_reports; it is not named that because what is saved is the record of a generation, not a re-runnable filter definition. A row outlives its file -- the file expires after seven days (0128) and the row does not, because "who exported which personal data, when" is the audit record this block contributes and it must not expire with the bytes.';

comment on column public.report_runs.payload is
  'The captured aggregate for a panel run, null for a listing. Design D2: the worker cannot call get_*_dashboard (SECURITY INVOKER, granted to authenticated only, and auth.uid() is null in a service_role client), so a panel''s numbers are computed at request time by the same call the screen makes, under the requester''s own rights, and the worker only renders them.';

comment on column public.report_runs.withheld is
  'Columns omitted from the file because the requester''s permissions did not carry them, named so the file can say so (design D7). Absent, never blank: an empty phone column is a false statement about people, where a missing one is only a missing one.';

comment on column public.report_runs.attempts is
  'Deliberately UNLIKE storage_erasure_queue (0087), which has no give-up threshold because a silently abandoned erasure is a legal obligation dropped. A report is the opposite: after three attempts the run is FAILED with the error on the operator''s own screen and they ask again, because a queue that retries for ever hides the defect behind a row that is always about to succeed.';

-- ---------------------------------------------------------------------------
-- RLS. A run is readable by the person who asked for it and by the
-- Organization's owner -- who is accountable for what leaves the installation
-- and is the one person who should be able to see that a report of forty
-- thousand listeners was exported on Tuesday.
--
-- NO write policy of any kind. Every transition is an RPC (0127) running as
-- service_role. A client that could update this table could set status=READY
-- and point storage_path at another Station's object, which the bucket policy
-- (0123) would then happily sign.
-- ---------------------------------------------------------------------------

alter table public.report_runs enable row level security;

revoke all on public.report_runs from anon, authenticated;
grant select on public.report_runs to authenticated;
grant select, insert, update, delete on public.report_runs to service_role;

create policy report_runs_read_own on public.report_runs
  for select to authenticated
  using (
    requested_by = auth.uid()
    or public.is_owner(organization_id)
    or public.is_platform_admin()
  );
```

- [ ] **Step 4: Run the test**

Run: `npm run db:test`
Expected: PASS — `22_reports` 12/12, everything else still green.

- [ ] **Step 5: Regenerate the database types**

Run: `npm run db:types`
Expected: `src/lib/supabase/database.types.ts` gains `report_runs` and the three enums. Commit it with the migration — a stale types file makes Task 10 fail typecheck for reasons that look like its own.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/0122_report_runs.sql supabase/tests/22_reports.test.sql src/lib/supabase/database.types.ts
git commit -m "feat(reports): report_runs, the queue and the history in one table"
```

---

## Task 4: The private bucket

**Files:**
- Create: `supabase/migrations/0123_reports_bucket.sql`
- Modify: `supabase/tests/22_reports.test.sql`

**Interfaces:**
- Consumes: `report_runs` (Task 3).
- Produces: a private `reports` bucket whose object paths are `{company_id}/{run_id}.{ext}`, readable through `storage.objects` only by a caller who may read the run.

- [ ] **Step 1: Add the failing assertions**

In `supabase/tests/22_reports.test.sql`, raise `plan(12)` to `plan(16)` and insert before `select * from finish();`:

```sql
-- The bucket. Private, in the shape 0086 established for delivery receipts:
-- a path is not a link, and reading is a signed URL minted at click time.
select is(
  (select count(*)::int from storage.buckets where id = 'reports'),
  1, 'the reports bucket exists');

select ok(
  not (select public from storage.buckets where id = 'reports'),
  'the reports bucket is private');

select ok(
  exists (select 1 from pg_policies
          where schemaname = 'storage' and tablename = 'objects'
            and policyname = 'reports_read_own_run'),
  'the read policy exists');

-- No insert policy for authenticated. Only the worker writes here, and a
-- client that could upload into this bucket could put a file where a signed
-- URL would later be minted for it.
select ok(
  not exists (select 1 from pg_policies
              where schemaname = 'storage' and tablename = 'objects'
                and cmd = 'INSERT' and 'authenticated' = any(roles)
                and qual::text like '%reports%'),
  'authenticated cannot write into the reports bucket');
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run db:test`
Expected: FAIL — the bucket does not exist.

- [ ] **Step 3: Write the migration**

Create `supabase/migrations/0123_reports_bucket.sql`:

```sql
-- supabase/migrations/0123_reports_bucket.sql

-- Block 8b, Task 3: where a generated file lives.
--
-- 0086's shape, for 0086's reasons. The bucket is private, so a path is not a
-- link; the client asks for a short-lived signed URL at the moment of the
-- click and it is never stored anywhere.
--
-- THE PATH IS {company_id}/{run_id}.{ext} AND THE FIRST SEGMENT IS LOad-BEARING:
-- the read policy proves the Station from the path, the same way 0086's
-- receipt policies do, so an object cannot be read through a run row that
-- happens to be readable while the object belongs to a different Station.
--
-- A consolidated run writes under its FIRST Station id. That is a filing
-- decision, not a permission one -- the permission is carried by the run row,
-- which names every Station, and 0127 refuses a consolidated request without
-- reports.consolidated in every one of them.

insert into storage.buckets (id, name, public)
values ('reports', 'reports', false)
on conflict (id) do nothing;

-- Reading. A caller may read an object if they may read the run that produced
-- it -- which is report_runs' own RLS, reached through a subquery rather than
-- restated here, so the two cannot disagree.
create policy reports_read_own_run on storage.objects
  for select to authenticated
  using (
    bucket_id = 'reports'
    and exists (
      select 1 from public.report_runs r
      where r.storage_path = storage.objects.name
    )
  );

comment on policy reports_read_own_run on storage.objects is
  'Block 8b. A report object is readable exactly when its run row is -- the EXISTS reaches report_runs, whose own RLS (0122) already answers "may this caller see this run", so the rule lives in one place. A run whose storage_path has been cleared by expiry (0128) matches nothing here, which is what makes an expired file unreadable even to somebody holding a stale signed URL''s path.';

-- No INSERT, UPDATE or DELETE policy for authenticated, deliberately. Writing
-- is the worker's, through service_role, which bypasses RLS; deletion is the
-- storage erasure queue's (0087), through the same client. A client that could
-- write here could place a file at a path a signed URL would later be minted
-- for.
```

- [ ] **Step 4: Run the test**

Run: `npm run db:test`
Expected: PASS — `22_reports` 16/16.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/0123_reports_bucket.sql supabase/tests/22_reports.test.sql
git commit -m "feat(reports): the private reports bucket, read through its run row"
```

---

## Task 5: The first two page functions — listeners and participations

**The uniform contract every page function honours:**

```sql
public.report_page_<kind>(
  p_user_id     uuid,
  p_company_ids uuid[],
  p_filters     jsonb,
  p_cursor_at   timestamptz,
  p_cursor_id   uuid,
  p_limit       integer
) returns table (
  sort_at     timestamptz,
  sort_id     uuid,
  row_data    jsonb,
  total_count bigint,
  withheld    text[]
)
```

`total_count` and `withheld` ride back with the rows from the same CTE, which is what stops the row ceiling and the withheld set from being computed a second time somewhere else. `p_user_id` rather than a run id is what lets one function serve the request path (`auth.uid()`, before a run exists) and the worker (`run.requested_by`).

**Files:**
- Create: `supabase/migrations/0124_report_pages_a.sql`
- Modify: `supabase/tests/22_reports.test.sql`

**Interfaces:**
- Consumes: `has_permission_for` (Task 2).
- Produces: `report_page_listeners`, `report_page_participations` with the signature above.

- [ ] **Step 1: Add the failing assertions**

In `supabase/tests/22_reports.test.sql`, raise `plan(16)` to `plan(26)` and insert before `select * from finish();`:

```sql
-- The page functions. The suite runs as superuser with a null auth.uid(),
-- which is exactly why these functions take the user id as an argument: this
-- is the only place in the repository where a permission decision can be
-- tested without a JWT. tests/isolation/reports.test.ts proves the same rules
-- with real users; neither file replaces the other.

select has_function('public', 'report_page_listeners',
  array['uuid', 'uuid[]', 'jsonb', 'timestamptz', 'uuid', 'integer'],
  'report_page_listeners exists');
select has_function('public', 'report_page_participations',
  array['uuid', 'uuid[]', 'jsonb', 'timestamptz', 'uuid', 'integer'],
  'report_page_participations exists');

-- A null user id is refused, not treated as unrestricted. This is the worker's
-- own failure mode: a run row whose requested_by somehow did not load must
-- produce an error, never a file containing everything.
select throws_ok(
  $$select * from public.report_page_listeners(
      null, array[(select id from public.companies limit 1)], '{}'::jsonb, null, null, 10)$$,
  '42501', null, 'listeners refuses a null user id');

select throws_ok(
  $$select * from public.report_page_participations(
      null, array[(select id from public.companies limit 1)], '{}'::jsonb, null, null, 10)$$,
  '42501', null, 'participations refuses a null user id');

-- An empty Station list is a caller error, not an empty report.
select throws_ok(
  $$select * from public.report_page_listeners(
      (select user_id from public.platform_admins limit 1),
      array[]::uuid[], '{}'::jsonb, null, null, 10)$$,
  '22023', null, 'listeners refuses an empty Station list');

-- The admin can read, and total_count agrees with the rows.
select ok(
  (select count(*) from public.report_page_listeners(
     (select user_id from public.platform_admins limit 1),
     array[(select id from public.companies where status = 'active' limit 1)],
     '{}'::jsonb, null, null, 1000)) >= 0,
  'listeners returns a page for an entitled caller');

select is(
  (select distinct total_count from public.report_page_listeners(
     (select user_id from public.platform_admins limit 1),
     array[(select id from public.companies where status = 'active' limit 1)],
     '{}'::jsonb, null, null, 1000)),
  (select count(*) from public.member_company_links mcl
     join public.members m on m.id = mcl.member_id
    where mcl.company_id = (select id from public.companies where status = 'active' limit 1)
      and m.deleted_at is null),
  'total_count counts the same rows the page draws from');

-- withheld is empty for a caller who holds everything, and the listeners
-- report has no withheld set at all by construction: members.view gates the
-- whole listing, so it is all-or-nothing (design §4.1).
select is(
  (select distinct withheld from public.report_page_listeners(
     (select user_id from public.platform_admins limit 1),
     array[(select id from public.companies where status = 'active' limit 1)],
     '{}'::jsonb, null, null, 10)),
  '{}'::text[],
  'an entitled caller has nothing withheld');

-- row_data carries no CPF beyond the three digits that exist. A report that
-- shipped a cpf key at all would be a promise the database cannot keep.
select ok(
  not exists (
    select 1 from public.report_page_listeners(
      (select user_id from public.platform_admins limit 1),
      array[(select id from public.companies where status = 'active' limit 1)],
      '{}'::jsonb, null, null, 100) p
    where p.row_data ? 'cpf' or p.row_data ? 'cpf_hash'),
  'no listeners row carries a full CPF or its hash');

-- The keyset walks strictly backwards in (sort_at, sort_id) and never repeats
-- a row across pages. A cursor whose comparison is not the tuple comparison
-- strands rows silently -- pages still load and the total still looks right.
select ok(
  not exists (
    select 1
    from public.report_page_listeners(
      (select user_id from public.platform_admins limit 1),
      array[(select id from public.companies where status = 'active' limit 1)],
      '{}'::jsonb, null, null, 2) first_page
    join lateral (
      select * from public.report_page_listeners(
        (select user_id from public.platform_admins limit 1),
        array[(select id from public.companies where status = 'active' limit 1)],
        '{}'::jsonb, first_page.sort_at, first_page.sort_id, 2)) second_page
      on second_page.sort_id = first_page.sort_id),
  'a second page never repeats a row from the first');
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run db:test`
Expected: FAIL — `report_page_listeners` does not exist.

- [ ] **Step 3: Write the migration**

Create `supabase/migrations/0124_report_pages_a.sql`:

```sql
-- supabase/migrations/0124_report_pages_a.sql

-- Block 8b, Task 4: the first two page functions.
--
-- ONE SIGNATURE FOR ALL FIVE, and the two departures from the list RPCs they
-- mirror are both deliberate:
--
--   1. p_user_id is an ARGUMENT. The list RPCs ask has_permission about
--      auth.uid(); these ask has_permission_for about a named user, because
--      the worker generating the file is never the person entitled to it
--      (0121's header argues this in full). The same function therefore
--      serves the request path -- which passes auth.uid() before any run row
--      exists, to preflight the row ceiling -- and the worker, which passes
--      report_runs.requested_by.
--
--   2. total_count AND withheld come back WITH the rows. 0090 already
--      established the first half ("total_count is computed from the same CTE
--      the rows come from, so a page and its count cannot narrow
--      differently"); this block needs the same guarantee for the withheld
--      set, because a file whose columns disagree with the list of columns it
--      says were withheld is worse than either error alone.
--
-- p_company_ids is an ARRAY because a consolidated report is one file. The
-- permission loop below refuses the WHOLE call if any named Station is
-- unreadable -- it does not quietly drop that Station and return the rest,
-- which would be a report that is wrong in a way nothing on its face reveals.
-- reports.consolidated is checked in request_report (0127), not here: this
-- function is also the preflight for a single-Station request, and duplicating
-- that check would refuse the preflight for a reason the operator has not hit
-- yet.

-- ---------------------------------------------------------------------------
-- Shared guard. Every page function opens with this, and it is a function
-- rather than five copies for the reason this whole block exists.
-- ---------------------------------------------------------------------------

create function public.report_guard(
  p_user_id     uuid,
  p_company_ids uuid[],
  p_permission  text
)
returns void
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  v_company uuid;
begin
  if p_user_id is null then
    raise exception 'a report needs an identity' using errcode = '42501';
  end if;

  if p_company_ids is null or cardinality(p_company_ids) = 0 then
    raise exception 'at least one station is required' using errcode = '22023';
  end if;

  foreach v_company in array p_company_ids loop
    if not public.has_permission_for(p_user_id, p_permission, v_company) then
      raise log 'report denied: user=% company=% permission=%',
        p_user_id, v_company, p_permission;
      raise exception 'permission denied for this station' using errcode = '42501';
    end if;
  end loop;
end;
$$;

comment on function public.report_guard(uuid, uuid[], text) is
  'Block 8b. The opening of every page function: an identity, a non-empty Station list, and the named permission in EVERY Station or a 42501 for the whole call. Refusing the whole call rather than dropping the unreadable Station is the point -- a consolidated file silently missing one radio is wrong in a way nothing on its face reveals.';

revoke execute on function public.report_guard(uuid, uuid[], text) from public;
grant execute on function public.report_guard(uuid, uuid[], text) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 1. Listeners.
--
-- The unit is the LINK, not the member: 8a's D9 settled that a new listener at
-- a Station is a new member_company_links row, because an Organization-scoped
-- member reaching a second radio is new to that radio and not to the group.
-- Sorting and filtering both use linked_at, so the report and the Audience
-- panel cannot disagree about who arrived in a period.
--
-- NO WITHHELD SET, and that is a property of this report rather than an
-- omission: members.view gates the entire listing, so a caller either gets
-- every column or gets a 42501. §4.1 of the design says so, and
-- lib/reports/provenance.ts prints it, because a file that stays silent about
-- it is indistinguishable from one that quietly dropped a column.
--
-- THERE IS NO CPF COLUMN. 0031 stores a SHA-256 and three digits and says the
-- raw number "is stored nowhere and appears in no query log". No export can
-- undo that and none should; cpf_last_digits is what a person confirms out
-- loud, and it is what ships.
-- ---------------------------------------------------------------------------

create function public.report_page_listeners(
  p_user_id     uuid,
  p_company_ids uuid[],
  p_filters     jsonb,
  p_cursor_at   timestamptz,
  p_cursor_id   uuid,
  p_limit       integer
)
returns table (
  sort_at     timestamptz,
  sort_id     uuid,
  row_data    jsonb,
  total_count bigint,
  withheld    text[]
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  v_from      timestamptz := nullif(p_filters ->> 'from', '')::timestamptz;
  v_to        timestamptz := nullif(p_filters ->> 'to', '')::timestamptz;
  v_situation text        := nullif(p_filters ->> 'situation', '');
  v_age_min   integer     := nullif(p_filters ->> 'age_min', '')::integer;
  v_age_max   integer     := nullif(p_filters ->> 'age_max', '')::integer;
  v_consent   boolean     := nullif(p_filters ->> 'consent', '')::boolean;
  v_now       timestamptz := now();
begin
  perform public.report_guard(p_user_id, p_company_ids, 'members.view');

  return query
  with matched as (
    select
      mcl.linked_at as k_at,
      m.id          as k_id,
      m.full_name, m.phone, m.email, m.cpf_last_digits, m.birth_date,
      m.city, m.state, m.discovery_source,
      c.name as company_name,
      m.deleted_at,
      -- The active-block window is 0032's and 0036's, restated because this
      -- function is SECURITY DEFINER and RLS is not applying: lifted_at null,
      -- started, not yet ended. A block with a null company_id is
      -- Organization-wide and applies to every Station -- 8a's §3.1 counts it
      -- once per Station for the same reason.
      exists (
        select 1 from public.member_blocks b
        where b.member_id = m.id
          and (b.company_id is null or b.company_id = mcl.company_id)
          and b.lifted_at is null
          and b.starts_at <= v_now
          and (b.ends_at is null or b.ends_at > v_now)
      ) as is_blocked,
      exists (
        select 1 from public.member_consents mc
        where mc.member_id = m.id
          and mc.company_id = mcl.company_id
          and mc.granted
      ) as has_consent
    from public.member_company_links mcl
    join public.members m on m.id = mcl.member_id
    join public.companies c on c.id = mcl.company_id
    where mcl.company_id = any(p_company_ids)
      and (v_from is null or mcl.linked_at >= v_from)
      and (v_to   is null or mcl.linked_at <  v_to)
      -- An age band is a birth_date range, never an age computed per row:
      -- computing it in the predicate defeats members_birth_date_idx (0036)
      -- and scans the Organization. `>`, not `>=`, on the lower bound of the
      -- date range: somebody born exactly age_max + 1 years ago today has had
      -- that birthday and is outside the band. services/members.ts carries the
      -- identical comment, and the two must agree or the screen and its export
      -- disagree about who is 30.
      and (v_age_max is null or m.birth_date > (current_date - make_interval(years => v_age_max + 1)))
      and (v_age_min is null or m.birth_date <= (current_date - make_interval(years => v_age_min)))
  ),
  situated as (
    select *,
      case
        when deleted_at is not null then 'archived'
        when is_blocked then 'blocked'
        else 'active'
      end as situation
    from matched
  ),
  filtered as (
    select * from situated
    where (v_situation is null or situation = v_situation)
      and (v_consent is null or has_consent = v_consent)
      -- Archived listeners are excluded unless explicitly asked for. An export
      -- that silently included erased people would defeat Block 3's whole
      -- stance; one that could never show them would make the archive
      -- unauditable.
      and (v_situation = 'archived' or deleted_at is null)
  ),
  counted as (
    select count(*) as n from filtered
  )
  select
    f.k_at,
    f.k_id,
    jsonb_build_object(
      'station',    f.company_name,
      'name',       f.full_name,
      'phone',      f.phone,
      'email',      f.email,
      'cpf_last_digits', f.cpf_last_digits,
      'birth_date', f.birth_date,
      'city',       f.city,
      'state',      f.state,
      'discovery_source', f.discovery_source,
      'situation',  f.situation,
      'consent',    f.has_consent,
      'linked_at',  f.k_at
    ),
    counted.n,
    '{}'::text[]
  from filtered f, counted
  where p_cursor_at is null
     or (f.k_at, f.k_id) < (p_cursor_at, p_cursor_id)
  order by f.k_at desc, f.k_id desc
  limit p_limit;
end;
$$;

comment on function public.report_page_listeners(uuid, uuid[], jsonb, timestamptz, uuid, integer) is
  'One keyset page of the listeners export, newest link first. The unit is the member_company_links row, not the member, because 8a''s D9 settled that a new listener at a Station is a new link -- so this export and the Audience panel cannot disagree about who arrived in a period. members.view gates the whole listing, so there is no withheld set: a caller gets every column or a 42501. No CPF column exists beyond cpf_last_digits, because 0031 stores only a SHA-256 and three digits.';

-- ---------------------------------------------------------------------------
-- 2. Participations.
--
-- TWO PERMISSION CODES, and the second is the one a rewrite loses. 0090's
-- header records it: 0053's policy read `has_permission('participations.view',
-- company_id) and promotion_id in (select id from public.promotions)`, and
-- public.promotions is itself behind RLS, so that second term silently
-- required promotions.view as well. A SECURITY DEFINER function gating on
-- participations.view alone is MORE PERMISSIVE than the query it replaces.
--
-- The listener's identity is the withheld set here, exactly as in 0090: a
-- caller with participations.view but not members.view gets every row and no
-- name, phone or document -- and the columns are ABSENT from row_data rather
-- than null, so the file cannot print an empty phone column that reads as
-- "these listeners have no phone".
-- ---------------------------------------------------------------------------

create function public.report_page_participations(
  p_user_id     uuid,
  p_company_ids uuid[],
  p_filters     jsonb,
  p_cursor_at   timestamptz,
  p_cursor_id   uuid,
  p_limit       integer
)
returns table (
  sort_at     timestamptz,
  sort_id     uuid,
  row_data    jsonb,
  total_count bigint,
  withheld    text[]
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  v_from         timestamptz := nullif(p_filters ->> 'from', '')::timestamptz;
  v_to           timestamptz := nullif(p_filters ->> 'to', '')::timestamptz;
  v_promotion    uuid        := nullif(p_filters ->> 'promotion_id', '')::uuid;
  v_status       text        := nullif(p_filters ->> 'status', '');
  v_source       text        := nullif(p_filters ->> 'source', '');
  v_names        boolean;
  v_withheld     text[] := '{}';
  v_company      uuid;
begin
  perform public.report_guard(p_user_id, p_company_ids, 'participations.view');

  -- The second code, per 0090. Checked in every Station, like the first.
  foreach v_company in array p_company_ids loop
    if not public.has_permission_for(p_user_id, 'promotions.view', v_company) then
      raise exception 'permission denied for this station' using errcode = '42501';
    end if;
  end loop;

  -- The identity columns ride on a third code the caller may not hold. One
  -- evaluation, used for both the row shape and the withheld list, so the two
  -- cannot disagree.
  v_names := true;
  foreach v_company in array p_company_ids loop
    if not public.has_permission_for(p_user_id, 'members.view', v_company) then
      v_names := false;
    end if;
  end loop;

  if not v_names then
    v_withheld := array['name', 'phone', 'cpf_last_digits'];
  end if;

  return query
  with matched as (
    select
      p.participated_at as k_at,
      p.id              as k_id,
      pr.name  as promotion_name,
      c.name   as company_name,
      p.status, p.source,
      m.full_name, m.phone, m.cpf_last_digits
    from public.participations p
    join public.promotions pr on pr.id = p.promotion_id
    join public.companies  c  on c.id  = p.company_id
    left join public.members m on m.id = p.member_id
    where p.company_id = any(p_company_ids)
      -- 0044's rule, which 0053 used to inherit through a sub-select: an
      -- archived promotion's entries reach the platform admin and the
      -- Organization's owner and nobody else.
      and (
        pr.archived_at is null
        or public.is_platform_admin_for(p_user_id)
        or public.is_owner_for(p_user_id, pr.organization_id)
      )
      and (v_from      is null or p.participated_at >= v_from)
      and (v_to        is null or p.participated_at <  v_to)
      and (v_promotion is null or p.promotion_id = v_promotion)
      and (v_status    is null or p.status::text = v_status)
      and (v_source    is null or p.source::text = v_source)
  ),
  counted as (select count(*) as n from matched)
  select
    mt.k_at,
    mt.k_id,
    jsonb_build_object(
      'station',   mt.company_name,
      'promotion', mt.promotion_name,
      'status',    mt.status,
      'source',    mt.source,
      'participated_at', mt.k_at
    )
    -- Absent, not null. `||` on a jsonb object adds the keys only when the
    -- caller may have them; the withheld array above names exactly the keys
    -- this branch withholds, and 22_reports asserts the two agree.
    || case when v_names then jsonb_build_object(
         'name',  mt.full_name,
         'phone', mt.phone,
         'cpf_last_digits', mt.cpf_last_digits)
       else '{}'::jsonb end,
    counted.n,
    v_withheld
  from matched mt, counted
  where p_cursor_at is null
     or (mt.k_at, mt.k_id) < (p_cursor_at, p_cursor_id)
  order by mt.k_at desc, mt.k_id desc
  limit p_limit;
end;
$$;

comment on function public.report_page_participations(uuid, uuid[], jsonb, timestamptz, uuid, integer) is
  'One keyset page of the participations export. THREE permission codes: participations.view and promotions.view are both required (0090''s header explains why the second is the one a rewrite loses -- RLS on public.promotions silently supplied it), and members.view decides whether the listener''s name, phone and document are present at all. Withheld columns are ABSENT from row_data and named in the withheld array, never null, because an empty phone column in a spreadsheet is a false statement about people.';

revoke execute on function public.report_page_listeners(uuid, uuid[], jsonb, timestamptz, uuid, integer) from public;
revoke execute on function public.report_page_participations(uuid, uuid[], jsonb, timestamptz, uuid, integer) from public;
grant execute on function public.report_page_listeners(uuid, uuid[], jsonb, timestamptz, uuid, integer) to authenticated, service_role;
grant execute on function public.report_page_participations(uuid, uuid[], jsonb, timestamptz, uuid, integer) to authenticated, service_role;
```

- [ ] **Step 4: Run the test**

Run: `npm run db:test`
Expected: PASS — `22_reports` 26/26.

- [ ] **Step 5: Check the index the listeners query wants**

8a's `0116` shipped `member_links_company_linked_idx (company_id, linked_at)` and then **removed it**, because `EXPLAIN` showed the planner never chose it: the Audience CTE selected `member_id`, so no index-only scan was possible and the date bound never reached the planner as a pushable range. This query has a different shape — it filters *and* sorts on `linked_at` within `company_id`.

Run against the local stack:

```bash
npx supabase db reset
psql "$(npx supabase status -o json | node -pe 'JSON.parse(require("fs").readFileSync(0)).DB_URL')" -c "explain (analyze, buffers) select * from public.report_page_listeners((select user_id from public.platform_admins limit 1), array[(select id from public.companies where status='active' limit 1)], '{}'::jsonb, null, null, 1000);"
```

If the plan shows a sequential scan over `member_company_links`, add to `0124`:

```sql
create index member_links_company_linked_idx
  on public.member_company_links (company_id, linked_at desc);
```

and re-run to confirm it is chosen. **If it is still not chosen, do not add it** — 8a already paid for one index nobody uses, and its removal is asserted in `20_dashboards.test.sql`. Record whichever way it went in the commit message.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/0124_report_pages_a.sql supabase/tests/22_reports.test.sql
git commit -m "feat(reports): the listeners and participations page functions"
```

---

## Task 6: The remaining three page functions

**Files:**
- Create: `supabase/migrations/0125_report_pages_b.sql`
- Modify: `supabase/tests/22_reports.test.sql`

**Interfaces:**
- Consumes: `report_guard`, `has_permission_for`.
- Produces: `report_page_winners`, `report_page_music_requests`, `report_page_movements`, all with the Task 5 signature.

- [ ] **Step 1: Add the failing assertions**

Raise `plan(26)` to `plan(33)` and insert before `select * from finish();`:

```sql
select has_function('public', 'report_page_winners',
  array['uuid', 'uuid[]', 'jsonb', 'timestamptz', 'uuid', 'integer'],
  'report_page_winners exists');
select has_function('public', 'report_page_music_requests',
  array['uuid', 'uuid[]', 'jsonb', 'timestamptz', 'uuid', 'integer'],
  'report_page_music_requests exists');
select has_function('public', 'report_page_movements',
  array['uuid', 'uuid[]', 'jsonb', 'timestamptz', 'uuid', 'integer'],
  'report_page_movements exists');

select throws_ok(
  $$select * from public.report_page_winners(
      null, array[(select id from public.companies limit 1)], '{}'::jsonb, null, null, 10)$$,
  '42501', null, 'winners refuses a null user id');
select throws_ok(
  $$select * from public.report_page_music_requests(
      null, array[(select id from public.companies limit 1)], '{}'::jsonb, null, null, 10)$$,
  '42501', null, 'music requests refuses a null user id');
select throws_ok(
  $$select * from public.report_page_movements(
      null, array[(select id from public.companies limit 1)], '{}'::jsonb, null, null, 10)$$,
  '42501', null, 'movements refuses a null user id');

-- A cancelled draw awards nothing (0097). Its winners must not appear in the
-- winners export in any guise -- 8a's D12 states the same rule for the panels,
-- and a file that disagreed with the panel about who won would be believed
-- over the panel, because it is a document.
select ok(
  not exists (
    select 1 from public.report_page_winners(
      (select user_id from public.platform_admins limit 1),
      array[(select id from public.companies where status = 'active' limit 1)],
      '{}'::jsonb, null, null, 1000) p
    join public.winners w on w.id = (p.row_data ->> 'winner_id')::uuid
    join public.draws d on d.id = w.draw_id
    where d.status = 'cancelled'),
  'a cancelled draw''s winners reach no export');
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run db:test`
Expected: FAIL — the three functions do not exist.

- [ ] **Step 3: Write the migration**

Create `supabase/migrations/0125_report_pages_b.sql`:

```sql
-- supabase/migrations/0125_report_pages_b.sql

-- Block 8b, Task 5: the remaining three page functions.
--
-- Same contract as 0124, same reasons. Each one mirrors the list RPC of its
-- screen and carries EVERY permission term that RPC carries -- which for all
-- three means a domain code that gates the listing and members.view that
-- gates the listener's identity inside it.

-- ---------------------------------------------------------------------------
-- 1. Winners and deliveries. Mirrors list_pickups (0095): promotions.view
-- gates it, members.view carries the identity.
--
-- The deadline is the column this report exists for. `met_deadline` is
-- computed here rather than in Node because a deadline is a Station-local
-- instant and Node runs UTC -- 0117's header argues this at length for the
-- dashboards and the argument does not weaken for a file.
-- ---------------------------------------------------------------------------

create function public.report_page_winners(
  p_user_id     uuid,
  p_company_ids uuid[],
  p_filters     jsonb,
  p_cursor_at   timestamptz,
  p_cursor_id   uuid,
  p_limit       integer
)
returns table (
  sort_at     timestamptz,
  sort_id     uuid,
  row_data    jsonb,
  total_count bigint,
  withheld    text[]
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  v_from      timestamptz := nullif(p_filters ->> 'from', '')::timestamptz;
  v_to        timestamptz := nullif(p_filters ->> 'to', '')::timestamptz;
  v_promotion uuid        := nullif(p_filters ->> 'promotion_id', '')::uuid;
  v_status    text        := nullif(p_filters ->> 'status', '');
  v_names     boolean := true;
  v_withheld  text[]  := '{}';
  v_company   uuid;
begin
  perform public.report_guard(p_user_id, p_company_ids, 'promotions.view');

  foreach v_company in array p_company_ids loop
    if not public.has_permission_for(p_user_id, 'members.view', v_company) then
      v_names := false;
    end if;
  end loop;
  if not v_names then
    v_withheld := array['name', 'phone'];
  end if;

  return query
  with matched as (
    select
      w.created_at as k_at,
      w.id         as k_id,
      c.name  as company_name,
      pr.name as promotion_name,
      pz.name as prize_name,
      w.awarded_rank, w.status, w.deadline_at,
      m.full_name, m.phone
    from public.winners w
    join public.draws d on d.id = w.draw_id
    join public.companies c on c.id = w.company_id
    join public.promotion_prizes pp on pp.id = w.promotion_prize_id
    join public.promotions pr on pr.id = pp.promotion_id
    join public.prizes pz on pz.id = pp.prize_id
    left join public.members m on m.id = w.member_id
    where w.company_id = any(p_company_ids)
      -- 0097: a cancelled draw awards nothing, so its winners are not winners.
      and d.status <> 'cancelled'
      and (
        pr.archived_at is null
        or public.is_platform_admin_for(p_user_id)
        or public.is_owner_for(p_user_id, pr.organization_id)
      )
      and (v_from      is null or w.created_at >= v_from)
      and (v_to        is null or w.created_at <  v_to)
      and (v_promotion is null or pr.id = v_promotion)
      and (v_status    is null or w.status::text = v_status)
  ),
  counted as (select count(*) as n from matched)
  select
    mt.k_at,
    mt.k_id,
    jsonb_build_object(
      'winner_id',   mt.k_id,
      'station',     mt.company_name,
      'promotion',   mt.promotion_name,
      'prize',       mt.prize_name,
      'rank',        mt.awarded_rank,
      'status',      mt.status,
      'deadline_at', mt.deadline_at,
      'drawn_at',    mt.k_at,
      -- Null when there is no deadline, which is not the same as "missed".
      'met_deadline', case
        when mt.deadline_at is null then null
        when mt.status = 'delivered' then true
        when now() > mt.deadline_at then false
        else null
      end
    )
    || case when v_names then jsonb_build_object('name', mt.full_name, 'phone', mt.phone)
       else '{}'::jsonb end,
    counted.n,
    v_withheld
  from matched mt, counted
  where p_cursor_at is null
     or (mt.k_at, mt.k_id) < (p_cursor_at, p_cursor_id)
  order by mt.k_at desc, mt.k_id desc
  limit p_limit;
end;
$$;

comment on function public.report_page_winners(uuid, uuid[], jsonb, timestamptz, uuid, integer) is
  'One keyset page of the winners-and-deliveries export, mirroring list_pickups (0095). promotions.view gates the listing; members.view carries the listener identity, withheld by absence otherwise. A cancelled draw''s winners appear nowhere (0097), the same rule 8a''s D12 applies to the panels -- and it matters more here, because a file is believed over a screen.';

-- ---------------------------------------------------------------------------
-- 2. Music requests. Mirrors list_music_requests (0107): music.view gates it,
-- members.view carries the identity. An archived song's title is RETURNED with
-- song_archived true rather than hidden, because archive_song is deliberately
-- never refused over a live request naming it, so such rows exist and would
-- otherwise be illegible.
-- ---------------------------------------------------------------------------

create function public.report_page_music_requests(
  p_user_id     uuid,
  p_company_ids uuid[],
  p_filters     jsonb,
  p_cursor_at   timestamptz,
  p_cursor_id   uuid,
  p_limit       integer
)
returns table (
  sort_at     timestamptz,
  sort_id     uuid,
  row_data    jsonb,
  total_count bigint,
  withheld    text[]
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  v_from     timestamptz := nullif(p_filters ->> 'from', '')::timestamptz;
  v_to       timestamptz := nullif(p_filters ->> 'to', '')::timestamptz;
  v_song     uuid        := nullif(p_filters ->> 'song_id', '')::uuid;
  v_show     uuid        := nullif(p_filters ->> 'show_id', '')::uuid;
  v_channel  text        := nullif(p_filters ->> 'channel', '');
  v_names    boolean := true;
  v_withheld text[]  := '{}';
  v_company  uuid;
begin
  perform public.report_guard(p_user_id, p_company_ids, 'music.view');

  foreach v_company in array p_company_ids loop
    if not public.has_permission_for(p_user_id, 'members.view', v_company) then
      v_names := false;
    end if;
  end loop;
  if not v_names then
    v_withheld := array['name', 'phone'];
  end if;

  return query
  with matched as (
    select
      r.requested_at as k_at,
      r.id           as k_id,
      c.name  as company_name,
      s.title as song_title,
      (s.deleted_at is not null) as song_archived,
      a.name  as artist_name,
      sh.name as show_name,
      r.channel,
      m.full_name, m.phone
    from public.music_requests r
    join public.companies c on c.id = r.company_id
    left join public.songs s on s.id = r.song_id
    left join public.artists a on a.id = s.artist_id
    left join public.shows sh on sh.id = r.show_id
    left join public.members m on m.id = r.member_id
    where r.company_id = any(p_company_ids)
      and r.deleted_at is null
      and (v_from    is null or r.requested_at >= v_from)
      and (v_to      is null or r.requested_at <  v_to)
      and (v_song    is null or r.song_id = v_song)
      and (v_show    is null or r.show_id = v_show)
      and (v_channel is null or r.channel::text = v_channel)
  ),
  counted as (select count(*) as n from matched)
  select
    mt.k_at,
    mt.k_id,
    jsonb_build_object(
      'station',       mt.company_name,
      'song',          mt.song_title,
      'song_archived', mt.song_archived,
      'artist',        mt.artist_name,
      'show',          mt.show_name,
      'channel',       mt.channel,
      'requested_at',  mt.k_at
    )
    || case when v_names then jsonb_build_object('name', mt.full_name, 'phone', mt.phone)
       else '{}'::jsonb end,
    counted.n,
    v_withheld
  from matched mt, counted
  where p_cursor_at is null
     or (mt.k_at, mt.k_id) < (p_cursor_at, p_cursor_id)
  order by mt.k_at desc, mt.k_id desc
  limit p_limit;
end;
$$;

comment on function public.report_page_music_requests(uuid, uuid[], jsonb, timestamptz, uuid, integer) is
  'One keyset page of the music-requests export, mirroring list_music_requests (0107). music.view gates it; members.view carries the requester identity. An archived song ships with song_archived true rather than being hidden, for 0107''s reason: archive_song is never refused over a live request naming it, so such rows exist and would otherwise be illegible.';

-- ---------------------------------------------------------------------------
-- 3. Inventory movements. Mirrors list_movements (0096): inventory.view, and
-- no listener identity anywhere in it -- a movement is about a prize and an
-- operator, so there is no withheld set.
-- ---------------------------------------------------------------------------

create function public.report_page_movements(
  p_user_id     uuid,
  p_company_ids uuid[],
  p_filters     jsonb,
  p_cursor_at   timestamptz,
  p_cursor_id   uuid,
  p_limit       integer
)
returns table (
  sort_at     timestamptz,
  sort_id     uuid,
  row_data    jsonb,
  total_count bigint,
  withheld    text[]
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  v_from  timestamptz := nullif(p_filters ->> 'from', '')::timestamptz;
  v_to    timestamptz := nullif(p_filters ->> 'to', '')::timestamptz;
  v_prize uuid        := nullif(p_filters ->> 'prize_id', '')::uuid;
  v_type  text        := nullif(p_filters ->> 'movement_type', '');
begin
  perform public.report_guard(p_user_id, p_company_ids, 'inventory.view');

  return query
  with matched as (
    select
      im.created_at as k_at,
      im.id         as k_id,
      c.name  as company_name,
      pz.name as prize_name,
      im.movement_type, im.quantity, im.from_bucket, im.to_bucket, im.note,
      u.email as actor_email
    from public.inventory_movements im
    join public.companies c on c.id = im.company_id
    join public.prizes pz on pz.id = im.prize_id
    left join auth.users u on u.id = im.actor_id
    where im.company_id = any(p_company_ids)
      and (v_from  is null or im.created_at >= v_from)
      and (v_to    is null or im.created_at <  v_to)
      and (v_prize is null or im.prize_id = v_prize)
      and (v_type  is null or im.movement_type::text = v_type)
  ),
  counted as (select count(*) as n from matched)
  select
    mt.k_at,
    mt.k_id,
    jsonb_build_object(
      'station',       mt.company_name,
      'moved_at',      mt.k_at,
      'prize',         mt.prize_name,
      'movement_type', mt.movement_type,
      'quantity',      mt.quantity,
      'from_bucket',   mt.from_bucket,
      'to_bucket',     mt.to_bucket,
      'actor',         mt.actor_email,
      'note',          mt.note
    ),
    counted.n,
    '{}'::text[]
  from matched mt, counted
  where p_cursor_at is null
     or (mt.k_at, mt.k_id) < (p_cursor_at, p_cursor_id)
  order by mt.k_at desc, mt.k_id desc
  limit p_limit;
end;
$$;

comment on function public.report_page_movements(uuid, uuid[], jsonb, timestamptz, uuid, integer) is
  'One keyset page of the inventory-movements export, mirroring list_movements (0096). inventory.view gates it and there is no withheld set: a movement is about a prize and an operator, and carries no listener identity at all.';

revoke execute on function public.report_page_winners(uuid, uuid[], jsonb, timestamptz, uuid, integer) from public;
revoke execute on function public.report_page_music_requests(uuid, uuid[], jsonb, timestamptz, uuid, integer) from public;
revoke execute on function public.report_page_movements(uuid, uuid[], jsonb, timestamptz, uuid, integer) from public;
grant execute on function public.report_page_winners(uuid, uuid[], jsonb, timestamptz, uuid, integer) to authenticated, service_role;
grant execute on function public.report_page_music_requests(uuid, uuid[], jsonb, timestamptz, uuid, integer) to authenticated, service_role;
grant execute on function public.report_page_movements(uuid, uuid[], jsonb, timestamptz, uuid, integer) to authenticated, service_role;
```

- [ ] **Step 4: Run the test**

Run: `npm run db:test`
Expected: PASS — `22_reports` 33/33.

**If the winners query fails to compile,** check the join chain against `0075_draw_tables.sql` and `0081_delivery_tables.sql` before changing it: `winners.promotion_prize_id` is the chain M4 requires, and reaching the prize through `promotion_prizes` rather than directly is what makes a delivery decrement the correct promotion.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/0125_report_pages_b.sql supabase/tests/22_reports.test.sql
git commit -m "feat(reports): the winners, music-request and movement page functions"
```

---

## Task 7: The dispatcher

**Files:**
- Create: `supabase/migrations/0126_report_page.sql`
- Modify: `supabase/tests/22_reports.test.sql`

**Interfaces:**
- Consumes: the five page functions.
- Produces: `public.report_page(p_user_id uuid, p_report_type public.report_type, p_company_ids uuid[], p_filters jsonb, p_cursor_at timestamptz, p_cursor_id uuid, p_limit integer)` returning the same five columns. The worker and `request_report` both call only this.

- [ ] **Step 1: Add the failing assertions**

Raise `plan(33)` to `plan(36)`, insert before `finish()`:

```sql
select has_function('public', 'report_page',
  array['uuid', 'report_type', 'uuid[]', 'jsonb', 'timestamptz', 'uuid', 'integer'],
  'the dispatcher exists');

-- A panel type has no page function, and asking for one is a programming
-- error rather than an empty result. Design D2: a panel's numbers are captured
-- at request time and never re-queried.
select throws_ok(
  $$select * from public.report_page(
      (select user_id from public.platform_admins limit 1),
      'AUDIENCE_PANEL'::public.report_type,
      array[(select id from public.companies limit 1)], '{}'::jsonb, null, null, 10)$$,
  '22023', null, 'the dispatcher refuses a panel type');

-- Every listing type dispatches to something. A new enum value added without
-- a branch here would otherwise fall through and return nothing -- an empty
-- file rather than an error.
select lives_ok(
  $$select public.report_page(
      (select user_id from public.platform_admins limit 1),
      t::public.report_type,
      array[(select id from public.companies where status = 'active' limit 1)],
      '{}'::jsonb, null, null, 1)
    from unnest(array['LISTENERS','PARTICIPATIONS','WINNERS','MUSIC_REQUESTS','MOVEMENTS']) t$$,
  'every listing type has a branch');
```

- [ ] **Step 2: Run to verify it fails** — `npm run db:test`, FAIL on `has_function`.

- [ ] **Step 3: Write the migration**

Create `supabase/migrations/0126_report_page.sql`:

```sql
-- supabase/migrations/0126_report_page.sql

-- Block 8b, Task 6: one door for five queries.
--
-- The worker knows nothing about report internals: it calls this, walks the
-- cursor, and stops. request_report (0127) calls the SAME function with
-- p_limit => 1 to preflight the row ceiling, which is why the ceiling has no
-- second implementation -- total_count rides back on this call.
--
-- THE `else` BRANCH IS NOT DEFENSIVE PROGRAMMING. report_type is an enum, and
-- a value added later without a branch here would otherwise fall out of the
-- CASE returning nothing at all -- an empty file, which looks like a report of
-- a Station with no data. Raising is the only outcome that cannot be mistaken
-- for a result.

create function public.report_page(
  p_user_id     uuid,
  p_report_type public.report_type,
  p_company_ids uuid[],
  p_filters     jsonb,
  p_cursor_at   timestamptz,
  p_cursor_id   uuid,
  p_limit       integer
)
returns table (
  sort_at     timestamptz,
  sort_id     uuid,
  row_data    jsonb,
  total_count bigint,
  withheld    text[]
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
begin
  case p_report_type
    when 'LISTENERS' then
      return query select * from public.report_page_listeners(
        p_user_id, p_company_ids, p_filters, p_cursor_at, p_cursor_id, p_limit);
    when 'PARTICIPATIONS' then
      return query select * from public.report_page_participations(
        p_user_id, p_company_ids, p_filters, p_cursor_at, p_cursor_id, p_limit);
    when 'WINNERS' then
      return query select * from public.report_page_winners(
        p_user_id, p_company_ids, p_filters, p_cursor_at, p_cursor_id, p_limit);
    when 'MUSIC_REQUESTS' then
      return query select * from public.report_page_music_requests(
        p_user_id, p_company_ids, p_filters, p_cursor_at, p_cursor_id, p_limit);
    when 'MOVEMENTS' then
      return query select * from public.report_page_movements(
        p_user_id, p_company_ids, p_filters, p_cursor_at, p_cursor_id, p_limit);
    else
      raise exception 'report type % has no page function', p_report_type
        using errcode = '22023';
  end case;
end;
$$;

comment on function public.report_page(uuid, public.report_type, uuid[], jsonb, timestamptz, uuid, integer) is
  'The one door the worker and request_report both use. Dispatches to the five listing page functions; raises 22023 for a panel type, because a panel''s numbers are captured at request time under the caller''s own rights (D2) and are never re-queried here. The else branch raises rather than returning nothing: an enum value added without a branch would otherwise produce an empty file, which reads as a Station with no data.';

revoke execute on function public.report_page(uuid, public.report_type, uuid[], jsonb, timestamptz, uuid, integer) from public;
grant execute on function public.report_page(uuid, public.report_type, uuid[], jsonb, timestamptz, uuid, integer) to authenticated, service_role;
```

- [ ] **Step 4: Run** — `npm run db:test`, 36/36 PASS.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/0126_report_page.sql supabase/tests/22_reports.test.sql
git commit -m "feat(reports): one dispatcher for the five listing queries"
```

---

## Task 8: The run lifecycle

**Files:**
- Create: `supabase/migrations/0127_report_run_rpcs.sql`
- Modify: `supabase/tests/22_reports.test.sql`

**Interfaces:**
- Consumes: `report_page` (Task 7), `report_runs` (Task 3), `has_permission_for` (Task 2).
- Produces:
  - `request_report(p_organization_id uuid, p_company_ids uuid[], p_report_type public.report_type, p_format public.report_format, p_filters jsonb, p_payload jsonb) returns uuid` — `SECURITY DEFINER`, `authenticated` only.
  - `claim_report_run() returns setof public.report_runs` — `service_role` only.
  - `finish_report_run(p_run_id uuid, p_storage_path text, p_row_count integer, p_byte_size integer, p_withheld text[]) returns void`
  - `fail_report_run(p_run_id uuid, p_error text) returns void`
  - `requeue_stalled_report_runs() returns integer`

- [ ] **Step 1: Add the failing assertions**

Raise `plan(36)` to `plan(46)`, insert before `finish()`:

```sql
select has_function('public', 'request_report',
  array['uuid', 'uuid[]', 'report_type', 'report_format', 'jsonb', 'jsonb'],
  'request_report exists');
select has_function('public', 'claim_report_run', array[]::text[], 'claim_report_run exists');
select has_function('public', 'finish_report_run',
  array['uuid', 'text', 'integer', 'integer', 'text[]'], 'finish_report_run exists');
select has_function('public', 'fail_report_run', array['uuid', 'text'], 'fail_report_run exists');
select has_function('public', 'requeue_stalled_report_runs', array[]::text[],
  'requeue_stalled_report_runs exists');

-- The claim is the concurrency-critical one. Two ticks overlapping (a slow
-- generation and the next cron firing) must not both take the same run: the
-- file would be written twice and the second finish would overwrite the first
-- run's row.
select function_privs_are('public', 'claim_report_run', array[]::text[], 'authenticated',
  array[]::text[], 'authenticated cannot claim a run');
select function_privs_are('public', 'finish_report_run',
  array['uuid', 'text', 'integer', 'integer', 'text[]'], 'authenticated',
  array[]::text[], 'authenticated cannot finish a run');

-- request_report is the client's only write door, and it is the one that
-- refuses a consolidated request without reports.consolidated.
select function_privs_are('public', 'request_report',
  array['uuid', 'uuid[]', 'report_type', 'report_format', 'jsonb', 'jsonb'],
  'authenticated', array['EXECUTE'], 'authenticated may request a report');

-- Three attempts and no more. The contrast with storage_erasure_queue is the
-- point and 0122's column comment argues it.
select is(
  (select pg_get_functiondef(oid) from pg_proc where proname = 'fail_report_run')
    like '%attempts >= 3%',
  true,
  'fail_report_run gives up at three attempts');

select is(
  (select pg_get_functiondef(oid) from pg_proc where proname = 'requeue_stalled_report_runs')
    like '%15 minutes%',
  true,
  'the stall threshold is fifteen minutes');
```

- [ ] **Step 2: Run to verify it fails** — `npm run db:test`.

- [ ] **Step 3: Write the migration**

Create `supabase/migrations/0127_report_run_rpcs.sql`. The five functions, with these rules written into them:

**`request_report`** — `SECURITY DEFINER`, granted to `authenticated`. In order:
1. `v_actor := auth.uid()`; null → `42501`.
2. Every Station in `p_company_ids` must belong to `p_organization_id` — else `22023`. (A caller who could name another Organization's Station would get the permission check to refuse it anyway, but the error would be a permission error for what is really a malformed request.)
3. If `cardinality(p_company_ids) > 1`, require `has_permission_for(v_actor, 'reports.consolidated', c)` for **every** `c` — else `42501`. This is 8a's D3, and it is checked here rather than in the page functions because the page functions are also the single-Station preflight.
4. For a **listing** type: call `report_page(v_actor, p_report_type, p_company_ids, p_filters, null, null, 1)` and read `total_count`. Zero rows is allowed (an empty report is a true answer); `> 50000` raises `22023` with a message naming the count. The page function's own permission guard runs here, as the caller, so an unauthorized request is refused in the dialog rather than ten seconds later.
5. For a **panel** type: `p_payload` must be non-null (the `CHECK` would catch it, but the message would be a constraint name).
6. Insert the run, `status = 'QUEUED'`.
7. Write `audit_logs` with `action = 'request_report'`, `target_table = 'report_runs'`, `target_id = v_id`, `detail = jsonb_build_object('report_type', p_report_type, 'format', p_format, 'company_ids', p_company_ids, 'row_count_estimate', v_count)`. **This is the block's real control over exporting personal data** (design D8) — the export is not forbidden, it is recorded.
8. Return the id.

**`claim_report_run`** — `SECURITY DEFINER`, `service_role` only:

```sql
update public.report_runs r
   set status = 'RUNNING', started_at = now(), attempts = r.attempts + 1
 where r.id = (
   select id from public.report_runs
    where status = 'QUEUED'
    order by requested_at
    for update skip locked
    limit 1
 )
returning r.*;
```

`skip locked` is the whole of the concurrency argument, and it is `claim_outbox_batch`'s (0111) shape: two overlapping ticks take different rows or one takes nothing, never the same row twice. `attempts` increments **on claim, not on failure**, so a run whose process dies without reporting anything still counts its try.

**`finish_report_run`** — sets `status = 'READY'`, `storage_path`, `row_count`, `byte_size`, `withheld`, `finished_at = now()`, and `expires_at = now() + interval '7 days'`. The clock starts when the file exists, not when it was asked for.

**`fail_report_run`** — sets `last_error`, and `status = case when attempts >= 3 then 'FAILED' else 'QUEUED' end`, clearing `started_at` when it returns to the queue. Three attempts and then it stops, deliberately unlike `storage_erasure_queue`.

**`requeue_stalled_report_runs`** — returns runs `RUNNING` with `started_at < now() - interval '15 minutes'` to `QUEUED` (or to `FAILED` if `attempts >= 3`), returning the count. Called from the tick, not from cron, so it needs no schedule of its own.

Grants: `request_report` to `authenticated`; the other four to `service_role` only, and explicitly revoked from `authenticated` — a client that could call `finish_report_run` could point `storage_path` at another Station's object.

- [ ] **Step 4: Add the concurrency assertion**

Because pgTAP runs single-session, the two-claimant race is proved in the isolation suite instead (Task 12). Here, assert the shape:

```sql
select ok(
  (select pg_get_functiondef(oid) from pg_proc where proname = 'claim_report_run')
    like '%skip locked%',
  'the claim skips locked rows');
```

- [ ] **Step 5: Run** — `npm run db:test`, 46/46 PASS. Then `npm run db:types` and commit the regenerated types.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/0127_report_run_rpcs.sql supabase/tests/22_reports.test.sql src/lib/supabase/database.types.ts
git commit -m "feat(reports): the run lifecycle, and the audit row every export leaves"
```

---

## Task 9: Expiry, and an erasure that is real

**Files:**
- Create: `supabase/migrations/0128_expire_report_runs.sql`
- Modify: `supabase/tests/22_reports.test.sql`

**Interfaces:**
- Consumes: `report_runs`, `storage_erasure_queue` (0087).
- Produces: `procedure public.expire_report_runs()` and its `cron.schedule`.

- [ ] **Step 1: Add the failing assertions** (raise to `plan(49)`)

```sql
select has_function('public', 'expire_report_runs', array[]::text[],
  'expire_report_runs exists');

-- A PROCEDURE, not a function, and for 0094's reason: only a procedure may
-- commit, and this one must commit per Station so one unwritable row does not
-- roll back every other expiry, every day, for ever.
select is(
  (select prokind from pg_proc where proname = 'expire_report_runs'),
  'p'::"char",
  'expire_report_runs is a procedure');

select ok(
  exists (select 1 from cron.job where command like '%expire_report_runs%'),
  'the expiry is scheduled');
```

- [ ] **Step 2: Run to verify it fails** — `npm run db:test`.

- [ ] **Step 3: Write the migration**

Create `supabase/migrations/0128_expire_report_runs.sql`. The procedure, for each run with `storage_path is not null and expires_at <= now()`:

1. `insert into public.storage_erasure_queue (bucket, path) values ('reports', r.storage_path)` — the queue the tick already drains through the storage API, because **deleting a row in SQL removes the metadata and leaves the file in the backing store** (0087's header).
2. `update public.report_runs set storage_path = null where id = r.id` — in the same statement pair, so the intent cannot survive without the instruction.
3. `commit` after each row.

Both steps must be in one transaction per run: clearing the path without queueing the object would leave a file nobody can reach and nobody will delete — the worst of both.

**No `set search_path`** on the procedure, matching `0094`/`0112`: a procedure that commits cannot carry it.

Schedule daily:

```sql
select cron.schedule(
  'expire-report-runs',
  '17 3 * * *',
  $$call public.expire_report_runs()$$
);
```

`17 3` rather than `0 3`, so it does not contend with every other installation's midnight-and-on-the-hour jobs.

- [ ] **Step 4: Run** — `npm run db:test`, 49/49 PASS.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/0128_expire_report_runs.sql supabase/tests/22_reports.test.sql
git commit -m "feat(reports): expire a report's file for real, through 6b's queue"
```

---

## Task 10: The schemas and the caller-side service

**Files:**
- Create: `src/schemas/reports.ts`, `src/services/reports.ts`, `src/lib/reports/types.ts`
- Create: `tests/unit/reports/schemas.test.ts`

**Interfaces:**
- Consumes: the RPCs of Tasks 7–8.
- Produces:
  - `reportRequestSchema` — a Zod **discriminated union on `reportType`**, each arm carrying that type's filter shape and its permitted formats.
  - `reportRunSchema`, `type ReportRun`.
  - `REPORT_COLUMNS: Record<ReportType, ReadonlyArray<{ key: string; header: string }>>` in `lib/reports/types.ts` — the single source of column order and headings, used by the CSV writer, the XLSX writer and the provenance block.
  - `requestReport(input, accessToken): Promise<string>`
  - `listMyReportRuns(accessToken): Promise<ReportRun[]>`
  - `signedUrlForRun(runId, accessToken): Promise<string | null>`

- [ ] **Step 1: Write the failing tests**

`tests/unit/reports/schemas.test.ts` asserts: a `LISTENERS` request with `format: 'PDF'` is rejected; an `AUDIENCE_PANEL` request with `format: 'CSV'` is rejected; an unknown filter key is stripped (or rejected — pick `.strict()` and assert the rejection, matching 8a's schemas); a `from` after `to` is rejected by the same rule `parsePeriod` uses, so the screen and the export refuse the same range; `REPORT_COLUMNS` has an entry for all five listing types and no duplicate keys.

- [ ] **Step 2: Run to verify it fails** — `npx vitest run tests/unit/reports/schemas.test.ts`.

- [ ] **Step 3: Implement**

`services/reports.ts` follows `services/dashboards.ts`'s error mapping exactly: `42501 → UnauthorizedError`, `22023 → ValidationError`, anything else → `InternalError`. Nothing here constructs a `NotFoundError` except `signedUrlForRun` for a run id that does not resolve.

`requestReport` for a **panel** type calls the matching `getAudienceDashboard` / `getMusicDashboard` / `getPromotionsDashboard` **first, as the caller**, and passes the parsed result as `p_payload`. This is D2, and it is the only place in the block that touches the 8a aggregates.

Rate limiting, before the RPC, through the service client — `services/invitations.ts` is the pattern:

```ts
const limiter = new PostgresRateLimiter(createServiceClient());
const { allowed } = await limiter.hit(`report:${userId}`, 20, 3600);
if (!allowed) throw new BusinessRuleError('too many reports requested in the last hour');
```

`signedUrlForRun` reads the run through the **user** client (so `report_runs`' RLS answers "may this caller see this run"), then mints the URL with a 60-second expiry through the same client. A run whose `storage_path` is null returns `null`, which the screen renders as "expired".

- [ ] **Step 4: Run** — tests pass, `npm run lint && npm run typecheck`.

- [ ] **Step 5: Commit**

```bash
git add src/schemas/reports.ts src/services/reports.ts src/lib/reports/types.ts tests/unit/reports/schemas.test.ts
git commit -m "feat(reports): the request schemas and the caller-side service"
```

---

## Task 11: The three writers and the generation loop

**Files:**
- Create: `src/lib/reports/provenance.ts`, `csv.ts`, `xlsx.ts`, `pdf.tsx`, `generate.ts`
- Create: `tests/unit/reports/csv.test.ts`, `provenance.test.ts`, `generate.test.ts`

**Interfaces:**
- Consumes: `REPORT_COLUMNS` (Task 10), `report_page` and the lifecycle RPCs (Tasks 7–8).
- Produces: `generateReportRun(supabase: ServiceClient, run: ReportRun): Promise<{ rowCount: number; byteSize: number }>` — the whole of one run, from first page to uploaded object.

- [ ] **Step 1: Write the failing tests**

`csv.test.ts`: a value containing the delimiter, a double quote and a newline round-trips through the writer and back per RFC 4180; a `null` becomes an empty field, not the string `null`; a value beginning `=`, `+`, `-` or `@` is prefixed with `'` — **spreadsheet formula injection**, which matters because these files are opened in Excel by people who did not generate them and a listener's "name" is attacker-controlled through the WhatsApp ingestion path.

`provenance.test.ts`: the block names every withheld column and the permission that would have carried it; a report with no withheld columns still says so explicitly rather than omitting the line.

`generate.test.ts`: the loop stops when a page returns fewer rows than the limit; a page raising `42501` mid-file aborts the run rather than uploading a partial file; `total_count` crossing the ceiling on the first page fails the run without writing anything.

- [ ] **Step 2: Run to verify they fail.**

- [ ] **Step 3: Implement**

`generate.ts`, in order: claim is the caller's; then

1. First page (`limit 1000`, cursor null). Read `total_count` and `withheld` from the first row. If `total_count > 50000` → `fail_report_run` and return.
2. Open the writer for the format. The provenance block is written **first**, before the header row, so it survives a truncated download.
3. Loop pages, advancing the cursor by the last row's `(sort_at, sort_id)`, until a page returns fewer rows than the limit.
4. Upload to `reports/{company_ids[0]}/{run.id}.{ext}` with `contentType` set (`text/csv`, `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`, `application/pdf`) and `upsert: false` — a second write to the same path means the run was claimed twice, and it must fail loudly.
5. `finish_report_run` with the byte size and the withheld set from step 1.

Panels skip 1–3 entirely: `pdf.tsx` renders `run.payload` and nothing queries.

**A withheld figure in a panel payload is absent from the page, not zero** — the renderer reads `payload.withheld` and omits those cards, printing the reason in the footer.

- [ ] **Step 4: Run** — all unit tests, lint, typecheck.

- [ ] **Step 5: Commit**

```bash
git add src/lib/reports tests/unit/reports
git commit -m "feat(reports): the CSV, XLSX and PDF writers, and the page loop"
```

---

## Task 12: The third drain, and the isolation suite

**Files:**
- Modify: `src/app/api/worker/tick/route.ts`
- Create: `tests/isolation/reports.test.ts`
- Modify: `tests/unit/whatsapp/tick.test.ts` (or wherever the tick handler's tests live)

**Interfaces:**
- Consumes: `claim_report_run`, `generateReportRun`, `requeue_stalled_report_runs`.
- Produces: the tick's response gains a `reports` key: `{ claimed: number; ready: number; failed: number; requeued: number }`.

- [ ] **Step 1: Write the failing tests**

The tick test asserts that a throwing report drain **does not lose the outbox counters** — the same guarantee `drainStorageErasures` already has, and for the same reason: a broken report engine must not stop messages going out.

`tests/isolation/reports.test.ts`, with real JWTs through `./harness`:
- a user of Station A requests a report; a user of Station B cannot read the run row, and `signedUrlForRun` on it fails;
- a consolidated request naming B, by a user of A, is refused with `42501`;
- a user holding `participations.view` but not `members.view` gets rows whose `row_data` has **no `name` key at all**, and `withheld` naming the three;
- **the two-claimant race**: two concurrent `claim_report_run` calls return different run ids, or one returns nothing — never the same id twice. This is the assertion pgTAP structurally cannot make.

- [ ] **Step 2: Run to verify they fail.**

- [ ] **Step 3: Implement the drain**

One run per tick, beside the other two drains and wrapped the same way:

```ts
let reports: ReportDrainResult | { error: string };
try {
  reports = await drainReportRuns(supabase);
} catch (cause) {
  reports = { error: cause instanceof Error ? cause.message : 'unknown' };
}
```

`drainReportRuns` calls `requeue_stalled_report_runs` first, then `claim_report_run`; a null claim returns zeros without touching anything.

- [ ] **Step 4: Run** — `npm test`, then `npm run test:isolation`.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/worker/tick/route.ts src/lib/reports/drain.ts tests/isolation/reports.test.ts tests/unit
git commit -m "feat(reports): drain one run per tick, without risking the outbox"
```

---

## Task 13: The screens

**Files:**
- Create: `src/app/(app)/reports/page.tsx`, `actions.ts`, `runs-table.tsx`, `pending-refresher.tsx`, `permissions.ts`
- Create: `src/components/reports/export-dialog.tsx`
- Modify: the five listing pages and the three dashboard pages to mount the export entry point
- Modify: the navigation in `src/app/(app)/layout.tsx`
- Create: `tests/e2e/reports.spec.ts`

**Interfaces:**
- Consumes: `requestReport`, `listMyReportRuns`, `signedUrlForRun`.
- Produces: `<ExportDialog reportType filters companyIds />` — one component, mounted eight times, which is what keeps the filters on screen and the filters in the file the same object.

- [ ] **Step 1: Write the failing e2e test**

`tests/e2e/reports.spec.ts`: sign in, open Participations, apply a filter, click Export, choose CSV, land on `/reports` with a run `QUEUED`; POST the worker tick with the shared secret; reload; the run is `READY`; click Download and assert the response is a CSV whose first lines are the provenance block.

- [ ] **Step 2: Run to verify it fails** — `npx playwright test tests/e2e/reports.spec.ts`.

- [ ] **Step 3: Implement**

`/reports` is a server component listing the caller's runs. `pending-refresher.tsx` is a client component that calls `router.refresh()` every three seconds **while at least one run is `QUEUED` or `RUNNING`**, and stops otherwise — an interval that never stops is a page that polls for ever in a background tab.

The export dialog asks for the format and nothing else: the filters arrive as props from the screen the operator was already looking at.

Navigation: `/reports` at the top level, guarded by nothing — the screen lists only the caller's own runs, and every export button behind it is guarded by its own domain permission.

- [ ] **Step 4: Run** — `npm run build`, then the e2e suite **in series** (`--workers=1`): parallel sign-in contends on the local Supabase and has failed on this machine since Block 7b. CI is the arbitration.

- [ ] **Step 5: Commit**

```bash
git add "src/app/(app)/reports" src/components/reports "src/app/(app)/layout.tsx" tests/e2e/reports.spec.ts
git commit -m "feat(reports): the /reports screen and eight export entry points"
```

---

## Task 14: The runbook and the whole gate

**Files:**
- Create: `docs/superpowers/reports/2026-08-05-block-8b-report.md`
- Modify: `docs/DEPLOYMENT.md` (or the runbook the previous blocks appended to)

- [ ] **Step 1: Write the verification report** — the shape the previous ten blocks used: what shipped, the gate output verbatim, the decisions taken during implementation, and what the next block inherits.

- [ ] **Step 2: The deploy note, at the top of the runbook**

**0121 rewrites `has_permission`, which every policy in the installation depends on.** The database goes first, always, and the pgTAP suite is what says it may. A frontend deployed ahead of `supabase db push` offers eight export buttons and fails behind every one of them — the trap Block 7a paid for once and 8a restated.

- [ ] **Step 3: Run the whole gate**

```bash
npm run lint && npm run typecheck && npm test && npm run db:test && npm run test:isolation && npm run build && npx playwright test --workers=1
```

Record the real numbers. **If something fails, the report says so** — a green report over a red suite is the one failure that costs more than the defect.

- [ ] **Step 4: Commit and open the PR**

```bash
git add docs
git commit -m "docs(reports): the Block 8b verification report and the deploy order"
git push -u origin block-8b
gh pr create --title "Block 8b — the report engine" --body "..."
```

**Migrations go up only after the PR merges.** They are edited in place on the branch until then, and Supabase records a migration by version number: pushing early and editing afterwards means the edit never lands and `migration list` shows everything applied. Block 8a's memory records this.

---

## Self-review — spec coverage

| spec section | task |
| --- | --- |
| §2 the worker has no identity | 2 |
| D1 everything through the queue | 8, 12 |
| D2 panel payload captured at request time | 3 (the CHECK), 10 (the capture), 11 (the renderer) |
| D3 `has_permission_for` | 2 |
| D4 five page functions, uniform contract | 5, 6, 7 |
| D5 `report_runs` | 3 |
| D6 seven-day expiry through the erasure queue | 8 (`expires_at`), 9 (the sweep) |
| D7 withheld columns absent and named | 5, 6 (the SQL), 11 (the provenance block), 12 (the isolation proof) |
| D8 no new permission; the audit row is the control | 8 (`request_report`'s audit write) |
| D9 the 50 000 ceiling, refused twice | 8 (request), 11 (worker) |
| D10 three attempts | 8 |
| D11 one run per tick, `skip locked` | 8, 12 |
| D12 PDF for panels only; the two dependencies | 1, 3 (the format CHECK), 11 |
| D13 the period contract | 5, 6 (the `from`/`to` filters), 10 (`parsePeriod` agreement) |
| D14 the rate limit | 10 |
| §4 the catalogue of five | 5, 6 |
| §5 the screens | 13 |
| §7 verification | every task, gathered in 14 |

