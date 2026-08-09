# Block 17a — The public widget door: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A page this product serves, embedded in an `<iframe>` on a Station's own website, which verifies a visitor's telephone number over WhatsApp and hands them an identified session.

**Architecture:** A public, non-secret key in the iframe URL names the Station. The framing exception is per-Station and comes from the database through the Edge middleware. Identification is a six-digit code sent through the existing outbox and verified against a stored SHA-256; on success the visitor holds a thirty-minute HMAC in a partitioned cookie. Every write is a `SECURITY DEFINER` door — the widget session is the subject, never a borrowed `auth.uid()`.

**Tech Stack:** Next.js App Router (Edge middleware + Node route handlers), Supabase Postgres with pgTAP, Vitest, Playwright, Zod, `next-intl`.

**Spec:** `docs/superpowers/specs/2026-08-09-block-17a-web-widget-design.md`. Every decision reference (D1–D8) points there.

## Global Constraints

- **Migrations are numbered `0159`–`0162`** and are append-only. Never edit a shipped migration.
- **Before reproducing any function or procedure body, `grep -rln '<name>' supabase/migrations/` and take the HIGHEST-numbered definition as your base.** `create or replace` means the file that first defined something is often not the file that defines it now. Task 3 was told to reproduce `sweep_retention` from `0131` and `0133` had already replaced it — copying `0131` compiled, passed pgTAP, and would have silently dropped the `job_health` stamps, leaving the monitor quiet with nothing failing. pgTAP cannot catch this class: it will not execute a procedure that commits. The isolation suite did.
- **`0160` contains the two `ALTER TYPE ... ADD VALUE` statements and nothing else.** `ADD VALUE` cannot share a transaction with a statement that uses the value.
- **Tables that hold credentials or installation state get RLS on and NO policy**, following `integrations` (0057) and `api_credentials` (0148). This schema revokes the default ACL, so `createServiceClient().from(...)` fails with `42501` by design. Every reader is inside a `SECURITY DEFINER` body.
- **Write the explicit `revoke all on <table> from anon, authenticated;` line.** The two cited precedents differ and the difference is worth knowing: `0057` writes it out; `0148` omits it and relies on the schema's default-ACL revoke, with a comment saying so. Prefer `0057`'s explicit form — it states the intent in the file a reader is looking at rather than in a comment about somewhere else.
- **A secret is hashed in Node before it reaches the database**, never passed raw as an RPC argument — an RPC argument lands in query logs and in backups. **One exception, and only one:** `widget_request_code`'s `p_code_plain` (Task 4), because the message is sent by the worker draining `outbox_messages` and the outbox is *in* the database. What the rule protects — the stored credential — is kept whole: `widget_verifications` holds only the digest. Task 4 carries the full argument; no other door may claim this exception.
- **Every user-visible string goes through `next-intl`**, in all three of `messages/en.json`, `messages/pt.json`, `messages/es.json`. No hardcoded copy in a component.
- **Code, comments, commit messages and docs are in English.** Listener-facing copy is translated.
- **Comments explain why, not what.** A comment that justifies a decision must name the alternative rejected.
- After any migration: `npm run db:reset && npm run db:types` before typechecking.
- Verification gates for every task: `npm run lint`, `npm run typecheck`, `npm test`, `npm run db:test`.

---

## File Structure

**Created**

| File | Responsibility |
| --- | --- |
| `supabase/migrations/0159_widget_installations.sql` | the installation table |
| `supabase/migrations/0160_widget_enum_values.sql` | the two `ADD VALUE`s, alone |
| `supabase/migrations/0161_widget_doors.sql` | verifications table + the four public doors |
| `supabase/migrations/0162_widget_console.sql` | the two console doors |
| `supabase/tests/39_widget_installations.test.sql` | table shape, RLS, the origin CHECK, the console doors |
| `supabase/tests/40_widget_verification.test.sql` | the code lifecycle and the identify door |
| `src/lib/widget/code.ts` | generate and hash a six-digit code |
| `src/lib/widget/session.ts` | mint and verify the visitor HMAC |
| `src/lib/widget/origins.ts` | parse and validate an origin allowlist |
| `src/schemas/widget.ts` | the three form bodies |
| `src/services/widget-installations.ts` | the console's read and write path |
| `src/app/(widget)/layout.tsx` | the chrome-free shell |
| `src/app/(widget)/w/[publicKey]/page.tsx` | the widget page |
| `src/app/(widget)/w/[publicKey]/actions.ts` | request code, verify code |
| `src/app/(widget)/w/[publicKey]/identify-form.tsx` | phone + name, then the code box |
| `src/app/(widget)/w/[publicKey]/menu.tsx` | the two (disabled) buttons |
| `src/app/(admin)/admin/stations/widget-tab.tsx` | the console tab |
| `tests/unit/widget-code.test.ts`, `widget-session.test.ts`, `widget-origins.test.ts`, `csp-frame-ancestors.test.ts` | the Node units |
| `tests/isolation/widget.test.ts` | Station A's session writes nothing into B |
| `tests/e2e/widget.spec.ts` | the identification inside a cross-origin iframe |

**Modified**

| File | Change |
| --- | --- |
| `src/lib/security/csp.ts:15-72` | `buildContentSecurityPolicy` takes the frame-ancestors value |
| `src/middleware.ts:22-97` | the `/w/` branch, above the Supabase client |
| `next.config.mjs:103` | header source becomes `'/((?!w/).*)'` |
| `src/lib/env.ts` | `WIDGET_SESSION_SECRET` |
| `src/lib/record-params.ts:99` | `STATION_TABS` gains `'widget'` |
| `src/app/(admin)/admin/stations/station-record-dialog.tsx` | render the new tab |
| `src/app/(admin)/admin/stations/actions.ts` | the two widget actions |
| `messages/en.json`, `messages/pt.json`, `messages/es.json` | the widget and tab strings |
| `docs/API.md` or a new `docs/WIDGET.md` | how a Station embeds it |

---

### Task 1: The installation table

**Files:**
- Create: `supabase/migrations/0159_widget_installations.sql`
- Create: `supabase/tests/39_widget_installations.test.sql`

**Interfaces:**
- Consumes: nothing.
- Produces: `public.widget_installations (id, organization_id, company_id, public_key, enabled, allowed_origins, created_by, created_at, updated_at, deleted_at)`.

- [ ] **Step 1: Write the failing pgTAP test**

Create `supabase/tests/39_widget_installations.test.sql`:

```sql
begin;
select plan(9);

-- Block 17a, design D4. The public key is NOT a secret: it sits in the src of
-- an iframe on a public web page. Everything that actually defends this door is
-- elsewhere -- the origin allowlist, the rate limits, and the code of spec §6.

select has_table('public', 'widget_installations', 'the installation table exists');

select is(
  (select relrowsecurity from pg_class where oid = 'public.widget_installations'::regclass),
  true, 'row level security is enabled');

select is(
  (select count(*) from pg_policies
    where schemaname = 'public' and tablename = 'widget_installations'),
  0::bigint, 'and there is no policy, so nothing reaches it directly');

select col_has_default('public', 'widget_installations', 'enabled',
  'enabled has a default');

insert into public.organizations (id, name) values
  ('00000000-0000-0000-0000-0000000000e1', 'Org widget');
insert into public.companies (id, organization_id, name, timezone) values
  ('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000e1',
   'Station widget', 'America/Sao_Paulo');

insert into public.widget_installations
  (id, organization_id, company_id, public_key)
values
  ('00000000-0000-0000-0000-000000000101',
   '00000000-0000-0000-0000-0000000000e1',
   '00000000-0000-0000-0000-0000000000f1', 'pw_aaaabbbbccccddddeeeeff');

-- A Station that has just been given an installation is not yet serving a
-- widget to the public. Somebody has to say so.
select is(
  (select enabled from public.widget_installations
    where id = '00000000-0000-0000-0000-000000000101'),
  false, 'a new installation is disabled until somebody enables it');

select is(
  (select allowed_origins from public.widget_installations
    where id = '00000000-0000-0000-0000-000000000101'),
  '{}'::text[], 'and it frames nowhere, which is what an empty allowlist means');

-- An origin is a scheme and a host. A path or a trailing slash would never
-- match what a browser sends in frame-ancestors, and would fail as "the widget
-- does not load" rather than as a refused write.
select throws_ok($$
  update public.widget_installations
     set allowed_origins = array['https://radio.com.br/']
   where id = '00000000-0000-0000-0000-000000000101'$$,
  '23514', null, 'a trailing slash is refused');

select throws_ok($$
  update public.widget_installations
     set allowed_origins = array['radio.com.br']
   where id = '00000000-0000-0000-0000-000000000101'$$,
  '23514', null, 'and so is a bare host with no scheme');

select lives_ok($$
  update public.widget_installations
     set allowed_origins = array['https://radio.com.br', 'https://www.radio.com.br']
   where id = '00000000-0000-0000-0000-000000000101'$$,
  'two well-formed origins are accepted');

select * from finish();
rollback;
```

