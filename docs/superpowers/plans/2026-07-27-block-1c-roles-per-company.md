# Block 1c — Roles & per-Company Assignment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the three fixed roles with roles the Organization owner composes from a system permission catalogue and assigns per Company.

**Architecture:** A new `roles` table owned by the Organization, joined to the catalogue through `role_permissions`, and referenced by a mandatory `role_id` on `company_memberships`. Cross-Organization assignment is blocked by composite foreign keys rather than by application checks. The three RLS helpers are rewritten to resolve permissions through the role, with the owner bypassing them by ownership.

**Tech Stack:** PostgreSQL 15 (Supabase), PL/pgSQL `SECURITY DEFINER` RPCs, Next.js 15 App Router with Server Components and Server Actions, Zod, Vitest, pgTAP, Playwright.

**Spec:** `docs/superpowers/specs/2026-07-27-block-1c-roles-per-company-design.md`

## Global Constraints

- Everything in English: identifiers, comments, error messages, UI copy, docs.
- Domain vocabulary: `organizations` (Organization), `companies` (Station in prose/UI), `members` (the audience — not used in this block), `company_memberships` (internal panel users).
- Every new table: RLS enabled, `revoke all from anon, authenticated`, explicit `grant` per role, explicit `grant` for `service_role` (BYPASSRLS does not substitute for a GRANT).
- Every business uniqueness rule is a **partial unique index** `where deleted_at is null`.
- `USING (true)` is forbidden in policies.
- Every `SECURITY DEFINER` function re-checks the caller in its own body, and on denial uses `RAISE LOG` + `RAISE EXCEPTION` — never an `audit_logs` insert, which cannot commit inside an aborting transaction.
- Permission-code existence is checked **outside** every bypass, so an unknown code is false even for a platform admin.
- Migrations are numbered sequentially from `0015`.
- Commands: `npm run lint`, `npm run typecheck`, `npm test`, `npm run test:isolation`, `npm run test:e2e`, `npx supabase db reset`, `npx supabase test db`, `npm run db:types`.
- A local Supabase must be running for the db, isolation and e2e suites: `npx supabase start`.

---

### Task 1: Permission catalogue and the `roles` table

**Files:**
- Create: `supabase/migrations/0015_roles.sql`
- Modify: `supabase/tests/02_permissions.test.sql`

**Interfaces:**
- Produces: table `public.roles (id, organization_id, name, description, created_by, created_at, updated_at, deleted_at)`; table `public.role_permissions (role_id, permission_code)`; type `public.permission_scope`; columns `permissions.module`, `permissions.label`, `permissions.scope`, `permissions.display_order`; permission code `roles.manage`; unique constraints `roles_id_org_unique` and `companies_id_org_unique`; a transitional `public.has_permission(text, uuid)` that Task 2 replaces.

- [ ] **Step 1: Write the migration**

```sql
-- supabase/migrations/0015_roles.sql

-- Scope decides which helper resolves a code, and it is what lets the role
-- editor warn that a permission reaches past the Company it is granted in.
create type public.permission_scope as enum ('organization', 'company');

alter table public.permissions
  add column module        text,
  add column label         text,
  add column scope         public.permission_scope,
  add column display_order integer not null default 0;

-- Block 1b's three codes are all Organization-scoped identity operations.
update public.permissions
   set module = 'organization',
       scope  = 'organization',
       label  = case code
                  when 'users.invite' then 'Invite people to the Organization'
                  when 'users.manage' then 'Assign roles and remove people'
                  when 'audit.view'   then 'Read the Organization''s audit trail'
                  else description
                end,
       display_order = case code
                  when 'users.invite' then 10
                  when 'users.manage' then 20
                  when 'audit.view'   then 30
                  else 0
                end;

alter table public.permissions
  alter column module set not null,
  alter column label  set not null,
  alter column scope  set not null;

comment on column public.permissions.module is 'Groups the checkbox in the role editor. The UI carries no copy of the catalogue.';
comment on column public.permissions.label is 'Human sentence shown beside the checkbox.';
comment on column public.permissions.scope is
  'organization: held through a role in ANY Company, it applies to the whole Organization. company: it applies only where the role is assigned.';

-- The job title the owner composes. It belongs to the Organization and is
-- reusable across its Companies; the assignment is per Company.
create table public.roles (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id),
  name            text not null,
  description     text,
  created_by      uuid references auth.users (id),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  deleted_at      timestamptz
);

comment on table public.roles is 'Roles the owner creates (Manager, Director). Organization-scoped, assigned per Company, exactly one per user per Company.';

create unique index roles_name_unique
  on public.roles (organization_id, lower(name))
  where deleted_at is null;

create index roles_organization_idx
  on public.roles (organization_id)
  where deleted_at is null;

-- These two composite keys exist only so 0016 can hang composite foreign keys
-- off them. That is what makes a role from another Organization structurally
-- unassignable: no trigger to forget, no RPC to bypass.
alter table public.roles     add constraint roles_id_org_unique     unique (id, organization_id);
alter table public.companies add constraint companies_id_org_unique unique (id, organization_id);

-- The old table is keyed by the member_role enum and holds three seeded rows,
-- all of them granting the owner — who now bypasses the lookup entirely. There
-- is nothing to migrate.
drop table public.role_permissions;

create table public.role_permissions (
  role_id         uuid not null references public.roles (id) on delete cascade,
  permission_code text not null references public.permissions (code) on delete cascade,
  primary key (role_id, permission_code)
);

comment on table public.role_permissions is 'What a role may do. Written only by the role RPCs in 0017.';

create index role_permissions_code_idx on public.role_permissions (permission_code);

-- A permission is born beside the feature it guards. This block guards role
-- administration; Block 2 inserts its inventory.* codes in its own migration
-- and they appear in the editor without it being touched.
insert into public.permissions (code, description, introduced_by_block, module, label, scope, display_order)
values ('roles.manage', 'Create, edit and delete the Organization''s roles', '1c',
        'organization', 'Administer roles', 'organization', 40);

-- CORRECTION, made while executing this task. Dropping role_permissions above
-- leaves has_permission (0010) joining a column that no longer exists, and it
-- breaks the moment anything calls it — the plan originally deferred the helper
-- rewrite to Task 2, which would have left the database inconsistent between two
-- migrations. This transitional definition holds the line until 0016 resolves
-- permissions through the role. `exists` rather than a scalar subquery, because
-- a scalar subquery yields NULL with no matching row, and `if not NULL then
-- raise` never fires — the wrong failure mode for a function whose job is to
-- fail closed. operator and viewer get nothing here, exactly as in Block 1b.
create or replace function public.has_permission(p_permission text, p_company_id uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select exists (select 1 from public.permissions p where p.code = p_permission)
     and public.has_company_access(p_company_id)
     and (
       public.is_platform_admin()
       or exists (
         select 1
         from public.company_memberships cm
         where cm.user_id = auth.uid()
           and cm.company_id = p_company_id
           and cm.deleted_at is null
           and cm.role = 'owner'
       )
     );
$$;

comment on function public.has_permission(text, uuid) is
  'Transitional: valid code AND active subscription AND the caller is the Company owner. 0016 replaces this with resolution through the assigned role.';

-- Same wound, same migration: 0010's has_org_permission joins role_permissions on
-- a column this migration dropped, and `language sql` means it errors at plan time
-- on any call — taking create_invitation, member management and two Block 1b RLS
-- policies with it. Block 1b seeded these three codes to the owner alone, so
-- admin-or-owner is exactly what the old join resolved to.
create or replace function public.has_org_permission(p_permission text, p_organization_id uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select exists (select 1 from public.permissions p where p.code = p_permission)
     and (public.is_platform_admin() or public.is_owner(p_organization_id));
$$;

comment on function public.has_org_permission(text, uuid) is
  'Transitional: valid permission code AND (platform admin OR Organization owner). 0016 replaces this with resolution through the assigned role.';
```

- [ ] **Step 2: Update the pgTAP assertions**

In `supabase/tests/02_permissions.test.sql`:

**Remove** the four assertions that read `role_permissions.role = 'owner' | 'operator' | 'viewer'`. That column no longer exists, so they cannot run. **Keep everything else**, in particular this one, which must survive untouched:

```sql
-- Fail closed, with no session in play.
select is(public.has_permission('no.such.code', gen_random_uuid()), false,
          'an unknown permission code returns false');
```

It guards the trap Block 1b documented — the existence check sitting outside the bypass — and it is a named row in this block's definition of done. It passes against the transitional function above, because `exists(...)` is false for an unknown code and nothing reaches the role tables.

**Then append** the following, and set the plan count on line 2 to whatever the file actually contains, confirmed against the runner rather than by arithmetic:

```sql
-- The catalogue's own seed, in the new model. Replaces the four fixed-role
-- assertions removed above: the same claim — that the seed is asserted and not
-- assumed — stated against the structure that now exists.
select is(
  (select introduced_by_block from public.permissions where code = 'roles.manage'),
  '1c',
  'roles.manage is seeded by this block'
);

select has_column('public', 'role_permissions', 'role_id', 'role_permissions is keyed by role');
select hasnt_column('public', 'role_permissions', 'role', 'the fixed-role column is gone');

-- The same guarantee for the Organization-scoped helper. It doubles as a canary:
-- these helpers are `language sql`, so a body referencing a dropped column errors
-- at plan time — calling it at all is what proves it still resolves. Without this,
-- a migration can orphan a helper and every existing test still passes.
select is(public.has_org_permission('no.such.code', gen_random_uuid()), false,
          'an unknown Organization-scoped permission code returns false');

-- Block 1c: the catalogue carries what the editor needs to render itself.
select col_not_null('public', 'permissions', 'module', 'module is required');
select col_not_null('public', 'permissions', 'label',  'label is required');
select col_not_null('public', 'permissions', 'scope',  'scope is required');

select is(
  (select scope::text from public.permissions where code = 'roles.manage'),
  'organization',
  'roles.manage reaches the whole Organization'
);

select has_table('public', 'roles', 'roles exists');

-- Two live roles of the same name in one Organization is a mistake; the same
-- name after archiving one is not.
select has_index('public', 'roles', 'roles_name_unique', 'role names are unique per Organization while live');
```

- [ ] **Step 3: Run the database suite and watch it fail before the migration is applied**

Run: `npx supabase db reset && npx supabase test db`
Expected: the new assertions fail with `relation "public.roles" does not exist` if the migration file is absent. With the migration in place, all pass — including the fail-closed assertion, which must appear in the output.

- [ ] **Step 4: Run the database suite green**

Run: `npx supabase db reset && npx supabase test db`
Expected: every file passes, including `00_smoke`, `01_identity` and `02_permissions`.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/0015_roles.sql supabase/tests/02_permissions.test.sql
git commit -m "feat(db): add roles and give the permission catalogue a module and scope"
```

---

### Task 2: Memberships move to roles, and the helpers follow

**Files:**
- Create: `supabase/migrations/0016_memberships.sql`
- Modify: `supabase/tests/01_identity.test.sql`

**Interfaces:**
- Consumes: `public.roles`, `roles_id_org_unique`, `companies_id_org_unique` (Task 1).
- Produces: type `public.org_role ('owner','member')`; `company_memberships.organization_id`, `company_memberships.role_id` (both `not null`); rewritten `public.has_company_access(uuid)`, `public.has_permission(text, uuid)`, `public.has_org_permission(text, uuid)`; `provision_customer` no longer writing a Company membership for the owner.

- [ ] **Step 1: Write the migration**

```sql
-- supabase/migrations/0016_memberships.sql

