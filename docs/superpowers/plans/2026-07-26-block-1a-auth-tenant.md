# Block 1a — Auth & Tenant Foundation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the only path by which a paying customer exists in PulchatX — provisioning, sign-in, forced password change — on a tenant schema whose isolation is proven by tests that use real users and real JWTs.

**Architecture:** Postgres owns isolation (RLS helpers querying membership tables, so revocation is immediate) and atomicity (PL/pgSQL RPCs for multi-step operations). Next.js owns orchestration and permission pre-checks. There is no self-serve signup: `enable_signup` is off, and a test fails if it is ever turned back on.

**Tech Stack:** Next.js 15 App Router · React 19 · TypeScript strict · Supabase (Postgres, Auth, RLS, PL/pgSQL) · Zod · Tailwind + shadcn/ui · Vitest · Playwright · pgTAP

**Spec:** `docs/superpowers/specs/2026-07-26-block-1a-auth-tenant-design.md`

## Global Constraints

- **Node.js ≥ 22**; npm with committed `package-lock.json`.
- **TypeScript strict**; `any` forbidden without a justifying comment. `noUncheckedIndexedAccess` and `noImplicitOverride` are on.
- **Everything in English** — identifiers, comments, error messages, UI strings, docs.
- **App Router**; Server Components by default, Client Components only when necessary.
- **UI only via Tailwind + shadcn/ui.**
- **`SUPABASE_SERVICE_ROLE_KEY` never reaches the client bundle**; `service-client.ts` stays `server-only`.
- **Never log** passwords, tokens, `service_role`, full CPF/passport, or `authorization`.
- **`USING (true)` is forbidden** in any RLS policy. `organization_id` / `company_id` arriving from the client are never trusted without a check.
- **`SECURITY DEFINER` functions re-check permission in their own body** — RLS does not protect them.
- Every commit passes `npm run lint`, `npm run typecheck`, `npm run test`.
- **Conventional Commits**; import alias `@/*` → `src/*`.
- Prettier: `singleQuote: true`, `semi: true`, `printWidth: 100`, `trailingComma: "all"`.
- Vocabulary: **Organization** → **Company** (prose: *Station*) → data. Audience is **Member**. Internal links are `organization_memberships` / `company_memberships`.

---

## File Structure

Created in this block:

- `supabase/migrations/0003_identity_tenant.sql` — profiles, organizations, companies, memberships, platform_admins
- `supabase/migrations/0004_audit_and_contact.sql` — audit_logs, contact_requests
- `supabase/migrations/0005_rls_helpers.sql` — the four helper functions
- `supabase/migrations/0006_rls_policies.sql` — policies on every table from 0003/0004
- `supabase/migrations/0007_provisioning_rpc.sql` — provision_customer, suspend_company, reactivate_company
- `supabase/tests/01_identity.test.sql` — pgTAP: schema, RLS enabled, grants
- `src/lib/supabase/database.types.ts` — generated
- `src/middleware.ts` — session refresh + password-change gate
- `src/lib/auth/session.ts` — `getSessionContext()`
- `src/services/provisioning.ts` — provisioning orchestration + compensating delete
- `src/services/contact-requests.ts` — contact form intake with rate limiting
- `src/schemas/auth.ts`, `src/schemas/provisioning.ts`, `src/schemas/contact.ts` — Zod
- `src/app/(public)/page.tsx`, `src/app/(public)/contato/page.tsx`, `src/app/(public)/login/page.tsx`
- `src/app/(app)/change-password/page.tsx`
- `src/app/(admin)/admin/customers/page.tsx`, `src/app/(admin)/admin/contact-requests/page.tsx`
- `tests/isolation/harness.ts`, `tests/isolation/tenant.test.ts`, `tests/isolation/signup-disabled.test.ts`
- Modified: `supabase/config.toml`, `src/lib/supabase/{user,service}-client.ts`, `src/lib/env.ts`

---

## Task 1: Disable public signup and prove it

**Files:**
- Modify: `supabase/config.toml`
- Create: `tests/isolation/signup-disabled.test.ts`

**Interfaces:**
- Produces: a local Supabase whose Auth API refuses `signUp`.

This is first because it is the security boundary of the whole product. Everything else assumes it holds.

- [ ] **Step 1: Turn signup off in `supabase/config.toml`**

Line 176, inside `[auth]`, currently reads `enable_signup = true`. Change to:

```toml
enable_signup = false
```

Also raise the password floor on the same block — 6 is too low for a product holding personal data:

```toml
minimum_password_length = 10
```

Leave the `[auth.external.*]` blocks alone; those are OAuth providers and already `false`.

- [ ] **Step 2: Write the failing test**

`tests/isolation/signup-disabled.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { createClient } from '@supabase/supabase-js';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

describe('public signup', () => {
  it('is refused by the Auth API', async () => {
    const anon = createClient(url, anonKey);
    const { data, error } = await anon.auth.signUp({
      email: `intruder-${Date.now()}@example.com`,
      password: 'a-perfectly-valid-password',
    });

    expect(error).not.toBeNull();
    expect(data.user).toBeNull();
  });
});
```

- [ ] **Step 3: Add an isolation test project to `vitest.config.ts`**

These tests need a live database, so they must not run in the default unit project. Replace the file with:

```ts
import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/unit/**/*.test.ts'],
    env: { SKIP_ENV_VALIDATION: '1' },
  },
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
});
```

Create `vitest.isolation.config.ts`:

```ts
import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/isolation/**/*.test.ts'],
    hookTimeout: 30_000,
    testTimeout: 30_000,
    fileParallelism: false,
  },
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
});
```

`fileParallelism: false` matters: these tests create and delete real users, and parallel files would race on the shared database.

Add to `package.json` scripts:

```json
"test:isolation": "vitest run --config vitest.isolation.config.ts"
```

- [ ] **Step 4: Run it and see it fail**

Run: `npm run db:reset`
Then: `npm run test:isolation`
Expected: FAIL — signup still succeeds, because `db:reset` has not yet picked up the config change. (`config.toml` is read by `supabase start`, not by `db reset`.)

- [ ] **Step 5: Restart the stack so the config applies**

Run: `npx supabase stop`
Then: `npx supabase start`
Then: `npm run test:isolation`
Expected: PASS. The error message will mention signups being disabled.

- [ ] **Step 6: Commit**

```bash
git add supabase/config.toml vitest.config.ts vitest.isolation.config.ts package.json tests/isolation/signup-disabled.test.ts
git commit -m "feat: disable public signup and assert it in tests"
```

> **Production note for the reviewer:** the hosted project has its own setting. Disabling signup there is a manual step in the Supabase dashboard (Authentication → Providers → Email → "Allow new users to sign up" off). The plan cannot automate it; Task 16 adds it to the deployment checklist.

---

## Task 2: Identity and tenant schema

**Files:**
- Create: `supabase/migrations/0003_identity_tenant.sql`

**Interfaces:**
- Produces: tables `profiles`, `organizations`, `companies`, `organization_memberships`, `company_memberships`, `platform_admins`; enum `member_role`; enum `company_status`.

- [ ] **Step 1: Write the migration**

`supabase/migrations/0003_identity_tenant.sql`:

```sql
-- Roles held on a membership. Granular permissions arrive in Block 1b as
-- tables that read this column; the column is not discarded then.
create type public.member_role as enum ('owner', 'operator', 'viewer');

-- Subscription state of a Company. A Company is created active (the contract
-- was signed before provisioning) and is suspended for non-payment.
create type public.company_status as enum ('active', 'suspended');

-- Application-level user data. auth.users is owned by Supabase; this mirrors
-- the subset the app needs and adds the provisional-password flags.
create table public.profiles (
  id                       uuid primary key references auth.users (id) on delete cascade,
  email                    text not null,
  full_name                text,
  must_change_password     boolean not null default false,
  provisional_expires_at   timestamptz,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  deleted_at               timestamptz
);

comment on table public.profiles is 'Application-level user data mirroring auth.users.';
comment on column public.profiles.must_change_password is 'While true, every route redirects to the change-password screen.';
comment on column public.profiles.provisional_expires_at is 'Sign-in is refused after this instant while must_change_password is true.';

create table public.organizations (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz
);

comment on table public.organizations is 'Top tenant level. Created at provisioning time and always active.';

create table public.companies (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid not null references public.organizations (id),
  name              text not null,
  status            public.company_status not null default 'active',
  timezone          text not null default 'America/Sao_Paulo',
  provisioned_by    uuid references auth.users (id),
  provisioned_at    timestamptz not null default now(),
  suspended_at      timestamptz,
  suspension_reason text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  deleted_at        timestamptz
);

comment on table public.companies is 'The business tenant (prose: Station). Suspended when the subscription lapses.';

create table public.organization_memberships (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references auth.users (id) on delete cascade,
  organization_id  uuid not null references public.organizations (id),
  role             public.member_role not null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  deleted_at       timestamptz
);

create table public.company_memberships (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users (id) on delete cascade,
  company_id  uuid not null references public.companies (id),
  role        public.member_role not null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz
);

comment on table public.company_memberships is 'Internal panel users linked to a Company. NOT the audience — that is public.members, in a later block.';

-- Who may provision and suspend. The app owner, cross-tenant.
create table public.platform_admins (
  user_id     uuid primary key references auth.users (id) on delete cascade,
  created_at  timestamptz not null default now()
);

comment on table public.platform_admins is 'Cross-tenant super-admins. The controlled bypass required by the spec, never an exposed service_role.';

-- Partial unique indexes: a membership can be archived and recreated without
-- colliding with the logically deleted row (spec N5).
create unique index organization_memberships_unique
  on public.organization_memberships (user_id, organization_id)
  where deleted_at is null;

create unique index company_memberships_unique
  on public.company_memberships (user_id, company_id)
  where deleted_at is null;

-- These two indexes carry every RLS helper. They are the reason a
-- membership subquery per policy check stays cheap.
create index organization_memberships_lookup
  on public.organization_memberships (user_id, organization_id)
  where deleted_at is null;

create index company_memberships_lookup
  on public.company_memberships (user_id, company_id)
  where deleted_at is null;

create index companies_organization_idx
  on public.companies (organization_id)
  where deleted_at is null;
```

