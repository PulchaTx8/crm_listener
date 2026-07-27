# Block 1b — Permissions & Invitations — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give a paying customer more than one user — permissions as seeded data, and an invitation flow whose token never reaches the database in plaintext — on a schema where privilege escalation fails under a real JWT.

**Architecture:** Postgres owns the permission primitives (`has_permission`, `has_org_permission`) and the atomic multi-step operations (PL/pgSQL RPCs). The last-owner rule is a deferred constraint trigger, not an RPC check, so it survives an RPC written later that forgets it. Next.js owns token generation, e-mail, and orchestration of the two-system acceptance flow.

**Tech Stack:** Next.js 15 App Router · React 19 · TypeScript strict · Supabase (Postgres, Auth, RLS, PL/pgSQL) · Zod · Tailwind + shadcn/ui · Vitest · Playwright · pgTAP

**Spec:** `docs/superpowers/specs/2026-07-26-block-1b-permissions-invitations-design.md`

**Predecessor:** Block 1a (migrations `0001`–`0009`). This block starts at `0010`.

## Global Constraints

- **Node.js ≥ 22**; npm with committed `package-lock.json`.
- **TypeScript strict**; `any` forbidden without a justifying comment. `noUncheckedIndexedAccess` and `noImplicitOverride` are on.
- **No `as unknown as` casts and no `!` non-null assertions on query results.** Block 1a shipped three defects behind exactly those two constructs. If the compiler disagrees with you about a query result, the query is wrong.
- **Everything in English** — identifiers, comments, error messages, UI strings, docs.
- **App Router**; Server Components by default, Client Components only when necessary.
- **UI only via Tailwind + shadcn/ui.**
- **`SUPABASE_SERVICE_ROLE_KEY` never reaches the client bundle**; `service-client.ts` stays `server-only`.
- **Never log** passwords, tokens, invitation tokens, `service_role`, full CPF/passport, or `authorization`.
- **`USING (true)` is forbidden** in any RLS policy. `organization_id` / `company_id` arriving from the client are never trusted without a check.
- **`SECURITY DEFINER` functions re-check permission in their own body** — RLS does not protect them.
- **A denied privileged call uses `RAISE LOG`, never an `INSERT` into `audit_logs`** — the raise aborts the transaction and takes the row with it (Block 1a §3.2).
- **New tables need explicit `service_role` grants.** The `public` schema's default ACL gives the Supabase roles only `Dxtm`; `BYPASSRLS` is not a substitute for a `GRANT`.
- Every commit passes `npm run lint`, `npm run typecheck`, `npm run test`.
- **Conventional Commits**; import alias `@/*` → `src/*`.
- Prettier: `singleQuote: true`, `semi: true`, `printWidth: 100`, `trailingComma: "all"`.
- Vocabulary: **Organization** → **Company** (prose: *Station*) → data. Audience is **Member**. Internal links are `organization_memberships` / `company_memberships`.

---

## File Structure

Created in this block:

- `supabase/migrations/0010_permissions.sql` — `permissions`, `role_permissions`, the two helpers, the seed
- `supabase/migrations/0011_member_management.sql` — `change_member_role`, `remove_member`, the last-owner trigger
- `supabase/migrations/0012_invitations.sql` — `invitation_status`, `invitations`, indexes
- `supabase/migrations/0013_invitation_rpcs.sql` — `create_invitation`, `revoke_invitation`, `validate_invitation`, `accept_invitation`
- `supabase/migrations/0014_rls_1b.sql` — RLS and grants for the new tables, plus org-scoped `audit_logs`
- `supabase/tests/02_permissions.test.sql` — pgTAP
- `src/schemas/invitations.ts` — Zod
- `src/services/invitations.ts` — token generation, create, revoke, validate, accept
- `src/app/(app)/team/page.tsx`, `actions.ts`, `invite-form.tsx` — the Organization's team screen
- `src/app/(public)/invite/[token]/page.tsx` — acceptance
- `tests/isolation/permissions.test.ts`, `tests/isolation/invitations.test.ts`
- `tests/e2e/invitation-flow.spec.ts`
- Modified: `src/lib/supabase/database.types.ts` (regenerated), `src/middleware.ts` (public path)

---

## Task 1: Permission catalogue and the two helpers

**Files:**
- Create: `supabase/migrations/0010_permissions.sql`

**Interfaces:**
- Produces: tables `permissions`, `role_permissions`; `has_permission(text, uuid) → boolean`; `has_org_permission(text, uuid) → boolean`.

- [ ] **Step 1: Write the migration**

`supabase/migrations/0010_permissions.sql`:

```sql
-- Permissions are seeded data, not runtime data. Roles are fixed
-- (member_role from 0003), so "who may do what" changes through a reviewed,
-- versioned migration rather than a click in production. That is why this
-- block ships no role-editing screen: it would be its highest-risk surface
-- and the business has not asked for it.
create table public.permissions (
  code                text primary key,
  description         text not null,
  introduced_by_block text not null,
  created_at          timestamptz not null default now()
);

comment on table public.permissions is 'Catalogue of permission codes. Each block inserts its own in its own migration.';

create table public.role_permissions (
  role            public.member_role not null,
  permission_code text not null references public.permissions (code) on delete cascade,
  primary key (role, permission_code)
);

comment on table public.role_permissions is 'Which fixed role grants which permission. Seeded; never written at runtime.';

-- This block seeds only what it enforces. Block 2 adds inventory.* in its own
-- migration, so a permission is born beside the feature it guards.
insert into public.permissions (code, description, introduced_by_block) values
  ('users.invite', 'Create and revoke invitations to the Organization', '1b'),
  ('users.manage', 'Change a member''s role and remove members',        '1b'),
  ('audit.view',   'Read the Organization''s audit trail',              '1b');

-- operator and viewer intentionally hold nothing in this block. There is no
-- business domain yet, so the only distinction that exists is owner/not-owner.
insert into public.role_permissions (role, permission_code) values
  ('owner', 'users.invite'),
  ('owner', 'users.manage'),
  ('owner', 'audit.view');

-- Business tables use this from Block 2 onward.
--
-- The permissions-existence check sits OUTSIDE the platform-admin bypass, and
-- the order matters. Written the obvious way, `is_platform_admin() or exists(...)`
-- short-circuits before permission_code is ever compared, so a typo'd code would
-- return true for an admin on any active Company. has_company_access (0005) uses
-- that same shape correctly, because the check it bypasses is membership; here it
-- would bypass the validity of the code itself. The shape does not transfer.
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
         join public.role_permissions rp on rp.role = cm.role
         where cm.user_id = auth.uid()
           and cm.company_id = p_company_id
           and cm.deleted_at is null
           and rp.permission_code = p_permission
       )
     );
$$;

comment on function public.has_permission(text, uuid) is
  'Valid permission code AND active subscription AND the role grants it. Business tables use this.';

-- Identity operations are Organization-scoped, so they need their own helper:
-- forcing an invitation through a Company-scoped check would make it pick an
-- arbitrary Company just to satisfy the signature. No subscription term here,
-- because an Organization is always active — only Companies are suspended.
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
       or exists (
         select 1
         from public.organization_memberships om
         join public.role_permissions rp on rp.role = om.role
         where om.user_id = auth.uid()
           and om.organization_id = p_organization_id
           and om.deleted_at is null
           and rp.permission_code = p_permission
       )
     );
$$;

revoke execute on function public.has_permission(text, uuid) from public;
revoke execute on function public.has_org_permission(text, uuid) from public;
grant execute on function public.has_permission(text, uuid) to authenticated;
grant execute on function public.has_org_permission(text, uuid) to authenticated;
```

- [ ] **Step 2: Apply**

Run: `npm run db:reset`
Expected: `0010_permissions.sql` applies with no error.

- [ ] **Step 3: Prove the fail-closed ordering by hand before trusting it**

Run:

```bash
docker exec -i supabase_db_CRM_-_LISTENER psql -U postgres -d postgres -c \
  "select public.has_permission('no.such.code', gen_random_uuid()) as unknown_code;"
```

Expected: `f`. `auth.uid()` is null here so no admin bypass is in play, but this
confirms the existence term evaluates first and independently. Task 9 asserts the
same thing under a real platform-admin JWT, which is the case that actually matters.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/0010_permissions.sql
git commit -m "feat(db): add permission catalogue and the two permission helpers"
```

---

## Task 2: Member management and the last-owner trigger

**Files:**
- Create: `supabase/migrations/0011_member_management.sql`

**Interfaces:**
- Consumes: `has_org_permission` (Task 1).
- Produces: `change_member_role(uuid, member_role) → void`; `remove_member(uuid) → void`; trigger `organization_memberships_keep_owner`.

- [ ] **Step 1: Write the migration**

`supabase/migrations/0011_member_management.sql`:

```sql
-- An Organization that loses its last owner cannot be repaired by anyone inside
-- it: the recovery is a support call only the product owner can answer. The rule
-- therefore lives in a trigger, not in the RPCs below. Membership writes pass
-- only through SECURITY DEFINER functions *today*, so an in-RPC check would be
-- enough right now — and would silently stop being enough the first time someone
-- adds an RPC and forgets. Same reasoning that put the 1a password gate in the
-- column GRANT rather than in the policy.
create or replace function public.enforce_last_owner()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  v_org    uuid := coalesce(new.organization_id, old.organization_id);
  v_owners integer;
begin
  select count(*) into v_owners
  from public.organization_memberships
  where organization_id = v_org
    and role = 'owner'
    and deleted_at is null;

  if v_owners = 0 then
    raise exception 'an organization must keep at least one owner'
      using errcode = '23514';
  end if;

  return null;
end;
$$;

-- DEFERRABLE INITIALLY DEFERRED so the check runs at commit, not per row. That
-- lets one transaction promote a new owner and demote the old one in either
-- order; only the end state has to be legal.
create constraint trigger organization_memberships_keep_owner
after update or delete on public.organization_memberships
deferrable initially deferred
for each row execute function public.enforce_last_owner();

