# Block 4a — Promotions and the quiz — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the promotion record — its window, its WhatsApp settings and its quiz — as a grid plus a tabbed dialog, with the database refusing every incoherent state the spec names.

**Architecture:** Three tables (`promotions`, `promotion_questions`, `promotion_question_options`), all writes through `SECURITY DEFINER` RPCs gated on a permission code, read through RLS policies keyed on `has_permission('promotions.view', company_id)`. The screen follows the Block 3c pattern exactly: a keyset-paginated grid whose list query never re-runs, with the record opening as a dialog over it.

**Tech Stack:** Postgres 15 (Supabase), PL/pgSQL, pgTAP, Next.js 15 App Router, React 19, TypeScript, Zod, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-07-29-block-4a-promotions-design.md`. Decisions D1–D12 there are settled with the owner and must not be relitigated.

## Global Constraints

- **Migrations are strictly additive.** No existing table changes shape; no existing policy is widened. The single exception is `member_consents`, which gains the foreign key its own `0032` comment promised.
- **No table takes an `insert`, `update` or `delete` grant from any role, `service_role` included.** Every write goes through a `SECURITY DEFINER` RPC. This is the rule `0029` established.
- **Every RPC checks its permission itself**, beside the operation, not inside a shared helper — `0027`'s comment says why.
- **Every RPC writes an `audit_logs` row** naming the action, and never puts personal data in `detail`.
- **English everywhere** — identifiers, comments, copy, test names. The project's vocabulary: Station (never "radio"), Organization, Member.
- **`set search_path = pg_catalog, public`** on every function. `digest()` lives in `extensions` and must be fully qualified if ever used.
- **Comments explain why, not what.** A comment restating the code is worse than none.
- **After any migration change, regenerate types:** `npm run db:types`.
- **Local stack sequence that works:** `npx supabase db reset` → `docker restart supabase_kong_CRM_-_LISTENER` → wait ~10s → run tests. Skipping the Kong restart makes every auth call return 502 and every spec fail with `could not create admin: {}`, which reads exactly like broken code and is not.
- **Never run `npm run build` while `npm run dev` is running.** Both write `.next` and the dev server starts 404ing on chunks.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `supabase/migrations/0040_promotions.sql` | Extension, enums, the `promotions` table, its constraints and indexes, permission catalogue rows, the `member_consents` foreign key |
| `supabase/migrations/0041_promotion_questions.sql` | `promotion_questions`, `promotion_question_options`, composite keys and checks |
| `supabase/migrations/0042_promotion_rpcs.sql` | `create_promotion`, `update_promotion`, `cancel_promotion`, `archive_promotion` |
| `supabase/migrations/0043_promotion_question_rpcs.sql` | `save_promotion_question`, `remove_promotion_question` |
| `supabase/migrations/0044_rls_promotions.sql` | Grants, `is_owner_of_company`, the three select policies |
| `supabase/tests/03_promotions.test.sql` | pgTAP over every constraint in spec §4 |
| `src/schemas/promotions.ts` | Zod schemas — the form's shape, shared by server and client |
| `src/services/promotions.ts` | Reads (keyset list, whole record) and RPC wrappers |
| `src/app/(app)/promotions/list-params.ts` | The URL contract for filters, sort and cursor |
| `src/app/(app)/promotions/page.tsx` | Server Component: reads params, renders filters + grid |
| `src/app/(app)/promotions/promotions-filters.tsx` | Client filter form |
| `src/app/(app)/promotions/promotions-grid.tsx` | Client grid, row actions, dialog host |
| `src/app/(app)/promotions/promotion-record-dialog.tsx` | The tabbed record dialog |
| `src/app/(app)/promotions/record.ts` | `getPromotionRecordAction` — one read for the whole record |
| `src/app/(app)/promotions/actions.ts` | Server actions wrapping the RPCs |
| `src/app/(app)/promotions/format.ts` | Situation labels, field labels, question-kind labels |
| `src/app/(app)/promotions/errors.ts` | Postgres error code → sentence |
| `tests/unit/promotions-schema.test.ts` | Schema rules |
| `tests/isolation/promotions.test.ts` | Every RPC and read under a real delegate JWT |
| `tests/e2e/promotions-flow.spec.ts` | The dialog over the list, and the list never re-queried |
| `docs/block-4a-report.md` | Verification report |

---

## Task 1: The promotions table

**Files:**
- Create: `supabase/migrations/0040_promotions.sql`
- Create: `supabase/tests/03_promotions.test.sql`

**Interfaces:**
- Produces: table `public.promotions`; types `public.promotion_requested_field`, `public.promotion_question_kind`; function `public.has_no_duplicates(anyarray)`; permission codes `promotions.view|create|edit|cancel|archive`.

- [ ] **Step 1: Write the failing pgTAP file**

Create `supabase/tests/03_promotions.test.sql`. It runs inside a transaction that is rolled back, like the other two.

```sql
begin;
select plan(24);

-- Structure
select has_table('public', 'promotions', 'promotions exists');
select has_type('public', 'promotion_requested_field', 'the requested-field enum exists');
select is(relrowsecurity, true, 'RLS enabled on promotions')
  from pg_class where oid = 'public.promotions'::regclass;
select ok(not has_table_privilege('authenticated', 'public.promotions', 'INSERT'),
          'authenticated may not insert a promotion directly');
select ok(not has_table_privilege('service_role', 'public.promotions', 'UPDATE'),
          'service_role may not update a promotion directly');

-- The permission catalogue gained this block's codes.
select is(
  (select count(*)::int from public.permissions where code like 'promotions.%'),
  5, 'five promotion permissions are catalogued');

-- A Station to hang the rows off. provision_customer needs a profiles row,
-- which the admin API does not create, so insert the auth user and profile
-- directly — this is a pgTAP transaction, not the application path.
insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
                        email_confirmed_at, created_at, updated_at)
values ('00000000-0000-0000-0000-0000000000aa',
        '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
        'promo-pgtap@example.test', '', now(), now(), now());
insert into public.profiles (id, full_name) values
  ('00000000-0000-0000-0000-0000000000aa', 'pgTAP');
insert into public.organizations (id, name) values
  ('00000000-0000-0000-0000-0000000000b1', 'Org pgTAP');
insert into public.companies (id, organization_id, name, timezone) values
  ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000b1',
   'Station pgTAP', 'America/Sao_Paulo');

-- Baseline: the minimum legal promotion.
prepare legal as
  insert into public.promotions
    (organization_id, company_id, name, starts_at, ends_at)
  values
    ('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000c1',
     'Baseline', '2026-08-01Z', '2026-08-31Z');
select lives_ok('legal', 'a promotion with only a name and a window is legal');

-- §4, one case per row of the table.
select throws_ok(
  $$insert into public.promotions (organization_id, company_id, name, starts_at, ends_at)
    values ('00000000-0000-0000-0000-0000000000b1','00000000-0000-0000-0000-0000000000c1',
            'Inverted', '2026-08-31Z', '2026-08-01Z')$$,
  '23514', null, 'an inverted window is refused');

select throws_ok(
  $$insert into public.promotions (organization_id, company_id, name, starts_at, ends_at,
                                   whatsapp_enabled)
    values ('00000000-0000-0000-0000-0000000000b1','00000000-0000-0000-0000-0000000000c1',
            'No hashtag', '2026-09-01Z', '2026-09-30Z', true)$$,
  '23514', null, 'WhatsApp enabled without a hashtag is refused');

select throws_ok(
  $$insert into public.promotions (organization_id, company_id, name, starts_at, ends_at,
                                   whatsapp_enabled, hashtag)
    values ('00000000-0000-0000-0000-0000000000b1','00000000-0000-0000-0000-0000000000c1',
            'Tab 2 while off', '2026-09-01Z', '2026-09-30Z', false, '#NOPE')$$,
  '23514', null, 'a hashtag with WhatsApp disabled is refused');