- [ ] **Step 2: Apply and inspect**

Run: `npm run db:reset`
Expected: all migrations apply with no error.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/0003_identity_tenant.sql
git commit -m "feat(db): add identity and tenant tables"
```

---

## Task 3: Audit log and contact requests

**Files:**
- Create: `supabase/migrations/0004_audit_and_contact.sql`

**Interfaces:**
- Produces: tables `audit_logs`, `contact_requests`; enum `contact_request_status`.

- [ ] **Step 1: Write the migration**

`supabase/migrations/0004_audit_and_contact.sql`:

```sql
-- Sensitive-operation trail. The spec requires this from every block onward.
-- actor_id is nullable: a failed privileged call by an unauthenticated caller
-- still deserves a record.
create table public.audit_logs (
  id               bigserial primary key,
  actor_id         uuid references auth.users (id),
  action           text not null,
  target_table     text,
  target_id        uuid,
  organization_id  uuid references public.organizations (id),
  company_id       uuid references public.companies (id),
  succeeded        boolean not null default true,
  detail           jsonb not null default '{}'::jsonb,
  created_at       timestamptz not null default now()
);

comment on table public.audit_logs is 'Trail of sensitive operations, successes and failures alike.';
comment on column public.audit_logs.detail is 'Never store credentials here. The provisional password is not recorded.';

create index audit_logs_created_idx on public.audit_logs (created_at desc);
create index audit_logs_actor_idx on public.audit_logs (actor_id, created_at desc);

create type public.contact_request_status as enum ('new', 'contacted', 'converted', 'discarded');

