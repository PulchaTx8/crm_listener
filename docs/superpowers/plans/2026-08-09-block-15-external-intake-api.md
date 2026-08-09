# Block 15 — External Intake API and the Station's Record — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Two machine endpoints — `POST /api/v1/songs` and `POST /api/v1/music-requests` — authenticated by a per-Station API key held in the database, plus the columns a radio Station actually has (address, dial frequency, coordinates, picture) edited from the platform console and shown on the `/app` card.

**Architecture:** Each endpoint is a thin Next.js route handler that authenticates, validates with Zod, optionally enriches from Deezer, and then calls exactly **one** `SECURITY DEFINER` plpgsql door. The door does all writes in one transaction, so a failure anywhere leaves no orphan artist, label, genre or album behind. The API key is the subject: its scopes are permission codes foreign-keyed to `public.permissions`, and the doors check the credential's scope instead of `has_permission`, which would ask about `auth.uid()` and find nobody.

**Tech Stack:** Next.js App Router (route handlers, `runtime = 'nodejs'`), Supabase Postgres with plpgsql RPCs, Zod, Vitest, pgTAP, Playwright, next-intl.

**Design spec:** `docs/superpowers/specs/2026-08-09-external-intake-api-design.md`. Read it before Task 1; every `D<n>` reference below points into its §3.

---

## Global Constraints

- **Migrations are numbered `0148`–`0153`** and land in `supabase/migrations/`. The last existing migration is `0147_branding_read_policy_removed.sql`.
- **`0151` contains one statement and nothing else.** `alter type ... add value` cannot share a transaction with a statement that uses the new value.
- **Every new function is `SECURITY DEFINER` with `set search_path = pg_catalog, public`**, except where a comment states otherwise. Postgres grants `EXECUTE` to `PUBLIC` on every newly created function, so **every** function gets an explicit `revoke execute ... from public` and only then a `grant` to the role that may call it.
- **Private cores are granted to nobody.** `revoke` with no matching `grant` is their whole protection.
- **New tables get `enable row level security` and no policy.** They are reachable only from inside `SECURITY DEFINER` bodies — the shape `integrations` (0057) uses. `createServiceClient().from('api_credentials')` will fail with 42501 and that is intended.
- **Code, comments, commit messages and docs are in English.** UI strings go through next-intl in all three of `messages/en.json`, `messages/es.json`, `messages/pt.json`.
- **No raw Postgres error text ever reaches an HTTP response body.**
- **The raw API token never reaches the database**, not even as an RPC argument. It is hashed in Node with `node:crypto`.
- **Do not stage `scripts/seed-demo.mjs`.** It carries ~507 lines of uncommitted work that belongs to another effort. Every `git add` in this plan names files explicitly; never use `git add -A` or `git add .`.
- **Verification commands:** `npm run typecheck`, `npm run lint`, `npm test`, `npm run db:test`, `npm run test:isolation`, `npm run test:e2e`.
- After any migration that changes a table or function signature, regenerate types: `npm run db:types`.

---

## File Structure

**Database**

| File | Responsibility |
| --- | --- |
| `supabase/migrations/0148_api_credentials.sql` | `api_credentials`, `api_credential_scopes`, RLS on, no policy |
| `supabase/migrations/0149_api_credential_rpcs.sql` | `authenticate_`, `issue_`, `revoke_`, `list_api_credentials` |
| `supabase/migrations/0150_external_ids.sql` | `external_id` on `songs` and `music_requests`, partial unique indexes |
| `supabase/migrations/0151_music_request_channel_api.sql` | `add value 'API'` — this statement alone |
| `supabase/migrations/0152_api_intake_doors.sql` | tracked resolvers, `apply_song_intake` core, the two public API doors |
| `supabase/migrations/0153_company_profile.sql` | Station columns, `update_company_profile`, `set_company_thumb`, `may_write_artwork` branch |

**Application**

| File | Responsibility |
| --- | --- |
| `src/lib/api/credentials.ts` | parse the `Authorization` header, hash the token, call `authenticate_api_credential` |
| `src/lib/api/errors.ts` | the stable error-code taxonomy and the SQLSTATE mapping |
| `src/lib/api/respond.ts` | the JSON envelope, `X-Request-Id`, the body-size and content-type guards |
| `src/schemas/api.ts` | Zod for both request bodies, and the Deezer-shape normaliser |
| `src/services/api-credentials.ts` | issue / list / revoke, secret generation |
| `src/services/company-profile.ts` | `update_company_profile`, thumb upload and clear |
| `src/app/api/v1/songs/route.ts` | endpoint 1 |
| `src/app/api/v1/music-requests/route.ts` | endpoint 2, including the Deezer album enrichment |
| `src/app/(admin)/admin/customers/station-form.tsx` | the Customer tab's new form |
| `src/app/(admin)/admin/customers/api-keys-tab.tsx` | the API keys tab |
| `src/app/(app)/app/page.tsx` | the card, with thumb, frequency and address |
| `scripts/issue-api-key.mjs` | issue a key from the command line, for use before the console tab ships |

**Tests**

| File | Responsibility |
| --- | --- |
| `supabase/tests/33_api_credentials.test.sql` | the credential gate |
| `supabase/tests/34_api_intake.test.sql` | the ladder, gap-fill, the request door |
| `supabase/tests/35_company_profile.test.sql` | the Station columns and their two writers |
| `tests/unit/api-credentials.test.ts` | header parsing and hashing |
| `tests/unit/api-errors.test.ts` | the taxonomy and SQLSTATE mapping |
| `tests/unit/api-schemas.test.ts` | strictness, the `song.deezer` exception, normalisation |
| `tests/isolation/api-intake.isolation.test.ts` | a Station A key writes nothing into Station B |
| `tests/e2e/station-settings.spec.ts` | issue, reveal once, revoke; thumb upload; the card |

---

## Task 0: Branch

**Files:** none

- [ ] **Step 1: Confirm the working tree**

```bash
git status --short
```

Expected: exactly one line, ` M scripts/seed-demo.mjs`. If anything else is modified, stop and ask before continuing.

- [ ] **Step 2: Create the block branch from main, carrying the spec commit**

The design spec was committed onto `fix-login-hero-without-rls` (commit `bf14916`). It belongs with this block, so it is cherry-picked onto a branch cut from `main`. The uncommitted `seed-demo.mjs` follows the checkout untouched.

```bash
git switch -c block-15-external-intake-api main
git cherry-pick bf14916
git log --oneline -2
```

Expected: the spec commit on top of main's tip. If the cherry-pick conflicts, stop and ask.

- [ ] **Step 3: Confirm the WIP survived**

```bash
git status --short
```

Expected: still exactly ` M scripts/seed-demo.mjs`.

---

## Task 1: The credential tables

**Files:**
- Create: `supabase/migrations/0148_api_credentials.sql`
- Test: `supabase/tests/33_api_credentials.test.sql`

**Interfaces:**
- Produces: tables `public.api_credentials` (columns `id`, `organization_id`, `company_id`, `name`, `token_prefix`, `token_hash`, `expires_at`, `last_used_at`, `revoked_at`, `revoked_by`, `created_by`, `created_at`, `updated_at`) and `public.api_credential_scopes` (`credential_id`, `permission_code`).

- [ ] **Step 1: Write the failing test**

Create `supabase/tests/33_api_credentials.test.sql`:

```sql
begin;
select plan(7);

select has_table('public', 'api_credentials', 'the credential table exists');
select has_table('public', 'api_credential_scopes', 'and its scopes are a child table');

-- The scope is a real foreign key, not a string somebody typed. This is the
-- whole reason the scopes are not a text[] column.
select col_is_fk('public', 'api_credential_scopes', 'permission_code',
  'a scope must name a permission that exists');

-- RLS on, no policy: reachable only from inside SECURITY DEFINER bodies, the
-- shape 0057 uses for integrations.
select is(
  (select relrowsecurity from pg_class
    where oid = 'public.api_credentials'::regclass),
  true, 'row level security is enabled on the credentials');
select is(
  (select count(*) from pg_policies
    where schemaname = 'public' and tablename = 'api_credentials'),
  0::bigint, 'and there is no policy, so nothing reaches it directly');

insert into public.organizations (id, name) values
  ('00000000-0000-0000-0000-0000000000a1', 'Org api credentials');
insert into public.companies (id, organization_id, name, timezone) values
  ('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000a1',
   'Station api credentials', 'America/Sao_Paulo');

select throws_ok(
  $$insert into public.api_credentials
      (organization_id, company_id, name, token_prefix, token_hash)
    values ('00000000-0000-0000-0000-0000000000a1',
            '00000000-0000-0000-0000-0000000000b1',
            'Bad hash', 'ptx_abcd1234', 'not-a-sha-256')$$,
  '23514', null,
  'a token hash that is not lowercase hex of the right length is refused');

select throws_ok(
  $$insert into public.api_credential_scopes (credential_id, permission_code)
    values (gen_random_uuid(), 'music.invented')$$,
  '23503', null,
  'an invented scope is refused by the foreign key');

select * from finish();
rollback;
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run db:test`
Expected: FAIL — `relation "public.api_credentials" does not exist`.

- [ ] **Step 3: Write the migration**

Create `supabase/migrations/0148_api_credentials.sql`:

```sql
-- supabase/migrations/0148_api_credentials.sql

-- Block 15, design D1. The API key is the SUBJECT, not a borrowed identity.
--
-- Every write door in this product is SECURITY DEFINER and asks
-- has_permission(code, company), which since 0121 is
-- has_permission_for(auth.uid(), ...). A machine has no auth.uid(). The
-- rejected alternative was to bind each key to a robot auth.users row and gate
-- on has_permission_for: it needs a company_membership and a role, so the robot
-- APPEARS ON THE TEAM SCREEN AS IF IT WERE A PERSON -- and the day somebody
-- tidies that user away, the automation stops with a 403 nobody will connect to
-- the cause.
--
-- So the credential carries its own scopes, and they are permission CODES, so
-- there is one vocabulary rather than two drifting apart.

create table public.api_credentials (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id),
  company_id      uuid not null,

  -- What the operator calls it in the console. Not an identifier.
  name            text not null,

  -- The first twelve characters of the secret, stored in the clear so a list of
  -- keys can be told apart. Twelve is `ptx_` plus eight, which is 48 bits of
  -- the secret -- enough to distinguish, nowhere near enough to guess.
  token_prefix    text not null,

  -- The WHOLE secret, SHA-256, lowercase hex. The secret itself is shown once
  -- at issue and never stored, so "show it again" is not a feature withheld --
  -- there is nothing to show.
  token_hash      text not null,

  expires_at      timestamptz,
  last_used_at    timestamptz,
  revoked_at      timestamptz,
  revoked_by      uuid references auth.users (id),
  created_by      uuid references auth.users (id),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  constraint api_credentials_company_org_fk
    foreign key (company_id, organization_id)
    references public.companies (id, organization_id),

  constraint api_credentials_name_not_blank check (btrim(name) <> ''),

  -- The same shape rule webhook_events.external_id (0058) carries, and for the
  -- same reason: it refuses a RAW secret written into a column meant for a
  -- digest. A backstop, not a licence to skip hashing in the caller.
  constraint api_credentials_hash_shape check (token_hash ~ '^[0-9a-f]{64}$'),
  constraint api_credentials_prefix_shape check (token_prefix ~ '^ptx_[A-Za-z0-9_-]{8}$'),

  constraint api_credentials_revocation_shape check (
    (revoked_at is null and revoked_by is null)
    or (revoked_at is not null and revoked_by is not null))
);

comment on table public.api_credentials is
  'Block 15, D1. One machine key for one Station. Holds the SHA-256 of the secret and never the secret. Revocable one at a time, which is the whole argument against a shared secret in the environment.';

-- Total, not partial. Two live credentials may not share a hash, and neither may
-- a revoked one -- a revoked key must stay unusable rather than becoming
-- reissuable, and a collision here would silently resurrect it.
create unique index api_credentials_hash_unique on public.api_credentials (token_hash);

create index api_credentials_company_idx
  on public.api_credentials (company_id, created_at desc);

-- ---------------------------------------------------------------------------
-- The scopes. A CHILD TABLE rather than a text[] column, and that is the whole
-- point: permission_code is a real foreign key, so an invented scope is refused
-- by Postgres. A text[] would need a trigger to say the same thing, and a
-- trigger is a thing somebody can forget to write.
-- ---------------------------------------------------------------------------

create table public.api_credential_scopes (
  credential_id   uuid not null references public.api_credentials (id) on delete cascade,
  permission_code text not null references public.permissions (code),
  primary key (credential_id, permission_code)
);

comment on table public.api_credential_scopes is
  'Block 15. What one key may do, in permission codes. A foreign key against public.permissions, so the API and the screens share one vocabulary.';

-- No policy follows either table, and that is the deny. 0057's comment on
-- integrations is worth restating because it is the sentence most likely to
-- cost a day: bypassing RLS is not a table privilege. This schema revokes the
-- Supabase default ACL, so a role reaches a table only through an explicit
-- grant, and there is deliberately none here. `createServiceClient()
-- .from('api_credentials')` WILL FAIL with 42501. Every reader is inside a
-- SECURITY DEFINER body.
alter table public.api_credentials       enable row level security;
alter table public.api_credential_scopes enable row level security;
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run db:reset && npm run db:test`
Expected: `33_api_credentials` — 7 passing.

- [ ] **Step 5: Regenerate types and commit**

```bash
npm run db:types
git add supabase/migrations/0148_api_credentials.sql supabase/tests/33_api_credentials.test.sql src/lib/supabase/database.types.ts
git commit -m "feat(api): a Station can hold machine keys of its own"
```

---

## Task 2: The credential doors

**Files:**
- Create: `supabase/migrations/0149_api_credential_rpcs.sql`
- Modify: `supabase/tests/33_api_credentials.test.sql` (raise `plan(7)` to `plan(14)`, append)

**Interfaces:**
- Produces:
  - `authenticate_api_credential(p_token_hash text, p_scope text) returns table (credential_id uuid, organization_id uuid, company_id uuid, scope_ok boolean)` — zero rows means "no usable credential"; one row with `scope_ok = false` means "valid key, wrong scope". Granted to `service_role` only.
  - `issue_api_credential(p_company_id uuid, p_name text, p_token_prefix text, p_token_hash text, p_scopes text[], p_expires_at timestamptz default null) returns uuid` — granted to `authenticated`.
  - `revoke_api_credential(p_credential_id uuid) returns void` — granted to `authenticated`.
  - `list_api_credentials(p_company_id uuid) returns table (id uuid, name text, token_prefix text, scopes text[], expires_at timestamptz, last_used_at timestamptz, revoked_at timestamptz, created_at timestamptz)` — granted to `authenticated`.

- [ ] **Step 1: Write the failing tests**

Append to `supabase/tests/33_api_credentials.test.sql`, before `select * from finish();`, and change `select plan(7);` to `select plan(16);` — nine assertions are added below.