- [ ] **Step 2: Run it and verify it fails**

Run: `npm run db:reset && npm run db:test`
Expected: FAIL — `relation "public.widget_installations" does not exist`.

- [ ] **Step 3: Write the migration**

Create `supabase/migrations/0159_widget_installations.sql`:

```sql
-- supabase/migrations/0159_widget_installations.sql

-- Block 17a, design D4. One installation per Station, and a key that is
-- deliberately NOT a credential.
--
-- THE NAME IS THE WARNING. This value travels in the `src` of an <iframe> on a
-- Station's public website, so it is readable by anybody who views source. A
-- reader who mistakes it for a secret will build the wrong defence: they will
-- reach for hashing and rotation, and leave the origin allowlist and the rate
-- limits -- which are what actually hold this door -- as an afterthought.
-- It identifies a Station. It authenticates nobody. The visitor is
-- authenticated by the code in 0161, and by nothing else.

-- A CHECK may not contain a subquery, and asking "does every element of this
-- array match" needs one. `has_no_duplicates` (0040) is the precedent and its
-- comment is the reasoning: an immutable function is the only way to state the
-- rule in the schema rather than in prose.
create or replace function public.are_origins(p_values text[])
returns boolean
language sql
immutable
parallel safe
set search_path = pg_catalog
as $$
  select p_values is null
      or not exists (
        select 1 from unnest(p_values) as v
         where v !~ '^https?://[A-Za-z0-9.-]+(:[0-9]{1,5})?$');
$$;

comment on function public.are_origins(text[]) is
  'True when every entry is a scheme and a host, with an optional port, and nothing else -- the grammar a browser matches frame-ancestors against. Exists because a CHECK cannot contain a subquery.';

create table public.widget_installations (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id),
  company_id      uuid not null,
  public_key      text not null,
  -- FALSE by default, and that is a decision rather than a convention. Creating
  -- an installation is the console admin describing an intention; serving a
  -- widget to the public is a second, separate act.
  enabled         boolean not null default false,
  -- Empty means "frames nowhere". It is NOT a synonym for "any" -- an allowlist
  -- that falls open when unconfigured is how a widget ends up embeddable from
  -- anywhere with nothing on any screen to say so.
  allowed_origins text[] not null default '{}',
  created_by      uuid references auth.users (id),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  deleted_at      timestamptz,

  constraint widget_installations_company_org_fk
    foreign key (company_id, organization_id)
    references public.companies (id, organization_id),

  constraint widget_installations_key_shape
    check (public_key ~ '^pw_[A-Za-z0-9_-]{22}$'),

  -- Scheme and host, nothing else: no path, no trailing slash, no query. This
  -- is the exact grammar a browser matches frame-ancestors against, so anything
  -- looser here fails later as "the widget will not load", which is a much
  -- worse failure than a refused write -- nothing logs it and nobody can see it
  -- from a screen.
  --
  -- Through a function because A CHECK MAY NOT CONTAIN A SUBQUERY and testing
  -- every element of an array needs one. 0040 hit this exact wall and its
  -- comment states the cure: wrapping it in an immutable function is the only
  -- way to state the rule in the schema rather than in prose.
  constraint widget_installations_origins_shape
    check (public.are_origins(allowed_origins))
);

-- Partial on deleted_at, the shape message_templates (0110) uses and for the
-- reason its comment gives: without it, archiving a stale installation would
-- leave the console unable to create its replacement.
create unique index widget_installations_company_unique
  on public.widget_installations (company_id)
  where deleted_at is null;

create unique index widget_installations_key_unique
  on public.widget_installations (public_key)
  where deleted_at is null;

comment on table public.widget_installations is
  'One embeddable widget per Station. RLS on and NO POLICY, the shape integrations (0057) and api_credentials (0148) use: this schema revokes the default ACL, so createServiceClient().from(''widget_installations'') fails with 42501 and every reader is inside a SECURITY DEFINER body.';

comment on column public.widget_installations.public_key is
  'NOT A SECRET, and named so nobody has to guess. It travels in the src of an iframe on a public page. It names a Station; it proves nothing about who is asking. What defends this door is allowed_origins, the rate limits in 0161, and the verification code -- not this column.';

comment on column public.widget_installations.allowed_origins is
  'Full origins, scheme and host only, matched by the browser against frame-ancestors. EMPTY MEANS NOWHERE, deliberately: an allowlist that means "any" when unconfigured is a hole that no screen would show.';

alter table public.widget_installations enable row level security;
revoke all on public.widget_installations from anon, authenticated;
```

- [ ] **Step 4: Run the test and verify it passes**

Run: `npm run db:reset && npm run db:test`
Expected: PASS — `39_widget_installations.test.sql .. ok`.

- [ ] **Step 5: Regenerate types and typecheck**

Run: `npm run db:types && npm run typecheck`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/0159_widget_installations.sql \
        supabase/tests/39_widget_installations.test.sql \
        src/lib/supabase/database.types.ts
git commit -m "feat(widget): one installation per station, and a key that is not a secret"
```

---

### Task 2: The two enum values

**Files:**
- Create: `supabase/migrations/0160_widget_enum_values.sql`
- Modify: `supabase/tests/39_widget_installations.test.sql` (plan 9 → 11)

**Interfaces:**
- Consumes: Task 1's migration ordering.
- Produces: `template_purpose.'WEB_VERIFICATION'`, `member_consent_type.'identification'`.

- [ ] **Step 1: Write the failing test**

Append to `supabase/tests/39_widget_installations.test.sql`, before `select * from finish();`, and change `select plan(9);` to `select plan(11);`:

```sql
-- 0110's own comment asked for this: "a later block adds a second rather than
-- renaming this one, because Task 4 references it by name." This is that block.
select ok(
  'WEB_VERIFICATION' = any(enum_range(null::public.template_purpose)::text[]),
  'the outbox can carry a verification template');

-- 0032 has three values and none of them is this one: `rules` is agreement to a
-- PROMOTION's rules, which is 17c's business, not identification's.
select ok(
  'identification' = any(enum_range(null::public.member_consent_type)::text[]),
  'and a listener can consent to being identified at all');
```

- [ ] **Step 2: Run it and verify it fails**

Run: `npm run db:test`
Expected: FAIL — both `ok` assertions false.

- [ ] **Step 3: Write the migration**

Create `supabase/migrations/0160_widget_enum_values.sql`:

```sql
-- supabase/migrations/0160_widget_enum_values.sql

-- Block 17a. TWO ADD VALUEs AND NOTHING ELSE IN THIS FILE.
--
-- The Postgres rule 0082, 0091 and 0151 each paid for: ALTER TYPE ... ADD VALUE
-- cannot share a transaction with a statement that USES the value. Separate
-- files are separate transactions. The two below may share this one because
-- neither uses the other's value; 0161 uses both, and is a separate file.

alter type public.template_purpose add value 'WEB_VERIFICATION';

alter type public.member_consent_type add value 'identification';

comment on type public.member_consent_type is
  'What a Member agreed to, or withdrew, at a Station. `rules` is agreement to a promotion''s rules; `identification` is Block 17a''s -- the basis for holding a name and a telephone number typed into a Station''s own website, recorded with origin = ''web-widget'' so an audit can tell it apart from a number that arrived over WhatsApp. Append-only since 0032: a withdrawal is a new row.';
```

- [ ] **Step 4: Run the test and verify it passes**

Run: `npm run db:reset && npm run db:test`
Expected: PASS — 11 of 11.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/0160_widget_enum_values.sql \
        supabase/tests/39_widget_installations.test.sql
git commit -m "feat(widget): the two enum values, alone in their transaction"
```

---

### Task 3: The verification table and the anon-callable lookup

**Files:**
- Create: `supabase/migrations/0161_widget_doors.sql` (first section)
- Create: `supabase/tests/40_widget_verification.test.sql`