create or replace function public.change_member_role(
  p_membership_id uuid,
  p_new_role      public.member_role
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
  v_old_role public.member_role;
begin
  select om.organization_id, om.user_id, om.role
    into v_org, v_user, v_old_role
  from public.organization_memberships om
  where om.id = p_membership_id
    and om.deleted_at is null;

  if not found then
    raise exception 'membership not found: %', p_membership_id using errcode = 'P0002';
  end if;

  if not public.has_org_permission('users.manage', v_org) then
    raise log 'change_member_role denied: actor=% membership=%', v_actor, p_membership_id;
    raise exception 'permission denied: users.manage required' using errcode = '42501';
  end if;

  update public.organization_memberships
     set role = p_new_role, updated_at = now()
   where id = p_membership_id;

  -- Company roles follow the Organization role. Per-Company roles arrive in
  -- Block 1c; until then the two levels must not drift apart, or has_permission
  -- and has_org_permission would disagree about the same person.
  update public.company_memberships cm
     set role = p_new_role, updated_at = now()
   from public.companies c
   where c.id = cm.company_id
     and c.organization_id = v_org
     and cm.user_id = v_user
     and cm.deleted_at is null;

  insert into public.audit_logs
    (actor_id, action, target_table, target_id, organization_id, detail)
  values
    (v_actor, 'change_member_role', 'organization_memberships', p_membership_id, v_org,
     jsonb_build_object('user_id', v_user, 'from', v_old_role, 'to', p_new_role));
end;
$$;

create or replace function public.remove_member(p_membership_id uuid)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor uuid := auth.uid();
  v_org   uuid;
  v_user  uuid;
begin
  select om.organization_id, om.user_id
    into v_org, v_user
  from public.organization_memberships om
  where om.id = p_membership_id
    and om.deleted_at is null;

  if not found then
    raise exception 'membership not found: %', p_membership_id using errcode = 'P0002';
  end if;

  if not public.has_org_permission('users.manage', v_org) then
    raise log 'remove_member denied: actor=% membership=%', v_actor, p_membership_id;
    raise exception 'permission denied: users.manage required' using errcode = '42501';
  end if;

  -- Soft delete, and it cuts immediately: the RLS helpers query these tables on
  -- every check (1a §4), so the next request from an open session already fails.
  update public.organization_memberships
     set deleted_at = now(), updated_at = now()
   where id = p_membership_id;

  update public.company_memberships cm
     set deleted_at = now(), updated_at = now()
   from public.companies c
   where c.id = cm.company_id
     and c.organization_id = v_org
     and cm.user_id = v_user
     and cm.deleted_at is null;

  insert into public.audit_logs
    (actor_id, action, target_table, target_id, organization_id, detail)
  values
    (v_actor, 'remove_member', 'organization_memberships', p_membership_id, v_org,
     jsonb_build_object('user_id', v_user));
end;
$$;

revoke execute on function public.change_member_role(uuid, public.member_role) from public;
revoke execute on function public.remove_member(uuid) from public;
grant execute on function public.change_member_role(uuid, public.member_role) to authenticated;
grant execute on function public.remove_member(uuid) to authenticated;
```

- [ ] **Step 2: Apply**

Run: `npm run db:reset`
Expected: applies cleanly.

- [ ] **Step 3: Prove the trigger fires**

Run:

```bash
docker exec -i supabase_db_CRM_-_LISTENER psql -U postgres -d postgres <<'SQL'
begin;
insert into public.organizations (id, name) values
  ('11111111-1111-1111-1111-111111111111', 'Trigger Probe');
insert into auth.users (id, instance_id, aud, role, email)
  values ('22222222-2222-2222-2222-222222222222',
          '00000000-0000-0000-0000-000000000000',
          'authenticated', 'authenticated', 'probe@example.test');
insert into public.organization_memberships (user_id, organization_id, role) values
  ('22222222-2222-2222-2222-222222222222',
   '11111111-1111-1111-1111-111111111111', 'owner');
-- demoting the only owner must fail at commit
update public.organization_memberships set role = 'viewer'
 where organization_id = '11111111-1111-1111-1111-111111111111';
commit;
SQL
```

Expected: `ERROR: an organization must keep at least one owner`. The transaction
rolls back, so nothing is left behind.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/0011_member_management.sql
git commit -m "feat(db): add member management with a last-owner trigger"
```

---

## Task 3: Invitations schema

**Files:**
- Create: `supabase/migrations/0012_invitations.sql`

**Interfaces:**
- Produces: enum `invitation_status`; table `invitations`.

- [ ] **Step 1: Write the migration**

`supabase/migrations/0012_invitations.sql`:

```sql
-- Three values, not four. There is no `expired`, because expiry is derived from
-- expires_at at read time. An `expired` status would only be true if a cron
-- maintained it — and Block 1a shipped exactly that defect: provisional_expires_at
-- was written and read by nothing. State nobody maintains lies.
create type public.invitation_status as enum ('pending', 'accepted', 'revoked');

create table public.invitations (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations (id),
  email            text not null,
  role             public.member_role not null,
  token_hash       text not null,
  status           public.invitation_status not null default 'pending',
  expires_at       timestamptz not null,
  invited_by       uuid references auth.users (id),
  accepted_at      timestamptz,
  accepted_by      uuid references auth.users (id),
  revoked_at       timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

comment on table public.invitations is 'Pending access grants. The plaintext token is never stored.';
comment on column public.invitations.token_hash is 'SHA-256 of the token. A database dump yields no working link.';

-- One live invitation per address per Organization: re-inviting someone who
-- already has a pending link should be an explicit revoke-and-resend, not two
-- valid links in circulation.
create unique index invitations_pending_unique
  on public.invitations (organization_id, lower(email))
  where status = 'pending';

-- The acceptance lookup is by hash; it must be indexed and unique.
create unique index invitations_token_hash_unique on public.invitations (token_hash);

create index invitations_org_idx on public.invitations (organization_id, created_at desc);
```

- [ ] **Step 2: Apply and commit**

Run: `npm run db:reset`
Expected: applies cleanly.

```bash
git add supabase/migrations/0012_invitations.sql
git commit -m "feat(db): add invitations table"
```

---

## Task 4: Invitation RPCs

**Files:**
- Create: `supabase/migrations/0013_invitation_rpcs.sql`

**Interfaces:**
- Consumes: `has_org_permission` (Task 1), `invitations` (Task 3).
- Produces:
  - `create_invitation(p_organization_id uuid, p_email text, p_role member_role, p_token_hash text, p_ttl_days integer) → uuid`
  - `revoke_invitation(p_invitation_id uuid) → void`
  - `validate_invitation(p_token_hash text) → jsonb` — `{invitation_id, organization_id, organization_name, email, role}` or raises
  - `accept_invitation(p_token_hash text, p_user_id uuid, p_full_name text) → jsonb` — `{organization_id}`

- [ ] **Step 1: Write the migration**

`supabase/migrations/0013_invitation_rpcs.sql`:

```sql
-- The plaintext token is generated in Node and never sent here: these functions
-- take its SHA-256. The token therefore appears in no query log and no backup.
create or replace function public.create_invitation(
  p_organization_id uuid,
  p_email           text,
  p_role            public.member_role,
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
begin
  if not public.has_org_permission('users.invite', p_organization_id) then
    raise log 'create_invitation denied: actor=% org=%', v_actor, p_organization_id;
    raise exception 'permission denied: users.invite required' using errcode = '42501';
  end if;

  if coalesce(v_email, '') = '' then
    raise exception 'email is required' using errcode = '22023';
  end if;

  -- A person belongs to one Organization (spec §4.3). Refusing here keeps the
  -- acceptance page single-path: it always creates an account. Offering to set a
  -- password for an existing account from an emailed link is account takeover.
  if exists (select 1 from auth.users u where lower(u.email) = v_email) then
    raise exception 'this e-mail already has an account on the platform'
      using errcode = '23505';
  end if;

  insert into public.invitations
    (organization_id, email, role, token_hash, expires_at, invited_by)
  values
    (p_organization_id, v_email, p_role, p_token_hash,
     now() + make_interval(days => p_ttl_days), v_actor)
  returning id into v_id;

  insert into public.audit_logs
    (actor_id, action, target_table, target_id, organization_id, detail)
  values
    (v_actor, 'create_invitation', 'invitations', v_id, p_organization_id,
     jsonb_build_object('email', v_email, 'role', p_role));

  return v_id;
end;
$$;

create or replace function public.revoke_invitation(p_invitation_id uuid)
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
  from public.invitations
  where id = p_invitation_id;

  if not found then
    raise exception 'invitation not found: %', p_invitation_id using errcode = 'P0002';
  end if;

  if not public.has_org_permission('users.invite', v_org) then
    raise log 'revoke_invitation denied: actor=% invitation=%', v_actor, p_invitation_id;
    raise exception 'permission denied: users.invite required' using errcode = '42501';
  end if;

  update public.invitations
     set status = 'revoked', revoked_at = now(), updated_at = now()
   where id = p_invitation_id
     and status = 'pending';

  if not found then
    raise exception 'invitation is not pending' using errcode = '22023';
  end if;

  insert into public.audit_logs
    (actor_id, action, target_table, target_id, organization_id)
  values
    (v_actor, 'revoke_invitation', 'invitations', p_invitation_id, v_org);
end;
$$;

-- Called by the server with the service client, because the visitor has no
-- session. Returns only what the acceptance page must render. Every failure —
-- unknown, revoked, accepted, expired — raises the SAME message: three distinct
-- ones would tell an attacker which guess landed close.
create or replace function public.validate_invitation(p_token_hash text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_inv  public.invitations;
  v_name text;
begin
  select * into v_inv
  from public.invitations
  where token_hash = p_token_hash
    and status = 'pending'
    and expires_at > now();

  if not found then
    raise exception 'invalid or expired invitation' using errcode = '42501';
  end if;

  select name into v_name from public.organizations where id = v_inv.organization_id;

  return jsonb_build_object(
    'invitation_id',     v_inv.id,
    'organization_id',   v_inv.organization_id,
    'organization_name', v_name,
    'email',             v_inv.email,
    'role',              v_inv.role
  );
end;
$$;

-- Creating the auth user is the Admin API; everything below is SQL, and there is
-- no transaction spanning the two. The caller creates the user first and deletes
-- it if this fails (services/invitations.ts) — the same compensating action as
-- provisioning.
--
-- This RE-VALIDATES rather than trusting whatever validate_invitation returned
-- earlier, and takes a row lock, so two simultaneous accepts of one link
-- serialize and only the first wins. Single-use is the database's guarantee, not
-- the click order's.
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
  select * into v_inv
  from public.invitations
  where token_hash = p_token_hash
    and status = 'pending'
    and expires_at > now()
  for update;

  if not found then
    raise exception 'invalid or expired invitation' using errcode = '42501';
  end if;

  insert into public.profiles (id, email, full_name)
  values (p_user_id, v_inv.email, nullif(trim(coalesce(p_full_name, '')), ''))
  on conflict (id) do nothing;

  insert into public.organization_memberships (user_id, organization_id, role)
  values (p_user_id, v_inv.organization_id, v_inv.role);

  -- Every Company in the Organization, at the invited role. Per-Company
  -- selection is Block 1c; with one Company per Organization this is exact.
  insert into public.company_memberships (user_id, company_id, role)
  select p_user_id, c.id, v_inv.role
  from public.companies c
  where c.organization_id = v_inv.organization_id
    and c.deleted_at is null;

  update public.invitations
     set status      = 'accepted',
         accepted_at = now(),
         accepted_by = p_user_id,
         updated_at  = now()
   where id = v_inv.id
     and status = 'pending';

  if not found then
    raise exception 'invitation was already accepted' using errcode = '23505';
  end if;

  insert into public.audit_logs
    (actor_id, action, target_table, target_id, organization_id, detail)
  values
    (p_user_id, 'accept_invitation', 'invitations', v_inv.id, v_inv.organization_id,
     jsonb_build_object('role', v_inv.role));

  return jsonb_build_object('organization_id', v_inv.organization_id);
end;
$$;

revoke execute on function public.create_invitation(uuid, text, public.member_role, text, integer) from public;
revoke execute on function public.revoke_invitation(uuid) from public;
revoke execute on function public.validate_invitation(text) from public;
revoke execute on function public.accept_invitation(text, uuid, text) from public;

-- Creating and revoking run as the calling Owner, because the RPCs re-check
-- has_org_permission against auth.uid().
grant execute on function public.create_invitation(uuid, text, public.member_role, text, integer) to authenticated;
grant execute on function public.revoke_invitation(uuid) to authenticated;

-- Validation and acceptance run server-side with the service client: the visitor
-- has no session. anon is granted nothing, so the only public write in the system
-- remains the contact form.
grant execute on function public.validate_invitation(text) to service_role;
grant execute on function public.accept_invitation(text, uuid, text) to service_role;
```

- [ ] **Step 2: Apply and commit**

Run: `npm run db:reset`
Expected: applies cleanly.

```bash
git add supabase/migrations/0013_invitation_rpcs.sql
git commit -m "feat(db): add invitation lifecycle RPCs"
```

---

## Task 5: RLS and grants for the new tables

**Files:**
- Create: `supabase/migrations/0014_rls_1b.sql`

**Interfaces:**
- Produces: RLS on `permissions`, `role_permissions`, `invitations`; an org-scoped `audit_logs` read policy.

- [ ] **Step 1: Write the migration**

`supabase/migrations/0014_rls_1b.sql`:

```sql
alter table public.permissions      enable row level security;
alter table public.role_permissions enable row level security;
alter table public.invitations      enable row level security;

revoke all on public.permissions      from anon, authenticated;
revoke all on public.role_permissions from anon, authenticated;
revoke all on public.invitations      from anon, authenticated;

-- The catalogue is reference data with no tenant column, and the UI needs it to
-- render what a role may do. `using (auth.uid() is not null)` rather than
-- `using (true)`: the ban on USING (true) exists to stop tenant tables leaking
-- across tenants, and stating the condition keeps the audit of policies uniform
-- — a reader never has to decide whether a bare `true` was reasoned about.
grant select on public.permissions      to authenticated;
grant select on public.role_permissions to authenticated;

create policy permissions_select_authenticated on public.permissions
  for select to authenticated
  using (auth.uid() is not null);

create policy role_permissions_select_authenticated on public.role_permissions
  for select to authenticated
  using (auth.uid() is not null);

-- invitations: this is where has_org_permission is exercised inside a real RLS
-- policy rather than only in RPC bodies. Without it, Block 2 would be the first
-- to discover whether the helper works in a policy, which is where it matters.
-- The table holds third parties' e-mail addresses, so the read is narrow.
grant select on public.invitations to authenticated;

create policy invitations_select_inviter on public.invitations
  for select to authenticated
  using (public.has_org_permission('users.invite', organization_id));

-- audit_logs stops being platform-admin-only. Policies OR together, so the 1a
-- admin policy still applies; this adds the Owner's view of their own trail and
-- gives audit.view something real to guard.
create policy audit_logs_select_org on public.audit_logs
  for select to authenticated
  using (
    organization_id is not null
    and public.has_org_permission('audit.view', organization_id)
  );

-- service_role needs explicit grants: the default ACL gives it only Dxtm and
-- BYPASSRLS does not substitute for a GRANT (Block 1a §3.9). It reads the
-- catalogue and nothing else here — invitations are reached only through the
-- SECURITY DEFINER RPCs, which run as the table owner.
grant select on public.permissions      to service_role;
grant select on public.role_permissions to service_role;
```

- [ ] **Step 2: Apply and verify the grants landed**

Run: `npm run db:reset`
Then:

```bash
docker exec -i supabase_db_CRM_-_LISTENER psql -U postgres -d postgres -c \
  "select has_table_privilege('authenticated','public.invitations','SELECT') as auth_select,
          has_table_privilege('authenticated','public.invitations','INSERT') as auth_insert,
          has_table_privilege('anon','public.invitations','SELECT')          as anon_select;"
```

Expected: `t | f | f`.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/0014_rls_1b.sql
git commit -m "feat(db): enable RLS on permissions and invitations"
```

---

## Task 6: pgTAP coverage

**Files:**
- Create: `supabase/tests/02_permissions.test.sql`

- [ ] **Step 1: Write the test**

`supabase/tests/02_permissions.test.sql`:

```sql
begin;
select plan(16);

select has_table('public', 'permissions', 'permissions exists');
select has_table('public', 'role_permissions', 'role_permissions exists');
select has_table('public', 'invitations', 'invitations exists');

select is(relrowsecurity, true, 'RLS enabled on invitations')
  from pg_class where oid = 'public.invitations'::regclass;
select is(relrowsecurity, true, 'RLS enabled on permissions')
  from pg_class where oid = 'public.permissions'::regclass;

-- The seed is the security policy of this block, so it is asserted, not assumed.
select ok(
  exists (select 1 from public.role_permissions
          where role = 'owner' and permission_code = 'users.invite'),
  'owner may invite'
);
select ok(
  not exists (select 1 from public.role_permissions
              where role = 'operator' and permission_code = 'users.invite'),
  'operator may not invite'
);
select ok(
  not exists (select 1 from public.role_permissions
              where role = 'viewer' and permission_code = 'users.manage'),
  'viewer may not manage members'
);
select is(
  (select count(*)::int from public.role_permissions where role in ('operator', 'viewer')),
  0,
  'operator and viewer hold no permissions in this block'
);

-- No client may write the catalogue or the invitations: both are RPC-only.
select ok(not has_table_privilege('authenticated', 'public.permissions', 'INSERT'),
          'authenticated may not write the permission catalogue');
select ok(not has_table_privilege('authenticated', 'public.role_permissions', 'UPDATE'),
          'authenticated may not rewrite role grants');
select ok(not has_table_privilege('authenticated', 'public.invitations', 'INSERT'),
          'authenticated may not insert invitations directly');
select ok(not has_table_privilege('anon', 'public.invitations', 'SELECT'),
          'anon may not read invitations');

-- anon must not reach any of the new privileged functions.
select ok(
  not has_function_privilege('anon', 'public.accept_invitation(text, uuid, text)', 'EXECUTE'),
  'anon may not call accept_invitation'
);
select ok(
  not has_function_privilege('anon', 'public.create_invitation(uuid, text, public.member_role, text, integer)', 'EXECUTE'),
  'anon may not call create_invitation'
);

-- Fail closed, with no session in play.
select is(public.has_permission('no.such.code', gen_random_uuid()), false,
          'an unknown permission code returns false');

select * from finish();
rollback;
```

- [ ] **Step 2: Run**

Run: `npm run db:reset` then `npm run db:test`
Expected: PASS — the Block 0 smoke test, the 1a suite, and these 16.

If the count is wrong, pgTAP reports `Looks like you planned N tests but ran M`.
Correct `plan(...)` to the number actually run rather than deleting assertions.

- [ ] **Step 3: Commit**

```bash
git add supabase/tests/02_permissions.test.sql
git commit -m "test(db): add pgTAP coverage for permissions and invitations"
```

---

## Task 7: Regenerate the database types

**Files:**
- Modify: `src/lib/supabase/database.types.ts`

- [ ] **Step 1: Regenerate**

Run: `npm run db:reset` then `npm run db:types`

- [ ] **Step 2: Confirm the new RPCs are typed**

Run:

```bash
grep -E 'accept_invitation|has_org_permission|change_member_role' src/lib/supabase/database.types.ts
```

Expected: all three appear under `Functions`.

- [ ] **Step 3: Verify the typing still engages**

Types silently stopped working once already in this project (Block 1a §3.3), so
re-run the probe rather than assuming. Create `probe-type.ts` in the repo root:

```ts
import { createUserClient } from '@/lib/supabase/user-client';
export async function probe() {
  return (await createUserClient()).from('no_such_table_1b');
}
```

Run: `npm run typecheck`
Expected: FAIL naming `no_such_table_1b`. Delete the file and re-run — PASS.
Report both outcomes.

- [ ] **Step 4: Commit**

```bash
git add src/lib/supabase/database.types.ts
git commit -m "chore: regenerate database types for Block 1b"
```

---

## Task 8: Isolation tests — privilege escalation

**Files:**
- Create: `tests/isolation/permissions.test.ts`

**Interfaces:**
- Consumes: `provisionCustomer()`, `signInAs()`, `createUser()`, `admin`, `cleanupUsers()` from `tests/isolation/harness.ts` (Block 1a).

This block's failure class is privilege escalation, as 1a's was tenant leakage.
These tests come before the UI so every later task is built against a suite that
already proves the boundary.

- [ ] **Step 1: Write the tests**

`tests/isolation/permissions.test.ts`:

```ts
import { describe, it, expect, afterAll } from 'vitest';
import { provisionCustomer, signInAs, createUser, cleanupUsers, admin } from './harness';

afterAll(async () => {
  await cleanupUsers();
});

/** Adds a second user to an existing Organization at the given role. */
async function addMember(
  organizationId: string,
  companyId: string,
  label: string,
  role: 'operator' | 'viewer' | 'owner',
) {
  const user = await createUser(`${role}-${label}@example.test`);
  const { error: orgError } = await admin
    .from('organization_memberships')
    .insert({ user_id: user.userId, organization_id: organizationId, role });
  if (orgError) throw new Error(`seed org membership: ${orgError.message}`);
  const { error: companyError } = await admin
    .from('company_memberships')
    .insert({ user_id: user.userId, company_id: companyId, role });
  if (companyError) throw new Error(`seed company membership: ${companyError.message}`);
  return user;
}

describe('permission helpers', () => {
  it('grants the owner what the seed says and denies the operator', async () => {
    const a = await provisionCustomer(`perm-${Date.now()}`);
    const ownerClient = await signInAs(a.email, a.password);

    const { data: ownerCan } = await ownerClient.rpc('has_org_permission', {
      p_permission: 'users.invite',
      p_organization_id: a.organizationId,
    });
    expect(ownerCan).toBe(true);

    const operator = await addMember(a.organizationId, a.companyId, `op-${Date.now()}`, 'operator');
    const operatorClient = await signInAs(operator.email, operator.password);

    const { data: operatorCan } = await operatorClient.rpc('has_org_permission', {
      p_permission: 'users.invite',
      p_organization_id: a.organizationId,
    });
    expect(operatorCan).toBe(false);
  });

  it('returns false for an unknown permission code, even for a platform admin', async () => {
    const a = await provisionCustomer(`closed-${Date.now()}`);

    // a.adminClient is the platform admin that provisioned this customer, so
    // is_platform_admin() is true — which is exactly the path where a naive
    // `is_platform_admin() or exists(...)` would short-circuit and return true
    // before the permission code was ever compared.
    const { data } = await a.adminClient.rpc('has_permission', {
      p_permission: 'totally.bogus.code',
      p_company_id: a.companyId,
    });
    expect(data).toBe(false);
  });

  it('grants a real permission to a platform admin on an active company', async () => {
    // The counterpart to the test above: the bypass must still work for a code
    // that exists, or the fail-closed fix would have broken admin access.
    const a = await provisionCustomer(`bypass-${Date.now()}`);
    const { data } = await a.adminClient.rpc('has_permission', {
      p_permission: 'users.manage',
      p_company_id: a.companyId,
    });
    expect(data).toBe(true);
  });

  it('yields no permissions on a suspended company, even to its owner', async () => {
    const a = await provisionCustomer(`susp-${Date.now()}`);
    const { error } = await a.adminClient.rpc('suspend_company', {
      p_company_id: a.companyId,
      p_reason: 'non-payment',
    });
    expect(error).toBeNull();

    const ownerClient = await signInAs(a.email, a.password);
    const { data } = await ownerClient.rpc('has_permission', {
      p_permission: 'users.manage',
      p_company_id: a.companyId,
    });
    expect(data).toBe(false);
  });
});

describe('member management', () => {
  it('refuses to remove the last owner', async () => {
    const a = await provisionCustomer(`last-${Date.now()}`);
    const ownerClient = await signInAs(a.email, a.password);

    const { data: membership } = await admin
      .from('organization_memberships')
      .select('id')
      .eq('organization_id', a.organizationId)
      .eq('user_id', a.userId)
      .single();
    if (!membership) throw new Error('provisioning left no owner membership');

    const { error } = await ownerClient.rpc('remove_member', {
      p_membership_id: membership.id,
    });

    expect(error).not.toBeNull();
    expect(error?.message).toMatch(/at least one owner/i);
  });

  it('refuses to demote the last owner', async () => {
    const a = await provisionCustomer(`demote-${Date.now()}`);
    const ownerClient = await signInAs(a.email, a.password);

    const { data: membership } = await admin
      .from('organization_memberships')
      .select('id')
      .eq('organization_id', a.organizationId)
      .eq('user_id', a.userId)
      .single();
    if (!membership) throw new Error('provisioning left no owner membership');

    const { error } = await ownerClient.rpc('change_member_role', {
      p_membership_id: membership.id,
      p_new_role: 'viewer',
    });

    expect(error).not.toBeNull();
    expect(error?.message).toMatch(/at least one owner/i);
  });

  it('an operator cannot change roles', async () => {
    const a = await provisionCustomer(`opmanage-${Date.now()}`);
    const operator = await addMember(
      a.organizationId,
      a.companyId,
      `mg-${Date.now()}`,
      'operator',
    );
    const operatorClient = await signInAs(operator.email, operator.password);

    const { data: victim } = await admin
      .from('organization_memberships')
      .select('id')
      .eq('user_id', a.userId)
      .single();
    if (!victim) throw new Error('no owner membership to target');

    const { error } = await operatorClient.rpc('change_member_role', {
      p_membership_id: victim.id,
      p_new_role: 'viewer',
    });

    expect(error).not.toBeNull();
    expect(error?.message).toMatch(/permission denied/i);
  });

  it('a removed member loses access on the next request', async () => {
    const a = await provisionCustomer(`revoke-${Date.now()}`);
    const viewer = await addMember(a.organizationId, a.companyId, `rv-${Date.now()}`, 'viewer');
    const viewerClient = await signInAs(viewer.email, viewer.password);

    const { data: before } = await viewerClient.from('companies').select('id');
    expect((before ?? []).map((r) => r.id)).toContain(a.companyId);

    const { data: membership } = await admin
      .from('organization_memberships')
      .select('id')
      .eq('user_id', viewer.userId)
      .single();
    if (!membership) throw new Error('no membership to remove');

    const ownerClient = await signInAs(a.email, a.password);
    const { error } = await ownerClient.rpc('remove_member', {
      p_membership_id: membership.id,
    });
    expect(error).toBeNull();

    // Same client, same JWT, no re-authentication: the helpers query the tables
    // on every check, so revocation is immediate.
    const { data: after } = await viewerClient.from('companies').select('id');
    expect(after ?? []).toEqual([]);
  });
});
```

- [ ] **Step 2: Run**

Run: `npm run db:reset` then `npm run test:isolation`
Expected: PASS — the 1a suites plus these 8.

- [ ] **Step 3: Prove the suite is not vacuous**

Temporarily edit `0010_permissions.sql`, deleting the line
`select exists (select 1 from public.permissions p where p.code = p_permission)` and
its trailing `and` from `has_permission`. Run `npm run db:reset` then
`npm run test:isolation`.
Expected: "returns false for an unknown permission code, even for a platform
admin" FAILS. Restore the line, re-run, expect PASS. Report both outcomes.

- [ ] **Step 4: Commit**

```bash
git add tests/isolation/permissions.test.ts
git commit -m "test: add privilege escalation coverage for permissions and members"
```

---

## Task 9: Invitation service

**Files:**
- Create: `src/schemas/invitations.ts`
- Create: `src/services/invitations.ts`
- Create: `tests/unit/invitation-token.test.ts`

**Interfaces:**
- Consumes: `createServiceClient` (Block 0), `PostgresRateLimiter` (Block 0), `mailer` (Block 0), the RPCs from Task 4.
- Produces: `generateInvitationToken(): string`; `hashInvitationToken(token: string): string`; `createInvitation(input, accessToken): Promise<{ invitationId: string; acceptUrl: string }>`; `revokeInvitation(id, accessToken): Promise<void>`; `validateInvitation(token): Promise<InvitationPreview | null>`; `acceptInvitation(input): Promise<{ organizationId: string }>`.

- [ ] **Step 1: Write the schema**

`src/schemas/invitations.ts`:

```ts
import { z } from 'zod';

export const createInvitationSchema = z.object({
  organizationId: z.string().uuid(),
  email: z.string().trim().toLowerCase().email(),
  role: z.enum(['owner', 'operator', 'viewer']),
});

export const acceptInvitationSchema = z
  .object({
    token: z.string().min(20),
    fullName: z.string().trim().min(2).max(120).optional(),
    // Mirrors minimum_password_length in supabase/config.toml.
    password: z.string().min(10).max(200),
    confirm: z.string(),
  })
  .refine((v) => v.password === v.confirm, {
    message: 'The two passwords do not match.',
    path: ['confirm'],
  });

export type CreateInvitationInput = z.infer<typeof createInvitationSchema>;
export type AcceptInvitationInput = z.infer<typeof acceptInvitationSchema>;
```

- [ ] **Step 2: Write the failing test**

`tests/unit/invitation-token.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { generateInvitationToken, hashInvitationToken } from '@/services/invitations';

describe('invitation tokens', () => {
  it('are long enough to resist guessing', () => {
    expect(generateInvitationToken().length).toBeGreaterThanOrEqual(32);
  });

  it('do not repeat across calls', () => {
    const seen = new Set(Array.from({ length: 100 }, () => generateInvitationToken()));
    expect(seen.size).toBe(100);
  });

  it('are URL-safe, since they travel in a link', () => {
    const joined = Array.from({ length: 50 }, () => generateInvitationToken()).join('');
    expect(joined).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('hash to a value that does not contain the token', () => {
    const token = generateInvitationToken();
    expect(hashInvitationToken(token)).not.toContain(token);
  });

  it('hash stably, so the lookup by hash finds the row', () => {
    const token = generateInvitationToken();
    expect(hashInvitationToken(token)).toBe(hashInvitationToken(token));
  });
});
```

- [ ] **Step 3: Run and see it fail**

Run: `npm run test`
Expected: FAIL — "Cannot find module '@/services/invitations'".

- [ ] **Step 4: Write the service**

`src/services/invitations.ts`:

```ts
import 'server-only';
import { createHash, randomBytes } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { createServiceClient } from '@/lib/supabase/service-client';
import { getUserSupabaseConfig } from '@/lib/supabase/config';
import { PostgresRateLimiter } from '@/lib/rate-limit';
import { DevMailer, SmtpMailer, type Mailer } from '@/lib/mailer';
import { env } from '@/lib/env';
import { InternalError, RateLimitError, UnauthorizedError, ValidationError } from '@/lib/errors';
import { logger } from '@/lib/logger';
import type { Database } from '@/lib/supabase/database.types';
import type { AcceptInvitationInput, CreateInvitationInput } from '@/schemas/invitations';

const ACCEPT_WINDOW_SECONDS = 3600;
const ACCEPT_MAX_PER_WINDOW = 10;

/** 32 bytes of CSPRNG, base64url so it survives a URL untouched. */
export function generateInvitationToken(): string {
  return randomBytes(32).toString('base64url');
}

/** Only this value reaches the database. A dump yields no working link. */
export function hashInvitationToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function resolveMailer(): Mailer {
  if (env.SMTP_URL && env.MAIL_FROM) return new SmtpMailer(env.SMTP_URL, env.MAIL_FROM);
  return new DevMailer();
}

function siteUrl(): string {
  return process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3000';
}

/**
 * A client bound to the caller's JWT. create_invitation re-checks
 * has_org_permission against auth.uid(), so calling it with the service key
 * would defeat the check it exists to make.
 */
function createUserScopedClient(accessToken: string) {
  const { url, anonKey } = getUserSupabaseConfig();
  return createClient<Database>(url, anonKey, {
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

export interface InvitationPreview {
  invitationId: string;
  organizationId: string;
  organizationName: string;
  email: string;
  role: 'owner' | 'operator' | 'viewer';
}

export async function createInvitation(
  input: CreateInvitationInput,
  accessToken: string,
): Promise<{ invitationId: string; acceptUrl: string }> {
  const token = generateInvitationToken();

  const asOwner = createUserScopedClient(accessToken);
  const { data, error } = await asOwner.rpc('create_invitation', {
    p_organization_id: input.organizationId,
    p_email: input.email,
    p_role: input.role,
    p_token_hash: hashInvitationToken(token),
    p_ttl_days: 7,
  });

  if (error) {
    // 23505 is the "already has an account" and "already invited" case; both are
    // the inviter's mistake, not a server fault.
    if (error.code === '23505') throw new ValidationError(error.message);
    throw new UnauthorizedError(`Could not create the invitation: ${error.message}`);
  }
  if (typeof data !== 'string') {
    throw new InternalError('create_invitation returned no id');
  }

  const acceptUrl = `${siteUrl()}/invite/${token}`;

  // Storage is the source of truth; delivery is best effort. A failed e-mail
  // must not lose the invitation — the caller shows the link for manual relay.
  try {
    await resolveMailer().send({
      to: input.email,
      subject: 'You have been invited to PulchatX',
      text: [
        'You have been invited to join a PulchatX account.',
        '',
        `Open this link to choose your password: ${acceptUrl}`,
        '',
        'The link expires in 7 days.',
      ].join('\n'),
    });
  } catch (cause) {
    // The token is deliberately absent from this log line.
    logger.error({ err: cause, invitationId: data }, 'invitation stored but e-mail failed');
  }

  return { invitationId: data, acceptUrl };
}

export async function revokeInvitation(invitationId: string, accessToken: string): Promise<void> {
  const asOwner = createUserScopedClient(accessToken);
  const { error } = await asOwner.rpc('revoke_invitation', { p_invitation_id: invitationId });
  if (error) throw new UnauthorizedError(`Could not revoke the invitation: ${error.message}`);
}

/**
 * Returns null for every failure — unknown, revoked, accepted, expired — so the
 * page renders one message for all of them. Distinct messages would tell an
 * attacker which guess landed close.
 */
export async function validateInvitation(token: string): Promise<InvitationPreview | null> {
  const admin = createServiceClient();
  const { data, error } = await admin.rpc('validate_invitation', {
    p_token_hash: hashInvitationToken(token),
  });
  if (error || !data) return null;

  const row = data as {
    invitation_id: string;
    organization_id: string;
    organization_name: string;
    email: string;
    role: 'owner' | 'operator' | 'viewer';
  };
  return {
    invitationId: row.invitation_id,
    organizationId: row.organization_id,
    organizationName: row.organization_name,
    email: row.email,
    role: row.role,
  };
}

/**
 * Creating the auth user is the Admin API; creating the memberships is SQL, with
 * no transaction spanning the two. If the RPC fails after the user exists we
 * would leave someone who can authenticate and belongs to no tenant — hence the
 * compensating delete, as in provisioning.
 *
 * The account is created with the invitation's e-mail, never one the visitor
 * typed: otherwise a valid token would mint an account for any address.
 */
export async function acceptInvitation(
  input: AcceptInvitationInput,
  ipAddress: string,
): Promise<{ organizationId: string }> {
  const admin = createServiceClient();

  const limiter = new PostgresRateLimiter(admin);
  const verdict = await limiter.check(
    `invite-accept:${createHash('sha256').update(ipAddress).digest('hex').slice(0, 32)}`,
    ACCEPT_MAX_PER_WINDOW,
    ACCEPT_WINDOW_SECONDS,
  );
  if (!verdict.allowed) {
    throw new RateLimitError('Too many attempts. Please try again later.');
  }

  const preview = await validateInvitation(input.token);
  if (!preview) throw new ValidationError('This invitation is no longer valid.');

  const { data: created, error: createError } = await admin.auth.admin.createUser({
    email: preview.email,
    password: input.password,
    email_confirm: true,
    user_metadata: input.fullName ? { full_name: input.fullName } : undefined,
  });
  if (createError || !created.user) {
    throw new ValidationError(`Could not create the account: ${createError?.message ?? 'unknown'}`);
  }

  const userId = created.user.id;

  try {
    const { data, error } = await admin.rpc('accept_invitation', {
      p_token_hash: hashInvitationToken(input.token),
      p_user_id: userId,
      p_full_name: input.fullName ?? null,
    });
    if (error) throw new Error(error.message);

    const result = data as { organization_id: string };
    return { organizationId: result.organization_id };
  } catch (cause) {
    await admin.auth.admin.deleteUser(userId).catch(() => {
      logger.error({ userId }, 'orphaned auth user could not be deleted after failed acceptance');
    });
    throw new InternalError('Could not accept the invitation', { cause });
  }
}
```

- [ ] **Step 5: Run and see it pass**

Run: `npm run test` then `npm run typecheck` then `npm run lint`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add src/schemas/invitations.ts src/services/invitations.ts tests/unit/invitation-token.test.ts
git commit -m "feat: add invitation service with hashed tokens"
```

---

## Task 10: Invitation isolation tests

**Files:**
- Create: `tests/isolation/invitations.test.ts`

**Interfaces:**
- Consumes: the harness, the RPCs from Task 4, `hashInvitationToken` (Task 9).

- [ ] **Step 1: Write the tests**

`tests/isolation/invitations.test.ts`:

```ts
import { describe, it, expect, afterAll } from 'vitest';
import { randomBytes } from 'node:crypto';
import { provisionCustomer, signInAs, createUser, cleanupUsers, admin } from './harness';
import { hashInvitationToken } from '@/services/invitations';

afterAll(async () => {
  await cleanupUsers();
});

function freshToken(): string {
  return randomBytes(32).toString('base64url');
}

describe('invitations', () => {
  it('an owner can create one and an operator cannot', async () => {
    const a = await provisionCustomer(`inv-${Date.now()}`);
    const ownerClient = await signInAs(a.email, a.password);

    const { data: id, error } = await ownerClient.rpc('create_invitation', {
      p_organization_id: a.organizationId,
      p_email: `guest-${Date.now()}@example.test`,
      p_role: 'operator',
      p_token_hash: hashInvitationToken(freshToken()),
      p_ttl_days: 7,
    });
    expect(error).toBeNull();
    expect(id).toBeTruthy();

    const operator = await createUser(`op-${Date.now()}@example.test`);
    await admin
      .from('organization_memberships')
      .insert({ user_id: operator.userId, organization_id: a.organizationId, role: 'operator' });
    const operatorClient = await signInAs(operator.email, operator.password);

    const { error: denied } = await operatorClient.rpc('create_invitation', {
      p_organization_id: a.organizationId,
      p_email: `nope-${Date.now()}@example.test`,
      p_role: 'viewer',
      p_token_hash: hashInvitationToken(freshToken()),
      p_ttl_days: 7,
    });
    expect(denied).not.toBeNull();
    expect(denied?.message).toMatch(/permission denied/i);
  });

  it('refuses an e-mail that already has an account', async () => {
    const a = await provisionCustomer(`dup-${Date.now()}`);
    const ownerClient = await signInAs(a.email, a.password);

    const { error } = await ownerClient.rpc('create_invitation', {
      p_organization_id: a.organizationId,
      p_email: a.email,
      p_role: 'viewer',
      p_token_hash: hashInvitationToken(freshToken()),
      p_ttl_days: 7,
    });

    expect(error).not.toBeNull();
    expect(error?.message).toMatch(/already has an account/i);
  });

  it('one organization cannot read another organization invitations', async () => {
    const a = await provisionCustomer(`ra-${Date.now()}`);
    const b = await provisionCustomer(`rb-${Date.now()}`);

    const ownerA = await signInAs(a.email, a.password);
    await ownerA.rpc('create_invitation', {
      p_organization_id: a.organizationId,
      p_email: `secret-${Date.now()}@example.test`,
      p_role: 'viewer',
      p_token_hash: hashInvitationToken(freshToken()),
      p_ttl_days: 7,
    });

    const ownerB = await signInAs(b.email, b.password);
    const { data } = await ownerB.from('invitations').select('id, email');
    expect(data ?? []).toEqual([]);
  });

  it('a revoked invitation cannot be accepted', async () => {
    const a = await provisionCustomer(`rev-${Date.now()}`);
    const ownerClient = await signInAs(a.email, a.password);
    const token = freshToken();

    const { data: id } = await ownerClient.rpc('create_invitation', {
      p_organization_id: a.organizationId,
      p_email: `revoked-${Date.now()}@example.test`,
      p_role: 'viewer',
      p_token_hash: hashInvitationToken(token),
      p_ttl_days: 7,
    });
    await ownerClient.rpc('revoke_invitation', { p_invitation_id: String(id) });

    const invitee = await createUser(`ri-${Date.now()}@example.test`);
    const { error } = await admin.rpc('accept_invitation', {
      p_token_hash: hashInvitationToken(token),
      p_user_id: invitee.userId,
      p_full_name: null,
    });

    expect(error).not.toBeNull();
    expect(error?.message).toMatch(/invalid or expired/i);
  });

  it('an expired invitation cannot be accepted', async () => {
    const a = await provisionCustomer(`exp-${Date.now()}`);
    const ownerClient = await signInAs(a.email, a.password);
    const token = freshToken();

    const { data: id } = await ownerClient.rpc('create_invitation', {
      p_organization_id: a.organizationId,
      p_email: `expired-${Date.now()}@example.test`,
      p_role: 'viewer',
      p_token_hash: hashInvitationToken(token),
      p_ttl_days: 7,
    });

    // Age it past its expiry. Service role writes invitations only in tests;
    // the application always goes through the RPCs.
    const { error: ageError } = await admin
      .from('invitations')
      .update({ expires_at: new Date(Date.now() - 1000).toISOString() })
      .eq('id', String(id));
    expect(ageError).toBeNull();

    const invitee = await createUser(`ei-${Date.now()}@example.test`);
    const { error } = await admin.rpc('accept_invitation', {
      p_token_hash: hashInvitationToken(token),
      p_user_id: invitee.userId,
      p_full_name: null,
    });

    expect(error).not.toBeNull();
    expect(error?.message).toMatch(/invalid or expired/i);
  });

  it('cannot be accepted twice', async () => {
    const a = await provisionCustomer(`twice-${Date.now()}`);
    const ownerClient = await signInAs(a.email, a.password);
    const token = freshToken();

    await ownerClient.rpc('create_invitation', {
      p_organization_id: a.organizationId,
      p_email: `once-${Date.now()}@example.test`,
      p_role: 'viewer',
      p_token_hash: hashInvitationToken(token),
      p_ttl_days: 7,
    });

    const first = await createUser(`f1-${Date.now()}@example.test`);
    const { error: firstError } = await admin.rpc('accept_invitation', {
      p_token_hash: hashInvitationToken(token),
      p_user_id: first.userId,
      p_full_name: null,
    });
    expect(firstError).toBeNull();

    const second = await createUser(`f2-${Date.now()}@example.test`);
    const { error: secondError } = await admin.rpc('accept_invitation', {
      p_token_hash: hashInvitationToken(token),
      p_user_id: second.userId,
      p_full_name: null,
    });
    expect(secondError).not.toBeNull();
  });

  it('acceptance grants membership at the invited role', async () => {
    const a = await provisionCustomer(`grant-${Date.now()}`);
    const ownerClient = await signInAs(a.email, a.password);
    const token = freshToken();

    await ownerClient.rpc('create_invitation', {
      p_organization_id: a.organizationId,
      p_email: `granted-${Date.now()}@example.test`,
      p_role: 'operator',
      p_token_hash: hashInvitationToken(token),
      p_ttl_days: 7,
    });

    const invitee = await createUser(`gi-${Date.now()}@example.test`);
    const { error } = await admin.rpc('accept_invitation', {
      p_token_hash: hashInvitationToken(token),
      p_user_id: invitee.userId,
      p_full_name: 'Granted Person',
    });
    expect(error).toBeNull();

    const inviteeClient = await signInAs(invitee.email, invitee.password);
    const { data: companies } = await inviteeClient.from('companies').select('id');
    expect((companies ?? []).map((r) => r.id)).toContain(a.companyId);

    const { data: canInvite } = await inviteeClient.rpc('has_org_permission', {
      p_permission: 'users.invite',
      p_organization_id: a.organizationId,
    });
    expect(canInvite).toBe(false);
  });
});
```

- [ ] **Step 2: Run**

Run: `npm run db:reset` then `npm run test:isolation`
Expected: PASS — everything from 1a, Task 8, and these 7.

Note: `createUser` in the harness inserts a `profiles` row, and
`accept_invitation` uses `on conflict (id) do nothing`, so seeding an invitee this
way is safe.

- [ ] **Step 3: Commit**

```bash
git add tests/isolation/invitations.test.ts
git commit -m "test: add invitation lifecycle isolation coverage"
```

---

## Task 11: The team screen

**Files:**
- Create: `src/app/(app)/team/page.tsx`, `src/app/(app)/team/actions.ts`, `src/app/(app)/team/invite-form.tsx`
- Modify: `src/app/(app)/app/page.tsx` (link to the team screen)

**Interfaces:**
- Consumes: `createInvitation`, `revokeInvitation` (Task 9); `change_member_role`, `remove_member` (Task 2).

- [ ] **Step 1: Write the server actions**

`src/app/(app)/team/actions.ts`:

```ts
'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { createUserClient } from '@/lib/supabase/user-client';
import { createInvitationSchema } from '@/schemas/invitations';
import { createInvitation, revokeInvitation } from '@/services/invitations';
import { logger } from '@/lib/logger';

/**
 * The accept URL is returned through the action result and shown once, never put
 * in a redirect query string: a URL reaches browser history and every proxy
 * access log in front of the app. Same rule as the provisional password in 1a.
 */
export interface InviteState {
  status: 'idle' | 'revealed' | 'error';
  email?: string;
  acceptUrl?: string;
  message?: string;
}

async function requireAccessToken(): Promise<string> {
  const supabase = await createUserClient();
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) redirect('/login');
  return token;
}

export async function inviteAction(_prev: InviteState, formData: FormData): Promise<InviteState> {
  const parsed = createInvitationSchema.safeParse({
    organizationId: formData.get('organizationId'),
    email: formData.get('email'),
    role: formData.get('role'),
  });

  if (!parsed.success) {
    return { status: 'error', message: 'Check the address and the role.' };
  }

  const token = await requireAccessToken();

  try {
    const result = await createInvitation(parsed.data, token);
    revalidatePath('/team');
    return { status: 'revealed', email: parsed.data.email, acceptUrl: result.acceptUrl };
  } catch (cause) {
    logger.error({ err: cause }, 'invitation failed');
    const message =
      cause instanceof Error && /already has an account|already/i.test(cause.message)
        ? 'That address already has an account or a pending invitation.'
        : 'Could not send the invitation.';
    return { status: 'error', message };
  }
}

export async function revokeAction(formData: FormData): Promise<void> {
  const token = await requireAccessToken();
  try {
    await revokeInvitation(String(formData.get('invitationId')), token);
  } catch (cause) {
    logger.error({ err: cause }, 'revoke failed');
  }
  revalidatePath('/team');
}

export async function changeRoleAction(formData: FormData): Promise<void> {
  const supabase = await createUserClient();
  const { error } = await supabase.rpc('change_member_role', {
    p_membership_id: String(formData.get('membershipId')),
    p_new_role: String(formData.get('role')) as 'owner' | 'operator' | 'viewer',
  });
  if (error) logger.error({ err: error }, 'change_member_role failed');
  revalidatePath('/team');
}

export async function removeMemberAction(formData: FormData): Promise<void> {
  const supabase = await createUserClient();
  const { error } = await supabase.rpc('remove_member', {
    p_membership_id: String(formData.get('membershipId')),
  });
  if (error) logger.error({ err: error }, 'remove_member failed');
  revalidatePath('/team');
}
```

- [ ] **Step 2: Write the invite form**

`src/app/(app)/team/invite-form.tsx`:

```tsx
'use client';

import { useActionState } from 'react';
import { inviteAction, type InviteState } from './actions';
import { Button } from '@/components/ui/button';

const INITIAL: InviteState = { status: 'idle' };

export function InviteForm({ organizationId }: { organizationId: string }) {
  const [state, action, pending] = useActionState(inviteAction, INITIAL);

  return (
    <div className="flex flex-col gap-4">
      {state.status === 'error' ? (
        <p className="text-sm text-destructive">{state.message}</p>
      ) : null}

      {state.status === 'revealed' && state.acceptUrl ? (
        <div className="rounded-md border border-primary p-4">
          <p className="text-sm">
            Invitation sent to <strong>{state.email}</strong>. If the e-mail does not arrive, share
            this link directly:
          </p>
          <code className="mt-2 block break-all text-sm">{state.acceptUrl}</code>
          <p className="mt-2 text-sm text-muted-foreground">
            It expires in 7 days and can be used once. It cannot be shown again — if it is lost,
            revoke the invitation and send a new one.
          </p>
        </div>
      ) : null}

      <form action={action} className="flex flex-col gap-3">
        <input type="hidden" name="organizationId" value={organizationId} />
        <input
          name="email"
          type="email"
          placeholder="Colleague's e-mail"
          required
          className="rounded-md border p-2"
        />
        <select name="role" defaultValue="operator" className="rounded-md border p-2">
          <option value="operator">Operator</option>
          <option value="viewer">Viewer</option>
          <option value="owner">Owner</option>
        </select>
        <Button type="submit" disabled={pending}>
          {pending ? 'Sending…' : 'Send invitation'}
        </Button>
      </form>
    </div>
  );
}
```

- [ ] **Step 3: Write the page**

`src/app/(app)/team/page.tsx`:

```tsx
import { createUserClient } from '@/lib/supabase/user-client';
import { logger } from '@/lib/logger';
import { Button } from '@/components/ui/button';
import { changeRoleAction, removeMemberAction, revokeAction } from './actions';
import { InviteForm } from './invite-form';

// Renders from the caller's session cookies, so it can never be static.
export const dynamic = 'force-dynamic';

export default async function TeamPage() {
  const supabase = await createUserClient();

  const { data: memberships, error: membershipsError } = await supabase
    .from('organization_memberships')
    .select('id, user_id, role, organization_id')
    .order('created_at', { ascending: true });

  if (membershipsError) logger.error({ err: membershipsError }, 'could not load memberships');

  const organizationId = memberships?.[0]?.organization_id;

  // Two queries joined in JS, not a PostgREST embed: organization_memberships
  // and profiles both reference auth.users, so there is no foreign key for an
  // embed to travel along and it would fail with PGRST200 (Block 1a review).
  const userIds = [...new Set((memberships ?? []).map((m) => m.user_id))];
  const { data: profiles, error: profilesError } = userIds.length
    ? await supabase.from('profiles').select('id, email, full_name').in('id', userIds)
    : { data: [], error: null };

  if (profilesError) logger.error({ err: profilesError }, 'could not load member profiles');

  const profileByUser = new Map((profiles ?? []).map((p) => [p.id, p]));

  const { data: invitations } = await supabase
    .from('invitations')
    .select('id, email, role, status, expires_at')
    .eq('status', 'pending')
    .order('created_at', { ascending: false });

  if (!organizationId) {
    return (
      <main className="flex flex-col gap-4">
        <h1 className="text-2xl font-semibold">Team</h1>
        <p className="text-muted-foreground">You do not belong to an organization yet.</p>
      </main>
    );
  }

  return (
    <main className="flex flex-col gap-10">
      <section className="flex flex-col gap-4">
        <h1 className="text-2xl font-semibold">Invite a colleague</h1>
        <InviteForm organizationId={organizationId} />
      </section>

      <section className="flex flex-col gap-4">
        <h2 className="text-xl font-semibold">Members</h2>
        <ul className="flex flex-col gap-2">
          {(memberships ?? []).map((m) => {
            const profile = profileByUser.get(m.user_id);
            return (
              <li key={m.id} className="flex items-center justify-between gap-4 rounded-md border p-3">
                <span className="text-sm">
                  {profile?.full_name ? `${profile.full_name} — ` : ''}
                  {profile?.email ?? m.user_id} — <em>{m.role}</em>
                </span>
                <div className="flex items-center gap-2">
                  <form action={changeRoleAction} className="flex items-center gap-2">
                    <input type="hidden" name="membershipId" value={m.id} />
                    <select name="role" defaultValue={m.role} className="rounded border p-1 text-sm">
                      <option value="owner">Owner</option>
                      <option value="operator">Operator</option>
                      <option value="viewer">Viewer</option>
                    </select>
                    <Button type="submit" variant="outline">
                      Save
                    </Button>
                  </form>
                  <form action={removeMemberAction}>
                    <input type="hidden" name="membershipId" value={m.id} />
                    <Button type="submit" variant="outline">
                      Remove
                    </Button>
                  </form>
                </div>
              </li>
            );
          })}
        </ul>
      </section>

      <section className="flex flex-col gap-4">
        <h2 className="text-xl font-semibold">Pending invitations</h2>
        {(invitations ?? []).length === 0 ? (
          <p className="text-muted-foreground">None.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {(invitations ?? []).map((i) => (
              <li key={i.id} className="flex items-center justify-between gap-4 rounded-md border p-3">
                <span className="text-sm">
                  {i.email} — <em>{i.role}</em> — expires{' '}
                  {new Date(i.expires_at).toLocaleDateString('en-GB')}
                </span>
                <form action={revokeAction}>
                  <input type="hidden" name="invitationId" value={i.id} />
                  <Button type="submit" variant="outline">
                    Revoke
                  </Button>
                </form>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
```

- [ ] **Step 4: Link it from the member home**

In `src/app/(app)/app/page.tsx`, inside the `<header>` block and next to the
sign-out form, add:

```tsx
        <Link href="/team" className="text-sm underline">
          Team
        </Link>
```

`Link` is already imported in that file.

- [ ] **Step 5: Verify**

Run: `npm run lint`, `npm run typecheck`, then
`SKIP_ENV_VALIDATION=1 npm run build`.
Expected: all PASS, with `/team` listed as `ƒ` in the build output.

If typecheck reports that `/team` is not a valid route, run the build first — typed
routes are regenerated at build time.

- [ ] **Step 6: Commit**

```bash
git add "src/app/(app)"
git commit -m "feat(team): add member and invitation management screen"
```

---

## Task 12: The acceptance page

**Files:**
- Create: `src/app/(public)/invite/[token]/page.tsx`
- Modify: `src/middleware.ts`

**Interfaces:**
- Consumes: `validateInvitation`, `acceptInvitation` (Task 9).

- [ ] **Step 1: Let the middleware through**

In `src/middleware.ts`, the `PUBLIC_PATHS` array is an exact-match list, so a
dynamic segment cannot be added to it. Replace the `!user` branch's condition:

```ts
  const isPublic = PUBLIC_PATHS.includes(path) || path.startsWith('/invite/');

  if (!user) {
    if (isPublic) return response;
    return NextResponse.redirect(new URL('/login', request.url));
  }
```

Add above `PUBLIC_PATHS`:

```ts
// `/invite/<token>` is public and prefix-matched: the invitee has no session
// yet, and bouncing them to /login would strand the invitation.
```

- [ ] **Step 2: Write the page**

`src/app/(public)/invite/[token]/page.tsx`:

```tsx
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { acceptInvitationSchema } from '@/schemas/invitations';
import { acceptInvitation, validateInvitation } from '@/services/invitations';
import { logger } from '@/lib/logger';
import { Button } from '@/components/ui/button';

export const dynamic = 'force-dynamic';

const MESSAGES: Record<string, string> = {
  invalid: 'Please check the fields and try again.',
  short: 'The password must be at least 10 characters.',
  mismatch: 'The two passwords do not match.',
  failed: 'Could not complete the invitation. Please ask for a new one.',
};

export default async function AcceptInvitationPage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { token } = await params;
  const query = await searchParams;

  const preview = await validateInvitation(token);

  // One message for unknown, revoked, accepted and expired alike. Three distinct
  // ones would tell an attacker which guess landed close.
  if (!preview) {
    return (
      <main className="flex flex-col gap-4">
        <h1 className="text-2xl font-semibold">This invitation is not valid</h1>
        <p className="text-muted-foreground">
          The link may have expired, been revoked, or already been used. Please ask whoever invited
          you to send a new one.
        </p>
      </main>
    );
  }

  async function accept(formData: FormData) {
    'use server';
    const parsed = acceptInvitationSchema.safeParse({
      token,
      fullName: formData.get('fullName') || undefined,
      password: String(formData.get('password') ?? ''),
      confirm: String(formData.get('confirm') ?? ''),
    });

    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const code = issue?.path.includes('confirm')
        ? 'mismatch'
        : issue?.path.includes('password')
          ? 'short'
          : 'invalid';
      redirect(`/invite/${token}?error=${code}`);
    }

    const headerList = await headers();
    const ip = headerList.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';

    // redirect() signals by throwing, so the success path stays outside the
    // catch — inside, a successful acceptance would be reported as a failure.
    let destination = '/login?invited=1';
    try {
      await acceptInvitation(parsed.data, ip);
    } catch (cause) {
      logger.error({ err: cause }, 'invitation acceptance failed');
      destination = `/invite/${token}?error=failed`;
    }
    redirect(destination);
  }

  return (
    <main className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold">Join {preview.organizationName}</h1>
      <p className="text-muted-foreground">
        You were invited as <strong>{preview.role}</strong> using{' '}
        <strong>{preview.email}</strong>. Choose a password to create your account.
      </p>
      {query.error ? (
        <p className="text-sm text-destructive">{MESSAGES[query.error] ?? MESSAGES.failed}</p>
      ) : null}
      <form action={accept} className="flex flex-col gap-4">
        <input name="fullName" placeholder="Your name (optional)" className="rounded-md border p-2" />
        <input
          name="password"
          type="password"
          placeholder="Choose a password"
          required
          className="rounded-md border p-2"
        />
        <input
          name="confirm"
          type="password"
          placeholder="Repeat the password"
          required
          className="rounded-md border p-2"
        />
        <Button type="submit">Create my account</Button>
      </form>
    </main>
  );
}
```

- [ ] **Step 3: Show a confirmation on the login page**

In `src/app/(public)/login/page.tsx`, widen the `searchParams` type to
`Promise<{ error?: string; invited?: string }>` and add above the error paragraph:

```tsx
      {params.invited ? (
        <p className="text-sm text-muted-foreground">
          Your account is ready. Sign in with the password you just chose.
        </p>
      ) : null}
```

- [ ] **Step 4: Verify**

Run: `npm run lint`, `npm run typecheck`, `SKIP_ENV_VALIDATION=1 npm run build`.
Expected: all PASS, with `/invite/[token]` listed in the build output.

- [ ] **Step 5: Commit**

```bash
git add "src/app/(public)/invite" "src/app/(public)/login/page.tsx" src/middleware.ts
git commit -m "feat(invite): add the public invitation acceptance page"
```

---

## Task 13: End-to-end invitation flow

**Files:**
- Create: `tests/e2e/invitation-flow.spec.ts`

- [ ] **Step 1: Write the test**

`tests/e2e/invitation-flow.spec.ts`:

```ts
import { test, expect } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { LOCAL_SUPABASE_URL, LOCAL_SUPABASE_SERVICE_ROLE_KEY } from '../local-supabase';

/**
 * The whole invitation journey through the real UI: an Owner invites, the link
 * is revealed once, a fresh browser context opens it, the invitee chooses a
 * password, signs in, and lands in the app as a member.
 */
const admin = createClient(LOCAL_SUPABASE_URL, LOCAL_SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const stamp = Date.now();
const platformAdminEmail = `e2e-inv-admin-${stamp}@example.test`;
const platformAdminPassword = `E2e-inv-admin-${stamp}-pw`;
const ownerEmail = `e2e-inv-owner-${stamp}@example.test`;
const inviteeEmail = `e2e-invitee-${stamp}@example.test`;
const inviteePassword = `Invitee-${stamp}-pw`;
const createdUserIds: string[] = [];

test.beforeAll(async () => {
  const { data, error } = await admin.auth.admin.createUser({
    email: platformAdminEmail,
    password: platformAdminPassword,
    email_confirm: true,
  });
  if (error || !data.user) throw new Error(`could not create admin: ${error?.message}`);
  createdUserIds.push(data.user.id);
  await admin.from('profiles').insert({ id: data.user.id, email: platformAdminEmail });
  await admin.from('platform_admins').insert({ user_id: data.user.id });
});

test.afterAll(async () => {
  for (const id of createdUserIds) await admin.auth.admin.deleteUser(id);
});

test('an owner invites a colleague who joins with their own password', async ({ page }) => {
  // --- provision an Owner to do the inviting ------------------------------
  await page.goto('/login');
  await page.getByPlaceholder('E-mail').fill(platformAdminEmail);
  await page.getByPlaceholder('Password').fill(platformAdminPassword);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/app$/);

  await page.getByRole('link', { name: /admin console/i }).click();
  await page.getByPlaceholder('Organization name').fill(`Invite Org ${stamp}`);
  await page.getByPlaceholder('Company (Station) name').fill(`Invite Station ${stamp}`);
  await page.getByPlaceholder('Owner e-mail').fill(ownerEmail);
  await page.getByRole('button', { name: 'Provision' }).click();

  const revealed = page.locator('code').first();
  await expect(revealed).toBeVisible({ timeout: 15_000 });
  const ownerPassword = (await revealed.innerText()).trim();

  const { data: ownerProfile, error: ownerLookupError } = await admin
    .from('profiles')
    .select('id')
    .eq('email', ownerEmail)
    .single();
  expect(ownerLookupError).toBeNull();
  if (!ownerProfile) throw new Error(`no profile row for ${ownerEmail}`);
  createdUserIds.push(ownerProfile.id);

  // --- the Owner signs in, clears the gate, and invites --------------------
  const ownerContext = await page.context().browser()!.newContext();
  const ownerPage = await ownerContext.newPage();

  await ownerPage.goto('/login');
  await ownerPage.getByPlaceholder('E-mail').fill(ownerEmail);
  await ownerPage.getByPlaceholder('Password').fill(ownerPassword);
  await ownerPage.getByRole('button', { name: 'Sign in' }).click();
  await expect(ownerPage).toHaveURL(/\/change-password$/);

  const chosen = `Owner-${stamp}-chosen`;
  await ownerPage.getByPlaceholder('New password').fill(chosen);
  await ownerPage.getByPlaceholder('Repeat the password').fill(chosen);
  await ownerPage.getByRole('button', { name: 'Save' }).click();
  await expect(ownerPage).toHaveURL(/\/app$/);

  await ownerPage.getByRole('link', { name: 'Team' }).click();
  await expect(ownerPage).toHaveURL(/\/team$/);

  await ownerPage.getByPlaceholder("Colleague's e-mail").fill(inviteeEmail);
  await ownerPage.getByRole('button', { name: 'Send invitation' }).click();

  const linkBox = ownerPage.locator('code').first();
  await expect(linkBox).toBeVisible({ timeout: 15_000 });
  const acceptUrl = (await linkBox.innerText()).trim();
  expect(acceptUrl).toContain('/invite/');

  // The token must never have travelled in the page URL.
  expect(ownerPage.url()).not.toContain('/invite/');

  // --- the invitee accepts in a fresh context ------------------------------
  const inviteeContext = await page.context().browser()!.newContext();
  const inviteePage = await inviteeContext.newPage();

  await inviteePage.goto(acceptUrl);
  await expect(inviteePage.getByRole('heading', { name: /Join Invite Org/ })).toBeVisible();

  await inviteePage.getByPlaceholder('Choose a password').fill(inviteePassword);
  await inviteePage.getByPlaceholder('Repeat the password').fill(inviteePassword);
  await inviteePage.getByRole('button', { name: 'Create my account' }).click();

  await expect(inviteePage).toHaveURL(/\/login/);

  const { data: inviteeProfile } = await admin
    .from('profiles')
    .select('id')
    .eq('email', inviteeEmail)
    .single();
  if (inviteeProfile) createdUserIds.push(inviteeProfile.id);

  // --- the invitee signs in with the password they chose -------------------
  await inviteePage.getByPlaceholder('E-mail').fill(inviteeEmail);
  await inviteePage.getByPlaceholder('Password').fill(inviteePassword);
  await inviteePage.getByRole('button', { name: 'Sign in' }).click();

  // Straight to /app: they chose their own password, so there is no gate.
  await expect(inviteePage).toHaveURL(/\/app$/);
  await expect(inviteePage.getByText(`Invite Station ${stamp}`)).toBeVisible();

  // --- the link is single-use ----------------------------------------------
  const secondTry = await inviteeContext.newPage();
  await secondTry.goto(acceptUrl);
  await expect(secondTry.getByRole('heading', { name: /not valid/i })).toBeVisible();

  await inviteeContext.close();
  await ownerContext.close();
});
```

- [ ] **Step 2: Run**

Run: `npm run db:reset` then `npm run test:e2e`
Expected: PASS — the 1a specs plus this one.

- [ ] **Step 3: Commit**

```bash
git add tests/e2e/invitation-flow.spec.ts
git commit -m "test(e2e): cover the invitation journey end to end"
```

---

## Task 14: Verification and report

**Files:**
- Create: `docs/block-1b-report.md`
- Modify: `docs/block-1a-report.md` — mark §5 item 2 (the contact-request e-mail notification) still open, and record that the rate limiter now has a second consumer

- [ ] **Step 1: Run the whole gate**

Run each separately and capture verbatim output:
- `npm run lint`
- `npm run typecheck`
- `npm run test`
- `npm run db:reset`
- `npm run db:test`
- `npm run test:isolation`
- `npm run test:e2e`
- `SKIP_ENV_VALIDATION=1 npm run build`
- `docker build -t pulchatx:dev .`

Expected: all PASS.

- [ ] **Step 2: Exercise the failure paths by hand**

With the stack running:
1. Invite an address, then revoke it, then open the link — expect the "not valid"
   page, not an error trace.
2. Invite an address that already has an account — expect the inviter to see a
   clear message, not a server error.
3. As an Owner, try to remove yourself while you are the only Owner — expect the
   refusal to surface in the UI rather than a silent no-op.

Record what the customer actually sees in each case.

- [ ] **Step 3: Write the report**

`docs/block-1b-report.md` must record, at minimum:

- Verbatim output of every command from Step 1.
- The outcome of the two non-vacuity checks: the `has_permission` existence-term
  removal (Task 8 Step 3) and the type probe (Task 7 Step 3).
- **Custom SMTP is now required, not optional.** Without it invitations do not
  arrive and the only path is the on-screen link. Carry the configuration steps
  forward from `docs/block-1a-report.md` §1.3.
- Any deviation from this plan, with the reason.

- [ ] **Step 4: Commit**

```bash
git add docs/
git commit -m "docs: add Block 1b verification report"
```

---

## Definition of Done

- [ ] An Owner invites a colleague; the colleague opens the link, chooses a password, and reaches the application as a member with the invited role.
- [ ] An operator calling `create_invitation`, `change_member_role` or `remove_member` is rejected under a real JWT.
- [ ] A revoked invitation and an expired invitation both refuse acceptance, with the same message as an invalid one.
- [ ] The same invitation cannot be accepted twice.
- [ ] An Organization cannot be left without an owner, by removal or by demotion.
- [ ] A removed member loses access on their next request, with no forced sign-out.
- [ ] A suspended Company grants no permissions, even to its Owner.
- [ ] `has_permission` returns false for an unknown code **even for a platform admin**, and true for a real code.
- [ ] An Owner can read their own Organization's audit trail, and no other.
- [ ] Deliberately removing the permission-existence term makes the isolation suite fail (proven in Task 8).
- [ ] `lint`, `typecheck`, unit, pgTAP, isolation, e2e and `docker build` all pass.

## Out of scope

Per-Organization custom roles · per-person permission overrides · additional Companies and the Company selector (Block 1c) · consolidated view (Block 8) · administration console beyond these screens · member, prize and promotion domains.