```sql
-- The doors ----------------------------------------------------------------

select has_function('public', 'authenticate_api_credential',
  array['text', 'text'], 'the authenticator exists');

-- service_role ONLY. An anon or authenticated caller reaching this would be
-- able to test hashes against the table at will.
select is(
  (select count(*) from information_schema.role_routine_grants
    where routine_schema = 'public' and routine_name = 'authenticate_api_credential'
      and grantee in ('anon', 'authenticated')),
  0::bigint, 'no browser role may call the authenticator');

-- A live credential, inserted directly: issue_api_credential is gated on
-- is_platform_admin() and this test has no session.
insert into public.api_credentials
  (id, organization_id, company_id, name, token_prefix, token_hash)
values
  ('00000000-0000-0000-0000-0000000000c1',
   '00000000-0000-0000-0000-0000000000a1',
   '00000000-0000-0000-0000-0000000000b1',
   'Live key', 'ptx_aaaabbbb', repeat('a', 64));
insert into public.api_credential_scopes (credential_id, permission_code)
values ('00000000-0000-0000-0000-0000000000c1', 'music.manage');

select is(
  (select company_id from public.authenticate_api_credential(repeat('a', 64), 'music.manage')),
  '00000000-0000-0000-0000-0000000000b1'::uuid,
  'a live key with the scope resolves to its Station');

select is(
  (select scope_ok from public.authenticate_api_credential(repeat('a', 64), 'music.request')),
  false,
  'and the same key reports a scope it does not hold, so the route can answer 403 rather than 401');

select is(
  (select count(*) from public.authenticate_api_credential(repeat('b', 64), 'music.manage')),
  0::bigint, 'an unknown hash resolves to nothing');

-- Revoked and expired are both "no usable credential", indistinguishable from
-- unknown outside. All three are one 401.
update public.api_credentials set revoked_at = now(), revoked_by = null
  where id = '00000000-0000-0000-0000-0000000000c1';
select is(
  (select count(*) from public.authenticate_api_credential(repeat('a', 64), 'music.manage')),
  0::bigint, 'a revoked key resolves to nothing');
update public.api_credentials set revoked_at = null
  where id = '00000000-0000-0000-0000-0000000000c1';

update public.api_credentials set expires_at = now() - interval '1 second'
  where id = '00000000-0000-0000-0000-0000000000c1';
select is(
  (select count(*) from public.authenticate_api_credential(repeat('a', 64), 'music.manage')),
  0::bigint, 'an expired key resolves to nothing');
update public.api_credentials set expires_at = null
  where id = '00000000-0000-0000-0000-0000000000c1';

-- A suspended Station stops its keys. Without this a lapsed subscription would
-- go on accepting machine writes for as long as nobody revoked the key.
update public.companies set status = 'suspended'
  where id = '00000000-0000-0000-0000-0000000000b1';
select is(
  (select count(*) from public.authenticate_api_credential(repeat('a', 64), 'music.manage')),
  0::bigint, 'a suspended Station stops its keys');
update public.companies set status = 'active'
  where id = '00000000-0000-0000-0000-0000000000b1';

-- No session, so is_platform_admin() is false: the three console doors refuse.
select throws_ok(
  $$select public.issue_api_credential(
      '00000000-0000-0000-0000-0000000000b1', 'Nope', 'ptx_ccccdddd',
      repeat('c', 64), array['music.manage'])$$,
  '42501', null, 'issuing a key requires the platform admin');
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run db:test`
Expected: FAIL — `function public.authenticate_api_credential does not exist`.

- [ ] **Step 3: Write the migration**

Create `supabase/migrations/0149_api_credential_rpcs.sql`:

```sql
-- supabase/migrations/0149_api_credential_rpcs.sql

-- Block 15, Task 2. The four doors onto 0148's tables.
--
-- THE AUTHENTICATOR IS GRANTED TO service_role AND NOBODY ELSE. It takes a hash
-- and answers whether it names a usable credential; a browser role holding it
-- could grind hashes against the table. Everything else here is gated on
-- is_platform_admin(), which is 0130's argument for the WhatsApp integration
-- applied unchanged: giving a machine write access to a Station is an act of
-- the platform, not of a Company role.

-- ---------------------------------------------------------------------------
-- 1. authenticate_api_credential.
--
-- ZERO ROWS versus ONE ROW WITH scope_ok = false is the whole contract, and the
-- route depends on it:
--   zero rows  -> 401. Unknown, revoked, expired, or the Station is gone or
--                 suspended. All four are one answer, so a caller probing with
--                 a stolen hash learns nothing about which it was.
--   scope_ok   -> 403 when false. The caller already proved it holds a valid
--                 key, so telling it which scope is missing gives away nothing
--                 it did not know, and an integrator cannot debug without it.
-- ---------------------------------------------------------------------------

create function public.authenticate_api_credential(
  p_token_hash text,
  p_scope      text
)
returns table (
  credential_id   uuid,
  organization_id uuid,
  company_id      uuid,
  scope_ok        boolean
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_id      uuid;
  v_org     uuid;
  v_company uuid;
begin
  select c.id, c.organization_id, c.company_id
    into v_id, v_org, v_company
  from public.api_credentials c
  join public.companies co
    on co.id = c.company_id
   and co.deleted_at is null
   and co.status = 'active'
  where c.token_hash = p_token_hash
    and c.revoked_at is null
    and (c.expires_at is null or c.expires_at > now());

  if not found then
    -- Returns zero rows. Deliberately NOT an exception: a wrong key is ordinary
    -- traffic on a public URL, and raising here would fill the log with
    -- stack traces for something the route answers with a plain 401.
    return;
  end if;

  -- AMORTISED, and the condition is the point: without it this is an UPDATE on
  -- one hot row for every single request the automation makes. Sixty seconds of
  -- resolution is ample for "when was this key last used?", which is the only
  -- question the column answers.
  update public.api_credentials
     set last_used_at = now()
   where id = v_id
     and (last_used_at is null or last_used_at < now() - interval '60 seconds');

  credential_id   := v_id;
  organization_id := v_org;
  company_id      := v_company;
  scope_ok        := exists (
    select 1 from public.api_credential_scopes s
     where s.credential_id = v_id and s.permission_code = p_scope);
  return next;
end;
$$;

comment on function public.authenticate_api_credential(text, text) is
  'Block 15. Resolves a presented token HASH to its Station, and reports separately whether the requested scope is held. Zero rows means unknown, revoked, expired or a Station that is gone or suspended -- one answer for four cases on purpose. EXECUTE is granted to service_role alone.';

revoke execute on function public.authenticate_api_credential(text, text) from public;
grant  execute on function public.authenticate_api_credential(text, text) to service_role;

-- ---------------------------------------------------------------------------
-- 2. issue_api_credential.
--
-- THE SECRET IS NOT GENERATED HERE. The caller sorts it in Node with
-- crypto.randomBytes and sends only the prefix and the hash. That is the same
-- rule the WhatsApp webhook follows for the wamid, and its comment gives the
-- reason: an argument passed to an RPC lands in query logs and in backups.
-- ---------------------------------------------------------------------------

create function public.issue_api_credential(
  p_company_id   uuid,
  p_name         text,
  p_token_prefix text,
  p_token_hash   text,
  p_scopes       text[],
  p_expires_at   timestamptz default null
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor uuid := auth.uid();
  v_org   uuid;
  v_name  text := nullif(btrim(p_name), '');
  v_id    uuid;
  v_scope text;
begin
  if not public.is_platform_admin() then
    raise log 'issue_api_credential denied: actor=% company=%', v_actor, p_company_id;
    raise exception 'permission denied: platform admin required' using errcode = '42501';
  end if;

  select organization_id into v_org
  from public.companies
  where id = p_company_id and deleted_at is null;

  if not found then
    raise exception 'station not found: %', p_company_id using errcode = 'P0002';
  end if;

  if v_name is null then
    raise exception 'a name is required' using errcode = '22023';
  end if;

  -- A key that may do nothing is a key somebody will spend an afternoon
  -- debugging. Refused at issue instead.
  if p_scopes is null or cardinality(p_scopes) = 0 then
    raise exception 'a key needs at least one scope' using errcode = '22023';
  end if;

  insert into public.api_credentials
    (organization_id, company_id, name, token_prefix, token_hash, expires_at, created_by)
  values
    (v_org, p_company_id, v_name, p_token_prefix, p_token_hash, p_expires_at, v_actor)
  returning id into v_id;

  -- One at a time rather than a set-returning insert, so the foreign key names
  -- the offending code in its error. `unnest` would report only that some
  -- member of the array was wrong.
  foreach v_scope in array p_scopes loop
    insert into public.api_credential_scopes (credential_id, permission_code)
    values (v_id, v_scope);
  end loop;

  insert into public.audit_logs
    (actor_id, action, target_table, target_id, organization_id, company_id, detail)
  values
    (v_actor, 'issue_api_credential', 'api_credentials', v_id, v_org, p_company_id,
     -- The prefix and the scopes, never the hash and never the secret. 0004's
     -- own comment on this column: never store credentials here.
     jsonb_build_object('name', v_name, 'token_prefix', p_token_prefix,
                        'scopes', to_jsonb(p_scopes), 'expires_at', p_expires_at));

  return v_id;
end;
$$;

comment on function public.issue_api_credential(uuid, text, text, text, text[], timestamptz) is
  'Block 15. Records a key whose secret was generated by the caller and never travels here. Gated on is_platform_admin() for 0130''s reason: machine access to a Station is an act of the platform. The audit detail carries the prefix and the scopes, never the hash.';

revoke execute on function public.issue_api_credential(uuid, text, text, text, text[], timestamptz) from public;
grant  execute on function public.issue_api_credential(uuid, text, text, text, text[], timestamptz) to authenticated;

-- ---------------------------------------------------------------------------
-- 3. revoke_api_credential. Soft, never a delete: the audit trail names a
-- credential id, and deleting the row would leave those entries pointing at
-- nothing.
-- ---------------------------------------------------------------------------

create function public.revoke_api_credential(p_credential_id uuid)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor   uuid := auth.uid();
  v_org     uuid;
  v_company uuid;
begin
  if not public.is_platform_admin() then
    raise log 'revoke_api_credential denied: actor=% credential=%', v_actor, p_credential_id;
    raise exception 'permission denied: platform admin required' using errcode = '42501';
  end if;

  select organization_id, company_id into v_org, v_company
  from public.api_credentials
  where id = p_credential_id and revoked_at is null;

  if not found then
    -- Already revoked, or never existed. One answer, and no complaint: a
    -- console that double-submits must not produce an error somebody
    -- investigates.
    return;
  end if;

  update public.api_credentials
     set revoked_at = now(), revoked_by = v_actor, updated_at = now()
   where id = p_credential_id;

  insert into public.audit_logs
    (actor_id, action, target_table, target_id, organization_id, company_id, detail)
  values
    (v_actor, 'revoke_api_credential', 'api_credentials', p_credential_id, v_org, v_company,
     jsonb_build_object('credential_id', p_credential_id));
end;
$$;

comment on function public.revoke_api_credential(uuid) is
  'Block 15. Marks a key dead. Soft, because audit entries name the credential id and a delete would leave them pointing at nothing. Revoking an already-revoked key is silent.';

revoke execute on function public.revoke_api_credential(uuid) from public;
grant  execute on function public.revoke_api_credential(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 4. list_api_credentials. Revoked keys are INCLUDED: "was this key ever
-- issued, and when did it die?" is the question somebody asks during an
-- incident, and a list that hides them cannot answer it.
-- ---------------------------------------------------------------------------

create function public.list_api_credentials(p_company_id uuid)
returns table (
  id           uuid,
  name         text,
  token_prefix text,
  scopes       text[],
  expires_at   timestamptz,
  last_used_at timestamptz,
  revoked_at   timestamptz,
  created_at   timestamptz
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if not public.is_platform_admin() then
    raise log 'list_api_credentials denied: actor=% company=%', auth.uid(), p_company_id;
    raise exception 'permission denied: platform admin required' using errcode = '42501';
  end if;

  return query
    select c.id, c.name, c.token_prefix,
           coalesce(array_agg(s.permission_code order by s.permission_code)
                    filter (where s.permission_code is not null), '{}'::text[]),
           c.expires_at, c.last_used_at, c.revoked_at, c.created_at
      from public.api_credentials c
      left join public.api_credential_scopes s on s.credential_id = c.id
     where c.company_id = p_company_id
     group by c.id
     order by c.created_at desc;
end;
$$;

comment on function public.list_api_credentials(uuid) is
  'Block 15. Every key a Station has ever been issued, newest first, revoked ones included. The hash is not among the columns and must never be added.';

revoke execute on function public.list_api_credentials(uuid) from public;
grant  execute on function public.list_api_credentials(uuid) to authenticated;
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm run db:reset && npm run db:test`
Expected: `33_api_credentials` — 16 passing.

- [ ] **Step 5: Regenerate types and commit**

```bash
npm run db:types
git add supabase/migrations/0149_api_credential_rpcs.sql supabase/tests/33_api_credentials.test.sql src/lib/supabase/database.types.ts
git commit -m "feat(api): issue, authenticate and revoke a Station's machine keys"
```

---

## Task 3: External ids and the API channel

**Files:**
- Create: `supabase/migrations/0150_external_ids.sql`, `supabase/migrations/0151_music_request_channel_api.sql`
- Create: `supabase/tests/34_api_intake.test.sql`

**Interfaces:**
- Produces: `public.songs.external_id text`, `public.music_requests.external_id text`, unique indexes `songs_external_live` and `music_requests_external_live`, and the enum value `public.music_request_channel.'API'`.

- [ ] **Step 1: Write the failing test**

Create `supabase/tests/34_api_intake.test.sql`:

```sql
begin;
select plan(4);

select has_column('public', 'songs', 'external_id',
  'a song can carry the calling system''s own key');
select has_column('public', 'music_requests', 'external_id',
  'and so can a request, so a retry is not a second request');

-- D5: this is NOT legacy_id. Block 9's ETL owns that column, and two sources
-- sharing one unique index would collide on values that mean different things.
select is(
  (select count(*) from information_schema.columns
    where table_schema = 'public' and table_name = 'songs'
      and column_name in ('legacy_id', 'external_id')),
  2::bigint, 'external_id lives beside legacy_id, not instead of it');

select is(
  (select count(*) from pg_enum e
     join pg_type t on t.oid = e.enumtypid
    where t.typname = 'music_request_channel' and e.enumlabel = 'API'),
  1::bigint, 'a request can say it arrived over the API');

select * from finish();
rollback;
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run db:test`
Expected: FAIL — `column "external_id" does not exist`.

- [ ] **Step 3: Write `0150_external_ids.sql`**

```sql
-- supabase/migrations/0150_external_ids.sql

-- Block 15, design D5. The calling system's own primary key, on both things
-- this API creates.
--
-- ITS OWN COLUMN RATHER THAN legacy_id, AND THAT IS THE DECISION. legacy_id is
-- reserved for Block 9's ETL over the legacy system (0098, D7). Two sources
-- sharing one unique index would collide on values that mean different things,
-- and the collision would surface to an integrator as "this song already
-- exists" on a record that has nothing to do with theirs.
--
-- ON music_requests TOO, and for a reason the songs column does not have: an
-- automation retries. Without a key here a network retry is a SECOND request in
-- the history, and Block 8 counts requests. A listener genuinely asking twice
-- still produces two rows, because the caller sends two different ids.

alter table public.songs          add column external_id text;
alter table public.music_requests add column external_id text;

comment on column public.songs.external_id is
  'Block 15, D5. The primary key of the row in the system that sent it. Beside legacy_id, never instead of it: that one belongs to Block 9''s import.';
comment on column public.music_requests.external_id is
  'Block 15. The caller''s own id for this request, so a retry resolves to the row it already created rather than to a second one.';

-- Partial on both counts, the shape 0098 uses for legacy_id: unique WHEN
-- PRESENT, and only among live rows, so archiving and re-sending stays possible.
create unique index songs_external_live
  on public.songs (company_id, external_id)
  where deleted_at is null and external_id is not null;

create unique index music_requests_external_live
  on public.music_requests (company_id, external_id)
  where deleted_at is null and external_id is not null;
```

- [ ] **Step 4: Write `0151_music_request_channel_api.sql`**

This file contains one statement and its comment. Nothing else may be added to it.

```sql
-- supabase/migrations/0151_music_request_channel_api.sql

-- Block 15. One statement, alone in its own migration, for the Postgres reason
-- 0082 and 0091 each paid for once: ALTER TYPE ... ADD VALUE cannot share a
-- transaction with a statement that USES the new value. 0098 predicted this
-- migration in its own comment and reserved WHATSAPP for a different caller.
--
-- 'API' AND NOT 'WHATSAPP'. 0098 reserved WHATSAPP for this product's own bot.
-- What arrives at /api/v1/music-requests came over HTTP from a third party;
-- that the third party happens to attend listeners on WhatsApp is its story,
-- not ours. This column answers HOW IT REACHED US.

alter type public.music_request_channel add value 'API';
```

- [ ] **Step 5: Run to verify it passes**

Run: `npm run db:reset && npm run db:test`
Expected: `34_api_intake` — 4 passing.

- [ ] **Step 6: Regenerate types and commit**

```bash
npm run db:types
git add supabase/migrations/0150_external_ids.sql supabase/migrations/0151_music_request_channel_api.sql supabase/tests/34_api_intake.test.sql src/lib/supabase/database.types.ts
git commit -m "feat(api): songs and requests can carry the caller's own key"
```

---

## Task 4: The song intake core

**Files:**
- Create: `supabase/migrations/0152_api_intake_doors.sql` (first half — the tracked resolvers and `apply_song_intake`)
- Modify: `supabase/tests/34_api_intake.test.sql` (raise to `plan(14)`, append)