**Interfaces:**
- Consumes: `widget_installations` (Task 1).
- Produces:
  - `public.widget_verifications` table.
  - `public.widget_frame_context(p_public_key text) returns jsonb` — `{"found": bool, "origins": text[]}`. `EXECUTE` granted to `anon` and `service_role`.

- [ ] **Step 1: Write the failing pgTAP test**

Create `supabase/tests/40_widget_verification.test.sql`:

```sql
begin;
select plan(6);

insert into public.organizations (id, name) values
  ('00000000-0000-0000-0000-000000000201', 'Org widget verify');
insert into public.companies (id, organization_id, name, timezone) values
  ('00000000-0000-0000-0000-000000000202', '00000000-0000-0000-0000-000000000201',
   'Station widget verify', 'America/Sao_Paulo');
insert into public.widget_installations
  (id, organization_id, company_id, public_key, enabled, allowed_origins)
values
  ('00000000-0000-0000-0000-000000000203',
   '00000000-0000-0000-0000-000000000201',
   '00000000-0000-0000-0000-000000000202',
   'pw_enabledkey012345678901', true, array['https://radio.com.br']);
insert into public.widget_installations
  (id, organization_id, company_id, public_key, enabled, allowed_origins)
values
  ('00000000-0000-0000-0000-000000000204',
   '00000000-0000-0000-0000-000000000201',
   (select id from public.companies where name = 'Station widget verify'),
   'pw_disabledkey012345678', false, array['https://off.radio.com.br']);

select has_table('public', 'widget_verifications', 'the verification table exists');

select is(
  (select count(*) from pg_policies
    where schemaname = 'public' and tablename = 'widget_verifications'),
  0::bigint, 'RLS on, no policy, like every other table holding a digest');

-- A raw code where a digest belongs is refused BY SHAPE, the backstop
-- api_credentials_hash_shape (0148) and webhook_events.external_id (0058)
-- already use.
select throws_ok($$
  insert into public.widget_verifications
    (organization_id, company_id, installation_id, phone, code_hash, expires_at)
  values ('00000000-0000-0000-0000-000000000201',
          '00000000-0000-0000-0000-000000000202',
          '00000000-0000-0000-0000-000000000203',
          '+5511999998888', '123456', now() + interval '10 minutes')$$,
  '23514', null, 'a six-digit code written where a sha256 belongs is refused');

-- The Edge middleware asks this, with the anon key, on a document request.
select is(
  public.widget_frame_context('pw_enabledkey012345678901'),
  jsonb_build_object('found', true, 'origins', jsonb_build_array('https://radio.com.br')),
  'an enabled key answers with its origins');

-- THE REFUSAL IS THE DEFAULT BRANCH. A disabled installation, an unknown key
-- and a deleted one all reach the same answer, and the middleware turns that
-- into frame-ancestors 'none' plus a 404.
select is(
  public.widget_frame_context('pw_disabledkey012345678'),
  jsonb_build_object('found', false, 'origins', '[]'::jsonb),
  'a disabled installation answers as if it did not exist');

select is(
  public.widget_frame_context('pw_nosuchkey01234567890'),
  jsonb_build_object('found', false, 'origins', '[]'::jsonb),
  'and so does a key nobody ever issued');

select * from finish();
rollback;
```

- [ ] **Step 2: Run it and verify it fails**

Run: `npm run db:test`
Expected: FAIL — `relation "public.widget_verifications" does not exist`.

- [ ] **Step 3: Write the first section of the migration**

Create `supabase/migrations/0161_widget_doors.sql`:

```sql
-- supabase/migrations/0161_widget_doors.sql

-- Block 17a, spec §6. The verification code, and the four doors the widget
-- reaches the database through.
--
-- THE WIDGET SESSION IS THE SUBJECT, not a borrowed auth.uid(). This is the
-- same principle Block 15's D1 argued for the API key, and it is here for the
-- same reason: a visitor on a radio station's website is not a member of
-- anything, has no role, and must never appear on the Team screen.

create table public.widget_verifications (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id),
  company_id      uuid not null,
  installation_id uuid not null references public.widget_installations (id) on delete cascade,
  -- Stored as given and normalised by the doors through normalize_phone (0031),
  -- so this can never disagree with members.phone_normalized, which is
  -- GENERATED from the same function.
  phone           text not null,
  code_hash       text not null,
  attempts        integer not null default 0,
  expires_at      timestamptz not null,
  consumed_at     timestamptz,
  created_at      timestamptz not null default now(),

  constraint widget_verifications_company_org_fk
    foreign key (company_id, organization_id)
    references public.companies (id, organization_id),

  -- The shape check that refuses a RAW code written where a digest belongs.
  -- A backstop, not a licence to relax the Node side: the code is hashed before
  -- it is passed, because an RPC argument lands in query logs and in backups --
  -- the rule the WhatsApp webhook already follows for the wamid.
  constraint widget_verifications_hash_shape
    check (code_hash ~ '^[0-9a-f]{64}$'),

  constraint widget_verifications_attempts_floor
    check (attempts >= 0)
);

create index widget_verifications_lookup_idx
  on public.widget_verifications (installation_id, phone, created_at desc);

comment on table public.widget_verifications is
  'One six-digit code sent to one telephone number for one installation. RLS on, no policy, reachable only from the SECURITY DEFINER doors below. Rows are not deleted on use -- consumed_at is stamped instead, so "was this number verified, and when" survives the session that used it. HOLDS A PHONE NUMBER, so sweep_retention (0131) is extended to delete it at 30 days: design D5 rejected a session table precisely because it would carry a retention obligation, and this table carrying one unswept would be that same hole with a different name.';

alter table public.widget_verifications enable row level security;
revoke all on public.widget_verifications from anon, authenticated;

-- ---------------------------------------------------------------------------
-- Door 1: what the Edge middleware asks before it renders the page.
--
-- GRANTED TO anon, which is the first SECURITY DEFINER body in this schema that
-- is. It is written to the standard that implies: it takes a public key and it
-- returns an origin list and a boolean. No Station name, no id, no count, no
-- error that distinguishes the three ways of not existing. What somebody can
-- learn by guessing keys is which keys exist -- which is exactly what a key in
-- an iframe src already tells them.
-- ---------------------------------------------------------------------------
create function public.widget_frame_context(p_public_key text)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select coalesce(
    (select jsonb_build_object(
              'found', true,
              'origins', to_jsonb(w.allowed_origins))
       from public.widget_installations w
      where w.public_key = p_public_key
        and w.enabled
        and w.deleted_at is null),
    jsonb_build_object('found', false, 'origins', '[]'::jsonb));
$$;

revoke execute on function public.widget_frame_context(text) from public;
grant execute on function public.widget_frame_context(text) to anon, service_role;

comment on function public.widget_frame_context(text) is
  'The origins one installation may be framed by, for the Edge middleware to build frame-ancestors from. Answers {"found": false, "origins": []} for an unknown key, a disabled installation and an archived one alike -- one answer for three causes, so probing learns nothing, and so the caller has exactly one refusal branch to get right. GRANTED TO anon deliberately (spec §4.3): the middleware holds the anon key and runs before any session exists.';
```

- [ ] **Step 4: Extend the retention sweep**

`widget_verifications` holds a telephone number, so it cannot sit outside retention. Append to `0161_widget_doors.sql` a `create or replace procedure public.sweep_retention()` that reproduces the shipped body from `supabase/migrations/0131_sweep_retention.sql` **exactly**, with one table added: `delete from public.widget_verifications where created_at < now() - interval '30 days';`, committed in its own statement like every other table there.

Read `0131` in full before writing this. It commits per table on purpose — one failure must not roll back the rest — and its comment enumerates every table and its period. Update that `comment on procedure` to name `widget_verifications` at 30 days; leaving the old comment would put a lie in the schema, and those cost the most later.

**Do not edit `0131` itself.** Migrations are append-only. `create or replace` in a new file is the mechanism.

The `cron.schedule` call is **not** repeated — the job already exists and points at the procedure by name, so replacing the body is the whole change.

Add to the pgTAP test:

```sql
-- D5 rejected a session table because it would carry a retention obligation.
-- A verifications table that holds a phone number and is never swept is that
-- same obligation, unmet.
select ok(
  (select prosrc from pg_proc where proname = 'sweep_retention')
    like '%widget_verifications%',
  'the retention sweep deletes verification rows too');
```

Change `select plan(6);` to `select plan(7);`.

