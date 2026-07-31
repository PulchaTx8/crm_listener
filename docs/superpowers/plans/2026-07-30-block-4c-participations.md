# Block 4c — Participations, import, and the limit N3 guards — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A participation can be recorded — by hand and by file — the repetition rules decide whether it counts, and the quiz freezes the moment the first one exists.

**Architecture:** Two tables (`participations`, `participation_answers`), one new column on `promotions`, and three RPCs on top. The repetition rules are applied under an advisory transaction lock over `(promotion, member)` and reinforced by a partial unique index that holds whether or not the function took the lock. Two of Block 4a's functions are recreated to enforce the freeze they promised. The screen is its own keyset-paginated list, with a fixed-cost tab on the promotion record.

**Tech Stack:** Postgres 15 (Supabase local), plpgsql SECURITY DEFINER RPCs, pgTAP, Next.js 15 App Router (React 19 server actions), TypeScript, Zod, Vitest, Playwright.

**Source spec:** `docs/superpowers/specs/2026-07-30-block-4c-participations-design.md` — read it before Task 1, including §9, where one item is struck through because Block 3 had already settled it.

**Branch:** `block-4c`, already checked out. It starts from `block-4b`'s head, so it carries Block 4b's commits until PR #16 merges; that is expected and the 4c pull request will show only 4c's work once it does.

## Global Constraints

- **Every gate at real defaults.** `npm run lint`, `npm run typecheck`, `npm test`, `npm run db:test`, `npm run test:isolation`, `npm run test:e2e` — no flags that weaken them, no skipped files.
- **The isolation suite is guarded and the guard must not be weakened.** `npm run test:isolation` runs `scripts/verify-isolation-suite.mjs`, which fails closed when a file does not report. **Adding `tests/isolation/participations.test.ts` requires adding it to that script's `REQUIRED_TEST_FILES` manifest** — the run will fail loudly until you do, which is the point. Block 4b found the runner can crash mid-file and still exit 0; if a run is short, fix the flake or report it, never the guard.
- **Everything in English**: identifiers, comments, UI copy, commit messages. Project vocabulary: Station = company, Organization, Member.
- **Migrations are numbered `0052`–`0055`** and are append-only: never edit a migration committed on a branch that has merged. Within this unmerged branch, amending a migration you added here is the established practice (`6228a8b` amended `0050`, `f64cadf` amended `0051`).
- **No table takes an INSERT, UPDATE or DELETE grant from any role**, `service_role` included. Every write goes through a SECURITY DEFINER RPC. `revoke truncate ... from service_role` too.
- **Every function states its reachability as a grant**: `revoke execute … from public` then `grant execute … to authenticated`, argument types spelled out in full. Private helpers are SECURITY INVOKER with EXECUTE granted to nobody.
- **Pin what you ship.** Block 4b shipped five functions with no grant-grid assertions while pinning Block 4a's six, and separately spent seven tasks claiming `::regprocedure` catches a surviving overload when it does not. Every function this block adds gets an anon/authenticated pair in pgTAP, and every private helper gets the four `ensure_inventory_balance_row` assertions.
- **A guard that cannot fire does not ship.** Where one is deliberately unreachable, it says so in its own comment and the test reaches it by removing what makes it unreachable.
- **No silent caps**: a bounded list must be able to say it was cut. `list_linkable_prizes` (`0051`) is the house convention — read N+1, the extra row is the answer.
- **No `revalidatePath` in any actions file under `src/app/(app)/`** — the banner in `promotions/actions.ts` explains why.
- Comments explain *why*, name the alternative that was rejected, and are written in full sentences.
- Commit message bodies end with the `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>` trailer.

## Two facts about running the gates locally

Both cost real time to rediscover on Block 4b:

- Clear `public.rate_limit_counters` before a full local `npm run test:e2e`. The invite-accept limiter is 10 per hour per IP, and four unrelated specs fail without it in a way that looks like a regression.
- Run Playwright with `--workers=1` locally. At default parallelism this suite produces 30-second timeouts in specs that pass alone in under ten.

---

## File Structure

**Migrations (create):**
- `supabase/migrations/0052_participations.sql` — the two enums, both tables, `promotions.max_entries_per_member`, the four unique constraints other tables need as foreign-key targets, the partial unique index, RLS enabled, and the three permission codes.
- `supabase/migrations/0053_rls_participations.sql` — grants and read policies. Deliberately before the function migrations, as `0046` was: every task after this asserts state by reading these tables.
- `supabase/migrations/0054_participation_rpcs.sql` — `resolve_or_create_member`, `record_participation`, `import_participations`.
- `supabase/migrations/0055_promotion_freeze.sql` — `update_promotion` and `remove_promotion_question` recreated, enforcing Block 4a's D9.

**pgTAP (create/modify):**
- `supabase/tests/05_participations.test.sql` — new; every constraint in this block, both ways.
- `supabase/tests/02_permissions.test.sql` — the grant grid for `resolve_or_create_member` (private helper, four assertions) and the three public RPCs.
- `supabase/tests/03_promotions.test.sql` — the promotion permission count is unchanged (the new codes are their own module), but `update_promotion` and `remove_promotion_question` keep their existing pairs; confirm the count rather than assuming it.

**Server (create/modify):**
- `src/schemas/participations.ts` — the manual-entry form and the CSV row.
- `src/services/participations.ts` — the list read, the three RPC wrappers, the error map.
- `src/lib/participation-status.ts` — the status vocabulary shared by server and client, in `@/lib` because the service is `server-only` and the grid is a client component. This is the shape `@/lib/promotion-situation.ts` and `@/lib/linkable-prizes.ts` already use, and Block 4b hit a build error importing a value from a `server-only` module into a client one.
- `src/app/(app)/participations/{page,actions,access,errors,list-params,participations-grid,participations-filters,record-participation-form,import-form}.tsx|ts`
- `src/app/(app)/promotions/participations-tab.tsx` — the fixed-cost tab.
- `src/app/(app)/promotions/promotion-record-dialog.tsx` — the fifth tab.
- `src/lib/supabase/database.types.ts` — regenerated, never hand-edited.

**Tests (create/modify):**
- `tests/isolation/participations.test.ts` — new; the block's real proof.
- `scripts/verify-isolation-suite.mjs` — the manifest gains the new file.
- `tests/unit/participations-schema.test.ts` — new.
- `tests/e2e/participations-flow.spec.ts` — new.

**Docs:**
- `docs/block-4c-report.md` — new, in Task 11.

---

## Task 1: The tables, the column, and the keys other tables will need

**Files:**
- Create: `supabase/migrations/0052_participations.sql`
- Create: `supabase/tests/05_participations.test.sql`

**Interfaces:**
- Consumes: `promotions (id, company_id)` (`0040:177`), `member_company_links (member_id, company_id)` (`0031:131`, its primary key), `promotion_questions (id, kind, company_id)` (`0041:39`), `companies (id, organization_id)`.
- Produces: types `public.participation_status` (`VALID`, `DUPLICATE`, `TOO_SOON`, `OVER_LIMIT`) and `public.participation_source` (`MANUAL`, `IMPORT`); tables `public.participations` and `public.participation_answers`; column `public.promotions.max_entries_per_member`; unique constraints `participations_id_promotion_unique`, `promotion_questions_id_promotion_kind_company_unique`, `promotion_question_options_id_question_unique`, `promotions_id_multiple_unique`; permission codes `participations.view`, `participations.create`, `participations.import`.

- [ ] **Step 1: Write the failing pgTAP suite**

Create `supabase/tests/05_participations.test.sql`. Count your assertions and set `plan(N)` to the number you actually wrote — every implementer on Block 4b's plan found a miscount in a number the author asserted from memory.