**Interfaces:**
- Produces:
  - `resolve_reference_tracked(p_company_id uuid, p_kind public.music_reference_kind, p_name text, out reference_id uuid, out was_created boolean)` — granted to nobody.
  - `resolve_album_tracked(p_company_id uuid, p_title text, p_deezer_album_id bigint, p_upc text, p_cover_md5 text, p_release_date date, out album_id uuid, out was_created boolean)` — granted to nobody.
  - `apply_song_intake(p_company_id uuid, p_org uuid, p_actor uuid, p_external_id text, p_title text, p_artist_name text, p_label_name text, p_genre_name text, p_album_title text, p_nationality public.music_nationality, p_vocal public.music_vocal, p_duration_seconds integer, p_isrc text, p_internal_code text, p_deezer_track_id bigint, p_deezer_album_id bigint, p_upc text, p_cover_md5 text, p_release_date date) returns jsonb` — granted to nobody.
  - The returned jsonb has exactly these keys: `song_id` (uuid), `created` (boolean), `filled` (array of column names), `references` (object keyed `artist`/`label`/`genre`/`album`, each `{id, created}` or null).

- [ ] **Step 1: Write the failing tests**

Append to `supabase/tests/34_api_intake.test.sql` before `finish()`, and change `plan(4)` to `plan(15)` — eleven assertions are added below.

```sql
-- Fixtures -------------------------------------------------------------------

insert into public.organizations (id, name) values
  ('00000000-0000-0000-0000-0000000000a2', 'Org intake');
insert into public.companies (id, organization_id, name, timezone) values
  ('00000000-0000-0000-0000-0000000000b2', '00000000-0000-0000-0000-0000000000a2',
   'Station intake', 'America/Sao_Paulo');

-- The core is granted to nobody: it writes without checking a permission,
-- because its only callers have already checked a scope.
select is(
  (select count(*) from information_schema.role_routine_grants
    where routine_schema = 'public' and routine_name = 'apply_song_intake'
      and grantee in ('anon', 'authenticated', 'service_role')),
  0::bigint, 'the intake core is reachable from no role at all');

-- A first registration, creating every reference it names.
select is(
  (public.apply_song_intake(
     '00000000-0000-0000-0000-0000000000b2', '00000000-0000-0000-0000-0000000000a2',
     null, 'EXT-1', 'Discovery Song', 'Daft Punk', 'Virgin', 'Electronic',
     'Discovery', null, null, 224, null, null, 3135556, 302127, null, null, null
   ) ->> 'created')::boolean,
  true, 'a song nobody had is created');

select is(
  (select count(*) from public.artists
    where company_id = '00000000-0000-0000-0000-0000000000b2' and name = 'Daft Punk'),
  1::bigint, 'and its artist was created with it');

-- The same external id again. D4 rung one.
select is(
  (public.apply_song_intake(
     '00000000-0000-0000-0000-0000000000b2', '00000000-0000-0000-0000-0000000000a2',
     null, 'EXT-1', 'Discovery Song', 'Daft Punk', null, null, null,
     null, null, null, null, null, null, null, null, null, null
   ) ->> 'created')::boolean,
  false, 'the same external id resolves to the song already there');

select is(
  (select count(*) from public.songs
    where company_id = '00000000-0000-0000-0000-0000000000b2'),
  1::bigint, 'and no second song was written');

-- D4 rung two: no external id, but the Deezer recording is known.
select is(
  (public.apply_song_intake(
     '00000000-0000-0000-0000-0000000000b2', '00000000-0000-0000-0000-0000000000a2',
     null, null, 'Discovery Song', 'Daft Punk', null, null, null,
     null, null, null, null, null, 3135556, null, null, null, null
   ) ->> 'created')::boolean,
  false, 'a known deezer track id resolves to the song already there');

-- D3: gaps are filled.
select is(
  (select isrc from public.songs
    where company_id = '00000000-0000-0000-0000-0000000000b2'),
  'GBDUW0000059',
  'an empty column is filled by a later call')
from (select public.apply_song_intake(
     '00000000-0000-0000-0000-0000000000b2', '00000000-0000-0000-0000-0000000000a2',
     null, 'EXT-1', 'Discovery Song', 'Daft Punk', null, null, null,
     null, null, null, 'gbduw0000059', null, null, null, null, null, null)) as _;

-- D3: and a column with a value is NOT touched, even when the payload disagrees.
select is(
  (select title from public.songs
    where company_id = '00000000-0000-0000-0000-0000000000b2'),
  'Discovery Song',
  'the title is never rewritten by a later call')
from (select public.apply_song_intake(
     '00000000-0000-0000-0000-0000000000b2', '00000000-0000-0000-0000-0000000000a2',
     null, 'EXT-1', 'A Different Title', 'Somebody Else', null, null, null,
     null, null, null, null, null, null, null, null, null, null)) as _;

select is(
  (select isrc from public.songs
    where company_id = '00000000-0000-0000-0000-0000000000b2'),
  'GBDUW0000059',
  'and neither is an ISRC that is already set');

-- D4: NOT deduplicated on title and artist. 0098's D2 allows the duplicate on
-- purpose -- a re-recording, a live version, a remix -- and 7b's merge is the
-- cure.
select is(
  (public.apply_song_intake(
     '00000000-0000-0000-0000-0000000000b2', '00000000-0000-0000-0000-0000000000a2',
     null, null, 'Discovery Song', 'Daft Punk', null, null, null,
     null, null, null, null, null, null, null, null, null, null
   ) ->> 'created')::boolean,
  true, 'the same title and artist with no code at all is a second song, by D2');

select throws_ok(
  $$select public.apply_song_intake(
      '00000000-0000-0000-0000-0000000000b2', '00000000-0000-0000-0000-0000000000a2',
      null, null, '   ', 'Daft Punk', null, null, null,
      null, null, null, null, null, null, null, null, null, null)$$,
  '22023', null, 'a blank title is refused');
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run db:test`
Expected: FAIL — `function public.apply_song_intake does not exist`.

- [ ] **Step 3: Write the first half of the migration**

Create `supabase/migrations/0152_api_intake_doors.sql` with this content (the two public doors are appended in Task 5 and Task 6):

```sql
-- supabase/migrations/0152_api_intake_doors.sql

-- Block 15, design D3, D4 and D8. What the two API endpoints actually call.
--
-- IT DOES NOT SHARE AN INSERT BODY WITH create_song_from_deezer (0139), AND
-- THAT IS DELIBERATE (D8). That door lets songs_deezer_live raise 23505 on
-- purpose, so the Deezer tab can say "another song is already linked to that
-- recording" -- a precise refusal an operator can act on. This one must be
-- IDEMPOTENT: an automation retries, and a retry must resolve to the row it
-- already created. Opposite semantics, so a shared body would have to branch on
-- its caller, which is two functions wearing one name.
--
-- What IS shared is what was already shared before this block:
-- resolve_or_create_reference (0139) and resolve_or_create_album (0137).
--
-- ATOMICITY IS THE POINT, the same one 0139's header makes. This resolves up to
-- four references and then writes a song. Done from four round trips in Node,
-- any failure after the first write leaves orphan rows in a Station's catalogue
-- with nothing to explain where they came from. A plpgsql body is one
-- transaction; a raised exception unwinds all of it.

-- ---------------------------------------------------------------------------
-- Two tracked resolvers.
--
-- They exist ONLY to answer "did this call have to create it?", which the HTTP
-- response reports so that support can answer "where did this artist come
-- from?" six months later without opening the audit trail. Each does a
-- read-only pre-check and then DELEGATES to the resolver that already exists --
-- it does not copy the insert, which would be the drift 0061's shared cores
-- were written to prevent.
--
-- EXECUTE GRANTED TO NOBODY, like the resolvers they wrap.
-- ---------------------------------------------------------------------------

create function public.resolve_reference_tracked(
  p_company_id uuid,
  p_kind       public.music_reference_kind,
  p_name       text,
  out reference_id uuid,
  out was_created  boolean
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_table text := public.music_reference_table(p_kind);
  v_name  text := nullif(btrim(coalesce(p_name, '')), '');
begin
  was_created := false;

  -- A blank name is not an absence of an artist here -- the caller checks that
  -- -- it is an absent LABEL or GENRE, both of which are optional on a song.
  if v_name is null then
    reference_id := null;
    return;
  end if;

  -- The same folded match resolve_or_create_reference makes, run first so the
  -- answer to "was it already there?" is knowable. format(%I) over a value THIS
  -- SCHEMA produced from an enum, never over a caller's string; every value is
  -- bound.
  execute format(
    'select id from public.%I
      where company_id = $1 and deleted_at is null and lower(name) = lower($2)
      order by created_at limit 1', v_table)
  into reference_id using p_company_id, v_name;

  if reference_id is not null then
    return;
  end if;

  was_created  := true;
  reference_id := public.resolve_or_create_reference(p_company_id, p_kind, v_name);
end;
$$;

comment on function public.resolve_reference_tracked(uuid, public.music_reference_kind, text) is
  'Block 15. resolve_or_create_reference, plus the one fact it does not report: whether this call had to create the row. EXECUTE granted to nobody.';

revoke execute on function
  public.resolve_reference_tracked(uuid, public.music_reference_kind, text) from public;

create function public.resolve_album_tracked(
  p_company_id      uuid,
  p_title           text,
  p_deezer_album_id bigint,
  p_upc             text,
  p_cover_md5       text,
  p_release_date    date,
  out album_id     uuid,
  out was_created  boolean
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_title text := nullif(btrim(coalesce(p_title, '')), '');
begin
  was_created := false;

  if v_title is null then
    album_id := null;
    return;
  end if;

  -- resolve_or_create_album tries the Deezer id first and the folded title
  -- second (0137). Both are asked here, in that order, so "was it already
  -- there?" matches what that function is about to decide.
  if p_deezer_album_id is not null then
    select id into album_id
      from public.albums
     where company_id = p_company_id
       and deezer_album_id = p_deezer_album_id
       and deleted_at is null;
  end if;

  if album_id is null then
    select id into album_id
      from public.albums
     where company_id = p_company_id
       and deleted_at is null
       and lower(title) = lower(v_title)
     order by created_at
     limit 1;
  end if;

  was_created := album_id is null;

  -- Called even when the album was found: resolve_or_create_album gap-fills a
  -- hand-typed album with the Deezer id, the UPC, the cover and the release
  -- date it lacked, and skipping the call would throw that away.
  album_id := public.resolve_or_create_album(
    p_company_id, v_title, p_deezer_album_id, p_upc, p_cover_md5, p_release_date);
end;
$$;

comment on function public.resolve_album_tracked(uuid, text, bigint, text, text, date) is
  'Block 15. resolve_or_create_album, plus whether this call had to create the album. Still calls it on a hit, because that function gap-fills what a hand-typed album lacked. EXECUTE granted to nobody.';

revoke execute on function
  public.resolve_album_tracked(uuid, text, bigint, text, text, date) from public;

-- ---------------------------------------------------------------------------
-- apply_song_intake. Design D3 and D4.
--
-- THE LADDER, and nothing else is on it:
--   1. external_id  -- the calling system's own key (D5)
--   2. deezer_track_id -- the recording (0138's songs_deezer_live)
--   3. neither matched -> insert
--
-- NOT ISRC. 0138's D8 refused a unique index there because the column is
-- hand-editable and one typo would become "a door nobody can open". Matching on
-- it has the same defect inverted: a wrong ISRC on an old record would silently
-- attach a new request to the wrong song.
--
-- NOT title + artist. 0098's D2 allows that duplicate deliberately -- a
-- re-recording, a live version and a remix are the same artist and title -- and
-- the cure is 7b's merge screen, not a wall here.
--
-- ON A HIT, GAPS ARE FILLED AND NOTHING ELSE IS TOUCHED (D3). This is the rule
-- link_song_to_deezer (0139) already applies, and its comment is the argument:
-- somebody who has curated a record for a year is not corrected by a catalogue.
-- title and artist_id are never among the filled columns -- they are the
-- record's identity, and they are NOT NULL, so there is no gap to fill.
--
-- NO PERMISSION CHECK HERE. Its callers have already checked a credential
-- scope, which is why EXECUTE is granted to nobody.
-- ---------------------------------------------------------------------------

create function public.apply_song_intake(
  p_company_id       uuid,
  p_org              uuid,
  p_actor            uuid,
  p_external_id      text,
  p_title            text,
  p_artist_name      text,
  p_label_name       text    default null,
  p_genre_name       text    default null,
  p_album_title      text    default null,
  p_nationality      public.music_nationality default null,
  p_vocal            public.music_vocal default null,
  p_duration_seconds integer default null,
  p_isrc             text    default null,
  p_internal_code    text    default null,
  p_deezer_track_id  bigint  default null,
  p_deezer_album_id  bigint  default null,
  p_upc              text    default null,
  p_cover_md5        text    default null,
  p_release_date     date    default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_title    text := nullif(btrim(coalesce(p_title, '')), '');
  v_artist   text := nullif(btrim(coalesce(p_artist_name, '')), '');
  v_external text := nullif(btrim(coalesce(p_external_id, '')), '');
  v_code     text := nullif(btrim(coalesce(p_internal_code, '')), '');
  -- Folded before it is stored AND before it is checked: songs_isrc_shape
  -- (0138) accepts upper case only, so a correct ISRC sent in lower case would
  -- otherwise be refused as malformed.
  v_isrc     text := nullif(btrim(upper(coalesce(p_isrc, ''))), '');
  -- 0098 checks duration_seconds > 0, and Deezer answers 0 for a handful of
  -- rows. A 0 would fail that check and take the whole registration with it,
  -- over a field nobody asked for. 0139 makes the same substitution.
  v_duration integer := nullif(coalesce(p_duration_seconds, 0), 0);
  v_existing public.songs%rowtype;
  v_artist_id uuid;  v_artist_new boolean := false;
  v_label_id  uuid;  v_label_new  boolean := false;
  v_genre_id  uuid;  v_genre_new  boolean := false;
  v_album_id  uuid;  v_album_new  boolean := false;
  v_filled   text[] := '{}';
  v_id       uuid;
  v_created  boolean;
begin
  if v_title is null then
    raise exception 'a title is required' using errcode = '22023';
  end if;

  if v_artist is null then
    raise exception 'a song must name an artist' using errcode = '22023';
  end if;

  if p_duration_seconds is not null and p_duration_seconds < 0 then
    raise exception 'a duration is a positive number of whole seconds' using errcode = '22023';
  end if;

  -- Rung 1. FOR UPDATE rather than a plain read: two retries of the same
  -- request arriving together would otherwise both miss and both insert, and
  -- songs_external_live would turn the loser into a 23505 the caller cannot act
  -- on. The lock makes the second wait and then take the gap-fill path.
  if v_external is not null then
    select * into v_existing from public.songs
     where company_id = p_company_id and external_id = v_external and deleted_at is null
     for update;
  end if;

  -- Rung 2.
  if v_existing.id is null and p_deezer_track_id is not null then
    select * into v_existing from public.songs
     where company_id = p_company_id and deezer_track_id = p_deezer_track_id
       and deleted_at is null
     for update;
  end if;

  if v_existing.id is not null then
    -- ------------------------------------------------------------------
    -- The hit. Only NULL columns are written, and each one that changes is
    -- named in `filled` so the caller can see what this call actually did.
    -- ------------------------------------------------------------------
    v_created := false;
    v_id      := v_existing.id;

    if v_existing.label_id is null and p_label_name is not null then
      select reference_id, was_created into v_label_id, v_label_new
        from public.resolve_reference_tracked(p_company_id, 'LABEL', p_label_name);
      if v_label_id is not null then v_filled := v_filled || 'label_id'; end if;
    else
      v_label_id := v_existing.label_id;
    end if;

    if v_existing.genre_id is null and p_genre_name is not null then
      select reference_id, was_created into v_genre_id, v_genre_new
        from public.resolve_reference_tracked(p_company_id, 'GENRE', p_genre_name);
      if v_genre_id is not null then v_filled := v_filled || 'genre_id'; end if;
    else
      v_genre_id := v_existing.genre_id;
    end if;

    if v_existing.album_id is null and p_album_title is not null then
      select album_id, was_created into v_album_id, v_album_new
        from public.resolve_album_tracked(p_company_id, p_album_title,
               p_deezer_album_id, p_upc, p_cover_md5, p_release_date);
      if v_album_id is not null then v_filled := v_filled || 'album_id'; end if;
    else
      v_album_id := v_existing.album_id;
    end if;

    if v_existing.isrc is null and v_isrc is not null then
      v_filled := v_filled || 'isrc';
    end if;
    if v_existing.duration_seconds is null and v_duration is not null then
      v_filled := v_filled || 'duration_seconds';
    end if;
    if v_existing.nationality is null and p_nationality is not null then
      v_filled := v_filled || 'nationality';
    end if;
    if v_existing.vocal is null and p_vocal is not null then
      v_filled := v_filled || 'vocal';
    end if;
    if v_existing.internal_code is null and v_code is not null then
      v_filled := v_filled || 'internal_code';
    end if;
    if v_existing.external_id is null and v_external is not null then
      v_filled := v_filled || 'external_id';
    end if;
    if v_existing.deezer_track_id is null and p_deezer_track_id is not null then
      v_filled := v_filled || 'deezer_track_id';
    end if;

    -- coalesce on every column, so this statement can only ever ADD. Written as
    -- one UPDATE rather than a conditional one because a no-op UPDATE of a row
    -- already locked FOR UPDATE costs nothing worth branching for.
    update public.songs s
       set label_id         = coalesce(s.label_id, v_label_id),
           genre_id         = coalesce(s.genre_id, v_genre_id),
           album_id         = coalesce(s.album_id, v_album_id),
           isrc             = coalesce(s.isrc, v_isrc),
           duration_seconds = coalesce(s.duration_seconds, v_duration),
           nationality      = coalesce(s.nationality, p_nationality),
           vocal            = coalesce(s.vocal, p_vocal),
           internal_code    = coalesce(s.internal_code, v_code),
           external_id      = coalesce(s.external_id, v_external),
           deezer_track_id  = coalesce(s.deezer_track_id, p_deezer_track_id),
           updated_at       = case when cardinality(v_filled) > 0 then now() else s.updated_at end
     where s.id = v_id;

    v_artist_id := v_existing.artist_id;
  else
    -- ------------------------------------------------------------------
    -- The miss.
    -- ------------------------------------------------------------------
    v_created := true;

    select reference_id, was_created into v_artist_id, v_artist_new
      from public.resolve_reference_tracked(p_company_id, 'ARTIST', v_artist);
    select reference_id, was_created into v_label_id, v_label_new
      from public.resolve_reference_tracked(p_company_id, 'LABEL', p_label_name);
    select reference_id, was_created into v_genre_id, v_genre_new
      from public.resolve_reference_tracked(p_company_id, 'GENRE', p_genre_name);
    select album_id, was_created into v_album_id, v_album_new
      from public.resolve_album_tracked(p_company_id, p_album_title,
             p_deezer_album_id, p_upc, p_cover_md5, p_release_date);

    -- 0103's reference locks. Not redundant with the resolve above: this closes
    -- the window in which a row this function just resolved is archived by a
    -- concurrent transaction before the insert lands.
    perform public.assert_song_references_live(p_company_id, v_artist_id, v_label_id, v_genre_id);

    insert into public.songs
      (organization_id, company_id, title, artist_id, label_id, genre_id,
       album_id, nationality, vocal, duration_seconds, internal_code,
       external_id, isrc, deezer_track_id, created_by)
    values
      (p_org, p_company_id, v_title, v_artist_id, v_label_id, v_genre_id,
       v_album_id, p_nationality, p_vocal, v_duration, v_code,
       v_external, v_isrc, p_deezer_track_id, p_actor)
    returning id into v_id;
  end if;

  insert into public.audit_logs
    (actor_id, action, target_table, target_id, organization_id, company_id, detail)
  values
    (p_actor, 'api_song_intake', 'songs', v_id, p_org, p_company_id,
     jsonb_build_object(
       'created', v_created, 'filled', to_jsonb(v_filled),
       'external_id', v_external, 'deezer_track_id', p_deezer_track_id,
       -- Which references this call had to CREATE is the fact an operator asks
       -- about later, and it is unrecoverable from the row afterwards.
       'artist_created', v_artist_new, 'label_created', v_label_new,
       'genre_created', v_genre_new, 'album_created', v_album_new));

  return jsonb_build_object(
    'song_id', v_id,
    'created', v_created,
    'filled', to_jsonb(v_filled),
    'references', jsonb_build_object(
      'artist', case when v_artist_id is null then null else
        jsonb_build_object('id', v_artist_id, 'created', v_artist_new) end,
      'label', case when v_label_id is null then null else
        jsonb_build_object('id', v_label_id, 'created', v_label_new) end,
      'genre', case when v_genre_id is null then null else
        jsonb_build_object('id', v_genre_id, 'created', v_genre_new) end,
      'album', case when v_album_id is null then null else
        jsonb_build_object('id', v_album_id, 'created', v_album_new) end));
end;
$$;

comment on function public.apply_song_intake is
  'Block 15, D3/D4. Idempotent song registration for a machine caller: external_id, then deezer_track_id, then insert. On a hit only NULL columns are written and each is named in the returned `filled`. Checks no permission -- its callers check a credential scope -- so EXECUTE is granted to nobody.';

revoke execute on function public.apply_song_intake(
  uuid, uuid, uuid, text, text, text, text, text, text,
  public.music_nationality, public.music_vocal, integer, text, text,
  bigint, bigint, text, text, date) from public;
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm run db:reset && npm run db:test`
Expected: `34_api_intake` — 15 passing.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/0152_api_intake_doors.sql supabase/tests/34_api_intake.test.sql
git commit -m "feat(api): register a song idempotently, with every dependency, in one transaction"
```

---

## Task 5: The song door

**Files:**
- Modify: `supabase/migrations/0152_api_intake_doors.sql` (append)
- Modify: `supabase/tests/34_api_intake.test.sql` (raise to `plan(17)`, append)

**Interfaces:**
- Consumes: `apply_song_intake` (Task 4), `authenticate_api_credential` (Task 2).
- Produces: `api_register_song(p_credential_id uuid, p_company_id uuid, p_org uuid, <the same 16 payload parameters as apply_song_intake, in the same order and with the same types>) returns jsonb` — granted to `service_role`.

- [ ] **Step 1: Write the failing tests**

Append to `34_api_intake.test.sql`, raising `plan(15)` to `plan(18)`:

```sql
select has_function('public', 'api_register_song', 'the song door exists');