-- The only unauthenticated write in the system.
create table public.contact_requests (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  email         text not null,
  phone         text,
  company_name  text,
  message       text,
  status        public.contact_request_status not null default 'new',
  ip_hash       text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

comment on table public.contact_requests is 'Inbound interest from the public contact form.';
comment on column public.contact_requests.ip_hash is 'Hashed, never the raw address (data minimisation).';

create index contact_requests_status_idx on public.contact_requests (status, created_at desc);
```

- [ ] **Step 2: Apply**

Run: `npm run db:reset`
Expected: applies cleanly.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/0004_audit_and_contact.sql
git commit -m "feat(db): add audit log and contact requests"
```

---

## Task 4: RLS helper functions

**Files:**
- Create: `supabase/migrations/0005_rls_helpers.sql`

**Interfaces:**
- Produces: `is_platform_admin() → boolean`, `is_org_member(uuid) → boolean`, `is_owner(uuid) → boolean`, `has_company_access(uuid) → boolean`.

- [ ] **Step 1: Write the migration**

`supabase/migrations/0005_rls_helpers.sql`:

```sql
-- These four functions are the whole isolation model. They query the
-- membership tables on every call rather than reading JWT claims, so that
-- revoking access takes effect immediately instead of waiting up to an hour
-- for a token to refresh. STABLE lets PostgreSQL reuse the result within a
-- single statement, and the *_lookup indexes from 0003 keep it cheap.
--
-- All of them are SECURITY DEFINER so that they can read the membership
-- tables regardless of the policies on those tables — otherwise a policy that
-- calls the helper would recurse into itself.

create or replace function public.is_platform_admin()
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select exists (
    select 1 from public.platform_admins pa
    where pa.user_id = auth.uid()
  );
$$;

create or replace function public.is_org_member(p_organization_id uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select public.is_platform_admin() or exists (
    select 1 from public.organization_memberships om
    where om.user_id = auth.uid()
      and om.organization_id = p_organization_id
      and om.deleted_at is null
  );
$$;

create or replace function public.is_owner(p_organization_id uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select exists (
    select 1 from public.organization_memberships om
    where om.user_id = auth.uid()
      and om.organization_id = p_organization_id
      and om.role = 'owner'
      and om.deleted_at is null
  );
$$;

-- The helper every business table will use from Block 2 onward. It carries
-- BOTH conditions: the user is a member, AND the Company's subscription is
-- active. A suspended Company therefore yields no business data even to its
-- own Owner, without any table needing to remember the status check.
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
  'Membership AND active subscription. Business tables use this; company metadata visibility uses is_org_member instead.';

revoke execute on function public.is_platform_admin() from public;
revoke execute on function public.is_org_member(uuid) from public;
revoke execute on function public.is_owner(uuid) from public;
revoke execute on function public.has_company_access(uuid) from public;

grant execute on function public.is_platform_admin() to authenticated;
grant execute on function public.is_org_member(uuid) to authenticated;
grant execute on function public.is_owner(uuid) to authenticated;
grant execute on function public.has_company_access(uuid) to authenticated;
```

- [ ] **Step 2: Apply**

Run: `npm run db:reset`
Expected: applies cleanly.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/0005_rls_helpers.sql
git commit -m "feat(db): add RLS helper functions"
```

---

## Task 5: RLS policies

**Files:**
- Create: `supabase/migrations/0006_rls_policies.sql`

**Interfaces:**
- Produces: RLS enabled with policies on every table from Tasks 2 and 3.

- [ ] **Step 1: Write the migration**

`supabase/migrations/0006_rls_policies.sql`:

```sql
alter table public.profiles                  enable row level security;
alter table public.organizations             enable row level security;
alter table public.companies                 enable row level security;
alter table public.organization_memberships  enable row level security;
alter table public.company_memberships       enable row level security;
alter table public.platform_admins           enable row level security;
alter table public.audit_logs                enable row level security;
alter table public.contact_requests          enable row level security;

-- Default deny everywhere. Grants are added back per role, per table.
revoke all on public.profiles                 from anon, authenticated;
revoke all on public.organizations            from anon, authenticated;
revoke all on public.companies                from anon, authenticated;
revoke all on public.organization_memberships from anon, authenticated;
revoke all on public.company_memberships      from anon, authenticated;
revoke all on public.platform_admins          from anon, authenticated;
revoke all on public.audit_logs               from anon, authenticated;
revoke all on public.contact_requests         from anon, authenticated;

-- profiles: you see and edit your own row, and nothing else. The
-- must_change_password and provisional_expires_at columns are written only by
-- SECURITY DEFINER functions, so a user cannot clear their own gate.
grant select, update on public.profiles to authenticated;

create policy profiles_select_self on public.profiles
  for select to authenticated
  using (id = auth.uid() or public.is_platform_admin());

create policy profiles_update_self on public.profiles
  for update to authenticated
  using (id = auth.uid())
  with check (id = auth.uid());

-- organizations: visible to members. No client-side writes at all — creation
-- happens inside provision_customer.
grant select on public.organizations to authenticated;

create policy organizations_select_member on public.organizations
  for select to authenticated
  using (deleted_at is null and public.is_org_member(id));

-- companies: metadata is visible to any member of the owning organization,
-- INCLUDING while suspended, so the UI can show why access stopped. Business
-- data lives in other tables and is gated by has_company_access instead.
grant select on public.companies to authenticated;

create policy companies_select_org_member on public.companies
  for select to authenticated
  using (deleted_at is null and public.is_org_member(organization_id));

-- memberships: you see your own links; an Owner sees everyone in their org.
grant select on public.organization_memberships to authenticated;
grant select on public.company_memberships to authenticated;

create policy organization_memberships_select on public.organization_memberships
  for select to authenticated
  using (
    deleted_at is null
    and (user_id = auth.uid() or public.is_owner(organization_id) or public.is_platform_admin())
  );

create policy company_memberships_select on public.company_memberships
  for select to authenticated
  using (
    deleted_at is null
    and (
      user_id = auth.uid()
      or public.is_platform_admin()
      or exists (
        select 1 from public.companies c
        where c.id = company_id and public.is_owner(c.organization_id)
      )
    )
  );

-- platform_admins: only a platform admin may read the list. No client writes.
grant select on public.platform_admins to authenticated;

create policy platform_admins_select on public.platform_admins
  for select to authenticated
  using (public.is_platform_admin());

-- audit_logs: readable by platform admins only in this block. Org-scoped
-- audit viewing arrives with the admin console in a later block. Writes come
-- exclusively from SECURITY DEFINER functions.
grant select on public.audit_logs to authenticated;

create policy audit_logs_select_admin on public.audit_logs
  for select to authenticated
  using (public.is_platform_admin());

-- contact_requests: anon may INSERT and nothing else. Only platform admins
-- read or update. This is the single public write in the system.
grant insert on public.contact_requests to anon;
grant select, update on public.contact_requests to authenticated;

create policy contact_requests_insert_anon on public.contact_requests
  for insert to anon
  with check (true);

create policy contact_requests_select_admin on public.contact_requests
  for select to authenticated
  using (public.is_platform_admin());

create policy contact_requests_update_admin on public.contact_requests
  for update to authenticated
  using (public.is_platform_admin())
  with check (public.is_platform_admin());
```

> **Note on the one `with check (true)`:** it is on an INSERT policy for `anon` on `contact_requests`, and it is deliberate — a stranger must be able to submit the form. It is not the forbidden `USING (true)`: `anon` holds no SELECT grant, so a submitter cannot read the table back, and the service layer rate-limits the endpoint. Flag it in review if you disagree.

- [ ] **Step 2: Apply**

Run: `npm run db:reset`
Expected: applies cleanly.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/0006_rls_policies.sql
git commit -m "feat(db): enable RLS with policies on identity tables"
```

---

## Task 6: Provisioning and subscription RPCs

**Files:**
- Create: `supabase/migrations/0007_provisioning_rpc.sql`

**Interfaces:**
- Produces:
  - `provision_customer(p_user_id uuid, p_organization_name text, p_company_name text, p_timezone text) → jsonb` — returns `{organization_id, company_id}`
  - `suspend_company(p_company_id uuid, p_reason text) → void`
  - `reactivate_company(p_company_id uuid) → void`

- [ ] **Step 1: Write the migration**

`supabase/migrations/0007_provisioning_rpc.sql`:

```sql
-- Creating the auth user is the Supabase Admin API; creating the tenant is
-- SQL. There is no transaction spanning the two, so the caller creates the
-- user first and deletes it if this function fails (see services/provisioning.ts).
-- Everything below IS atomic: organization, company, both memberships, the
-- profile flags and the audit entry either all land or none do.
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
  -- SECURITY DEFINER bypasses RLS, so the permission check must live here.
  if not public.is_platform_admin() then
    insert into public.audit_logs (actor_id, action, succeeded, detail)
    values (v_actor, 'provision_customer.denied', false,
            jsonb_build_object('target_user', p_user_id));
    raise exception 'permission denied: platform admin required'
      using errcode = '42501';
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

  insert into public.company_memberships (user_id, company_id, role)
  values (p_user_id, v_comp, 'owner');

  update public.profiles
     set must_change_password   = true,
         provisional_expires_at = now() + interval '7 days',
         updated_at             = now()
   where id = p_user_id;

  if not found then
    raise exception 'profile not found for user %', p_user_id using errcode = 'P0002';
  end if;

  insert into public.audit_logs
    (actor_id, action, target_table, target_id, organization_id, company_id, detail)
  values
    (v_actor, 'provision_customer', 'companies', v_comp, v_org, v_comp,
     jsonb_build_object('owner_user_id', p_user_id, 'organization_name', trim(p_organization_name)));

  return jsonb_build_object('organization_id', v_org, 'company_id', v_comp);
end;
$$;

create or replace function public.suspend_company(
  p_company_id uuid,
  p_reason     text
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor uuid := auth.uid();
  v_org   uuid;
begin
  if not public.is_platform_admin() then
    insert into public.audit_logs (actor_id, action, succeeded, detail)
    values (v_actor, 'suspend_company.denied', false,
            jsonb_build_object('company_id', p_company_id));
    raise exception 'permission denied: platform admin required'
      using errcode = '42501';
  end if;

  update public.companies
     set status            = 'suspended',
         suspended_at      = now(),
         suspension_reason = p_reason,
         updated_at        = now()
   where id = p_company_id and deleted_at is null
   returning organization_id into v_org;

  if not found then
    raise exception 'company not found: %', p_company_id using errcode = 'P0002';
  end if;

  insert into public.audit_logs
    (actor_id, action, target_table, target_id, organization_id, company_id, detail)
  values
    (v_actor, 'suspend_company', 'companies', p_company_id, v_org, p_company_id,
     jsonb_build_object('reason', p_reason));
end;
$$;

create or replace function public.reactivate_company(p_company_id uuid)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor uuid := auth.uid();
  v_org   uuid;
begin
  if not public.is_platform_admin() then
    insert into public.audit_logs (actor_id, action, succeeded, detail)
    values (v_actor, 'reactivate_company.denied', false,
            jsonb_build_object('company_id', p_company_id));
    raise exception 'permission denied: platform admin required'
      using errcode = '42501';
  end if;

  update public.companies
     set status            = 'active',
         suspended_at      = null,
         suspension_reason = null,
         updated_at        = now()
   where id = p_company_id and deleted_at is null
   returning organization_id into v_org;

  if not found then
    raise exception 'company not found: %', p_company_id using errcode = 'P0002';
  end if;

  insert into public.audit_logs
    (actor_id, action, target_table, target_id, organization_id, company_id)
  values
    (v_actor, 'reactivate_company', 'companies', p_company_id, v_org, p_company_id);
end;
$$;

revoke execute on function public.provision_customer(uuid, text, text, text) from public;
revoke execute on function public.suspend_company(uuid, text) from public;
revoke execute on function public.reactivate_company(uuid) from public;

grant execute on function public.provision_customer(uuid, text, text, text) to authenticated;
grant execute on function public.suspend_company(uuid, text) to authenticated;
grant execute on function public.reactivate_company(uuid) to authenticated;
```

- [ ] **Step 2: Apply**

Run: `npm run db:reset`
Expected: applies cleanly.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/0007_provisioning_rpc.sql
git commit -m "feat(db): add provisioning and subscription RPCs"
```

---

## Task 7: pgTAP coverage for the new schema

**Files:**
- Create: `supabase/tests/01_identity.test.sql`

**Interfaces:**
- Produces: schema-level assertions that run under `npm run db:test`.

- [ ] **Step 1: Write the test**

`supabase/tests/01_identity.test.sql`:

```sql
begin;
select plan(14);

-- tables exist
select has_table('public', 'profiles', 'profiles exists');
select has_table('public', 'organizations', 'organizations exists');
select has_table('public', 'companies', 'companies exists');
select has_table('public', 'organization_memberships', 'organization_memberships exists');
select has_table('public', 'company_memberships', 'company_memberships exists');
select has_table('public', 'platform_admins', 'platform_admins exists');
select has_table('public', 'audit_logs', 'audit_logs exists');
select has_table('public', 'contact_requests', 'contact_requests exists');

-- RLS is on everywhere it must be
select is(relrowsecurity, true, 'RLS enabled on companies')
  from pg_class where oid = 'public.companies'::regclass;
select is(relrowsecurity, true, 'RLS enabled on company_memberships')
  from pg_class where oid = 'public.company_memberships'::regclass;
select is(relrowsecurity, true, 'RLS enabled on contact_requests')
  from pg_class where oid = 'public.contact_requests'::regclass;

-- anon may insert a contact request and nothing more
select ok(
  has_table_privilege('anon', 'public.contact_requests', 'INSERT'),
  'anon may submit a contact request'
);
select ok(
  not has_table_privilege('anon', 'public.contact_requests', 'SELECT'),
  'anon may not read contact requests back'
);

-- anon has no reach into tenant data at all
select ok(
  not has_table_privilege('anon', 'public.companies', 'SELECT'),
  'anon has no read on companies'
);

select * from finish();
rollback;
```

- [ ] **Step 2: Run it**

Run: `npm run db:reset`
Then: `npm run db:test`
Expected: PASS — the Block 0 smoke test (7 assertions) plus these 14.

- [ ] **Step 3: Commit**

```bash
git add supabase/tests/01_identity.test.sql
git commit -m "test(db): add pgTAP coverage for identity schema"
```

---

## Task 8: Generated database types

**Files:**
- Create: `src/lib/supabase/database.types.ts`
- Modify: `src/lib/supabase/user-client.ts`, `src/lib/supabase/service-client.ts`
- Modify: `package.json`

**Interfaces:**
- Produces: `Database` type; both client factories return `SupabaseClient<Database>`.

This closes a real Block 0 defect: `.from()` and `.rpc()` are untyped today, and that is exactly how a library `any` bypassed `noUncheckedIndexedAccess`.

- [ ] **Step 1: Add the generation script**

In `package.json` scripts:

```json
"db:types": "supabase gen types typescript --local > src/lib/supabase/database.types.ts"
```

- [ ] **Step 2: Generate**

Run: `npm run db:reset`
Then: `npm run db:types`
Expected: `src/lib/supabase/database.types.ts` created, exporting `Database`.

- [ ] **Step 3: Thread the type through both clients**

In `src/lib/supabase/user-client.ts`, change the import and the return type:

```ts
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from './database.types';

export async function createUserClient(): Promise<SupabaseClient<Database>> {
```

and the `createServerClient` call becomes `createServerClient<Database>(url, anonKey, { ... })`.

In `src/lib/supabase/service-client.ts`:

```ts
import type { Database } from './database.types';

export function createServiceClient(): SupabaseClient<Database> {
  const { url, serviceRoleKey } = getServiceSupabaseConfig();
  return createClient<Database>(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}
```

- [ ] **Step 4: Verify the typing actually engages**

Run: `npm run typecheck`
Expected: PASS.

Then confirm it is not vacuous — temporarily add this line to `user-client.ts` and run typecheck again:

```ts
// TEMPORARY probe — must produce an error, then delete
const _probe = (await createUserClient()).from('no_such_table');
```

Expected: typecheck FAILS with an error naming `no_such_table`. Delete the line and re-run — PASS. Report both outcomes; a probe that compiles means the types are not wired up.

- [ ] **Step 5: Commit**

```bash
git add package.json src/lib/supabase/database.types.ts src/lib/supabase/user-client.ts src/lib/supabase/service-client.ts
git commit -m "feat: generate and thread Supabase database types"
```

---

## Task 9: Isolation test harness

**Files:**
- Create: `tests/isolation/harness.ts`
- Create: `tests/isolation/tenant.test.ts`

**Interfaces:**
- Consumes: `provision_customer` (Task 6), `Database` (Task 8).
- Produces: `provisionCustomer()`, `signInAs()`, `cleanupUsers()` — used by every later block's isolation tests.

- [ ] **Step 1: Write the harness**

`tests/isolation/harness.ts`:

```ts
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '../../src/lib/supabase/database.types';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

export const admin = createClient<Database>(url, serviceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const createdUserIds: string[] = [];

export interface ProvisionedCustomer {
  userId: string;
  email: string;
  password: string;
  organizationId: string;
  companyId: string;
}

/**
 * Creates a real auth user, marks it a platform admin only if asked, then
 * calls the real provision_customer RPC as that admin. Mirrors what the
 * application does, so the tests exercise the production path.
 */
export async function provisionCustomer(label: string): Promise<ProvisionedCustomer> {
  const adminUser = await createUser(`admin-${label}@example.test`);
  await admin.from('platform_admins').insert({ user_id: adminUser.userId });

  const owner = await createUser(`owner-${label}@example.test`);

  const adminClient = await signInAs(adminUser.email, adminUser.password);
  const { data, error } = await adminClient.rpc('provision_customer', {
    p_user_id: owner.userId,
    p_organization_name: `Org ${label}`,
    p_company_name: `Company ${label}`,
    p_timezone: 'America/Sao_Paulo',
  });
  if (error) throw new Error(`provision_customer failed: ${error.message}`);

  const result = data as { organization_id: string; company_id: string };
  return {
    ...owner,
    organizationId: result.organization_id,
    companyId: result.company_id,
  };
}

export async function createUser(
  email: string,
): Promise<{ userId: string; email: string; password: string }> {
  const password = `Test-${crypto.randomUUID()}`;
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (error || !data.user) throw new Error(`createUser failed: ${error?.message}`);

  await admin.from('profiles').insert({ id: data.user.id, email });
  createdUserIds.push(data.user.id);
  return { userId: data.user.id, email, password };
}

export async function signInAs(email: string, password: string): Promise<SupabaseClient<Database>> {
  const client = createClient<Database>(url, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { error } = await client.auth.signInWithPassword({ email, password });
  if (error) throw new Error(`signInAs(${email}) failed: ${error.message}`);
  return client;
}

export async function cleanupUsers(): Promise<void> {
  for (const id of createdUserIds.splice(0)) {
    await admin.auth.admin.deleteUser(id);
  }
}
```

> `createUser` inserts the profile row directly. In production that row is created by the provisioning service (Task 11); the harness does it explicitly so the RPC's `profile not found` guard is exercised by the service test rather than accidentally by every isolation test.

- [ ] **Step 2: Write the isolation tests**

`tests/isolation/tenant.test.ts`:

```ts
import { describe, it, expect, afterAll } from 'vitest';
import { provisionCustomer, signInAs, cleanupUsers, admin } from './harness';

afterAll(async () => {
  await cleanupUsers();
});

describe('tenant isolation', () => {
  it('a user reads only their own company', async () => {
    const a = await provisionCustomer(`a-${Date.now()}`);
    const b = await provisionCustomer(`b-${Date.now()}`);

    const clientA = await signInAs(a.email, a.password);
    const { data } = await clientA.from('companies').select('id');

    const ids = (data ?? []).map((r) => r.id);
    expect(ids).toContain(a.companyId);
    expect(ids).not.toContain(b.companyId);
  });

  it('a user cannot write into another company', async () => {
    const a = await provisionCustomer(`wa-${Date.now()}`);
    const b = await provisionCustomer(`wb-${Date.now()}`);

    const clientA = await signInAs(a.email, a.password);
    const { error } = await clientA
      .from('company_memberships')
      .insert({ user_id: a.userId, company_id: b.companyId, role: 'viewer' });

    expect(error).not.toBeNull();
  });

  it('an ordinary user cannot provision', async () => {
    const a = await provisionCustomer(`p-${Date.now()}`);
    const clientA = await signInAs(a.email, a.password);

    const { error } = await clientA.rpc('provision_customer', {
      p_user_id: a.userId,
      p_organization_name: 'Pirate Org',
      p_company_name: 'Pirate Company',
      p_timezone: 'America/Sao_Paulo',
    });

    expect(error).not.toBeNull();
    expect(error?.message).toMatch(/permission denied/i);
  });

  it('an ordinary user cannot suspend a company', async () => {
    const a = await provisionCustomer(`s-${Date.now()}`);
    const clientA = await signInAs(a.email, a.password);

    const { error } = await clientA.rpc('suspend_company', {
      p_company_id: a.companyId,
      p_reason: 'nope',
    });

    expect(error).not.toBeNull();
  });

  it('a suspended company yields no business data, even to its owner', async () => {
    const a = await provisionCustomer(`sus-${Date.now()}`);

    await admin
      .from('companies')
      .update({ status: 'suspended' })
      .eq('id', a.companyId);

    const clientA = await signInAs(a.email, a.password);

    // Metadata stays visible so the UI can explain the suspension...
    const { data: meta } = await clientA.from('companies').select('id, status');
    expect((meta ?? []).map((r) => r.id)).toContain(a.companyId);

    // ...but has_company_access is false, which is what business tables use.
    const { data: access } = await clientA.rpc('has_company_access', {
      p_company_id: a.companyId,
    });
    expect(access).toBe(false);
  });

  it('anon cannot read companies at all', async () => {
    const a = await provisionCustomer(`anon-${Date.now()}`);
    const anonClient = (await import('@supabase/supabase-js')).createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    );

    const { data, error } = await anonClient.from('companies').select('id');
    expect(error ?? data?.length === 0).toBeTruthy();
    expect(a.companyId).toBeTruthy();
  });
});
```

- [ ] **Step 3: Run and see them pass**

Run: `npm run db:reset`
Then: `npm run test:isolation`
Expected: PASS — 6 isolation tests plus the signup test from Task 1.

- [ ] **Step 4: Deliberately break a policy and confirm the harness catches it**

This proves the tests are not vacuous. Temporarily edit `0006_rls_policies.sql`, changing the `companies_select_org_member` policy's `using` clause to `using (true)`. Run `npm run db:reset` then `npm run test:isolation`.
Expected: the first test FAILS, because A now sees B's company.
Revert the edit, re-run `db:reset` and the suite. Expected: PASS.
Report both outcomes in your report.

- [ ] **Step 5: Commit**

```bash
git add tests/isolation/harness.ts tests/isolation/tenant.test.ts
git commit -m "test: add tenant isolation harness with real users and JWTs"
```

---

## Task 10: Session middleware and the password gate

**Files:**
- Create: `src/middleware.ts`

**Interfaces:**
- Consumes: `Database` (Task 8).
- Produces: request-level session refresh and the password-change gate.

This closes Block 0's number one debt: `user-client.ts` swallows cookie-write failures by design, on the documented assumption that middleware refreshes the session.

- [ ] **Step 1: Write the middleware**

`src/middleware.ts`:

```ts
import { NextResponse, type NextRequest } from 'next/server';
import { createServerClient } from '@supabase/ssr';

const PUBLIC_PATHS = ['/', '/contato', '/login', '/api/health'];
const CHANGE_PASSWORD_PATH = '/change-password';

export async function middleware(request: NextRequest) {
  let response = NextResponse.next({ request });

  // Refreshing the session here is what makes the cookie-write guard in
  // user-client.ts safe: Server Components cannot write cookies, so without
  // this the refreshed session would be silently discarded.
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll: (toSet) => {
          for (const { name, value } of toSet) request.cookies.set(name, value);
          response = NextResponse.next({ request });
          for (const { name, value, options } of toSet) {
            response.cookies.set(name, value, options);
          }
        },
      },
    },
  );

  const {
    data: { user },
  } = await supabase.auth.getUser();

  const path = request.nextUrl.pathname;
  const isPublic = PUBLIC_PATHS.includes(path);

  if (!user) {
    if (isPublic) return response;
    return NextResponse.redirect(new URL('/login', request.url));
  }

  const { data: profile } = await supabase
    .from('profiles')
    .select('must_change_password')
    .eq('id', user.id)
    .single();

  // The gate has no holes: while the flag is set, every path other than the
  // change screen itself redirects to it.
  if (profile?.must_change_password && path !== CHANGE_PASSWORD_PATH) {
    return NextResponse.redirect(new URL(CHANGE_PASSWORD_PATH, request.url));
  }

  if (!profile?.must_change_password && path === CHANGE_PASSWORD_PATH) {
    return NextResponse.redirect(new URL('/admin/customers', request.url));
  }

  return response;
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)'],
};
```

- [ ] **Step 2: Verify typecheck and build**

Run: `npm run typecheck`
Then: `$env:SKIP_ENV_VALIDATION=1; npm run build`
Expected: both PASS, and the build output lists `ƒ Middleware`.

- [ ] **Step 3: Commit**

```bash
git add src/middleware.ts
git commit -m "feat(auth): add session middleware and password-change gate"
```

---

## Task 11: Provisioning service

**Files:**
- Create: `src/schemas/provisioning.ts`
- Create: `src/services/provisioning.ts`
- Create: `tests/unit/provisioning-password.test.ts`

**Interfaces:**
- Consumes: `provision_customer` (Task 6), `createServiceClient` (Block 0).
- Produces: `generateProvisionalPassword(): string`, `provisionCustomer(input): Promise<ProvisionResult>`.

- [ ] **Step 1: Write the schema**

`src/schemas/provisioning.ts`:

```ts
import { z } from 'zod';