- [ ] **Step 5: Run the test and verify it passes**

Run: `npm run db:reset && npm run db:test`
Expected: PASS — 7 of 7.

- [ ] **Step 6: Regenerate types**

Run: `npm run db:types && npm run typecheck`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add supabase/migrations/0161_widget_doors.sql \
        supabase/tests/40_widget_verification.test.sql \
        src/lib/supabase/database.types.ts
git commit -m "feat(widget): the verification table, the one question anon may ask, and its retention"
```

---

### Task 4: Requesting a code

**Files:**
- Modify: `supabase/migrations/0161_widget_doors.sql` (append)
- Modify: `supabase/tests/40_widget_verification.test.sql` (plan 6 → 10)

**Interfaces:**
- Consumes: `widget_frame_context`, `widget_verifications`, `enqueue_whatsapp_outbound(uuid, text, text, jsonb, text, public.template_purpose, jsonb)` (0111).
- Produces: `public.widget_request_code(p_public_key text, p_phone text, p_code_hash text, p_code_plain text, p_ttl_seconds integer default 600) returns jsonb` → `{"ok": bool, "reason": text|null, "verification_id": uuid|null}`. `EXECUTE` to `service_role` only.

**Two notes for the implementer, both load-bearing.**

**This door does not rate-limit.** Rate limiting lives in the server action with `PostgresRateLimiter` (Task 10), because the limits in spec §6.3 are keyed by IP as well as by phone, and the database has no idea what an IP is.

**`p_code_plain` is a deliberate, bounded exception to a rule this codebase otherwise holds absolutely**, and the migration must say so in a comment or somebody will "fix" it. The rule — stated in `src/lib/api/credentials.ts:26-30` and followed by the WhatsApp webhook for the `wamid` — is that a raw secret never travels as an RPC argument, because an argument lands in query logs and in backups. Here it must: the message is sent by the worker draining `outbox_messages`, the outbox is *in* the database, so the six digits have to get there. What the rule actually protects is the **stored credential**, and that property is kept whole — `widget_verifications` holds only the SHA-256, so a database dump yields no usable code. The plaintext exists in exactly one place, `outbox_messages.template_variables`, where 0059's retention already prunes it, and it is worthless ten minutes later or after one use. That is a different risk class from an API key with no expiry, which is why the same rule gives a different answer here.

- [ ] **Step 1: Write the failing test**

Append to `supabase/tests/40_widget_verification.test.sql`, before `finish()`, and change `plan(6)` to `plan(10)`:

```sql
-- A Station with no WhatsApp integration cannot send anything, and saying so
-- here is what stops the console showing an enabled widget that silently never
-- delivers a code.
select is(
  public.widget_request_code('pw_enabledkey012345678901', '+5511999998888',
                             repeat('a', 64), '123456') ->> 'reason',
  'no_integration', 'without a WhatsApp integration the door refuses, by name');

insert into public.integrations
  (id, organization_id, company_id, provider, phone_number_id, waba_id, display_phone_number)
values
  ('00000000-0000-0000-0000-000000000205',
   '00000000-0000-0000-0000-000000000201',
   '00000000-0000-0000-0000-000000000202',
   'WHATSAPP', '111222333', '444555666', '+551130000000');

select is(
  public.widget_request_code('pw_enabledkey012345678901', '+5511999998888',
                             repeat('a', 64), '123456') ->> 'reason',
  'no_template', 'and without an approved template it still refuses, differently');

insert into public.message_templates
  (organization_id, company_id, purpose, name, language, body, variables)
values
  ('00000000-0000-0000-0000-000000000201',
   '00000000-0000-0000-0000-000000000202',
   'WEB_VERIFICATION', 'web_verification', 'pt_BR',
   'Seu codigo e {{1}}.', '["code"]'::jsonb);

select is(
  public.widget_request_code('pw_enabledkey012345678901', '+5511999998888',
                             repeat('a', 64), '123456') ->> 'ok',
  'true', 'with both in place the code is enqueued');

-- The message left through the outbox rather than from the request path (D8):
-- outbox_messages already carries the dedupe key that collapses a double click,
-- already has the retention story for a phone number in the clear, and already
-- retries.
select is(
  (select count(*) from public.outbox_messages
    where template_name = 'web_verification'),
  1::bigint, 'and it left as a template row on the existing outbox');
```

- [ ] **Step 2: Run it and verify it fails**

Run: `npm run db:test`
Expected: FAIL — `function public.widget_request_code(...) does not exist`.

- [ ] **Step 3: Append the door to the migration**

```sql
-- ---------------------------------------------------------------------------
-- Door 2: mint a verification. The CODE ITSELF NEVER ARRIVES HERE -- only its
-- SHA-256, hashed in Node. An RPC argument lands in query logs and in backups,
-- which is the rule the WhatsApp webhook already follows for the wamid, and it
-- matters more for six digits than for a 256-bit token: a code in a log is a
-- code somebody can still use for the next ten minutes.
--
-- THE REFUSALS ARE NAMED, and that is what the console tab reads to warn an
-- operator (spec §5). "It did not work" would leave a Station enabled and
-- silent, with the failure surfacing to a listener staring at an empty box.
-- ---------------------------------------------------------------------------
create function public.widget_request_code(
  p_public_key   text,
  p_phone        text,
  p_code_hash    text,
  p_code_plain   text,
  p_ttl_seconds  integer default 600
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_install    public.widget_installations;
  v_integration uuid;
  v_template   public.message_templates;
  v_id         uuid;
begin
  select * into v_install
    from public.widget_installations
   where public_key = p_public_key and enabled and deleted_at is null;

  if not found then
    return jsonb_build_object('ok', false, 'reason', 'unknown_installation',
                              'verification_id', null);
  end if;

  select id into v_integration
    from public.integrations
   where company_id = v_install.company_id
     and provider = 'WHATSAPP'
     and deleted_at is null;

  if not found then
    return jsonb_build_object('ok', false, 'reason', 'no_integration',
                              'verification_id', null);
  end if;

  select * into v_template
    from public.message_templates
   where company_id = v_install.company_id
     and purpose = 'WEB_VERIFICATION'
     and deleted_at is null;

  if not found then
    return jsonb_build_object('ok', false, 'reason', 'no_template',
                              'verification_id', null);
  end if;

  insert into public.widget_verifications
    (organization_id, company_id, installation_id, phone, code_hash, expires_at)
  values
    (v_install.organization_id, v_install.company_id, v_install.id,
     p_phone, p_code_hash,
     now() + make_interval(secs => p_ttl_seconds))
  returning id into v_id;

  -- The dedupe key is the VERIFICATION, not the phone: two codes legitimately
  -- requested a minute apart are two messages, and collapsing them on the
  -- number would silently drop the second -- leaving a visitor typing a code
  -- that was superseded.
  perform public.enqueue_whatsapp_outbound(
    v_integration,
    p_phone,
    -- The rendered words, for the operator question "what were they actually
    -- sent" once retention has pruned the number (0059's reasoning for why
    -- `body` is NOT NULL and not pruned).
    replace(v_template.body, '{{1}}', '******'),
    null,
    v_id::text || ':widget-verification',
    'WEB_VERIFICATION',
    -- THE ONLY PLACE THE SIX DIGITS EXIST outside the visitor's handset. The
    -- worker substitutes them into the approved body at send time. See the
    -- header comment on this function for why the raw value is an argument here
    -- when it is forbidden everywhere else in this codebase.
    jsonb_build_array(p_code_plain));

  return jsonb_build_object('ok', true, 'reason', null, 'verification_id', v_id);
end;
$$;

revoke execute on function public.widget_request_code(text, text, text, text, integer) from public;
grant execute on function public.widget_request_code(text, text, text, text, integer) to service_role;
```

The `body` written above is the rendered text with the code **masked** — `replace(v_template.body, '{{1}}', '******')`. That column is not pruned (0059 keeps it deliberately, so an operator can still answer "what were they told" after the number is gone), so putting the live code in it would outlive every mechanism meant to expire it.

- [ ] **Step 4: Run the test and verify it passes**

Run: `npm run db:reset && npm run db:test`
Expected: PASS — 10 of 10.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/0161_widget_doors.sql supabase/tests/40_widget_verification.test.sql
git commit -m "feat(widget): mint a verification, and name every reason it cannot"
```

---

### Task 5: Verifying a code, and identifying the listener