-- operator and viewer were shorthands for permission sets that are now roles.
-- Only owner still carries meaning at Organization level.
create type public.org_role as enum ('owner', 'member');

alter table public.organization_memberships add column role_new public.org_role;

update public.organization_memberships
   set role_new = case when role = 'owner' then 'owner'::public.org_role
                       else 'member'::public.org_role end;

alter table public.organization_memberships alter column role_new set not null;

-- The last-owner trigger is dropped and recreated around the swap. Its body
-- reads `role`, and leaving it attached through a drop-and-rename is asking for
-- a fire against a column that momentarily does not exist.
drop trigger organization_memberships_keep_owner on public.organization_memberships;
alter table public.organization_memberships drop column role;
alter table public.organization_memberships rename column role_new to role;

create constraint trigger organization_memberships_keep_owner
after update or delete on public.organization_memberships
deferrable initially deferred
for each row execute function public.enforce_last_owner();

-- The owner holds Company powers by ownership. Keeping their membership row
-- would make them the only user in the system obliged to carry a role in order
-- to exercise powers they already have.
-- `om.deleted_at is null` is load-bearing, and every other owner test in the
-- schema has it (is_owner, enforce_last_owner, organization_memberships_select).
-- Without it, someone whose owner membership was soft-deleted by remove_member
-- and who was later re-added as an operator has their LIVE Company membership
-- hard-deleted here — silent access loss, no soft-delete trace, in a one-shot
-- migration with no reverse.
delete from public.company_memberships cm
 using public.companies c, public.organization_memberships om
 where c.id = cm.company_id
   and om.organization_id = c.organization_id
   and om.user_id = cm.user_id
   and om.role = 'owner'
   and om.deleted_at is null;

alter table public.company_memberships add column organization_id uuid;

update public.company_memberships cm
   set organization_id = c.organization_id
  from public.companies c
 where c.id = cm.company_id;

alter table public.company_memberships alter column organization_id set not null;

comment on column public.company_memberships.organization_id is
  'Denormalised from the Company. It exists to carry the composite foreign keys below, which is what makes a role of another Organization unassignable. Not redundant — do not drop it.';

-- Every surviving row is a non-owner membership, and Block 1b granted operator
-- and viewer no permissions at all. Recreating that as an empty role is not a
-- downgrade: it is the same power, now a row the owner can see and edit.
-- Soft-deleted rows are included, because the column below is NOT NULL and a
-- historical row still has to point somewhere.
insert into public.roles (organization_id, name, description)
select distinct cm.organization_id,
       initcap(cm.role::text),
       'Created when Block 1c replaced fixed roles. Holds no permissions, exactly as this role did before.'
  from public.company_memberships cm
on conflict do nothing;

alter table public.company_memberships add column role_id uuid;

update public.company_memberships cm
   set role_id = r.id
  from public.roles r
 where r.organization_id = cm.organization_id
   and lower(r.name) = lower(cm.role::text)
   and r.deleted_at is null;

alter table public.company_memberships alter column role_id set not null;
alter table public.company_memberships drop column role;

-- One role per user per Company needs no rule of its own: it is one column, so
-- a second value cannot exist. What does need stating is that the Company and
-- the role belong to the SAME Organization — two composite foreign keys sharing
-- organization_id say it declaratively.
alter table public.company_memberships
  add constraint company_memberships_company_org_fk
    foreign key (company_id, organization_id)
    references public.companies (id, organization_id),
  add constraint company_memberships_role_org_fk
    foreign key (role_id, organization_id)
    references public.roles (id, organization_id);

create index company_memberships_role_idx
  on public.company_memberships (role_id)
  where deleted_at is null;

create index company_memberships_org_idx
  on public.company_memberships (organization_id)
  where deleted_at is null;

-- ---------------------------------------------------------------------------
-- The three helpers. They move in this migration and not a later one because
-- has_permission's body reads the column just dropped; splitting them would
-- leave the database inconsistent between two migrations.
-- ---------------------------------------------------------------------------

create or replace function public.has_company_access(p_company_id uuid)
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
        public.is_platform_admin()
        or public.is_owner(c.organization_id)
        or exists (
          select 1 from public.company_memberships cm
          where cm.user_id = auth.uid()
            and cm.company_id = c.id
            and cm.deleted_at is null
        )
      )
  );
$$;

comment on function public.has_company_access(uuid) is
  'Active subscription AND (platform admin OR owner of the Organization OR a live membership). The owner holds no membership row by design.';