export const provisionCustomerSchema = z.object({
  organizationName: z.string().trim().min(2).max(120),
  companyName: z.string().trim().min(2).max(120),
  ownerEmail: z.string().trim().email(),
  ownerName: z.string().trim().min(2).max(120).optional(),
  timezone: z.string().trim().min(1).default('America/Sao_Paulo'),
});

export type ProvisionCustomerInput = z.infer<typeof provisionCustomerSchema>;
```

- [ ] **Step 2: Write the failing test for the password generator**

`tests/unit/provisioning-password.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { generateProvisionalPassword } from '@/services/provisioning';

describe('generateProvisionalPassword', () => {
  it('is long enough for the configured minimum', () => {
    expect(generateProvisionalPassword().length).toBeGreaterThanOrEqual(16);
  });

  it('does not repeat across calls', () => {
    const seen = new Set(Array.from({ length: 50 }, () => generateProvisionalPassword()));
    expect(seen.size).toBe(50);
  });

  it('avoids characters that are ambiguous when read aloud', () => {
    const joined = Array.from({ length: 50 }, () => generateProvisionalPassword()).join('');
    expect(joined).not.toMatch(/[0OIl1]/);
  });
});
```

- [ ] **Step 3: Run and see it fail**

Run: `npm run test -- provisioning-password`
Expected: FAIL — "Cannot find module '@/services/provisioning'".

- [ ] **Step 4: Write the service**

`src/services/provisioning.ts`:

```ts
import 'server-only';
import { randomInt } from 'node:crypto';
import { createServiceClient } from '@/lib/supabase/service-client';
import { InternalError, ValidationError } from '@/lib/errors';
import { logger } from '@/lib/logger';
import type { ProvisionCustomerInput } from '@/schemas/provisioning';