**Files:**
- Modify: `supabase/migrations/0161_widget_doors.sql` (append)
- Modify: `supabase/tests/40_widget_verification.test.sql` (plan 12 → 19)

**Interfaces:**
- Consumes: `apply_member_lookup(uuid, text, text, text, text) returns uuid`, `apply_member_creation(...) returns uuid`, `apply_member_link(uuid, uuid, uuid, uuid) returns boolean` (all 0061).
- Produces: `public.widget_verify_code(p_public_key text, p_phone text, p_code_hash text, p_name text default null) returns jsonb` → `{"ok": bool, "reason": text|null, "member_id": uuid|null, "company_id": uuid|null, "organization_id": uuid|null}`. `EXECUTE` to `service_role`.

- [ ] **Step 1: Write the failing test**

Append to `supabase/tests/40_widget_verification.test.sql`, before `finish()`, changing `plan(12)` to `plan(19)`:

```sql
-- The ceiling, and what it is actually for. A six-digit code is 10^6, so
-- guessing is only expensive if guessing is limited -- which is the whole
-- reason there is no constant-time comparison anywhere near this (0148's
-- credentials.ts comment gives the general argument; this is the sharp case).
select is(
  public.widget_verify_code('pw_enabledkey012345678901', '+5511999998888',
                            repeat('b', 64)) ->> 'reason',
  'wrong_code', 'a wrong code is refused');

select is(
  (select attempts from public.widget_verifications
    where phone = '+5511999998888' order by created_at desc limit 1),
  1, 'and the attempt is counted');

select lives_ok($$
  select public.widget_verify_code('pw_enabledkey012345678901', '+5511999998888',
                                   repeat('b', 64))
    from generate_series(1, 4)$$,
  'four more wrong guesses are survivable');

select is(
  public.widget_verify_code('pw_enabledkey012345678901', '+5511999998888',
                            repeat('a', 64)) ->> 'reason',
  'too_many_attempts', 'and the RIGHT code is refused once the ceiling is hit');

-- A fresh verification, to prove the happy path and the listener it creates.
select public.widget_request_code('pw_enabledkey012345678901', '+5511999997777',
                                  repeat('c', 64), '654321');

select is(
  public.widget_verify_code('pw_enabledkey012345678901', '+5511999997777',
                            repeat('c', 64), 'Maria Silva') ->> 'ok',
  'true', 'the right code identifies the visitor');

-- Resolved through the 0061 cores, the same three the WhatsApp door and the
-- Block 15 API door use. Nothing new decides who a listener is.
select is(
  (select count(*) from public.member_company_links l
     join public.members m on m.id = l.member_id
    where m.phone_normalized = public.normalize_phone('+5511999997777')
      and l.company_id = '00000000-0000-0000-0000-000000000202'),
  1::bigint, 'the listener exists and is linked to this Station');

select is(
  (select count(*) from public.member_consents c
     join public.members m on m.id = c.member_id
    where m.phone_normalized = public.normalize_phone('+5511999997777')
      and c.consent_type = 'identification'
      and c.origin = 'web-widget'),
  1::bigint, 'and their consent to being identified is on the record');

select * from finish();
```

- [ ] **Step 2: Run it and verify it fails**

Run: `npm run db:test`
Expected: FAIL — `function public.widget_verify_code(...) does not exist`.

- [ ] **Step 3: Append the door**

Write `widget_verify_code` in `0161_widget_doors.sql`. It must, in one transaction and in this order:

1. Resolve the installation by `p_public_key` (enabled, not deleted) → `unknown_installation`.
2. Take the newest unconsumed verification for `(installation, phone)`. None → `no_pending_code`.
3. `expires_at <= now()` → `expired`.
4. `attempts >= 5` → `too_many_attempts`, **checked before the hash is compared**, so a burned row cannot be unlocked by finally guessing right.
5. `code_hash <> p_code_hash` → increment `attempts`, return `wrong_code`.
6. Stamp `consumed_at`.
7. `apply_member_lookup(org, p_phone, null, null, null)`. Found and `anonymized_at is not null` → `listener_anonymized`, with nothing written. Recording fresh activity against somebody who exercised erasure is precisely what the erasure was for.
8. Not found → `p_name` is required (`name_required`); create through `apply_member_creation` with `p_first_contact_origin = 'web-widget'`.
9. `apply_member_link(member, company, org, null)`.
10. Insert the `member_consents` row: `consent_type = 'identification'`, `granted = true`, `origin = 'web-widget'`, `recorded_by = null`.
11. Return `ok` with the member, company and organization ids.

`actor`/`recorded_by` is **null throughout**, and the migration must say why in a comment: `audit_logs.actor_id` has been nullable since 0004 for exactly this class of caller, and 0129 states in writing that a null there does not mean "the system did it". A visitor on a website is not an `auth.users` row and must never become one.

Grant `EXECUTE` to `service_role` only, and `revoke ... from public` first.

- [ ] **Step 4: Run the test and verify it passes**

Run: `npm run db:reset && npm run db:test`
Expected: PASS — 17 of 17.

- [ ] **Step 5: Regenerate types**

Run: `npm run db:types && npm run typecheck`

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/0161_widget_doors.sql supabase/tests/40_widget_verification.test.sql \
        src/lib/supabase/database.types.ts
git commit -m "feat(widget): the code that identifies a visitor, and the ceiling that guards it"
```

---

### Task 6: The console doors

**Files:**
- Create: `supabase/migrations/0162_widget_console.sql`
- Modify: `supabase/tests/39_widget_installations.test.sql` (plan 11 → 15)

**Interfaces:**
- Produces:
  - `public.upsert_widget_installation(p_company_id uuid, p_public_key text, p_enabled boolean, p_allowed_origins text[]) returns uuid`
  - `public.widget_installation_for(p_company_id uuid) returns jsonb`

  Both gated on `is_platform_admin()`, `EXECUTE` to `authenticated`.

- [ ] **Step 1: Write the failing test**

Append four assertions to `supabase/tests/39_widget_installations.test.sql`: that an unauthenticated caller gets `42501` from each door (`throws_ok` with `'42501'`), that `upsert_widget_installation` creates a row on first call, and that a second call for the same Station updates rather than duplicating — the partial unique index from Task 1 is what makes that a design guarantee and not a race.

Follow `33_api_credentials.test.sql:` the tail of that file shows the exact `throws_ok($$ select public.issue_api_credential(...) $$, '42501', null, '...')` shape for a platform-admin gate.

- [ ] **Step 2: Run it and verify it fails**

Run: `npm run db:test`
Expected: FAIL — the functions do not exist.

- [ ] **Step 3: Write the migration**

Both doors are `SECURITY DEFINER`, `set search_path = pg_catalog, public`, and open with:

```sql
if not public.is_platform_admin() then
  raise exception 'permission denied: platform admin required' using errcode = '42501';
end if;
```

`upsert_widget_installation` writes **every field on every call, never merged** — the house convention `update_prize`, `update_role`, `update_song` and `update_company_profile` all follow. The public key is generated in Node (Task 7) and passed in; the database does not mint secrets, matching `issue_api_credential` (0149).

`widget_installation_for` returns the row plus a `has_template` boolean, computed from `message_templates` for purpose `WEB_VERIFICATION`. That boolean is what the console tab's warning line reads (spec §5) — computing it here rather than in a second query means the tab cannot show an enabled widget and a missing template out of sync.

- [ ] **Step 4: Run the test and verify it passes**

Run: `npm run db:reset && npm run db:test`

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/0162_widget_console.sql supabase/tests/39_widget_installations.test.sql \
        src/lib/supabase/database.types.ts
git commit -m "feat(widget): the console doors, and the warning the tab reads"
```

---

### Task 7: Code generation, hashing, and the visitor session

**Files:**
- Create: `src/lib/widget/code.ts`, `src/lib/widget/session.ts`
- Create: `tests/unit/widget-code.test.ts`, `tests/unit/widget-session.test.ts`
- Modify: `src/lib/env.ts`

**Interfaces:**
- Produces:
  - `generateCode(): string` — six digits, `crypto.randomInt`.
  - `hashCode(code: string): string` — sha256 lowercase hex.
  - `generatePublicKey(): string` — `pw_` + 16 random bytes base64url (22 chars).
  - `mintSession(claims: WidgetClaims, secret: string): string` — **two parameters, no clock.** `exp` arrives inside `claims` and must not be overridden, so a `now` here would have nothing to compute and would fail this repo's `no-unused-vars` lint. Only `readSession` needs a clock, to judge expiry.
  - `readSession(token: string, secret: string, now?: number): WidgetClaims | null`
  - `interface WidgetClaims { installationId: string; companyId: string; organizationId: string; memberId: string; phone: string; exp: number }`
  - `WIDGET_SESSION_COOKIE = 'pw_session'`, `WIDGET_SESSION_SECONDS = 1800`

