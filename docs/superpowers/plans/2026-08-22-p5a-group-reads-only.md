# P5a — the group reads and does not write: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An Organization's users read every record of every Station in the group
and change nothing — which today they can, because the group's owner passes every
permission at every Station, writes included.

**Architecture:** D19 reads as an addition and is a **restriction**.
`has_permission_for` already admits the group's owner to every permission at every
Station of their group, through one `or exists (... is_owner_for(user,
c.organization_id))` branch. This narrows that branch to permissions the catalogue
marks as reads. `has_company_access_for` — the separate gate that lets the group
reach the Station at all — is deliberately left alone: the group still reaches
every Station, it simply cannot write there.

**Tech Stack:** PostgreSQL / PL/pgSQL, Supabase migrations, pgTAP.

**Spec:** `docs/superpowers/specs/2026-08-22-station-root-and-platform-identity-design.md`
— block **P5a** of §11; decision **D19**.

## Global Constraints

- **Everything in English** — identifiers, comments, error messages, docs, commit
  messages.
- **Never edit a merged migration in place.** Where a function must change, copy
  it forward from the migration holding the **live** definition — confirmed
  against `pg_proc`, never inferred from a grep for `create or replace`, which
  misses a `drop` + `create function` pair. `has_permission_for`'s live
  definition is `0121_permission_for.sql:156`.
- **Migration numbers `0276`–`0277`.** The highest on `main` is
  `0275_person_id_required.sql`.
- **Run `npm run db:reset` before `npm run db:test`.**

---

## What this block is NOT, and where it went

**The `is_owner_of_company` inversion is not here.** That helper resolves a
Station's Organization and asks whether you own the *group*; D17 wants a Station
owner instead. Inverting it is the staff model, and "who may create a role at this
Station" is the same question, so it moves to **P5b** with roles and invitations.
Nothing in this block needs it: D19 is about what the group's users may do, not
about who owns a Station.

**The six Organization-level permissions descending is not here either**, for the
same reason: `users.manage`, `users.invite` and `roles.manage` descend when staff
descends. `members.view` and `audit.view` are already company-scoped through
`has_permission`; `members.block`'s Organization-wide form is retired in **P5c**.

What is here is one branch of one function, and the catalogue column that lets it
be written truthfully.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `supabase/migrations/0276_permission_kind.sql` (create) | `permissions.kind`, all 43 codes classified, `not null` taken in the same migration because the classification is complete by construction. |
| `supabase/migrations/0277_group_reads_only.sql` (create) | `has_permission_for` copied forward from `0121` with the Organization branch narrowed to reads. |
| `supabase/tests/77_group_reads_only.test.sql` (create) | The block's assertions, including the classification's completeness. |

**Application changes: expected to be none, and that is a finding either way.**
Nothing in `src/` decides a permission for itself — every gate is a
`has_permission` call in a `SECURITY DEFINER` body. If a screen breaks, it has
been relying on the group's owner writing, and that screen is the thing D19 is
about. Task 3 runs the e2e suite specifically to find out.

---

### Task 1: The catalogue learns which codes are reads

**Files:**
- Create: `supabase/migrations/0276_permission_kind.sql`
- Create: `supabase/tests/77_group_reads_only.test.sql`

**Interfaces:**
- Produces: `public.permission_kind` enum with values `READ`, `WRITE`
- Produces: `public.permissions.kind permission_kind not null`

- [ ] **Step 1: Write the failing test**

Create `supabase/tests/77_group_reads_only.test.sql`:

```sql
begin;
select plan(4);

-- ---------------------------------------------------------------------------
-- P5a. THE GROUP READS AND DOES NOT WRITE (design D19).
--
-- The classification has to be DATA rather than a list inside a function. A list
-- drifts the first time a block adds a permission and nobody remembers to
-- exclude it, and the drift is silent: the new code simply becomes writable by
-- every group owner in the platform.
-- ---------------------------------------------------------------------------

select has_column('public', 'permissions', 'kind',
  'every permission says whether it is a read or a write');

select col_not_null('public', 'permissions', 'kind',
  'and none of them may decline to say');

-- The nine reads, named rather than counted, so adding a tenth is a deliberate
-- edit here and not an off-by-one somebody accepts.
select set_eq(
  $$ select code from public.permissions where kind = 'READ' $$,
  $$ values ('audit.view'), ('inventory.view'), ('members.view'),
            ('messaging.view'), ('music.view'), ('participations.view'),
            ('promotions.view'), ('reports.consolidated'), ('templates.view') $$,
  'and exactly these nine are reads');

-- The guarantee that makes a new permission safe by default: a code added by a
-- future block with no kind cannot exist, and one added as WRITE is invisible to
-- the group until somebody decides otherwise.
select is(
  (select count(*)::int from public.permissions where kind = 'WRITE'),
  34,
  'and the other thirty-four are writes');

select * from finish();
rollback;
```

- [ ] **Step 2: Run it and watch it fail**

```bash
npm run db:reset && npm run db:test
```

Expected: the first assertion reports `permissions` has no column `kind`.

- [ ] **Step 3: Write the migration**

Create `supabase/migrations/0276_permission_kind.sql`:

```sql
-- supabase/migrations/0276_permission_kind.sql

-- WHICH PERMISSIONS ARE READS, as data rather than as a list inside a function.
--
-- 0277 uses this to decide what an Organization's users may do at a Station of
-- their group (design D19): everything that reads, nothing that writes. Written
-- as a list in that function instead, it would drift the first time a block adds
-- a permission and nobody remembers to classify it -- and the drift is silent in
-- the worst direction, because an unclassified code would fall into whichever
-- branch the list's default is.
--
-- NOT NULL IN THIS SAME MIGRATION, unlike members.person_id in 0275. There the
-- constraint had to wait for a backfill over live rows written by doors that did
-- not know about it. Here the classification is complete by construction: the
-- catalogue has forty-three rows, this file names all forty-three, and a
-- forty-fourth cannot arrive until some future migration inserts it -- at which
-- point the constraint is exactly the reminder that migration needs.
create type public.permission_kind as enum ('READ', 'WRITE');

alter table public.permissions add column kind public.permission_kind;

-- The reads. Everything that shows somebody something and changes nothing.
-- reports.consolidated is here deliberately: it gates the dashboard's Station
-- pills (0115, 0118), which is reading numbers across a group -- the single most
-- group-shaped thing in the product, and the reason D19 exists.
update public.permissions set kind = 'READ' where code in (
  'audit.view',
  'inventory.view',
  'members.view',
  'messaging.view',
  'music.view',
  'participations.view',
  'promotions.view',
  'reports.consolidated',
  'templates.view'
);

-- Everything else. Named as a fallback rather than as a list, deliberately: a
-- code this file forgot to mention must land in WRITE, which is the side that
-- withholds rather than the side that grants.
update public.permissions set kind = 'WRITE' where kind is null;

alter table public.permissions alter column kind set not null;

comment on column public.permissions.kind is
  'Whether exercising this permission changes a Station''s operational state. READ is what an Organization''s users may do at a Station of their group and WRITE is what they may not (design D19, enforced in has_permission_for). A permission added without a kind cannot exist, which is deliberate: the constraint is the reminder, and anything that slipped through would otherwise become writable by every group owner on the platform without a line of code changing.';
```

- [ ] **Step 4: Run it and watch it pass**

```bash
npm run db:reset && npm run db:test
```

Expected: `77_group_reads_only` passes all 4; every other file unchanged, since
nothing reads the column yet.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/0276_permission_kind.sql supabase/tests/77_group_reads_only.test.sql
git commit -m "feat(p5a): the catalogue says which permissions are reads"
```

---

### Task 2: The group's branch narrows to reads

**Files:**
- Create: `supabase/migrations/0277_group_reads_only.sql`
- Modify: `supabase/tests/77_group_reads_only.test.sql`
- Read (do not modify): `supabase/migrations/0121_permission_for.sql:156` — `has_permission_for`, whose live definition this is

Confirm that before copying:

```bash
docker exec supabase_db_CRM_-_LISTENER psql -U postgres -d postgres -tAc \
  "select pg_get_function_identity_arguments(p.oid) from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'has_permission_for'"