// Ambiguous glyphs removed: this password is read over the phone.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
const LENGTH = 20;

export function generateProvisionalPassword(): string {
  let out = '';
  for (let i = 0; i < LENGTH; i += 1) {
    out += ALPHABET[randomInt(ALPHABET.length)];
  }
  return out;
}

export interface ProvisionResult {
  userId: string;
  organizationId: string;
  companyId: string;
  provisionalPassword: string;
}

/**
 * Creating the auth user and creating the tenant are two systems with no
 * shared transaction. If the RPC fails after the user exists we would leave
 * someone who can authenticate and belongs to no tenant — worse than failing
 * outright, because it only surfaces when they try to sign in. Hence the
 * compensating delete.
 *
 * `accessToken` is the calling platform admin's JWT: the RPC re-checks
 * is_platform_admin() in its own body, so it must run as that user, not as
 * service_role.
 */
export async function provisionCustomer(
  input: ProvisionCustomerInput,
  accessToken: string,
): Promise<ProvisionResult> {
  const admin = createServiceClient();
  const provisionalPassword = generateProvisionalPassword();

  const { data: created, error: createError } = await admin.auth.admin.createUser({
    email: input.ownerEmail,
    password: provisionalPassword,
    email_confirm: true,
    user_metadata: input.ownerName ? { full_name: input.ownerName } : undefined,
  });

  if (createError || !created.user) {
    throw new ValidationError(`Could not create the user: ${createError?.message ?? 'unknown'}`);
  }

  const userId = created.user.id;

  try {
    const { error: profileError } = await admin
      .from('profiles')
      .insert({ id: userId, email: input.ownerEmail, full_name: input.ownerName ?? null });
    if (profileError) throw new Error(profileError.message);

    const asAdmin = createUserScopedClient(accessToken);
    const { data, error } = await asAdmin.rpc('provision_customer', {
      p_user_id: userId,
      p_organization_name: input.organizationName,
      p_company_name: input.companyName,
      p_timezone: input.timezone,
    });
    if (error) throw new Error(error.message);

    const result = data as { organization_id: string; company_id: string };
    return {
      userId,
      organizationId: result.organization_id,
      companyId: result.company_id,
      provisionalPassword,
    };
  } catch (cause) {
    // Compensating action: remove the orphan before surfacing the failure.
    await admin.auth.admin.deleteUser(userId).catch(() => {
      logger.error({ userId }, 'orphaned auth user could not be deleted after failed provisioning');
    });
    throw new InternalError('Provisioning failed and was rolled back', { cause });
  }
}

function createUserScopedClient(accessToken: string) {
  const { createClient } = require('@supabase/supabase-js') as typeof import('@supabase/supabase-js');
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      global: { headers: { Authorization: `Bearer ${accessToken}` } },
      auth: { autoRefreshToken: false, persistSession: false },
    },
  );
}
```

> **Implementer note:** `createUserScopedClient` uses `require` to avoid a top-level import cycle warning; if your lint configuration rejects it, hoist a normal `import { createClient } from '@supabase/supabase-js'` to the top of the file instead and delete the helper's inner require. Report which you did.

- [ ] **Step 5: Run and see it pass**

Run: `npm run test -- provisioning-password`
Then: `npm run typecheck`
Expected: both PASS.

- [ ] **Step 6: Commit**

```bash
git add src/schemas/provisioning.ts src/services/provisioning.ts tests/unit/provisioning-password.test.ts
git commit -m "feat: add provisioning service with compensating rollback"
```

---

## Task 12: Contact request intake with rate limiting

**Files:**
- Create: `src/schemas/contact.ts`
- Create: `src/services/contact-requests.ts`
- Create: `tests/unit/contact-requests.test.ts`

**Interfaces:**
- Consumes: `PostgresRateLimiter` and `createServiceClient` (Block 0), `contact_requests` (Task 3).
- Produces: `submitContactRequest(input, ipAddress): Promise<void>`.

This gives Block 0's rate limiter its first real consumer.

- [ ] **Step 1: Write the schema**

`src/schemas/contact.ts`:

```ts
import { z } from 'zod';

export const contactRequestSchema = z.object({
  name: z.string().trim().min(2).max(120),
  email: z.string().trim().email(),
  phone: z.string().trim().max(40).optional(),
  companyName: z.string().trim().max(120).optional(),
  message: z.string().trim().max(2000).optional(),
});

export type ContactRequestInput = z.infer<typeof contactRequestSchema>;
```

- [ ] **Step 2: Write the failing test**

`tests/unit/contact-requests.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { hashIpAddress } from '@/services/contact-requests';

describe('hashIpAddress', () => {
  it('never returns the raw address', () => {
    expect(hashIpAddress('203.0.113.7')).not.toContain('203.0.113.7');
  });

  it('is stable for the same address', () => {
    expect(hashIpAddress('203.0.113.7')).toBe(hashIpAddress('203.0.113.7'));
  });

  it('differs across addresses', () => {
    expect(hashIpAddress('203.0.113.7')).not.toBe(hashIpAddress('203.0.113.8'));
  });
});
```

- [ ] **Step 3: Run and see it fail**

Run: `npm run test -- contact-requests`
Expected: FAIL — module not found.

- [ ] **Step 4: Write the service**

`src/services/contact-requests.ts`:

```ts
import 'server-only';
import { createHash } from 'node:crypto';
import { createServiceClient } from '@/lib/supabase/service-client';
import { PostgresRateLimiter } from '@/lib/rate-limit';
import { RateLimitError, InternalError } from '@/lib/errors';
import { logger } from '@/lib/logger';
import { DevMailer, SmtpMailer, type Mailer } from '@/lib/mailer';
import { env } from '@/lib/env';
import type { ContactRequestInput } from '@/schemas/contact';