- [ ] **Step 1: Write the failing tests**

`tests/unit/widget-session.test.ts` must cover, at minimum:

```ts
import { describe, expect, it } from 'vitest';
import { mintSession, readSession, type WidgetClaims } from '@/lib/widget/session';

const SECRET = 'a'.repeat(48);
const claims: WidgetClaims = {
  installationId: '11111111-1111-1111-1111-111111111111',
  companyId: '22222222-2222-2222-2222-222222222222',
  organizationId: '33333333-3333-3333-3333-333333333333',
  memberId: '44444444-4444-4444-4444-444444444444',
  phone: '+5511999998888',
  exp: 2_000_000_000,
};

describe('the visitor session', () => {
  it('round-trips its own token', () => {
    expect(readSession(mintSession(claims, SECRET), SECRET)).toEqual(claims);
  });

  // The whole point of signing it. Without this assertion the session is a
  // base64 blob a visitor can edit into somebody else's Station.
  it('refuses a token whose payload was edited', () => {
    const token = mintSession(claims, SECRET);
    const [payload, signature] = token.split('.');
    const tampered = Buffer.from(
      Buffer.from(payload, 'base64url').toString('utf8').replace(claims.companyId, claims.organizationId),
      'utf8',
    ).toString('base64url');
    expect(readSession(`${tampered}.${signature}`, SECRET)).toBeNull();
  });

  it('refuses a token signed with a different secret', () => {
    expect(readSession(mintSession(claims, SECRET), 'b'.repeat(48))).toBeNull();
  });

  it('refuses an expired token', () => {
    expect(readSession(mintSession(claims, SECRET), SECRET, 2_000_000_001_000)).toBeNull();
  });

  it('refuses a token that is not two parts', () => {
    expect(readSession('nonsense', SECRET)).toBeNull();
  });
});
```

`tests/unit/widget-code.test.ts` asserts `generateCode()` is exactly six digits over 500 draws (including leading zeros — `'000123'` is a valid code and a `String(randomInt(0, 999999))` implementation silently produces five-digit codes about 10% of the time), that `hashCode` matches a known SHA-256 vector, and that `generatePublicKey()` satisfies the `^pw_[A-Za-z0-9_-]{22}$` CHECK from Task 1.

- [ ] **Step 2: Run and verify they fail**

Run: `npx vitest run tests/unit/widget-session.test.ts tests/unit/widget-code.test.ts`
Expected: FAIL — cannot resolve `@/lib/widget/session`.

- [ ] **Step 3: Implement**

`session.ts` uses `createHmac('sha256', secret)` over the base64url payload and compares with `timingSafeEqual`.

**This one IS a constant-time comparison, and the comment must say why it differs from `src/lib/api/credentials.ts:41`.** There, what arrives is hashed and what is stored is a hash, so the lookup is an indexed equality over a digest. Here a caller supplies a token and we compare a computed MAC against the one they sent — a secret-to-secret comparison against a value an attacker varies freely, which is exactly the case `/api/worker/tick`'s `secretMatches` exists for. Guard the length first: `timingSafeEqual` throws on a mismatch, which would leak the length through an exception.

Add to `src/lib/env.ts`: `WIDGET_SESSION_SECRET: z.string().min(32).optional()`. Optional, following `WORKER_TICK_SECRET` — an installation with no widget must still boot. The route handlers refuse with a 503 when it is absent, the way the tick does.

- [ ] **Step 4: Run and verify they pass**

Run: `npx vitest run tests/unit/widget-session.test.ts tests/unit/widget-code.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/widget/ tests/unit/widget-code.test.ts tests/unit/widget-session.test.ts src/lib/env.ts
git commit -m "feat(widget): six digits, a digest, and a session that cannot be edited"
```

---

### Task 8: The origin allowlist and the CSP builder

**Files:**
- Create: `src/lib/widget/origins.ts`, `tests/unit/widget-origins.test.ts`
- Modify: `src/lib/security/csp.ts:15-72`
- Create: `tests/unit/csp-frame-ancestors.test.ts`

**`buildContentSecurityPolicy` already has unit tests** at `tests/unit/security/csp.test.ts` (11 of them, from Blocks 11b and 13a) — note the `security/` subdirectory, which a non-recursive `ls tests/unit` misses. Those tests are the load-bearing proof that the new parameter's default leaves every existing caller correct: they must keep passing UNMODIFIED. Needing to edit them means the default is wrong.

**Interfaces:**
- Produces:
  - `parseOrigins(input: string): { ok: true; origins: string[] } | { ok: false; bad: string }` — splits on newline/comma, trims, validates each against `^https?:\/\/[A-Za-z0-9.-]+(:\d{1,5})?$`.
  - `frameAncestorsValue(origins: string[]): string` — `"'none'"` for an empty list, otherwise the origins joined by a space.
  - `buildContentSecurityPolicy(nonce, supabaseUrl, isDev, frameAncestors = "'none'")` — the new fourth parameter.

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, it } from 'vitest';
import { frameAncestorsValue, parseOrigins } from '@/lib/widget/origins';
import { buildContentSecurityPolicy } from '@/lib/security/csp';

describe('the origin allowlist', () => {
  it('accepts a host with a scheme, and a port', () => {
    expect(parseOrigins('https://radio.com.br\nhttp://localhost:3000')).toEqual({
      ok: true,
      origins: ['https://radio.com.br', 'http://localhost:3000'],
    });
  });

  // A trailing slash never matches what a browser sends, and the failure is
  // "the widget does not load" -- which nothing logs and no screen shows.
  it('names the entry it refused', () => {
    expect(parseOrigins('https://radio.com.br/')).toEqual({
      ok: false,
      bad: 'https://radio.com.br/',
    });
  });

  // THE REFUSAL IS THE DEFAULT. An empty list means nowhere, and the one thing
  // this function must never do is turn "unconfigured" into "anywhere".
  it('turns an empty list into none, never into a wildcard', () => {
    expect(frameAncestorsValue([])).toBe("'none'");
  });
});

describe('the policy', () => {
  it('still refuses framing when nobody passes an allowlist', () => {
    const policy = buildContentSecurityPolicy('n0nce', 'https://x.supabase.co', false);
    expect(policy).toContain("frame-ancestors 'none'");
  });

  it('names the origins it was given', () => {
    const policy = buildContentSecurityPolicy(
      'n0nce', 'https://x.supabase.co', false, 'https://radio.com.br',
    );
    expect(policy).toContain('frame-ancestors https://radio.com.br');
    expect(policy).not.toContain("frame-ancestors 'none'");
  });
});
```

- [ ] **Step 2: Run and verify they fail**

Run: `npx vitest run tests/unit/widget-origins.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

In `csp.ts`, change the signature to take `frameAncestors: string = "'none'"` and replace line 69's literal with the parameter. **Keep the existing comment and extend it** — it currently says the directive agrees with `X-Frame-Options: DENY` in `next.config.mjs`, and after Task 9 that is only true for paths outside `/w/`. A comment that stops being true is worse than no comment; rewrite it to say that the two agree everywhere except the one route whose header source excludes it, and name that route.

The default argument is what keeps every existing caller correct without touching them, and is the reason the first CSP test above passes unchanged.

- [ ] **Step 4: Run the full unit suite**

Run: `npm test`
Expected: PASS — including the pre-existing CSP tests, unmodified.

- [ ] **Step 5: Commit**

```bash
git add src/lib/widget/origins.ts src/lib/security/csp.ts tests/unit/widget-origins.test.ts
git commit -m "feat(widget): the policy learns one route may be framed, and by whom"
```

---

### Task 9: The middleware branch and the header exception

**Files:**
- Modify: `src/middleware.ts` (a branch immediately after the `/` redirect at line 95-97)
- Modify: `next.config.mjs:103`
- Create: `tests/e2e/widget-headers.spec.ts`

**Interfaces:**
- Consumes: `widget_frame_context` (Task 3), `frameAncestorsValue` (Task 8).
- Produces: `/w/<key>` served with a per-Station `frame-ancestors` and no `X-Frame-Options`.