select throws_ok(
  $$insert into public.promotions (organization_id, company_id, name, starts_at, ends_at,
                                   whatsapp_enabled, hashtag, requested_fields)
    values ('00000000-0000-0000-0000-0000000000b1','00000000-0000-0000-0000-0000000000c1',
            'Fields while off', '2026-09-01Z', '2026-09-30Z', false, null,
            array['full_name']::public.promotion_requested_field[])$$,
  '23514', null, 'requested fields with WhatsApp disabled are refused');

select throws_ok(
  $$insert into public.promotions (organization_id, company_id, name, starts_at, ends_at,
                                   whatsapp_enabled, hashtag, requested_fields)
    values ('00000000-0000-0000-0000-0000000000b1','00000000-0000-0000-0000-0000000000c1',
            'Dup fields', '2026-09-01Z', '2026-09-30Z', true, '#DUP',
            array['city','city']::public.promotion_requested_field[])$$,
  '23514', null, 'the same requested field twice is refused');

select throws_ok(
  $$insert into public.promotions (organization_id, company_id, name, starts_at, ends_at,
                                   whatsapp_enabled, hashtag, use_art)
    values ('00000000-0000-0000-0000-0000000000b1','00000000-0000-0000-0000-0000000000c1',
            'Art without url', '2026-09-01Z', '2026-09-30Z', true, '#ART', true)$$,
  '23514', null, 'use_art without a url is refused');

select throws_ok(
  $$insert into public.promotions (organization_id, company_id, name, starts_at, ends_at,
                                   whatsapp_enabled, hashtag, use_art, art_url)
    values ('00000000-0000-0000-0000-0000000000b1','00000000-0000-0000-0000-0000000000c1',
            'Http art', '2026-09-01Z', '2026-09-30Z', true, '#HTTP', true,
            'http://example.test/banner.jpg')$$,
  '23514', null, 'an http art url is refused');

select throws_ok(
  $$insert into public.promotions (organization_id, company_id, name, starts_at, ends_at,
                                   allow_multiple_entries)
    values ('00000000-0000-0000-0000-0000000000b1','00000000-0000-0000-0000-0000000000c1',
            'Repeat no interval', '2026-09-01Z', '2026-09-30Z', true)$$,
  '23514', null, 'repetition without an interval is refused');

select throws_ok(
  $$insert into public.promotions (organization_id, company_id, name, starts_at, ends_at,
                                   min_hours_between_entries)
    values ('00000000-0000-0000-0000-0000000000b1','00000000-0000-0000-0000-0000000000c1',
            'Interval no repeat', '2026-09-01Z', '2026-09-30Z', 24)$$,
  '23514', null, 'an interval without repetition is refused');

select throws_ok(
  $$insert into public.promotions (organization_id, company_id, name, starts_at, ends_at,
                                   cancelled_at)
    values ('00000000-0000-0000-0000-0000000000b1','00000000-0000-0000-0000-0000000000c1',
            'Half cancelled', '2026-09-01Z', '2026-09-30Z', now())$$,
  '23514', null, 'a cancellation without author and reason is refused');

select throws_ok(
  $$insert into public.promotions (organization_id, company_id, name, starts_at, ends_at,
                                   deleted_at)
    values ('00000000-0000-0000-0000-0000000000b1','00000000-0000-0000-0000-0000000000c1',
            'Half archived', '2026-09-01Z', '2026-09-30Z', now())$$,
  '23514', null, 'an archive without an author is refused');

-- The hashtag exclusion constraint. Three cases, and the middle one is the
-- one that distinguishes this from an ordinary unique index.
insert into public.promotions
  (organization_id, company_id, name, starts_at, ends_at, whatsapp_enabled, hashtag)
values
  ('00000000-0000-0000-0000-0000000000b1','00000000-0000-0000-0000-0000000000c1',
   'First', '2026-10-01Z', '2026-10-31Z', true, '#EUQUERO');

select throws_ok(
  $$insert into public.promotions
      (organization_id, company_id, name, starts_at, ends_at, whatsapp_enabled, hashtag)
    values ('00000000-0000-0000-0000-0000000000b1','00000000-0000-0000-0000-0000000000c1',
            'Overlapping', '2026-10-15Z', '2026-11-15Z', true, '#EUQUERO')$$,
  '23P01', null, 'an overlapping window with the same hashtag is refused');

select throws_ok(
  $$insert into public.promotions
      (organization_id, company_id, name, starts_at, ends_at, whatsapp_enabled, hashtag)
    values ('00000000-0000-0000-0000-0000000000b1','00000000-0000-0000-0000-0000000000c1',
            'Case', '2026-10-15Z', '2026-11-15Z', true, '#euquero')$$,
  '23P01', null, 'the same hashtag in another case is refused');

prepare touching as
  insert into public.promotions
    (organization_id, company_id, name, starts_at, ends_at, whatsapp_enabled, hashtag)
  values ('00000000-0000-0000-0000-0000000000b1','00000000-0000-0000-0000-0000000000c1',
          'Touching', '2026-10-31Z', '2026-11-30Z', true, '#EUQUERO');
select lives_ok('touching',
  'a window that starts exactly when the other ends is accepted');

-- The site integration code, unique per Station while live.
insert into public.promotions
  (organization_id, company_id, name, starts_at, ends_at, site_integration_code)
values ('00000000-0000-0000-0000-0000000000b1','00000000-0000-0000-0000-0000000000c1',
        'Coded', '2027-01-01Z', '2027-01-31Z', 4242);
select throws_ok(
  $$insert into public.promotions
      (organization_id, company_id, name, starts_at, ends_at, site_integration_code)
    values ('00000000-0000-0000-0000-0000000000b1','00000000-0000-0000-0000-0000000000c1',
            'Coded twice', '2027-02-01Z', '2027-02-28Z', 4242)$$,
  '23505', null, 'a duplicate site integration code is refused');

-- §1.1's loose end: the consent foreign key now exists.
select throws_ok(
  $$insert into public.member_consents
      (organization_id, member_id, company_id, consent_type, granted, promotion_id)
    values ('00000000-0000-0000-0000-0000000000b1', gen_random_uuid(),
            '00000000-0000-0000-0000-0000000000c1', 'rules', true, gen_random_uuid())$$,
  '23503', null, 'a consent naming a promotion that does not exist is refused');

select * from finish();
rollback;
```

- [ ] **Step 2: Run it and watch it fail**

```bash
npx supabase test db
```

Expected: the file errors out at the first `has_table` — `relation "public.promotions" does not exist`. That failure is the point: it proves the file is actually being executed before anything exists.

- [ ] **Step 3: Write the migration**

Create `supabase/migrations/0040_promotions.sql`.

```sql
-- supabase/migrations/0040_promotions.sql

-- btree_gist gives GiST the `=` operator for uuid and text, which the hashtag
-- exclusion constraint below needs in order to compare company_id and
-- lower(hashtag) alongside a range. The schema is named explicitly for the
-- reason 0001's comment gives: `create extension if not exists` without it is
-- a silent no-op against a database where the extension already lives
-- somewhere else, and that only looks like a guarantee.
create extension if not exists btree_gist with schema extensions;

-- The eight fields a promotion may ask the audience for. Each value names the
-- members column it fills, not the label on screen: the label is interface and
-- will be reworded, the column is the contract. Three fields the owner's old
-- system offered — gender, favourite station, favourite show — are deliberately
-- absent (spec D5); they have no column and will not get one.
create type public.promotion_requested_field as enum (
  'full_name', 'address', 'city', 'neighbourhood',
  'age', 'cpf', 'passport', 'discovery_source'
);