```sql
begin;
select plan(22);

-- Structure ------------------------------------------------------------------

select has_table('public', 'participations', 'participations exists');
select has_table('public', 'participation_answers', 'participation_answers exists');
select has_type('public', 'participation_status', 'the status enum exists');
select has_type('public', 'participation_source', 'the source enum exists');
select has_column('public', 'promotions', 'max_entries_per_member',
                  'a promotion can cap entries per person');

select is(relrowsecurity, true, 'RLS enabled on participations')
  from pg_class where oid = 'public.participations'::regclass;
select is(relrowsecurity, true, 'RLS enabled on participation_answers')
  from pg_class where oid = 'public.participation_answers'::regclass;

select ok(not has_table_privilege('authenticated', 'public.participations', 'INSERT'),
          'authenticated may not record a participation directly');

select is(
  (select count(*)::int from public.permissions where module = 'participations'),
  3, 'three participation permissions are catalogued');

-- Fixtures -------------------------------------------------------------------

insert into public.organizations (id, name) values
  ('00000000-0000-0000-0000-0000000004f1', 'Org 4c');
insert into public.companies (id, organization_id, name, timezone) values
  ('00000000-0000-0000-0000-0000000004g1', '00000000-0000-0000-0000-0000000004f1',
   'Station 4c', 'America/Sao_Paulo');
insert into public.members (id, organization_id, full_name) values
  ('00000000-0000-0000-0000-0000000004m1', '00000000-0000-0000-0000-0000000004f1', 'Ouvinte Um'),
  ('00000000-0000-0000-0000-0000000004m9', '00000000-0000-0000-0000-0000000004f1', 'Ouvinte Sem Vinculo');
insert into public.member_company_links (member_id, company_id, organization_id) values
  ('00000000-0000-0000-0000-0000000004m1', '00000000-0000-0000-0000-0000000004g1',
   '00000000-0000-0000-0000-0000000004f1');

insert into public.promotions
  (id, organization_id, company_id, name, starts_at, ends_at, allow_multiple_entries)
values
  ('00000000-0000-0000-0000-0000000004p1', '00000000-0000-0000-0000-0000000004f1',
   '00000000-0000-0000-0000-0000000004g1', 'Once only', '2026-08-01Z', '2026-08-31Z', false),
  ('00000000-0000-0000-0000-0000000004p2', '00000000-0000-0000-0000-0000000004f1',
   '00000000-0000-0000-0000-0000000004g1', 'Repeatable', '2026-08-01Z', '2026-08-31Z', true);
update public.promotions set min_hours_between_entries = 6
  where id = '00000000-0000-0000-0000-0000000004p2';

-- The ceiling ----------------------------------------------------------------

select throws_ok(
  $$update public.promotions set max_entries_per_member = 5
     where id = '00000000-0000-0000-0000-0000000004p1'$$,
  '23514', null, 'a ceiling on a promotion that forbids repeats is refused');

select throws_ok(
  $$update public.promotions set max_entries_per_member = 1
     where id = '00000000-0000-0000-0000-0000000004p2'$$,
  '23514', null, 'a ceiling of one is refused — that is what forbidding repeats already says');

prepare ceiling as
  update public.promotions set max_entries_per_member = 5
   where id = '00000000-0000-0000-0000-0000000004p2';
select lives_ok('ceiling', 'a ceiling of two or more on a repeatable promotion is legal');

-- The participation proves its Station and its listener ----------------------

prepare first_entry as
  insert into public.participations
    (promotion_id, member_id, organization_id, company_id, allows_multiple,
     status, source, participated_at)
  values ('00000000-0000-0000-0000-0000000004p1',
          '00000000-0000-0000-0000-0000000004m1',
          '00000000-0000-0000-0000-0000000004f1',
          '00000000-0000-0000-0000-0000000004g1', false,
          'VALID', 'MANUAL', '2026-08-05Z');
select lives_ok('first_entry', 'a participation for a linked listener is legal');

-- member_company_links is keyed on exactly this pair, so one constraint proves
-- both that the listener exists and that this Station has them. A key to
-- members (id, organization_id) would prove only the Organization.
select throws_ok(
  $$insert into public.participations
      (promotion_id, member_id, organization_id, company_id, allows_multiple,
       status, source, participated_at)
    values ('00000000-0000-0000-0000-0000000004p1',
            '00000000-0000-0000-0000-0000000004m9',
            '00000000-0000-0000-0000-0000000004f1',
            '00000000-0000-0000-0000-0000000004g1', false,
            'VALID', 'MANUAL', '2026-08-05Z')$$,
  '23503', null, 'a listener this Station is not linked to cannot participate');

-- The one-per-person index ---------------------------------------------------

select throws_ok(
  $$insert into public.participations
      (promotion_id, member_id, organization_id, company_id, allows_multiple,
       status, source, participated_at)
    values ('00000000-0000-0000-0000-0000000004p1',
            '00000000-0000-0000-0000-0000000004m1',
            '00000000-0000-0000-0000-0000000004f1',
            '00000000-0000-0000-0000-0000000004g1', false,
            'VALID', 'MANUAL', '2026-08-06Z')$$,
  '23505', null, 'a second VALID entry is refused where the promotion forbids repeats');

-- The index counts only VALID, which is what lets a refusal be recorded rather
-- than thrown away. Drop `status = 'VALID'` from its predicate and this case
-- goes red while the one above stays green.
prepare refused_beside_it as
  insert into public.participations
    (promotion_id, member_id, organization_id, company_id, allows_multiple,
     status, source, participated_at)
  values ('00000000-0000-0000-0000-0000000004p1',
          '00000000-0000-0000-0000-0000000004m1',
          '00000000-0000-0000-0000-0000000004f1',
          '00000000-0000-0000-0000-0000000004g1', false,
          'DUPLICATE', 'MANUAL', '2026-08-06Z');
select lives_ok('refused_beside_it',
  'a DUPLICATE may sit beside the VALID one it was refused for');

-- And the same pair repeats freely where the promotion allows it.
prepare repeat_ok as
  insert into public.participations
    (promotion_id, member_id, organization_id, company_id, allows_multiple,
     status, source, participated_at)
  values ('00000000-0000-0000-0000-0000000004p2',
          '00000000-0000-0000-0000-0000000004m1',
          '00000000-0000-0000-0000-0000000004f1',
          '00000000-0000-0000-0000-0000000004g1', true,
          'VALID', 'MANUAL', '2026-08-07Z');
select lives_ok('repeat_ok', 'a repeatable promotion takes the same listener twice');

-- The denormalised flag cannot drift, and turning repeats off is refused
-- while the data already breaks the rule. Same shape as 0041's "a quiz with a
-- right answer cannot become a poll".
select throws_ok(
  $$insert into public.participations
      (promotion_id, member_id, organization_id, company_id, allows_multiple,
       status, source, participated_at)
    values ('00000000-0000-0000-0000-0000000004p2',
            '00000000-0000-0000-0000-0000000004m1',
            '00000000-0000-0000-0000-0000000004f1',
            '00000000-0000-0000-0000-0000000004g1', false,
            'VALID', 'MANUAL', '2026-08-08Z')$$,
  '23503', null, 'a participation may not claim a repeat rule its promotion does not have');

insert into public.participations
  (promotion_id, member_id, organization_id, company_id, allows_multiple,
   status, source, participated_at)
values ('00000000-0000-0000-0000-0000000004p2',
        '00000000-0000-0000-0000-0000000004m1',
        '00000000-0000-0000-0000-0000000004f1',
        '00000000-0000-0000-0000-0000000004g1', true,
        'VALID', 'MANUAL', '2026-08-09Z');

select throws_ok(
  $$update public.promotions
       set allow_multiple_entries = false, min_hours_between_entries = null
     where id = '00000000-0000-0000-0000-0000000004p2'$$,
  '23505', null,
  'repeats cannot be turned off while one listener already has two valid entries');

-- Answers --------------------------------------------------------------------

insert into public.promotion_questions
  (id, promotion_id, organization_id, company_id, position, kind, prompt,
   menu_title, button_label)
values ('00000000-0000-0000-0000-0000000004q1',
        '00000000-0000-0000-0000-0000000004p1',
        '00000000-0000-0000-0000-0000000004f1', '00000000-0000-0000-0000-0000000004g1',
        1, 'QUIZ', 'Quem ganha?', 'Escolha', 'Opções'),
       ('00000000-0000-0000-0000-0000000004q2',
        '00000000-0000-0000-0000-0000000004p1',
        '00000000-0000-0000-0000-0000000004f1', '00000000-0000-0000-0000-0000000004g1',
        2, 'ESSAY', 'Por que você ouve?', null, null);
insert into public.promotion_question_options
  (id, question_id, kind, company_id, organization_id, position, label, is_correct)
values ('00000000-0000-0000-0000-0000000004o1', '00000000-0000-0000-0000-0000000004q1',
        'QUIZ', '00000000-0000-0000-0000-0000000004g1',
        '00000000-0000-0000-0000-0000000004f1', 1, 'Brasil', true);

prepare quiz_answer as
  insert into public.participation_answers
    (participation_id, promotion_id, question_id, kind, option_id,
     organization_id, company_id)
  select p.id, '00000000-0000-0000-0000-0000000004p1',
         '00000000-0000-0000-0000-0000000004q1', 'QUIZ',
         '00000000-0000-0000-0000-0000000004o1',
         '00000000-0000-0000-0000-0000000004f1', '00000000-0000-0000-0000-0000000004g1'
  from public.participations p
  where p.promotion_id = '00000000-0000-0000-0000-0000000004p1' and p.status = 'VALID';
select lives_ok('quiz_answer', 'a quiz answer naming its own option is legal');

select throws_ok(
  $$insert into public.participation_answers
      (participation_id, promotion_id, question_id, kind, answer_text,
       organization_id, company_id)
    select p.id, '00000000-0000-0000-0000-0000000004p1',
           '00000000-0000-0000-0000-0000000004q1', 'QUIZ', 'Brasil',
           '00000000-0000-0000-0000-0000000004f1', '00000000-0000-0000-0000-0000000004g1'
    from public.participations p
    where p.promotion_id = '00000000-0000-0000-0000-0000000004p1' and p.status = 'VALID'$$,
  '23514', null, 'a quiz answer may not be free text');

select throws_ok(
  $$insert into public.participation_answers
      (participation_id, promotion_id, question_id, kind, option_id,
       organization_id, company_id)
    select p.id, '00000000-0000-0000-0000-0000000004p1',
           '00000000-0000-0000-0000-0000000004q2', 'ESSAY',
           '00000000-0000-0000-0000-0000000004o1',
           '00000000-0000-0000-0000-0000000004f1', '00000000-0000-0000-0000-0000000004g1'
    from public.participations p
    where p.promotion_id = '00000000-0000-0000-0000-0000000004p1' and p.status = 'VALID'$$,
  '23514', null, 'an essay answer may not name an option');

-- The option belongs to the question, structurally rather than by check.
insert into public.promotion_questions
  (id, promotion_id, organization_id, company_id, position, kind, prompt,
   menu_title, button_label)
values ('00000000-0000-0000-0000-0000000004q3',
        '00000000-0000-0000-0000-0000000004p1',
        '00000000-0000-0000-0000-0000000004f1', '00000000-0000-0000-0000-0000000004g1',
        3, 'QUIZ', 'Outra?', 'Escolha', 'Opções');
select throws_ok(
  $$insert into public.participation_answers
      (participation_id, promotion_id, question_id, kind, option_id,
       organization_id, company_id)
    select p.id, '00000000-0000-0000-0000-0000000004p1',
           '00000000-0000-0000-0000-0000000004q3', 'QUIZ',
           '00000000-0000-0000-0000-0000000004o1',
           '00000000-0000-0000-0000-0000000004f1', '00000000-0000-0000-0000-0000000004g1'
    from public.participations p
    where p.promotion_id = '00000000-0000-0000-0000-0000000004p1' and p.status = 'VALID'$$,
  '23503', null, 'an answer may not name an option from another question');

select throws_ok(
  $$insert into public.participation_answers
      (participation_id, promotion_id, question_id, kind, option_id,
       organization_id, company_id)
    select p.id, '00000000-0000-0000-0000-0000000004p1',
           '00000000-0000-0000-0000-0000000004q1', 'QUIZ',
           '00000000-0000-0000-0000-0000000004o1',
           '00000000-0000-0000-0000-0000000004f1', '00000000-0000-0000-0000-0000000004g1'
    from public.participations p
    where p.promotion_id = '00000000-0000-0000-0000-0000000004p1' and p.status = 'VALID'$$,
  '23505', null, 'one answer per question per participation');

select * from finish();
rollback;
```

**Note on the fixture uuids:** `g1`, `m1`, `p1`, `q1`, `o1` are not hexadecimal. Replace the non-hex letters with digits before running — for example `…04c1`, `…04d1`, `…04e1`, `…04a1`, `…04b1` — and keep them distinct. This is called out because a bad uuid literal fails with a cast error that reads nothing like the assertion it breaks.

- [ ] **Step 2: Run it and confirm it fails for the right reason**

Run: `npm run db:reset && npm run db:test`

Expected: `05_participations.test.sql` fails at the first `has_table` — `relation "public.participations" does not exist`. `00`–`04` stay green.

- [ ] **Step 3: Write the migration**

Create `supabase/migrations/0052_participations.sql`:

```sql
-- supabase/migrations/0052_participations.sql

-- Four outcomes, one column. The brainstorming sketch had three statuses and a
-- free-text reason beside them, and it was replaced for two reasons: the reason
-- would have to be parsed to answer "show me everything refused for coming in
-- too early", which is a question the screen will be asked; and DUPLICATE would
-- have appeared both as a status and as a reason, so two columns would encode
-- one fact and could disagree.
create type public.participation_status as enum (
  'VALID', 'DUPLICATE', 'TOO_SOON', 'OVER_LIMIT'
);

comment on type public.participation_status is
  'What happened to an attempt. Never says whether the quiz was answered correctly — that is a draw-time question (Block 6) read off the answers, and a wrong answer refuses nobody.';

-- Block 5 adds WHATSAPP. Deliberately separate from status: how somebody entered
-- and whether it counted are independent, and every combination of the two is
-- real.
create type public.participation_source as enum ('MANUAL', 'IMPORT');

-- The ceiling D1 asked for. Meaningful only where repeats are already allowed,
-- and never one: a ceiling of one is what allow_multiple_entries = false already
-- says, and two ways to say one thing is one way too many.
alter table public.promotions
  add column max_entries_per_member integer;

alter table public.promotions
  add constraint promotions_entry_ceiling_shape check (
    max_entries_per_member is null
    or (allow_multiple_entries and max_entries_per_member >= 2)
  );

comment on column public.promotions.max_entries_per_member is
  'How many times one person may enter. Null means no ceiling. Counted under the same advisory lock as the interval (0054), so two near-simultaneous entries cannot both pass it.';

-- The foreign-key target that makes the partial unique index below possible.
-- allow_multiple_entries lives here and an index on participations cannot see
-- another table, so the flag is denormalised there and proved by this key.
alter table public.promotions
  add constraint promotions_id_multiple_unique unique (id, allow_multiple_entries);

-- Targets the answers table needs. Each exists so a child can prove a fact in
-- one constraint rather than by convention, the same reason 0041 carries
-- promotion_questions_id_kind_company_unique.
alter table public.promotion_questions
  add constraint promotion_questions_id_promotion_kind_company_unique
  unique (id, promotion_id, kind, company_id);

alter table public.promotion_question_options
  add constraint promotion_question_options_id_question_unique
  unique (id, question_id);

create table public.participations (
  id              uuid primary key default gen_random_uuid(),
  promotion_id    uuid not null,
  member_id       uuid not null,
  organization_id uuid not null references public.organizations (id),
  company_id      uuid not null,

  -- Denormalised from the promotion, and not for convenience: the partial
  -- unique index below is the whole reason it exists, and the foreign key with
  -- ON UPDATE CASCADE is what stops it drifting from its source.
  allows_multiple boolean not null,

  status public.participation_status not null,
  source public.participation_source not null,

  -- When the person actually entered, which is not when the row was written.
  -- The minimum interval measures against this, so a historical import stamped
  -- "now" on every row would refuse its own second entry for a person and give
  -- a reason that is not true.
  participated_at timestamptz not null,

  created_by uuid references auth.users (id),
  created_at timestamptz not null default now(),

  -- No updated_at and no deleted_at. A participation is a thing that happened;
  -- it is not edited and it is not withdrawn, the same reasoning
  -- inventory_movements (0026) carries for the ledger.

  constraint participations_promotion_fk
    foreign key (promotion_id, company_id)
    references public.promotions (id, company_id),

  -- member_company_links is keyed on exactly this pair, so this one constraint
  -- proves the listener exists AND that this Station has them. A key to
  -- members (id, organization_id) would prove only the Organization, and an
  -- Organization with two Stations would let a participation name somebody this
  -- Station has never heard of.
  constraint participations_member_link_fk
    foreign key (member_id, company_id)
    references public.member_company_links (member_id, company_id),

  constraint participations_company_org_fk
    foreign key (company_id, organization_id)
    references public.companies (id, organization_id),

  constraint participations_allows_multiple_fk
    foreign key (promotion_id, allows_multiple)
    references public.promotions (id, allow_multiple_entries)
    on update cascade
);

comment on table public.participations is
  'One row per attempt, including the refused ones. A refusal is recorded rather than thrown away because Block 5 will have no choice about it — a message arrived, and what happened to it has to be on the record — and building it now means Block 5 adds a source, not a column and a second write path.';

-- ON UPDATE CASCADE on the flag above is what earns this its keep: turning
-- "allows repeats" off on a promotion where one person already holds two valid
-- entries cascades the new value onto them and this index refuses the whole
-- update. The operator is stopped rather than left with a promotion whose stated
-- rule its own data breaks. Same shape as 0041's "a quiz with a right answer
-- cannot become a poll".
create unique index participations_one_per_member
  on public.participations (promotion_id, member_id)
  where status = 'VALID' and not allows_multiple;

-- The list orders by when somebody entered, newest first, tie-broken by id — a
-- keyset cursor must compare exactly what it orders by (Block 3b), so the index
-- carries both.
create index participations_listing_idx
  on public.participations (promotion_id, participated_at desc, id desc);

create index participations_member_idx
  on public.participations (member_id, participated_at desc);

-- The foreign-key target the answers need to prove they belong to the same
-- promotion as their participation.
alter table public.participations
  add constraint participations_id_promotion_unique unique (id, promotion_id);

create table public.participation_answers (
  id               uuid primary key default gen_random_uuid(),
  participation_id uuid not null,
  promotion_id     uuid not null,
  question_id      uuid not null,
  kind             public.promotion_question_kind not null,

  option_id   uuid,
  answer_text text,

  organization_id uuid not null references public.organizations (id),
  company_id      uuid not null,
  created_at      timestamptz not null default now(),

  -- Three keys, three different facts, none of them left to a check or to the
  -- RPC remembering. The answer belongs to a participation in this promotion;
  -- the question belongs to this promotion, has this kind and lives in this
  -- Station; the option belongs to this question.
  constraint participation_answers_participation_fk
    foreign key (participation_id, promotion_id)
    references public.participations (id, promotion_id),
  constraint participation_answers_question_fk
    foreign key (question_id, promotion_id, kind, company_id)
    references public.promotion_questions (id, promotion_id, kind, company_id),
  constraint participation_answers_option_fk
    foreign key (option_id, question_id)
    references public.promotion_question_options (id, question_id),

  constraint participation_answers_shape check (
    (kind = 'ESSAY'
       and option_id is null
       and answer_text is not null and length(btrim(answer_text)) > 0)
    or (kind in ('QUIZ', 'MULTIPLE_CHOICE')
       and option_id is not null and answer_text is null)
  ),

  constraint participation_answers_one_per_question
    unique (participation_id, question_id)
);

comment on table public.participation_answers is
  'What the person answered, not whether they were right. Block 6 derives correctness at draw time by joining promotion_question_options.is_correct; storing a flag here would be a second place telling the same truth, and Block 4a''s D9 freeze — no option may be reworded once somebody has chosen it — is what makes deriving it safe.';

create index participation_answers_participation_idx
  on public.participation_answers (participation_id);

alter table public.participations        enable row level security;
alter table public.participation_answers enable row level security;

-- A permission is born beside the feature it guards. Its own module rather than
-- more promotions.* codes, because participations get their own screen and every
-- screen-level module in this project owns its codes.
insert into public.permissions (code, description, introduced_by_block, module, label, scope, display_order) values
  ('participations.view',   'Read participations',              '4c', 'participations', 'See participations',       'company', 10),
  ('participations.create', 'Record a participation by hand',   '4c', 'participations', 'Record a participation',   'company', 20),
  ('participations.import', 'Import participations from a file','4c', 'participations', 'Import participations',    'company', 30);
```

- [ ] **Step 4: Run the suite green**

Run: `npm run db:reset && npm run db:test`

Expected: all five files pass. If `repeats cannot be turned off while one listener already has two valid entries` fails with `23503` rather than `23505`, the cascade is firing but the participation rows are being rejected by the flag key before the index sees them — check that both entries were inserted with `allows_multiple = true`.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/0052_participations.sql supabase/tests/05_participations.test.sql
git commit -m "$(cat <<'EOF'
feat(participations): the table, the answers, and the ceiling a promotion may set

The v1 design asks for a partial unique index enforcing one entry per person
when the promotion forbids repeats, and it cannot be written as stated: the flag
lives on promotions and an index on participations cannot see another table. The
flag is denormalised and proved by a composite key with ON UPDATE CASCADE, so
turning repeats off on a promotion whose own data already breaks that rule is
refused rather than recorded.

The index counts only VALID rows, which is what lets a refusal be recorded
beside the entry it was refused for instead of thrown away.

A participation proves its listener through member_company_links rather than
through members, because that table is keyed on exactly the pair that matters:
one constraint says both that the listener exists and that this Station has them.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: The read gate on both tables

**Files:**
- Create: `supabase/migrations/0053_rls_participations.sql`
- Modify: `supabase/tests/05_participations.test.sql` (plan count + a new section)

**Interfaces:**
- Consumes: `public.has_permission(text, uuid)` (`0024`), the `promotions` read policy (`0044:43`).
- Produces: policies `participations_select_participations_view` and `participation_answers_select_participations_view`; `select` granted to `authenticated` and `service_role` on both tables and nothing else.

Like `0046`, this comes before the function migrations rather than last in the block: every task after this asserts state by reading these two tables.

- [ ] **Step 1: Write the failing assertions**

Raise `05_participations.test.sql`'s plan by the number of assertions you add and append this before the final `select * from finish();`:

```sql
-- The read gate --------------------------------------------------------------

select ok(has_table_privilege('authenticated', 'public.participations', 'SELECT'),
          'authenticated may read participations, subject to policy');
select ok(has_table_privilege('service_role', 'public.participation_answers', 'SELECT'),
          'service_role may read answers — BYPASSRLS is not a grant');
select ok(not has_table_privilege('service_role', 'public.participations', 'TRUNCATE'),
          'service_role may not truncate participations');
select ok(not has_table_privilege('service_role', 'public.participation_answers', 'TRUNCATE'),
          'service_role may not truncate answers');

select is(
  (select count(*)::int from pg_policies
    where schemaname = 'public' and tablename = 'participations'),
  1, 'participations carries exactly one policy, and it is a read policy');
select is(
  (select count(*)::int from pg_policies
    where schemaname = 'public' and tablename = 'participation_answers'),
  1, 'participation_answers carries exactly one policy, and it is a read policy');

-- Fails closed against a row that exists. The claim names a user with no
-- membership anywhere, and the fixtures above left real participations behind,
-- so a zero here is a denial and not an empty table.
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-0000000004ff", "role": "authenticated"}';

create temporary view stranger_participations as
  select id from public.participations;

reset role;
select is(
  (select count(*)::int from stranger_participations),
  0, 'a caller holding participations.view nowhere reads no participations at all');
```

- [ ] **Step 2: Run it and confirm it fails for the right reason**

Run: `npm run db:reset && npm run db:test`

Expected: the two `has_table_privilege(… 'SELECT')` assertions fail — no grant exists yet — and both policy counts read 0. The fail-closed assertion passes already, because RLS with no policy denies everything; that is why it is not the assertion this task rests on.

- [ ] **Step 3: Write the migration**

Create `supabase/migrations/0053_rls_participations.sql`:

```sql
-- supabase/migrations/0053_rls_participations.sql

revoke all on public.participations        from anon, authenticated;
revoke all on public.participation_answers from anon, authenticated;

-- No table takes an insert, update or delete grant from any role, service_role
-- included: every write goes through a SECURITY DEFINER RPC (0054) that runs as
-- the table owner and needs no grant of its own.
grant select on public.participations        to authenticated, service_role;
grant select on public.participation_answers to authenticated, service_role;

-- `revoke all` above ran against anon and authenticated only, so service_role
-- kept the default ACL's TRUNCATE on both. Closed here at the same time as the
-- grant rather than after somebody notices — 0029 had to come back for this one.
revoke truncate on public.participations        from service_role;
revoke truncate on public.participation_answers from service_role;

-- The `promotion_id in (select ...)` clause is not redundant with the permission
-- check beside it. That subquery is itself filtered by 0044's policy on
-- promotions, which hides an archived promotion from everyone but the
-- Organization owner and the platform admin. Without it, a delegate who kept an
-- id could read the participations of a promotion that has left every one of
-- their other reads — the participations, not the promotion, would become the
-- leak.
create policy participations_select_participations_view on public.participations
  for select to authenticated
  using (
    public.has_permission('participations.view', company_id)
    and promotion_id in (select id from public.promotions)
  );

-- Same shape one level down, and the subquery is what carries the
-- archived-promotion rule from the policy above rather than restating it.
create policy participation_answers_select_participations_view on public.participation_answers
  for select to authenticated
  using (
    public.has_permission('participations.view', company_id)
    and participation_id in (select id from public.participations)
  );
```

- [ ] **Step 4: Run the suite green, then commit**

Run: `npm run db:reset && npm run db:test`

```bash
git add supabase/migrations/0053_rls_participations.sql supabase/tests/05_participations.test.sql
git commit -m "$(cat <<'EOF'
feat(participations): the read gate on both tables

Read-only for both roles, gated on participations.view, with the
archived-promotion rule inherited through a subquery over promotions rather than
restated — a delegate who kept an id must not be able to read the participations
of a promotion that has left every one of their other reads.

TRUNCATE is revoked from service_role in the same migration as the grant.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Recording one participation, and the lock N3 asks for

**Files:**
- Create: `supabase/migrations/0054_participation_rpcs.sql` (this task writes the first two functions; Task 4 appends the third to the same file, before either is committed — so **do not commit `0054` until Task 4**; commit only the tests and the harness change here, or hold the migration back as the tasks direct below)
- Create: `tests/isolation/participations.test.ts`
- Modify: `scripts/verify-isolation-suite.mjs` (the `REQUIRED_TEST_FILES` manifest)

**Interfaces:**
- Consumes: `public.find_member_by_identifier(p_organization_id uuid, p_phone text, p_email text, p_cpf_hash text, p_passport text) returns jsonb` (`0033`) — outcomes `none`, `visible` (with `member_id`), `elsewhere`; gated on `members.view` across the Organization. `public.create_member(p_company_id uuid, p_full_name text, p_phone text, p_email text, p_cpf_hash text, p_cpf_last_digits text, p_passport text, …) returns uuid` (`0034:60`), gated on `members.create`.
- Produces:
  - `public.resolve_or_create_member(p_company_id uuid, p_full_name text, p_phone text default null, p_email text default null, p_cpf_hash text default null, p_cpf_last_digits text default null, p_passport text default null) returns jsonb` — `{outcome: 'resolved'|'created'|'elsewhere', member_id?}`.
  - `public.record_participation(p_promotion_id uuid, p_member_id uuid, p_participated_at timestamptz, p_source public.participation_source, p_answers jsonb) returns jsonb` — `{participation_id, status}`.

- [ ] **Step 1: Register the new test file with the isolation guard**

`npm run test:isolation` fails closed on a file that does not report, and the manifest is checked in. Add `'participations.test.ts'` to `REQUIRED_TEST_FILES` in `scripts/verify-isolation-suite.mjs`, keeping the list in the order it already uses.

This is step 1 rather than an afterthought because the guard fails the run until it is done, and a failing guard on an unrelated cause is exactly the noise that hides a real one.

- [ ] **Step 2: Write the failing isolation suite**

Create `tests/isolation/participations.test.ts`. Every case is driven by a non-owner delegate, for the reason `members.test.ts`'s header gives: Block 1c shipped two defects that thirteen reviews missed because the owner drove every scenario and the owner's bypass hid the delegate's failure.

```ts
import { afterAll, describe, expect, it } from 'vitest';
import {
  addCompany,
  cleanupUsers,
  createMemberAs,
  grantRoleWith,
  provisionCustomer,
  signInAs,
} from './harness';
import type { ProvisionedCustomer } from './harness';