- [ ] **Step 1: Write the failing e2e test**

`tests/e2e/widget-headers.spec.ts` asserts, against a seeded enabled installation:

1. `GET /w/<key>` carries **no** `x-frame-options` header.
2. Its CSP contains `frame-ancestors https://radio.com.br` and not `'none'`.
3. `GET /app` still carries `X-Frame-Options: DENY` and `frame-ancestors 'none'` — the exception did not leak.
4. `GET /w/<unknown key>` answers 404 and `frame-ancestors 'none'`.

Point 3 is the one that matters most and is the reason this is an e2e rather than a unit test: the header source regex is applied by Next, not by any function a unit test can call. `tests/e2e/headers.spec.ts` already asserts the five static headers — read it for the request-level assertion style before writing this.

- [ ] **Step 2: Run and verify it fails**

Run: `npx playwright test tests/e2e/widget-headers.spec.ts`
Expected: FAIL — `/w/<key>` 404s and still carries `X-Frame-Options: DENY`.

- [ ] **Step 3: Change the header source**

`next.config.mjs:103`: `source: '/:path*'` becomes `source: '/((?!w/).*)'`.

Add a comment above it. It must say that `X-Frame-Options` **cannot be relaxed by a later, more specific entry** — Next applies every matching entry and the browser obeys the strictest — so exclusion is the only mechanism, and that the excluded route sets its own `frame-ancestors` from the database in the middleware. Without that sentence the next person adds a second `headers()` entry for `/w/:path*`, ships a widget that frames nowhere, and debugs a browser.

- [ ] **Step 4: Add the middleware branch**

Immediately after the `/` redirect (`middleware.ts:95-97`), and **before `createServerClient` is called** — the same placement and the same reason the `/` branch gives: an anonymous visitor must not pay a `getUser()` round trip whose answer is discarded.

```ts
// Block 17a, spec §4.3. The one route in this product that may be framed.
//
// HERE, above the Supabase client, for the reason the `/` branch above gives:
// a visitor on a radio station's website has no session and never will, so
// getUser() would be a round trip whose answer is thrown away -- paid on every
// widget load, by every listener.
//
// Document requests only. The server action POSTs from inside the frame carry
// no framing question, and making them pay this lookup would put a database
// round trip in front of every keystroke's worth of form submission.
if (request.nextUrl.pathname.startsWith('/w/')) {
  const isDocument =
    request.method === 'GET' &&
    (request.headers.get('accept') ?? '').includes('text/html');

  const ancestors = isDocument
    ? frameAncestorsValue(await frameOrigins(request.nextUrl.pathname.split('/')[2] ?? ''))
    : "'none'";

  const policy = buildContentSecurityPolicy(
    nonce,
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NODE_ENV !== 'production',
    ancestors,
  );
  const built = NextResponse.next({ request: { headers: forwarded() } });
  built.headers.set('Content-Security-Policy', policy);
  return built;
}
```

`frameOrigins` is a module-scope function in `src/lib/widget/frame-cache.ts` holding a `Map<string, { origins: string[]; at: number }>` with a 60-second TTL (D6). It calls `widget_frame_context` through a plain `fetch` to `${SUPABASE_URL}/rest/v1/rpc/widget_frame_context` with the anon key — `supabase-js` is not used here because this runs on the Edge and one `fetch` is the whole requirement.

**Its catch branch returns `[]`.** A cache miss that cannot reach the database must not fall open: the refusal is the default branch, reached by every path that is not a successful lookup. Write that as a comment, because it is the line a later "let's make this resilient" change would delete.

**Harden `frameAncestorsValue` before you call it.** Task 8 shipped it guarding only `origins.length === 0`, which was sufficient there because its only producer was `parseOrigins` and that cannot emit a blank element. You are about to become a second producer, fed by an HTTP response rather than by a validated form — so an array like `['']` becomes reachable, and it would emit a `frame-ancestors` directive with no value rather than `'none'`. Add a guard that treats any falsy element as the empty case, and a test for it in `tests/unit/widget-origins.test.ts`. This is one line, on the one path in this product where falling open means every widget is embeddable from anywhere with nothing on any screen to say so.

The 60-second TTL cuts both ways and the comment must say so: an origin just **added** may not frame for a minute (harmless), and one just **removed** may keep framing for a minute (a real, bounded window). Sixty seconds is the number precisely because of the second sentence.

- [ ] **Step 5: Run the e2e test and verify it passes**

Run: `npx playwright test tests/e2e/widget-headers.spec.ts`
Expected: PASS, all four assertions.

- [ ] **Step 6: Run the full e2e suite**

Run: `npm run test:e2e`
Expected: PASS — `headers.spec.ts` and `csp.spec.ts` especially, which is how you learn the exception did not leak.

- [ ] **Step 7: Commit**

```bash
git add src/middleware.ts next.config.mjs src/lib/widget/frame-cache.ts tests/e2e/widget-headers.spec.ts
git commit -m "feat(widget): one route may be framed, and only by the origins its station named"
```

---

### Task 10: The widget page and its two server actions

**Files:**
- Create: `src/app/(widget)/layout.tsx`, `src/app/(widget)/w/[publicKey]/page.tsx`, `actions.ts`, `identify-form.tsx`, `menu.tsx`
- Create: `src/schemas/widget.ts`
- Modify: `messages/en.json`, `messages/pt.json`, `messages/es.json`

**Interfaces:**
- Consumes: `widget_request_code`, `widget_verify_code`, `mintSession`, `readSession`, `generateCode`, `hashCode`, `PostgresRateLimiter`.
- Produces: the page at `/w/<publicKey>`.

- [ ] **Step 1: Write the schemas and their failing tests**

`src/schemas/widget.ts`, strict, following `src/schemas/api.ts`:

```ts
export const identifySchema = z.object({
  phone: z.string().trim().min(5).max(40),
  name: z.string().trim().min(1).max(200),
}).strict();

export const verifySchema = z.object({
  phone: z.string().trim().min(5).max(40),
  name: z.string().trim().min(1).max(200),
  code: z.string().trim().regex(/^\d{6}$/, 'a code is six digits'),
}).strict();
```

Test in `tests/unit/widget-schemas.test.ts` that a five-digit code, a seven-digit code and `'12 34 56'` are all refused, and that a leading-zero code `'000123'` is accepted — the case an implementer's `Number()` would silently destroy.

- [ ] **Step 2: Run and verify they fail**

Run: `npx vitest run tests/unit/widget-schemas.test.ts`

- [ ] **Step 3: Implement the actions**

`actions.ts` holds two server actions. Both:

- Refuse with a 503-equivalent when `env.WIDGET_SESSION_SECRET` is absent, the way `/api/worker/tick` refuses without its secret: a deployment fault is not a caller fault.
- Rate-limit through `new PostgresRateLimiter(createServiceClient())` before doing anything else. **Spec §6.3, and this is the endpoint that spends the Station's money:** `widget:code:phone:<normalised>` at 1/60s and 5/3600s, `widget:code:ip:<ip>` at 10/3600s, `widget:code:station:<companyId>` at the Station ceiling. The IP comes from `x-forwarded-for`'s first entry, the way `src/app/(public)/contato/page.tsx:32` already reads it.
- Never return the raw code, and never log it.