create type public.promotion_question_kind as enum (
  'QUIZ', 'MULTIPLE_CHOICE', 'ESSAY'
);

comment on type public.promotion_question_kind is
  'QUIZ has options and exactly one right answer; MULTIPLE_CHOICE has options and no right answer; ESSAY is free text and has no options at all.';

-- A CHECK constraint may not contain a subquery, and de-duplicating an array
-- needs one. Wrapping it in an immutable function is the only way to state the
-- rule in the schema rather than in prose.
create or replace function public.has_no_duplicates(p_values anyarray)
returns boolean
language sql
immutable
parallel safe
set search_path = pg_catalog
as $$
  select p_values is null
      or cardinality(p_values) = (select count(distinct v) from unnest(p_values) as v);
$$;

comment on function public.has_no_duplicates(anyarray) is
  'True when the array holds no value twice. Exists because a CHECK cannot contain a subquery.';

create table public.promotions (
  id                    uuid primary key default gen_random_uuid(),
  organization_id       uuid not null references public.organizations (id),
  company_id            uuid not null,

  site_integration_code integer,
  name                  text not null,

  starts_at             timestamptz not null,
  ends_at               timestamptz not null,

  allow_multiple_entries    boolean not null default false,
  min_hours_between_entries integer,

  require_correct_answer boolean not null default false,
  call_to_action         text,

  whatsapp_enabled  boolean not null default false,
  hashtag           text,
  use_art           boolean not null default false,
  art_url           text,
  yes_button_label  text,
  no_button_label   text,
  requested_fields  public.promotion_requested_field[] not null default '{}',

  created_by  uuid references auth.users (id),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),

  cancelled_at        timestamptz,
  cancelled_by        uuid references auth.users (id),
  cancellation_reason text,

  deleted_at  timestamptz,
  deleted_by  uuid references auth.users (id),

  constraint promotions_company_org_fk
    foreign key (company_id, organization_id)
    references public.companies (id, organization_id),

  constraint promotions_window check (ends_at > starts_at),

  constraint promotions_name_present check (length(btrim(name)) > 0),

  -- The whole of tab 2 is empty when WhatsApp is off, rather than merely
  -- ignored. A hashtag sitting on a promotion that does not use WhatsApp is a
  -- value some future reader will believe.
  constraint promotions_whatsapp_shape check (
    (whatsapp_enabled and hashtag is not null)
    or (not whatsapp_enabled
        and hashtag is null
        and use_art = false
        and art_url is null
        and yes_button_label is null
        and no_button_label is null
        and cardinality(requested_fields) = 0)
  ),

  -- A hashtag with a space in it cannot be matched against an inbound message
  -- with any confidence, and one without the leading # is not what the operator
  -- typed on the old screen. Both are refused here rather than in the form,
  -- where only one of the two write paths would see the rule.
  constraint promotions_hashtag_shape check (
    hashtag is null or hashtag ~ '^#[^[:space:]#]{1,39}$'
  ),

  constraint promotions_art_shape check (
    (use_art and art_url is not null) or (not use_art and art_url is null)
  ),

  -- The WhatsApp Cloud API fetches this image itself and will not fetch over
  -- http. Refusing it here means the operator learns at the moment of typing,
  -- not at send time in Block 5, where nothing points back to this field.
  constraint promotions_art_https check (
    art_url is null or art_url like 'https://%'
  ),

  constraint promotions_requested_fields_distinct check (
    public.has_no_duplicates(requested_fields)
  ),

  constraint promotions_repetition_shape check (
    (allow_multiple_entries and min_hours_between_entries is not null
       and min_hours_between_entries between 1 and 8760)
    or (not allow_multiple_entries and min_hours_between_entries is null)
  ),

  constraint promotions_cancellation_shape check (
    (cancelled_at is null and cancelled_by is null and cancellation_reason is null)
    or (cancelled_at is not null and cancelled_by is not null
        and cancellation_reason is not null and length(btrim(cancellation_reason)) > 0)
  ),

  constraint promotions_archival_shape check (
    (deleted_at is null and deleted_by is null)
    or (deleted_at is not null and deleted_by is not null)
  ),

  -- The bot decides which promotion an inbound message belongs to by its
  -- hashtag alone, so two promotions accepting at the same moment in the same
  -- Station must not share one. A unique index would be too strong — it would
  -- forbid reusing #EUQUERO next year. What is actually forbidden is an
  -- OVERLAP, and tstzrange's default [) bounds mean a promotion ending at the
  -- instant another starts does not overlap it. Proved against the real
  -- database before this was written: docs/probes/block-4a-hashtag-overlap.sql.
  --
  -- Note it re-evaluates on UPDATE too, so a cancelled promotion whose window
  -- was reused can no longer be un-cancelled. Nothing here un-cancels; a future
  -- reactivate button must refuse that case with a sentence a human can act on,
  -- because the raw 23P01 reads like nothing an operator has ever seen.
  constraint promotions_hashtag_no_overlap exclude using gist (
    company_id with =,
    lower(hashtag) with =,
    tstzrange(starts_at, ends_at) with &&
  ) where (deleted_at is null and cancelled_at is null and hashtag is not null)
);

comment on table public.promotions is
  'A promotion and its WhatsApp settings in one row. The two are not separable: forbidding two live promotions from sharing a hashtag is an exclusion constraint over the window, and an exclusion constraint cannot span two tables.';
comment on column public.promotions.requested_fields is
  'Which member fields the bot asks for. Every marked field is asked the same way, in this enum''s order — the owner was asked directly whether a field would ever need settings of its own and said no (spec D6).';
comment on column public.promotions.deleted_by is
  'Who archived it. New to this project: every other table records when a row was soft-deleted and never who. The owner resolves discrepancies himself rather than calling support, and cannot do that without a name.';

-- Child tables prove Station membership through a composite foreign key rather
-- than trusting their own company_id, the way prizes and inventory_movements do.
alter table public.promotions
  add constraint promotions_id_company_unique unique (id, company_id);

-- The list orders by start, newest first, tie-broken by id — a keyset cursor
-- must compare exactly what it orders by (Block 3b), so the index carries both.
create index promotions_listing_idx
  on public.promotions (company_id, starts_at desc, id desc)
  where deleted_at is null;

create unique index promotions_site_code_unique
  on public.promotions (company_id, site_integration_code)
  where deleted_at is null and site_integration_code is not null;

alter table public.promotions enable row level security;

-- 0032 created this column with the comment "No foreign key yet:
-- public.promotions does not exist." It does now.
alter table public.member_consents
  add constraint member_consents_promotion_fk
  foreign key (promotion_id) references public.promotions (id);