```

Expected: `p_user_id uuid, p_permission text, p_company_id uuid`. Anything else
means a later migration changed it and `0121` is not the source.

**Interfaces:**
- Consumes: `public.permissions.kind` from Task 1
- Preserves: `has_permission_for`'s signature exactly, so `has_permission` and
  every caller are untouched

- [ ] **Step 1: Write the failing test**

Raise the plan to `select plan(9);` and append before `select * from finish();`:

```sql
-- ---------------------------------------------------------------------------
-- THE NARROWING. Two Stations in one Organization, an owner of that
-- Organization, and a plain member of one Station -- so the assertions can tell
-- "the group's reach" apart from "this Station's role".
-- ---------------------------------------------------------------------------
insert into public.organizations (id, name) values
  ('00000000-0000-0000-0000-0000000077f1', 'Org P5a');

insert into public.companies (id, organization_id, name, timezone, status) values
  ('00000000-0000-0000-0000-0000000077c1', '00000000-0000-0000-0000-0000000077f1',
   'Station P5a one', 'America/Sao_Paulo', 'active');

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000077a1', 'owner-p5a@example.com');

insert into public.organization_memberships (user_id, organization_id, role) values
  ('00000000-0000-0000-0000-0000000077a1', '00000000-0000-0000-0000-0000000077f1', 'owner');

-- What the group's owner may still do: everything that reads.
select is(
  public.has_permission_for('00000000-0000-0000-0000-0000000077a1',
                            'members.view', '00000000-0000-0000-0000-0000000077c1'),
  true,
  'the group''s owner reads a listener at a Station of the group');

select is(
  public.has_permission_for('00000000-0000-0000-0000-0000000077a1',
                            'reports.consolidated', '00000000-0000-0000-0000-0000000077c1'),
  true,
  'and consolidates its figures, which is what the group is for');

-- What they may no longer do, and could until this migration.
select is(
  public.has_permission_for('00000000-0000-0000-0000-0000000077a1',
                            'promotions.create', '00000000-0000-0000-0000-0000000077c1'),
  false,
  'and does NOT create a promotion there, which they could until 0277');

select is(
  public.has_permission_for('00000000-0000-0000-0000-0000000077a1',
                            'members.erase', '00000000-0000-0000-0000-0000000077c1'),
  false,
  'nor erase a listener');

-- The gate is untouched: the group still REACHES the Station. Losing that would
-- take the reading away too, which is the opposite of D19.
select is(
  public.has_company_access_for('00000000-0000-0000-0000-0000000077a1',
                                '00000000-0000-0000-0000-0000000077c1'),
  true,
  'while still reaching the Station at all: D19 removes writing, not access');
```

- [ ] **Step 2: Run it and watch it fail**

```bash
npm run db:reset && npm run db:test
```

Expected: the two `false` assertions report `have: true` — the group's owner
creating promotions and erasing listeners is exactly today's behaviour, and it is
what this block is about. The three `true` assertions pass already.

- [ ] **Step 3: Write the migration**

Create `supabase/migrations/0277_group_reads_only.sql` by copying the live
definition forward:

```bash
{ printf -- '-- supabase/migrations/0277_group_reads_only.sql\n\n'; \
  sed -n '/^create or replace function public.has_permission_for/,/^\$\$;/p' \
    supabase/migrations/0121_permission_for.sql; } \
  > supabase/migrations/0277_group_reads_only.sql
```

Then narrow the Organization branch. It reads:

```sql
       or exists (
         select 1 from public.companies c
         where c.id = p_company_id and public.is_owner_for(p_user_id, c.organization_id)
       )