`requestCode` generates the code, hashes it, calls `widget_request_code` with **both** the hash and the plaintext (the plaintext reaches only the outbox row — see Task 4's implementer note), and returns the named refusal or success. `verifyCode` hashes the submitted code, calls `widget_verify_code`, and on success writes the session cookie:

```ts
cookieStore.set(WIDGET_SESSION_COOKIE, mintSession(claims, secret), {
  httpOnly: true,
  secure: true,
  sameSite: 'none',
  partitioned: true,
  path: '/w',
  maxAge: WIDGET_SESSION_SECONDS,
});
```

**Both `sameSite: 'none'` and `partitioned: true` are load-bearing and need the comment saying so.** A `lax` cookie is not sent inside a third-party iframe at all, so the widget would identify a visitor and then not know them on the next click — which reads as this product being broken rather than as a cookie policy. Without `partitioned`, Chrome's removal of unpartitioned third-party cookies takes the widget with it, in a browser release rather than a deployment.

- [ ] **Step 4: Implement the page**

`page.tsx` reads the cookie. No valid session → `identify-form.tsx` (phone + name, then the code box). Valid session → `menu.tsx`, two buttons, both `disabled` with a `title` naming the block that will enable them.

`layout.tsx` draws no application chrome: no nav, no locale switcher, no footer. It sets `<html>` background to transparent so the Station's own page shows through, and the body to `max-width: 28rem`.

Every string through `next-intl`, in all three message files.

- [ ] **Step 5: Run the suite**

Run: `npm run lint && npm run typecheck && npm test`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add "src/app/(widget)" src/schemas/widget.ts tests/unit/widget-schemas.test.ts messages/
git commit -m "feat(widget): the page a listener on a station's own site actually sees"
```

---

### Task 11: The console Widget tab

**Files:**
- Create: `src/app/(admin)/admin/stations/widget-tab.tsx`
- Create: `src/services/widget-installations.ts`
- Modify: `src/lib/record-params.ts:99`, `station-record-dialog.tsx`, `actions.ts`, `messages/*.json`

- [ ] **Step 1: Extend `STATION_TABS`**

`src/lib/record-params.ts:99`: `['data', 'whatsapp', 'keys']` becomes `['data', 'whatsapp', 'keys', 'widget']`. The dialog's strip already maps over the tuple (`station-record-dialog.tsx:105`), so this costs an entry and a label rather than a rewrite — which is what that file's sibling comment predicted for exactly this case.

- [ ] **Step 2: Write the service**

`src/services/widget-installations.ts`, modelled on `src/services/api-credentials.ts`. It uses `asCaller(accessToken)` — a client bound to the caller's JWT, **not** the service key — because the console RPCs re-check `is_platform_admin()` against `auth.uid()`, and calling them with the service key would defeat the very check they exist to make. Copy that reasoning into a comment; `api-credentials.ts:9-14` has the wording.

`generatePublicKey()` (Task 7) is called here on first save, never in the database — matching `issue_api_credential`, where the secret is generated in Node and only its digest travels.

- [ ] **Step 3: Write the tab**

Enable/disable, a textarea of origins parsed by `parseOrigins` with the refused entry named back to the operator, the public key shown and copyable, and the `<iframe>` snippet.

**The warning line, spec §5:** when `has_template` from `widget_installation_for` is false, the tab says so and says where to fix it — the Templates screen, purpose `WEB_VERIFICATION`. Without it the console shows an enabled widget that will never send a code, and the failure surfaces to a listener rather than to an operator.

- [ ] **Step 4: Run the suite**

Run: `npm run lint && npm run typecheck && npm test`

- [ ] **Step 5: Commit**

```bash
git add "src/app/(admin)/admin/stations" src/services/widget-installations.ts src/lib/record-params.ts messages/
git commit -m "feat(widget): the console configures it, and says when it cannot work"
```

---

### Task 12: The cross-origin journey and the isolation test

**Files:**
- Create: `tests/e2e/widget.spec.ts`, `tests/isolation/widget.test.ts`

**Do not modify `scripts/seed-demo.mjs`.** The journey creates its own installation through `upsert_widget_installation` (Task 6) in a `beforeAll`, and tears it down after. This is not only to avoid a file that has uncommitted work in it: a test that depends on the demo dataset breaks the day somebody changes the demo, with nothing in the diff to explain why.

- [ ] **Step 1: Write the isolation test**

`tests/isolation/widget.test.ts`, following `tests/isolation/api-intake.test.ts` and its `harness.ts`: a session minted for Station A, replayed against Station B's public key, writes nothing into B. Assert on row counts in `members`, `member_company_links` and `member_consents` scoped to B.

**Add a second test to the same file: the attempt ceiling under real concurrency.**

`widget_verify_code` (Task 5) takes the verification row `for update` so that the read, the ceiling check and the increment serialise. Without it, N concurrent requests each read the same pre-increment `attempts` and every one of them gets a guess — which would make the design spec's §6.1 claim false, since the ceiling and the ten-minute expiry are the whole of a six-digit code's protection.

**That clause currently has no test in any harness, and pgTAP structurally cannot give it one** — `supabase test db` runs each file as a single session inside one `begin;`/`rollback;`, so the lock never contends with itself and the clause is invisible whether present or absent. This suite can: it talks to the database over the network and can open two connections.

Issue one code, then fire ten wrong guesses concurrently with `Promise.all`, and assert that `attempts` lands at exactly the ceiling rather than at ten. Deleting the `for update` from `0161` must turn this test red — check that by actually deleting it locally, running the test, and putting it back. A concurrency test that passes with the lock removed is testing nothing, and this is the one gate that can tell the difference.

- [ ] **Step 2: Write the e2e journey**

`tests/e2e/widget.spec.ts` serves a throwaway HTML page from a **different origin** (`http://127.0.0.1:<port>` while the app is on `http://localhost:3000` — different origins, which is the whole point) containing `<iframe src="http://localhost:3000/w/<key>">`, then drives the form inside the frame.

**This is the only configuration in which the cookie attributes and `frame-ancestors` do anything observable.** A same-origin test passes while proving nothing — the same lesson Block 16 recorded about its own journeys, and Block 11a about the CSP it shipped, tested and withdrew. If you find yourself pointing the iframe at `localhost` from `localhost`, stop: the test is now green and worthless.

Read the six-digit code out of `outbox_messages.template_variables` with the service client, the way the WhatsApp e2e specs read what the bot enqueued.

- [ ] **Step 3: Run both**

Run: `npm run test:isolation && npx playwright test tests/e2e/widget.spec.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add tests/e2e/widget.spec.ts tests/isolation/widget.test.ts scripts/seed-demo.mjs
git commit -m "test(widget): the journey that only means anything across two origins"
```

---

### Task 13: Documentation, and the final gate

**Files:**
- Create: `docs/WIDGET.md`
- Modify: `docs/SECURITY.md`

- [ ] **Step 1: Write `docs/WIDGET.md`**

How a Station embeds the widget: the snippet, the origins that must be declared, the template that must be approved, and what a visitor sees. In English, like every other doc.

- [ ] **Step 2: Add the framing section to `docs/SECURITY.md`**

`/w/` is the one route in this product that may be embedded. Record: what the allowlist is, that empty means nowhere, that the 60-second cache means a revoked origin can frame for up to a minute, and that `X-Frame-Options` is excluded by header source rather than overridden.

- [ ] **Step 3: Run every gate**

```bash
npm run lint && npm run typecheck && npm test && npm run db:reset && npm run db:test && npm run test:isolation && npm run test:e2e
```

Expected: all green. **Report the actual output.** A gate you did not run is a gate that did not pass.

- [ ] **Step 4: Commit and open the PR**

```bash
git add docs/WIDGET.md docs/SECURITY.md
git commit -m "docs: how a station embeds the widget, and what the framing hole costs"
git push -u origin block-17a-web-widget
```

---

## Self-Review

**Spec coverage.** §4.1 → Task 1. §4.2 → Task 10. §4.3 → Tasks 8, 9. §5 → Tasks 6, 11. §6.1 → Task 3. §6.2 → Task 4. §6.3 → Task 10. §7 → Task 7. §8 → Task 5. §9 → Tasks 1, 3–7, 12. §10 → Tasks 1–6. §11 → Tasks 7–11. D1 → Tasks 4, 5, 10. D2 → Task 4. D3 → deferred to 17c, correctly. D4 → Task 1. D5 → Task 7. D6 → Task 9. D7 → Task 5. D8 → Task 4.

**Placeholder scan.** Clean. The one that existed — a `'__CODE__'` literal in Task 4's `enqueue_whatsapp_outbound` call — was a real hole rather than a formatting slip: the plaintext code has to reach the outbox and cannot be reconstructed in SQL. It is closed by `p_code_plain`, with the migration comment explaining why this one raw value may be an RPC argument when no other may. The reviewer of Task 4 should still check the thing that comment claims: that the plaintext lands in `outbox_messages.template_variables` and **nowhere else** — not in `body`, not in `widget_verifications`, not in a log line.

**Type consistency.** `WidgetClaims` (Task 7) is consumed by name in Tasks 9 and 10. `frameAncestorsValue` and `parseOrigins` (Task 8) are consumed in Tasks 9 and 11. `widget_frame_context` returns `{found, origins}` in Task 3 and is read as such in Task 9. `widget_verify_code` returns `member_id`/`company_id`/`organization_id` in Task 5, which is exactly what `mintSession`'s claims need in Task 10. `generatePublicKey()` (Task 7) produces the `^pw_[A-Za-z0-9_-]{22}$` that Task 1's CHECK requires.