afterAll(cleanupUsers);

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

async function clientFor(user: { email: string; password: string }) {
  return signInAs(user.email, user.password);
}

/** A promotion on air now, registered by the owner. Fixture, never the operation under test. */
async function promotionAsOwner(
  customer: ProvisionedCustomer,
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const owner = await clientFor(customer);
  const { data, error } = await owner.rpc('create_promotion', {
    p_company_id: customer.companyId,
    p_name: `Promo ${Math.random().toString(36).slice(2, 8)}`,
    p_starts_at: new Date(Date.now() - 2 * DAY).toISOString(),
    p_ends_at: new Date(Date.now() + 20 * DAY).toISOString(),
    ...overrides,
  });
  if (error) throw new Error(`create_promotion failed: ${error.message}`);
  return data as string;
}

describe('recording a participation', () => {
  it('records a valid entry and returns the status', async () => {
    const label = `part-ok-${Date.now()}`;
    const customer = await provisionCustomer(label);
    const memberId = await createMemberAs(customer, customer.companyId, {
      fullName: 'Ouvinte Um',
      phone: '11988887777',
    });
    const promotionId = await promotionAsOwner(customer);

    const delegate = await grantRoleWith(customer, label, [
      'promotions.view',
      'participations.view',
      'participations.create',
    ]);
    const client = await clientFor(delegate);

    const first = await client.rpc('record_participation', {
      p_promotion_id: promotionId,
      p_member_id: memberId,
      p_participated_at: new Date().toISOString(),
      p_source: 'MANUAL',
      p_answers: [],
    });
    expect(first.error).toBeNull();
    expect(first.data).toMatchObject({ status: 'VALID' });

    const rows = await client
      .from('participations')
      .select('status, source, member_id')
      .eq('promotion_id', promotionId);
    expect(rows.data).toEqual([
      { status: 'VALID', source: 'MANUAL', member_id: memberId },
    ]);
  });

  it('records the second attempt as DUPLICATE rather than refusing it', async () => {
    const label = `part-dup-${Date.now()}`;
    const customer = await provisionCustomer(label);
    const memberId = await createMemberAs(customer, customer.companyId, {
      fullName: 'Ouvinte Dois',
      phone: '11988887778',
    });
    const promotionId = await promotionAsOwner(customer);

    const delegate = await grantRoleWith(customer, label, [
      'promotions.view',
      'participations.view',
      'participations.create',
    ]);
    const client = await clientFor(delegate);

    const entry = { p_promotion_id: promotionId, p_member_id: memberId, p_source: 'MANUAL', p_answers: [] };
    await client.rpc('record_participation', { ...entry, p_participated_at: new Date().toISOString() });
    const second = await client.rpc('record_participation', {
      ...entry,
      p_participated_at: new Date().toISOString(),
    });

    // Not an error. The attempt is recorded with the status that says what
    // happened to it, which is what Block 5's bot will need without a choice.
    expect(second.error).toBeNull();
    expect(second.data).toMatchObject({ status: 'DUPLICATE' });

    const rows = await client
      .from('participations')
      .select('status')
      .eq('promotion_id', promotionId)
      .order('status');
    expect(rows.data).toEqual([{ status: 'DUPLICATE' }, { status: 'VALID' }]);
  });

  it('records TOO_SOON inside the interval and VALID after it', async () => {
    const label = `part-soon-${Date.now()}`;
    const customer = await provisionCustomer(label);
    const memberId = await createMemberAs(customer, customer.companyId, {
      fullName: 'Ouvinte Tres',
      phone: '11988887779',
    });
    const promotionId = await promotionAsOwner(customer, {
      p_allow_multiple_entries: true,
      p_min_hours_between_entries: 6,
    });

    const delegate = await grantRoleWith(customer, label, [
      'promotions.view',
      'participations.view',
      'participations.create',
    ]);
    const client = await clientFor(delegate);

    const base = Date.now();
    const entry = { p_promotion_id: promotionId, p_member_id: memberId, p_source: 'MANUAL', p_answers: [] };

    const first = await client.rpc('record_participation', {
      ...entry,
      p_participated_at: new Date(base - 10 * HOUR).toISOString(),
    });
    expect(first.data).toMatchObject({ status: 'VALID' });

    // Two hours after the first: inside the six-hour interval.
    const tooSoon = await client.rpc('record_participation', {
      ...entry,
      p_participated_at: new Date(base - 8 * HOUR).toISOString(),
    });
    expect(tooSoon.data).toMatchObject({ status: 'TOO_SOON' });

    // Ten hours after the first: outside it.
    const later = await client.rpc('record_participation', {
      ...entry,
      p_participated_at: new Date(base).toISOString(),
    });
    expect(later.data).toMatchObject({ status: 'VALID' });
  });

  it('records OVER_LIMIT once the ceiling is reached', async () => {
    const label = `part-limit-${Date.now()}`;
    const customer = await provisionCustomer(label);
    const memberId = await createMemberAs(customer, customer.companyId, {
      fullName: 'Ouvinte Quatro',
      phone: '11988887770',
    });
    const promotionId = await promotionAsOwner(customer, {
      p_allow_multiple_entries: true,
      p_min_hours_between_entries: 1,
    });

    const owner = await clientFor(customer);
    await owner.rpc('update_promotion', {
      p_promotion_id: promotionId,
      p_name: 'Com teto',
      p_starts_at: new Date(Date.now() - 2 * DAY).toISOString(),
      p_ends_at: new Date(Date.now() + 20 * DAY).toISOString(),
      p_allow_multiple_entries: true,
      p_min_hours_between_entries: 1,
      p_max_entries_per_member: 2,
    });

    const delegate = await grantRoleWith(customer, label, [
      'promotions.view',
      'participations.view',
      'participations.create',
    ]);
    const client = await clientFor(delegate);

    const base = Date.now();
    const entry = { p_promotion_id: promotionId, p_member_id: memberId, p_source: 'MANUAL', p_answers: [] };

    const a = await client.rpc('record_participation', { ...entry, p_participated_at: new Date(base - 5 * HOUR).toISOString() });
    const b = await client.rpc('record_participation', { ...entry, p_participated_at: new Date(base - 3 * HOUR).toISOString() });
    const c = await client.rpc('record_participation', { ...entry, p_participated_at: new Date(base).toISOString() });

    expect(a.data).toMatchObject({ status: 'VALID' });
    expect(b.data).toMatchObject({ status: 'VALID' });
    // The ceiling counts VALID entries only, so the third is refused for the
    // ceiling and not for the interval — which is why the fixture leaves two
    // hours between each.
    expect(c.data).toMatchObject({ status: 'OVER_LIMIT' });
  });

  it('stores the answers, and stores them for a refused attempt too', async () => {
    const label = `part-answers-${Date.now()}`;
    const customer = await provisionCustomer(label);
    const memberId = await createMemberAs(customer, customer.companyId, {
      fullName: 'Ouvinte Cinco',
      phone: '11988887771',
    });
    const promotionId = await promotionAsOwner(customer);

    const owner = await clientFor(customer);
    const { data: questionId } = await owner.rpc('save_promotion_question', {
      p_promotion_id: promotionId,
      p_kind: 'QUIZ',
      p_prompt: 'Quem ganha a Copa?',
      p_menu_title: 'Escolha',
      p_button_label: 'Opções',
      p_options: [
        { label: 'Brasil', is_correct: true },
        { label: 'Argentina', is_correct: false },
      ],
    });

    const delegate = await grantRoleWith(customer, label, [
      'promotions.view',
      'participations.view',
      'participations.create',
    ]);
    const client = await clientFor(delegate);

    const { data: options } = await client
      .from('promotion_question_options')
      .select('id, label')
      .eq('question_id', questionId as string);
    const brasil = options!.find((o) => o.label === 'Brasil')!.id;

    const entry = {
      p_promotion_id: promotionId,
      p_member_id: memberId,
      p_source: 'MANUAL',
      p_answers: [{ question_id: questionId, option_id: brasil }],
    };

    const first = await client.rpc('record_participation', {
      ...entry,
      p_participated_at: new Date().toISOString(),
    });
    expect(first.data).toMatchObject({ status: 'VALID' });

    const second = await client.rpc('record_participation', {
      ...entry,
      p_participated_at: new Date().toISOString(),
    });
    expect(second.data).toMatchObject({ status: 'DUPLICATE' });

    // Both attempts keep what the person said. The status says whether it
    // counted; the answer says what happened, and Block 5 will want the answer
    // of a duplicate message for exactly the same reason.
    const answers = await client
      .from('participation_answers')
      .select('participation_id, option_id')
      .eq('promotion_id', promotionId);
    expect(answers.data).toHaveLength(2);
    expect(answers.data!.every((a) => a.option_id === brasil)).toBe(true);
  });

  it('refuses a cancelled promotion, one outside its window, and a listener from another Station', async () => {
    const label = `part-refuse-${Date.now()}`;
    const customer = await provisionCustomer(label);
    const otherCompanyId = await addCompany(customer, `Second ${label}`);
    const memberId = await createMemberAs(customer, customer.companyId, {
      fullName: 'Ouvinte Seis',
      phone: '11988887772',
    });
    const foreignMemberId = await createMemberAs(customer, otherCompanyId, {
      fullName: 'Ouvinte De Fora',
      phone: '11988887773',
    });

    const delegate = await grantRoleWith(customer, label, [
      'promotions.view',
      'promotions.cancel',
      'participations.view',
      'participations.create',
    ]);
    const client = await clientFor(delegate);

    const cancelled = await promotionAsOwner(customer);
    await client.rpc('cancel_promotion', {
      p_promotion_id: cancelled,
      p_reason: 'sponsor pulled out',
    });
    const onCancelled = await client.rpc('record_participation', {
      p_promotion_id: cancelled,
      p_member_id: memberId,
      p_participated_at: new Date().toISOString(),
      p_source: 'MANUAL',
      p_answers: [],
    });
    expect(onCancelled.error?.code).toBe('22023');

    const scheduled = await promotionAsOwner(customer, {
      p_starts_at: new Date(Date.now() + 7 * DAY).toISOString(),
      p_ends_at: new Date(Date.now() + 30 * DAY).toISOString(),
    });
    const beforeOpen = await client.rpc('record_participation', {
      p_promotion_id: scheduled,
      p_member_id: memberId,
      p_participated_at: new Date().toISOString(),
      p_source: 'MANUAL',
      p_answers: [],
    });
    expect(beforeOpen.error?.code).toBe('22023');

    const open = await promotionAsOwner(customer);
    const crossStation = await client.rpc('record_participation', {
      p_promotion_id: open,
      p_member_id: foreignMemberId,
      p_participated_at: new Date().toISOString(),
      p_source: 'MANUAL',
      p_answers: [],
    });
    expect(crossStation.error?.code).toBe('P0002');
  });

  it('refuses a delegate who may see participations but not record one', async () => {
    const label = `part-perm-${Date.now()}`;
    const customer = await provisionCustomer(label);
    const memberId = await createMemberAs(customer, customer.companyId, {
      fullName: 'Ouvinte Sete',
      phone: '11988887774',
    });
    const promotionId = await promotionAsOwner(customer);

    const delegate = await grantRoleWith(customer, label, [
      'promotions.view',
      'participations.view',
    ]);
    const client = await clientFor(delegate);

    const denied = await client.rpc('record_participation', {
      p_promotion_id: promotionId,
      p_member_id: memberId,
      p_participated_at: new Date().toISOString(),
      p_source: 'MANUAL',
      p_answers: [],
    });
    expect(denied.error?.code).toBe('42501');
  });

  // This is the case N3 exists for, and the one the mutation in Task 10 targets.
  it('lets exactly one of two simultaneous entries be VALID', async () => {
    const label = `part-race-${Date.now()}`;
    const customer = await provisionCustomer(label);
    const memberId = await createMemberAs(customer, customer.companyId, {
      fullName: 'Ouvinte Oito',
      phone: '11988887775',
    });
    const promotionId = await promotionAsOwner(customer);

    const delegate = await grantRoleWith(customer, label, [
      'promotions.view',
      'participations.view',
      'participations.create',
    ]);
    // Two separate clients, so the two calls are two connections rather than
    // two statements queued on one.
    const a = await clientFor(delegate);
    const b = await clientFor(delegate);

    const entry = {
      p_promotion_id: promotionId,
      p_member_id: memberId,
      p_participated_at: new Date().toISOString(),
      p_source: 'MANUAL' as const,
      p_answers: [],
    };

    const [first, second] = await Promise.all([
      a.rpc('record_participation', entry),
      b.rpc('record_participation', entry),
    ]);

    expect(first.error).toBeNull();
    expect(second.error).toBeNull();

    // Exactly one VALID and exactly one DUPLICATE — asserted on the statuses
    // rather than on a count, because the partial unique index would also
    // produce "one row" by raising 23505 on the loser. The whole point of the
    // lock is that the loser is RECORDED as a duplicate rather than lost, and
    // only the status can tell those two outcomes apart.
    const statuses = [first.data, second.data]
      .map((d) => (d as { status: string }).status)
      .sort();
    expect(statuses).toEqual(['DUPLICATE', 'VALID']);
  });
});
```

- [ ] **Step 3: Run it and confirm it fails for the right reason**

Run: `npm run db:reset && npm run test:isolation -- tests/isolation/participations.test.ts`

Expected: every case fails with `Could not find the function public.record_participation` (PostgREST `PGRST202`). Nothing fails on a fixture. If the guard complains that `participations.test.ts` is not in the manifest, Step 1 was skipped.

- [ ] **Step 4: Write the two functions**

Create `supabase/migrations/0054_participation_rpcs.sql` with the following. Task 4 appends `import_participations` to this same file.

```sql
-- supabase/migrations/0054_participation_rpcs.sql
--
-- Each function checks its own permission beside the operation rather than
-- inside a shared helper, for the reason 0027's own comment gives: a reader
-- looking for "who may do this" finds it next to the thing being done.