```

and becomes:

```sql
       -- D19, AND IT IS A RESTRICTION RATHER THAN THE ADDITION THE DECISION
       -- SOUNDS LIKE. Until this migration this branch admitted the group's
       -- owner to EVERY permission at every Station of the group -- creating
       -- promotions, adjusting inventory, erasing listeners. The owner's ruling
       -- of 2026-08-22 is that an Organization's users read everything and
       -- change nothing, so the branch now asks the catalogue what kind of
       -- permission this is.
       --
       -- has_company_access_for, above, is deliberately NOT touched: it is what
       -- lets the group reach the Station at all, and narrowing it would take
       -- the reading away with the writing.
       --
       -- The kind is read from the catalogue rather than matched on the code's
       -- shape. "Everything ending in .view" would have been shorter and would
       -- have made reports.consolidated -- the most group-shaped permission
       -- there is -- a write.
       or exists (
         select 1
         from public.companies c
         join public.permissions p on p.code = p_permission
         where c.id = p_company_id
           and p.kind = 'READ'
           and public.is_owner_for(p_user_id, c.organization_id)
       )
```

Then append the comment, re-issued whole because the old one no longer describes
what the function does:

```sql
comment on function public.has_permission_for(uuid, text, uuid) is
  'Valid code AND active subscription AND (admin OR the Organization''s owner FOR A READ OR the role assigned in THAT Company grants it). The role must be live (r.deleted_at is null, 0024 Minor 2). The Organization clause was unconditional until 0277: a group''s owner held every permission at every Station of the group, writes included, and design D19 narrows it to permissions the catalogue marks READ (0276). has_company_access_for is untouched, so the group still reaches the Station -- what it loses is the ability to change anything there.';
```

Verify the copy reverted nothing:

```bash
diff \
  <(sed -n '/^create or replace function public.has_permission_for/,/^\$\$;/p' supabase/migrations/0121_permission_for.sql) \
  <(sed -n '/^create or replace function public.has_permission_for/,/^\$\$;/p' supabase/migrations/0277_group_reads_only.sql)
```

Expected: one hunk, the Organization branch. Nothing removed but those four lines.

- [ ] **Step 4: Run it and watch it pass**

```bash
npm run db:reset && npm run db:test
```

Expected: `77_group_reads_only` passes all 9. **Other files failing here is the
real result of this block**: each one names a place that relied on the group's
owner writing. Read each before changing it — the fixture may be asserting
behaviour D19 deliberately removes, in which case the assertion changes and its
description says why, exactly as `44_service_hashtags` and `73_fast_entry` did in
P1.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/0277_group_reads_only.sql supabase/tests/77_group_reads_only.test.sql
git commit -m "feat(p5a): the group's owner stops writing at Stations of the group"
```

---

### Task 3: Find out what the screens were relying on

No new code is planned here. This task exists because the honest answer to
"application changes: none" is "none that I can find by reading", and the e2e
suite drives the real console as a real user.

- [ ] **Step 1: Run every gate**

```bash
npm run db:reset && npm run db:test
npm run lint && npm test && npm run build
npm run test:e2e
```

- [ ] **Step 2: Read what e2e says**

A failure here is a screen that a group owner could operate and now cannot. For
each one, decide and record which it is:

- **D19 doing its job** — the screen offered a write to somebody who should not
  have it. The test changes, its description says what D19 removed, and the
  screen should stop offering the control rather than offering one that refuses.
- **A gap in D19** — the action is genuinely a read that the catalogue classified
  as a write. Fix `0276`'s classification, not the test.

- [ ] **Step 3: Commit whatever the answer required, with the reasoning**

Name the finding in the subject line rather than the block: `fix(p5a): the
Programmes tab offered a group owner an Edit button the database refuses` says
what happened; `fix(p5a): e2e failures` says nothing anybody can act on.

```bash
git add -A
git commit
```

If e2e is green, commit nothing and say so in the PR: the console never let a
group owner write through a path the database did not also gate, which is worth
knowing and is not something reading the code could have proved.

---

## Closing checklist

- [ ] `npm run db:reset && npm run db:test` green from a clean database.
- [ ] The `has_permission_for` diff is one hunk: the Organization branch.
- [ ] `git diff main --stat` names only the two migrations, the new test file,
      and whatever Task 3 found.
- [ ] Every one of the 43 permission codes has a kind, and the nine reads are the
      nine the test names.
- [ ] **The two migrations are applied to the hosted database after the PR
      merges.** Neither touches a row of business data; `0276` writes only to the
      catalogue.
- [ ] **Tell the owner what a group owner can no longer do**, in the PR. This is
      the first block of the programme that takes a capability away from a real
      person who has it today.
