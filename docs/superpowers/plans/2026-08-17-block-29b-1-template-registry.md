# Block 29b-1 — Multi-channel template registry: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn `message_templates` from a one-row-per-purpose WhatsApp registry into a two-channel one that also holds an operator's own marketing templates, with a typed variable vocabulary and email bodies rendered into a Station-branded frame.

**Architecture:** One table for both channels, with a `channel` column and conditional CHECK constraints in the shape this schema already uses; `purpose` becomes nullable and null means marketing. Two write doors, because narrowing the unique index breaks the existing door's `ON CONFLICT` clause. Email bodies are plain text escaped into one HTML frame — no arbitrary HTML enters the system.

**Tech Stack:** PostgreSQL 17 (Supabase), pgTAP, Next.js 15 App Router, React Server Components, TypeScript, Zod, vitest, Playwright, next-intl.

**Spec:** `docs/superpowers/specs/2026-08-17-block-29b-1-template-registry-design.md`

## Global Constraints

- **Language:** every identifier, comment, commit message and operator-facing string is **English**. The one exception is what a LISTENER reads — template bodies and subjects — which is Portuguese. i18n keys go in **all three** catalogues: `messages/en.json`, `messages/pt.json`, `messages/es.json`.
- **Migrations are numbered sequentially** from the highest on disk. At the time of writing the last is `0221`, so this block starts at `0222`. A migration already merged is **never edited in place**.
- **A function recreated in a migration is copied from its LIVE definition** (`pg_get_functiondef`), never from the body in the migration that first created it. The live bodies this plan needs are quoted in full inside the tasks that recreate them.
- **`create or replace` preserves a function's ACL; `drop` + `create` destroys it.** Any task that drops a function reissues `revoke … from public` and `grant … to authenticated` in the same file.
- **Every write door is SECURITY DEFINER** with `set search_path = pg_catalog, public`, re-checks its permission in its own body, and writes an `audit_logs` row.
- **Permissions:** `templates.view` and `templates.manage`. No new permission codes in this block.
- **Gate order after any database change:** `npm run db:reset` → `npm run db:test` → `npm run test:isolation`. Running `db:test` after the e2e or isolation suites produces two false reds in `25_job_health.test.sql`; reset first.
- **Local e2e verdict:** `CI=1 npx playwright test <spec> --workers=1`. Without `CI=1` the dev server's cold compile produces false reds; without `--workers=1` parallel workers saturate the machine.
- **Do not edit any file while an e2e suite is running.** Each edit recompiles and a client-side navigation in flight never receives its RSC payload.

---

## File Structure

**Migrations (create):**
- `supabase/migrations/0222_template_channel_vocabulary.sql` — the two new enums, alone
- `supabase/migrations/0223_template_channel.sql` — columns, CHECKs, index, backfill, and `register_message_template` recreated
- `supabase/migrations/0224_enqueue_channel_term.sql` — `enqueue_whatsapp_outbound` gains the channel filter
- `supabase/migrations/0225_marketing_template_door.sql` — `save_marketing_template`
- `supabase/migrations/0226_station_email_identity.sql` — three `companies` columns and their door

**pgTAP (create):** `supabase/tests/64_template_channel.test.sql`

**TypeScript (create):**
- `src/lib/templates/variables.ts` — the vocabulary, the two notations, `CAMPAIGN_RESOLVABLE`
- `src/lib/mailer/frame.ts` — the Station-branded frame and its escaping
- `src/app/(app)/app/station-email-tab.tsx` — the Email tab
- `src/app/(app)/messages/templates/marketing-grid.tsx` — the marketing list
- `src/app/(app)/messages/templates/template-dialog.tsx` — create/edit, channel-switching

**TypeScript (modify):**
- `src/schemas/templates.ts` — the marketing schema and the variable enum
- `src/services/templates.ts` — read and write the new shape
- `src/app/(app)/messages/templates/page.tsx` — render both groups
- `src/app/(app)/messages/templates/actions.ts` — the new action
- `src/app/(app)/app/station-settings.tsx` — a second tab
- `src/app/(app)/app/page.tsx` — carry the Station's email identity into the dialog

**Tests (create):** `tests/unit/template-variables.test.ts`, `tests/unit/mailer-frame.test.ts`, `tests/isolation/marketing-templates.test.ts`
**Tests (modify):** `tests/e2e/templates.spec.ts`, `scripts/verify-isolation-suite.mjs`

---

### Task 1: The two vocabularies

**Files:**
- Create: `supabase/migrations/0222_template_channel_vocabulary.sql`
- Test: `supabase/tests/64_template_channel.test.sql`

**Interfaces:**
- Consumes: nothing.
- Produces: `public.message_channel` (`WHATSAPP` | `EMAIL`) and `public.template_variable` (seven values, listed below). Every later task uses both.

- [ ] **Step 1: Write the failing test**

Create `supabase/tests/64_template_channel.test.sql`:

```sql
begin;
select plan(3);

-- Block 29b-1, Task 1. The two vocabularies this block adds.
--
-- SEPARATE FILE FOR THE TYPES, and the reason is readability rather than
-- correctness: `CREATE TYPE` and its first use may share a transaction. The
-- rule 0219 states is about `ALTER TYPE ... ADD VALUE`, which nothing in this
-- block does. A reader who has met 0219 will assume the harder rule applies
-- here; it does not, and this comment is why the split is still worth making.
select has_type('public', 'message_channel', 'message_channel exists');
select has_type('public', 'template_variable', 'template_variable exists');

-- ORDER IS NOT DECORATION for template_variable: a WhatsApp template's
-- `variables` array is POSITIONAL, so the enum's own order is what a reader
-- compares an array against. The campaign-resolvable four come first because
-- they are the ones 29d may offer.
select is(
  enum_range(null::public.template_variable)::text[],
  array['LISTENER_FIRST_NAME', 'LISTENER_FULL_NAME', 'LISTENER_CITY', 'STATION_NAME',
        'PRIZE_NAME', 'PICKUP_DEADLINE', 'VERIFICATION_CODE'],
  'template_variable holds both families, resolvable first');

select * from finish();
rollback;
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run db:reset && npm run db:test 2>&1 | tail -20`
Expected: `64_template_channel.test.sql` fails — `has_type` reports both types missing.

- [ ] **Step 3: Write the migration**

Create `supabase/migrations/0222_template_channel_vocabulary.sql`:

```sql
-- supabase/migrations/0222_template_channel_vocabulary.sql

-- Block 29b-1, Task 1. THE TWO VOCABULARIES AND NOTHING ELSE IN THIS FILE.
--
-- Unlike 0219, this separation is for READABILITY and not for correctness:
-- `CREATE TYPE` may share a transaction with its first use. The Postgres rule
-- 0219 states -- that `ALTER TYPE ... ADD VALUE` cannot -- does not apply,
-- because nothing in this block adds a value to an existing type. A reader who
-- has met 0219 will assume otherwise, which is why this paragraph exists.

create type public.message_channel as enum ('WHATSAPP', 'EMAIL');

comment on type public.message_channel is
  'Which door a template speaks through. Two values today; a third (SMS, push) is a later block adding a value rather than a second table -- see the Block 29b-1 design, D1: a campaign points at ONE template and the rule "the campaign''s channel equals its template''s channel" is only expressible in the schema while both channels share a table.';

-- ---------------------------------------------------------------------------
-- The substitutable values, in two families.
--
-- ONE VOCABULARY, NOT TWO. The four campaign-resolvable values are what a
-- marketing template may carry; the three caller-supplied ones are what the two
-- SYSTEM templates already carry and what, until this migration, was free prose
-- in a jsonb array -- a description for a human that no code could act on.
--
-- WHICH FAMILY A VALUE BELONGS TO IS NOT RECORDED HERE. It lives in
-- `CAMPAIGN_RESOLVABLE` (src/lib/templates/variables.ts), a TypeScript record
-- total over this enum, so an eighth value stops that file compiling until
-- somebody decides. A column or a second enum here would be a second place for
-- the same fact, and the compiler cannot check a column.
--
-- ORDER MATTERS. A WhatsApp template's `variables` is POSITIONAL -- index 0 is
-- {{1}} -- so this declaration order is what a reader compares an array
-- against. The resolvable four are first because they are the ones 29d offers.
create type public.template_variable as enum (
  'LISTENER_FIRST_NAME',
  'LISTENER_FULL_NAME',
  'LISTENER_CITY',
  'STATION_NAME',
  'PRIZE_NAME',
  'PICKUP_DEADLINE',
  'VERIFICATION_CODE'
);

comment on type public.template_variable is
  'What a template may substitute. Two families in one type: LISTENER_* and STATION_NAME are resolvable by a campaign from the row it already reads, and PRIZE_NAME / PICKUP_DEADLINE / VERIFICATION_CODE are supplied by the specific caller that enqueues a system template (enqueue_pickup_reminder, widget_request_code) and can never be filled by a campaign. Which family a value is in is held by CAMPAIGN_RESOLVABLE in src/lib/templates/variables.ts, total over this enum, because a compiler can check that and a column cannot.';
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run db:reset && npm run db:test 2>&1 | tail -8`
Expected: `64_template_channel.test.sql ... ok`, `Result: PASS`.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/0222_template_channel_vocabulary.sql supabase/tests/64_template_channel.test.sql
git commit -m "feat(templates): the channel and the variable vocabulary"
```

---

### Task 2: The table learns two channels, and the door survives the index

**Files:**
- Create: `supabase/migrations/0223_template_channel.sql`
- Modify: `supabase/tests/64_template_channel.test.sql`

**Interfaces:**
- Consumes: `public.message_channel`, `public.template_variable` (Task 1).
- Produces: `message_templates` with `channel`, nullable `purpose`, `internal_name`, `description`, `subject`, `from_name`, `from_email`, `reply_to`, `updated_by`, and `variables` retyped to `public.template_variable[]`. `register_message_template(uuid, template_purpose, text, text, text, jsonb, boolean)` keeps its exact signature.

**Why this is one task and not two:** narrowing `message_templates_purpose_unique` to `where … and purpose is not null` makes `register_message_template`'s `on conflict (company_id, purpose) where deleted_at is null` match no index, and PostgreSQL raises *"there is no unique or exclusion constraint matching the ON CONFLICT specification"*. The index and the door cannot ship apart.

- [ ] **Step 1: Write the failing tests**

Replace the `select plan(3);` line in `supabase/tests/64_template_channel.test.sql` with `select plan(14);` and append **before** `select * from finish();`:

```sql
-- ---------------------------------------------------------------------------
-- Task 2. The table.
-- ---------------------------------------------------------------------------
select has_column('public', 'message_templates', 'channel', 'channel exists');
select has_column('public', 'message_templates', 'internal_name', 'internal_name exists');
select has_column('public', 'message_templates', 'subject', 'subject exists');