-- A permission is born beside the feature it guards, and appears in the role
-- editor without that screen being touched (0025's comment).
insert into public.permissions (code, description, introduced_by_block, module, label, scope, display_order) values
  ('promotions.view',    'Read promotions and their quizzes',   '4a', 'promotions', 'See promotions',                'company', 10),
  ('promotions.create',  'Register a promotion',                '4a', 'promotions', 'Register a promotion',          'company', 20),
  ('promotions.edit',    'Edit a promotion and its quiz',       '4a', 'promotions', 'Edit a promotion and its quiz', 'company', 30),
  ('promotions.cancel',  'Cancel a promotion before it ends',   '4a', 'promotions', 'Cancel a promotion',            'company', 40),
  ('promotions.archive', 'Archive a promotion',                 '4a', 'promotions', 'Archive a promotion',           'company', 50);
```

- [ ] **Step 4: Run the database gate**

```bash
npx supabase db reset && docker restart supabase_kong_CRM_-_LISTENER
npx supabase test db
```

Expected: `03_promotions.test.sql .. ok`, and the total across all three files rises from 244 to 268.

- [ ] **Step 5: Prove the touching-window case is load-bearing**

Change `tstzrange(starts_at, ends_at)` to `tstzrange(starts_at, ends_at, '[]')` in the migration, reset, and re-run.

Expected: `a window that starts exactly when the other ends is accepted` turns red, and the three refusal cases stay green. That is what proves the assertion is testing the half-open bound rather than passing for the same reason a unique index would. Restore with `git checkout -- supabase/migrations/0040_promotions.sql` as its own command, verify with `git diff` (empty), reset, and re-run before continuing. Record the mutation and its output for the report.

- [ ] **Step 6: Regenerate types and commit**

```bash
npm run db:types
git add supabase/migrations/0040_promotions.sql supabase/tests/03_promotions.test.sql src/lib/supabase/database.types.ts
git commit -m "feat(promotions): the promotion table and what the database refuses"
```

---

## Task 2: The quiz tables

**Files:**
- Create: `supabase/migrations/0041_promotion_questions.sql`
- Modify: `supabase/tests/03_promotions.test.sql`

**Interfaces:**
- Consumes: `public.promotions (id, company_id)`, `public.promotion_question_kind` from Task 1.
- Produces: tables `public.promotion_questions`, `public.promotion_question_options`.

- [ ] **Step 1: Add the failing assertions**

Append to `supabase/tests/03_promotions.test.sql` before `select * from finish();`, and raise the `plan(24)` to `plan(33)`.

```sql
-- Quiz structure
select has_table('public', 'promotion_questions', 'promotion_questions exists');
select has_table('public', 'promotion_question_options', 'promotion_question_options exists');

insert into public.promotions
  (id, organization_id, company_id, name, starts_at, ends_at)
values ('00000000-0000-0000-0000-0000000000d1',
        '00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000c1',
        'Quiz host', '2027-03-01Z', '2027-03-31Z');

prepare essay as
  insert into public.promotion_questions
    (id, promotion_id, organization_id, company_id, position, kind, prompt)
  values ('00000000-0000-0000-0000-0000000000e1',
          '00000000-0000-0000-0000-0000000000d1',
          '00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000c1',
          1, 'ESSAY', 'Tell us why you listen');
select lives_ok('essay', 'an essay question needs no menu or button title');

select throws_ok(
  $$insert into public.promotion_questions
      (promotion_id, organization_id, company_id, position, kind, prompt, menu_title, button_label)
    values ('00000000-0000-0000-0000-0000000000d1',
            '00000000-0000-0000-0000-0000000000b1','00000000-0000-0000-0000-0000000000c1',
            2, 'ESSAY', 'Why?', 'Choose', 'Options')$$,
  '23514', null, 'an essay question may not carry a menu title');

select throws_ok(
  $$insert into public.promotion_questions
      (promotion_id, organization_id, company_id, position, kind, prompt)
    values ('00000000-0000-0000-0000-0000000000d1',
            '00000000-0000-0000-0000-0000000000b1','00000000-0000-0000-0000-0000000000c1',
            3, 'QUIZ', 'Who wins?')$$,
  '23514', null, 'a choice question without a menu title is refused');

select throws_ok(
  $$insert into public.promotion_question_options
      (question_id, kind, company_id, organization_id, position, label)
    values ('00000000-0000-0000-0000-0000000000e1', 'ESSAY',
            '00000000-0000-0000-0000-0000000000c1','00000000-0000-0000-0000-0000000000b1',
            1, 'Nope')$$,
  '23514', null, 'an option may not hang off an essay question');

insert into public.promotion_questions
  (id, promotion_id, organization_id, company_id, position, kind, prompt, menu_title, button_label)
values ('00000000-0000-0000-0000-0000000000e2',
        '00000000-0000-0000-0000-0000000000d1',
        '00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000c1',
        4, 'MULTIPLE_CHOICE', 'Favourite genre?', 'Choose', 'Options');

select throws_ok(
  $$insert into public.promotion_question_options
      (question_id, kind, company_id, organization_id, position, label, is_correct)
    values ('00000000-0000-0000-0000-0000000000e2', 'MULTIPLE_CHOICE',
            '00000000-0000-0000-0000-0000000000c1','00000000-0000-0000-0000-0000000000b1',
            1, 'Rock', true)$$,
  '23514', null, 'a poll may not have a right answer');

insert into public.promotion_questions
  (id, promotion_id, organization_id, company_id, position, kind, prompt, menu_title, button_label)
values ('00000000-0000-0000-0000-0000000000e3',
        '00000000-0000-0000-0000-0000000000d1',
        '00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000c1',
        5, 'QUIZ', 'Which country wins the 2026 World Cup?', 'Choose', 'Options');
insert into public.promotion_question_options
  (question_id, kind, company_id, organization_id, position, label, is_correct)
values ('00000000-0000-0000-0000-0000000000e3', 'QUIZ',
        '00000000-0000-0000-0000-0000000000c1','00000000-0000-0000-0000-0000000000b1',
        1, 'Brazil', true);

select throws_ok(
  $$insert into public.promotion_question_options
      (question_id, kind, company_id, organization_id, position, label, is_correct)
    values ('00000000-0000-0000-0000-0000000000e3', 'QUIZ',
            '00000000-0000-0000-0000-0000000000c1','00000000-0000-0000-0000-0000000000b1',
            2, 'Argentina', true)$$,
  '23505', null, 'a second right answer in one question is refused');

select throws_ok(
  $$update public.promotion_questions set kind = 'MULTIPLE_CHOICE'
     where id = '00000000-0000-0000-0000-0000000000e3'$$,
  '23514', null,
  'a quiz with a right answer cannot become a poll');

select throws_ok(
  $$insert into public.promotion_questions
      (promotion_id, organization_id, company_id, position, kind, prompt)
    values ('00000000-0000-0000-0000-0000000000d1',
            '00000000-0000-0000-0000-0000000000b1','00000000-0000-0000-0000-0000000000c1',
            1, 'ESSAY', 'Duplicate position')$$,
  '23505', null, 'two questions may not share a position');
```

- [ ] **Step 2: Run and watch it fail**

```bash
npx supabase test db
```
Expected: fails on `promotion_questions exists`.

- [ ] **Step 3: Write the migration**

Create `supabase/migrations/0041_promotion_questions.sql`.

```sql
-- supabase/migrations/0041_promotion_questions.sql

create table public.promotion_questions (
  id              uuid primary key default gen_random_uuid(),
  promotion_id    uuid not null,
  organization_id uuid not null references public.organizations (id),
  company_id      uuid not null,

  position     integer not null check (position > 0),
  kind         public.promotion_question_kind not null,
  prompt       text not null check (length(btrim(prompt)) > 0),

  -- The two fields of a WhatsApp interactive list message. They are what the
  -- owner's screen calls Título do Menu and Título do Botão.
  menu_title   text,
  button_label text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint promotion_questions_promotion_fk
    foreign key (promotion_id, company_id)
    references public.promotions (id, company_id),

  constraint promotion_questions_list_fields check (
    (kind = 'ESSAY' and menu_title is null and button_label is null)
    or (kind in ('QUIZ', 'MULTIPLE_CHOICE')
        and menu_title is not null and length(btrim(menu_title)) > 0
        and button_label is not null and length(btrim(button_label)) > 0)
  ),

  -- Plain, not deferrable, because 4a has no reordering: questions are appended
  -- and asked in position order, which is what the owner's screen does today.
  -- Adding reordering later means making this deferrable at that point, so that
  -- a swap inside one transaction does not collide with itself midway.
  constraint promotion_questions_position_unique unique (promotion_id, position),

  -- Exists so the options table can prove kind and Station in one foreign key.
  constraint promotion_questions_id_kind_company_unique unique (id, kind, company_id)
);

comment on table public.promotion_questions is
  'Carries no deleted_at on purpose. Soft deletion exists to keep rows something still points at; a question may only be removed while the promotion has no participation (4c), so nothing can point at one when it goes.';

create index promotion_questions_promotion_idx
  on public.promotion_questions (promotion_id, position);

alter table public.promotion_questions enable row level security;

create table public.promotion_question_options (
  id              uuid primary key default gen_random_uuid(),
  question_id     uuid not null,
  kind            public.promotion_question_kind not null,
  organization_id uuid not null references public.organizations (id),
  company_id      uuid not null,

  position   integer not null check (position > 0),
  label      text not null check (length(btrim(label)) > 0),
  is_correct boolean not null default false,

  created_at timestamptz not null default now(),

  -- kind is denormalised here so that two rules become structural rather than
  -- prose. ON UPDATE CASCADE earns its keep on the edit path: changing a
  -- question from QUIZ to MULTIPLE_CHOICE cascades the new kind onto its
  -- options, where the is_correct check below then refuses the whole update
  -- while any option is still marked right — so a quiz cannot quietly become a
  -- poll while keeping a right answer.
  constraint promotion_question_options_question_fk
    foreign key (question_id, kind, company_id)
    references public.promotion_questions (id, kind, company_id)
    on update cascade,

  constraint promotion_question_options_not_essay check (kind <> 'ESSAY'),

  constraint promotion_question_options_correct_only_on_quiz check (
    kind = 'QUIZ' or is_correct = false
  ),

  constraint promotion_question_options_position_unique unique (question_id, position)
);

-- At most one right answer. No index can require a FIRST one — that rule lives
-- in save_promotion_question (0043) and is weaker for it, which the spec says
-- out loud rather than leaving to be discovered.
create unique index promotion_question_options_one_correct
  on public.promotion_question_options (question_id)
  where is_correct;

create index promotion_question_options_question_idx
  on public.promotion_question_options (question_id, position);

alter table public.promotion_question_options enable row level security;
```

- [ ] **Step 4: Run the gate**

```bash
npx supabase db reset && docker restart supabase_kong_CRM_-_LISTENER
npx supabase test db
```
Expected: 277 passing.

- [ ] **Step 5: Prove the cascade assertion is load-bearing**

Remove `on update cascade` from the options foreign key, reset, re-run.

Expected: `a quiz with a right answer cannot become a poll` still fails — but with `23503` (foreign key violation) rather than `23514`, so `throws_ok`'s error-code argument makes the test red. That distinction is the whole point: without the code pinned, the assertion would pass for the wrong reason. Restore, verify with `git diff`, re-run, and record it.

- [ ] **Step 6: Commit**

```bash
npm run db:types
git add supabase/migrations/0041_promotion_questions.sql supabase/tests/03_promotions.test.sql src/lib/supabase/database.types.ts
git commit -m "feat(promotions): the quiz tables, with kind proved by the key"
```

---

## Task 3: The promotion write RPCs

**Files:**
- Create: `supabase/migrations/0042_promotion_rpcs.sql`

**Interfaces:**
- Produces:
  - `create_promotion(p_company_id uuid, p_name text, p_starts_at timestamptz, p_ends_at timestamptz, p_site_integration_code integer, p_call_to_action text, p_allow_multiple_entries boolean, p_min_hours_between_entries integer, p_require_correct_answer boolean, p_whatsapp_enabled boolean, p_hashtag text, p_use_art boolean, p_art_url text, p_yes_button_label text, p_no_button_label text, p_requested_fields public.promotion_requested_field[]) returns uuid`
  - `update_promotion(p_promotion_id uuid, <same fields, no company>) returns void`
  - `cancel_promotion(p_promotion_id uuid, p_reason text) returns void`
  - `archive_promotion(p_promotion_id uuid) returns void`

- [ ] **Step 1: Write the migration**

Create `supabase/migrations/0042_promotion_rpcs.sql`. Follow `create_prize` (0027:499) line for line in shape: resolve the Organization from the Station, check the permission, normalise text with `nullif(trim(coalesce(...)), '')`, translate constraint violations into sentences, write an audit row, return the id.

The three refusals the spec names, each in the RPC and not only in the form:

```sql
-- in cancel_promotion
if v_reason is null then
  raise exception 'a reason is required to cancel a promotion' using errcode = '22023';
end if;
if v_cancelled_at is not null then
  raise exception 'this promotion is already cancelled' using errcode = '22023';
end if;
if v_ends_at <= now() then
  raise exception 'this promotion has already ended; there is nothing to cancel'
    using errcode = '22023';
end if;

-- in archive_promotion: the shape of archive_prize's own refusal (0027:660)
if v_cancelled_at is null and now() >= v_starts_at and now() < v_ends_at then
  raise exception 'this promotion is still accepting entries; cancel it before archiving'
    using errcode = '22023';
end if;
```

Translate the two constraint violations an operator can actually cause into
sentences, rather than letting a raw code reach the screen:

```sql
exception
  when exclusion_violation then
    raise exception 'another promotion in this station is already using "%" during that period', v_hashtag
      using errcode = '23P01';
  when unique_violation then
    raise exception 'site integration code % is already used by another promotion in this station', p_site_integration_code
      using errcode = '23505';
```

Every function is `security definer`, `set search_path = pg_catalog, public`, and
takes `for update` on the promotion row before reading the fields it decides on,
so two cancels racing cannot both pass their "already cancelled" check.

- [ ] **Step 2: Reset and confirm the migration applies**

```bash
npx supabase db reset && docker restart supabase_kong_CRM_-_LISTENER
npx supabase test db
```
Expected: still 277 — this task adds no pgTAP. Its proof is Task 8's isolation suite, which drives every one of these under a real delegate JWT. Do not add a "the function exists" assertion here: it would pass while the body was wrong.

- [ ] **Step 3: Commit**

```bash
npm run db:types
git add supabase/migrations/0042_promotion_rpcs.sql src/lib/supabase/database.types.ts
git commit -m "feat(promotions): create, update, cancel and archive"
```

---

## Task 4: The quiz write RPCs

**Files:**
- Create: `supabase/migrations/0043_promotion_question_rpcs.sql`

**Interfaces:**
- Produces:
  - `save_promotion_question(p_promotion_id uuid, p_question_id uuid, p_kind public.promotion_question_kind, p_prompt text, p_menu_title text, p_button_label text, p_options jsonb) returns uuid`
  - `remove_promotion_question(p_question_id uuid) returns void`

- [ ] **Step 1: Write the migration**

A question and its options are written in **one call**: they are one form, and splitting them would let a question exist for an instant with no options, or with the previous question's. `p_options` is a JSONB array of `{"label": text, "is_correct": boolean}`, in the order given.

The body, in order: resolve Organization and Station from the promotion; check `promotions.edit`; `for update` on the promotion; validate; delete the existing options for this question; insert the new ones with `position` from `with ordinality`; write the audit row.

The rule no index can express, stated where it lives:

```sql
-- A partial unique index forbids the SECOND right answer; nothing can require
-- a FIRST. This is the weaker half of the guarantee and the only place it
-- exists, so it is checked before anything is written rather than after.
if p_kind = 'QUIZ' and v_correct_count <> 1 then
  raise exception 'a quiz question needs exactly one right answer, and % were marked', v_correct_count
    using errcode = '22023';
end if;

if p_kind = 'ESSAY' and jsonb_array_length(coalesce(p_options, '[]'::jsonb)) > 0 then
  raise exception 'an essay question takes no options' using errcode = '22023';
end if;

if p_kind <> 'ESSAY' and jsonb_array_length(coalesce(p_options, '[]'::jsonb)) < 2 then
  raise exception 'a choice question needs at least two options' using errcode = '22023';
end if;
```

`position` for a new question is `coalesce(max(position), 0) + 1` for that promotion, read under the promotion's `for update` so two concurrent adds cannot pick the same number.

`remove_promotion_question` deletes the row and its options and **renumbers nothing** — a gap orders correctly, and renumbering would rewrite rows nobody asked to touch.

- [ ] **Step 2: Reset, confirm, commit**

```bash
npx supabase db reset && docker restart supabase_kong_CRM_-_LISTENER
npx supabase test db
npm run db:types
git add supabase/migrations/0043_promotion_question_rpcs.sql src/lib/supabase/database.types.ts
git commit -m "feat(promotions): save and remove a quiz question in one call"
```

---

## Task 5: RLS

**Files:**
- Create: `supabase/migrations/0044_rls_promotions.sql`
- Modify: `supabase/tests/03_promotions.test.sql`

**Interfaces:**
- Produces: `public.is_owner_of_company(p_company_id uuid) returns boolean`; three select policies.

- [ ] **Step 1: Add the failing grant assertions**

Raise `plan(33)` to `plan(37)` and append:

```sql
select ok(has_table_privilege('authenticated', 'public.promotions', 'SELECT'),
          'authenticated may read promotions, subject to policy');
select ok(not has_table_privilege('authenticated', 'public.promotion_questions', 'INSERT'),
          'authenticated may not insert a question directly');
select is(relrowsecurity, true, 'RLS enabled on promotion_questions')
  from pg_class where oid = 'public.promotion_questions'::regclass;
select is(public.is_owner_of_company(gen_random_uuid()), false,
          'is_owner_of_company fails closed with no session');
```

- [ ] **Step 2: Run and watch it fail**

Expected: fails on the missing grant and the missing function.

- [ ] **Step 3: Write the migration**

```sql
-- supabase/migrations/0044_rls_promotions.sql

-- has_permission already admits the owner and the platform admin, so it cannot
-- express "the owner also sees archived rows" by itself. This is that second
-- predicate. It must be SECURITY DEFINER rather than an inline EXISTS over
-- public.companies inside the policy: an EXISTS in a policy body is itself
-- subject to the read policies of the table it touches, which is what forced
-- the same move in 0024.
create or replace function public.is_owner_of_company(p_company_id uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select public.is_platform_admin()
      or exists (
        select 1 from public.companies c
        where c.id = p_company_id and public.is_owner(c.organization_id)
      );
$$;

comment on function public.is_owner_of_company(uuid) is
  'True for the platform admin and for the Organization owner of that Station. Exists so a policy can admit the owner to rows it hides from everybody else — the owner resolves discrepancies rather than calling support (spec D12).';

revoke execute on function public.is_owner_of_company(uuid) from public;
grant execute on function public.is_owner_of_company(uuid) to authenticated;

grant select on public.promotions                to authenticated, service_role;
grant select on public.promotion_questions       to authenticated, service_role;
grant select on public.promotion_question_options to authenticated, service_role;

create policy promotions_select_promotions_view on public.promotions
  for select to authenticated
  using (
    public.has_permission('promotions.view', company_id)
    and (deleted_at is null or public.is_owner_of_company(company_id))
  );

-- The `promotion_id in (select id from public.promotions)` clause is not
-- redundant with the permission check beside it. That subquery is itself
-- filtered by the policy above, so an archived promotion's quiz is visible to
-- exactly whoever can see the archived promotion — without this, a delegate
-- who kept the id could still read the questions of a promotion that has left
-- every one of their other reads.
create policy promotion_questions_select_promotions_view on public.promotion_questions
  for select to authenticated
  using (
    public.has_permission('promotions.view', company_id)
    and promotion_id in (select id from public.promotions)
  );

create policy promotion_question_options_select_promotions_view on public.promotion_question_options
  for select to authenticated
  using (
    public.has_permission('promotions.view', company_id)
    and question_id in (select id from public.promotion_questions)
  );
```

- [ ] **Step 4: Run the gate and commit**

```bash
npx supabase db reset && docker restart supabase_kong_CRM_-_LISTENER
npx supabase test db
git add supabase/migrations/0044_rls_promotions.sql supabase/tests/03_promotions.test.sql
git commit -m "feat(promotions): read policies, and the owner's view of archived rows"
```

---

## Task 6: The validation schema

**Files:**
- Create: `src/schemas/promotions.ts`
- Create: `tests/unit/promotions-schema.test.ts`

**Interfaces:**
- Produces: `promotionFormSchema`, `PromotionFormInput`, `questionFormSchema`, `QuestionFormInput`, `REQUESTED_FIELD_ORDER`.

- [ ] **Step 1: Write the failing unit tests**

Mirror `tests/unit/inventory-schema.test.ts` in style. Cases, one `it` each:

```ts
import { describe, it, expect } from 'vitest';
import { promotionFormSchema, questionFormSchema } from '@/schemas/promotions';

const base = {
  companyId: '00000000-0000-0000-0000-0000000000c1',
  name: 'Galaxy S25 Ultra',
  startsAt: '2026-08-01T00:00:00.000Z',
  endsAt: '2026-08-31T00:00:00.000Z',
  allowMultipleEntries: false,
  requireCorrectAnswer: false,
  whatsappEnabled: false,
  useArt: false,
  requestedFields: [],
};

describe('promotionFormSchema', () => {
  it('accepts the minimum promotion', () => {
    expect(promotionFormSchema.safeParse(base).success).toBe(true);
  });

  it('refuses an end before the start', () => {
    const r = promotionFormSchema.safeParse({ ...base, endsAt: '2026-07-01T00:00:00.000Z' });
    expect(r.success).toBe(false);
  });

  it('refuses an end exactly equal to the start', () => {
    const r = promotionFormSchema.safeParse({ ...base, endsAt: base.startsAt });
    expect(r.success).toBe(false);
  });

  it('requires an interval when repetition is on', () => {
    const r = promotionFormSchema.safeParse({ ...base, allowMultipleEntries: true });
    expect(r.success).toBe(false);
  });

  it('refuses an interval when repetition is off', () => {
    const r = promotionFormSchema.safeParse({ ...base, minHoursBetweenEntries: 24 });
    expect(r.success).toBe(false);
  });

  it('requires a hashtag when WhatsApp is on', () => {
    const r = promotionFormSchema.safeParse({ ...base, whatsappEnabled: true });
    expect(r.success).toBe(false);
  });

  it('refuses a hashtag without the leading hash', () => {
    const r = promotionFormSchema.safeParse({ ...base, whatsappEnabled: true, hashtag: 'EUQUERO' });
    expect(r.success).toBe(false);
  });

  it('refuses a hashtag containing a space', () => {
    const r = promotionFormSchema.safeParse({ ...base, whatsappEnabled: true, hashtag: '#EU QUERO' });
    expect(r.success).toBe(false);
  });

  it('requires an art url when the art box is ticked', () => {
    const r = promotionFormSchema.safeParse({
      ...base, whatsappEnabled: true, hashtag: '#EUQUERO', useArt: true,
    });
    expect(r.success).toBe(false);
  });

  it('refuses an http art url', () => {
    const r = promotionFormSchema.safeParse({
      ...base, whatsappEnabled: true, hashtag: '#EUQUERO', useArt: true,
      artUrl: 'http://example.test/b.jpg',
    });
    expect(r.success).toBe(false);
  });

  it('refuses requested fields while WhatsApp is off', () => {
    const r = promotionFormSchema.safeParse({ ...base, requestedFields: ['city'] });
    expect(r.success).toBe(false);
  });

  it('refuses the same requested field twice', () => {
    const r = promotionFormSchema.safeParse({
      ...base, whatsappEnabled: true, hashtag: '#EUQUERO', requestedFields: ['city', 'city'],
    });
    expect(r.success).toBe(false);
  });
});

describe('questionFormSchema', () => {
  const choice = {
    kind: 'MULTIPLE_CHOICE' as const,
    prompt: 'Favourite genre?',
    menuTitle: 'Choose',
    buttonLabel: 'Options',
    options: [{ label: 'Rock', isCorrect: false }, { label: 'Samba', isCorrect: false }],
  };

  it('accepts a poll with two options and no right answer', () => {
    expect(questionFormSchema.safeParse(choice).success).toBe(true);
  });

  it('refuses a choice question with one option', () => {
    const r = questionFormSchema.safeParse({ ...choice, options: [choice.options[0]] });
    expect(r.success).toBe(false);
  });

  it('refuses a right answer on a poll', () => {
    const r = questionFormSchema.safeParse({
      ...choice, options: [{ label: 'Rock', isCorrect: true }, choice.options[1]],
    });
    expect(r.success).toBe(false);
  });

  it('requires exactly one right answer on a quiz', () => {
    const r = questionFormSchema.safeParse({ ...choice, kind: 'QUIZ' });
    expect(r.success).toBe(false);
  });

  it('accepts a quiz with exactly one right answer', () => {
    const r = questionFormSchema.safeParse({
      ...choice, kind: 'QUIZ',
      options: [{ label: 'Brazil', isCorrect: true }, { label: 'Argentina', isCorrect: false }],
    });
    expect(r.success).toBe(true);
  });

  it('refuses two right answers on a quiz', () => {
    const r = questionFormSchema.safeParse({
      ...choice, kind: 'QUIZ',
      options: [{ label: 'Brazil', isCorrect: true }, { label: 'Argentina', isCorrect: true }],
    });
    expect(r.success).toBe(false);
  });

  it('refuses options on an essay question', () => {
    const r = questionFormSchema.safeParse({
      kind: 'ESSAY', prompt: 'Why?', options: [{ label: 'x', isCorrect: false }],
    });
    expect(r.success).toBe(false);
  });

  it('refuses a menu title on an essay question', () => {
    const r = questionFormSchema.safeParse({
      kind: 'ESSAY', prompt: 'Why?', menuTitle: 'Choose', options: [],
    });
    expect(r.success).toBe(false);
  });
});
```

- [ ] **Step 2: Run and watch them fail**

```bash
npx vitest run tests/unit/promotions-schema.test.ts
```
Expected: cannot resolve `@/schemas/promotions`.

- [ ] **Step 3: Write the schema**

Create `src/schemas/promotions.ts`. Every cross-field rule above is a `.superRefine`, and every message is a sentence an operator can act on. Each rule carries a comment naming the constraint in `0040`/`0041` it mirrors, so a reader can see the two are meant to agree — the form gives the verdict without a round trip, the database gives it whether or not the form ran.

- [ ] **Step 4: Run, then commit**

```bash
npx vitest run tests/unit/promotions-schema.test.ts
npm test
git add src/schemas/promotions.ts tests/unit/promotions-schema.test.ts
git commit -m "feat(promotions): the form's shape, mirroring the database's"
```

---

## Task 7: The service

**Files:**
- Create: `src/services/promotions.ts`

**Interfaces:**
- Consumes: `promotionFormSchema` types (Task 6), the RPCs (Tasks 3–4).
- Produces: `listPromotions`, `getPromotion`, `listPromotionQuestions`, `createPromotion`, `updatePromotion`, `cancelPromotion`, `archivePromotion`, `savePromotionQuestion`, `removePromotionQuestion`; types `PromotionSummary`, `PromotionDetail`, `PromotionQuestionRow`, `PromotionSortKey`, `PromotionSituation`.

- [ ] **Step 1: Write it, mirroring `src/services/inventory.ts`**

Same `asCaller(accessToken)` helper and the same reason for it: every RPC re-checks `has_permission` against `auth.uid()`, so calling one with the service key would defeat the check it exists to make.

`listPromotions` uses `keysetFilter`/`keysetPage` from `@/lib/keyset`, ordered by `starts_at desc, id desc` — the pair the index in `0040` carries.

**The situation filter is a predicate over three columns, never a computed sort key.** Block 3b proved a cursor must compare what it orders by; ordering by something computed pages wrongly. Write it as:

```ts
// `situation` narrows; it never orders. See 0040's promotions_listing_idx and
// the Block 3b report §2.4 for why a computed sort key cannot be paged.
switch (situation) {
  case 'scheduled': query = query.is('cancelled_at', null).gt('starts_at', nowIso); break;
  case 'live':      query = query.is('cancelled_at', null).lte('starts_at', nowIso).gt('ends_at', nowIso); break;
  case 'ended':     query = query.is('cancelled_at', null).lte('ends_at', nowIso); break;
  case 'cancelled': query = query.not('cancelled_at', 'is', null); break;
}
```

`getPromotion` returns the whole record — the promotion, its questions and their options — in the fewest round trips: one read for the promotion, one for its questions, one for the options of those questions. Three, not one per tab and not one per question.

- [ ] **Step 2: Typecheck and commit**

```bash
npm run typecheck
git add src/services/promotions.ts
git commit -m "feat(promotions): read the list and the whole record"
```

---

## Task 8: Isolation

**Files:**
- Create: `tests/isolation/promotions.test.ts`

**Interfaces:**
- Consumes: `provisionCustomer`, `createUser`, `signInAs` from `tests/isolation/harness.ts`.

- [ ] **Step 1: Write the suite**

**Every case is driven by a non-owner delegate.** That is the discipline adopted after Block 1c shipped two defects that thirteen reviews missed because the owner's bypass hid the delegate's failure. Create the delegate with a role granting exactly the codes each case needs and no more.

Cases, one `it` each:

1. A delegate with `promotions.view` reads a promotion and its questions.
2. A delegate **without** `promotions.view` gets nothing back — not an error, nothing.
3. A promotion in another Station is invisible to this delegate.
4. `create_promotion` with `promotions.create` lands; the re-read shows what was stored, including `requested_fields`.
5. `create_promotion` **without** it is refused with `42501`, and no row appears.
6. `update_promotion` with `promotions.edit` lands; a field blanked by the wholesale replace comes back null.
7. `update_promotion` without it is refused, and the row is unchanged for a caller who can still read it.
8. `cancel_promotion` with `promotions.cancel` sets the trio; the promotion stops being live.
9. `cancel_promotion` with no reason is refused with `22023`.
10. `cancel_promotion` on an already-cancelled promotion is refused.
11. `archive_promotion` while the promotion is live is refused, naming the reason.
12. `archive_promotion` after cancelling lands.
13. **D12, both sides:** an archived promotion is absent for the delegate who could read it while it was live, **and present for the owner**, carrying `deleted_by`.
14. **D12's reach:** the archived promotion's **questions** are also absent for that delegate — the clause in `0044`'s question policy is what makes this pass.
15. Two promotions with the same hashtag and overlapping windows: the second `create_promotion` comes back with the sentence, not a raw `23P01`.
16. `save_promotion_question` with `promotions.edit` replaces the options wholesale; the old ones are gone.
17. `save_promotion_question` without it is refused.
18. A quiz with no right answer is refused with the sentence from Task 4.

- [ ] **Step 2: Run**

```bash
npx supabase db reset && docker restart supabase_kong_CRM_-_LISTENER
npm run test:isolation
```
Expected: 101 + 18 = 119 passing.

If every spec fails at once with `could not create admin: {}`, that is Kong holding a stale auth upstream after the reset, not the code. Restart Kong, wait ten seconds, run again.

- [ ] **Step 3: Commit**

```bash
git add tests/isolation/promotions.test.ts
git commit -m "test(isolation): every promotion RPC under a delegate's JWT"
```

---

## Task 9: The list screen

**Files:**
- Create: `src/app/(app)/promotions/list-params.ts`, `page.tsx`, `promotions-filters.tsx`, `promotions-grid.tsx`, `format.ts`, `errors.ts`
- Modify: `src/components/layout/sidebar-nav.tsx`

**Interfaces:**
- Consumes: `listPromotions` and its types (Task 7).
- Produces: `PromotionListSearchParams`, `PromotionListState`, `describePromotionsReadError`, `SITUATION_LABELS`, `REQUESTED_FIELD_LABELS`, `QUESTION_KIND_LABELS`.

- [ ] **Step 1: Build it, mirroring the audience screen**

`src/app/(app)/members/list-params.ts`, `page.tsx`, `members-filters.tsx` and `members-grid.tsx` are the pattern; follow their structure, their comments' level of detail, and their URL contract. Filters, sort and cursor live in the URL so a filtered page is a link somebody can send to a colleague.

Columns: Name, Window, Situation, Hashtag, Questions. Filters: situation, free text over name and hashtag, and a period over `starts_at`. **The situation control is a filter only; there is no sort link on that column** — put the reason in a comment beside it, not only in the report.

The archived filter renders **only** when the caller is the owner or the platform admin, because they are the only callers whose reads return archived rows at all.

`format.ts` holds the labels. Situation is computed there from `startsAt`, `endsAt` and `cancelledAt`, in the Station's timezone, in one function both the grid and the dialog call — two copies of that rule is how they drift.

- [ ] **Step 2: Verify**

```bash
npm run lint && npm run typecheck && npm run build
```

- [ ] **Step 3: Commit**

```bash
git add src/app/\(app\)/promotions src/components/layout/sidebar-nav.tsx
git commit -m "feat(promotions): the list, its filters and the situation it computes"
```

---

## Task 10: The record dialog

**Files:**
- Create: `src/app/(app)/promotions/record.ts`, `actions.ts`, `promotion-record-dialog.tsx`, `promotion-form.tsx`, `whatsapp-form.tsx`, `quiz-tab.tsx`, `question-form.tsx`, `cancel-promotion-form.tsx`
- Modify: `src/app/(app)/promotions/promotions-grid.tsx`

**Interfaces:**
- Consumes: `getPromotion` (Task 7), `useRecordDialog` from `@/lib/record-params` and the row-action menu from Block 3c.
- Produces: `getPromotionRecordAction`, and the server actions `createPromotionAction`, `updatePromotionAction`, `cancelPromotionAction`, `archivePromotionAction`, `savePromotionQuestionAction`, `removePromotionQuestionAction`.

- [ ] **Step 1: Build it, mirroring `member-record-dialog.tsx`**

Three tabs — Promotion, WhatsApp, Quiz — addressable as `?record=<id>&tab=<slug>`. `src/app/(app)/members/member-record-dialog.tsx` and `record.ts` are the pattern, including the three-outcome `MemberRecordResult` shape and the reason `not-found` deliberately covers two different facts.

**The rule the whole pattern rests on:** no action invoked from this dialog calls `revalidatePath('/promotions')`. Put that as a banner comment at the top of `actions.ts`, in the words the other five action files use.

**Each write inside the dialog re-reads the record through `getPromotionRecordAction`**, which is not a hole in that rule: the prohibition is on re-running the *list*, not on reading one record again. Block 3c shipped this as a fix after the record dialogs failed to show what had just been written; do not rediscover it.

The WhatsApp tab is disabled while `whatsappEnabled` is false, and the art URL field is disabled and cleared when `useArt` is unticked. The banner preview renders beside the field from `artUrl`, so a broken URL is seen here rather than by a listener.

- [ ] **Step 2: Verify**

```bash
npm run lint && npm run typecheck && npm test && npm run build
```

- [ ] **Step 3: Commit**

```bash
git add src/app/\(app\)/promotions
git commit -m "feat(promotions): the promotion record as a dialog"
```

---

## Task 11: End to end, and the report

**Files:**
- Create: `tests/e2e/promotions-flow.spec.ts`, `docs/block-4a-report.md`

- [ ] **Step 1: Write the spec**

`tests/e2e/record-dialog.spec.ts` is the pattern, and its central finding applies unchanged: **the request counter cannot see a `revalidatePath`**, because Next returns the re-rendered tree inside the server action's own POST response, which the counter deliberately excludes. Copy that comment across.

The journey: register a promotion, open it, move through all three tabs, add a quiz question with two options, save, close with ESC, reopen from the URL, cancel it with a reason, and confirm the situation reads Cancelada.

**The assertion that actually catches a reintroduced `revalidatePath` is the row-position one, made at the moment of the save** — sort the list by name, rename the first row to something that would re-sort, and assert at the save that it has not moved.

- [ ] **Step 2: Run every gate**

```bash
npx supabase db reset && docker restart supabase_kong_CRM_-_LISTENER
npm run lint && npm run typecheck && npm test
npx supabase test db
npm run test:isolation
npm run build
CI=1 npx playwright test --workers=2
```

- [ ] **Step 3: Prove the position assertion is load-bearing**

Add `revalidatePath('/promotions')` to `updatePromotionAction`, re-run only that spec, and record the failure verbatim. Restore with `git checkout --` as its own command, never chained behind the failing run, verify with `git diff` (empty), and re-run the full suite.

- [ ] **Step 4: Write `docs/block-4a-report.md`**

Follow `docs/block-3c-report.md`'s shape. It must carry, at minimum:

- Every gate with its real command and real number.
- Each mutation from Tasks 1, 2 and 11, quoted verbatim.
- **What this block did not do:** no prize linking (4b), no participations and therefore **no frozen quiz** (D9 is 4c's, and the reason a guard was not written here is that it would be a guard that can never fire); no bot (Block 5); no reordering of questions; `prizes` and `members` still hide archived rows from everyone, pending the separate PR D12's second half describes.
- The judgement calls made in the code that the spec did not settle: the hashtag format regex, the 8760-hour ceiling on the repeat interval, and the option-count floor of two on a choice question. Each is defensible and none was approved in advance; the owner reads them here.
- Anything found while building that the spec got wrong. If nothing was found, say that, and say what was looked for.

- [ ] **Step 5: Commit and open the PR**

```bash
git add tests/e2e/promotions-flow.spec.ts docs/block-4a-report.md
git commit -m "test(e2e): the promotion record over a list that is never re-queried"
```

Then ask the owner before pushing — opening a PR is his call, every time.

---

## Self-review notes

Checked against the spec, section by section:

- §2 D1–D12: D1/D2 → Task 1 columns + Task 3 refusals; D3 → Task 1 enum, Task 2 constraints; D4 → `require_correct_answer` (Task 1); D5 → the eight-value enum with the three exclusions named in its comment; D6 → the array column, reason in the comment; D7 → `promotions_repetition_shape`; D8 → `promotions_site_code_unique`; D9 → **explicitly deferred to 4c**, recorded in Task 11's report list; D10/D11 → `promotions_art_shape`, `promotions_art_https`, Task 10's preview; D12 → Task 5's policy, Task 8 cases 13–14.
- §3 tables → Tasks 1–2. §4 table of guarantees → every row has a pgTAP case in Task 1 or 2. §5 screens → Tasks 9–10. §6 RPCs and powers → Tasks 3–4, catalogue rows in Task 1. §7 RLS → Task 5. §8 exclusions → Task 11's report. §9 verification → Tasks 1, 2, 6, 8, 11.
- §10 open item 2 (window timezone copy) is settled in Task 9: `format.ts` computes situation in the Station's timezone and the filter form shows it. Open item 1 (permission granularity) is left as the owner asked — five codes, collapsible at review.