const WINDOW_SECONDS = 3600;
const MAX_PER_WINDOW = 5;

/** SMTP when configured, otherwise the recording DevMailer from Block 0. */
function resolveMailer(): Mailer {
  if (env.SMTP_URL && env.MAIL_FROM) return new SmtpMailer(env.SMTP_URL, env.MAIL_FROM);
  return new DevMailer();
}

/** Stored instead of the raw address: enough to rate limit, not enough to identify. */
export function hashIpAddress(ip: string): string {
  return createHash('sha256').update(ip).digest('hex').slice(0, 32);
}

export async function submitContactRequest(
  input: ContactRequestInput,
  ipAddress: string,
): Promise<void> {
  const client = createServiceClient();
  const limiter = new PostgresRateLimiter(client);
  const ipHash = hashIpAddress(ipAddress);

  const verdict = await limiter.check(`contact:${ipHash}`, MAX_PER_WINDOW, WINDOW_SECONDS);
  if (!verdict.allowed) {
    throw new RateLimitError('Too many submissions. Please try again later.');
  }

  const { error } = await client.from('contact_requests').insert({
    name: input.name,
    email: input.email,
    phone: input.phone ?? null,
    company_name: input.companyName ?? null,
    message: input.message ?? null,
    ip_hash: ipHash,
  });

  if (error) {
    throw new InternalError(`Could not record the contact request: ${error.message}`);
  }

  logger.info({ email: input.email }, 'contact request received');

  // Storage is the source of truth; the notification is best-effort. A failed
  // e-mail must never lose a lead, so this cannot throw past the insert.
  if (env.MAIL_FROM) {
    try {
      await resolveMailer().send({
        to: env.MAIL_FROM,
        subject: `New PulchatX contact request from ${input.name}`,
        text: [
          `Name: ${input.name}`,
          `E-mail: ${input.email}`,
          `Phone: ${input.phone ?? '-'}`,
          `Company: ${input.companyName ?? '-'}`,
          '',
          input.message ?? '(no message)',
        ].join('\n'),
      });
    } catch (cause) {
      logger.error({ err: cause }, 'contact request stored but notification failed');
    }
  }
}
```

- [ ] **Step 5: Run and see it pass**

Run: `npm run test -- contact-requests`
Then: `npm run typecheck`
Expected: both PASS.

- [ ] **Step 6: Commit**

```bash
git add src/schemas/contact.ts src/services/contact-requests.ts tests/unit/contact-requests.test.ts
git commit -m "feat: add contact request intake with rate limiting"
```

---

## Task 13: Public pages — landing, contact, login

**Files:**
- Create: `src/app/(public)/layout.tsx`, `src/app/(public)/page.tsx`, `src/app/(public)/contato/page.tsx`, `src/app/(public)/login/page.tsx`
- Delete: `src/app/page.tsx`
- Modify: `tests/e2e/home.spec.ts`

**Interfaces:**
- Consumes: `submitContactRequest` (Task 12), `contactRequestSchema`.

- [ ] **Step 1: Move the home page into the public route group**

Delete `src/app/page.tsx` and create `src/app/(public)/layout.tsx`:

```tsx
export default function PublicLayout({ children }: { children: React.ReactNode }) {
  return <div className="mx-auto min-h-screen max-w-3xl px-6 py-16">{children}</div>;
}
```

`src/app/(public)/page.tsx`:

```tsx
import Link from 'next/link';
import { Button } from '@/components/ui/button';

export default function Home() {
  return (
    <main className="flex flex-col gap-6">
      <h1 className="text-3xl font-semibold">PulchatX</h1>
      <p className="text-muted-foreground">
        CRM for entertainment companies. Manage your audience relationship and the whole prize
        distribution cycle of your promotions.
      </p>
      <p className="text-muted-foreground">
        PulchatX is sold by subscription. Get in touch and we will set your account up.
      </p>
      <div className="flex gap-3">
        <Button asChild>
          <Link href="/contato">Get in touch</Link>
        </Button>
        <Button variant="outline" asChild>
          <Link href="/login">Sign in</Link>
        </Button>
      </div>
    </main>
  );
}
```

> `asChild` requires the shadcn Slot pattern. If `Button` does not support it, wrap with `<Link>` outside the button instead — do not add Radix Slot just for this.

- [ ] **Step 2: Write the contact page with its Server Action**

`src/app/(public)/contato/page.tsx`:

```tsx
import { headers } from 'next/headers';
import { contactRequestSchema } from '@/schemas/contact';
import { submitContactRequest } from '@/services/contact-requests';
import { Button } from '@/components/ui/button';

export default function ContactPage({
  searchParams,
}: {
  searchParams: Promise<{ sent?: string; error?: string }>;
}) {
  async function submit(formData: FormData) {
    'use server';
    const parsed = contactRequestSchema.safeParse({
      name: formData.get('name'),
      email: formData.get('email'),
      phone: formData.get('phone') || undefined,
      companyName: formData.get('companyName') || undefined,
      message: formData.get('message') || undefined,
    });

    const { redirect } = await import('next/navigation');
    if (!parsed.success) redirect('/contato?error=invalid');

    const headerList = await headers();
    const ip = headerList.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';

    try {
      await submitContactRequest(parsed.data, ip);
    } catch {
      redirect('/contato?error=failed');
    }
    redirect('/contato?sent=1');
  }

  return <ContactForm action={submit} searchParams={searchParams} />;
}

async function ContactForm({
  action,
  searchParams,
}: {
  action: (formData: FormData) => Promise<void>;
  searchParams: Promise<{ sent?: string; error?: string }>;
}) {
  const params = await searchParams;

  if (params.sent) {
    return (
      <main className="flex flex-col gap-4">
        <h1 className="text-2xl font-semibold">Thank you</h1>
        <p className="text-muted-foreground">We received your message and will be in touch.</p>
      </main>
    );
  }

  return (
    <main className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold">Get in touch</h1>
      {params.error ? (
        <p className="text-sm text-destructive">
          {params.error === 'invalid'
            ? 'Please check the fields and try again.'
            : 'Something went wrong. Please try again later.'}
        </p>
      ) : null}
      <form action={action} className="flex flex-col gap-4">
        <input name="name" placeholder="Your name" required className="rounded-md border p-2" />
        <input name="email" type="email" placeholder="E-mail" required className="rounded-md border p-2" />
        <input name="phone" placeholder="Phone (optional)" className="rounded-md border p-2" />
        <input name="companyName" placeholder="Company (optional)" className="rounded-md border p-2" />
        <textarea name="message" placeholder="How can we help?" rows={4} className="rounded-md border p-2" />
        <Button type="submit">Send</Button>
      </form>
    </main>
  );
}
```

- [ ] **Step 3: Write the login page**

`src/app/(public)/login/page.tsx`:

```tsx
import { redirect } from 'next/navigation';
import { createUserClient } from '@/lib/supabase/user-client';
import { Button } from '@/components/ui/button';

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const params = await searchParams;

  async function signIn(formData: FormData) {
    'use server';
    const supabase = await createUserClient();
    const { error } = await supabase.auth.signInWithPassword({
      email: String(formData.get('email') ?? ''),
      password: String(formData.get('password') ?? ''),
    });
    // Deliberately generic: a distinct "no such user" message would let an
    // attacker enumerate accounts (spec §9).
    if (error) redirect('/login?error=1');
    redirect('/change-password');
  }

  return (
    <main className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold">Sign in</h1>
      {params.error ? <p className="text-sm text-destructive">Invalid credentials.</p> : null}
      <form action={signIn} className="flex flex-col gap-4">
        <input name="email" type="email" placeholder="E-mail" required className="rounded-md border p-2" />
        <input name="password" type="password" placeholder="Password" required className="rounded-md border p-2" />
        <Button type="submit">Sign in</Button>
      </form>
    </main>
  );
}
```

> Redirecting to `/change-password` is safe for everyone: the middleware bounces users who do not need it straight to `/admin/customers`.

- [ ] **Step 4: Update the e2e test**

`tests/e2e/home.spec.ts`:

```ts
import { test, expect } from '@playwright/test';

test('home shows the product and links to contact', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'PulchatX' })).toBeVisible();
  await expect(page.getByRole('link', { name: /Get in touch/i })).toBeVisible();
});

test('contact page renders the form', async ({ page }) => {
  await page.goto('/contato');
  await expect(page.getByRole('heading', { name: /Get in touch/i })).toBeVisible();
  await expect(page.getByPlaceholder('Your name')).toBeVisible();
});
```

- [ ] **Step 5: Verify**

Run: `npm run lint`
Then: `npm run typecheck`
Then: `npm run test:e2e`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add src/app tests/e2e/home.spec.ts
git commit -m "feat: add public landing, contact and login pages"
```