select ok(
  (select is_nullable from information_schema.columns
    where table_name = 'message_templates' and column_name = 'purpose') = 'YES',
  'purpose is nullable -- null is a marketing template');

select is(
  (select data_type from information_schema.columns
    where table_name = 'message_templates' and column_name = 'variables'),
  'ARRAY',
  'variables is a typed array, not prose in jsonb');

-- The conditional pairs, asserted by DEFINITION. An insert-based test would
-- fail on the company_org foreign key first and pass for the wrong reason.
select ok(
  exists (select 1 from pg_constraint
           where conname = 'message_templates_whatsapp_shape'),
  'a WhatsApp row must name what the Cloud API takes');

select ok(
  exists (select 1 from pg_constraint
           where conname = 'message_templates_email_shape'),
  'an email row must have a subject');

-- Not symmetry. Without it an email template may carry a name and a language,
-- and every query asking "is this registered at Meta" gains a row that answers
-- yes and is not.
select ok(
  exists (select 1 from pg_constraint
           where conname = 'message_templates_email_no_meta_fields'),
  'an email row may NOT carry Meta''s name, language or OTP flag');

select ok(
  exists (select 1 from pg_constraint
           where conname = 'message_templates_email_variables_empty'),
  'an email row declares no positional array -- its body names its own places');

-- THE INDEX, and the assertion that matters most in this file.
select ok(
  (select indexdef from pg_indexes
    where indexname = 'message_templates_purpose_unique')
    like '%purpose IS NOT NULL%',
  'the purpose index excludes marketing rows, which all have a null purpose');

-- AND THE DOOR THAT NAMES IT. These two are a pair: narrowing the index above
-- without correcting the clause below leaves register_message_template raising
-- "there is no unique or exclusion constraint matching the ON CONFLICT
-- specification" on every system registration.
select ok(
  (select prosrc from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'register_message_template')
    like '%purpose is not null%',
  'register_message_template''s ON CONFLICT predicate matches the narrowed index');

-- The signature is UNCHANGED, so `create or replace` kept the ACL. A drop would
-- have taken it, and every registration would answer 42501 -- which no test
-- calling this as the OWNER would notice, because has_permission's owner bypass
-- opens the door for the one identity that never needed the grant.
select has_function('public', 'register_message_template',
  array['uuid','template_purpose','text','text','text','jsonb','boolean'],
  'register_message_template keeps its exact signature');

select ok(
  has_function_privilege('authenticated',
    'public.register_message_template(uuid,public.template_purpose,text,text,text,jsonb,boolean)',
    'execute'),
  'and therefore still holds its grant');

-- The backfill, asserted rather than inspected.
select ok(
  not exists (select 1 from public.message_templates where channel is null),
  'every existing row was given a channel');
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run db:reset && npm run db:test 2>&1 | tail -20`
Expected: `64_template_channel.test.sql` fails on the `has_column` assertions.

- [ ] **Step 3: Write the migration**

Create `supabase/migrations/0223_template_channel.sql`:

```sql
-- supabase/migrations/0223_template_channel.sql

-- Block 29b-1, Task 2. One table, two channels -- and the door that the index
-- change breaks if it ships alone.
--
-- WHY ONE TABLE AND NOT ONE PER CHANNEL (design D1). Not to save a join. A
-- campaign (29d) points at ONE template and must not use the wrong channel's,
-- and with a `channel` column that rule is a foreign key plus a CHECK. With two
-- tables a campaign needs two nullable foreign keys or a polymorphic reference,
-- and the rule stops being expressible in the schema at all -- it becomes a
-- sentence in application code that the database cannot hold.

-- ---------------------------------------------------------------------------
-- 1. The columns.
--
-- `channel` arrives with a default so the existing rows are legal at the moment
-- the column exists, and the default is DROPPED immediately after: a default of
-- WHATSAPP on a table that now holds email templates would make the channel an
-- assumption rather than a statement, and the marketing door below sets it
-- explicitly for exactly that reason.
-- ---------------------------------------------------------------------------
alter table public.message_templates
  add column channel public.message_channel not null default 'WHATSAPP';

alter table public.message_templates
  alter column channel drop default;

alter table public.message_templates
  add column internal_name text,
  add column description   text,
  add column subject       text,
  add column from_name     text,
  add column from_email    text,
  add column reply_to      text,
  add column updated_by    uuid references auth.users (id);

comment on column public.message_templates.channel is
  'WHATSAPP or EMAIL. NOT NULL and with no default: a template that did not say which door it speaks through is a template somebody will send through the wrong one.';

comment on column public.message_templates.internal_name is
  'What an operator calls this template. NOT Meta''s name: with many marketing templates per Station, "pickup_reminder" is a value the Cloud API needs and not a label anybody searches by. A SYSTEM template gets this from `name`, because its card is titled by its purpose and there is no second label to give it.';

comment on column public.message_templates.from_name is
  'An override of the Station''s own sender identity (companies.email_from_name, 0226), null in the ordinary case. The Station declares it once; a template that needs to differ says so here. Null on every WhatsApp row, which has no sender to name.';

-- ---------------------------------------------------------------------------
-- 2. purpose becomes nullable, and null MEANS something.
-- ---------------------------------------------------------------------------
alter table public.message_templates
  alter column purpose drop not null;

comment on column public.message_templates.purpose is
  'What a SYSTEM template is for, and NULL for every marketing template. The null is not an absence to tidy away: it is the discriminator between the two families, and message_templates_purpose_unique is partial on it so that marketing rows -- all of which have a null purpose -- do not collide with one another.';

-- ---------------------------------------------------------------------------
-- 3. name and language become conditional, so the existing not-blank checks
-- have to admit null.
-- ---------------------------------------------------------------------------
alter table public.message_templates
  alter column name drop not null,
  alter column language drop not null;

alter table public.message_templates
  drop constraint message_templates_name_not_blank,
  drop constraint message_templates_language_not_blank;

alter table public.message_templates
  add constraint message_templates_name_not_blank
    check (name is null or btrim(name) <> ''),
  add constraint message_templates_language_not_blank
    check (language is null or btrim(language) <> '');

-- ---------------------------------------------------------------------------
-- 4. The conditional pairs, in the shape this schema already uses three times
-- (outbox_messages_template_shape, _sent_shape, _retention_shape): a row names
-- all of a channel's fields or none of them.
-- ---------------------------------------------------------------------------
alter table public.message_templates
  add constraint message_templates_whatsapp_shape
    check (channel <> 'WHATSAPP' or (name is not null and language is not null)),

  add constraint message_templates_email_shape
    check (channel <> 'EMAIL' or (subject is not null and btrim(subject) <> '')),

  -- NOT symmetry for its own sake. Without this an email template may carry a
  -- name, a language and the OTP flag, and every screen and query that reads
  -- "is this registered at Meta" gains a row that answers yes and is not.
  add constraint message_templates_email_no_meta_fields
    check (channel <> 'EMAIL' or (name is null and language is null and not otp_button)),

  -- An email body names its own placeholders inline ({{listener_first_name}}),
  -- so a positional array beside it would be a second declaration to drift from
  -- the first. The door validates the body against the enum on save.
  add constraint message_templates_email_variables_empty
    check (channel <> 'EMAIL' or cardinality(variables) = 0);

-- ---------------------------------------------------------------------------
-- 5. variables: from prose to vocabulary.
--
-- THE BACKFILL PRESERVES THE COUNT INVARIANT rather than assuming a shape.
-- register_message_template has always refused a registration whose description
-- count disagrees with the body's placeholder count, so every existing row's
-- count is already correct -- and a Station's approved PICKUP_REMINDER body may
-- legitimately use one placeholder or three. So the new value is the first N of
-- the purpose's canonical order, where N is the row's existing count.
--
-- Measured before writing: production holds ONE row (WEB_VERIFICATION, one
-- description). That is what makes a typed vocabulary affordable here -- over
-- hundreds of prose rows the mapping would be guesswork.
-- ---------------------------------------------------------------------------
alter table public.message_templates
  add column variable_fields public.template_variable[] not null default '{}';

update public.message_templates m
   set variable_fields = (
     select coalesce(array_agg(v order by o), '{}')
     from unnest(
       case m.purpose
         when 'PICKUP_REMINDER' then
           array['LISTENER_FULL_NAME', 'PRIZE_NAME', 'PICKUP_DEADLINE']::public.template_variable[]
         when 'WEB_VERIFICATION' then
           array['VERIFICATION_CODE']::public.template_variable[]
         else '{}'::public.template_variable[]
       end
     ) with ordinality as t(v, o)
     where o <= jsonb_array_length(m.variables)
   );

alter table public.message_templates drop column variables;
alter table public.message_templates rename column variable_fields to variables;
alter table public.message_templates alter column variables drop default;
alter table public.message_templates alter column variables set default '{}';

comment on column public.message_templates.variables is
  'What this template substitutes, IN ORDER: index 0 is {{1}}. Typed against template_variable (0222) rather than the prose array it replaced, which described something to a human and let no code act on it. EMPTY on every email row -- an email body names its own placeholders inline, so an array beside it would be a second declaration (message_templates_email_variables_empty holds that structurally).';

-- ---------------------------------------------------------------------------
-- 6. internal_name becomes required, after the backfill that can satisfy it.
-- ---------------------------------------------------------------------------
update public.message_templates set internal_name = name where internal_name is null;

alter table public.message_templates
  alter column internal_name set not null,
  add constraint message_templates_internal_name_not_blank
    check (btrim(internal_name) <> '');

-- ---------------------------------------------------------------------------
-- 7. The index, narrowed.
--
-- Without `and purpose is not null`, every marketing template in a Station
-- collides with every other on "purpose is null" -- one marketing template per
-- Station, for ever, discovered by the second one.
-- ---------------------------------------------------------------------------
drop index public.message_templates_purpose_unique;

create unique index message_templates_purpose_unique
  on public.message_templates (company_id, purpose)
  where deleted_at is null and purpose is not null;