select is(
  (select count(*) from information_schema.role_routine_grants
    where routine_schema = 'public' and routine_name = 'api_register_song'
      and grantee in ('anon', 'authenticated')),
  0::bigint, 'and no browser role may call it');

-- The scope is checked against the credential, not against auth.uid(): there is
-- no session here at all, and this is the call that proves the API does not
-- depend on one.
insert into public.api_credentials
  (id, organization_id, company_id, name, token_prefix, token_hash)
values
  ('00000000-0000-0000-0000-0000000000c2',
   '00000000-0000-0000-0000-0000000000a2',
   '00000000-0000-0000-0000-0000000000b2',
   'Intake key', 'ptx_eeeeffff', repeat('e', 64));

select throws_ok(
  $$select public.api_register_song(
      '00000000-0000-0000-0000-0000000000c2',
      '00000000-0000-0000-0000-0000000000b2',
      '00000000-0000-0000-0000-0000000000a2',
      'EXT-9', 'Scopeless', 'Nobody', null, null, null,
      null, null, null, null, null, null, null, null, null, null)$$,
  '42501', null, 'a credential without music.manage is refused');
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run db:test`
Expected: FAIL — `function public.api_register_song does not exist`.

- [ ] **Step 3: Append the door to `0152_api_intake_doors.sql`**

```sql
-- ---------------------------------------------------------------------------
-- api_register_song. The public half of endpoint 1.
--
-- THE GATE IS THE CREDENTIAL'S SCOPE, NOT has_permission (design D1).
-- has_permission is has_permission_for(auth.uid(), ...) since 0121, and there
-- is no auth.uid() on this path -- the route calls with the service key. Asking
-- it here would refuse every call, always, and the refusal would look like a
-- permission problem in the customer's roles.
--
-- p_credential_id AND p_company_id BOTH ARRIVE, and the credential's Station is
-- re-read from the row rather than trusted from the argument. The route already
-- got the Station from authenticate_api_credential, but a door that trusts a
-- caller-supplied company_id is one bug in the route away from writing into
-- another Station -- exactly what the isolation suite exists to catch.
-- ---------------------------------------------------------------------------