-- ---------------------------------------------------------------------------
-- Resolution, shared by both doors so they cannot drift. SECURITY INVOKER and
-- granted to authenticated: it holds no privileges of its own because both
-- functions it calls are SECURITY DEFINER and re-check the caller against
-- auth.uid() themselves. Making it DEFINER would grant it rights it never uses.
--
-- find_member_by_identifier answers one of three things and all three have a
-- destination here. `elsewhere` means an identifier matches somebody this
-- caller may not reach: it deliberately returns no id, and registering anyway
-- is impossible because 0031's per-Organization unique indexes on phone,
-- e-mail, CPF and passport would refuse the duplicate. That outcome is passed
-- back for the caller to report, which for the import means a skipped row.
-- ---------------------------------------------------------------------------
create or replace function public.resolve_or_create_member(
  p_company_id      uuid,
  p_full_name       text,
  p_phone           text default null,
  p_email           text default null,
  p_cpf_hash        text default null,
  p_cpf_last_digits text default null,
  p_passport        text default null
)
returns jsonb
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  v_org     uuid;
  v_found   jsonb;
  v_id      uuid;
begin
  select organization_id into v_org
  from public.companies
  where id = p_company_id and deleted_at is null;

  if not found then
    raise exception 'station not found: %', p_company_id using errcode = 'P0002';
  end if;

  v_found := public.find_member_by_identifier(
    v_org, p_phone, p_email, p_cpf_hash, p_passport);

  if v_found ->> 'outcome' = 'visible' then
    return jsonb_build_object(
      'outcome', 'resolved', 'member_id', (v_found ->> 'member_id')::uuid);
  end if;

  if v_found ->> 'outcome' = 'elsewhere' then
    return jsonb_build_object('outcome', 'elsewhere');
  end if;

  v_id := public.create_member(
    p_company_id, p_full_name, p_phone, p_email,
    p_cpf_hash, p_cpf_last_digits, p_passport);

  return jsonb_build_object('outcome', 'created', 'member_id', v_id);
end;
$$;

revoke execute on function public.resolve_or_create_member(uuid, text, text, text, text, text, text) from public;
grant execute on function public.resolve_or_create_member(uuid, text, text, text, text, text, text) to authenticated;

comment on function public.resolve_or_create_member(uuid, text, text, text, text, text, text) is
  'Finds a listener through Block 3''s deduplication or registers one, and is the single resolution path both the manual form and the import use — one rule with two entrances is the shape Block 4b was sent back to fix twice. SECURITY INVOKER: find_member_by_identifier (0033) gates on members.view across the Organization and create_member (0034) on members.create, both against auth.uid(), so this function needs no privileges of its own. Returns resolved, created, or elsewhere — the last meaning an identifier matches a listener this caller may not reach, which is not an error and not a registration: 0031''s unique indexes would refuse the duplicate, so the caller reports it and moves on.';