-- ---------------------------------------------------------------------------
-- 8. register_message_template, recreated FROM ITS LIVE DEFINITION with two
-- changes and no others.
--
-- WHY IT IS HERE AND NOT IN ITS OWN FILE: the ON CONFLICT clause below names
-- the index recreated in step 7. Ship them apart and every system registration
-- raises "there is no unique or exclusion constraint matching the ON CONFLICT
-- specification" for however long the two files are separated.
--
-- THE SIGNATURE DOES NOT CHANGE, and that is deliberate rather than lucky:
-- `create or replace` keeps the ACL, where a drop would take it and leave every
-- registration answering 42501 -- which no test calling this as the OWNER would
-- notice, because has_permission's owner bypass opens the door for the one
-- identity that never needed the grant. Block 24 lost an ACL exactly that way.
--
-- p_variables STAYS jsonb for the same reason. The column is now
-- template_variable[]; the parameter is cast inside. Widening the parameter to
-- the array type would be a new signature, and the ACL would go with it.
--
-- The two changes: the ON CONFLICT predicate, and the cast plus the two columns
-- this door now fills itself (channel and internal_name).
-- ---------------------------------------------------------------------------
create or replace function public.register_message_template(
  p_company_id uuid,
  p_purpose    public.template_purpose,
  p_name       text,
  p_language   text,
  p_body       text,
  p_variables  jsonb default '[]'::jsonb,
  p_otp_button boolean default false
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor    uuid := auth.uid();
  v_org      uuid;
  v_name     text := nullif(btrim(p_name), '');
  v_language text := nullif(btrim(p_language), '');
  v_body     text := nullif(btrim(p_body), '');
  v_vars     jsonb := coalesce(p_variables, '[]'::jsonb);
  v_otp      boolean := coalesce(p_otp_button, false);
  v_fields   public.template_variable[];
  v_expected integer;
  v_id       uuid;
begin
  if not public.has_permission('templates.manage', p_company_id) then
    raise log 'register_message_template denied: actor=% company=% purpose=%',
      v_actor, p_company_id, p_purpose;
    raise exception 'permission denied: templates.manage required' using errcode = '42501';
  end if;

  select organization_id into v_org
    from public.companies
   where id = p_company_id and deleted_at is null;

  if not found then
    raise exception 'station not found: %', p_company_id using errcode = 'P0002';
  end if;

  -- Three separate refusals rather than one, so the message names the field
  -- the operator has to go back and fix. 0110 carries a check constraint for
  -- each of these; reaching them would be a 23514 naming a constraint.
  if v_name is null then
    raise exception 'the template name Meta approved is required' using errcode = '22023';
  end if;

  if v_language is null then
    raise exception 'the language Meta approved is required' using errcode = '22023';
  end if;

  if v_body is null then
    raise exception 'the approved body is required' using errcode = '22023';
  end if;

  if jsonb_typeof(v_vars) <> 'array' then
    raise exception 'the variables must be a JSON array' using errcode = '22023';
  end if;

  -- Block 29b-1. The array is now a VOCABULARY rather than prose, so an element
  -- outside template_variable is refused by name here instead of arriving as a
  -- raw 22P02 from the cast below. The screen offers a closed list, so reaching
  -- this means a hand-made call or a stale client.
  begin
    select array_agg(e #>> '{}' order by ord)::public.template_variable[]
      into v_fields
      from jsonb_array_elements(v_vars) with ordinality as t(e, ord);
  exception
    when invalid_text_representation then
      raise exception 'one of the variables is not a value this system substitutes'
        using errcode = '22023';
  end;

  v_fields := coalesce(v_fields, '{}'::public.template_variable[]);

  -- The same comparison 0111 makes at enqueue, moved to the moment it can
  -- still be acted on. The regexp form is 0111's, verified there against
  -- PostgreSQL 17.6.
  v_expected := coalesce((
    select max((regexp_matches[1])::integer)
    from regexp_matches(v_body, '\{\{(\d+)\}\}', 'g')
  ), 0);

  if cardinality(v_fields) <> v_expected then
    raise exception 'this body uses % placeholder(s) but % variable(s) were given',
      v_expected, cardinality(v_fields)
      using errcode = '22023';
  end if;

  -- 0165. An OTP button's parameter is the code, and the code is what the body
  -- says with its placeholder -- so a template marked as carrying the button
  -- with nothing to put in it is a registration that could never be sent.
  if v_otp and v_expected = 0 then
    raise exception 'an authentication template carries the code in {{1}}; this body has no placeholder'
      using errcode = '22023';
  end if;

  -- Block 29b-1: `channel` and `internal_name` are filled HERE rather than
  -- taken as parameters. A system purpose is never email, and a system card is
  -- titled by its purpose -- so there is no second label an operator could give
  -- it, and widening the signature to ask for one would drop the ACL for a
  -- field nobody would fill.
  insert into public.message_templates
    (organization_id, company_id, purpose, channel, internal_name,
     name, language, body, variables, otp_button, created_by, updated_by)
  values
    (v_org, p_company_id, p_purpose, 'WHATSAPP', v_name,
     v_name, v_language, v_body, v_fields, v_otp, v_actor, v_actor)
  on conflict (company_id, purpose) where deleted_at is null and purpose is not null
  do update set name          = excluded.name,
                internal_name = excluded.internal_name,
                language      = excluded.language,
                body          = excluded.body,
                variables     = excluded.variables,
                otp_button    = excluded.otp_button,
                updated_by    = excluded.updated_by,
                updated_at    = now()
  returning id into v_id;

  insert into public.audit_logs
    (actor_id, action, target_table, target_id, organization_id, company_id, detail)
  values
    (v_actor, 'register_message_template', 'message_templates', v_id, v_org, p_company_id,
     jsonb_build_object('purpose', p_purpose, 'name', v_name, 'language', v_language,
                        'otp_button', v_otp));

  return v_id;
end;
$$;
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run db:reset && npm run db:test 2>&1 | tail -8`
Expected: `64_template_channel.test.sql ... ok`, `Result: PASS`.

- [ ] **Step 5: Prove the pair by mutation**

Temporarily change step 7's index back to `where deleted_at is null` (drop the `and purpose is not null`) and re-run `npm run db:reset`.
Expected: the reset **fails** applying 0223 — PostgreSQL raises `there is no unique or exclusion constraint matching the ON CONFLICT specification`. Restore the predicate and reset again.

This is the assertion the task exists for; run it once and record the message in the commit.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/0223_template_channel.sql supabase/tests/64_template_channel.test.sql
git commit -m "feat(templates): one table, two channels, and the index that names a door"
```

---

### Task 3: The enqueue stops resolving across channels

**Files:**
- Create: `supabase/migrations/0224_enqueue_channel_term.sql`
- Modify: `supabase/tests/64_template_channel.test.sql`

**Interfaces:**
- Consumes: `channel` (Task 2).
- Produces: `enqueue_whatsapp_outbound` unchanged in signature, resolving only WhatsApp templates.

- [ ] **Step 1: Write the failing test**

Bump the plan to `select plan(15);` and append before `finish()`:

```sql
-- Task 3. Without this term, the day somebody registers an email template
-- carrying a system purpose, the pickup reminder resolves it and tries to send
-- an email through the Cloud API.
select ok(
  (select prosrc from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'enqueue_whatsapp_outbound')
    like '%channel = ''WHATSAPP''%',
  'the enqueue resolves WhatsApp templates and no others');
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run db:reset && npm run db:test 2>&1 | grep -A 3 "Failed test"`
Expected: the new assertion fails.

- [ ] **Step 3: Write the migration**

Create `supabase/migrations/0224_enqueue_channel_term.sql`. Take the live body first:

```bash
npx supabase migration list --linked >/dev/null 2>&1
psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -Atc \
  "select pg_get_functiondef(p.oid) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='enqueue_whatsapp_outbound'" \
  > /tmp/enqueue.sql
```

Copy that body into the migration verbatim, changing the header to
`create or replace function public.enqueue_whatsapp_outbound(...)` with
`set search_path = pg_catalog, public`, and adding **one line** to the template
lookup:

```sql
    select * into v_tpl
      from public.message_templates
     where company_id = v_integ.company_id
       and purpose = p_template_purpose
       and channel = 'WHATSAPP'
       and deleted_at is null;
```

Head the file with:

```sql
-- supabase/migrations/0224_enqueue_channel_term.sql

-- Block 29b-1, Task 3. ONE TERM, and the whole file is here to justify it.
--
-- 0111's lookup resolves a system template by (company_id, purpose). Since 0223
-- a purpose is no longer enough to identify one row's CHANNEL -- and an email
-- template carrying a system purpose would be resolved by this function and
-- handed to the Cloud API, which would refuse a message with no `name` and no
-- `language` at all. The failure would arrive as a send that never happens, in
-- a sweep whose only reader is a server log.
--
-- FROM THE LIVE DEFINITION, not from 0111's body: this function has been
-- recreated since, and rebuilding it from the migration that first created it
-- would silently revert every fix applied in between.
--
-- Signature unchanged, so `create or replace` keeps the grant.
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm run db:reset && npm run db:test 2>&1 | tail -6`
Expected: `Result: PASS`.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/0224_enqueue_channel_term.sql supabase/tests/64_template_channel.test.sql
git commit -m "fix(templates): the pickup reminder may only resolve a WhatsApp template"
```

---

### Task 4: The marketing door

**Files:**
- Create: `supabase/migrations/0225_marketing_template_door.sql`, `tests/isolation/marketing-templates.test.ts`
- Modify: `supabase/tests/64_template_channel.test.sql`, `scripts/verify-isolation-suite.mjs`

**Interfaces:**
- Consumes: everything from Tasks 1–2.
- Produces:
  `save_marketing_template(p_id uuid, p_company_id uuid, p_channel public.message_channel, p_internal_name text, p_description text, p_body text, p_subject text, p_name text, p_language text, p_variables jsonb, p_from_name text, p_from_email text, p_reply_to text) returns uuid`.
  `p_id` null inserts; non-null updates.

- [ ] **Step 1: Write the failing isolation test**

Create `tests/isolation/marketing-templates.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  admin,
  cleanupUsers,
  grantRoleWith,
  provisionCustomer,
  signInAs,
  type ProvisionedCustomer,
} from './harness';

/**
 * Block 29b-1. The marketing door, against real sessions.
 *
 * pgTAP runs as superuser with a null auth.uid(), so has_permission answers true
 * unconditionally and every gate reads open. It can hold the grants and the
 * shape; it cannot prove the door refuses anybody. These cases can.
 */
const STAMP = Date.now();

describe('Block 29b-1 — the marketing template door', () => {
  let customer: ProvisionedCustomer;
  let manager: { email: string; password: string };
  let viewer: { email: string; password: string };

  beforeAll(async () => {
    customer = await provisionCustomer(`marketing-tpl-${STAMP}`);
    manager = await grantRoleWith(customer, `mtpl-manage-${STAMP}`, [
      'templates.view',
      'templates.manage',
    ]);
    viewer = await grantRoleWith(customer, `mtpl-view-${STAMP}`, ['templates.view']);
  }, 120_000);

  afterAll(async () => {
    await cleanupUsers();
  }, 60_000);

  async function save(
    who: { email: string; password: string },
    args: Record<string, unknown>,
  ): Promise<{ id?: string; code?: string; message?: string }> {
    const client = await signInAs(who.email, who.password);
    const { data, error } = await client.rpc('save_marketing_template', {
      p_company_id: customer.companyId,
      ...args,
    });
    return { id: data as string | undefined, code: error?.code, message: error?.message };
  }

  it('creates an email template for a caller holding templates.manage', async () => {
    const result = await save(manager, {
      p_channel: 'EMAIL',
      p_internal_name: `natal_${STAMP}`,
      p_subject: 'Feliz Natal!',
      p_body: 'Oi {{listener_first_name}}, boas festas da {{station_name}}!',
    });
    expect(result.code, result.message).toBeUndefined();
    expect(result.id).toBeTruthy();

    const { data } = await admin
      .from('message_templates')
      .select('channel, purpose, subject, variables, name, language')
      .eq('id', result.id!)
      .single();
    expect(data?.channel).toBe('EMAIL');
    // The discriminator: a marketing template has no purpose, which is what
    // keeps it out of the partial unique index the system half depends on.
    expect(data?.purpose).toBeNull();
    // An email row declares no positional array -- its body names its places.
    expect(data?.variables).toEqual([]);
    expect(data?.name).toBeNull();
  }, 60_000);

  it('lets a second marketing template exist beside the first', async () => {
    // THE CASE THE NARROWED INDEX EXISTS FOR. Against the old index both rows
    // collide on "purpose is null" and the second save raises 23505.
    const result = await save(manager, {
      p_channel: 'EMAIL',
      p_internal_name: `aniversario_${STAMP}`,
      p_subject: 'Parabéns!',
      p_body: 'Parabéns, {{listener_first_name}}!',
    });
    expect(result.code, result.message).toBeUndefined();
  }, 60_000);

  it('refuses a body naming something this system does not substitute', async () => {
    const result = await save(manager, {
      p_channel: 'EMAIL',
      p_internal_name: `ruim_${STAMP}`,
      p_subject: 'Oi',
      p_body: 'Oi {{listener_shoe_size}}!',
    });
    expect(result.code).toBe('22023');
  }, 60_000);

  it('refuses a caller who may see templates but not manage them', async () => {
    const result = await save(viewer, {
      p_channel: 'EMAIL',
      p_internal_name: `negado_${STAMP}`,
      p_subject: 'Oi',
      p_body: 'Oi!',
    });
    expect(result.code).toBe('42501');
  }, 60_000);

  it('updates in place when given an id, rather than inserting a second row', async () => {
    const created = await save(manager, {
      p_channel: 'EMAIL',
      p_internal_name: `editar_${STAMP}`,
      p_subject: 'Antes',
      p_body: 'Oi!',
    });
    expect(created.code, created.message).toBeUndefined();

    const updated = await save(manager, {
      p_id: created.id,
      p_channel: 'EMAIL',
      p_internal_name: `editar_${STAMP}`,
      p_subject: 'Depois',
      p_body: 'Oi!',
    });
    expect(updated.id).toBe(created.id);

    const { data } = await admin
      .from('message_templates')
      .select('subject')
      .eq('id', created.id!)
      .single();
    expect(data?.subject).toBe('Depois');
  }, 60_000);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run --config vitest.isolation.config.ts tests/isolation/marketing-templates.test.ts 2>&1 | tail -10`
Expected: every case fails — `save_marketing_template` does not exist (PGRST202).

- [ ] **Step 3: Write the migration**

Create `supabase/migrations/0225_marketing_template_door.sql`:

```sql
-- supabase/migrations/0225_marketing_template_door.sql

-- Block 29b-1, Task 4. The second write door, and the split is FORCED rather
-- than chosen (design D5).
--
-- register_message_template upserts on (company_id, purpose) -- which is how the
-- screen's "Replace what is recorded" works, and which requires a conflict
-- target. A marketing template has no purpose, so there is no natural target:
-- two marketing templates collide on nothing, which is the whole point of the
-- narrowed index in 0223. Writing by id is the only shape available.
--
-- Folding both into one function would mean a function branching on "is purpose
-- null" and using two different write strategies -- two functions wearing one
-- name.

create function public.save_marketing_template(
  p_company_id     uuid,
  p_channel        public.message_channel,
  p_internal_name  text,
  p_body           text,
  p_id             uuid default null,
  p_description    text default null,
  p_subject        text default null,
  p_name           text default null,
  p_language       text default null,
  p_variables      jsonb default '[]'::jsonb,
  p_from_name      text default null,
  p_from_email     text default null,
  p_reply_to       text default null
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor   uuid := auth.uid();
  v_org     uuid;
  v_label   text := nullif(btrim(p_internal_name), '');
  v_body    text := nullif(btrim(p_body), '');
  v_subject text := nullif(btrim(p_subject), '');
  v_name    text := nullif(btrim(p_name), '');
  v_lang    text := nullif(btrim(p_language), '');
  v_fields  public.template_variable[];
  v_known   text[];
  v_used    text;
  v_id      uuid;
begin
  if not public.has_permission('templates.manage', p_company_id) then
    raise log 'save_marketing_template denied: actor=% company=%', v_actor, p_company_id;
    raise exception 'permission denied: templates.manage required' using errcode = '42501';
  end if;

  select organization_id into v_org
    from public.companies
   where id = p_company_id and deleted_at is null;

  if not found then
    raise exception 'station not found: %', p_company_id using errcode = 'P0002';
  end if;

  if v_label is null then
    raise exception 'an internal name is required' using errcode = '22023';
  end if;

  if v_body is null then
    raise exception 'the body is required' using errcode = '22023';
  end if;

  -- ---------------------------------------------------------------------
  -- The two channels part company here, and only here.
  -- ---------------------------------------------------------------------
  if p_channel = 'EMAIL' then
    if v_subject is null then
      raise exception 'an email needs a subject' using errcode = '22023';
    end if;

    -- AN EMAIL BODY NAMES ITS OWN PLACEHOLDERS, so they are validated rather
    -- than declared: every {{...}} must be a value this system substitutes.
    -- Lower case, because the named notation is the enum lower-cased and
    -- nothing else -- one vocabulary, one derivation.
    select array_agg(lower(v::text)) into v_known
      from unnest(enum_range(null::public.template_variable)) as v;

    for v_used in
      select (regexp_matches[1])
      from regexp_matches(v_body, '\{\{([a-z_]+)\}\}', 'g')
    loop
      if not (v_used = any(v_known)) then
        raise exception 'this body names %, which is not a value this system substitutes', v_used
          using errcode = '22023';
      end if;
    end loop;

    -- The positional array is meaningless for email and the CHECK in 0223
    -- refuses a non-empty one; refused here by name instead of as a 23514.
    if coalesce(jsonb_array_length(p_variables), 0) > 0 then
      raise exception 'an email template declares no positional variables; its body names them'
        using errcode = '22023';
    end if;
    v_fields := '{}'::public.template_variable[];
    v_name := null;
    v_lang := null;
  else
    -- WHATSAPP. In 29b-1 this is still a TRANSCRIPTION of something Meta
    -- approved in its own console -- the same act the system half performs,
    -- and the reason the screen keeps that notice on this channel only. 29b-2
    -- is what makes it possible to author one here.
    if v_name is null or v_lang is null then
      raise exception 'a WhatsApp template needs the name and language Meta approved'
        using errcode = '22023';
    end if;

    begin
      select array_agg(e #>> '{}' order by ord)::public.template_variable[]
        into v_fields
        from jsonb_array_elements(coalesce(p_variables, '[]'::jsonb)) with ordinality as t(e, ord);
    exception
      when invalid_text_representation then
        raise exception 'one of the variables is not a value this system substitutes'
          using errcode = '22023';
    end;

    v_fields := coalesce(v_fields, '{}'::public.template_variable[]);

    if cardinality(v_fields) <> coalesce((
      select max((regexp_matches[1])::integer)
      from regexp_matches(v_body, '\{\{(\d+)\}\}', 'g')), 0)
    then
      raise exception 'the body''s placeholders and the variables given do not agree'
        using errcode = '22023';
    end if;

    v_subject := null;
  end if;

  if p_id is null then
    insert into public.message_templates
      (organization_id, company_id, purpose, channel, internal_name, description,
       name, language, body, subject, variables,
       from_name, from_email, reply_to, created_by, updated_by)
    values
      (v_org, p_company_id, null, p_channel, v_label, nullif(btrim(p_description), ''),
       v_name, v_lang, v_body, v_subject, v_fields,
       nullif(btrim(p_from_name), ''), nullif(btrim(p_from_email), ''),
       nullif(btrim(p_reply_to), ''), v_actor, v_actor)
    returning id into v_id;
  else
    -- The tenancy is re-stated in the WHERE clause rather than trusted from the
    -- id: an id is a value a caller supplies, and a template of another Station
    -- must not be reachable by naming it. `purpose is null` is the second half
    -- -- this door may not edit a SYSTEM registration, which belongs to
    -- register_message_template and its own validations.
    update public.message_templates
       set internal_name = v_label,
           description   = nullif(btrim(p_description), ''),
           channel       = p_channel,
           name          = v_name,
           language      = v_lang,
           body          = v_body,
           subject       = v_subject,
           variables     = v_fields,
           from_name     = nullif(btrim(p_from_name), ''),
           from_email    = nullif(btrim(p_from_email), ''),
           reply_to      = nullif(btrim(p_reply_to), ''),
           updated_by    = v_actor,
           updated_at    = now()
     where id = p_id
       and company_id = p_company_id
       and purpose is null
       and deleted_at is null
    returning id into v_id;

    if v_id is null then
      raise exception 'that template could not be found in this station'
        using errcode = 'P0002';
    end if;
  end if;

  insert into public.audit_logs
    (actor_id, action, target_table, target_id, organization_id, company_id, detail)
  values
    (v_actor, 'save_marketing_template', 'message_templates', v_id, v_org, p_company_id,
     jsonb_build_object('channel', p_channel, 'internal_name', v_label,
                        'created', p_id is null));

  return v_id;
end;
$$;

revoke execute on function public.save_marketing_template(
  uuid, public.message_channel, text, text, uuid, text, text, text, text, jsonb,
  text, text, text) from public;
grant execute on function public.save_marketing_template(
  uuid, public.message_channel, text, text, uuid, text, text, text, text, jsonb,
  text, text, text) to authenticated;

comment on function public.save_marketing_template(uuid, public.message_channel, text, text, uuid, text, text, text, text, jsonb, text, text, text) is
  'Creates or updates a MARKETING template -- one with no purpose. Separate from register_message_template because that door upserts on (company_id, purpose) and a marketing template has no purpose to conflict on: two of them collide on nothing, which is what the partial index in 0223 exists to allow. Writes by id, re-stating company_id and `purpose is null` in the UPDATE''s own WHERE clause so an id from another Station, or a SYSTEM registration, is unreachable by naming it. An EMAIL body''s {{placeholders}} are validated against template_variable rather than declared in an array, because the body names its own and a second declaration would drift.';
```

- [ ] **Step 4: Register the isolation file**

In `scripts/verify-isolation-suite.mjs`, add after the `station-settings.test.ts` entry:

```js
  // Block 29b-1. Five cases over the marketing door, and the floor is the full
  // count because three have no other proof anywhere.
  //
  // 64_template_channel.test.sql holds the shape and the grants as superuser
  // with a null auth.uid(), where has_permission answers true unconditionally.
  // It cannot see: that templates.view alone is REFUSED; that a SECOND marketing
  // template may exist beside the first (the case the narrowed index exists for,
  // and which raises 23505 against the old one); and that an update by id lands
  // on the same row rather than inserting a second.
  { path: 'tests/isolation/marketing-templates.test.ts', minTests: 5 },
```

- [ ] **Step 5: Run to verify it passes**

Run: `npm run db:reset && npx vitest run --config vitest.isolation.config.ts tests/isolation/marketing-templates.test.ts 2>&1 | tail -8`
Expected: `Tests 5 passed (5)`.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/0225_marketing_template_door.sql tests/isolation/marketing-templates.test.ts scripts/verify-isolation-suite.mjs
git commit -m "feat(templates): the door a template without a purpose is written through"
```

---

### Task 5: The variable vocabulary in TypeScript

**Files:**
- Create: `src/lib/templates/variables.ts`, `tests/unit/template-variables.test.ts`

**Interfaces:**
- Consumes: `Enums<'template_variable'>` from the regenerated database types.
- Produces:
  `export type TemplateVariable = Enums<'template_variable'>`
  `export const CAMPAIGN_RESOLVABLE: Record<TemplateVariable, boolean>`
  `export const CAMPAIGN_VARIABLES: TemplateVariable[]`
  `export function namedPlaceholder(v: TemplateVariable): string`
  `export function variableFromPlaceholder(name: string): TemplateVariable | null`

- [ ] **Step 1: Regenerate the database types**

Run: `npm run db:reset && npm run db:types`
Expected: `src/lib/supabase/database.types.ts` gains `message_channel` and `template_variable` under `Enums`.

- [ ] **Step 2: Write the failing test**

Create `tests/unit/template-variables.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  CAMPAIGN_RESOLVABLE,
  CAMPAIGN_VARIABLES,
  namedPlaceholder,
  variableFromPlaceholder,
} from '@/lib/templates/variables';

describe('the template variable vocabulary', () => {
  it('says which family every value is in', () => {
    // Totality is the compiler's job; this asserts the SPLIT, which the
    // compiler cannot check. A value moved to the wrong family would let 29d
    // offer a campaign something no campaign can resolve.
    expect(CAMPAIGN_RESOLVABLE.LISTENER_FIRST_NAME).toBe(true);
    expect(CAMPAIGN_RESOLVABLE.STATION_NAME).toBe(true);
    expect(CAMPAIGN_RESOLVABLE.PRIZE_NAME).toBe(false);
    expect(CAMPAIGN_RESOLVABLE.PICKUP_DEADLINE).toBe(false);
    expect(CAMPAIGN_RESOLVABLE.VERIFICATION_CODE).toBe(false);
  });

  it('offers a campaign exactly the resolvable four', () => {
    expect(CAMPAIGN_VARIABLES).toEqual([
      'LISTENER_FIRST_NAME',
      'LISTENER_FULL_NAME',
      'LISTENER_CITY',
      'STATION_NAME',
    ]);
  });

  it('derives the email notation from the enum rather than declaring it twice', () => {
    expect(namedPlaceholder('LISTENER_FIRST_NAME')).toBe('{{listener_first_name}}');
    expect(namedPlaceholder('STATION_NAME')).toBe('{{station_name}}');
  });

  it('reads a placeholder back to its value', () => {
    expect(variableFromPlaceholder('listener_city')).toBe('LISTENER_CITY');
  });

  it('answers null for a placeholder that names nothing', () => {
    // The screen offers a closed list, so this is a hand-edited body -- and it
    // must be refused rather than substituted with an empty string, which is
    // how a listener reads "Oi !" and nobody finds out.
    expect(variableFromPlaceholder('listener_shoe_size')).toBeNull();
  });

  it('round-trips every value in the vocabulary', () => {
    for (const value of Object.keys(CAMPAIGN_RESOLVABLE) as (keyof typeof CAMPAIGN_RESOLVABLE)[]) {
      const placeholder = namedPlaceholder(value).slice(2, -2);
      expect(variableFromPlaceholder(placeholder)).toBe(value);
    }
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `npx vitest run tests/unit/template-variables.test.ts 2>&1 | tail -8`
Expected: FAIL — cannot resolve `@/lib/templates/variables`.

- [ ] **Step 4: Write the module**

Create `src/lib/templates/variables.ts`:

```ts
import type { Enums } from '@/lib/supabase/database.types';

/**
 * What a template may substitute. `template_variable` (0222), derived rather
 * than re-declared for the reason `lib/conversation/steps.ts` gives for
 * `RequestedField`: a hand-written union here would be a second place an eighth
 * value has to be added, and the two would disagree in silence.
 */
export type TemplateVariable = Enums<'template_variable'>;

/**
 * Whether a campaign can fill this value from the row it already reads.
 *
 * TOTAL OVER THE ENUM, and that is the only reason it exists as a record rather
 * than as two arrays: an eighth value does not compile until somebody says
 * which family it is in. The database cannot hold this fact — it is a statement
 * about what 29d's send loop has in hand — and a comment could not be checked.
 *
 * `false` does not mean unusable. The three false values are what the SYSTEM
 * templates carry, supplied by the specific caller that enqueues them
 * (`enqueue_pickup_reminder` computes the prize and the deadline;
 * `widget_request_code` mints the code). A campaign has none of those and never
 * will, which is why offering them would be offering a blank.
 */
export const CAMPAIGN_RESOLVABLE: Record<TemplateVariable, boolean> = {
  LISTENER_FIRST_NAME: true,
  LISTENER_FULL_NAME: true,
  LISTENER_CITY: true,
  STATION_NAME: true,
  PRIZE_NAME: false,
  PICKUP_DEADLINE: false,
  VERIFICATION_CODE: false,
};

/** The values a campaign may offer, in the enum's own order. */
export const CAMPAIGN_VARIABLES = (
  Object.keys(CAMPAIGN_RESOLVABLE) as TemplateVariable[]
).filter((value) => CAMPAIGN_RESOLVABLE[value]);

/**
 * The email notation for a value: `{{listener_first_name}}`.
 *
 * DERIVED, never declared. WhatsApp takes positional `{{1}}` because that is
 * what the Cloud API accepts, and email takes a name because a body is
 * self-describing — but both notations name the SAME vocabulary, and spelling
 * the second one out in a table would be the copy that goes stale.
 */
export function namedPlaceholder(value: TemplateVariable): string {
  return `{{${value.toLowerCase()}}}`;
}

/**
 * The value a placeholder names, or null.
 *
 * Null rather than a guess: the screen offers a closed list, so a name that
 * resolves to nothing is a hand-edited body, and substituting an empty string
 * for it is how a listener reads "Oi !" and nobody finds out.
 */
export function variableFromPlaceholder(name: string): TemplateVariable | null {
  const match = (Object.keys(CAMPAIGN_RESOLVABLE) as TemplateVariable[]).find(
    (value) => value.toLowerCase() === name.toLowerCase(),
  );
  return match ?? null;
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `npx vitest run tests/unit/template-variables.test.ts 2>&1 | tail -6`
Expected: `Tests 6 passed (6)`.

- [ ] **Step 6: Commit**

```bash
git add src/lib/templates/variables.ts tests/unit/template-variables.test.ts src/lib/supabase/database.types.ts
git commit -m "feat(templates): one vocabulary, two notations, and the second derived"
```

---

### Task 6: The frame, and the escaping that dispenses with a sanitiser

**Files:**
- Create: `src/lib/mailer/frame.ts`, `tests/unit/mailer-frame.test.ts`

**Interfaces:**
- Consumes: `TemplateVariable`, `namedPlaceholder` (Task 5).
- Produces:
  `export interface FrameInput { stationName: string; logoUrl: string | null; body: string; unsubscribe?: { url: string; label: string } | null }`
  `export function renderCampaignEmail(input: FrameInput): { html: string; text: string }`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/mailer-frame.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { renderCampaignEmail } from '@/lib/mailer/frame';

const base = { stationName: 'Rádio Pulcha FM', logoUrl: null, body: 'Oi Ana!' };

describe('the campaign email frame', () => {
  it('ESCAPES the operator text — the assertion this module exists for', () => {
    // The whole security argument of Block 29b-1's D2: the operator writes
    // text, the frame is ours, and the text is escaped on the way in. There is
    // no path by which third-party HTML reaches a recipient, which is why this
    // codebase still needs no sanitiser.
    const { html } = renderCampaignEmail({
      ...base,
      body: '<script>alert(1)</script> & "quoted"',
    });
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&amp;');
    expect(html).toContain('&quot;');
  });

  it('escapes the Station name too, which is operator-typed as well', () => {
    const { html } = renderCampaignEmail({ ...base, stationName: 'Rádio <b>X</b>' });
    expect(html).not.toContain('<b>X</b>');
    expect(html).toContain('&lt;b&gt;');
  });

  it('keeps the operator line breaks, because a paragraph is what they typed', () => {
    const { html } = renderCampaignEmail({ ...base, body: 'linha um\nlinha dois' });
    expect(html).toContain('linha um<br />linha dois');
  });

  it('carries the Station name as the logo alt, so a blocked image still reads', () => {
    // Email clients block remote images by default. Without this the header is
    // an empty box on the first open of most campaigns ever sent.
    const { html } = renderCampaignEmail({ ...base, logoUrl: 'https://cdn/x.png' });
    expect(html).toContain('alt="Rádio Pulcha FM"');
  });

  it('renders no image tag at all when the Station has no logo', () => {
    const { html } = renderCampaignEmail(base);
    expect(html).not.toContain('<img');
    expect(html).toContain('Rádio Pulcha FM');
  });

  it('returns the operator text unframed as the plain-text half', () => {
    // MailMessage carries both (src/lib/mailer/index.ts). The text half is what
    // a client refusing HTML shows, and it is the operator's own words.
    const { text } = renderCampaignEmail({ ...base, body: 'Oi Ana!\nTudo bem?' });
    expect(text).toBe('Oi Ana!\nTudo bem?');
  });

  it('leaves the unsubscribe seam empty until something fills it', () => {
    // 29c fills this. The slot ships empty because reopening the frame later is
    // dearer than leaving the seam.
    const { html } = renderCampaignEmail(base);
    // No anchor at all, rather than "no such word": the seam is empty when the
    // frame renders no link, and only that is checkable without naming copy
    // this module does not own.
    expect(html).not.toContain('<a ');
  });

  it('renders the unsubscribe link with the caller-supplied label', () => {
    // The label is the caller's, never ours: this module has no access to the
    // i18n catalogues, and a word hardcoded here would be the one piece of
    // untranslated copy in a message otherwise entirely in the reader's
    // language.
    const { html } = renderCampaignEmail({
      ...base,
      unsubscribe: { url: 'https://app.example/u/abc', label: 'Cancelar inscrição' },
    });
    expect(html).toContain('https://app.example/u/abc');
    expect(html).toContain('Cancelar inscrição');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/unit/mailer-frame.test.ts 2>&1 | tail -6`
Expected: FAIL — cannot resolve `@/lib/mailer/frame`.

- [ ] **Step 3: Write the module**

Create `src/lib/mailer/frame.ts`:

```ts
/**
 * The one HTML frame every campaign e-mail is sent in.
 *
 * WHY THERE IS EXACTLY ONE, and why an operator cannot supply their own
 * (Block 29b-1, D2). The original request asked for an HTML body AND for
 * messages "compatible with e-mail clients"; those pull apart. E-mail HTML is
 * not web HTML — tables, inline CSS, and Outlook deforming what every browser
 * accepts — and an editor that produces browser markup produces mail that
 * arrives broken. One frame, tested once, renders the same way everywhere.
 *
 * ESCAPING IS THE SECURITY PROPERTY, and it is what dispenses with a sanitiser.
 * The operator writes TEXT. It is escaped on its way in and is never
 * interpreted as markup, so there is no path by which third-party HTML reaches
 * a recipient — and this codebase, which uses `dangerouslySetInnerHTML` nowhere
 * and depends on no sanitiser, keeps both of those true.
 *
 * INLINE STYLES ONLY, and no external stylesheet: `<style>` blocks are stripped
 * by several clients and `<link>` by all of them.
 */
export interface FrameInput {
  stationName: string;
  /** `companies.thumb_url`, or null when the Station has no picture. */
  logoUrl: string | null;
  /** The operator's text, with variables already substituted. */
  body: string;
  /**
   * Block 29c fills this. Null or absent leaves the seam empty.
   *
   * The URL and its label travel together in one object so that the compiler
   * refuses a link with no text. The label belongs to the caller because this
   * module cannot reach the i18n catalogues, and the recipient reads the whole
   * message in one language.
   */
  unsubscribe?: { url: string; label: string } | null;
}

/**
 * The five characters that can change the meaning of markup. `'` is escaped as
 * a numeric reference rather than `&apos;`, which Outlook's older engines do
 * not recognise.
 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function renderCampaignEmail(input: FrameInput): { html: string; text: string } {
  const station = escapeHtml(input.stationName);

  // Escaped first, then the line breaks the operator typed are restored as
  // markup. The order matters: doing it the other way round would let a body
  // containing the literal text "<br />" become a real line break.
  const body = escapeHtml(input.body).replace(/\r?\n/g, '<br />');

  // The Station's name is the alt text AND appears beside the picture, because
  // e-mail clients block remote images by default: somebody who never unblocks
  // them reads the name rather than an empty box.
  const header = input.logoUrl
    ? `<img src="${escapeHtml(input.logoUrl)}" alt="${station}" width="40" height="40" style="vertical-align:middle;border:0;" /> <span style="vertical-align:middle;">${station}</span>`
    : `<span>${station}</span>`;

  const footer = input.unsubscribe
    ? `<a href="${escapeHtml(input.unsubscribe.url)}" style="color:#666;">${escapeHtml(input.unsubscribe.label)}</a>`
    : '';

  const html = [
    '<!doctype html>',
    '<html><body style="margin:0;padding:0;background:#f4f4f5;">',
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;padding:24px 0;">',
    '<tr><td align="center">',
    '<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border-radius:8px;font-family:Arial,Helvetica,sans-serif;">',
    `<tr><td style="padding:16px 24px;border-bottom:1px solid #e4e4e7;font-size:16px;font-weight:bold;color:#18181b;">${header}</td></tr>`,
    `<tr><td style="padding:24px;font-size:15px;line-height:1.5;color:#27272a;">${body}</td></tr>`,
    `<tr><td style="padding:16px 24px;border-top:1px solid #e4e4e7;font-size:12px;color:#71717a;">${station}${footer ? ' · ' + footer : ''}</td></tr>`,
    '</table>',
    '</td></tr></table>',
    '</body></html>',
  ].join('');

  // The plain-text half of MailMessage (src/lib/mailer/index.ts) is the
  // operator's own words, unframed: it is what a client refusing HTML shows,
  // and a stripped-down copy of the frame would be a second thing to keep in
  // step for no gain.
  return { html, text: input.body };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/unit/mailer-frame.test.ts 2>&1 | tail -6`
Expected: `Tests 8 passed (8)`.

- [ ] **Step 5: Prove the escaping test bites**

Temporarily change `renderCampaignEmail` to interpolate `input.body` without `escapeHtml`. Re-run the test.
Expected: the first case fails on `expect(html).not.toContain('<script>')`. Restore the escape.

- [ ] **Step 6: Commit**

```bash
git add src/lib/mailer/frame.ts tests/unit/mailer-frame.test.ts
git commit -m "feat(mailer): one frame, and the escape that means no sanitiser"
```

---

### Task 7: The Station's e-mail identity

**Files:**
- Create: `supabase/migrations/0226_station_email_identity.sql`, `src/app/(app)/app/station-email-tab.tsx`
- Modify: `src/app/(app)/app/station-settings.tsx`, `src/app/(app)/app/page.tsx`, `supabase/tests/64_template_channel.test.sql`

**Interfaces:**
- Consumes: the Station settings dialog Block 29a created.
- Produces: `companies.email_from_name`, `companies.email_from_address`, `companies.email_reply_to`; `save_station_email_identity(p_company_id uuid, p_from_name text, p_from_address text, p_reply_to text) returns void`; a second tab in the dialog.

- [ ] **Step 1: Write the failing pgTAP**

Bump the plan to `select plan(25);` and append before `finish()`:

```sql
-- Task 7. The Station's own sender identity.
select has_column('public', 'companies', 'email_from_address', 'companies carries a sender address');

select has_function('public', 'save_station_email_identity',
  array['uuid','text','text','text'],
  'and a door to set it');

-- The gate is the OWNER, not templates.manage: this is the address every
-- campaign of this Station goes out as, and it is a fact about the business
-- rather than about a text somebody wrote.
select ok(
  (select prosrc from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'save_station_email_identity')
    like '%is_owner_of_company%',
  'only the Organization owner may change who a Station''s mail comes from');
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run db:reset && npm run db:test 2>&1 | grep -c "not ok"`
Expected: a non-zero count, the three new assertions among them.

- [ ] **Step 3: Write the migration**

Create `supabase/migrations/0226_station_email_identity.sql`:

```sql
-- supabase/migrations/0226_station_email_identity.sql

-- Block 29b-1, Task 7. Who a Station's campaign mail comes from (design D4).
--
-- ON THE STATION, ONCE, rather than on every template. A Station with thirty
-- templates would otherwise carry thirty chances for the same address to be
-- wrong, and the operator creating the thirtieth would type it again. A
-- template may still override (message_templates.from_*, 0223); the ordinary
-- case sets nothing there.
--
-- NULLABLE, ALL THREE. A Station that has configured none falls back to the
-- installation's MAIL_FROM, which is already what invitations, password resets
-- and the health alert do.
--
-- NOT THE STATION'S EXISTING CONTACT E-MAIL, deliberately. They answer
-- different questions -- one is how to reach the radio, the other is what
-- address a campaign is sent from. They usually coincide and are not the same
-- thing, and the day a Station changes its commercial contact is not the day
-- thirty thousand e-mails should start arriving from a different sender.

alter table public.companies
  add column email_from_name    text,
  add column email_from_address text,
  add column email_reply_to     text;

-- Deliberately weak, and for companies_thumb_shape's (0153) reason: a stricter
-- pattern refuses valid addresses, and this column is typed by an operator
-- reading it off whatever their provider gave them.
alter table public.companies
  add constraint companies_email_from_shape
    check (email_from_address is null or email_from_address like '%@%'),
  add constraint companies_email_reply_to_shape
    check (email_reply_to is null or email_reply_to like '%@%');

comment on column public.companies.email_from_address is
  'What a campaign e-mail is sent AS for this Station, or null to fall back to the installation''s MAIL_FROM. DELIVERABILITY RESTS ON THE INSTALLATION''S DOMAIN (Block 29 brief, D5): the transport is one installation-wide SMTP, so an address on a domain the installation cannot sign with SPF and DKIM lands in spam. The warning belongs on the screen where this is chosen, which is why the field is here and not on thirty templates.';

-- ---------------------------------------------------------------------------
-- The door. THE GATE IS THE OWNER, not templates.manage.
--
-- templates.manage is a grant handed out for writing texts. This is the address
-- every campaign of the Station goes out as, and getting it wrong sends thirty
-- thousand e-mails from somewhere the recipients do not recognise. It is the
-- same predicate the pairing card is gated on (0218's own reasoning), and
-- is_owner_of_company (0044) is true for the platform admin as well, which is
-- the house convention and the intended reading for support.
-- ---------------------------------------------------------------------------
create function public.save_station_email_identity(
  p_company_id  uuid,
  p_from_name   text default null,
  p_from_address text default null,
  p_reply_to    text default null
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
  if not public.is_owner_of_company(p_company_id) then
    raise log 'save_station_email_identity denied: actor=% company=%', v_actor, p_company_id;
    raise exception 'permission denied: organization owner required' using errcode = '42501';
  end if;

  update public.companies
     set email_from_name    = nullif(btrim(p_from_name), ''),
         email_from_address = nullif(btrim(p_from_address), ''),
         email_reply_to     = nullif(btrim(p_reply_to), ''),
         updated_at         = now()
   where id = p_company_id and deleted_at is null
  returning organization_id into v_org;

  if v_org is null then
    raise exception 'station not found: %', p_company_id using errcode = 'P0002';
  end if;

  -- The addresses themselves are in the detail: they are not secrets, they are
  -- what an audit reader asking "why did mail start arriving from there" needs.
  insert into public.audit_logs
    (actor_id, action, target_table, target_id, organization_id, company_id, detail)
  values
    (v_actor, 'save_station_email_identity', 'companies', p_company_id, v_org, p_company_id,
     jsonb_build_object('from_address', nullif(btrim(p_from_address), ''),
                        'reply_to', nullif(btrim(p_reply_to), '')));
end;
$$;

revoke execute on function public.save_station_email_identity(uuid, text, text, text) from public;
grant execute on function public.save_station_email_identity(uuid, text, text, text) to authenticated;

comment on function public.save_station_email_identity(uuid, text, text, text) is
  'Sets who this Station''s campaign e-mail comes from. Gated on is_owner_of_company (0044) rather than on templates.manage: that grant is handed out for writing texts, and this is the address thirty thousand e-mails go out as. All three columns are clearable -- the form sets every field it takes on every call, so a blank means "fall back to the installation''s MAIL_FROM".';
```

- [ ] **Step 4: Write the tab**

Create `src/app/(app)/app/station-email-tab.tsx`:

```tsx
'use client';

import { useActionState } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { saveStationEmailIdentityAction, type EmailIdentityState } from './actions';

const IDLE: EmailIdentityState = { status: 'idle' };

export interface StationEmailIdentity {
  fromName: string | null;
  fromAddress: string | null;
  replyTo: string | null;
}

/**
 * Who this Station's campaign e-mail comes from.
 *
 * THE WARNING LIVES HERE, beside the field it is about. Block 29's D5 put the
 * transport on one installation-wide SMTP, so deliverability rests on the
 * installation's domain: an address on a domain the installation cannot sign
 * lands in spam. Repeating that on thirty template forms would be thirty places
 * to read it and none to act on it.
 */
export function StationEmailTab({
  companyId,
  initial,
}: {
  companyId: string;
  initial: StationEmailIdentity;
}) {
  const t = useTranslations('app');
  const [state, save, pending] = useActionState(saveStationEmailIdentityAction, IDLE);

  return (
    <form action={save} className="flex flex-col gap-3">
      <input type="hidden" name="companyId" value={companyId} />

      <p className="rounded-md border border-dashed p-3 text-xs text-muted-foreground">
        {t('emailIdentityDomainWarning')}
      </p>

      <label className="flex flex-col gap-1 text-sm">
        <span className="text-muted-foreground">{t('emailFromName')}</span>
        <Input name="fromName" defaultValue={initial.fromName ?? ''} maxLength={120}
               data-testid="station-email-from-name" />
      </label>

      <label className="flex flex-col gap-1 text-sm">
        <span className="text-muted-foreground">{t('emailFromAddress')}</span>
        <Input name="fromAddress" type="email" defaultValue={initial.fromAddress ?? ''}
               maxLength={200} data-testid="station-email-from-address" />
      </label>

      <label className="flex flex-col gap-1 text-sm">
        <span className="text-muted-foreground">{t('emailReplyTo')}</span>
        <Input name="replyTo" type="email" defaultValue={initial.replyTo ?? ''}
               maxLength={200} data-testid="station-email-reply-to" />
      </label>

      <div className="flex items-center gap-3">
        <Button type="submit" disabled={pending}>
          {pending ? t('saving') : t('save')}
        </Button>
        {state.status === 'error' && (
          <span className="text-sm text-destructive">{state.message}</span>
        )}
        {state.status === 'saved' && (
          <span className="text-sm text-muted-foreground">{t('saved')}</span>
        )}
      </div>
    </form>
  );
}
```

- [ ] **Step 5: Turn the dialog's single tab into two**

In `src/app/(app)/app/station-settings.tsx`, replace the one-tab `<span>` (the block carrying `data-testid="station-settings-tabs"`) with a two-button strip driven by local state, and render `StationEmailTab` when `tab === 'email'`. The WhatsApp branch keeps exactly what it renders today. Accept a new prop `emailIdentity: StationEmailIdentity` and pass it through.

In `src/app/(app)/app/page.tsx`, add `email_from_name, email_from_address, email_reply_to` to the `companies` select literal (**one string literal, never a concatenation** — PostgREST's types are inferred from it) and pass them into `<StationSettings … />`.

Add the server action `saveStationEmailIdentityAction` to `src/app/(app)/app/actions.ts`, following the shape of the actions in `src/app/(app)/messages/templates/actions.ts`: parse with a Zod schema, call the RPC through `asCaller`, `revalidatePath('/app')`, and map the error with the module's `describe…Error`.

- [ ] **Step 6: Run the gates**

Run: `npm run db:reset && npm run db:test 2>&1 | tail -6 && npx tsc --noEmit && npm run lint 2>&1 | tail -2`
Expected: `Result: PASS`, no TypeScript output, `✔ No ESLint warnings or errors`.

- [ ] **Step 7: Commit**

```bash
git add supabase/migrations/0226_station_email_identity.sql supabase/tests/64_template_channel.test.sql "src/app/(app)/app" messages
git commit -m "feat(stations): who a Station's mail comes from, once rather than per template"
```

---

### Task 8: The service and the schema learn the new shape

**Files:**
- Modify: `src/schemas/templates.ts`, `src/services/templates.ts`, `src/app/(app)/messages/templates/page.tsx`

**Interfaces:**
- Consumes: `TemplateVariable`, `variableFromPlaceholder` (Task 5); `save_marketing_template` (Task 4).
- Produces:
  `marketingTemplateSchema` (Zod) and `export type MarketingTemplateInput`;
  `RegisteredTemplate` gains `channel`, `internalName`, `description`, `subject`, `variables: TemplateVariable[]`;
  `saveMarketingTemplate(input, accessToken): Promise<string>`;
  `listTemplates(companyId): Promise<{ system: RegisteredTemplate[]; marketing: RegisteredTemplate[] }>`.

- [ ] **Step 1: Write the failing test**

Append to `tests/unit/template-variables.test.ts`:

```ts
import { marketingTemplateSchema } from '@/schemas/templates';

describe('marketingTemplateSchema', () => {
  const base = {
    companyId: '11111111-1111-1111-1111-111111111111',
    internalName: 'natal_2026',
    body: 'Oi {{listener_first_name}}!',
  };

  it('accepts an email template with a subject', () => {
    const r = marketingTemplateSchema.safeParse({
      ...base, channel: 'EMAIL', subject: 'Feliz Natal',
    });
    expect(r.success).toBe(true);
  });

  it('refuses an email template with no subject', () => {
    // The database CHECK refuses it too; catching it here is what turns a 23514
    // naming a constraint into a message beside the field that is empty.
    const r = marketingTemplateSchema.safeParse({ ...base, channel: 'EMAIL' });
    expect(r.success).toBe(false);
  });

  it('refuses an email body naming something outside the vocabulary', () => {
    const r = marketingTemplateSchema.safeParse({
      ...base, channel: 'EMAIL', subject: 'Oi', body: 'Oi {{listener_shoe_size}}!',
    });
    expect(r.success).toBe(false);
  });

  it('refuses a WhatsApp template with no name or language', () => {
    const r = marketingTemplateSchema.safeParse({ ...base, channel: 'WHATSAPP' });
    expect(r.success).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/unit/template-variables.test.ts 2>&1 | tail -6`
Expected: FAIL — `marketingTemplateSchema` is not exported.

- [ ] **Step 3: Add the schema**

Append to `src/schemas/templates.ts`:

```ts
import { variableFromPlaceholder } from '@/lib/templates/variables';

/**
 * What the marketing form posts.
 *
 * The channel-conditional rules are `superRefine`d rather than expressed as two
 * schemas, so the form has ONE parse and the error lands on the field that is
 * wrong. They restate what 0223's CHECK constraints hold structurally — which
 * is the point: the database is the authority and this is what turns a 23514
 * naming a constraint into a message beside an empty box.
 */
export const marketingTemplateSchema = z
  .object({
    templateId: z.string().uuid().optional(),
    companyId: z.string().uuid(),
    channel: z.enum(['WHATSAPP', 'EMAIL']),
    internalName: z.string().trim().min(1).max(120),
    description: z.string().trim().max(500).optional(),
    body: z.string().trim().min(1).max(MAX_MESSAGE_BODY),
    subject: z.string().trim().max(200).optional(),
    name: z.string().trim().max(512).optional(),
    language: z.string().trim().max(20).optional(),
    variables: z.array(z.string()).max(20).default([]),
    fromName: z.string().trim().max(120).optional(),
    fromEmail: z.string().trim().email().max(200).optional().or(z.literal('')),
    replyTo: z.string().trim().email().max(200).optional().or(z.literal('')),
  })
  .superRefine((value, ctx) => {
    if (value.channel === 'EMAIL') {
      if (!value.subject) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['subject'],
                       message: 'an e-mail needs a subject' });
      }
      // Every {{name}} the body uses must be a value this system substitutes.
      // Caught here rather than at the door so the operator sees WHICH name.
      for (const match of value.body.matchAll(/\{\{([a-z_]+)\}\}/g)) {
        if (variableFromPlaceholder(match[1] ?? '') === null) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['body'],
                         message: `this body names {{${match[1]}}}, which is not a value this system substitutes` });
        }
      }
      return;
    }

    if (!value.name || !value.language) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['name'],
                     message: 'a WhatsApp template needs the name and language Meta approved' });
    }
  });

export type MarketingTemplateInput = z.infer<typeof marketingTemplateSchema>;
```

- [ ] **Step 4: Extend the service**

In `src/services/templates.ts`: widen `RegisteredTemplate` with
`channel: 'WHATSAPP' | 'EMAIL'`, `internalName: string`, `description: string | null`,
`subject: string | null`, and retype `variables` to `TemplateVariable[]`
(dropping the `Array.isArray` narrowing, which existed because `jsonb` said
nothing about its shape and a typed array does). Add the columns to the select
literal. Split `listRegisteredTemplates` into `listTemplates` returning
`{ system, marketing }` partitioned on `purpose !== null`, and add:

```ts
export async function saveMarketingTemplate(
  input: MarketingTemplateInput,
  accessToken: string,
): Promise<string> {
  const { data, error } = await asCaller(accessToken).rpc('save_marketing_template', {
    p_id: input.templateId,
    p_company_id: input.companyId,
    p_channel: input.channel,
    p_internal_name: input.internalName,
    p_description: input.description,
    p_body: input.body,
    p_subject: input.subject,
    p_name: input.name,
    p_language: input.language,
    p_variables: input.variables,
    p_from_name: input.fromName,
    p_from_email: input.fromEmail,
    p_reply_to: input.replyTo,
  });
  if (error) throw mapTemplateError(error.code, error.message);
  if (typeof data !== 'string') throw new InternalError('save_marketing_template returned no id');
  return data;
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `npx vitest run tests/unit/template-variables.test.ts 2>&1 | tail -6 && npx tsc --noEmit`
Expected: `Tests 10 passed (10)`, no TypeScript output.

- [ ] **Step 6: Commit**

```bash
git add src/schemas/templates.ts src/services/templates.ts tests/unit/template-variables.test.ts
git commit -m "feat(templates): the shape the marketing form posts, and the read that splits the two families"
```

---

### Task 9: The screen

**Files:**
- Create: `src/app/(app)/messages/templates/marketing-grid.tsx`, `src/app/(app)/messages/templates/template-dialog.tsx`
- Modify: `src/app/(app)/messages/templates/page.tsx`, `src/app/(app)/messages/templates/actions.ts`, `src/app/(app)/messages/templates/template-registry.tsx`, `src/schemas/templates.ts`, `tests/unit/templates-schema.test.ts`, `messages/en.json`, `messages/pt.json`, `messages/es.json`

**Every key these screens render lands here, in all three catalogues** — the grid, the dialog, the channel badges, the preview, and the seven `variable_<VALUE>` labels. Task 10 verifies them; it does not add them. A screen shipped against keys the catalogues do not hold fails its own gate, which is the whole reason the keys travel with the screen.

**Interfaces:**
- Consumes: `listTemplates`, `saveMarketingTemplate` (Task 8), `renderCampaignEmail` (Task 6), `CAMPAIGN_VARIABLES` (Task 5).
- Produces: the two-group screen.

- [ ] **Step 1: Render the two groups**

`page.tsx` calls `listTemplates(selected.id)` and renders `<TemplateRegistry templates={system} … />` unchanged above `<MarketingGrid templates={marketing} … />`.

Move the existing notice — *"Templates are created and approved in Meta's own console"* — out of the page body and into the WhatsApp branch of the dialog. **In 29b-1 a WhatsApp template is still a transcription of something Meta approved elsewhere; an e-mail template is written here.** A screen that does not say which is which is a screen where somebody writes a WhatsApp marketing template and waits for a send that cannot happen.

- [ ] **Step 2: The grid**

`marketing-grid.tsx` renders internal name, a channel badge, description, `updated_at` with `updated_by`, and an Actions column (Edit, Archive). Above it, a channel `<Select>` filtering client-side over the already-loaded rows — **not** a navigation, because the whole list is in hand (design D6, no cursor pagination). A controlled `<select>` is safe here for the reason `members-filters.tsx` records; do not reach for a checkbox.

The empty state names the act: "No marketing templates yet — create one to send a campaign."

- [ ] **Step 3: The dialog**

`template-dialog.tsx` opens on `New template` and on `Edit`, with `Channel` first because every field below it depends on the answer:

| Channel | Fields |
|---|---|
| both | internal name, description, body |
| `EMAIL` | subject; `from name` / `from e-mail` / `reply-to` under a collapsed "override this Station's sender"; a variable palette inserting `{{listener_first_name}}` etc. from `CAMPAIGN_VARIABLES`; **Preview** |
| `WHATSAPP` | Meta's name, language, the positional variable list, the OTP flag, and the transcription notice |

**Preview** posts the body to a server action that returns `renderCampaignEmail(...).html`, shown in `<iframe sandbox srcdoc={html} />` — not because the HTML is doubtful, since this system generates all of it, but to keep intact the rule that this application never injects HTML into a page, which is true of every file in the repository today.

Give every conditionally rendered `<Button>` a distinct `key`. Two buttons in the same position without one let React reuse the DOM node and the survivor inherits `type="submit"` — which is how a participation was once recorded by a button nobody pressed.

- [ ] **Step 4: The system screen stops posting prose**

This step exists because §8 of the spec is wrong. It says the system group's screen is unchanged, and it is not: `register_message_template` now writes `template_variable[]`, so the free-text boxes in `template-registry.tsx` — where an operator types "nome do ouvinte" to describe what `{{1}}` carries — post values the door refuses. The screen would fail on every registration.

Three files move together, and they move together because they are one change:

`src/schemas/templates.ts`: retype `templateRegistrationSchema.variables` from `z.array(z.string().trim().min(1).max(MAX_VARIABLE_DESCRIPTION))` to an array over the closed vocabulary. `MAX_VARIABLE_DESCRIPTION` then has no remaining use — delete it rather than leave a constant nothing reads. Keep the `superRefine` that counts placeholders exactly as it is: the rule "one entry per `{{n}}`" is unchanged, and only what an entry may CONTAIN has narrowed.

`src/app/(app)/messages/templates/template-registry.tsx`: each positional input becomes a `<select>` over `CAMPAIGN_VARIABLES`, labelled `t(\`variable_${value}\`)`. The question the form asks is the same one it asked before — what does `{{1}}` carry — and the answer is now chosen instead of typed. The card that lists a registered template's variables (its `template.variables.map(...)`) renders the same labels rather than the raw enum tokens.

`tests/unit/templates-schema.test.ts`: its fixtures pass prose ("nome do ouvinte", "prêmio", "prazo") and several will now fail. Replace the values, keep every case. The case asserting a blank entry is rejected keeps its meaning — a value outside the vocabulary is refused — so rewrite it to assert that rather than deleting it.

- [ ] **Step 5: Run the gates**

Run: `npx tsc --noEmit && npm run lint 2>&1 | tail -2 && npx vitest run 2>&1 | tail -4`
Expected: clean, clean, all tests passing.

- [ ] **Step 6: Commit**

```bash
git add "src/app/(app)/messages/templates"
git commit -m "feat(templates): the system cards, and a grid for everything an operator writes"
```

---

### Task 10: i18n, the e2e, and the four pins no compiler sees

**Files:**
- Modify: `tests/unit/i18n/catalogue.test.ts`, `tests/e2e/templates.spec.ts`

- [ ] **Step 1: Verify the catalogues, do not add to them**

Every key this block introduces lands with the screen that renders it — Task 7's
in the `app` namespace, Task 9's in `templates`, including the seven
`variable_<VALUE>` labels. A screen that shipped referencing keys three files do
not hold would have failed its own gate, so by the time this task runs they are
all present.

So this step reads rather than writes: confirm `messages/en.json`,
`messages/pt.json` and `messages/es.json` each hold every key Tasks 7 and 9
reference, and that the three files agree. Add nothing here. A key added twice
is a conflict in three files at once, and `tests/unit/i18n/catalogue.test.ts`
would not catch it — it checks parity between the languages, not which task put
a key there.

The `app` namespace is **not** this task's. Task 7's tab cannot render without its own labels, so `emailFromName`, `emailFromAddress`, `emailReplyTo`, `emailIdentityDomainWarning`, `tabEmail`, `save`, `saving` and `saved` all land with Task 7. Adding them again here would be a merge conflict against a file three languages wide. Verify they are present; do not re-add them.

Operator strings in English, Portuguese and Spanish. **Only template bodies and subjects are Portuguese**, and those are data rather than copy.

- [ ] **Step 2: Guard the keys built at the call site**

The variable palette labels each value with `t(\`variable_${value}\`)`, which
`tests/unit/i18n/usage.test.ts` cannot see — it reads the source with a regular
expression. Add to `tests/unit/i18n/catalogue.test.ts`, inside the existing
`describe('the keys built at the call site')`:

```ts
  it.each(CAMPAIGN_VARIABLES)('the palette can label %s', (value) => {
    expect(
      catalogue.templates?.[`variable_${value}`],
      `templates.variable_${value} is missing`,
    ).toBeTruthy();
  });
```

- [ ] **Step 3: Extend the e2e**

In `tests/e2e/templates.spec.ts`, after the existing WhatsApp registration steps, add: open `New template`, choose `Email`, fill internal name, subject and a body using `{{listener_first_name}}`, save, assert the row appears in the marketing grid, open the preview and assert the iframe carries the Station's name. Then assert the database directly — `channel = 'EMAIL'`, `purpose is null`, `variables = []` — because a Server Action answering `saved` proves the round trip reached the action and not that anything was written.

- [ ] **Step 4: Run the whole gate set, in the order that gives an honest verdict**

```bash
npm run db:reset
npm run db:test
npm run test:isolation
npx tsc --noEmit
npm run lint
npx vitest run
CI=1 npx playwright test tests/e2e/templates.spec.ts --workers=1
```

Expected: `Result: PASS`; the isolation suite complete; no TypeScript output; no ESLint output; every unit test passing; the spec green.

**If the isolation wrapper reports INCOMPLETE:** it is very likely the
pre-existing `Worker exited unexpectedly` crash, not this branch. Confirm before
blaming the code by running once with your own reporter and comparing the JSON
against the summary line:

```bash
npx vitest run --config vitest.isolation.config.ts \
  --reporter=default --reporter=json --outputFile=/tmp/iso.json
```

A JSON report listing every file with zero failures beside a short summary line
is that crash, which the script's own header documents.

- [ ] **Step 5: Search for the pins no compiler holds**

```bash
grep -rn "toHaveCount(\|toHaveLength(" tests/ | grep -iE "template|message"
grep -rn "has_function(" supabase/tests/ | grep -i template
```

Any count this block moved must be updated by hand. Adding a value to
`system_message_key` in the gender block moved four such pins and the compiler
saw none of them.

- [ ] **Step 6: Commit**

```bash
git add messages tests
git commit -m "feat(templates): three catalogues, the palette guard, and the journey through an e-mail template"
```

---

## Self-review

**Spec coverage.** §3's columns → Task 2. §3's index and the `ON CONFLICT`
consequence → Task 2 (one task, by the spec's own argument). §3's
`enqueue_whatsapp_outbound` term → Task 3. §3's backfill → Task 2, asserted in
pgTAP. §4's vocabulary → Tasks 1 and 5. §4's two notations → Task 5. §5's frame,
escaping, alt text and unsubscribe seam → Task 6. §6's Station identity and
domain warning → Task 7. §7's two doors → Tasks 2 and 4. §8's screen → Task 9.
§9's test table → spread across the tasks that own each behaviour, with the e2e
and the pin search in Task 10.

**Placeholders.** None: every code step carries the code, every test step the
assertions, every run step the exact command and expected output.

**Type consistency.** `TemplateVariable`, `CAMPAIGN_RESOLVABLE`,
`CAMPAIGN_VARIABLES`, `namedPlaceholder` and `variableFromPlaceholder` are
defined in Task 5 and used under those names in Tasks 8, 9 and 10.
`renderCampaignEmail` and `FrameInput` are defined in Task 6 and used in Task 9.
`save_marketing_template`'s parameter list is written once in Task 4 and called
with the same names in Task 8. `StationEmailIdentity` is defined in Task 7 and
consumed by the page in the same task.

**One gap found and closed while reviewing:** the spec's §3 says `variables`
becomes `template_variable[]` and its §7 says `register_message_template` keeps
its signature — which are only compatible if the parameter stays `jsonb` and is
cast inside the body. Task 2's migration does exactly that and says why, because
the obvious "tidy-up" is to widen the parameter, and that would drop the ACL.