create function public.api_register_song(
  p_credential_id    uuid,
  p_company_id       uuid,
  p_org              uuid,
  p_external_id      text,
  p_title            text,
  p_artist_name      text,
  p_label_name       text    default null,
  p_genre_name       text    default null,
  p_album_title      text    default null,
  p_nationality      public.music_nationality default null,
  p_vocal            public.music_vocal default null,
  p_duration_seconds integer default null,
  p_isrc             text    default null,
  p_internal_code    text    default null,
  p_deezer_track_id  bigint  default null,
  p_deezer_album_id  bigint  default null,
  p_upc              text    default null,
  p_cover_md5        text    default null,
  p_release_date     date    default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_company uuid;
  v_org     uuid;
begin
  select c.company_id, c.organization_id into v_company, v_org
  from public.api_credentials c
  join public.api_credential_scopes s
    on s.credential_id = c.id and s.permission_code = 'music.manage'
  join public.companies co
    on co.id = c.company_id and co.deleted_at is null and co.status = 'active'
  where c.id = p_credential_id
    and c.revoked_at is null
    and (c.expires_at is null or c.expires_at > now());

  if not found then
    raise log 'api_register_song denied: credential=%', p_credential_id;
    raise exception 'permission denied: music.manage required' using errcode = '42501';
  end if;

  -- The argument is checked against the credential rather than used. A mismatch
  -- is a fault in the route, not in the caller, and it must be loud.
  if v_company <> p_company_id or v_org <> p_org then
    raise log 'api_register_song station mismatch: credential=% asked=%', p_credential_id, p_company_id;
    raise exception 'permission denied: music.manage required' using errcode = '42501';
  end if;

  return public.apply_song_intake(
    v_company, v_org, null,
    p_external_id, p_title, p_artist_name, p_label_name, p_genre_name,
    p_album_title, p_nationality, p_vocal, p_duration_seconds, p_isrc,
    p_internal_code, p_deezer_track_id, p_deezer_album_id, p_upc,
    p_cover_md5, p_release_date);
end;
$$;

comment on function public.api_register_song is
  'Block 15, endpoint 1. Gated on the credential''s music.manage scope, never on has_permission -- there is no auth.uid() on this path. The Station comes from the credential row; the p_company_id argument is checked against it and never used, so a fault in the route cannot write into another Station. The actor recorded in audit_logs is null (0004 allows it; 0129 states that null there does not mean "the system did it").';

revoke execute on function public.api_register_song(
  uuid, uuid, uuid, text, text, text, text, text, text,
  public.music_nationality, public.music_vocal, integer, text, text,
  bigint, bigint, text, text, date) from public;
grant execute on function public.api_register_song(
  uuid, uuid, uuid, text, text, text, text, text, text,
  public.music_nationality, public.music_vocal, integer, text, text,
  bigint, bigint, text, text, date) to service_role;
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm run db:reset && npm run db:test`
Expected: `34_api_intake` — 18 passing.

- [ ] **Step 5: Regenerate types and commit**

```bash
npm run db:types
git add supabase/migrations/0152_api_intake_doors.sql supabase/tests/34_api_intake.test.sql src/lib/supabase/database.types.ts
git commit -m "feat(api): the song registration door, gated on a credential scope"
```

---

## Task 6: The music request door

**Files:**
- Modify: `supabase/migrations/0152_api_intake_doors.sql` (append)
- Modify: `supabase/tests/34_api_intake.test.sql` (raise to `plan(23)`, append)

**Interfaces:**
- Consumes: `apply_song_intake`, `api_credentials`, and 0061's member cores.
- Produces: `api_record_music_request(p_credential_id uuid, p_company_id uuid, p_org uuid, p_request_external_id text, p_phone text, p_listener_name text, p_show_name text, p_requested_at timestamptz, <the same 16 song payload parameters>) returns jsonb`, returning `{request_id, created, song, listener}` — granted to `service_role`.

**Before writing this task, read** `supabase/migrations/0061_member_resolution_cores.sql` in full and confirm the exact signatures of `apply_member_candidates`, `apply_member_lookup`, `apply_member_creation` and `apply_member_link`. The body below calls `public.normalize_phone`, `public.members` and `public.member_company_links` directly where a core does not fit; **if a core exists that does the same work, call it instead** — 0061's whole argument is that the WhatsApp door and the screen door must not drift, and a third caller reimplementing the lookup would be exactly that drift.

- [ ] **Step 1: Write the failing tests**

Append to `34_api_intake.test.sql`, raising `plan(18)` to `plan(24)`:

```sql
insert into public.api_credential_scopes (credential_id, permission_code) values
  ('00000000-0000-0000-0000-0000000000c2', 'music.manage'),
  ('00000000-0000-0000-0000-0000000000c2', 'music.request'),
  ('00000000-0000-0000-0000-0000000000c2', 'members.create');

-- A listener nobody has ever seen, arriving with a name: created, linked, and
-- the request recorded, all in one call.
select is(
  (public.api_record_music_request(
     '00000000-0000-0000-0000-0000000000c2',
     '00000000-0000-0000-0000-0000000000b2',
     '00000000-0000-0000-0000-0000000000a2',
     'REQ-1', '+5511999990001', 'Maria Silva', null, null,
     null, 'Around the World', 'Daft Punk', null, null, null,
     null, null, null, null, null, 1234567, null, null, null, null
   ) -> 'listener' ->> 'created')::boolean,
  true, 'a listener the Station has never seen is registered');

select is(
  (select count(*) from public.music_requests
    where company_id = '00000000-0000-0000-0000-0000000000b2'),
  1::bigint, 'and the request is recorded');

select is(
  (select channel::text from public.music_requests
    where company_id = '00000000-0000-0000-0000-0000000000b2'),
  'API', 'saying it arrived over the API');

-- D6: a NEW listener without a name is refused. The external application's
-- bug, refused here rather than turned into a nameless row.
select throws_ok(
  $$select public.api_record_music_request(
      '00000000-0000-0000-0000-0000000000c2',
      '00000000-0000-0000-0000-0000000000b2',
      '00000000-0000-0000-0000-0000000000a2',
      'REQ-2', '+5511999990002', null, null, null,
      null, 'One More Time', 'Daft Punk', null, null, null,
      null, null, null, null, null, 2345678, null, null, null, null)$$,
  '22023', null, 'a new listener with no name is refused');

-- The retry. Same request external id, and no second row.
select is(
  (public.api_record_music_request(
     '00000000-0000-0000-0000-0000000000c2',
     '00000000-0000-0000-0000-0000000000b2',
     '00000000-0000-0000-0000-0000000000a2',
     'REQ-1', '+5511999990001', 'Maria Silva', null, null,
     null, 'Around the World', 'Daft Punk', null, null, null,
     null, null, null, null, null, 1234567, null, null, null, null
   ) ->> 'created')::boolean,
  false, 'the same request external id is not a second request');

-- An unknown programme is refused rather than silently dropped: `shows` is the
-- one catalogue entity with no merge door (0098), so this API must never create
-- one from a typed name.
select throws_ok(
  $$select public.api_record_music_request(
      '00000000-0000-0000-0000-0000000000c2',
      '00000000-0000-0000-0000-0000000000b2',
      '00000000-0000-0000-0000-0000000000a2',
      'REQ-3', '+5511999990001', 'Maria Silva', 'No Such Programme', null,
      null, 'Aerodynamic', 'Daft Punk', null, null, null,
      null, null, null, null, null, 3456789, null, null, null, null)$$,
  'P0002', null, 'an unknown programme is refused, never created');
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run db:test`
Expected: FAIL — `function public.api_record_music_request does not exist`.

- [ ] **Step 3: Append the door**

```sql
-- ---------------------------------------------------------------------------
-- api_record_music_request. The public half of endpoint 2.
--
-- LEAST PRIVILEGE ACROSS THREE SCOPES: music.request is required always;
-- music.manage only if the song has to be created; members.create only if the
-- listener has to be. So a key can be issued that records requests for known
-- listeners and touches neither the catalogue nor the audience.
--
-- The listener resolution goes through 0061's cores, which the WhatsApp door
-- already uses. A third implementation of "find this person by phone" is
-- exactly the drift those cores were extracted to prevent.
-- ---------------------------------------------------------------------------

create function public.api_record_music_request(
  p_credential_id       uuid,
  p_company_id          uuid,
  p_org                 uuid,
  p_request_external_id text,
  p_phone               text,
  p_listener_name       text,
  p_show_name           text        default null,
  p_requested_at        timestamptz default null,
  p_song_external_id    text    default null,
  p_title               text    default null,
  p_artist_name         text    default null,
  p_label_name          text    default null,
  p_genre_name          text    default null,
  p_album_title         text    default null,
  p_nationality         public.music_nationality default null,
  p_vocal               public.music_vocal default null,
  p_duration_seconds    integer default null,
  p_isrc                text    default null,
  p_internal_code       text    default null,
  p_deezer_track_id     bigint  default null,
  p_deezer_album_id     bigint  default null,
  p_upc                 text    default null,
  p_cover_md5           text    default null,
  p_release_date        date    default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_company   uuid;
  v_org       uuid;
  v_scopes    text[];
  v_external  text := nullif(btrim(coalesce(p_request_external_id, '')), '');
  v_phone     text := public.normalize_phone(p_phone);
  v_name      text := nullif(btrim(coalesce(p_listener_name, '')), '');
  v_show_name text := nullif(btrim(coalesce(p_show_name, '')), '');
  v_member    uuid;
  v_member_new boolean := false;
  v_linked    boolean := false;
  v_anonymised boolean;
  v_show      uuid;
  v_song      jsonb;
  v_request   uuid;
begin
  select c.company_id, c.organization_id,
         coalesce(array_agg(s.permission_code) filter (where s.permission_code is not null), '{}')
    into v_company, v_org, v_scopes
  from public.api_credentials c
  left join public.api_credential_scopes s on s.credential_id = c.id
  join public.companies co
    on co.id = c.company_id and co.deleted_at is null and co.status = 'active'
  where c.id = p_credential_id
    and c.revoked_at is null
    and (c.expires_at is null or c.expires_at > now())
  group by c.company_id, c.organization_id;

  if not found or not ('music.request' = any(v_scopes)) then
    raise log 'api_record_music_request denied: credential=%', p_credential_id;
    raise exception 'permission denied: music.request required' using errcode = '42501';
  end if;

  if v_company <> p_company_id or v_org <> p_org then
    raise log 'api_record_music_request station mismatch: credential=% asked=%',
      p_credential_id, p_company_id;
    raise exception 'permission denied: music.request required' using errcode = '42501';
  end if;

  if v_phone is null then
    raise exception 'a listener must be identified by a phone number' using errcode = '22023';
  end if;

  -- Idempotency first, before anything is created. A retry must not register a
  -- listener or a song on its way to discovering it already recorded the
  -- request.
  if v_external is not null then
    select id into v_request from public.music_requests
     where company_id = v_company and external_id = v_external and deleted_at is null;

    if found then
      return jsonb_build_object(
        'request_id', v_request, 'created', false,
        'song', (select jsonb_build_object('id', song_id, 'created', false,
                                           'filled', '[]'::jsonb)
                   from public.music_requests where id = v_request),
        'listener', (select jsonb_build_object('id', member_id, 'created', false,
                                               'linked', true)
                       from public.music_requests where id = v_request));
    end if;
  end if;

  -- The listener. Organization-scoped (0031): the same person entering at two
  -- of the group's Stations is one row.
  select m.id, m.anonymized_at is not null into v_member, v_anonymised
    from public.members m
   where m.organization_id = v_org
     and m.phone_normalized = v_phone
     and m.deleted_at is null
   order by m.created_at
   limit 1;

  if v_member is not null and v_anonymised then
    -- 0034's erasure. Recording fresh activity against somebody who exercised
    -- it is precisely what the erasure was for; create_music_request excludes
    -- them for the same reason.
    raise exception 'that listener has been anonymised' using errcode = '23514';
  end if;

  if v_member is null then
    -- Design D6. The external application attends on WhatsApp and therefore
    -- holds the profile name; arriving without one is its bug, and this refuses
    -- rather than registering a nameless listener.
    if v_name is null then
      raise exception 'a new listener must arrive with a name' using errcode = '22023';
    end if;
    if not ('members.create' = any(v_scopes)) then
      raise exception 'permission denied: members.create required' using errcode = '42501';
    end if;

    v_member     := public.apply_member_creation(v_company, v_org, v_name, v_phone, null);
    v_member_new := true;
    v_linked     := true;
  else
    -- Already known to the Organization; make sure THIS Station may see them.
    if not exists (select 1 from public.member_company_links
                    where member_id = v_member and company_id = v_company) then
      if not ('members.create' = any(v_scopes)) then
        raise exception 'permission denied: members.create required' using errcode = '42501';
      end if;
      perform public.apply_member_link(v_member, v_company);
      v_linked := true;
    end if;
  end if;

  -- The programme. RESOLVED, NEVER CREATED. `shows` is the one catalogue entity
  -- with no merge door (0098's own table comment), so an API creating one from
  -- a typed name would breed duplicates with no cure.
  if v_show_name is not null then
    select id into v_show from public.shows
     where company_id = v_company and deleted_at is null
       and lower(name) = lower(v_show_name)
     order by created_at limit 1;

    if not found then
      raise exception 'programme not found in this station: %', v_show_name using errcode = 'P0002';
    end if;
  end if;

  -- The song, by endpoint 1's rules exactly.
  v_song := public.apply_song_intake(
    v_company, v_org, null,
    p_song_external_id, p_title, p_artist_name, p_label_name, p_genre_name,
    p_album_title, p_nationality, p_vocal, p_duration_seconds, p_isrc,
    p_internal_code, p_deezer_track_id, p_deezer_album_id, p_upc,
    p_cover_md5, p_release_date);

  if (v_song ->> 'created')::boolean and not ('music.manage' = any(v_scopes)) then
    raise exception 'permission denied: music.manage required' using errcode = '42501';
  end if;

  insert into public.music_requests
    (organization_id, company_id, member_id, song_id, show_id, channel,
     requested_at, external_id, created_by)
  values
    (v_org, v_company, v_member, (v_song ->> 'song_id')::uuid, v_show, 'API',
     coalesce(p_requested_at, now()), v_external, null)
  returning id into v_request;

  insert into public.audit_logs
    (actor_id, action, target_table, target_id, organization_id, company_id, detail)
  values
    (null, 'api_record_music_request', 'music_requests', v_request, v_org, v_company,
     jsonb_build_object('credential_id', p_credential_id,
                        'member_created', v_member_new,
                        'song', v_song, 'show_id', v_show));

  return jsonb_build_object(
    'request_id', v_request,
    'created', true,
    'song', v_song,
    'listener', jsonb_build_object('id', v_member, 'created', v_member_new, 'linked', v_linked));
end;
$$;

comment on function public.api_record_music_request is
  'Block 15, endpoint 2. Records what a listener asked for, registering the song by endpoint 1''s rules if it is not there. Three scopes, least privilege: music.request always, members.create only to register or link a listener, music.manage only when a song has to be created. A new listener without a name is refused (D6); an anonymised one is refused and never recreated; an unknown programme is refused and never created.';

revoke execute on function public.api_record_music_request(
  uuid, uuid, uuid, text, text, text, text, timestamptz, text, text, text, text, text, text,
  public.music_nationality, public.music_vocal, integer, text, text,
  bigint, bigint, text, text, date) from public;
grant execute on function public.api_record_music_request(
  uuid, uuid, uuid, text, text, text, text, timestamptz, text, text, text, text, text, text,
  public.music_nationality, public.music_vocal, integer, text, text,
  bigint, bigint, text, text, date) to service_role;
```

- [ ] **Step 4: Reconcile against 0061 and 0031**

The body above calls `public.apply_member_creation(v_company, v_org, v_name, v_phone, null)`, `public.apply_member_link(v_member, v_company)`, and reads `members.phone_normalized`. **These names are provisional.** Open `supabase/migrations/0061_member_resolution_cores.sql` and `supabase/migrations/0031_members.sql`, read the real signatures and the real generated-column name, and correct the calls. Do not invent a parallel lookup: if `apply_member_candidates` or `apply_member_lookup` already answers "find this phone in this Organization", call it.

- [ ] **Step 5: Run to verify it passes**

Run: `npm run db:reset && npm run db:test`
Expected: `34_api_intake` — 24 passing.

- [ ] **Step 6: Regenerate types and commit**

```bash
npm run db:types
git add supabase/migrations/0152_api_intake_doors.sql supabase/tests/34_api_intake.test.sql src/lib/supabase/database.types.ts
git commit -m "feat(api): record a listener's music request, registering the song if needed"
```

---

## Task 7: HTTP credentials, errors and the response envelope

**Files:**
- Create: `src/lib/api/credentials.ts`, `src/lib/api/errors.ts`, `src/lib/api/respond.ts`
- Test: `tests/unit/api-credentials.test.ts`, `tests/unit/api-errors.test.ts`

**Interfaces:**
- Produces:
  - `parseBearer(header: string | null): string | null`
  - `hashToken(token: string): string` — lowercase hex SHA-256
  - `authenticate(client: SupabaseClient<Database>, header: string | null, scope: string): Promise<AuthOutcome>` where `type AuthOutcome = { ok: true; credentialId: string; companyId: string; organizationId: string } | { ok: false; code: 'unauthorized' | 'forbidden_scope' }`
  - `type ApiErrorCode` and `apiError(code: ApiErrorCode, message: string, details?: ApiErrorDetail[]): Response`
  - `mapPostgresError(code: string | undefined, message: string): { status: number; code: ApiErrorCode; message: string }`
  - `jsonOk(body: unknown, status: number, requestId: string): Response`
  - `guardRequest(request: Request, id: string): Response | null` — the content-type and body-size checks; a `Response` is the refusal, `null` means carry on
  - `requestId(request: Request): string`

- [ ] **Step 1: Write the failing tests**

Create `tests/unit/api-credentials.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { hashToken, parseBearer } from '@/lib/api/credentials';

describe('parseBearer', () => {
  it('reads the token out of a well-formed header', () => {
    expect(parseBearer('Bearer ptx_abc123')).toBe('ptx_abc123');
  });

  it('accepts the scheme in any case, because HTTP says it is case-insensitive', () => {
    expect(parseBearer('bearer ptx_abc123')).toBe('ptx_abc123');
  });

  it('refuses a missing header', () => {
    expect(parseBearer(null)).toBeNull();
  });

  it('refuses another scheme rather than treating its value as a token', () => {
    expect(parseBearer('Basic ptx_abc123')).toBeNull();
  });

  it('refuses an empty token', () => {
    expect(parseBearer('Bearer   ')).toBeNull();
  });
});

describe('hashToken', () => {
  it('is lowercase hex sha-256, which is the shape the column CHECK accepts', () => {
    const token = 'ptx_whatever';
    expect(hashToken(token)).toBe(createHash('sha256').update(token).digest('hex'));
    expect(hashToken(token)).toMatch(/^[0-9a-f]{64}$/);
  });
});
```

Create `tests/unit/api-errors.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { mapPostgresError } from '@/lib/api/errors';

describe('mapPostgresError', () => {
  it('turns a permission refusal into 403 with a stable code', () => {
    const mapped = mapPostgresError('42501', 'permission denied: music.manage required');
    expect(mapped.status).toBe(403);
    expect(mapped.code).toBe('forbidden_scope');
  });

  it('turns a missing row into 422 rather than 404, because the caller sent it', () => {
    const mapped = mapPostgresError('P0002', 'programme not found in this station: Tarde');
    expect(mapped.status).toBe(422);
    expect(mapped.code).toBe('show_not_found');
  });

  it('recognises the anonymised listener as a conflict', () => {
    const mapped = mapPostgresError('23514', 'that listener has been anonymised');
    expect(mapped.status).toBe(409);
    expect(mapped.code).toBe('listener_anonymized');
  });

  it('recognises the nameless listener', () => {
    const mapped = mapPostgresError('22023', 'a new listener must arrive with a name');
    expect(mapped.status).toBe(422);
    expect(mapped.code).toBe('listener_name_required');
  });

  it('NEVER passes raw database text through on an unknown code', () => {
    const mapped = mapPostgresError('XX000', 'stack smashing detected in pg_catalog.foo');
    expect(mapped.status).toBe(500);
    expect(mapped.code).toBe('internal');
    expect(mapped.message).not.toContain('pg_catalog');
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npm test -- tests/unit/api-credentials.test.ts tests/unit/api-errors.test.ts`
Expected: FAIL — cannot resolve `@/lib/api/credentials`.

- [ ] **Step 3: Write `src/lib/api/credentials.ts`**

```ts
import 'server-only';
import { createHash } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/supabase/database.types';

/**
 * Pulls the token out of `Authorization: Bearer <token>`.
 *
 * The scheme is matched case-insensitively because RFC 7235 says it is
 * case-insensitive, and an integrator sending `bearer` is not wrong.
 */
export function parseBearer(header: string | null): string | null {
  if (!header) return null;
  const match = /^bearer\s+(.+)$/i.exec(header.trim());
  const token = match?.[1]?.trim();
  return token ? token : null;
}

/**
 * SHA-256, lowercase hex.
 *
 * THE RAW TOKEN NEVER REACHES THE DATABASE, not even as an RPC argument. This
 * is the rule the WhatsApp webhook already follows for the wamid, and its
 * comment gives the reason: an argument passed to an RPC lands in query logs
 * and in backups. `api_credentials_hash_shape` (0148) refuses anything that is
 * not this shape, which is a backstop rather than a reason to relax here.
 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export type AuthOutcome =
  | { ok: true; credentialId: string; companyId: string; organizationId: string }
  | { ok: false; code: 'unauthorized' | 'forbidden_scope' };

/**
 * The whole of this API's authentication.
 *
 * NO CONSTANT-TIME COMPARISON HERE, and that is correct rather than an
 * oversight. There is no secret-to-secret comparison on this path: what arrives
 * is hashed before anything happens, and what is stored is a hash, so the lookup
 * is an indexed equality over the SHA-256 of a high-entropy secret. The
 * `timingSafeEqual` in /api/worker/tick exists because THAT secret lives in the
 * environment and is compared directly. Please do not "fix" this into a scan.
 *
 * The two failure codes are distinguished on purpose (0149's own comment): zero
 * rows means unknown, revoked, expired or a Station that is gone or suspended —
 * one answer for four cases, so probing learns nothing. A row with
 * `scope_ok = false` means the caller already proved it holds a valid key, so
 * naming the missing scope gives away nothing it did not know and is the only
 * way an integrator can debug.
 */
export async function authenticate(
  client: SupabaseClient<Database>,
  header: string | null,
  scope: string,
): Promise<AuthOutcome> {
  const token = parseBearer(header);
  if (!token) return { ok: false, code: 'unauthorized' };

  const { data, error } = await client.rpc('authenticate_api_credential', {
    p_token_hash: hashToken(token),
    p_scope: scope,
  });

  // A failed call is NOT folded into "not authorised". Collapsing a transient
  // database failure into a 401 would tell a correct integrator their key is
  // wrong — the same choice searchDeezerAction makes for its permission check.
  if (error) throw error;

  const row = Array.isArray(data) ? data[0] : data;
  if (!row) return { ok: false, code: 'unauthorized' };
  if (!row.scope_ok) return { ok: false, code: 'forbidden_scope' };

  return {
    ok: true,
    credentialId: row.credential_id,
    companyId: row.company_id,
    organizationId: row.organization_id,
  };
}
```

- [ ] **Step 4: Write `src/lib/api/errors.ts`**

```ts
/**
 * The stable vocabulary this API answers with.
 *
 * The CODE is the machine contract and never changes meaning; the message is
 * for a human reading a log. English in both, deliberately: the screens are
 * trilingual because people read them, and an automation reads the code.
 */
export type ApiErrorCode =
  | 'malformed_json'
  | 'unauthorized'
  | 'forbidden_scope'
  | 'listener_anonymized'
  | 'payload_too_large'
  | 'unsupported_media_type'
  | 'invalid_payload'
  | 'listener_name_required'
  | 'show_not_found'
  | 'rate_limited'
  | 'internal';

export interface ApiErrorDetail {
  path: string;
  message: string;
}

/**
 * Postgres SQLSTATE to an HTTP answer.
 *
 * THE DEFAULT BRANCH IS THE POINT. `describeMusicReadError` already writes the
 * rule down for the screens: an internal error means the fault is ours, not
 * theirs, and its message may carry a raw database error — not something to
 * show. The same applies here, and more sharply, because this body goes to
 * somebody else's log file.
 *
 * The specific branches are matched on SQLSTATE **and** on text the doors in
 * 0152 raise deliberately. Matching on text alone would be fragile; matching on
 * SQLSTATE alone cannot tell 22023's three cases apart.
 */
export function mapPostgresError(
  code: string | undefined,
  message: string,
): { status: number; code: ApiErrorCode; message: string } {
  if (code === '42501') {
    return {
      status: 403,
      code: 'forbidden_scope',
      // The raw text names the scope ("permission denied: music.manage
      // required"), which is exactly what an integrator needs and gives away
      // nothing: they already hold a valid key.
      message,
    };
  }

  if (code === '23514' && message.includes('anonymised')) {
    return {
      status: 409,
      code: 'listener_anonymized',
      message: 'That listener has exercised erasure and cannot be recorded against.',
    };
  }

  if (code === 'P0002' && message.includes('programme not found')) {
    return {
      status: 422,
      code: 'show_not_found',
      message: 'No programme with that name exists in this station.',
    };
  }

  if (code === '22023') {
    if (message.includes('must arrive with a name')) {
      return {
        status: 422,
        code: 'listener_name_required',
        message: 'A listener not yet registered must arrive with a name.',
      };
    }
    return { status: 422, code: 'invalid_payload', message };
  }

  return {
    status: 500,
    code: 'internal',
    message: 'The request could not be completed.',
  };
}
```

- [ ] **Step 5: Write `src/lib/api/respond.ts`**

```ts
import { randomUUID } from 'node:crypto';
import type { ApiErrorCode, ApiErrorDetail } from './errors';

/**
 * Headroom, not a proof of anything — the same qualification the WhatsApp
 * webhook puts on its own ceiling. A caller that omits Content-Length, or lies
 * about it, is caught by nothing here; this stops an unauthenticated caller
 * from making the route read a huge body before there is any chance to reject
 * it.
 */
export const MAX_BODY_BYTES = 256_000;

const REQUEST_ID_HEADER = 'x-request-id';

/**
 * Echoed if the caller sent one, minted if not.
 *
 * Without this, "it failed yesterday around 2pm" is not investigable: the log
 * line and the caller's log line have nothing in common.
 */
export function requestId(request: Request): string {
  const supplied = request.headers.get(REQUEST_ID_HEADER)?.trim();
  // Bounded, because it is echoed into a response header and written to a log.
  if (supplied && supplied.length <= 200) return supplied;
  return randomUUID();
}

export function jsonOk(body: unknown, status: number, id: string): Response {
  return Response.json(body, { status, headers: { [REQUEST_ID_HEADER]: id } });
}

export function apiError(
  code: ApiErrorCode,
  message: string,
  status: number,
  id: string,
  details?: ApiErrorDetail[],
  extraHeaders?: Record<string, string>,
): Response {
  return Response.json(
    { error: { code, message, ...(details?.length ? { details } : {}) } },
    { status, headers: { [REQUEST_ID_HEADER]: id, ...extraHeaders } },
  );
}

/**
 * The two checks that must happen before the body is read.
 */
export function guardRequest(request: Request, id: string): Response | null {
  const contentType = request.headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().includes('application/json')) {
    return apiError(
      'unsupported_media_type',
      'This endpoint accepts application/json.',
      415,
      id,
    );
  }

  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    return apiError('payload_too_large', 'That body is too large.', 413, id);
  }

  return null;
}
```

- [ ] **Step 6: Run to verify the tests pass**

Run: `npm test -- tests/unit/api-credentials.test.ts tests/unit/api-errors.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/lib/api tests/unit/api-credentials.test.ts tests/unit/api-errors.test.ts
git commit -m "feat(api): bearer credentials, a stable error vocabulary and one response envelope"
```

---

## Task 8: The request schemas

**Files:**
- Create: `src/schemas/api.ts`
- Test: `tests/unit/api-schemas.test.ts`

**Interfaces:**
- Produces:
  - `songIntakeSchema` — Zod object, strict, describing §5's body
  - `musicRequestSchema` — Zod object, strict, describing §6's body
  - `type SongIntake = z.infer<typeof songIntakeSchema>`
  - `type MusicRequestIntake = z.infer<typeof musicRequestSchema>`
  - `normaliseSong(input: SongIntake): NormalisedSong` — folds `deezer` into the flat fields, flat wins
  - `interface NormalisedSong { externalId, title, artistName, labelName, genreName, albumTitle, nationality, vocal, durationSeconds, isrc, internalCode, deezerTrackId, deezerAlbumId, upc, coverMd5, releaseDate }` — every field `string | number | null` as appropriate

- [ ] **Step 1: Write the failing tests**

Create `tests/unit/api-schemas.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { musicRequestSchema, normaliseSong, songIntakeSchema } from '@/schemas/api';

describe('songIntakeSchema', () => {
  it('accepts a minimal body', () => {
    const parsed = songIntakeSchema.safeParse({ title: 'A Song', artist: 'An Artist' });
    expect(parsed.success).toBe(true);
  });

  it('refuses a body with no artist', () => {
    expect(songIntakeSchema.safeParse({ title: 'A Song' }).success).toBe(false);
  });

  it('refuses an unknown field rather than ignoring it', () => {
    // For an automation a mistyped field name must fail on the first test run,
    // not disappear for six months.
    const parsed = songIntakeSchema.safeParse({
      title: 'A Song',
      artist: 'An Artist',
      titel: 'typo',
    });
    expect(parsed.success).toBe(false);
  });

  it('refuses a malformed ISRC', () => {
    const parsed = songIntakeSchema.safeParse({
      title: 'A Song',
      artist: 'An Artist',
      isrc: 'nope',
    });
    expect(parsed.success).toBe(false);
  });

  it('accepts a lowercase ISRC, which is folded later', () => {
    const parsed = songIntakeSchema.safeParse({
      title: 'A Song',
      artist: 'An Artist',
      isrc: 'gbduw0000059',
    });
    expect(parsed.success).toBe(true);
  });
});

describe('the deezer object', () => {
  it('tolerates fields nobody here knows about', () => {
    // Deliberate exception to strictness: it is a third party's object and
    // Deezer may add to it. The integration must not break the day it does.
    const parsed = musicRequestSchema.safeParse({
      listener: { phone: '+5511999990001', name: 'Maria' },
      song: {
        deezer: {
          id: 3135556,
          title: 'Harder, Better, Faster, Stronger',
          duration: 224,
          artist: { name: 'Daft Punk' },
          album: { id: 302127, title: 'Discovery', md5_image: 'a'.repeat(32) },
          rank: 952814,
          preview: 'https://example.test/x.mp3',
          explicit_lyrics: false,
          something_deezer_added_last_tuesday: true,
        },
      },
    });
    expect(parsed.success).toBe(true);
  });
});

describe('normaliseSong', () => {
  it('reads the flat fields when no deezer object is present', () => {
    const flat = normaliseSong({ title: 'A Song', artist: 'An Artist' });
    expect(flat.title).toBe('A Song');
    expect(flat.artistName).toBe('An Artist');
    expect(flat.deezerTrackId).toBeNull();
  });

  it('unpacks the deezer object into the flat shape', () => {
    const from = normaliseSong({
      deezer: {
        id: 3135556,
        title: 'Harder, Better, Faster, Stronger',
        duration: 224,
        artist: { name: 'Daft Punk' },
        album: { id: 302127, title: 'Discovery', md5_image: 'b'.repeat(32) },
      },
    });
    expect(from.title).toBe('Harder, Better, Faster, Stronger');
    expect(from.artistName).toBe('Daft Punk');
    expect(from.deezerTrackId).toBe(3135556);
    expect(from.deezerAlbumId).toBe(302127);
    expect(from.albumTitle).toBe('Discovery');
    expect(from.durationSeconds).toBe(224);
    expect(from.coverMd5).toBe('b'.repeat(32));
  });

  it('lets an explicit flat field win over the deezer object', () => {
    // Whoever was explicit meant it.
    const merged = normaliseSong({
      title: 'The Title The Operator Wants',
      deezer: {
        id: 3135556,
        title: 'Harder, Better, Faster, Stronger',
        artist: { name: 'Daft Punk' },
      },
    });
    expect(merged.title).toBe('The Title The Operator Wants');
    expect(merged.artistName).toBe('Daft Punk');
  });

  it('drops a cover hash that is not an md5, rather than carrying it forward', () => {
    // albums.cover_md5 has a CHECK (0136) and coverUrl refuses anything else.
    // A bad hash refused here is a clearer failure than one refused at insert.
    const parsed = songIntakeSchema.safeParse({
      title: 'A Song',
      artist: 'An Artist',
      album: { title: 'An Album', cover_md5: 'not-a-hash' },
    });
    expect(parsed.success).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npm test -- tests/unit/api-schemas.test.ts`
Expected: FAIL — cannot resolve `@/schemas/api`.

- [ ] **Step 3: Write `src/schemas/api.ts`**

```ts
import { z } from 'zod';

/**
 * The two request bodies, and the one place Deezer's own shape is understood.
 *
 * STRICT EVERYWHERE EXCEPT INSIDE `song.deezer`. For an automation a mistyped
 * field name must fail on the first test run rather than disappear for six
 * months, so an unknown key at our own boundary is a 422. The Deezer object is
 * the exception on purpose: it is a third party's payload, Deezer may add to it
 * at any time, and the integration must not break the day it does.
 */

// songs_isrc_shape (0138): two letters of country, three of registrant, two of
// year, five of designation. Accepted in either case here and folded to upper
// by the database, because an operator reading it off a sleeve will not
// shift-lock and neither will every calling system.
const ISRC = /^[A-Za-z]{2}[A-Za-z0-9]{3}[0-9]{7}$/;

// albums.cover_md5 (0136) and coverUrl (lib/integrations/deezer/cover.ts) both
// insist on a plain MD5. Refused here so the failure names the field.
const MD5 = /^[0-9a-f]{32}$/;

const albumSchema = z
  .object({
    title: z.string().trim().min(1).max(300).optional(),
    release_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    upc: z.string().trim().max(50).optional(),
    cover_md5: z.string().regex(MD5, 'a cover hash is a plain md5').optional(),
    deezer_album_id: z.number().int().positive().optional(),
  })
  .strict();

/**
 * Deezer's own track object, as `/search` returns it. Everything is optional
 * except the parts this product actually reads, and `.passthrough()` is the
 * deliberate exception to strictness described above.
 */
const deezerTrackSchema = z
  .object({
    id: z.number().int().positive().optional(),
    title: z.string().trim().min(1).max(300).optional(),
    duration: z.number().int().nonnegative().optional(),
    isrc: z.string().regex(ISRC).optional(),
    artist: z.object({ name: z.string().trim().min(1).max(300).optional() }).passthrough().optional(),
    album: z
      .object({
        id: z.number().int().positive().optional(),
        title: z.string().trim().min(1).max(300).optional(),
        md5_image: z.string().regex(MD5).optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

const songBody = {
  external_id: z.string().trim().min(1).max(200).optional(),
  title: z.string().trim().min(1).max(300).optional(),
  artist: z.string().trim().min(1).max(300).optional(),
  label: z.string().trim().min(1).max(300).optional(),
  genre: z.string().trim().min(1).max(300).optional(),
  nationality: z.enum(['DOMESTIC', 'INTERNATIONAL']).optional(),
  vocal: z.enum(['MALE', 'FEMALE', 'DUO', 'GROUP', 'INSTRUMENTAL']).optional(),
  duration_seconds: z.number().int().nonnegative().optional(),
  isrc: z.string().regex(ISRC, 'that is not an ISRC').optional(),
  internal_code: z.string().trim().min(1).max(100).optional(),
  album: albumSchema.optional(),
  deezer_track_id: z.number().int().positive().optional(),
  deezer: deezerTrackSchema.optional(),
};

/**
 * Endpoint 1's body. `title` and `artist` are required — but they may arrive
 * through `deezer` instead, so the requirement is checked after normalisation
 * rather than here, where it would refuse a valid Deezer payload.
 */
export const songIntakeSchema = z.object(songBody).strict();
export type SongIntake = z.infer<typeof songIntakeSchema>;

export const musicRequestSchema = z
  .object({
    external_id: z.string().trim().min(1).max(200).optional(),
    listener: z
      .object({
        phone: z.string().trim().min(5).max(40),
        name: z.string().trim().min(1).max(200).optional(),
      })
      .strict(),
    song: z.object(songBody).strict(),
    show: z.string().trim().min(1).max(300).optional(),
    requested_at: z.string().datetime({ offset: true }).optional(),
  })
  .strict();
export type MusicRequestIntake = z.infer<typeof musicRequestSchema>;

export interface NormalisedSong {
  externalId: string | null;
  title: string | null;
  artistName: string | null;
  labelName: string | null;
  genreName: string | null;
  albumTitle: string | null;
  nationality: 'DOMESTIC' | 'INTERNATIONAL' | null;
  vocal: 'MALE' | 'FEMALE' | 'DUO' | 'GROUP' | 'INSTRUMENTAL' | null;
  durationSeconds: number | null;
  isrc: string | null;
  internalCode: string | null;
  deezerTrackId: number | null;
  deezerAlbumId: number | null;
  upc: string | null;
  coverMd5: string | null;
  releaseDate: string | null;
}

/**
 * Folds `deezer` into the flat shape the database doors take.
 *
 * THE FLAT FIELDS WIN. Somebody who sent `title` alongside a Deezer object was
 * being explicit, and this API does not overrule that — the same instinct
 * registerFromDeezerAction follows when it reads every reference out of the
 * form rather than out of the payload the dialog was opened with.
 */
export function normaliseSong(input: SongIntake): NormalisedSong {
  const d = input.deezer;
  const pick = <T>(explicit: T | undefined, fromDeezer: T | undefined): T | null =>
    explicit ?? fromDeezer ?? null;

  return {
    externalId: input.external_id ?? null,
    title: pick(input.title, d?.title),
    artistName: pick(input.artist, d?.artist?.name),
    labelName: input.label ?? null,
    genreName: input.genre ?? null,
    albumTitle: pick(input.album?.title, d?.album?.title),
    nationality: input.nationality ?? null,
    vocal: input.vocal ?? null,
    durationSeconds: pick(input.duration_seconds, d?.duration),
    isrc: pick(input.isrc, d?.isrc),
    internalCode: input.internal_code ?? null,
    deezerTrackId: pick(input.deezer_track_id, d?.id),
    deezerAlbumId: pick(input.album?.deezer_album_id, d?.album?.id),
    upc: input.album?.upc ?? null,
    // Deezer carries md5_image on the album AND on the track; they are the same
    // hash. The album's is read because the column it lands in belongs to the
    // album (design D5 of Block 13a: the cover lives on the album, not the song).
    coverMd5: pick(input.album?.cover_md5, d?.album?.md5_image),
    releaseDate: input.album?.release_date ?? null,
  };
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `npm test -- tests/unit/api-schemas.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/schemas/api.ts tests/unit/api-schemas.test.ts
git commit -m "feat(api): request schemas, strict at our boundary and tolerant of Deezer's"
```

---

## Task 9: The song endpoint

**Files:**
- Create: `src/app/api/v1/songs/route.ts`
- Modify: `src/middleware.ts` (the matcher)
- Test: `tests/unit/api-songs-route.test.ts`

**Interfaces:**
- Consumes: `authenticate`, `apiError`, `jsonOk`, `guardRequest`, `requestId`, `mapPostgresError`, `songIntakeSchema`, `normaliseSong`, `createServiceClient`, `PostgresRateLimiter`.
- Produces: `POST(request: Request): Promise<Response>`.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/api-songs-route.test.ts`. It calls the handler directly, so it never exercises the middleware — which is exactly why Step 4 exists and cannot be a test.

```ts
import { describe, expect, it, vi, beforeEach } from 'vitest';

const rpc = vi.fn();
vi.mock('@/lib/supabase/service-client', () => ({
  createServiceClient: () => ({ rpc }),
}));

const { POST } = await import('@/app/api/v1/songs/route');

function post(body: unknown, headers: Record<string, string> = {}) {
  return new Request('https://example.test/api/v1/songs', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

beforeEach(() => rpc.mockReset());

describe('POST /api/v1/songs', () => {
  it('refuses a request with no Authorization header', async () => {
    const response = await POST(post({ title: 'A', artist: 'B' }));
    expect(response.status).toBe(401);
    expect((await response.json()).error.code).toBe('unauthorized');
  });

  it('refuses a body that is not JSON', async () => {
    const response = await POST(
      new Request('https://example.test/api/v1/songs', {
        method: 'POST',
        headers: { 'content-type': 'text/plain', authorization: 'Bearer ptx_x' },
        body: 'hello',
      }),
    );
    expect(response.status).toBe(415);
  });

  it('answers 403 when the key is valid but lacks the scope', async () => {
    rpc.mockResolvedValueOnce({
      data: [{ credential_id: 'c', company_id: 'co', organization_id: 'o', scope_ok: false }],
      error: null,
    });
    const response = await POST(post({ title: 'A', artist: 'B' }, { authorization: 'Bearer ptx_x' }));
    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe('forbidden_scope');
  });

  it('answers 201 with the new song, and echoes the request id', async () => {
    rpc.mockResolvedValueOnce({
      data: [{ credential_id: 'c', company_id: 'co', organization_id: 'o', scope_ok: true }],
      error: null,
    });
    // The rate limiter's own rpc call.
    rpc.mockResolvedValueOnce({ data: [{ allowed: true, remaining: 9, reset_at: new Date().toISOString() }], error: null });
    rpc.mockResolvedValueOnce({
      data: { song_id: 's1', created: true, filled: [], references: {} },
      error: null,
    });

    const response = await POST(
      post({ title: 'A', artist: 'B' }, { authorization: 'Bearer ptx_x', 'x-request-id': 'trace-1' }),
    );
    expect(response.status).toBe(201);
    expect(response.headers.get('x-request-id')).toBe('trace-1');
    expect((await response.json()).song_id).toBe('s1');
  });

  it('answers 422 with the offending path when the body is wrong', async () => {
    rpc.mockResolvedValueOnce({
      data: [{ credential_id: 'c', company_id: 'co', organization_id: 'o', scope_ok: true }],
      error: null,
    });
    rpc.mockResolvedValueOnce({ data: [{ allowed: true, remaining: 9, reset_at: new Date().toISOString() }], error: null });

    const response = await POST(post({ title: 'A' }, { authorization: 'Bearer ptx_x' }));
    expect(response.status).toBe(422);
    const body = await response.json();
    expect(body.error.code).toBe('invalid_payload');
    expect(body.error.details.some((d: { path: string }) => d.path.includes('artist'))).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- tests/unit/api-songs-route.test.ts`
Expected: FAIL — cannot resolve `@/app/api/v1/songs/route`.

- [ ] **Step 3: Write the route**

```ts
import { createServiceClient } from '@/lib/supabase/service-client';
import { PostgresRateLimiter } from '@/lib/rate-limit';
import { logger } from '@/lib/logger';
import { authenticate } from '@/lib/api/credentials';
import { mapPostgresError } from '@/lib/api/errors';
import { apiError, guardRequest, jsonOk, requestId } from '@/lib/api/respond';
import { normaliseSong, songIntakeSchema } from '@/schemas/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const REQUESTS_PER_MINUTE = 120;

/**
 * Endpoint 1 (design spec §5): register a song's record with every dependency
 * it names, idempotently.
 *
 * It is excluded from the middleware matcher (src/middleware.ts). An automation
 * holds no session cookie, so matched it would be answered with a 307 to /login
 * and none of this would run — the defect that reached both the webhook and the
 * worker tick before it. Nothing here can be tested for that: this file's tests
 * import the handler and call it directly.
 *
 * ONE DATABASE DOOR, and everything it writes is one transaction. Resolving the
 * artist, the label, the genre and the album from four round trips here would
 * leave orphan rows in a Station's catalogue on any failure after the first
 * write, with nothing to explain where they came from.
 */
export async function POST(request: Request): Promise<Response> {
  const id = requestId(request);

  const guard = guardRequest(request, id);
  if (guard) return guard;

  const supabase = createServiceClient();

  let auth;
  try {
    auth = await authenticate(supabase, request.headers.get('authorization'), 'music.manage');
  } catch (cause) {
    logger.error({ err: cause, requestId: id }, 'api: credential lookup failed');
    return apiError('internal', 'The request could not be completed.', 500, id);
  }

  if (!auth.ok) {
    return auth.code === 'forbidden_scope'
      ? apiError('forbidden_scope', 'This key does not hold music.manage.', 403, id)
      : apiError('unauthorized', 'That key is not usable.', 401, id);
  }

  // Per credential, not per IP: an automation has one address, and the counter
  // has to survive between instances — which is why this is the Postgres
  // limiter and not the in-memory one the Deezer tab uses.
  const gate = await new PostgresRateLimiter(supabase).check(
    `api:songs:${auth.credentialId}`,
    REQUESTS_PER_MINUTE,
    60,
  );
  if (!gate.allowed) {
    const retryAfter = Math.max(1, Math.ceil((gate.resetAt.getTime() - Date.now()) / 1000));
    return apiError('rate_limited', 'Too many requests.', 429, id, undefined, {
      'retry-after': String(retryAfter),
    });
  }

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return apiError('malformed_json', 'That body is not JSON.', 400, id);
  }

  const parsed = songIntakeSchema.safeParse(raw);
  if (!parsed.success) {
    return apiError('invalid_payload', 'That body was refused.', 422, id,
      parsed.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })));
  }

  const song = normaliseSong(parsed.data);

  // Checked here rather than in the schema because either may arrive through
  // `deezer`, and a schema-level `required` would refuse a valid Deezer payload.
  const missing = [
    song.title ? null : 'title',
    song.artistName ? null : 'artist',
  ].filter((field): field is string => field !== null);

  if (missing.length > 0) {
    return apiError('invalid_payload', 'A song needs a title and an artist.', 422, id,
      missing.map((path) => ({ path, message: 'Required' })));
  }

  const { data, error } = await supabase.rpc('api_register_song', {
    p_credential_id: auth.credentialId,
    p_company_id: auth.companyId,
    p_org: auth.organizationId,
    p_external_id: song.externalId,
    p_title: song.title,
    p_artist_name: song.artistName,
    p_label_name: song.labelName,
    p_genre_name: song.genreName,
    p_album_title: song.albumTitle,
    p_nationality: song.nationality,
    p_vocal: song.vocal,
    p_duration_seconds: song.durationSeconds,
    p_isrc: song.isrc,
    p_internal_code: song.internalCode,
    p_deezer_track_id: song.deezerTrackId,
    p_deezer_album_id: song.deezerAlbumId,
    p_upc: song.upc,
    p_cover_md5: song.coverMd5,
    p_release_date: song.releaseDate,
  });

  if (error) {
    const mapped = mapPostgresError(error.code, error.message);
    // Logged with the raw text, answered without it: the fault may be ours and
    // the message may carry a database error, which is not something to publish.
    logger.error({ err: error, requestId: id, credentialId: auth.credentialId },
      'api: register song failed');
    return apiError(mapped.code, mapped.message, mapped.status, id);
  }

  const result = data as { song_id: string; created: boolean };
  return jsonOk(result, result.created ? 201 : 200, id);
}
```

- [ ] **Step 4: Add the matcher exclusion**

In `src/middleware.ts`, extend the comment block above `config` with a paragraph naming the new prefix, and change the matcher to add `api/v1/`:

```ts
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|api/webhooks/|api/worker/|api/v1/|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
```

Add to the comment block above it:

```
  // `/api/v1/` joins them in Block 15, on the same terms and for the same
  // reason: it holds only machine endpoints that authenticate themselves, on a
  // per-Station key hashed in the database. An automation carries no session
  // cookie, so matched it would pay a Supabase Auth round trip and then be
  // 307-redirected to /login — and a redirect answered to a queue-draining
  // integration is a failure that looks like silence.
```

- [ ] **Step 5: Run the tests and the type check**

Run: `npm test -- tests/unit/api-songs-route.test.ts && npm run typecheck && npm run lint`
Expected: PASS on all three.

- [ ] **Step 6: Commit**

```bash
git add src/app/api/v1/songs/route.ts src/middleware.ts tests/unit/api-songs-route.test.ts
git commit -m "feat(api): POST /api/v1/songs"
```

---

## Task 10: The music request endpoint

**Files:**
- Create: `src/app/api/v1/music-requests/route.ts`
- Test: `tests/unit/api-music-requests-route.test.ts`

**Interfaces:**
- Consumes: everything Task 9 consumes, plus `deezerTransport` from `@/lib/integrations/deezer` and `musicRequestSchema`.
- Produces: `POST(request: Request): Promise<Response>`.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/api-music-requests-route.test.ts`:

```ts
import { describe, expect, it, vi, beforeEach } from 'vitest';

const rpc = vi.fn();
vi.mock('@/lib/supabase/service-client', () => ({ createServiceClient: () => ({ rpc }) }));

const album = vi.fn();
vi.mock('@/lib/integrations/deezer', () => ({
  deezerTransport: () => ({ album, search: vi.fn() }),
}));

const { POST } = await import('@/app/api/v1/music-requests/route');

const ALLOWED = { data: [{ allowed: true, remaining: 9, reset_at: new Date().toISOString() }], error: null };
const AUTHED = {
  data: [{ credential_id: 'c', company_id: 'co', organization_id: 'o', scope_ok: true }],
  error: null,
};

function post(body: unknown) {
  return new Request('https://example.test/api/v1/music-requests', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ptx_x' },
    body: JSON.stringify(body),
  });
}

const BODY = {
  listener: { phone: '+5511999990001', name: 'Maria Silva' },
  song: {
    deezer: {
      id: 3135556,
      title: 'Harder, Better, Faster, Stronger',
      duration: 224,
      artist: { name: 'Daft Punk' },
      album: { id: 302127, title: 'Discovery', md5_image: 'a'.repeat(32) },
    },
  },
};

beforeEach(() => {
  rpc.mockReset();
  album.mockReset();
});

describe('POST /api/v1/music-requests', () => {
  it('enriches from /album/{id} and passes the label and genre to the door', async () => {
    rpc.mockResolvedValueOnce(AUTHED).mockResolvedValueOnce(ALLOWED);
    album.mockResolvedValueOnce({
      ok: true,
      value: { id: 302127, title: 'Discovery', upc: '724384960650', label: 'Virgin',
               genreName: 'Electronic', releaseDate: '2001-03-07', coverMd5: 'a'.repeat(32) },
    });
    rpc.mockResolvedValueOnce({
      data: { request_id: 'r1', created: true, song: { id: 's1' }, listener: { id: 'm1' } },
      error: null,
    });

    const response = await POST(post(BODY));
    expect(response.status).toBe(201);
    expect(album).toHaveBeenCalledWith(302127);
    const args = rpc.mock.calls.at(-1)![1];
    expect(args.p_label_name).toBe('Virgin');
    expect(args.p_genre_name).toBe('Electronic');
  });

  it('records the request anyway when Deezer refuses the album lookup', async () => {
    // Best effort, never fatal: a listener's request must not be lost because a
    // second, enriching call failed.
    rpc.mockResolvedValueOnce(AUTHED).mockResolvedValueOnce(ALLOWED);
    album.mockResolvedValueOnce({ ok: false, reason: 'quota', message: 'slow down' });
    rpc.mockResolvedValueOnce({
      data: { request_id: 'r1', created: true, song: { id: 's1' }, listener: { id: 'm1' } },
      error: null,
    });

    const response = await POST(post(BODY));
    expect(response.status).toBe(201);
    expect(rpc.mock.calls.at(-1)![1].p_label_name).toBeNull();
  });

  it('does not call Deezer at all when the caller already sent a label and a genre', async () => {
    rpc.mockResolvedValueOnce(AUTHED).mockResolvedValueOnce(ALLOWED);
    rpc.mockResolvedValueOnce({
      data: { request_id: 'r1', created: true, song: { id: 's1' }, listener: { id: 'm1' } },
      error: null,
    });

    await POST(post({ ...BODY, song: { ...BODY.song, label: 'Virgin', genre: 'Electronic' } }));
    expect(album).not.toHaveBeenCalled();
  });

  it('turns the door refusal for a nameless listener into 422', async () => {
    rpc.mockResolvedValueOnce(AUTHED).mockResolvedValueOnce(ALLOWED);
    rpc.mockResolvedValueOnce({
      data: null,
      error: { code: '22023', message: 'a new listener must arrive with a name' },
    });

    const response = await POST(post({ ...BODY, listener: { phone: '+5511999990001' } }));
    expect(response.status).toBe(422);
    expect((await response.json()).error.code).toBe('listener_name_required');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- tests/unit/api-music-requests-route.test.ts`
Expected: FAIL — cannot resolve the route module.

- [ ] **Step 3: Write the route**

Structure it exactly like Task 9's, with the enrichment inserted between validation and the RPC call, and `music.request` as the authenticating scope. The enrichment:

```ts
/**
 * Design D7. Deezer's /search carries no record label, genre, UPC or release
 * date — verified against a live payload on 2026-08-09. The album call fills
 * them.
 *
 * BEST EFFORT, NEVER FATAL, and this copies prefillFromDeezerAction rather than
 * inventing a second behaviour: everything it would add is optional on both the
 * song and the album, and refusing to record a listener's request because a
 * second, enriching call failed would trade the whole action for three fields
 * nobody asked for.
 *
 * SKIPPED ENTIRELY when the caller already sent both — an integrator who did
 * the work should not make this server pay for a call it does not need, and
 * Deezer's quota is per IP and shared by every Station.
 *
 * There is deliberately NO second call to /track/{id} for the ISRC. The Deezer
 * tab does not make one either; songs registered from a search live without an
 * ISRC and an operator types it. Matching that beats diverging from it.
 */
async function enrich(song: NormalisedSong): Promise<NormalisedSong> {
  if (song.deezerAlbumId === null) return song;
  if (song.labelName !== null && song.genreName !== null) return song;

  const gate = await deezerLimiter.check(`api:deezer:${companyId}`, DEEZER_CALLS_PER_MINUTE, 60);
  if (!gate.allowed) return song;

  const found = await deezerTransport().album(song.deezerAlbumId);
  if (!found.ok) {
    logger.warn({ reason: found.reason, albumId: song.deezerAlbumId },
      'api: deezer album lookup failed; recording without it');
    return song;
  }

  return {
    ...song,
    labelName: song.labelName ?? found.value.label,
    genreName: song.genreName ?? found.value.genreName,
    upc: song.upc ?? found.value.upc,
    releaseDate: song.releaseDate ?? found.value.releaseDate,
    coverMd5: song.coverMd5 ?? found.value.coverMd5,
    albumTitle: song.albumTitle ?? found.value.title,
  };
}
```

The RPC call passes the listener, the show, the timestamp and the sixteen song parameters:

```ts
  const { data, error } = await supabase.rpc('api_record_music_request', {
    p_credential_id: auth.credentialId,
    p_company_id: auth.companyId,
    p_org: auth.organizationId,
    p_request_external_id: parsed.data.external_id ?? null,
    p_phone: parsed.data.listener.phone,
    p_listener_name: parsed.data.listener.name ?? null,
    p_show_name: parsed.data.show ?? null,
    p_requested_at: parsed.data.requested_at ?? null,
    p_song_external_id: song.externalId,
    p_title: song.title,
    p_artist_name: song.artistName,
    p_label_name: song.labelName,
    p_genre_name: song.genreName,
    p_album_title: song.albumTitle,
    p_nationality: song.nationality,
    p_vocal: song.vocal,
    p_duration_seconds: song.durationSeconds,
    p_isrc: song.isrc,
    p_internal_code: song.internalCode,
    p_deezer_track_id: song.deezerTrackId,
    p_deezer_album_id: song.deezerAlbumId,
    p_upc: song.upc,
    p_cover_md5: song.coverMd5,
    p_release_date: song.releaseDate,
  });
```

The response is `jsonOk(data, result.created ? 201 : 200, id)`, with the rate limit key `api:requests:${auth.credentialId}` and `REQUESTS_PER_MINUTE = 60`.

- [ ] **Step 4: Run the tests, types and lint**

Run: `npm test -- tests/unit/api-music-requests-route.test.ts && npm run typecheck && npm run lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/v1/music-requests/route.ts tests/unit/api-music-requests-route.test.ts
git commit -m "feat(api): POST /api/v1/music-requests, with best-effort Deezer enrichment"
```

---

## Task 11: Issuing keys — the service and the script

**Files:**
- Create: `src/services/api-credentials.ts`, `scripts/issue-api-key.mjs`

**Interfaces:**
- Produces:
  - `generateApiKey(): { secret: string; prefix: string; hash: string }` — `secret` is `ptx_` + 43 base64url characters; `prefix` is the first 12 characters of `secret`; `hash` is `hashToken(secret)`
  - `issueApiCredential(input: { companyId: string; name: string; scopes: string[]; expiresAt: string | null }, accessToken: string): Promise<{ id: string; secret: string }>`
  - `listApiCredentials(companyId: string, accessToken: string): Promise<ApiCredentialRow[]>`
  - `revokeApiCredential(credentialId: string, accessToken: string): Promise<void>`
  - `interface ApiCredentialRow { id: string; name: string; tokenPrefix: string; scopes: string[]; expiresAt: string | null; lastUsedAt: string | null; revokedAt: string | null; createdAt: string }`

- [ ] **Step 1: Write the failing test**

Add to `tests/unit/api-credentials.test.ts`:

```ts
import { generateApiKey } from '@/services/api-credentials';

describe('generateApiKey', () => {
  it('mints a prefixed secret whose prefix and hash line up with it', () => {
    const key = generateApiKey();
    expect(key.secret).toMatch(/^ptx_[A-Za-z0-9_-]{43}$/);
    expect(key.prefix).toBe(key.secret.slice(0, 12));
    // The CHECK constraints in 0148 accept exactly these two shapes.
    expect(key.prefix).toMatch(/^ptx_[A-Za-z0-9_-]{8}$/);
    expect(key.hash).toBe(hashToken(key.secret));
  });

  it('does not repeat itself', () => {
    const seen = new Set(Array.from({ length: 50 }, () => generateApiKey().secret));
    expect(seen.size).toBe(50);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- tests/unit/api-credentials.test.ts`
Expected: FAIL — cannot resolve `@/services/api-credentials`.

- [ ] **Step 3: Write the service**

```ts
import 'server-only';
import { randomBytes } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { getUserSupabaseConfig } from '@/lib/supabase/config';
import { hashToken } from '@/lib/api/credentials';
import { InternalError, UnauthorizedError } from '@/lib/errors';
import type { Database } from '@/lib/supabase/database.types';

function asCaller(accessToken: string) {
  const { url, anonKey } = getUserSupabaseConfig();
  return createClient<Database>(url, anonKey, {
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

/**
 * Mints a secret and derives what the database is allowed to keep.
 *
 * 32 bytes, base64url — 256 bits, and no character that needs escaping in a
 * header or a shell. THE SECRET IS RETURNED ONCE and never stored: the caller
 * shows it to the operator and forgets it. Everything the row keeps is derived
 * here, so there is no path where the plaintext could be written by accident.
 */
export function generateApiKey(): { secret: string; prefix: string; hash: string } {
  const secret = `ptx_${randomBytes(32).toString('base64url')}`;
  return { secret, prefix: secret.slice(0, 12), hash: hashToken(secret) };
}
```

Then `issueApiCredential` (calls `generateApiKey`, sends `prefix` and `hash` to `issue_api_credential`, returns `{ id, secret }`), `listApiCredentials` and `revokeApiCredential`, each mapping a `42501` to `UnauthorizedError` and anything else to `InternalError`.

- [ ] **Step 4: Write `scripts/issue-api-key.mjs`**

Model it on `scripts/seed-branding.mjs`: read `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` from the environment, take `--company`, `--name`, `--scopes` and optional `--expires` from `process.argv`, generate the key inline (the script cannot import `server-only` modules), insert through the service client, and print the secret **once** with a line saying it will not be shown again.

- [ ] **Step 5: Run the tests**

Run: `npm test -- tests/unit/api-credentials.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/services/api-credentials.ts scripts/issue-api-key.mjs tests/unit/api-credentials.test.ts
git commit -m "feat(api): mint, list and revoke keys, and a script to issue the first one"
```

---

## Task 12: The Station's own columns

**Files:**
- Create: `supabase/migrations/0153_company_profile.sql`, `supabase/tests/35_company_profile.test.sql`

**Interfaces:**
- Produces: on `public.companies` — `address_line`, `address_number`, `address_complement`, `neighbourhood`, `city`, `state`, `postal_code` (all `text`), `broadcast_band public.broadcast_band`, `frequency_khz integer`, `latitude numeric(9,6)`, `longitude numeric(9,6)`, `thumb_url text`; the enum `public.broadcast_band` with `FM`, `AM`, `WEB`; `update_company_profile(...)`; `set_company_thumb(p_company_id uuid, p_url text default null)`; a `station-thumbs` branch in `may_write_artwork`.

- [ ] **Step 1: Write the failing test**

Create `supabase/tests/35_company_profile.test.sql`:

```sql
begin;
select plan(8);

select has_column('public', 'companies', 'thumb_url', 'a Station can have a picture');
select has_column('public', 'companies', 'frequency_khz', 'and a dial frequency');
select has_column('public', 'companies', 'city', 'and an address');

insert into public.organizations (id, name) values
  ('00000000-0000-0000-0000-0000000000a3', 'Org profile');
insert into public.companies (id, organization_id, name, timezone) values
  ('00000000-0000-0000-0000-0000000000b3', '00000000-0000-0000-0000-0000000000a3',
   'Station profile', 'America/Sao_Paulo');

select throws_ok(
  $$update public.companies set thumb_url = 'not-an-address'
     where id = '00000000-0000-0000-0000-0000000000b3'$$,
  '23514', null, 'a picture that is not an address is refused');

-- Half a coordinate is worse than none: it renders a pin in the Atlantic.
select throws_ok(
  $$update public.companies set latitude = -23.55
     where id = '00000000-0000-0000-0000-0000000000b3'$$,
  '23514', null, 'a latitude with no longitude is refused');

select lives_ok(
  $$update public.companies set latitude = -23.55, longitude = -46.63
     where id = '00000000-0000-0000-0000-0000000000b3'$$,
  'and the pair together is accepted');

select throws_ok(
  $$update public.companies set latitude = 91, longitude = 0
     where id = '00000000-0000-0000-0000-0000000000b3'$$,
  '23514', null, 'a latitude off the planet is refused');

-- The picture has ONE writer, and it is not the wholesale-replace one. 0144 and
-- 0145 both document what happens otherwise: the next ordinary Save clears it.
select is(
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'update_company_profile'
      and 'p_thumb_url' = any(p.proargnames)),
  0::bigint,
  'update_company_profile cannot touch the picture, so a save cannot clear it');

select * from finish();
rollback;
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run db:test`
Expected: FAIL — `column "thumb_url" does not exist`.

- [ ] **Step 3: Write the migration**

Create `0153_company_profile.sql` with:

1. `create type public.broadcast_band as enum ('FM', 'AM', 'WEB');` with a comment explaining that **one unit is stored** — `frequency_khz`, so FM 98.5 MHz is `98500` and AM 1200 kHz is `1200` — chosen over a `numeric` in MHz because an integer has no rounding, and over free text because free text cannot be sorted or validated.
2. The `alter table public.companies add column ...` for all twelve columns, mirroring `members`' seven address names verbatim (0031) so there is not a second address shape in one database.
3. The CHECKs: `companies_thumb_shape` (`^https?://`, mirroring `prizes_photo_shape`), `companies_coordinates_pair` (both null or both set), `companies_latitude_range` (`between -90 and 90`), `companies_longitude_range` (`between -180 and 180`), `companies_frequency_positive`.
4. `update_company_profile(p_company_id uuid, p_address_line text, p_address_number text, p_address_complement text, p_neighbourhood text, p_city text, p_state text, p_postal_code text, p_broadcast_band public.broadcast_band, p_frequency_khz integer, p_latitude numeric, p_longitude numeric) returns void` — gated `is_platform_admin()`, writing **every** field on every call (the convention `update_prize`, `update_role` and `update_song` all follow), with an audit entry carrying before and after. It takes **no** `p_thumb_url`, and the comment says why.
5. `set_company_thumb(p_company_id uuid, p_url text default null)` — gated `is_platform_admin()`, `for update` on the row, enqueueing `enqueue_artwork_erasure(v_current, 'station-thumbs/' || p_company_id || '/thumb')` when clearing, modelled directly on `set_prize_photo` (0145).
6. `create or replace function public.may_write_artwork(p_name text)` — the whole 0143 body, restated, with one new branch before the final `return false`:

```sql
  -- Block 15. The Station's own picture. is_platform_admin() rather than a
  -- has_permission code, because the console that edits it is the platform's
  -- (design D9) and there is no Company permission that names this.
  if v_slot = 'station-thumbs' then
    return public.is_platform_admin();
  end if;
```

7. Extend `ArtworkSlot` in `src/lib/storage/artwork-keys.ts` to include `'station-thumbs'`.

- [ ] **Step 4: Run to verify it passes**

Run: `npm run db:reset && npm run db:test`
Expected: `35_company_profile` — 8 passing, and every earlier file still passing.

- [ ] **Step 5: Regenerate types and commit**

```bash
npm run db:types
git add supabase/migrations/0153_company_profile.sql supabase/tests/35_company_profile.test.sql src/lib/storage/artwork-keys.ts src/lib/supabase/database.types.ts
git commit -m "feat(stations): a Station gets an address, a frequency, a place and a picture"
```

---

## Task 13: The console — the Customer tab form and the API keys tab

**Files:**
- Create: `src/app/(admin)/admin/customers/station-form.tsx`, `src/app/(admin)/admin/customers/api-keys-tab.tsx`
- Create: `src/services/company-profile.ts`
- Modify: `src/lib/record-params.ts` (`CUSTOMER_TABS`), `src/app/(admin)/admin/customers/customer-record-dialog.tsx`, `src/app/(admin)/admin/customers/actions.ts`, `src/app/(admin)/admin/customers/page.tsx`, `messages/en.json`, `messages/es.json`, `messages/pt.json`

- [ ] **Step 1: Extend the tab vocabulary**

In `src/lib/record-params.ts`:

```ts
export const CUSTOMER_TABS = ['customer', 'stations', 'owner', 'keys'] as const;
```

`keys` is appended rather than inserted: `parseRecordParam` falls back to `tabs[0]` for an unknown `tab=`, so the first element is the tab a record opens on, and inserting would change where every existing link lands.

- [ ] **Step 2: Correct the dialog's comment**

`customer-record-dialog.tsx` opens with:

> *The Customer tab has no Save button, and that is a finding rather than an omission: no migration defines update_company or a rename, so there is nothing on a Station that this console may edit.*

That stops being true in this block. Replace it with a paragraph saying that 0153 gives the console the Station's own record — address, frequency, coordinates and picture — that name, timezone and status are **still** not editable here (D10; status changes through the row menu), and that the picture has a writer of its own because `update_company_profile` replaces every field it takes.

Leaving the old sentence would put a lie in the code, and those cost the most later.

- [ ] **Step 3: Write `src/services/company-profile.ts`**

`updateCompanyProfile(input, accessToken)` calls `update_company_profile`; `setCompanyThumb(input, accessToken)` validates the file with `describeArtworkRejection('thumb', …)`, uploads to `artworkKey('station-thumbs', companyId, 'thumb')` in `ARTWORK_BUCKET` with `contentType: file.type` and `upsert: true`, then calls `set_company_thumb` with `artworkPublicUrl(url, key, Date.now())`; `clearCompanyThumb(companyId, accessToken)` calls `set_company_thumb` **omitting** `p_url` — 0145's `default null` exists precisely so clearing needs no cast. This mirrors `setPrizePhoto` / `clearPrizePhoto` in `src/services/inventory.ts` line for line.

- [ ] **Step 4: Write the two tab components**

`station-form.tsx` is a client component: `ImageUploadField` with `name="thumb"` and `kind="thumb"`, the seven address inputs, a `broadcast_band` select, a `frequency_khz` number input labelled in MHz for FM and kHz for AM (converted on submit), and two coordinate inputs. One Save, through a Server Action in `actions.ts`.

`api-keys-tab.tsx` lists what `list_api_credentials` returns, with a Revoke button per live row and an issue form (name, scope checkboxes, optional expiry). On issue it renders the secret **once**, in a box with a copy button and a line saying it will not be shown again.

- [ ] **Step 5: Add the translations**

Every new string goes into the `admin` namespace of all three of `messages/en.json`, `messages/es.json`, `messages/pt.json`.

- [ ] **Step 6: Verify**

Run: `npm run typecheck && npm run lint && npm test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/app/\(admin\)/admin/customers src/services/company-profile.ts src/lib/record-params.ts messages
git commit -m "feat(admin): edit a Station's record and manage its machine keys"
```

---

## Task 14: The card

**Files:**
- Modify: `src/app/(app)/app/page.tsx`, `messages/en.json`, `messages/es.json`, `messages/pt.json`
- Test: `tests/e2e/station-settings.spec.ts`

- [ ] **Step 1: Write the failing e2e test**

Create `tests/e2e/station-settings.spec.ts` covering, as the platform admin: opening a customer record, uploading a thumb, saving the address and frequency, seeing the thumb on `/app`, issuing a key and seeing the secret once, and revoking it. Follow the existing specs in `tests/e2e/` for the sign-in helper and the `data-testid` conventions.

- [ ] **Step 2: Run to verify it fails**

Run: `npm run test:e2e -- station-settings`
Expected: FAIL — no thumb on the card.

- [ ] **Step 3: Rewrite the card**

Add `thumb_url, broadcast_band, frequency_khz, address_line, address_number, neighbourhood, city, state, postal_code` to the `select`, render the thumb (or the name's initial in a circle), the formatted frequency (`98,5 FM` / `1200 AM` / the `WEB` label), and the assembled address.

**Also fix the two English strings that escaped Block 12's language migration** in this file — *"No station is linked to your account yet. Please contact us."* and *"Suspended — no data is available while the subscription is inactive."* — moving both into the `app` namespace of all three message files.

Coordinates are **not** rendered (D12).

- [ ] **Step 4: Run the e2e and the whole suite**

Run: `npm run test:e2e -- station-settings && npm test && npm run typecheck && npm run lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/app/\(app\)/app/page.tsx tests/e2e/station-settings.spec.ts messages
git commit -m "feat(stations): the card shows the Station, not just its name"
```

---

## Task 15: Isolation, documentation and the full sweep

**Files:**
- Create: `tests/isolation/api-intake.isolation.test.ts`, `docs/API.md`
- Modify: `docs/SECURITY.md`, `docs/DATABASE.md`, `docs/PERMISSIONS.md`

- [ ] **Step 1: Write the isolation test**

This is the test that matters most in the block. Following the conventions in `tests/isolation/`, provision two Organizations each with a Station, issue a credential for Station A, and assert that:

1. `api_register_song` with A's credential but B's `p_company_id` raises `42501`.
2. After registering a song through A's credential, Station B's `songs`, `artists`, `record_labels`, `music_genres` and `albums` are all still empty.
3. The same for `api_record_music_request` and B's `members` and `music_requests`.

- [ ] **Step 2: Run it**

Run: `npm run test:isolation`
Expected: PASS.

- [ ] **Step 3: Write `docs/API.md`**

Both contracts in full, the deduplication ladder with its reasoning, the error table from spec §7, the rate limits, how a key is issued and revoked, and a worked `curl` example for each endpoint. State plainly that a key is a bearer token and what that means.

- [ ] **Step 4: Update the three existing docs**

`SECURITY.md` gains a section on the credential model — hashing, revocation, expiry, scope, and the explicit note that there is no IP allowlist. `DATABASE.md` gains the two new tables and the `companies` columns. `PERMISSIONS.md` gains a paragraph explaining that a credential's scopes are permission codes and that they are checked against the credential rather than through `has_permission`.

- [ ] **Step 5: Run everything**

```bash
npm run typecheck && npm run lint && npm test && npm run db:reset && npm run db:test && npm run test:isolation && npm run test:e2e
```

Expected: all green. Investigate any failure rather than re-running.

- [ ] **Step 6: Confirm the untouched WIP**

```bash
git status --short
```

Expected: exactly ` M scripts/seed-demo.mjs` — the same line Task 0 started with, still uncommitted and unchanged.

- [ ] **Step 7: Commit and push**

```bash
git add docs/API.md docs/SECURITY.md docs/DATABASE.md docs/PERMISSIONS.md tests/isolation/api-intake.isolation.test.ts
git commit -m "docs: the external intake API, its key model and its isolation proof"
git push -u origin block-15-external-intake-api
```

---

## Self-Review Notes

**Spec coverage.** Every `D<n>` in spec §3 maps to a task: D1 → 1, 2, 5, 6; D2 → 9, 10; D3/D4 → 4; D5 → 3; D6 → 6; D7 → 10; D8 → 4; D9 → 13, 14; D10 → 13 (stated as a non-change); D11/D12 → 12. Spec §7's error table is Task 7; §8 is Tasks 12–14; §11 is Tasks 11 and 15.

**Two things this plan deliberately leaves to the implementer, with instructions rather than code.** Task 6 Step 4 requires reading 0061 and 0031 before finalising the member calls, because inventing a third lookup is precisely the drift those cores exist to prevent. Task 13 Steps 3–5 describe components rather than transcribing them, because they follow `prize-form.tsx` and `credential-forms.tsx` closely enough that copying a stale transcription would be worse than reading the originals.

**Ordering constraint.** `0151` must be applied before `0152` runs. They are separate files, so `supabase db reset` gives them separate transactions; do not merge them.