-- ---------------------------------------------------------------------------
-- One participation. The rules are applied and the row written inside one
-- transaction, under an advisory lock over the pair.
-- ---------------------------------------------------------------------------
create or replace function public.record_participation(
  p_promotion_id    uuid,
  p_member_id       uuid,
  p_participated_at timestamptz,
  p_source          public.participation_source,
  p_answers         jsonb default '[]'
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor     uuid := auth.uid();
  v_org       uuid;
  v_company   uuid;
  v_multiple  boolean;
  v_min_hours integer;
  v_ceiling   integer;
  v_cancelled timestamptz;
  v_deleted   timestamptz;
  v_starts    timestamptz;
  v_ends      timestamptz;
  v_status    public.participation_status;
  v_id        uuid;
  v_when      timestamptz := coalesce(p_participated_at, now());
  v_answer    jsonb;
begin
  select organization_id, company_id, allow_multiple_entries,
         min_hours_between_entries, max_entries_per_member,
         cancelled_at, deleted_at, starts_at, ends_at
    into v_org, v_company, v_multiple,
         v_min_hours, v_ceiling,
         v_cancelled, v_deleted, v_starts, v_ends
  from public.promotions
  where id = p_promotion_id;

  if not found or v_deleted is not null then
    raise exception 'promotion not found: %', p_promotion_id using errcode = 'P0002';
  end if;

  if not public.has_permission('participations.create', v_company) then
    raise log 'record_participation denied: actor=% promotion=%', v_actor, p_promotion_id;
    raise exception 'permission denied: participations.create required' using errcode = '42501';
  end if;

  if v_cancelled is not null then
    raise exception 'this promotion is cancelled and is not taking entries'
      using errcode = '22023';
  end if;

  -- Refused rather than recorded with a status, and the distinction is the
  -- point: the four statuses are all about one person entering too often. A
  -- promotion that is not open is not a fact about the person, and inventing a
  -- fifth status for it would let the draw's "VALID only" filter go on looking
  -- complete while hiding a different kind of problem.
  if v_when < v_starts or v_when >= v_ends then
    raise exception 'this promotion was not taking entries at %', v_when
      using errcode = '22023';
  end if;

  -- The composite key on participations would refuse a listener this Station is
  -- not linked to anyway, but with a constraint name rather than the sentence a
  -- caller can act on — the same reasoning apply_inventory_movement (0047)
  -- gives for its own sufficiency check.
  if not exists (
    select 1 from public.member_company_links
    where member_id = p_member_id and company_id = v_company
  ) then
    raise exception 'listener not found in this station: %', p_member_id using errcode = 'P0002';
  end if;

  -- N3. An advisory lock over the pair rather than a row lock, for two reasons
  -- the alternatives cannot answer. FOR UPDATE on the promotion would serialise
  -- every entry in it against every other — tolerable for an operator typing
  -- one at a time and ruinous once Block 5's bot is receiving messages. Locking
  -- the participation rows for this pair locks nothing at all the first time
  -- somebody enters, which is precisely the case the rule governs; Block 4b hit
  -- the identical problem when archive_prize needed to lock a balance row that
  -- did not exist yet.
  --
  -- The cost, stated: the pair is hashed into a bigint, so two different pairs
  -- can collide and serialise against each other for no reason. That makes a
  -- collision slow, never wrong.
  perform pg_advisory_xact_lock(
    hashtextextended(p_promotion_id::text || ':' || p_member_id::text, 0));

  if not v_multiple and exists (
    select 1 from public.participations
    where promotion_id = p_promotion_id and member_id = p_member_id
      and status = 'VALID'
  ) then
    v_status := 'DUPLICATE';
  elsif v_min_hours is not null and exists (
    select 1 from public.participations
    where promotion_id = p_promotion_id and member_id = p_member_id
      and status = 'VALID'
      and participated_at > v_when - make_interval(hours => v_min_hours)
  ) then
    v_status := 'TOO_SOON';
  elsif v_ceiling is not null and (
    select count(*) from public.participations
    where promotion_id = p_promotion_id and member_id = p_member_id
      and status = 'VALID'
  ) >= v_ceiling then
    v_status := 'OVER_LIMIT';
  else
    v_status := 'VALID';
  end if;

  insert into public.participations
    (promotion_id, member_id, organization_id, company_id, allows_multiple,
     status, source, participated_at, created_by)
  values
    (p_promotion_id, p_member_id, v_org, v_company, v_multiple,
     v_status, p_source, v_when, v_actor)
  returning id into v_id;

  -- The answers are stored whatever the status. What somebody said is a fact
  -- about the attempt; whether it counted is a different fact, and the status
  -- already carries that one. Block 5 will want the answer of a duplicate
  -- message for the same reason.
  for v_answer in select * from jsonb_array_elements(coalesce(p_answers, '[]'))
  loop
    insert into public.participation_answers
      (participation_id, promotion_id, question_id, kind, option_id, answer_text,
       organization_id, company_id)
    select v_id, p_promotion_id, q.id, q.kind,
           nullif(v_answer ->> 'option_id', '')::uuid,
           nullif(btrim(coalesce(v_answer ->> 'answer_text', '')), ''),
           v_org, v_company
    from public.promotion_questions q
    where q.id = (v_answer ->> 'question_id')::uuid;

    if not found then
      raise exception 'question not found in this promotion: %', v_answer ->> 'question_id'
        using errcode = 'P0002';
    end if;
  end loop;

  insert into public.audit_logs
    (actor_id, action, target_table, target_id, organization_id, company_id, detail)
  values
    (v_actor, 'record_participation', 'participations', v_id, v_org, v_company,
     jsonb_build_object('promotion_id', p_promotion_id, 'member_id', p_member_id,
                        'status', v_status, 'source', p_source));

  return jsonb_build_object('participation_id', v_id, 'status', v_status);
end;
$$;

revoke execute on function public.record_participation(uuid, uuid, timestamptz, public.participation_source, jsonb) from public;
grant execute on function public.record_participation(uuid, uuid, timestamptz, public.participation_source, jsonb) to authenticated;

comment on function public.record_participation(uuid, uuid, timestamptz, public.participation_source, jsonb) is
  'Records one attempt and returns what happened to it. Gated on participations.create. Repeating, coming in early and passing the ceiling are NOT refusals — they are written down with the status that says so, because Block 5 will have no choice about recording what happened to a message it received. A cancelled promotion, one outside its window, a listener this Station is not linked to and an answer naming a question from another promotion ARE refusals, because none of them is a fact about how often this person entered. The rules are applied under pg_advisory_xact_lock over (promotion, member); the partial unique index on participations (0052) holds the same floor whether or not this function took it, which is what makes the concurrency test meaningful rather than circular.';
```

- [ ] **Step 5: Run the suite green**

Run: `npm run db:reset && npm run test:isolation -- tests/isolation/participations.test.ts`

Expected: every case passes. Two failure signatures worth recognising: if `lets exactly one of two simultaneous entries be VALID` fails with one call erroring on `23505`, the lock is not being taken and the index caught the loser instead — which is the mutation's expected result, not the fix's. If `records OVER_LIMIT once the ceiling is reached` reports `TOO_SOON`, the fixture's spacing is inside the interval.

- [ ] **Step 6: Run the wider gates, then commit the tests and the harness change**

Run: `npm run lint && npm run typecheck && npm run db:test && npm run test:isolation`

**Hold `0054` back from this commit** — Task 4 appends to it, and a migration committed half-written is a migration somebody can apply half-written.

```bash
git add tests/isolation/participations.test.ts scripts/verify-isolation-suite.mjs
git commit -m "$(cat <<'EOF'
test(participations): the eight cases record_participation has to satisfy

The concurrency case asserts the two statuses rather than a row count, and the
difference matters: the partial unique index would also leave "one row" by
raising 23505 on the loser. The whole point of the lock is that the loser is
recorded as a duplicate instead of lost, and only the status tells those two
outcomes apart.

The new file is added to the isolation guard's manifest in the same commit,
because the guard fails closed on a file that does not report and a failing gate
on an unrelated cause is exactly the noise that hides a real one.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Importing a file

**Files:**
- Modify: `supabase/migrations/0054_participation_rpcs.sql` (append the third function, then commit the whole file)
- Modify: `tests/isolation/participations.test.ts` (a new `describe`)

**Interfaces:**
- Consumes: `public.resolve_or_create_member(...) returns jsonb` and the rule logic from Task 3.
- Produces: `public.import_participations(p_promotion_id uuid, p_rows jsonb) returns jsonb` — `{recorded, duplicate, too_soon, over_limit, skipped, members_created, rows: [{line, outcome, status?, reason?}]}`. `outcome` is one of `recorded`, `skipped`.

**The CPF never arrives raw.** `0031`'s comment is explicit: the hash is computed in Node before it reaches the database, because an argument passed to an RPC lands in query logs and in backups. The import's TypeScript hashes it and sends `cpf_hash` plus `cpf_last_digits`; this function never sees a CPF.

- [ ] **Step 1: Write the failing cases**

Append to `tests/isolation/participations.test.ts`:

```ts
describe('importing a file', () => {
  it('records the good rows, marks the repeats, and skips the unusable ones', async () => {
    const label = `imp-mixed-${Date.now()}`;
    const customer = await provisionCustomer(label);
    const promotionId = await promotionAsOwner(customer);

    const delegate = await grantRoleWith(customer, label, [
      'promotions.view',
      'participations.view',
      'participations.import',
      'members.view',
      'members.create',
    ]);
    const client = await clientFor(delegate);

    const when = new Date(Date.now() - HOUR).toISOString();
    const result = await client.rpc('import_participations', {
      p_promotion_id: promotionId,
      p_rows: [
        { line: 2, full_name: 'Ana Lima', phone: '11970000001', participated_at: when },
        { line: 3, full_name: 'Bruno Reis', phone: '11970000002', participated_at: when },
        // The same person again: recorded, and marked as the repeat it is.
        { line: 4, full_name: 'Ana Lima', phone: '11970000001', participated_at: when },
        // Nothing to identify her by.
        { line: 5, full_name: 'Carla Souza', participated_at: when },
      ],
    });

    expect(result.error).toBeNull();
    expect(result.data).toMatchObject({
      recorded: 3,
      duplicate: 1,
      skipped: 1,
      members_created: 2,
    });

    const rows = (result.data as { rows: Array<Record<string, unknown>> }).rows;
    expect(rows.find((r) => r.line === 5)).toMatchObject({
      outcome: 'skipped',
      reason: 'no identifier',
    });
    expect(rows.find((r) => r.line === 4)).toMatchObject({
      outcome: 'recorded',
      status: 'DUPLICATE',
    });

    // Two listeners for three recorded rows: the repeat reused the first one.
    const members = await client.from('participations').select('member_id').eq('promotion_id', promotionId);
    expect(new Set(members.data!.map((m) => m.member_id)).size).toBe(2);
  });

  it('honours the timestamp in the file rather than the clock', async () => {
    const label = `imp-when-${Date.now()}`;
    const customer = await provisionCustomer(label);
    const promotionId = await promotionAsOwner(customer, {
      p_allow_multiple_entries: true,
      p_min_hours_between_entries: 6,
    });

    const delegate = await grantRoleWith(customer, label, [
      'promotions.view',
      'participations.view',
      'participations.import',
      'members.view',
      'members.create',
    ]);
    const client = await clientFor(delegate);

    const base = Date.now();
    const result = await client.rpc('import_participations', {
      p_promotion_id: promotionId,
      p_rows: [
        { line: 2, full_name: 'Dora Melo', phone: '11970000003', participated_at: new Date(base - 30 * HOUR).toISOString() },
        { line: 3, full_name: 'Dora Melo', phone: '11970000003', participated_at: new Date(base - 20 * HOUR).toISOString() },
      ],
    });

    // Ten hours apart in the file, against a six-hour interval: both count.
    // Stamped "now" on both, the second would have been TOO_SOON — which is the
    // whole reason the column exists and the file carries it.
    expect(result.data).toMatchObject({ recorded: 2, too_soon: 0 });
  });

  it('skips a row whose identifier belongs to a listener this caller cannot reach', async () => {
    const label = `imp-elsewhere-${Date.now()}`;
    const customer = await provisionCustomer(label);
    const otherCompanyId = await addCompany(customer, `Second ${label}`);
    // Registered in the other Station, so a delegate scoped to the first cannot
    // reach them — and 0031's unique index on the phone means they cannot be
    // registered a second time either.
    await createMemberAs(customer, otherCompanyId, {
      fullName: 'Fora do Alcance',
      phone: '11970000009',
    });
    const promotionId = await promotionAsOwner(customer);

    const delegate = await grantRoleWith(customer, label, [
      'promotions.view',
      'participations.view',
      'participations.import',
      'members.view',
      'members.create',
    ]);
    const client = await clientFor(delegate);

    const result = await client.rpc('import_participations', {
      p_promotion_id: promotionId,
      p_rows: [
        { line: 2, full_name: 'Fora do Alcance', phone: '11970000009', participated_at: new Date().toISOString() },
      ],
    });

    expect(result.data).toMatchObject({ recorded: 0, skipped: 1 });
    const rows = (result.data as { rows: Array<Record<string, unknown>> }).rows;
    expect(rows[0]).toMatchObject({ outcome: 'skipped', reason: 'listener is out of reach' });
  });

  it('refuses a delegate holding participations.import but not members.create', async () => {
    const label = `imp-perm-${Date.now()}`;
    const customer = await provisionCustomer(label);
    const promotionId = await promotionAsOwner(customer);

    // Import registers listeners. Without members.create this would be a side
    // door that registers people for somebody who may not register one.
    const delegate = await grantRoleWith(customer, label, [
      'promotions.view',
      'participations.view',
      'participations.import',
      'members.view',
    ]);
    const client = await clientFor(delegate);

    const denied = await client.rpc('import_participations', {
      p_promotion_id: promotionId,
      p_rows: [
        { line: 2, full_name: 'Nova Pessoa', phone: '11970000004', participated_at: new Date().toISOString() },
      ],
    });
    expect(denied.error?.code).toBe('42501');
  });
});
```

- [ ] **Step 2: Run and confirm `PGRST202` on the four new cases**

Run: `npm run db:reset && npm run test:isolation -- tests/isolation/participations.test.ts`

- [ ] **Step 3: Append the function to `0054`**

```sql
-- ---------------------------------------------------------------------------
-- One call per file. Per row: resolve the listener, then do what
-- record_participation does. It repeats that function's rule block rather than
-- calling it, and the reason is the lock: calling it per row would take and
-- release an advisory lock four hundred times inside one transaction, and the
-- rules for row 300 would be evaluated against a promotion another transaction
-- could have changed since row 1. One lock per pair, held for the whole file,
-- is both faster and the only version that is coherent.
--
-- The CPF never arrives here raw — 0031's comment is explicit that the hash is
-- computed in Node, because an argument passed to an RPC lands in query logs
-- and in backups. This function takes cpf_hash and cpf_last_digits.
-- ---------------------------------------------------------------------------
create or replace function public.import_participations(
  p_promotion_id uuid,
  p_rows         jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor     uuid := auth.uid();
  v_company   uuid;
  v_row       jsonb;
  v_resolved  jsonb;
  v_member    uuid;
  v_outcome   jsonb;
  v_result    jsonb := '[]';
  v_recorded  integer := 0;
  v_duplicate integer := 0;
  v_too_soon  integer := 0;
  v_over      integer := 0;
  v_skipped   integer := 0;
  v_created   integer := 0;
begin
  select company_id into v_company
  from public.promotions
  where id = p_promotion_id and deleted_at is null;

  if not found then
    raise exception 'promotion not found: %', p_promotion_id using errcode = 'P0002';
  end if;

  if not public.has_permission('participations.import', v_company) then
    raise log 'import_participations denied: actor=% promotion=%', v_actor, p_promotion_id;
    raise exception 'permission denied: participations.import required' using errcode = '42501';
  end if;

  -- D10. Import registers listeners, so it needs the right to register one.
  -- Checked here rather than left to create_member's own gate so the file is
  -- refused before a single row is written, instead of halfway through.
  if not public.has_permission('members.create', v_company) then
    raise log 'import_participations denied (members.create): actor=% promotion=%', v_actor, p_promotion_id;
    raise exception 'permission denied: members.create required to import participations'
      using errcode = '42501';
  end if;

  for v_row in select * from jsonb_array_elements(coalesce(p_rows, '[]'))
  loop
    if coalesce(btrim(v_row ->> 'phone'), '') = ''
       and coalesce(btrim(v_row ->> 'cpf_hash'), '') = '' then
      v_skipped := v_skipped + 1;
      v_result := v_result || jsonb_build_object(
        'line', (v_row ->> 'line')::integer, 'outcome', 'skipped',
        'reason', 'no identifier');
      continue;
    end if;

    v_resolved := public.resolve_or_create_member(
      v_company,
      v_row ->> 'full_name',
      nullif(btrim(coalesce(v_row ->> 'phone', '')), ''),
      null,
      nullif(btrim(coalesce(v_row ->> 'cpf_hash', '')), ''),
      nullif(btrim(coalesce(v_row ->> 'cpf_last_digits', '')), ''),
      null);

    if v_resolved ->> 'outcome' = 'elsewhere' then
      v_skipped := v_skipped + 1;
      v_result := v_result || jsonb_build_object(
        'line', (v_row ->> 'line')::integer, 'outcome', 'skipped',
        'reason', 'listener is out of reach');
      continue;
    end if;

    if v_resolved ->> 'outcome' = 'created' then
      v_created := v_created + 1;
    end if;

    v_member := (v_resolved ->> 'member_id')::uuid;

    v_outcome := public.record_participation(
      p_promotion_id, v_member,
      (v_row ->> 'participated_at')::timestamptz,
      'IMPORT', '[]');

    v_recorded := v_recorded + 1;
    case v_outcome ->> 'status'
      when 'DUPLICATE'  then v_duplicate := v_duplicate + 1;
      when 'TOO_SOON'   then v_too_soon  := v_too_soon  + 1;
      when 'OVER_LIMIT' then v_over      := v_over      + 1;
      else null;
    end case;

    v_result := v_result || jsonb_build_object(
      'line', (v_row ->> 'line')::integer, 'outcome', 'recorded',
      'status', v_outcome ->> 'status');
  end loop;

  return jsonb_build_object(
    'recorded', v_recorded, 'duplicate', v_duplicate, 'too_soon', v_too_soon,
    'over_limit', v_over, 'skipped', v_skipped, 'members_created', v_created,
    'rows', v_result);
end;
$$;

revoke execute on function public.import_participations(uuid, jsonb) from public;
grant execute on function public.import_participations(uuid, jsonb) to authenticated;

comment on function public.import_participations(uuid, jsonb) is
  'One call per file. Gated on participations.import AND members.create — import registers listeners, and without the second this would be a side door that registers six hundred people for somebody who may not register one; both are checked before the first row is written rather than halfway through. Returns per-row outcomes with the line number from the file, so the screen can name what it skipped. A row with no phone and no CPF is skipped; so is one whose identifier matches a listener this caller cannot reach, because find_member_by_identifier deliberately returns no id for that case and 0031''s unique indexes would refuse the duplicate anyway. Repeats are not skipped — they are recorded with the status that says so. The CPF is hashed in Node before it reaches here (0031).';
```

Note: the row loop calls `record_participation`, which takes its own advisory lock per pair — the comment above the function says the block is repeated rather than delegated, and it is not. **Reconcile this before writing:** delegating is correct and simpler, and the lock-per-row concern is real but smaller than the duplication it would buy. Keep the delegation, and rewrite that comment to say what the code does: one lock per pair per row, held only as long as that row's own work, which is what lets a long file not hold one lock for its whole duration.

- [ ] **Step 4: Run green, then commit the whole migration**

Run: `npm run db:reset && npm run test:isolation -- tests/isolation/participations.test.ts && npm run db:test`

```bash
git add supabase/migrations/0054_participation_rpcs.sql tests/isolation/participations.test.ts
git commit -m "$(cat <<'EOF'
feat(participations): recording one, and importing a file of them

Repeating, coming in early and passing the ceiling are not refusals — they are
recorded with the status that says what happened, because Block 5 will have no
choice about recording what became of a message it received, and building it now
means that block adds a source rather than a column and a second write path.

The rules run under an advisory lock over the pair. A row lock on the promotion
would serialise every entry in it, which is ruinous once the bot arrives;
locking the participation rows locks nothing the first time somebody enters,
which is exactly the case the rule governs.

Import needs members.create as well as its own code, checked before the first
row rather than halfway through. A row whose identifier belongs to a listener
the caller cannot reach is skipped: the lookup returns no id on purpose, and
registering anyway is impossible because the unique indexes would refuse it.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Block 4a's D9 comes due

**Files:**
- Create: `supabase/migrations/0055_promotion_freeze.sql`
- Modify: `tests/isolation/participations.test.ts` (a new `describe`)
- Modify: `supabase/tests/02_permissions.test.sql` (grant grid for this block's four functions)

**Interfaces:**
- Consumes: `public.participations` (`0052`).
- Produces: `public.update_promotion(...)` recreated with the freeze and with `p_max_entries_per_member`; `public.remove_promotion_question(uuid)` recreated with its refusal.

**Read `0042:132-231` and `0043:139-182` before writing.** Both functions are recreated in place with `create or replace`, so there is no drop-and-recreate hazard — but `update_promotion`'s argument list **does** change, because D1 adds `p_max_entries_per_member`. That is Block 4b's trap exactly: `create or replace` cannot change an argument list, and doing it that way leaves the old overload alive beside the new one. **`update_promotion` must be dropped and recreated**, and `02_permissions.test.sql` must count `pg_proc` entries by name for it — the signature pin alone proves nothing about a surviving twin, which Block 4b discovered by mutation after asserting the opposite in five places for seven tasks.

**One case moves here from Task 3.** `records OVER_LIMIT once the ceiling is reached` sets the ceiling through `update_promotion(p_max_entries_per_member: 2)` — an argument that RPC does not have until this task. In Task 3 it failed with `PGRST202`, the ceiling stayed null, and the third entry was correctly `VALID`. Task 3 removed it rather than leaving the suite red or skipping it (the isolation guard fails closed on skipped tests). **Add it back here, with the ceiling set through the seventeen-argument signature this task creates, and assert it goes green.** Its fixture must space the three entries more than the minimum interval apart, or it reports `TOO_SOON` and tests the wrong rule:

```ts
  it('records OVER_LIMIT once the ceiling is reached', async () => {
    // Two hours between each entry against a one-hour interval, so the third is
    // refused for the ceiling and not for coming in too early.
    // Ceiling of 2, three entries: VALID, VALID, OVER_LIMIT.
  });
```

- [ ] **Step 1: Write the failing cases**

```ts
describe("Block 4a's freeze, now that there is something to freeze", () => {
  it('locks the hashtag and the start date once somebody has entered, and leaves the rest open', async () => {
    const label = `freeze-${Date.now()}`;
    const customer = await provisionCustomer(label);
    const memberId = await createMemberAs(customer, customer.companyId, {
      fullName: 'Ouvinte Nove',
      phone: '11970000005',
    });
    const promotionId = await promotionAsOwner(customer, {
      p_whatsapp_enabled: true,
      p_hashtag: '#EUQUERO',
    });

    const delegate = await grantRoleWith(customer, label, [
      'promotions.view',
      'promotions.edit',
      'participations.view',
      'participations.create',
    ]);
    const client = await clientFor(delegate);

    const starts = new Date(Date.now() - 2 * DAY).toISOString();
    const ends = new Date(Date.now() + 20 * DAY).toISOString();
    const base = {
      p_promotion_id: promotionId,
      p_starts_at: starts,
      p_ends_at: ends,
      p_whatsapp_enabled: true,
      p_hashtag: '#EUQUERO',
    };

    // Before anybody enters, the hashtag moves freely.
    const beforeAnyone = await client.rpc('update_promotion', {
      ...base,
      p_name: 'Ainda editável',
      p_hashtag: '#OUTRO',
    });
    expect(beforeAnyone.error).toBeNull();

    await client.rpc('record_participation', {
      p_promotion_id: promotionId,
      p_member_id: memberId,
      p_participated_at: new Date().toISOString(),
      p_source: 'MANUAL',
      p_answers: [],
    });

    const hashtagNow = await client.rpc('update_promotion', {
      ...base,
      p_name: 'Ainda editável',
      p_hashtag: '#MUDOU',
    });
    expect(hashtagNow.error?.code).toBe('22023');

    const startNow = await client.rpc('update_promotion', {
      ...base,
      p_name: 'Ainda editável',
      p_hashtag: '#OUTRO',
      p_starts_at: new Date(Date.now() - 3 * DAY).toISOString(),
    });
    expect(startNow.error?.code).toBe('22023');

    // What stays open: the name, the end date, the call to action, the art and
    // the button labels. Listeners are already texting the hashtag; nobody is
    // reading the name.
    const stillOpen = await client.rpc('update_promotion', {
      ...base,
      p_name: 'Nome novo',
      p_hashtag: '#OUTRO',
      p_ends_at: new Date(Date.now() + 40 * DAY).toISOString(),
      p_call_to_action: 'Manda #OUTRO agora',
    });
    expect(stillOpen.error).toBeNull();
  });

  it('refuses to remove a question once somebody has entered', async () => {
    const label = `freeze-q-${Date.now()}`;
    const customer = await provisionCustomer(label);
    const memberId = await createMemberAs(customer, customer.companyId, {
      fullName: 'Ouvinte Dez',
      phone: '11970000006',
    });
    const promotionId = await promotionAsOwner(customer);

    const delegate = await grantRoleWith(customer, label, [
      'promotions.view',
      'promotions.edit',
      'participations.view',
      'participations.create',
    ]);
    const client = await clientFor(delegate);

    const { data: questionId } = await client.rpc('save_promotion_question', {
      p_promotion_id: promotionId,
      p_kind: 'ESSAY',
      p_prompt: 'Por que você ouve?',
      p_options: [],
    });

    // Removable while nothing points at it — which is what 0041's table comment
    // says is the only time it is ever removable.
    const before = await client.rpc('remove_promotion_question', {
      p_question_id: questionId as string,
    });
    expect(before.error).toBeNull();

    const { data: second } = await client.rpc('save_promotion_question', {
      p_promotion_id: promotionId,
      p_kind: 'ESSAY',
      p_prompt: 'E agora?',
      p_options: [],
    });
    await client.rpc('record_participation', {
      p_promotion_id: promotionId,
      p_member_id: memberId,
      p_participated_at: new Date().toISOString(),
      p_source: 'MANUAL',
      p_answers: [],
    });

    const after = await client.rpc('remove_promotion_question', {
      p_question_id: second as string,
    });
    expect(after.error?.code).toBe('22023');
  });
});
```

- [ ] **Step 2: Confirm they fail — the freeze does not exist yet**

Run: `npm run db:reset && npm run test:isolation -- tests/isolation/participations.test.ts`

Expected: both new cases fail because the edits succeed. `p_max_entries_per_member` is also an unknown argument until Step 3, so the ceiling case from Task 3 may report `PGRST202`; that is the same missing signature and is fixed by the same step.

- [ ] **Step 3: Write `0055`**

Take `update_promotion`'s body from `0042:154-228` verbatim and `remove_promotion_question`'s from `0043:139-178` verbatim, and make exactly these changes:

- `update_promotion` is **dropped** on its sixteen-argument signature and created with seventeen, `p_max_entries_per_member integer default null` last. Its `UPDATE` sets the new column. Its `revoke`/`grant` and `comment on function` all spell out seventeen argument types.
- Both gain, immediately after their permission check:

```sql
  -- Block 4a's D9, finally able to fire. 0042 carried a comment saying this
  -- guard was deliberately absent because it would have had to consult a table
  -- that did not exist, and a guard that can never fire is a defect this
  -- project has shipped five times. The table exists now.
  if exists (select 1 from public.participations where promotion_id = <the id>) then
    -- ...the specific refusal, see below
  end if;
```

For `update_promotion`, the refusal is conditional on what changed, so it reads the current row first and compares:

```sql
  if v_frozen then
    if v_hashtag is distinct from v_current_hashtag then
      raise exception 'somebody has already entered this promotion; the hashtag can no longer change'
        using errcode = '22023';
    end if;
    if p_starts_at is distinct from v_current_starts then
      raise exception 'somebody has already entered this promotion; the start date can no longer change'
        using errcode = '22023';
    end if;
  end if;
```

For `remove_promotion_question`, it is unconditional:

```sql
  if exists (select 1 from public.participations where promotion_id = v_promotion) then
    raise exception 'somebody has already entered this promotion; its questions can no longer be removed'
      using errcode = '22023';
  end if;
```

Update both `comment on function` texts: `0042:231` currently says the freeze "is not here, because a guard against a table that does not exist yet is a guard that can never fire", and `0043:182` says removal is only permitted "while nothing points at the question (Block 4c enforces that)". Both sentences are now false in the same direction — say that 4c enforces it, here, and name this migration.

- [ ] **Step 4: Pin the grant grid for everything this block added**

In `supabase/tests/02_permissions.test.sql`, add — and recount the plan, reporting the arithmetic:

- an anon/authenticated `has_function_privilege` pair for `resolve_or_create_member`, `record_participation`, `import_participations`;
- an overload count for `update_promotion`, in the `count(*)::int from pg_proc join pg_namespace where nspname = 'public' and proname = ...` shape the file already uses, asserting 1.

The overload count is not optional and not belt-and-braces: `::regprocedure` resolves the signature it is handed and succeeds regardless of what else shares the name, which is how Block 4b passed 331 of 331 with two `apply_inventory_movement` overloads live while claiming the pin caught exactly that.

- [ ] **Step 5: Run every gate green, then commit**

Run: `npm run db:reset && npm run db:test && npm run test:isolation && npm run lint && npm run typecheck`

`tests/isolation/promotions.test.ts` is the one to watch: it drives `update_promotion` through the service layer, and the signature changed under it.

```bash
git add supabase/migrations/0055_promotion_freeze.sql supabase/tests/02_permissions.test.sql tests/isolation/participations.test.ts
git commit -m "$(cat <<'EOF'
feat(promotions): the freeze Block 4a promised, now that there is a table to check

0042 and 0043 both carry comments saying the guard was deliberately absent
because it would have had to consult participations, and that a guard against a
table that does not exist is one that can never fire. Both comments are now
false in the same direction, and both are corrected here rather than left to
contradict the code beside them.

update_promotion is dropped and recreated, not replaced: p_max_entries_per_member
changes its argument list, and create or replace cannot do that — it would leave
the sixteen-argument overload alive beside the new one. 02_permissions.test.sql
counts pg_proc entries by name, because the signature pin succeeds regardless of
what else shares it, which Block 4b learned by mutation after asserting the
opposite for seven tasks.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: The server layer

**Files:**
- Create: `src/lib/participation-status.ts`, `src/schemas/participations.ts`, `src/services/participations.ts`
- Modify: `src/lib/supabase/database.types.ts` (regenerated)
- Create: `tests/unit/participations-schema.test.ts`

**Interfaces:**
- Produces: `PARTICIPATION_STATUSES`, `STATUS_LABELS`, `STATUS_CLASSES` in `@/lib/participation-status`; `participationFormSchema` and `importRowSchema` in `@/schemas/participations`; `listParticipationsPage`, `recordParticipation`, `importParticipations`, `resolveOrCreateMember`, `PARTICIPATION_PAGE_SIZE` in `@/services/participations`.

**The status vocabulary lives in `@/lib`, not in the service.** `src/services/participations.ts` is `server-only`, and the grid is a client component. Block 4b hit a build error importing a value across that line and had to move it mid-task; `@/lib/promotion-situation.ts` is the precedent.

- [ ] **Step 1** — regenerate types: `npm run db:reset && npm run db:types`. Confirm the four new functions and two new tables are present before going on.
- [ ] **Step 2** — write `tests/unit/participations-schema.test.ts` first, covering: a form with neither phone nor CPF is refused with a message naming both; a CSV row with an unparseable `participou_em` is refused; a row whose CPF is not eleven digits is refused; and the happy path. Assert on `issues[0].message`, not just on `success === false` — Block 4b shipped a schema test that pinned only the boolean and had to come back for the message.
- [ ] **Step 3** — write the two schemas and the status module, then the service. Model `listParticipationsPage` on `listPromotionsPage` in `src/services/promotions.ts`: the same keyset shape, `.limit(PAGE_SIZE + 1)`, `keysetPage` from `@/lib/keyset`, ordering by `participated_at desc, id desc` to match `participations_listing_idx`. Map errors through a `mapParticipationError` in the shape of `mapPromotionError`, covering `22023`, `P0002`, `42501` and `23505`.
- [ ] **Step 4** — `npm run lint && npm run typecheck && npm test`, then commit.

### Also in this task: the ceiling reaches the promotion form

**A gap this plan shipped and Task 5 found.** Decision D1 says a promotion may cap entries per person, and the spec calls for "a new field on the Promotion tab". Task 5 added `p_max_entries_per_member` to `update_promotion` — but nothing in `src/services/promotions.ts` sends it, `PromotionFormInput` has no such field, and `update_promotion` replaces every field on every call. So **every edit of a promotion through the screen nulls whatever ceiling it had**. Nothing can set one through the UI today, so no data is lost yet; the moment Task 8 puts the field on the form, it would be.

Close it here, in the promotions layer rather than the participations one:

- `src/schemas/promotions.ts` — `promotionFormSchema` gains `maxEntriesPerMember`, an optional positive integer of at least 2, refused unless `allowMultipleEntries` is true. That mirrors `promotions_entry_ceiling_shape` in `0052`, and the two must agree: a ceiling of one is what "no repeats" already says.
- `src/services/promotions.ts` — `promotionRpcArgs` sends `p_max_entries_per_member: input.maxEntriesPerMember`, and `PromotionDetail` carries it back so the form can render what is stored.
- `tests/unit/promotions-schema.test.ts` — a case for the ceiling accepted with repeats on, one for it refused with repeats off, and one for a ceiling of 1 refused. Assert on `issues[0].message`, not on `success` alone.

Task 8 puts the input on the Promotion tab beside the repeat interval.

---

## Task 7: The `/participations` screen

**Files:** `src/app/(app)/participations/{page.tsx,actions.ts,access.ts,errors.ts,list-params.ts,participations-grid.tsx,participations-filters.tsx}`

Build it on `src/app/(app)/promotions/` as the template — the same `listCompanyAccess` Station picker, the same `parsePromotionListState` shape for filters, the same grid/filters split, the same `access.ts` courtesy gate that throws rather than folding a failed permission check into "not granted".

Filters: promotion, status, source, date range, and a listener search. **The default status filter is `VALID`**, and the filter control is visible with the others so nobody concludes the refused ones were lost.

- [ ] Steps: page + access + list-params; then grid + filters; then `npm run lint && npm run typecheck && npm test && npm run test:e2e -- tests/e2e/record-dialog.spec.ts` (that spec exercises the shared record-dialog machinery this screen reuses); commit.

---

## Task 8: The manual form, the import, and the promotion's fifth tab

**Files:** `src/app/(app)/participations/{record-participation-form.tsx,import-form.tsx}`, `src/app/(app)/promotions/participations-tab.tsx`, `src/app/(app)/promotions/promotion-record-dialog.tsx`

- The fifth tab is **fixed cost**: a count of valid against refused, the two buttons, and a link into `/participations` filtered to this promotion. It must not list participations — the record is read once per opening and a promotion with eight thousand entries cannot be.
- `PROMOTION_TABS` gains `'participations'`. It is validated against by `parseRecordParam`, and the tuple now lives in `src/lib/record-params.ts` — **not** in the dialog module, which is a `'use client'` file. Adding it back to the dialog would reintroduce the defect commit `caef39d` fixed across six screens.
- The footer's Save button already hides on tabs that are not part of the shared form; confirm the condition covers the new tab as it does `quiz` and `prizes`.
- **`/participations` needs a navigation entry.** Task 7 built the screen and left it reachable only by typing the URL, correctly flagging rather than adding it because `src/lib/auth/shell.ts` was outside its file list. Add it here, in the shape the existing entries use — and read the comment above the Inventory entry first: it explains why a link is shown to every member rather than gated on a permission, and the same reasoning applies, because `/participations` redirects at the top of its own page for anyone holding `participations.view` nowhere and every RPC re-checks besides.
- **The per-person ceiling gets its input on the Promotion tab**, beside the repeat interval it depends on, in `src/app/(app)/promotions/promotion-fields.tsx`. Task 6 added the schema and the service field; this is where an operator can finally set one. It renders only when "allows repeats" is ticked — the schema and `promotions_entry_ceiling_shape` (`0052`) both refuse it otherwise, and offering a field the database will reject is how a form teaches somebody the wrong thing.
- The import form hashes the CPF in the browser action before calling the RPC (`0031`), parses the CSV with its header row in any order, and renders the per-row result the RPC returns — recorded, refused with which status, skipped with the line number and the reason, and how many listeners were created. It warns before writing when the promotion has `require_correct_answer` set, because imported rows carry no answers and would be outside the draw.

- [ ] Steps: the tab; the manual form; the import form; `npm run lint && npm run typecheck && npm test`; commit.

---

## Task 9: The end-to-end proof

**Files:** `tests/e2e/participations-flow.spec.ts`

Copy the fixture scaffolding from `tests/e2e/promotion-prizes.spec.ts` — the admin client, `createdUserIds`, `beforeAll`/`afterAll`, and `countListRenders` **with its whole warning comment**, which says the counter cannot see a `revalidatePath` because Next returns the re-rendered tree inside the action's own POST response.

The spec proves: recording a participation from the promotion's fifth tab updates the count without the promotions list behind the dialog being re-queried; and `/participations` lists it.

**The compensating assertion has to be invented, not copied.** `promotion-prizes.spec.ts` registers a second promotion out of band after the list is on screen, because neither of its writes changes anything the list displays. Here the count on the tab *does* change, so a different compensating assertion may be available — work out what a re-rendered list would reveal that the browser could not know, and say in your report what you chose and why. Copying the counter without copying the reason it is insufficient is the worst outcome.

- [ ] Steps: the spec; `npm run test:e2e -- tests/e2e/participations-flow.spec.ts`; then the full `npm run test:e2e` with `rate_limit_counters` cleared and `--workers=1`; commit.

---

## Task 10: Mutation, and the block report

**Files:** `docs/block-4c-report.md`, and transient edits reverted with `git checkout --`

- [ ] **Mutation 1 — remove the advisory lock** from `record_participation`. `lets exactly one of two simultaneous entries be VALID` must go red. **Watch how it goes red**: if one call now errors with `23505` instead of returning `DUPLICATE`, that is the partial unique index catching the loser, and it is the correct red — record it, because it is the evidence that the index and the lock guard the same floor by different means.
- [ ] **Mutation 2 — remove the participation check** from `update_promotion`. The freeze case must go red on the hashtag edit.
- [ ] **Mutation 3 — drop `status = 'VALID'` from the partial unique index predicate.** The pgTAP case `a DUPLICATE may sit beside the VALID one it was refused for` must go red while its neighbour stays green.
- [ ] **Mutation 4 — one of your own choosing**, against something this block claims and nothing yet proves. Say why you chose it. Block 4b's self-chosen mutation is the one that found the block's headline claim was false in five places.
- [ ] Revert each with `git checkout --` before the next, and prove the tree is clean.
- [ ] Write `docs/block-4c-report.md` covering: what shipped; the correction to how `require_correct_answer` was being read, and that it had been wrong since 4a; the spec's own withdrawn open item and why Block 3 had already settled it; the mutation log with what went red and what survived; what Block 5 and Block 6 inherit, with file and line; and the deferred minors from the execution ledger, grouped.
- [ ] Run every gate, commit, and **stop before opening the pull request** — a whole-branch review runs first, and the owner opens it.

---

## Self-Review

**Spec coverage.** §2 D1 → Task 1 (`max_entries_per_member`) and Task 5 (`p_max_entries_per_member` on the RPC). D2 → the whole design: no status means "wrong answer", stated in `participation_status`'s comment. D3 → Task 1 (`participation_answers`), Task 3 (stored whatever the status). D4 → Task 3 (`resolve_or_create_member`), Task 4 (per row). D5 → Task 1 (the enum and the partial index counting only VALID), Task 3 (the four statuses). D6 → Task 4. D7 → Task 4's timestamp case and Task 8's warning. D8 → Tasks 7 and 8. D9 → Task 3's lock. D10 → Task 4's second permission check. §3.1–3.5 → Task 1. §4 → Task 3. §5's refusal list → Task 3's `refuses a cancelled promotion…` case and the answers loop's `P0002`. §6 → Tasks 7 and 8. §7 → Tasks 3, 4, 5 and 10. §8's exclusions → nothing in this plan builds a bot, a draw, or a delete.

**Placeholder scan.** Tasks 6, 7 and 8 name the file each thing goes in, the existing module each is modelled on, and the specific properties that must hold — but they do not reproduce the component code. That is deliberate and it is the one place this plan is thinner than Block 4b's: the templates are in the repository and reproducing four hundred lines of React that already exist two directories over would be a worse instruction than pointing at them. Every non-obvious decision in those tasks is stated. **If the executing agent finds a place where "model it on X" is ambiguous, that is a plan defect — report it rather than guessing.**

**Type consistency.** `participation_status` and `participation_source` are the enum names in Task 1, in Task 3's function signature, and in Task 6's `@/lib/participation-status`. `record_participation` returns `{participation_id, status}` in Task 3 and is consumed with that shape in Task 4's `v_outcome ->> 'status'`. `resolve_or_create_member` returns `{outcome, member_id?}` with `outcome` in `resolved|created|elsewhere` in Task 3, and Task 4 branches on exactly those three. `import_participations` returns the six counters plus `rows`, and Task 4's tests assert on those names.

**One thing the plan changes about itself, and the executor should notice:** Task 4's first draft of the import comment claims the rule block is repeated rather than delegated, and the code delegates. The task says so and says which to keep. That contradiction is left visible rather than silently fixed, because it is the shape of defect this project has caught in its own plans six times, and a plan that hides its own is not teaching anything.