---

## Task 14: Change-password screen

**Files:**
- Create: `src/app/(app)/change-password/page.tsx`
- Create: `supabase/migrations/0008_complete_password_change.sql`

**Interfaces:**
- Produces: `complete_password_change() → void` — clears the gate for the calling user.

The flag must not be clearable by an ordinary UPDATE, or a user could skip the gate by writing to their own profile row. It is cleared only by a `SECURITY DEFINER` function, called after Supabase Auth confirms the password actually changed.

- [ ] **Step 1: Write the migration**

`supabase/migrations/0008_complete_password_change.sql`:

```sql
-- profiles_update_self lets a user edit their own row, which would include
-- must_change_password. Clearing the gate therefore goes through this
-- function instead, called only after auth.updateUser() has succeeded.
create or replace function public.complete_password_change()
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_user uuid := auth.uid();
begin
  if v_user is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;

  update public.profiles
     set must_change_password   = false,
         provisional_expires_at = null,
         updated_at             = now()
   where id = v_user;

  insert into public.audit_logs (actor_id, action, target_table, target_id)
  values (v_user, 'complete_password_change', 'profiles', v_user);
end;
$$;

revoke execute on function public.complete_password_change() from public;
grant execute on function public.complete_password_change() to authenticated;

-- Close the hole the policy would otherwise leave: a user may update their
-- own profile, but not these two columns.
revoke update (must_change_password, provisional_expires_at)
  on public.profiles from authenticated;
```

- [ ] **Step 2: Write the page**

`src/app/(app)/change-password/page.tsx`:

```tsx
import { redirect } from 'next/navigation';
import { createUserClient } from '@/lib/supabase/user-client';
import { Button } from '@/components/ui/button';

export default async function ChangePasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const params = await searchParams;

  async function change(formData: FormData) {
    'use server';
    const password = String(formData.get('password') ?? '');
    const confirm = String(formData.get('confirm') ?? '');

    if (password.length < 10) redirect('/change-password?error=short');
    if (password !== confirm) redirect('/change-password?error=mismatch');

    const supabase = await createUserClient();
    const { error } = await supabase.auth.updateUser({ password });
    if (error) redirect('/change-password?error=failed');

    const { error: rpcError } = await supabase.rpc('complete_password_change');
    if (rpcError) redirect('/change-password?error=failed');

    redirect('/admin/customers');
  }

  const messages: Record<string, string> = {
    short: 'The password must be at least 10 characters.',
    mismatch: 'The two passwords do not match.',
    failed: 'Could not change the password. Please try again.',
  };

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-6 px-6">
      <h1 className="text-2xl font-semibold">Choose a new password</h1>
      <p className="text-muted-foreground">
        Your account was created with a provisional password. Choose your own to continue.
      </p>
      {params.error ? (
        <p className="text-sm text-destructive">{messages[params.error] ?? messages.failed}</p>
      ) : null}
      <form action={change} className="flex flex-col gap-4">
        <input name="password" type="password" placeholder="New password" required className="rounded-md border p-2" />
        <input name="confirm" type="password" placeholder="Repeat the password" required className="rounded-md border p-2" />
        <Button type="submit">Save</Button>
      </form>
    </main>
  );
}
```

- [ ] **Step 3: Verify**

Run: `npm run db:reset`
Then: `npm run typecheck`
Then: `npm run test:isolation`
Expected: all PASS.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/0008_complete_password_change.sql "src/app/(app)"
git commit -m "feat(auth): add change-password screen behind a database-enforced gate"
```

---

## Task 15: Password reset and sign out

**Files:**
- Create: `src/app/(public)/forgot-password/page.tsx`
- Create: `src/app/auth/callback/route.ts`
- Create: `src/app/auth/signout/route.ts`
- Modify: `src/app/(public)/login/page.tsx` (add the link)
- Modify: `src/middleware.ts` (allow the new public paths)

**Interfaces:**
- Consumes: `createUserClient` (Block 0).
- Produces: the reset request page, the code-exchange callback, and a sign-out route.

The spec lists four auth flows for this block: sign in, sign out, change password and **reset password**. Tasks 13 and 14 cover the first and third; this task covers the other two.

- [ ] **Step 1: Write the reset request page**

`src/app/(public)/forgot-password/page.tsx`:

```tsx
import { redirect } from 'next/navigation';
import { createUserClient } from '@/lib/supabase/user-client';
import { Button } from '@/components/ui/button';

export default async function ForgotPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ sent?: string }>;
}) {
  const params = await searchParams;

  async function request(formData: FormData) {
    'use server';
    const email = String(formData.get('email') ?? '');
    const supabase = await createUserClient();

    await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3000'}/auth/callback?next=/change-password`,
    });

    // Always report success. Revealing whether an address exists would let an
    // attacker enumerate customers (spec §9).
    redirect('/forgot-password?sent=1');
  }

  if (params.sent) {
    return (
      <main className="flex flex-col gap-4">
        <h1 className="text-2xl font-semibold">Check your inbox</h1>
        <p className="text-muted-foreground">
          If that address belongs to an account, we sent a link to reset the password.
        </p>
      </main>
    );
  }

  return (
    <main className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold">Reset your password</h1>
      <form action={request} className="flex flex-col gap-4">
        <input name="email" type="email" placeholder="E-mail" required className="rounded-md border p-2" />
        <Button type="submit">Send the link</Button>
      </form>
    </main>
  );
}
```

- [ ] **Step 2: Add `NEXT_PUBLIC_SITE_URL` to the env schema**

In `src/lib/env.ts`, add to `envSchema`:

```ts
  NEXT_PUBLIC_SITE_URL: z.string().url().optional(),
```

Add to `.env.example`:

```bash
# Public base URL, used to build password-reset links.
NEXT_PUBLIC_SITE_URL=http://localhost:3000
```

- [ ] **Step 3: Write the callback route**

`src/app/auth/callback/route.ts`:

```ts
import { NextResponse, type NextRequest } from 'next/server';
import { createUserClient } from '@/lib/supabase/user-client';

/**
 * Supabase sends the user here with a one-time code after they click the
 * reset link. Exchanging it establishes the session; the middleware then
 * routes them onward.
 */
export async function GET(request: NextRequest) {
  const { searchParams, origin } = request.nextUrl;
  const code = searchParams.get('code');
  const next = searchParams.get('next') ?? '/change-password';

  if (!code) return NextResponse.redirect(`${origin}/login?error=1`);

  const supabase = await createUserClient();
  const { error } = await supabase.auth.exchangeCodeForSession(code);
  if (error) return NextResponse.redirect(`${origin}/login?error=1`);

  return NextResponse.redirect(`${origin}${next}`);
}
```

- [ ] **Step 4: Write the sign-out route**

`src/app/auth/signout/route.ts`:

```ts
import { NextResponse, type NextRequest } from 'next/server';
import { createUserClient } from '@/lib/supabase/user-client';

export async function POST(request: NextRequest) {
  const supabase = await createUserClient();
  await supabase.auth.signOut();
  return NextResponse.redirect(new URL('/login', request.url), { status: 303 });
}
```

- [ ] **Step 5: Let the middleware through**

In `src/middleware.ts`, extend the public list:

```ts
const PUBLIC_PATHS = [
  '/',
  '/contato',
  '/login',
  '/forgot-password',
  '/auth/callback',
  '/api/health',
];
```

`/auth/callback` **must** be public: the user arriving from the e-mail has no session yet, and without this the middleware would bounce them to `/login` before the code could be exchanged.

- [ ] **Step 6: Add the link on the login page**

In `src/app/(public)/login/page.tsx`, below the form:

```tsx
      <a href="/forgot-password" className="text-sm underline">
        Forgot your password?
      </a>
```

- [ ] **Step 7: Verify**

Run: `npm run lint`
Then: `npm run typecheck`
Then: `$env:SKIP_ENV_VALIDATION=1; npm run build`
Expected: all PASS.

Then exercise it locally: request a reset for a provisioned user, open Inbucket at `http://127.0.0.1:54324`, click the link, and confirm you land on the change-password screen with a session.

- [ ] **Step 8: Commit**

```bash
git add "src/app/(public)/forgot-password" src/app/auth src/middleware.ts src/lib/env.ts .env.example "src/app/(public)/login/page.tsx"
git commit -m "feat(auth): add password reset and sign out"
```

---

## Task 16: Admin screens — provisioning, contact queue, suspension

**Files:**
- Create: `src/app/(admin)/layout.tsx`, `src/app/(admin)/admin/customers/page.tsx`, `src/app/(admin)/admin/contact-requests/page.tsx`

**Interfaces:**
- Consumes: `provisionCustomer` (Task 11), `suspend_company` / `reactivate_company` (Task 6), the sign-out route (Task 15).

- [ ] **Step 1: Write the admin layout with its guard**

`src/app/(admin)/layout.tsx`:

```tsx
import { redirect } from 'next/navigation';
import { createUserClient } from '@/lib/supabase/user-client';

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createUserClient();
  const { data: isAdmin } = await supabase.rpc('is_platform_admin');

  // Defense in depth: the RPCs re-check this themselves, but a non-admin
  // should never see the screens either.
  if (!isAdmin) redirect('/login');

  return (
    <div className="mx-auto min-h-screen max-w-4xl px-6 py-12">
      <nav className="mb-8 flex items-center justify-between">
        <div className="flex gap-4 text-sm">
          <a href="/admin/customers" className="underline">Customers</a>
          <a href="/admin/contact-requests" className="underline">Contact requests</a>
        </div>
        <form action="/auth/signout" method="post">
          <button type="submit" className="text-sm underline">Sign out</button>
        </form>
      </nav>
      {children}
    </div>
  );
}
```

- [ ] **Step 2: Write the provisioning screen**

`src/app/(admin)/admin/customers/page.tsx`:

```tsx
import { redirect } from 'next/navigation';
import { createUserClient } from '@/lib/supabase/user-client';
import { provisionCustomerSchema } from '@/schemas/provisioning';
import { provisionCustomer } from '@/services/provisioning';
import { Button } from '@/components/ui/button';

export default async function CustomersPage({
  searchParams,
}: {
  searchParams: Promise<{ password?: string; email?: string; error?: string }>;
}) {
  const params = await searchParams;
  const supabase = await createUserClient();

  const { data: companies } = await supabase
    .from('companies')
    .select('id, name, status, created_at')
    .order('created_at', { ascending: false });

  async function provision(formData: FormData) {
    'use server';
    const parsed = provisionCustomerSchema.safeParse({
      organizationName: formData.get('organizationName'),
      companyName: formData.get('companyName'),
      ownerEmail: formData.get('ownerEmail'),
      ownerName: formData.get('ownerName') || undefined,
      timezone: formData.get('timezone') || undefined,
    });
    if (!parsed.success) redirect('/admin/customers?error=invalid');

    const client = await createUserClient();
    const { data: sessionData } = await client.auth.getSession();
    const token = sessionData.session?.access_token;
    if (!token) redirect('/login');

    try {
      const result = await provisionCustomer(parsed.data, token);
      // Shown once, in the URL of a redirect the admin alone sees. It is not
      // stored anywhere and never reaches a log.
      redirect(
        `/admin/customers?password=${encodeURIComponent(result.provisionalPassword)}&email=${encodeURIComponent(parsed.data.ownerEmail)}`,
      );
    } catch {
      redirect('/admin/customers?error=failed');
    }
  }

  async function suspend(formData: FormData) {
    'use server';
    const client = await createUserClient();
    await client.rpc('suspend_company', {
      p_company_id: String(formData.get('companyId')),
      p_reason: String(formData.get('reason') ?? 'non-payment'),
    });
    redirect('/admin/customers');
  }

  async function reactivate(formData: FormData) {
    'use server';
    const client = await createUserClient();
    await client.rpc('reactivate_company', {
      p_company_id: String(formData.get('companyId')),
    });
    redirect('/admin/customers');
  }

  return (
    <main className="flex flex-col gap-10">
      <section className="flex flex-col gap-4">
        <h1 className="text-2xl font-semibold">Provision a customer</h1>
        {params.error ? (
          <p className="text-sm text-destructive">
            {params.error === 'invalid' ? 'Check the fields.' : 'Provisioning failed and was rolled back.'}
          </p>
        ) : null}
        {params.password ? (
          <div className="rounded-md border border-primary p-4">
            <p className="text-sm">
              Created for <strong>{params.email}</strong>. Provisional password, shown once:
            </p>
            <code className="mt-2 block text-lg">{params.password}</code>
            <p className="mt-2 text-sm text-muted-foreground">
              It expires in 7 days and must be changed on first sign-in.
            </p>
          </div>
        ) : null}
        <form action={provision} className="flex flex-col gap-3">
          <input name="organizationName" placeholder="Organization name" required className="rounded-md border p-2" />
          <input name="companyName" placeholder="Company (Station) name" required className="rounded-md border p-2" />
          <input name="ownerEmail" type="email" placeholder="Owner e-mail" required className="rounded-md border p-2" />
          <input name="ownerName" placeholder="Owner name (optional)" className="rounded-md border p-2" />
          <Button type="submit">Provision</Button>
        </form>
      </section>

      <section className="flex flex-col gap-4">
        <h2 className="text-xl font-semibold">Companies</h2>
        <ul className="flex flex-col gap-2">
          {(companies ?? []).map((c) => (
            <li key={c.id} className="flex items-center justify-between rounded-md border p-3">
              <span>
                {c.name} — <em>{c.status}</em>
              </span>
              {c.status === 'active' ? (
                <form action={suspend}>
                  <input type="hidden" name="companyId" value={c.id} />
                  <input name="reason" placeholder="Reason" className="mr-2 rounded border p-1 text-sm" />
                  <Button type="submit" variant="outline">Suspend</Button>
                </form>
              ) : (
                <form action={reactivate}>
                  <input type="hidden" name="companyId" value={c.id} />
                  <Button type="submit" variant="outline">Reactivate</Button>
                </form>
              )}
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}
```

- [ ] **Step 3: Write the contact queue**

`src/app/(admin)/admin/contact-requests/page.tsx`:

```tsx
import { createUserClient } from '@/lib/supabase/user-client';

export default async function ContactRequestsPage() {
  const supabase = await createUserClient();
  const { data: requests } = await supabase
    .from('contact_requests')
    .select('id, name, email, phone, company_name, message, status, created_at')
    .order('created_at', { ascending: false });

  return (
    <main className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold">Contact requests</h1>
      {(requests ?? []).length === 0 ? (
        <p className="text-muted-foreground">Nothing yet.</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {(requests ?? []).map((r) => (
            <li key={r.id} className="rounded-md border p-3">
              <p className="font-medium">
                {r.name} — {r.email} {r.phone ? `— ${r.phone}` : ''}
              </p>
              {r.company_name ? <p className="text-sm">{r.company_name}</p> : null}
              {r.message ? <p className="mt-1 text-sm text-muted-foreground">{r.message}</p> : null}
              <p className="mt-1 text-xs text-muted-foreground">{r.status}</p>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
```

- [ ] **Step 4: Verify**

Run: `npm run lint`
Then: `npm run typecheck`
Then: `$env:SKIP_ENV_VALIDATION=1; npm run build`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add "src/app/(admin)"
git commit -m "feat(admin): add provisioning, suspension and contact queue screens"
```

---

## Task 17: End-to-end verification and deployment notes

**Files:**
- Create: `docs/block-1a-report.md`
- Modify: `docs/bloco-0-handoff.md` — strike the items this block closed (`middleware.ts`, generated `Database` types) and leave the rest

- [ ] **Step 1: Run the whole gate**

Run each separately:
- `npm run lint`
- `npm run typecheck`
- `npm run test`
- `npm run db:reset`
- `npm run db:test`
- `npm run test:isolation`
- `npm run test:e2e`
- `$env:SKIP_ENV_VALIDATION=1; npm run build`
- `docker build -t pulchatx:dev .`

Expected: all PASS. Capture verbatim output.

- [ ] **Step 2: Exercise the flow by hand**

With the stack running and a platform admin seeded (insert your own user id into `platform_admins` via the local Studio), walk through: provision a customer → copy the provisional password → sign in as that customer in a private window → confirm the forced change → confirm you land in the app. Then suspend the company and confirm `has_company_access` returns false.

- [ ] **Step 3: Write the deployment notes**

`docs/block-1a-report.md` must record, at minimum:

- **Disable signup on the hosted project** — Authentication → Providers → Email → "Allow new users to sign up" off. The local `config.toml` does not propagate; this is manual.
- **Raise the hosted minimum password length** to 10 to match local.
- **Configure custom SMTP** on the hosted project so password reset works; the built-in sender is rate limited and unsuitable for production.
- **Seed the first platform admin** — there is no UI for it by design. Document the exact SQL.
- Verbatim output of every command from Step 1.

- [ ] **Step 4: Commit**

```bash
git add docs/
git commit -m "docs: add Block 1a verification report and deployment notes"
```

---

## Definition of Done

- [ ] Provisioning creates user, organization, company and both memberships — or fails cleanly with no orphaned auth user.
- [ ] The customer signs in with the provisional password, is forced to change it, and reaches the app.
- [ ] A cross-tenant read **and** write both fail under a real JWT.
- [ ] Public `signUp` is refused, proven by a test.
- [ ] An ordinary user calling `provision_customer`, `suspend_company` or `reactivate_company` is rejected.
- [ ] A suspended Company yields no business data, even to its Owner; its metadata stays visible.
- [ ] The contact form records, notifies and is rate limited.
- [ ] Deliberately breaking a policy makes the isolation suite fail (proven in Task 9).
- [ ] `lint`, `typecheck`, unit, pgTAP, isolation, e2e and `docker build` all pass.

## Out of scope

Granular permissions as data · invitations · Company selector · consolidated view · org-scoped audit viewing · member, prize and promotion domains. All of these are Block 1b or later.