-- The existence check stays OUTSIDE every bypass. Written the obvious way,
-- `is_platform_admin() or exists(...)` short-circuits before permission_code is
-- ever compared, and a typo would return true for an admin on any Company
-- (Block 1b §3).
create or replace function public.has_permission(p_permission text, p_company_id uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select exists (select 1 from public.permissions p where p.code = p_permission)
     and public.has_company_access(p_company_id)
     and (
       public.is_platform_admin()
       or exists (
         select 1 from public.companies c
         where c.id = p_company_id and public.is_owner(c.organization_id)
       )
       or exists (
         select 1
         from public.company_memberships cm
         join public.role_permissions rp on rp.role_id = cm.role_id
         where cm.user_id = auth.uid()
           and cm.company_id = p_company_id
           and cm.deleted_at is null
           and rp.permission_code = p_permission
       )
     );
$$;

comment on function public.has_permission(text, uuid) is
  'Valid code AND active subscription AND (admin OR owner OR the role assigned in THAT Company grants it).';

-- Organization-scoped codes are held through a role in any Company, so this
-- searches every Company of the Organization. The active-subscription term is
-- what stops a lapsed customer from still inviting users and reading the audit
-- trail through a role in a suspended Station.
create or replace function public.has_org_permission(p_permission text, p_organization_id uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select exists (select 1 from public.permissions p where p.code = p_permission)
     and (
       public.is_platform_admin()
       or (
         -- The owner's bypass carries the same subscription gate as the role
         -- path. Without it the two helpers disagree: has_permission runs the
         -- owner through has_company_access and yields nothing on a suspended
         -- Station, while this one would keep granting users.invite, audit.view
         -- and roles.manage to an owner whose only Station is suspended. The
         -- spec says a suspended Company grants nothing, full stop — a lapsed
         -- customer is frozen, and reactivation is the platform admin's job.
         public.is_owner(p_organization_id)
         and exists (
           select 1 from public.companies c
           where c.organization_id = p_organization_id
             and c.status = 'active'
             and c.deleted_at is null
         )
       )
       or exists (
         select 1
         from public.company_memberships cm
         join public.companies c          on c.id = cm.company_id
         join public.role_permissions rp  on rp.role_id = cm.role_id
         where cm.user_id = auth.uid()
           and cm.organization_id = p_organization_id
           and cm.deleted_at is null
           and c.status = 'active'
           and c.deleted_at is null
           and rp.permission_code = p_permission
       )
     );
$$;

comment on function public.has_org_permission(text, uuid) is
  'Valid code AND (admin OR owner OR a role in any ACTIVE Company of the Organization grants it).';

-- provision_customer stops writing the owner's Company membership. Everything
-- else in it is unchanged; it is repeated in full because CREATE OR REPLACE
-- takes the whole body.
create or replace function public.provision_customer(
  p_user_id           uuid,
  p_organization_name text,
  p_company_name      text,
  p_timezone          text default 'America/Sao_Paulo'
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor uuid := auth.uid();
  v_org   uuid;
  v_comp  uuid;
begin
  if not public.is_platform_admin() then
    raise log 'provision_customer denied: actor=% target_user=%', v_actor, p_user_id;
    raise exception 'permission denied: platform admin required' using errcode = '42501';
  end if;

  if coalesce(trim(p_organization_name), '') = '' then
    raise exception 'organization name is required' using errcode = '22023';
  end if;
  if coalesce(trim(p_company_name), '') = '' then
    raise exception 'company name is required' using errcode = '22023';
  end if;

  insert into public.organizations (name)
  values (trim(p_organization_name))
  returning id into v_org;

  insert into public.companies (organization_id, name, timezone, provisioned_by)
  values (v_org, trim(p_company_name), p_timezone, v_actor)
  returning id into v_comp;

  insert into public.organization_memberships (user_id, organization_id, role)
  values (p_user_id, v_org, 'owner');

  update public.profiles
     set must_change_password   = true,
         provisional_expires_at = now() + interval '7 days',
         updated_at             = now()
   where id = p_user_id;

  -- Load-bearing: without it the function returns success for a user with no
  -- profile row, having created the Organization, the Company, the owner
  -- membership and the audit entry, while the provisional-password gate that
  -- 0009 exists to enforce is silently never set.
  if not found then
    raise exception 'profile not found for user %', p_user_id using errcode = 'P0002';
  end if;

  -- Byte-for-byte the audit row from 0007. audit_logs.company_id is a real
  -- column that other RPCs populate, so anything filtering the trail by Company
  -- would stop seeing provisioning if this moved into the JSON blob.
  insert into public.audit_logs
    (actor_id, action, target_table, target_id, organization_id, company_id, detail)
  values
    (v_actor, 'provision_customer', 'companies', v_comp, v_org, v_comp,
     jsonb_build_object('owner_user_id', p_user_id, 'organization_name', trim(p_organization_name)));

  return jsonb_build_object('organization_id', v_org, 'company_id', v_comp);
end;
$$;
```

Removing the owner's `company_memberships` insert is the **only** change to this function. Diff your rewrite against `0007_provisioning_rpc.sql` line by line before committing — a `create or replace` that quietly drops a guard or rewrites an audit row is invisible in review unless someone compares.

- [ ] **Step 2: Append the pgTAP assertions**

Append to `supabase/tests/01_identity.test.sql`, and change its first line from `select plan(21);` to `select plan(27);`.

```sql
-- Block 1c: a membership without a role is not representable.
select col_not_null('public', 'company_memberships', 'role_id',
  'a Company membership must carry a role');
select col_not_null('public', 'company_memberships', 'organization_id',
  'a Company membership carries its Organization, for the composite keys');

select has_index('public', 'company_memberships', 'company_memberships_role_idx',
  'live memberships are indexed by role, which delete_role reads');

-- The composite foreign keys are the whole cross-tenant guarantee.
select fk_ok('public', 'company_memberships', array['role_id', 'organization_id'],
             'public', 'roles', array['id', 'organization_id'],
             'a role can only be assigned inside its own Organization');
select fk_ok('public', 'company_memberships', array['company_id', 'organization_id'],
             'public', 'companies', array['id', 'organization_id'],
             'a membership can only name a Company of its own Organization');

-- Declaring the constraint and having it bite are different claims. This is the
-- one that matters, so it is asserted rather than reasoned about.
--
-- The user must be REAL. company_memberships.user_id references auth.users, and
-- that constraint is older, so a random uuid trips it first — also SQLSTATE
-- 23503, which means a throws_ok matching on the code alone goes green whether
-- or not the composite key exists at all. Pinning the message is what makes this
-- assertion mean what it says.
insert into public.organizations (id, name) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'Org A'),
  ('aaaaaaaa-0000-0000-0000-000000000002', 'Org B');
insert into public.companies (id, organization_id, name) values
  ('bbbbbbbb-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001', 'Station A');
insert into public.roles (id, organization_id, name) values
  ('cccccccc-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000002', 'Foreign');

insert into auth.users (id, email)
values ('dddddddd-0000-0000-0000-000000000001', 'fk-probe@example.test');

select throws_ok(
  $$insert into public.company_memberships (user_id, company_id, organization_id, role_id)
    values ('dddddddd-0000-0000-0000-000000000001',
            'bbbbbbbb-0000-0000-0000-000000000001',
            'aaaaaaaa-0000-0000-0000-000000000001',
            'cccccccc-0000-0000-0000-000000000001')$$,
  '23503',
  'insert or update on table "company_memberships" violates foreign key constraint "company_memberships_role_org_fk"',
  'a role from another Organization cannot be assigned'
);

select has_index('public', 'company_memberships', 'company_memberships_org_idx',
  'live memberships are indexed by Organization, which has_org_permission reads');
```

If a bare `insert into auth.users (id, email)` will not go in — that table is Supabase's and its NOT NULL set moves between versions — determine the minimum columns empirically and use them. If it proves impractical inside pgTAP, **do not leave the weaker assertion in place**: delete it, say so in the report, and the proof moves to the isolation suite in Task 8, where real users exist through the Admin API. A false green on this particular claim is worse than an honest gap.

- [ ] **Step 3: Run the database suite and read the failure**

Run: `npx supabase db reset && npx supabase test db`
Expected before the migration exists: `column "role_id" does not exist`. After it: green.

- [ ] **Step 4: Confirm the cross-Organization rejection actually fired**

Run: `npx supabase db reset && npx supabase test db`
Expected: green, and the line `ok … a role from another Organization cannot be assigned` present in the output. Copy that line verbatim into the task's report to the reviewer. If that assertion is missing or fails, the composite keys are wrong and nothing else in this block is trustworthy — stop and fix `0016` before continuing.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/0016_memberships.sql supabase/tests/01_identity.test.sql
git commit -m "feat(db): make the Company membership carry a role, and resolve permissions through it"
```

---

### Task 3: The role and membership RPCs

**Files:**
- Create: `supabase/migrations/0017_role_rpcs.sql`

**Interfaces:**
- Consumes: `public.roles`, `public.role_permissions`, `public.has_org_permission`, `public.org_role` (Tasks 1–2).
- Produces: `create_role(uuid, text, text, text[]) returns uuid`, `update_role(uuid, text, text, text[]) returns void`, `delete_role(uuid) returns void`, `assign_company_role(uuid, uuid, uuid) returns uuid`, `remove_company_access(uuid, uuid) returns void`, `change_org_role(uuid, public.org_role) returns void`, `add_company(uuid, text, text) returns uuid`. `change_member_role(uuid, public.member_role)` is dropped.

- [ ] **Step 1: Write the migration**

```sql
-- supabase/migrations/0017_role_rpcs.sql

-- Shared shape: re-check the caller here, because SECURITY DEFINER bypasses RLS;
-- RAISE LOG on denial, because an audit INSERT followed by RAISE never commits.
--
-- roles.manage and users.manage are Organization-scoped. The two functions that
-- take a company_id resolve ITS Organization first and check against that —
-- never against an Organization id the caller supplied.

create or replace function public.create_role(
  p_organization_id uuid,
  p_name            text,
  p_description     text default null,
  p_permission_codes text[] default '{}'
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor   uuid := auth.uid();
  v_name    text := nullif(trim(p_name), '');
  v_id      uuid;
  v_unknown text;
begin
  if not public.has_org_permission('roles.manage', p_organization_id) then
    raise log 'create_role denied: actor=% org=%', v_actor, p_organization_id;
    raise exception 'permission denied: roles.manage required' using errcode = '42501';
  end if;

  if v_name is null then
    raise exception 'role name is required' using errcode = '22023';
  end if;

  -- Refusing an unknown code rather than skipping it: silently dropping one
  -- yields a role weaker than the screen showed, and nobody finds out until
  -- someone cannot do their job.
  select code into v_unknown
  from unnest(coalesce(p_permission_codes, '{}')) as code
  where not exists (select 1 from public.permissions p where p.code = code)
  limit 1;

  if v_unknown is not null then
    raise exception 'unknown permission code: %', v_unknown using errcode = '22023';
  end if;

  insert into public.roles (organization_id, name, description, created_by)
  values (p_organization_id, v_name, nullif(trim(coalesce(p_description, '')), ''), v_actor)
  returning id into v_id;

  insert into public.role_permissions (role_id, permission_code)
  select v_id, code from unnest(coalesce(p_permission_codes, '{}')) as code;

  insert into public.audit_logs
    (actor_id, action, target_table, target_id, organization_id, detail)
  values
    (v_actor, 'create_role', 'roles', v_id, p_organization_id,
     jsonb_build_object('name', v_name, 'permissions', to_jsonb(coalesce(p_permission_codes, '{}'))));

  return v_id;
end;
$$;

create or replace function public.update_role(
  p_role_id          uuid,
  p_name             text,
  p_description      text default null,
  p_permission_codes text[] default '{}'
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor   uuid := auth.uid();
  v_org     uuid;
  v_name    text := nullif(trim(p_name), '');
  v_before  jsonb;
  v_unknown text;
begin
  select organization_id into v_org
  from public.roles
  where id = p_role_id and deleted_at is null;

  if not found then
    raise exception 'role not found: %', p_role_id using errcode = 'P0002';
  end if;

  if not public.has_org_permission('roles.manage', v_org) then
    raise log 'update_role denied: actor=% role=%', v_actor, p_role_id;
    raise exception 'permission denied: roles.manage required' using errcode = '42501';
  end if;

  if v_name is null then
    raise exception 'role name is required' using errcode = '22023';
  end if;

  select code into v_unknown
  from unnest(coalesce(p_permission_codes, '{}')) as code
  where not exists (select 1 from public.permissions p where p.code = code)
  limit 1;

  if v_unknown is not null then
    raise exception 'unknown permission code: %', v_unknown using errcode = '22023';
  end if;

  select coalesce(jsonb_agg(permission_code order by permission_code), '[]'::jsonb)
    into v_before
  from public.role_permissions where role_id = p_role_id;

  update public.roles
     set name        = v_name,
         description = nullif(trim(coalesce(p_description, '')), ''),
         updated_at  = now()
   where id = p_role_id;

  -- Replace the set wholesale. A diff would be the same result with more ways
  -- to be wrong, and this runs inside one transaction.
  delete from public.role_permissions where role_id = p_role_id;
  insert into public.role_permissions (role_id, permission_code)
  select p_role_id, code from unnest(coalesce(p_permission_codes, '{}')) as code;

  insert into public.audit_logs
    (actor_id, action, target_table, target_id, organization_id, detail)
  values
    (v_actor, 'update_role', 'roles', p_role_id, v_org,
     jsonb_build_object('name', v_name, 'before', v_before,
                        'after', to_jsonb(coalesce(p_permission_codes, '{}'))));
end;
$$;

create or replace function public.delete_role(p_role_id uuid)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor  uuid := auth.uid();
  v_org    uuid;
  v_in_use integer;
begin
  select organization_id into v_org
  from public.roles
  where id = p_role_id and deleted_at is null;

  if not found then
    raise exception 'role not found: %', p_role_id using errcode = 'P0002';
  end if;

  if not public.has_org_permission('roles.manage', v_org) then
    raise log 'delete_role denied: actor=% role=%', v_actor, p_role_id;
    raise exception 'permission denied: roles.manage required' using errcode = '42501';
  end if;

  select count(*) into v_in_use
  from public.company_memberships
  where role_id = p_role_id and deleted_at is null;

  -- Reassign first. Archiving a role in use would leave people with no powers
  -- and nothing on screen to explain why.
  if v_in_use > 0 then
    raise exception 'role is assigned to % user(s); reassign them first', v_in_use
      using errcode = '23503';
  end if;

  update public.roles set deleted_at = now(), updated_at = now() where id = p_role_id;

  insert into public.audit_logs
    (actor_id, action, target_table, target_id, organization_id)
  values (v_actor, 'delete_role', 'roles', p_role_id, v_org);
end;
$$;

-- Creates the membership or moves it to another role. The composite foreign
-- keys reject a role from another Organization even if this body were wrong.
create or replace function public.assign_company_role(
  p_company_id uuid,
  p_user_id    uuid,
  p_role_id    uuid
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor uuid := auth.uid();
  v_org   uuid;
  v_id    uuid;
begin
  select organization_id into v_org
  from public.companies
  where id = p_company_id and deleted_at is null;

  if not found then
    raise exception 'company not found: %', p_company_id using errcode = 'P0002';
  end if;

  if not public.has_org_permission('users.manage', v_org) then
    raise log 'assign_company_role denied: actor=% company=%', v_actor, p_company_id;
    raise exception 'permission denied: users.manage required' using errcode = '42501';
  end if;

  if not exists (
    select 1 from public.organization_memberships
    where user_id = p_user_id and organization_id = v_org and deleted_at is null
  ) then
    raise exception 'that user does not belong to this organization' using errcode = '23503';
  end if;

  -- The owner is recognised by ownership and holds no membership row. Creating
  -- one would put them under a role, which is exactly what §4.6 removed.
  if exists (
    select 1 from public.organization_memberships
    where user_id = p_user_id and organization_id = v_org
      and role = 'owner' and deleted_at is null
  ) then
    raise exception 'the owner already has full access and takes no role' using errcode = '22023';
  end if;

  update public.company_memberships
     set role_id = p_role_id, updated_at = now()
   where user_id = p_user_id and company_id = p_company_id and deleted_at is null
  returning id into v_id;

  if v_id is null then
    insert into public.company_memberships (user_id, company_id, organization_id, role_id)
    values (p_user_id, p_company_id, v_org, p_role_id)
    returning id into v_id;
  end if;

  insert into public.audit_logs
    (actor_id, action, target_table, target_id, organization_id, detail)
  values
    (v_actor, 'assign_company_role', 'company_memberships', v_id, v_org,
     jsonb_build_object('user_id', p_user_id, 'company_id', p_company_id, 'role_id', p_role_id));

  return v_id;
end;
$$;

create or replace function public.remove_company_access(p_company_id uuid, p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor uuid := auth.uid();
  v_org   uuid;
begin
  select organization_id into v_org
  from public.companies
  where id = p_company_id and deleted_at is null;

  if not found then
    raise exception 'company not found: %', p_company_id using errcode = 'P0002';
  end if;

  if not public.has_org_permission('users.manage', v_org) then
    raise log 'remove_company_access denied: actor=% company=%', v_actor, p_company_id;
    raise exception 'permission denied: users.manage required' using errcode = '42501';
  end if;

  -- Soft delete, and it cuts immediately: the helpers query this table on every
  -- check, so the next request from an open session already fails.
  update public.company_memberships
     set deleted_at = now(), updated_at = now()
   where user_id = p_user_id and company_id = p_company_id and deleted_at is null;

  insert into public.audit_logs
    (actor_id, action, target_table, target_id, organization_id, detail)
  values
    (v_actor, 'remove_company_access', 'company_memberships', null, v_org,
     jsonb_build_object('user_id', p_user_id, 'company_id', p_company_id));
end;
$$;

-- Replaces change_member_role. It no longer propagates anything to
-- company_memberships: Company powers are the role's business now.
drop function if exists public.change_member_role(uuid, public.member_role);

create or replace function public.change_org_role(
  p_membership_id uuid,
  p_new_role      public.org_role
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor    uuid := auth.uid();
  v_org      uuid;
  v_user     uuid;
  v_old_role public.org_role;
begin
  select om.organization_id, om.user_id, om.role
    into v_org, v_user, v_old_role
  from public.organization_memberships om
  where om.id = p_membership_id and om.deleted_at is null;

  if not found then
    raise exception 'membership not found: %', p_membership_id using errcode = 'P0002';
  end if;

  if not public.has_org_permission('users.manage', v_org) then
    raise log 'change_org_role denied: actor=% membership=%', v_actor, p_membership_id;
    raise exception 'permission denied: users.manage required' using errcode = '42501';
  end if;

  update public.organization_memberships
     set role = p_new_role, updated_at = now()
   where id = p_membership_id;

  -- Promoting to owner removes the Company memberships: an owner reaches every
  -- Company by ownership and must not also sit under a role.
  if p_new_role = 'owner' then
    update public.company_memberships
       set deleted_at = now(), updated_at = now()
     where user_id = v_user and organization_id = v_org and deleted_at is null;
  end if;

  insert into public.audit_logs
    (actor_id, action, target_table, target_id, organization_id, detail)
  values
    (v_actor, 'change_org_role', 'organization_memberships', p_membership_id, v_org,
     jsonb_build_object('user_id', v_user, 'from', v_old_role, 'to', p_new_role));
end;
$$;

-- Per-Company roles cannot be exercised against an Organization that can only
-- ever hold one Company. The self-service lifecycle stays in Block 10.
create or replace function public.add_company(
  p_organization_id uuid,
  p_name            text,
  p_timezone        text default 'America/Sao_Paulo'
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor uuid := auth.uid();
  v_id    uuid;
begin
  if not public.is_platform_admin() then
    raise log 'add_company denied: actor=% org=%', v_actor, p_organization_id;
    raise exception 'permission denied: platform admin required' using errcode = '42501';
  end if;

  if coalesce(trim(p_name), '') = '' then
    raise exception 'company name is required' using errcode = '22023';
  end if;

  if not exists (select 1 from public.organizations where id = p_organization_id and deleted_at is null) then
    raise exception 'organization not found: %', p_organization_id using errcode = 'P0002';
  end if;

  insert into public.companies (organization_id, name, timezone, provisioned_by)
  values (p_organization_id, trim(p_name), p_timezone, v_actor)
  returning id into v_id;

  insert into public.audit_logs
    (actor_id, action, target_table, target_id, organization_id, detail)
  values
    (v_actor, 'add_company', 'companies', v_id, p_organization_id,
     jsonb_build_object('name', trim(p_name)));

  return v_id;
end;
$$;

revoke execute on function public.create_role(uuid, text, text, text[])          from public;
revoke execute on function public.update_role(uuid, text, text, text[])          from public;
revoke execute on function public.delete_role(uuid)                              from public;
revoke execute on function public.assign_company_role(uuid, uuid, uuid)          from public;
revoke execute on function public.remove_company_access(uuid, uuid)              from public;
revoke execute on function public.change_org_role(uuid, public.org_role)         from public;
revoke execute on function public.add_company(uuid, text, text)                  from public;

grant execute on function public.create_role(uuid, text, text, text[])           to authenticated;
grant execute on function public.update_role(uuid, text, text, text[])           to authenticated;
grant execute on function public.delete_role(uuid)                               to authenticated;
grant execute on function public.assign_company_role(uuid, uuid, uuid)           to authenticated;
grant execute on function public.remove_company_access(uuid, uuid)               to authenticated;
grant execute on function public.change_org_role(uuid, public.org_role)          to authenticated;
grant execute on function public.add_company(uuid, text, text)                   to authenticated;
```

- [ ] **Step 2: Run the database suite**

Run: `npx supabase db reset && npx supabase test db`
Expected: green. The RPCs have no pgTAP coverage of their own — they are exercised under real JWTs in Task 8, which is the only way to prove a `SECURITY DEFINER` permission check actually holds.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/0017_role_rpcs.sql
git commit -m "feat(db): add the role lifecycle and per-Company assignment RPCs"
```

---

### Task 4: Invitations carry a role and a set of Companies

**Files:**
- Create: `supabase/migrations/0018_invitations_1c.sql`
- Modify: `supabase/tests/01_identity.test.sql`

**Interfaces:**
- Consumes: `public.roles`, `public.org_role` (Tasks 1–2).
- Produces: `invitations.is_owner`, `invitations.role_id`, table `public.invitation_companies (invitation_id, company_id)`; `create_invitation(uuid, text, boolean, uuid, uuid[], text, integer) returns uuid`; `validate_invitation(text) returns jsonb` unchanged in shape; `accept_invitation(text, uuid, text) returns jsonb`. Type `public.member_role` is dropped.

- [ ] **Step 1: Write the migration**

```sql
-- supabase/migrations/0018_invitations_1c.sql

alter table public.invitations
  add column is_owner boolean not null default false,
  add column role_id  uuid references public.roles (id);

create table public.invitation_companies (
  invitation_id uuid not null references public.invitations (id) on delete cascade,
  company_id    uuid not null references public.companies (id),
  primary key (invitation_id, company_id)
);

comment on table public.invitation_companies is
  'Which Stations the invitee is attached to on acceptance. Empty for an owner invitation.';

-- Pending invitations written under the fixed-role model are mapped the same way
-- memberships were in 0016: owner becomes an owner invitation, anything else
-- gets the Organization's like-named role, created if this is the first sighting.
insert into public.roles (organization_id, name, description)
select distinct i.organization_id, initcap(i.role::text),
       'Created when Block 1c replaced fixed roles. Holds no permissions, exactly as this role did before.'
  from public.invitations i
 where i.status = 'pending' and i.role <> 'owner'
on conflict do nothing;

update public.invitations i
   set is_owner = true
 where i.status = 'pending' and i.role = 'owner';

update public.invitations i
   set role_id = r.id
  from public.roles r
 where i.status = 'pending'
   and i.role <> 'owner'
   and r.organization_id = i.organization_id
   and lower(r.name) = lower(i.role::text)
   and r.deleted_at is null;

insert into public.invitation_companies (invitation_id, company_id)
select i.id, c.id
  from public.invitations i
  join public.companies c on c.organization_id = i.organization_id and c.deleted_at is null
 where i.status = 'pending' and i.role <> 'owner'
on conflict do nothing;

alter table public.invitations drop column role;

-- An invitation is either for an owner, who takes no role, or for a member, who
-- must take one. Nothing in between is representable.
alter table public.invitations
  add constraint invitations_role_shape
  check ((is_owner and role_id is null) or (not is_owner and role_id is not null));

drop type public.member_role;

create index invitation_companies_company_idx on public.invitation_companies (company_id);

-- ---------------------------------------------------------------------------
-- The three invitation functions, rewritten. Their signatures change, so the
-- old ones are dropped rather than replaced.
-- ---------------------------------------------------------------------------

drop function if exists public.create_invitation(uuid, text, public.member_role, text, integer);

create or replace function public.create_invitation(
  p_organization_id uuid,
  p_email           text,
  p_is_owner        boolean,
  p_role_id         uuid,
  p_company_ids     uuid[],
  p_token_hash      text,
  p_ttl_days        integer default 7
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor uuid := auth.uid();
  v_email text := lower(trim(p_email));
  v_id    uuid;
  v_count integer;
begin
  if not public.has_org_permission('users.invite', p_organization_id) then
    raise log 'create_invitation denied: actor=% org=%', v_actor, p_organization_id;
    raise exception 'permission denied: users.invite required' using errcode = '42501';
  end if;

  if coalesce(v_email, '') = '' then
    raise exception 'email is required' using errcode = '22023';
  end if;

  -- A person belongs to one Organization. Refusing here keeps the acceptance
  -- page single-path: it always creates an account. Offering to set a password
  -- for an existing account from an emailed link is account takeover.
  if exists (select 1 from auth.users u where lower(u.email) = v_email) then
    raise exception 'this e-mail already has an account on the platform' using errcode = '23505';
  end if;

  if not p_is_owner then
    if p_role_id is null then
      raise exception 'a member invitation must name a role' using errcode = '22023';
    end if;

    if not exists (
      select 1 from public.roles
      where id = p_role_id and organization_id = p_organization_id and deleted_at is null
    ) then
      raise exception 'that role does not belong to this organization' using errcode = '23503';
    end if;

    select count(*) into v_count
    from unnest(coalesce(p_company_ids, '{}')) as cid
    join public.companies c on c.id = cid
    where c.organization_id = p_organization_id and c.deleted_at is null;

    if v_count = 0 or v_count <> coalesce(array_length(p_company_ids, 1), 0) then
      raise exception 'name at least one Station, all of them in this organization'
        using errcode = '22023';
    end if;
  end if;

  insert into public.invitations
    (organization_id, email, is_owner, role_id, token_hash, expires_at, invited_by)
  values
    (p_organization_id, v_email, p_is_owner,
     case when p_is_owner then null else p_role_id end,
     p_token_hash, now() + make_interval(days => p_ttl_days), v_actor)
  returning id into v_id;

  if not p_is_owner then
    insert into public.invitation_companies (invitation_id, company_id)
    select v_id, cid from unnest(p_company_ids) as cid;
  end if;

  insert into public.audit_logs
    (actor_id, action, target_table, target_id, organization_id, detail)
  values
    (v_actor, 'create_invitation', 'invitations', v_id, p_organization_id,
     jsonb_build_object('email', v_email, 'is_owner', p_is_owner, 'role_id', p_role_id));

  return v_id;
end;
$$;

-- Returns only what the acceptance page renders. Every failure — unknown,
-- revoked, accepted, expired — raises the SAME message.
create or replace function public.validate_invitation(p_token_hash text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_inv  public.invitations;
  v_name text;
  v_role text;
begin
  select * into v_inv
  from public.invitations
  where token_hash = p_token_hash and status = 'pending' and expires_at > now();

  if not found then
    raise exception 'invalid or expired invitation' using errcode = '42501';
  end if;

  select name into v_name from public.organizations where id = v_inv.organization_id;
  select name into v_role from public.roles where id = v_inv.role_id;

  return jsonb_build_object(
    'invitation_id',     v_inv.id,
    'organization_id',   v_inv.organization_id,
    'organization_name', v_name,
    'email',             v_inv.email,
    'is_owner',          v_inv.is_owner,
    'role_name',         coalesce(v_role, 'Owner')
  );
end;
$$;

create or replace function public.accept_invitation(
  p_token_hash text,
  p_user_id    uuid,
  p_full_name  text default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_inv public.invitations;
begin
  -- Re-validates rather than trusting what validate_invitation returned
  -- earlier, and takes a row lock, so two simultaneous accepts serialize and
  -- only the first wins. Single use is the database's guarantee.
  select * into v_inv
  from public.invitations
  where token_hash = p_token_hash and status = 'pending' and expires_at > now()
  for update;

  if not found then
    raise exception 'invalid or expired invitation' using errcode = '42501';
  end if;

  insert into public.profiles (id, email, full_name)
  values (p_user_id, v_inv.email, nullif(trim(coalesce(p_full_name, '')), ''))
  on conflict (id) do nothing;

  insert into public.organization_memberships (user_id, organization_id, role)
  values (p_user_id, v_inv.organization_id,
          case when v_inv.is_owner then 'owner'::public.org_role else 'member'::public.org_role end);

  -- An owner takes no Company membership: they reach every Station by ownership.
  if not v_inv.is_owner then
    insert into public.company_memberships (user_id, company_id, organization_id, role_id)
    select p_user_id, ic.company_id, v_inv.organization_id, v_inv.role_id
    from public.invitation_companies ic
    join public.companies c on c.id = ic.company_id and c.deleted_at is null
    where ic.invitation_id = v_inv.id;
  end if;

  update public.invitations
     set status = 'accepted', accepted_at = now(), accepted_by = p_user_id, updated_at = now()
   where id = v_inv.id and status = 'pending';

  if not found then
    raise exception 'invitation was already accepted' using errcode = '23505';
  end if;

  insert into public.audit_logs
    (actor_id, action, target_table, target_id, organization_id, detail)
  values
    (p_user_id, 'accept_invitation', 'invitations', v_inv.id, v_inv.organization_id,
     jsonb_build_object('is_owner', v_inv.is_owner, 'role_id', v_inv.role_id));

  return jsonb_build_object('organization_id', v_inv.organization_id);
end;
$$;

revoke execute on function public.create_invitation(uuid, text, boolean, uuid, uuid[], text, integer) from public;
grant  execute on function public.create_invitation(uuid, text, boolean, uuid, uuid[], text, integer) to authenticated;
revoke execute on function public.validate_invitation(text) from public;
revoke execute on function public.accept_invitation(text, uuid, text) from public;
grant  execute on function public.validate_invitation(text) to service_role;
grant  execute on function public.accept_invitation(text, uuid, text) to service_role;
```

- [ ] **Step 2: Assert the enum is really gone**

Append to `supabase/tests/01_identity.test.sql`, and change its plan from `select plan(27);` to `select plan(28);`.

```sql
-- If any column or function signature still held member_role, the DROP TYPE in
-- 0018 would have failed the migration — but a future CREATE could bring it
-- back, and a lingering enum beside org_role is exactly the ambiguity this
-- block removed.
select hasnt_type('public', 'member_role', 'the fixed-role enum is gone');
```

- [ ] **Step 3: Run the database suite**

Run: `npx supabase db reset && npx supabase test db`
Expected: green, 28 assertions in `01_identity`.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/0018_invitations_1c.sql
git commit -m "feat(db): make an invitation carry a role and the Stations it grants"
```

---

### Task 5: RLS and grants for the new tables

**Files:**
- Create: `supabase/migrations/0019_rls_1c.sql`

**Interfaces:**
- Consumes: `public.roles`, `public.role_permissions`, `public.invitation_companies`.
- Produces: policies `roles_select_org_member`, `role_permissions_select_org`, `invitation_companies_select_inviter`; `service_role` grants.

- [ ] **Step 1: Write the migration**

```sql
-- supabase/migrations/0019_rls_1c.sql

alter table public.roles                enable row level security;
alter table public.role_permissions     enable row level security;
alter table public.invitation_companies enable row level security;

revoke all on public.roles                from anon, authenticated;
revoke all on public.role_permissions     from anon, authenticated;
revoke all on public.invitation_companies from anon, authenticated;

-- A user must be able to see the name of the role they hold, and whoever holds
-- roles.manage needs the whole list. Neither table takes a write grant: every
-- write goes through the RPCs in 0017, which carry the audit entry with them.
grant select on public.roles            to authenticated;
grant select on public.role_permissions to authenticated;

create policy roles_select_org_member on public.roles
  for select to authenticated
  using (deleted_at is null and public.is_org_member(organization_id));

create policy role_permissions_select_org on public.role_permissions
  for select to authenticated
  using (
    exists (
      select 1 from public.roles r
      where r.id = role_id
        and r.deleted_at is null
        and public.is_org_member(r.organization_id)
    )
  );

-- Same narrowness as the invitations policy it accompanies: this table names
-- which Stations a third party was offered.
grant select on public.invitation_companies to authenticated;

create policy invitation_companies_select_inviter on public.invitation_companies
  for select to authenticated
  using (
    exists (
      select 1 from public.invitations i
      where i.id = invitation_id
        and public.has_org_permission('users.invite', i.organization_id)
    )
  );

-- service_role needs explicit grants: the default ACL gives it only Dxtm and
-- BYPASSRLS does not substitute for a GRANT (Block 1a §3.9). Read-only, because
-- every write to these tables belongs to a SECURITY DEFINER function.
grant select on public.roles                to service_role;
grant select on public.role_permissions     to service_role;
grant select on public.invitation_companies to service_role;
```

- [ ] **Step 2: Run the database suite**

Run: `npx supabase db reset && npx supabase test db`
Expected: green.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/0019_rls_1c.sql
git commit -m "feat(db): enable RLS on roles and invitation Stations"
```

---

### Task 6: Regenerate types and repair the compile

**Files:**
- Modify: `src/lib/supabase/database.types.ts` (generated)
- Modify: `src/app/(app)/team/actions.ts`
- Modify: `src/services/invitations.ts`
- Modify: `src/schemas/invitations.ts`
- Modify: `tests/isolation/harness.ts`

**Interfaces:**
- Consumes: every migration from Tasks 1–5.
- Produces: a compiling tree. `harness.addMemberByInvitation(customer, label, roleId, companyIds)` replaces the old `role` parameter.

- [ ] **Step 1: Regenerate the types**

Run: `npx supabase db reset && npm run db:types`

Do not format the result — `.prettierignore` already excludes it.

- [ ] **Step 2: Prove the generated types still bind**

The Block 1a report records a `@supabase/ssr` + `supabase-js` pairing where the generics landed in the wrong positions and `.from()` silently accepted any string — the whole tree type-checked while being unchecked. Re-run that probe:

Add this line temporarily inside `getShellContext` in `src/lib/auth/shell.ts`:

```ts
await supabase.from('no_such_table').select('*');
```

Run: `npm run typecheck`
Expected: **FAILS**, with an error naming `no_such_table`. Then remove the line and run it again, expecting a pass. If the first run succeeds, stop and report: the types are not binding and nothing below this step is actually type-checked.

- [ ] **Step 3: Update the schema for the new invitation shape**

```ts
// src/schemas/invitations.ts
import { z } from 'zod';

export const createInvitationSchema = z
  .object({
    organizationId: z.string().uuid(),
    email: z.string().email().max(320),
    isOwner: z.boolean(),
    roleId: z.string().uuid().nullable(),
    companyIds: z.array(z.string().uuid()),
  })
  // The database enforces this too. Stating it here turns a 22023 from Postgres
  // into a field-level message the form can render.
  .refine((v) => (v.isOwner ? v.roleId === null : v.roleId !== null), {
    message: 'Choose a role for this person.',
    path: ['roleId'],
  })
  .refine((v) => (v.isOwner ? true : v.companyIds.length > 0), {
    message: 'Choose at least one Station.',
    path: ['companyIds'],
  });

export type CreateInvitationInput = z.infer<typeof createInvitationSchema>;

export const acceptInvitationSchema = z.object({
  token: z.string().min(20),
  password: z.string().min(12).max(128),
  fullName: z.string().trim().max(120).optional(),
});

export type AcceptInvitationInput = z.infer<typeof acceptInvitationSchema>;
```

- [ ] **Step 4: Update `createInvitation` for the new RPC signature**

In `src/services/invitations.ts`, replace the `rpc('create_invitation', …)` argument object:

```ts
  const { data, error } = await asOwner.rpc('create_invitation', {
    p_organization_id: input.organizationId,
    p_email: input.email,
    p_is_owner: input.isOwner,
    p_role_id: input.roleId,
    p_company_ids: input.companyIds,
    p_token_hash: hashInvitationToken(token),
    p_ttl_days: 7,
  });
```

And widen `InvitationPreview` to the new payload:

```ts
export interface InvitationPreview {
  invitationId: string;
  organizationId: string;
  organizationName: string;
  email: string;
  isOwner: boolean;
  roleName: string;
}
```

updating the destructure in `validateInvitation` to read `is_owner` and `role_name`.

- [ ] **Step 5: Update the team actions**

In `src/app/(app)/team/actions.ts`, replace `changeRoleAction` and `removeMemberAction`:

```ts
export async function changeOrgRoleAction(formData: FormData): Promise<void> {
  const supabase = await createUserClient();
  const { error } = await supabase.rpc('change_org_role', {
    p_membership_id: String(formData.get('membershipId')),
    p_new_role: String(formData.get('role')) as 'owner' | 'member',
  });
  if (error) logger.error({ err: error }, 'change_org_role failed');
  revalidatePath('/team');
}

export async function assignCompanyRoleAction(formData: FormData): Promise<void> {
  const supabase = await createUserClient();
  const { error } = await supabase.rpc('assign_company_role', {
    p_company_id: String(formData.get('companyId')),
    p_user_id: String(formData.get('userId')),
    p_role_id: String(formData.get('roleId')),
  });
  if (error) logger.error({ err: error }, 'assign_company_role failed');
  revalidatePath('/team');
}

export async function removeCompanyAccessAction(formData: FormData): Promise<void> {
  const supabase = await createUserClient();
  const { error } = await supabase.rpc('remove_company_access', {
    p_company_id: String(formData.get('companyId')),
    p_user_id: String(formData.get('userId')),
  });
  if (error) logger.error({ err: error }, 'remove_company_access failed');
  revalidatePath('/team');
}
```

`removeMemberAction` keeps calling `remove_member`, which is unchanged.

- [ ] **Step 6: Update the isolation harness**

In `tests/isolation/harness.ts`, `addMemberByInvitation` takes a role id and Company ids instead of an enum, and `provisionCustomer` gains a helper for creating one:

```ts
/**
 * Creates a role in the customer's Organization through the real RPC, as the
 * owner. Tests cannot insert one directly: roles are written only by the
 * SECURITY DEFINER functions, and going the long way round means the seeding
 * path is the production path.
 */
export async function createRoleAs(
  customer: ProvisionedCustomer,
  name: string,
  permissionCodes: string[],
): Promise<string> {
  const ownerClient = await signInAs(customer.email, customer.password);
  const { data, error } = await ownerClient.rpc('create_role', {
    p_organization_id: customer.organizationId,
    p_name: name,
    p_description: null,
    p_permission_codes: permissionCodes,
  });
  if (error) throw new Error(`create_role failed: ${error.message}`);
  return data as string;
}

export async function addMemberByInvitation(
  customer: ProvisionedCustomer,
  label: string,
  roleId: string,
  companyIds: string[],
): Promise<{ userId: string; email: string; password: string }> {
  const email = `member-${label}@example.test`;
  const token = randomBytes(32).toString('base64url');
  const tokenHash = createHash('sha256').update(token).digest('hex');

  const ownerClient = await signInAs(customer.email, customer.password);
  const { error: inviteError } = await ownerClient.rpc('create_invitation', {
    p_organization_id: customer.organizationId,
    p_email: email,
    p_is_owner: false,
    p_role_id: roleId,
    p_company_ids: companyIds,
    p_token_hash: tokenHash,
    p_ttl_days: 7,
  });
  if (inviteError) throw new Error(`create_invitation failed: ${inviteError.message}`);

  const user = await createUser(email);

  const { error: acceptError } = await admin.rpc('accept_invitation', {
    p_token_hash: tokenHash,
    p_user_id: user.userId,
  });
  if (acceptError) throw new Error(`accept_invitation failed: ${acceptError.message}`);

  return user;
}
```

Update every call site in `tests/isolation/*.test.ts` to create a role first and pass `[customer.companyId]`.

- [ ] **Step 7: Run the whole local gate**

Run: `npm run lint && npm run typecheck && npm test && npm run test:isolation`
Expected: all pass. Any isolation test asserting the old fixed roles is updated to assert the equivalent role-based behaviour, not deleted.

- [ ] **Step 8: Commit**

```bash
git add src tests
git commit -m "chore: regenerate database types and move the app onto roles"
```

---

### Task 7: The roles service and schema

**Files:**
- Create: `src/schemas/roles.ts`
- Create: `src/services/roles.ts`
- Test: `tests/unit/roles-schema.test.ts`

**Interfaces:**
- Consumes: the generated `Database` type (Task 6).
- Produces: `roleFormSchema`, `RoleFormInput`; `listPermissionCatalogue()`, `listRoles(organizationId)`, `createRole(input, accessToken)`, `updateRole(roleId, input, accessToken)`, `deleteRole(roleId, accessToken)`; types `PermissionEntry`, `RoleSummary`.

- [ ] **Step 1: Write the failing schema test**

```ts
// tests/unit/roles-schema.test.ts
import { describe, expect, it } from 'vitest';
import { roleFormSchema } from '@/schemas/roles';

describe('roleFormSchema', () => {
  it('accepts a named role with permissions', () => {
    const parsed = roleFormSchema.safeParse({
      organizationId: '11111111-1111-1111-1111-111111111111',
      name: 'Manager',
      description: 'Runs the station day to day',
      permissionCodes: ['users.invite'],
    });
    expect(parsed.success).toBe(true);
  });

  it('accepts a role with no permissions, because an empty role is a real state', () => {
    const parsed = roleFormSchema.safeParse({
      organizationId: '11111111-1111-1111-1111-111111111111',
      name: 'Trainee',
      description: null,
      permissionCodes: [],
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects a blank name, which would render as an unclickable row', () => {
    const parsed = roleFormSchema.safeParse({
      organizationId: '11111111-1111-1111-1111-111111111111',
      name: '   ',
      description: null,
      permissionCodes: [],
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects a duplicated permission code', () => {
    const parsed = roleFormSchema.safeParse({
      organizationId: '11111111-1111-1111-1111-111111111111',
      name: 'Manager',
      description: null,
      permissionCodes: ['users.invite', 'users.invite'],
    });
    expect(parsed.success).toBe(false);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/unit/roles-schema.test.ts`
Expected: FAIL — `Cannot find module '@/schemas/roles'`.

- [ ] **Step 3: Write the schema**

```ts
// src/schemas/roles.ts
import { z } from 'zod';

export const roleFormSchema = z.object({
  organizationId: z.string().uuid(),
  name: z.string().trim().min(1, 'Name the role.').max(60),
  description: z.string().trim().max(240).nullable(),
  // The database primary key would reject a duplicate anyway; catching it here
  // means the form says so instead of the request failing.
  permissionCodes: z
    .array(z.string().min(1))
    .refine((codes) => new Set(codes).size === codes.length, 'A permission was listed twice.'),
});

export type RoleFormInput = z.infer<typeof roleFormSchema>;
```

- [ ] **Step 4: Run it green**

Run: `npx vitest run tests/unit/roles-schema.test.ts`
Expected: 4 passed.

- [ ] **Step 5: Write the service**

```ts
// src/services/roles.ts
import 'server-only';
import { createClient } from '@supabase/supabase-js';
import { createUserClient } from '@/lib/supabase/user-client';
import { getUserSupabaseConfig } from '@/lib/supabase/config';
import { UnauthorizedError, ValidationError } from '@/lib/errors';
import type { Database } from '@/lib/supabase/database.types';
import type { RoleFormInput } from '@/schemas/roles';

export interface PermissionEntry {
  code: string;
  module: string;
  label: string;
  scope: 'organization' | 'company';
}

export interface RoleSummary {
  id: string;
  name: string;
  description: string | null;
  permissionCodes: string[];
  holders: number;
}

/**
 * A client bound to the caller's JWT. The role RPCs re-check has_org_permission
 * against auth.uid(), so calling them with the service key would defeat the
 * check they exist to make.
 */
function asCaller(accessToken: string) {
  const { url, anonKey } = getUserSupabaseConfig();
  return createClient<Database>(url, anonKey, {
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

/** The catalogue is reference data; RLS lets any signed-in user read it. */
export async function listPermissionCatalogue(): Promise<PermissionEntry[]> {
  const supabase = await createUserClient();
  const { data, error } = await supabase
    .from('permissions')
    .select('code, module, label, scope')
    .order('module')
    .order('display_order')
    .order('label');

  if (error) throw new UnauthorizedError(`Could not read the permission catalogue: ${error.message}`);
  return (data ?? []) as PermissionEntry[];
}

export async function listRoles(organizationId: string): Promise<RoleSummary[]> {
  const supabase = await createUserClient();

  // Two reads rather than one embed. Block 1a hit a PostgREST embed that could
  // not resolve the relationship it needed and had to be unwound; counting
  // holders in JavaScript is duller and does not depend on that resolution.
  const [{ data: roles, error: rolesError }, { data: grants }, { data: memberships }] =
    await Promise.all([
      supabase
        .from('roles')
        .select('id, name, description')
        .eq('organization_id', organizationId)
        .is('deleted_at', null)
        .order('name'),
      supabase.from('role_permissions').select('role_id, permission_code'),
      supabase
        .from('company_memberships')
        .select('role_id')
        .eq('organization_id', organizationId)
        .is('deleted_at', null),
    ]);

  if (rolesError) throw new UnauthorizedError(`Could not read roles: ${rolesError.message}`);

  const holders = new Map<string, number>();
  for (const row of memberships ?? []) {
    holders.set(row.role_id, (holders.get(row.role_id) ?? 0) + 1);
  }

  return (roles ?? []).map((role) => ({
    id: role.id,
    name: role.name,
    description: role.description,
    permissionCodes: (grants ?? [])
      .filter((g) => g.role_id === role.id)
      .map((g) => g.permission_code),
    holders: holders.get(role.id) ?? 0,
  }));
}

export async function createRole(input: RoleFormInput, accessToken: string): Promise<string> {
  const { data, error } = await asCaller(accessToken).rpc('create_role', {
    p_organization_id: input.organizationId,
    p_name: input.name,
    p_description: input.description,
    p_permission_codes: input.permissionCodes,
  });
  if (error) throw mapRoleError(error.code, error.message);
  return data as string;
}

export async function updateRole(
  roleId: string,
  input: RoleFormInput,
  accessToken: string,
): Promise<void> {
  const { error } = await asCaller(accessToken).rpc('update_role', {
    p_role_id: roleId,
    p_name: input.name,
    p_description: input.description,
    p_permission_codes: input.permissionCodes,
  });
  if (error) throw mapRoleError(error.code, error.message);
}

export async function deleteRole(roleId: string, accessToken: string): Promise<void> {
  const { error } = await asCaller(accessToken).rpc('delete_role', { p_role_id: roleId });
  if (error) throw mapRoleError(error.code, error.message);
}

/**
 * 23505 is a duplicate name, 23503 a role still assigned, 22023 a bad argument.
 * Each is the caller's mistake and gets a sentence they can act on; anything
 * else is a refusal.
 */
function mapRoleError(code: string | undefined, message: string): Error {
  if (code === '23505') return new ValidationError('There is already a role with that name.');
  if (code === '23503') return new ValidationError(message);
  if (code === '22023') return new ValidationError(message);
  return new UnauthorizedError(message);
}
```

- [ ] **Step 6: Run lint, typecheck and the unit suite**

Run: `npm run lint && npm run typecheck && npm test`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add src/schemas/roles.ts src/services/roles.ts tests/unit/roles-schema.test.ts
git commit -m "feat: add the roles service and its form schema"
```

---

### Task 8: Isolation coverage under real JWTs

**Files:**
- Create: `tests/isolation/roles.test.ts`
- Modify: `tests/isolation/harness.ts` (add `addCompany`)

**Interfaces:**
- Consumes: `provisionCustomer`, `signInAs`, `createUser`, `createRoleAs`, `addMemberByInvitation`, `admin` (Task 6).
- Produces: `addCompany(customer, name)` returning a second Company id.

- [ ] **Step 1: Add the second-Company helper to the harness**

```ts
/**
 * Adds a second Station through the real RPC, as the platform admin that
 * provisioned the customer. Per-Company roles cannot be tested against an
 * Organization holding one Company.
 */
export async function addCompany(
  customer: ProvisionedCustomer,
  name: string,
): Promise<string> {
  const { data, error } = await customer.adminClient.rpc('add_company', {
    p_organization_id: customer.organizationId,
    p_name: name,
    p_timezone: 'America/Sao_Paulo',
  });
  if (error) throw new Error(`add_company failed: ${error.message}`);
  return data as string;
}
```

- [ ] **Step 2: Write the failing isolation suite**

```ts
// tests/isolation/roles.test.ts
import { afterAll, describe, expect, it } from 'vitest';
import {
  addCompany,
  addMemberByInvitation,
  admin,
  cleanupUsers,
  createRoleAs,
  provisionCustomer,
  signInAs,
} from './harness';

afterAll(cleanupUsers);

describe('roles', () => {
  it('grants a permission in one Station and withholds it in another', async () => {
    const customer = await provisionCustomer('roles-scope');
    const second = await addCompany(customer, 'Station Two');
    const manager = await createRoleAs(customer, 'Manager', ['users.invite']);
    const member = await addMemberByInvitation(customer, 'roles-scope', manager, [
      customer.companyId,
    ]);

    const client = await signInAs(member.email, member.password);

    const { data: here } = await client.rpc('has_permission', {
      p_permission: 'users.invite',
      p_company_id: customer.companyId,
    });
    const { data: there } = await client.rpc('has_permission', {
      p_permission: 'users.invite',
      p_company_id: second,
    });

    expect(here).toBe(true);
    expect(there).toBe(false);
  });

  it('cuts access on the next request when the permission is unchecked', async () => {
    const customer = await provisionCustomer('roles-live');
    const role = await createRoleAs(customer, 'Manager', ['users.invite']);
    const member = await addMemberByInvitation(customer, 'roles-live', role, [customer.companyId]);

    // The SAME client throughout: no sign-out, no token refresh.
    const client = await signInAs(member.email, member.password);
    const before = await client.rpc('has_org_permission', {
      p_permission: 'users.invite',
      p_organization_id: customer.organizationId,
    });
    expect(before.data).toBe(true);

    const owner = await signInAs(customer.email, customer.password);
    const { error } = await owner.rpc('update_role', {
      p_role_id: role,
      p_name: 'Manager',
      p_description: null,
      p_permission_codes: [],
    });
    expect(error).toBeNull();

    const after = await client.rpc('has_org_permission', {
      p_permission: 'users.invite',
      p_organization_id: customer.organizationId,
    });
    expect(after.data).toBe(false);
  });

  it('refuses to delete a role somebody holds', async () => {
    const customer = await provisionCustomer('roles-inuse');
    const role = await createRoleAs(customer, 'Manager', []);
    await addMemberByInvitation(customer, 'roles-inuse', role, [customer.companyId]);

    const owner = await signInAs(customer.email, customer.password);
    const { error } = await owner.rpc('delete_role', { p_role_id: role });

    expect(error).not.toBeNull();
    expect(error!.message).toMatch(/assigned to 1 user/i);
  });

  it('refuses a role from another Organization even with a valid id', async () => {
    const a = await provisionCustomer('roles-org-a');
    const b = await provisionCustomer('roles-org-b');
    const foreign = await createRoleAs(b, 'Foreign', []);

    const memberOfA = await createUserInOrgA(a);
    const owner = await signInAs(a.email, a.password);
    const { error } = await owner.rpc('assign_company_role', {
      p_company_id: a.companyId,
      p_user_id: memberOfA,
      p_role_id: foreign,
    });

    expect(error).not.toBeNull();
    expect(error!.message).toMatch(/foreign key|violates/i);
  });

  it('lets roles.manage administer roles, and refuses without it', async () => {
    const customer = await provisionCustomer('roles-delegate');
    const admin_role = await createRoleAs(customer, 'Director', ['roles.manage']);
    const plain = await createRoleAs(customer, 'Trainee', []);

    const director = await addMemberByInvitation(customer, 'director', admin_role, [
      customer.companyId,
    ]);
    const trainee = await addMemberByInvitation(customer, 'trainee', plain, [customer.companyId]);

    const asDirector = await signInAs(director.email, director.password);
    const created = await asDirector.rpc('create_role', {
      p_organization_id: customer.organizationId,
      p_name: 'Producer',
      p_description: null,
      p_permission_codes: [],
    });
    expect(created.error).toBeNull();

    const asTrainee = await signInAs(trainee.email, trainee.password);
    const refused = await asTrainee.rpc('create_role', {
      p_organization_id: customer.organizationId,
      p_name: 'Sneaky',
      p_description: null,
      p_permission_codes: [],
    });
    expect(refused.error).not.toBeNull();
    expect(refused.error!.message).toMatch(/roles\.manage/);
  });

  it('grants the owner everything without any membership row', async () => {
    const customer = await provisionCustomer('roles-owner');
    const owner = await signInAs(customer.email, customer.password);

    const { data: rows } = await admin
      .from('company_memberships')
      .select('id')
      .eq('user_id', customer.userId);
    expect(rows).toHaveLength(0);

    const { data } = await owner.rpc('has_permission', {
      p_permission: 'users.invite',
      p_company_id: customer.companyId,
    });
    expect(data).toBe(true);
  });

  it('grants nothing once the Station is suspended, not even to the owner', async () => {
    const customer = await provisionCustomer('roles-suspended');
    await customer.adminClient.rpc('suspend_company', {
      p_company_id: customer.companyId,
      p_reason: 'non-payment',
    });

    const owner = await signInAs(customer.email, customer.password);
    const { data } = await owner.rpc('has_permission', {
      p_permission: 'users.invite',
      p_company_id: customer.companyId,
    });
    expect(data).toBe(false);
  });
});

/** A second person in Organization A, needed as the target of a bad assignment. */
async function createUserInOrgA(a: Awaited<ReturnType<typeof provisionCustomer>>) {
  const role = await createRoleAs(a, 'Local', []);
  const member = await addMemberByInvitation(a, 'roles-target', role, [a.companyId]);
  return member.userId;
}
```

- [ ] **Step 3: Run it and read every failure**

Run: `npm run test:isolation -- roles`
Expected: the suite runs against a live local Supabase. Any failure here is a real defect in Tasks 1–5, not in the test — fix the migration, not the assertion. (`suspend_company(p_company_id uuid, p_reason text)` is defined in `0007_provisioning_rpc.sql` and takes exactly those two arguments.)

- [ ] **Step 4: Run the whole isolation suite**

Run: `npm run test:isolation`
Expected: every file passes, including the Block 1a and 1b suites updated in Task 6.

- [ ] **Step 5: Commit**

```bash
git add tests/isolation
git commit -m "test: cover per-Company roles under real JWTs"
```

---

### Task 9: The Roles screen

**Files:**
- Create: `src/app/(app)/roles/page.tsx`
- Create: `src/app/(app)/roles/actions.ts`
- Create: `src/app/(app)/roles/role-form.tsx`
- Modify: `src/lib/auth/shell.ts`

**Interfaces:**
- Consumes: `listRoles`, `listPermissionCatalogue`, `createRole`, `updateRole`, `deleteRole`, `roleFormSchema` (Task 7).
- Produces: the route `/roles`; a nav entry under Organization.

- [ ] **Step 1: Write the server actions**

```ts
// src/app/(app)/roles/actions.ts
'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { createUserClient } from '@/lib/supabase/user-client';
import { roleFormSchema } from '@/schemas/roles';
import { createRole, deleteRole, updateRole } from '@/services/roles';
import { logger } from '@/lib/logger';

export interface RoleFormState {
  status: 'idle' | 'saved' | 'error';
  message?: string;
}

async function requireAccessToken(): Promise<string> {
  const supabase = await createUserClient();
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) redirect('/login');
  return token;
}

export async function saveRoleAction(
  _prev: RoleFormState,
  formData: FormData,
): Promise<RoleFormState> {
  const parsed = roleFormSchema.safeParse({
    organizationId: formData.get('organizationId'),
    name: formData.get('name'),
    description: formData.get('description') || null,
    permissionCodes: formData.getAll('permissionCodes').map(String),
  });

  if (!parsed.success) {
    return { status: 'error', message: parsed.error.issues[0]?.message ?? 'Check the form.' };
  }

  const token = await requireAccessToken();
  const roleId = String(formData.get('roleId') ?? '');

  try {
    if (roleId) await updateRole(roleId, parsed.data, token);
    else await createRole(parsed.data, token);
    revalidatePath('/roles');
    return { status: 'saved' };
  } catch (cause) {
    logger.error({ err: cause }, 'save role failed');
    return {
      status: 'error',
      message: cause instanceof Error ? cause.message : 'Could not save the role.',
    };
  }
}

export async function deleteRoleAction(formData: FormData): Promise<void> {
  const token = await requireAccessToken();
  try {
    await deleteRole(String(formData.get('roleId')), token);
  } catch (cause) {
    // The database refuses a role in use, and the list re-renders with the
    // holder count that explains why. Swallowing it here keeps the failure on
    // the screen instead of a stack trace.
    logger.error({ err: cause }, 'delete role failed');
  }
  revalidatePath('/roles');
}
```

- [ ] **Step 2: Write the form component**

```tsx
// src/app/(app)/roles/role-form.tsx
'use client';

import { useActionState } from 'react';
import { saveRoleAction, type RoleFormState } from './actions';
import type { PermissionEntry, RoleSummary } from '@/services/roles';

const initial: RoleFormState = { status: 'idle' };

/**
 * One component for both creating and editing. `role` absent means create; the
 * hidden roleId is what saveRoleAction reads to tell them apart, so the two
 * paths cannot drift into rendering different catalogues.
 */
export function RoleForm({
  organizationId,
  catalogue,
  role,
}: {
  organizationId: string;
  catalogue: PermissionEntry[];
  role?: RoleSummary;
}) {
  const [state, action, pending] = useActionState(saveRoleAction, initial);

  const modules = [...new Set(catalogue.map((p) => p.module))];
  const held = new Set(role?.permissionCodes ?? []);

  return (
    <form action={action} className="flex flex-col gap-4 rounded-lg border p-4">
      <input type="hidden" name="organizationId" value={organizationId} />
      {role && <input type="hidden" name="roleId" value={role.id} />}

      <label className="flex flex-col gap-1 text-sm">
        Name
        <input
          name="name"
          required
          maxLength={60}
          defaultValue={role?.name ?? ''}
          className="rounded-md border px-3 py-2"
        />
      </label>

      <label className="flex flex-col gap-1 text-sm">
        Description
        <input
          name="description"
          maxLength={240}
          defaultValue={role?.description ?? ''}
          className="rounded-md border px-3 py-2"
        />
      </label>

      {modules.map((module) => (
        <fieldset key={module} className="flex flex-col gap-2">
          <legend className="text-xs font-medium uppercase tracking-wider">{module}</legend>
          {catalogue
            .filter((p) => p.module === module)
            .map((p) => (
              <label key={p.code} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  name="permissionCodes"
                  value={p.code}
                  defaultChecked={held.has(p.code)}
                />
                {p.label}
                {/* Roles are assigned per Station, so a permission that reaches
                    the whole Organization has to say so where it is chosen. */}
                {p.scope === 'organization' && (
                  <span className="rounded bg-amber-100 px-1.5 py-0.5 text-xs text-amber-900">
                    whole Organization
                  </span>
                )}
              </label>
            ))}
        </fieldset>
      ))}

      {/* Unchecking a box cuts its holders off on their next request, with no
          sign-out. Saying how many people that is, next to the button, is the
          whole mitigation for how sharp that edge is. */}
      {role && role.holders > 0 && (
        <p className="text-sm text-amber-800">
          {role.holders} user(s) hold this role. Changes apply to them immediately.
        </p>
      )}

      <button
        type="submit"
        disabled={pending}
        className="self-start rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground"
      >
        {pending ? 'Saving…' : role ? 'Save changes' : 'Create role'}
      </button>

      {state.status === 'error' && <p className="text-sm text-red-600">{state.message}</p>}
      {state.status === 'saved' && <p className="text-sm text-emerald-700">Role saved.</p>}
    </form>
  );
}
```

- [ ] **Step 3: Write the page**

```tsx
// src/app/(app)/roles/page.tsx
import { redirect } from 'next/navigation';
import { createUserClient } from '@/lib/supabase/user-client';
import { listPermissionCatalogue, listRoles } from '@/services/roles';
import { deleteRoleAction } from './actions';
import { RoleForm } from './role-form';

export default async function RolesPage() {
  const supabase = await createUserClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { data: membership } = await supabase
    .from('organization_memberships')
    .select('organization_id')
    .eq('user_id', user.id)
    .is('deleted_at', null)
    .single();

  if (!membership) redirect('/app');

  const { data: allowed } = await supabase.rpc('has_org_permission', {
    p_permission: 'roles.manage',
    p_organization_id: membership.organization_id,
  });

  // A courtesy, not the boundary: every RPC below re-checks in its own body.
  if (!allowed) redirect('/app');

  const [roles, catalogue] = await Promise.all([
    listRoles(membership.organization_id),
    listPermissionCatalogue(),
  ]);

  return (
    <div className="flex flex-col gap-8">
      <header>
        <h1 className="text-xl font-semibold">Roles</h1>
        <p className="text-sm text-muted-foreground">
          A role is a set of powers you assign to someone in a Station.
        </p>
      </header>

      <ul className="flex flex-col gap-2">
        {roles.map((role) => (
          <li key={role.id} className="rounded-lg border p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="font-medium">{role.name}</p>
                <p className="text-sm text-muted-foreground">
                  {role.permissionCodes.length} permission(s) · held by {role.holders} user(s)
                </p>
              </div>
              <form action={deleteRoleAction}>
                <input type="hidden" name="roleId" value={role.id} />
                <button
                  type="submit"
                  disabled={role.holders > 0}
                  title={role.holders > 0 ? 'Reassign its holders first' : undefined}
                  className="text-sm text-red-600 disabled:text-muted-foreground"
                >
                  Delete
                </button>
              </form>
            </div>

            <details className="mt-3">
              <summary className="cursor-pointer text-sm underline">Edit permissions</summary>
              <div className="pt-3">
                <RoleForm
                  organizationId={membership.organization_id}
                  catalogue={catalogue}
                  role={role}
                />
              </div>
            </details>
          </li>
        ))}
        {roles.length === 0 && (
          <li className="rounded-lg border border-dashed p-6 text-sm text-muted-foreground">
            No roles yet. Create one below, then assign it on the Team screen.
          </li>
        )}
      </ul>

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-medium">New role</h2>
        <RoleForm organizationId={membership.organization_id} catalogue={catalogue} />
      </section>
    </div>
  );
}
```

- [ ] **Step 4: Add the nav entry**

In `src/lib/auth/shell.ts`, add to the Organization section, after the Team item:

```ts
      items: [
        { href: '/team', label: 'Team', icon: ICONS.users },
        { href: '/roles', label: 'Roles', icon: ICONS.shield },
      ],
```

Add a `shield` entry to `ICONS` in `src/components/layout/app-shell.tsx` using the same inline-path convention as its neighbours:

```ts
  shield: 'M12 3l7 4v5c0 4.4-3 8.3-7 9-4-0.7-7-4.6-7-9V7l7-4z',
```

- [ ] **Step 5: Run lint, typecheck, build**

Run: `npm run lint && npm run typecheck && npm run build`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/app/\(app\)/roles src/lib/auth/shell.ts src/components/layout/app-shell.tsx
git commit -m "feat(ui): add the roles screen"
```

---

### Task 10: The Team screen assigns roles per Station

**Files:**
- Modify: `src/app/(app)/team/page.tsx`
- Modify: `src/app/(app)/team/invite-form.tsx`
- Modify: `src/app/(app)/team/actions.ts`

**Interfaces:**
- Consumes: `assignCompanyRoleAction`, `removeCompanyAccessAction` (Task 6); `listRoles` (Task 7).
- Produces: no new exports.

- [ ] **Step 1: Extend the page query and render one row per Station**

In `src/app/(app)/team/page.tsx`, alongside the existing membership and invitation reads, load the Organization's Companies, its roles, and every live Company membership:

```tsx
  const [{ data: companies }, roles, { data: links }] = await Promise.all([
    supabase
      .from('companies')
      .select('id, name, status')
      .eq('organization_id', organizationId)
      .is('deleted_at', null)
      .order('name'),
    listRoles(organizationId),
    supabase
      .from('company_memberships')
      .select('user_id, company_id, role_id')
      .eq('organization_id', organizationId)
      .is('deleted_at', null),
  ]);
```

For each non-owner member, render one row per Company with a role dropdown that submits `assignCompanyRoleAction`, plus a Remove button submitting `removeCompanyAccessAction`:

```tsx
{companies?.map((company) => {
  const link = links?.find((l) => l.user_id === member.userId && l.company_id === company.id);
  return (
    <div key={company.id} className="flex items-center gap-3 text-sm">
      <span className="w-40 truncate">{company.name}</span>
      <form action={assignCompanyRoleAction} className="flex items-center gap-2">
        <input type="hidden" name="companyId" value={company.id} />
        <input type="hidden" name="userId" value={member.userId} />
        <select
          name="roleId"
          defaultValue={link?.role_id ?? ''}
          className="rounded-md border px-2 py-1"
        >
          <option value="" disabled>
            No access
          </option>
          {roles.map((role) => (
            <option key={role.id} value={role.id}>
              {role.name}
            </option>
          ))}
        </select>
        <button type="submit" className="text-sm underline">
          Apply
        </button>
      </form>
      {link && (
        <form action={removeCompanyAccessAction}>
          <input type="hidden" name="companyId" value={company.id} />
          <input type="hidden" name="userId" value={member.userId} />
          <button type="submit" className="text-sm text-red-600">
            Remove
          </button>
        </form>
      )}
    </div>
  );
})}
```

Owners render once, labelled `Owner — full access to every Station`, with no controls: they hold no membership row and take no role.

- [ ] **Step 2: Extend the invite form**

`src/app/(app)/team/invite-form.tsx` takes `roles` and `companies` as props and renders an owner checkbox, a role select, and a Company checkbox list. The role select and Company list are disabled while the owner box is checked, because the schema in Task 6 rejects that combination:

```tsx
  const [isOwner, setIsOwner] = useState(false);
  …
  <label className="flex items-center gap-2 text-sm">
    <input
      type="checkbox"
      name="isOwner"
      checked={isOwner}
      onChange={(e) => setIsOwner(e.target.checked)}
    />
    Invite as owner (full access to every Station)
  </label>

  <select name="roleId" disabled={isOwner} required={!isOwner} className="rounded-md border px-3 py-2">
    <option value="">Choose a role…</option>
    {roles.map((r) => (
      <option key={r.id} value={r.id}>{r.name}</option>
    ))}
  </select>

  <fieldset disabled={isOwner} className="flex flex-col gap-1">
    <legend className="text-sm">Stations</legend>
    {companies.map((c) => (
      <label key={c.id} className="flex items-center gap-2 text-sm">
        <input type="checkbox" name="companyIds" value={c.id} />
        {c.name}
      </label>
    ))}
  </fieldset>
```

- [ ] **Step 3: Update `inviteAction` to parse the new fields**

```ts
  const isOwner = formData.get('isOwner') === 'on';
  const parsed = createInvitationSchema.safeParse({
    organizationId: formData.get('organizationId'),
    email: formData.get('email'),
    isOwner,
    roleId: isOwner ? null : (formData.get('roleId') as string) || null,
    companyIds: isOwner ? [] : formData.getAll('companyIds').map(String),
  });
```

- [ ] **Step 4: Run lint, typecheck, build**

Run: `npm run lint && npm run typecheck && npm run build`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/app/\(app\)/team
git commit -m "feat(ui): assign a role per Station on the team screen"
```

---

### Task 11: Stations on the home screen, and a second Station in the console

**Files:**
- Modify: `src/app/(app)/app/page.tsx`
- Modify: `src/app/(admin)/admin/customers/page.tsx`
- Modify: `src/app/(admin)/admin/customers/actions.ts`

**Interfaces:**
- Consumes: `add_company` (Task 3).
- Produces: `addCompanyAction(formData)` in the admin actions module.

- [ ] **Step 1: List reachable Stations on `/app`**

```tsx
  const { data: companies } = await supabase
    .from('companies')
    .select('id, name, status, timezone')
    .is('deleted_at', null)
    .order('name');
```

RLS already limits this to the user's Organization. Render each as a card showing name, timezone and, when `status === 'suspended'`, the sentence `Suspended — no data is available while the subscription is inactive.` This is how a member discovers they were added to a second Station.

- [ ] **Step 2: Add the console action**

```ts
export async function addCompanyAction(formData: FormData): Promise<void> {
  const supabase = await createUserClient();
  const { error } = await supabase.rpc('add_company', {
    p_organization_id: String(formData.get('organizationId')),
    p_name: String(formData.get('name')),
    p_timezone: String(formData.get('timezone') || 'America/Sao_Paulo'),
  });
  if (error) logger.error({ err: error }, 'add_company failed');
  revalidatePath('/admin/customers');
}
```

- [ ] **Step 3: Add the form to each customer row**

A single-line form with a name input and a submit button, posting `organizationId` from the row. Keep it inline with the existing row layout rather than introducing a dialog — the console has no dialog pattern yet and this block is not the place to invent one.

- [ ] **Step 4: Run lint, typecheck, build**

Run: `npm run lint && npm run typecheck && npm run build`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/app
git commit -m "feat(ui): list reachable Stations and add one from the console"
```

---

### Task 12: The end-to-end journey

**Files:**
- Create: `tests/e2e/roles-flow.spec.ts`

**Interfaces:**
- Consumes: the whole stack.

- [ ] **Step 1: Write the spec**

Follow the shape of `tests/e2e/invitation-flow.spec.ts`, which already provisions a customer, signs in and completes the provisional-password gate. The journey:

1. Sign in as the owner and complete the password gate.
2. Open `/roles`, create `Manager` with the `users.invite` box ticked, and assert the row shows `held by 0 user(s)`.
3. Add a second Station through the admin console as the platform admin.
4. Back on `/team`, invite `manager@example.test` as a member with the Manager role and only the first Station ticked.
5. Open the accept URL in a fresh context, set a password, and land in the app.
6. As that user, assert `/app` lists exactly one Station.
7. As the owner, assign the Manager role in the second Station and assert the member's `/app` now lists two.
8. As the owner, open `/roles` and assert Delete is disabled for Manager, with the holder count above zero.

```ts
test('an owner composes a role and assigns it per Station', async ({ page, browser }) => {
  // …provision and sign in as the owner, as invitation-flow.spec.ts does…

  await page.goto('/roles');
  await page.getByLabel('Name').fill('Manager');
  await page.getByLabel('Invite people to the Organization').check();
  await page.getByRole('button', { name: 'Create role' }).click();
  await expect(page.getByText('held by 0 user(s)')).toBeVisible();

  // …invite, accept in a second context, and assert the Station count…
});
```

- [ ] **Step 2: Run it**

Run: `npm run test:e2e -- roles-flow`
Expected: pass against a running local Supabase and `next build && next start`, exactly as the existing e2e specs do.

- [ ] **Step 3: Run the full e2e suite**

Run: `npm run test:e2e`
Expected: `home`, `provisioning-flow`, `invitation-flow` and `roles-flow` all pass. The invitation spec needs updating for the new form fields — update it, do not skip it.

- [ ] **Step 4: Commit**

```bash
git add tests/e2e
git commit -m "test(e2e): cover composing a role and assigning it per Station"
```

---

### Task 13: Full verification and the block report

**Files:**
- Create: `docs/block-1c-report.md`

- [ ] **Step 1: Run every gate in one sequence and capture the output**

```bash
npm run lint
npm run typecheck
npm test
npx supabase db reset && npx supabase test db
npm run test:isolation
npm run test:e2e
docker build -t pulchatx:1c \
  --build-arg NEXT_PUBLIC_SUPABASE_URL=http://localhost:54321 \
  --build-arg NEXT_PUBLIC_SUPABASE_ANON_KEY=dummy .
```

Every command must pass. Record the actual output — not a summary of it — in the report.

- [ ] **Step 2: Prove the fail-closed term still bites**

Temporarily change `has_permission` so the existence check moves inside the bypass, run `npm run test:isolation`, and confirm a test fails. Revert. A suite that passes either way proves nothing. Record which test caught it.

- [ ] **Step 3: Write the report**

Follow `docs/block-1b-report.md`: §1 what was verified with verbatim output, §2 defects found in the plan itself while executing it, §3 deployment steps, §4 a definition-of-done table copied from the spec with evidence per row, §5 open items.

Migrations `0015`–`0019` apply with `npx supabase db push --linked`. Note explicitly that `0016` **deletes** the owners' `company_memberships` rows and `0018` **drops** the `member_role` type — both irreversible on a live database, so the deploy takes a snapshot first.

- [ ] **Step 4: Commit and open the pull request**

```bash
git add docs/block-1c-report.md
git commit -m "docs: add Block 1c verification report"
git push -u origin block-1c
gh pr create --title "Block 1c — Roles & per-Company assignment" --body "…"
```

---

## Notes carried forward to Block 2

Decisions taken during this block's brainstorming that belong to the inventory block, recorded so they are not re-litigated:

- **Prizes carry quantity only** — no unit value, no supplier. If value is needed later it arrives by migration without touching the ledger.
- **Reservations are real**, and a reservation carries a free-text note explaining what it is being held for.
- **The full bucket vocabulary and the canonical equation ship in Block 2**, with `CHECK >= 0` per bucket, but only the movements Block 2 can prove end to end get an RPC. Blocks 4 and 6 add theirs against a schema that already accounted for them.
- **The uncollected-prize return is derived from a date, not maintained by a cron.** A drawn prize whose deadline has passed leaves the awarded list and appears in the returned list because the deadline is in the past; the user then archives it or returns it to stock. This replaces the deadline cron in spec §6 and removes a scheduled job that could silently fail.
- Inventory permission codes are introduced in Block 2's own migration with `module = 'inventory'`, and appear in the role editor without that screen being touched. That is the test of whether this block's catalogue was built right.
