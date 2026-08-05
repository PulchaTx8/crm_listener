# Block Templates — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a Station speak in its own words, and let it start a conversation — ending with a listener actually receiving the pickup reminder Block 6d shipped without.

**Architecture:** Two small per-Station tables (a copy-override table and an approved-template registry), one extension of the existing outbound queue, and one sweep. `enqueue_whatsapp_outbound` gains a template purpose and resolves it itself, so the rendered audit text and the sent variables are produced by one function from one source. The reminder sweep is a procedure committing per winner, in the shape of `sweep_pickup_deadlines` (0094).

**Tech Stack:** Postgres 15 / Supabase, plpgsql, pgTAP, Next.js 15 App Router (Server Components + Server Actions), TypeScript strict + `noUncheckedIndexedAccess`, Zod, Vitest, Playwright.

---

## Global Constraints

From the spec (`docs/superpowers/specs/2026-08-04-block-templates-design.md`) and the house rules every block has established. **Every task's requirements implicitly include this section.**

- **Migrations are append-only across merges.** The next free number is `0109`. Within this unmerged branch a migration may be edited in place.
- **Everything user-visible in the operator UI is English.** Code, comments, commit messages, docs. **The ten system texts and every template body are what a LISTENER reads and stay Portuguese** — that is the one exception, and it is the point of the block.
- **This project deletes nothing.** Every removal is `deleted_at = now()`.
- **Permission before existence** — an unknown id and an unauthorised Station answer `42501` alike (0093).
- **A `SECURITY DEFINER` function inherits no RLS.** Every rule the policy would have applied is restated in the body by hand.
- **`revoke execute … from public`** on every function, then grant to the role that needs it — `authenticated` for operator doors, `service_role` for worker doors.
- **`set search_path = pg_catalog, public`** on every function.
- **No write grant to `service_role`** on the two new operator tables, and `revoke truncate` on each.
- **pgTAP runs as superuser with a null `auth.uid()`**, so `has_permission` answers FALSE there. A gated RPC needs the actor fixture — `roles` + `role_permissions` + `auth.users` + `company_memberships`, then `set local role authenticated` with the JWT claims, and `reset role` before any read RLS would hide.
- **Isolation-suite labels carry the file's single `${STAMP}`**, and a new isolation file needs a `REQUIRED_TEST_FILES` entry with a `minTests` floor (`scripts/verify-isolation-suite.mjs`).
- **Regenerate `src/lib/supabase/database.types.ts` in EVERY task that adds or changes an RPC or a table** — not only the first. Block 7b learned this the hard way: Tasks 2–4 added nine RPCs and none regenerated, and nothing surfaced it until the first TypeScript call.
- **A permission-gate change must run `npm run test:isolation`.** It is the only suite that sees permissions; pgTAP, unit, lint, typecheck and build all pass over a broken gate. Block 7b learned this too.
- **Gates:** `npm run lint`, `npm run typecheck`, `npm run build`, `npm test`, `npm run db:test`, plus `npm run test:isolation`. `test:e2e` is not green at default parallelism — a documented environment contention (`docs/block-7b-report.md` §1.1, now confirmed by CI passing) — so run it at `--workers=1` and report both.

---

## Two facts about the existing code this plan is built on

**1. `claim_outbox_batch` is redefined, not replaced.** `0067_outbox_interactive.sql` is the exact precedent: it added a column and re-created the claim function in the same file, with `drop function if exists` first, because *"the returned table gains a column, and Postgres refuses to replace a function whose OUT parameters change"* — and it re-issued the grant, because a dropped function takes its ACL with it and losing that one *"would answer 42501 to every send."* This block writes that function's **third** definition and must repeat both moves.

**2. `enqueue_whatsapp_outbound` must be dropped to gain an argument.** `create or replace` cannot change an argument list — the trap `0047` hit for `apply_inventory_movement` and `0092` for `apply_winner_transition`. Its current signature is `(uuid, text, text, jsonb, text)`, granted to `service_role` only.

---

## File Structure

**Created**

| path | responsibility |
|---|---|
| `supabase/migrations/0109_station_message_templates.sql` | the copy-override table, its key enum, RLS, and the two permissions |
| `supabase/migrations/0110_message_templates.sql` | the approved-template registry and its purpose enum |
| `supabase/migrations/0111_outbox_template.sql` | the outbox columns, `claim_outbox_batch`'s third definition, `enqueue_whatsapp_outbound` recreated with purpose resolution and rendering |
| `supabase/migrations/0112_sweep_pickup_reminders.sql` | the reminder sweep |
| `supabase/tests/18_templates.test.sql` | pgTAP for the two tables and the enqueue |
| `supabase/tests/19_pickup_reminders.test.sql` | pgTAP for the sweep |
| `tests/isolation/templates.test.ts` | the tenant boundary, with real JWTs |
| `src/lib/integrations/whatsapp/template.ts` | `buildTemplatePayload` / `parseTemplate`, mirroring `interactive.ts` |
| `src/services/templates.ts` | the reads and writes both screens use |
| `src/schemas/templates.ts` | the two forms |
| `src/app/(app)/templates/messages/…` | the System Templates screen |
| `src/app/(app)/templates/whatsapp/…` | the registry screen |
| `tests/unit/template-payload.test.ts`, `tests/unit/templates-schema.test.ts`, `tests/unit/system-message-resolution.test.ts` | |
| `tests/e2e/templates.spec.ts` | |
| `docs/block-templates-report.md`, `docs/block-templates-runbook.md` | |

**Modified**

| path | change |
|---|---|
| `src/lib/integrations/whatsapp/transport.ts` | `SendTemplateInput`, `sendTemplate` on the interface |
| `src/lib/integrations/whatsapp/graph.ts`, `fake.ts` | the implementations |
| `src/services/whatsapp.ts` | the third dispatch branch in `drainOutbox` |
| `src/lib/conversation/engine.ts` | the ten constants become defaults a resolver falls back to |
| `src/lib/auth/shell.ts` | the Templates section |
| `src/app/api/worker/tick/route.ts` | call the new sweep |
| `scripts/verify-isolation-suite.mjs` | the manifest entry |

---

## Task 1: The copy-override table, and the two permissions

**Files:** Create `supabase/migrations/0109_station_message_templates.sql`, `supabase/tests/18_templates.test.sql`.

**Interfaces produced:** `public.system_message_key` enum (10 values); `public.station_message_templates`; permission codes `templates.view`, `templates.manage`.

- [ ] **Step 1: Write the failing pgTAP test**

Create `supabase/tests/18_templates.test.sql` with `select plan(10);`. Fixtures use the `…00e4xx` range (14/15 own `e0`/`e1`, 16 owns `e2`, 17 owns `e3`).

```sql
begin;
select plan(10);

insert into public.organizations (id, name) values
  ('00000000-0000-0000-0000-00000000e4f1', 'Org templates');
insert into public.companies (id, organization_id, name, timezone) values
  ('00000000-0000-0000-0000-00000000e4c1', '00000000-0000-0000-0000-00000000e4f1',
   'Station templates', 'America/Sao_Paulo');

-- 1: ten keys, and the order is pinned. Eight are the requested fields
-- FIELD_PROMPTS covers; two are the standalone messages.
select is(
  enum_range(null::public.system_message_key)::text[],
  array['REFUSAL', 'ABANDON', 'FULL_NAME', 'ADDRESS', 'CITY', 'NEIGHBOURHOOD',
        'AGE', 'CPF', 'PASSPORT', 'DISCOVERY_SOURCE'],
  'system_message_key is the ten texts engine.ts hard-codes');

-- 2: a blank override is not an override. '   ' would satisfy NOT NULL and
-- send a listener an empty message, which is worse than the default.
select throws_ok($$
  insert into public.station_message_templates
    (organization_id, company_id, key, body)
  values ('00000000-0000-0000-0000-00000000e4f1', '00000000-0000-0000-0000-00000000e4c1',
          'REFUSAL', '   ')
$$, '23514', null, 'a blank body is refused by the check constraint');

-- 3: one override per key per Station.
insert into public.station_message_templates
  (organization_id, company_id, key, body)
values ('00000000-0000-0000-0000-00000000e4f1', '00000000-0000-0000-0000-00000000e4c1',
        'REFUSAL', 'Beleza! Fica pra próxima.');

select throws_ok($$
  insert into public.station_message_templates
    (organization_id, company_id, key, body)
  values ('00000000-0000-0000-0000-00000000e4f1', '00000000-0000-0000-0000-00000000e4c1',
          'REFUSAL', 'Outro texto')
$$, '23505', null, 'a second live override for the same key is refused');

-- 4: and archiving the first frees the key, because the unique index is
-- partial on deleted_at. Without this an operator who cleared an override
-- could never set another.
update public.station_message_templates set deleted_at = now()
 where company_id = '00000000-0000-0000-0000-00000000e4c1' and key = 'REFUSAL';

select lives_ok($$
  insert into public.station_message_templates
    (organization_id, company_id, key, body)
  values ('00000000-0000-0000-0000-00000000e4f1', '00000000-0000-0000-0000-00000000e4c1',
          'REFUSAL', 'Texto novo')
$$, 'clearing an override frees the key for a new one');

-- 5-6: the two permissions exist, and there is no third.
select is(
  (select count(*)::int from public.permissions where module = 'templates'),
  2, 'templates ships exactly two permission codes');
select is(
  (select array_agg(code order by display_order) from public.permissions where module = 'templates'),
  array['templates.view', 'templates.manage'],
  'the two are view and manage — nothing here destroys the way a merge does');

-- 7-8: RLS. authenticated reads under templates.view and writes nothing
-- directly; the doors are SECURITY DEFINER.
select ok(
  not has_table_privilege('authenticated', 'public.station_message_templates', 'INSERT'),
  'authenticated cannot insert an override directly');
select ok(
  has_table_privilege('authenticated', 'public.station_message_templates', 'SELECT'),
  'authenticated may read overrides, gated by the policy');

-- 9: service_role reads — the conversation engine resolves through it — and
-- cannot truncate. 0059's lesson, applied before anybody finds it again.
select ok(
  has_table_privilege('service_role', 'public.station_message_templates', 'SELECT'),
  'service_role reads overrides, which is how the engine resolves them');
select ok(
  not has_table_privilege('service_role', 'public.station_message_templates', 'TRUNCATE'),
  'service_role cannot truncate the overrides');

select * from finish();
rollback;
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm run db:test`
Expected: FAIL — `type "public.system_message_key" does not exist`.

- [ ] **Step 3: Write the migration**

Create `supabase/migrations/0109_station_message_templates.sql`:

```sql
-- supabase/migrations/0109_station_message_templates.sql

-- The Templates block, Task 1: a Station's own words.
--
-- Every sentence the bot speaks is a constant in
-- src/lib/conversation/engine.ts today — the same Portuguese for every Station
-- of every Organization. A group with five radios has five voices and one
-- script. This is the table that ends that.

-- The ten texts, and only the ten that exist. The legacy screen the owner
-- showed also had "Inatividade", "Aguarde", "Rejeita Áudio" and "Rejeita
-- Ligação"; none of those BEHAVIOURS exists in this system, and a key here
-- for a message nothing sends would be a field that configures nothing (D3).
-- They are named in the block's report with their cost instead.
--
-- Eight of these mirror RequestedField, whose FIELD_PROMPTS record is TOTAL —
-- so a ninth requested field fails to compile there AND has no key here.
-- Both, deliberately: the failure mode a lookup table would produce is a
-- listener receiving an empty message.
create type public.system_message_key as enum (
  'REFUSAL', 'ABANDON',
  'FULL_NAME', 'ADDRESS', 'CITY', 'NEIGHBOURHOOD',
  'AGE', 'CPF', 'PASSPORT', 'DISCOVERY_SOURCE'
);

comment on type public.system_message_key is
  'The ten messages engine.ts hard-codes: the refusal, the abandon, and the eight field prompts. Not a catalogue of everything a bot could say — only what this system already says.';

create table public.station_message_templates (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id),
  company_id      uuid not null,
  key             public.system_message_key not null,
  -- PORTUGUESE, and the one place in this codebase where that is correct:
  -- this is what a LISTENER reads. Every operator-facing string in the block
  -- is English, as everywhere else.
  body            text not null,
  created_by      uuid references auth.users (id),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  deleted_at      timestamptz,
  constraint station_message_templates_company_org_fk
    foreign key (company_id, organization_id)
    references public.companies (id, organization_id),
  -- Blank is not an override. '   ' satisfies NOT NULL and reaches a listener
  -- as an empty message — strictly worse than the default it replaced.
  constraint station_message_templates_body_not_blank check (btrim(body) <> '')
);

comment on table public.station_message_templates is
  'One row per OVERRIDDEN text, never one row per Station (D2). Three consequences, each of them the reason: overriding one field prompt does not freeze the other seven at whatever the code said that day; a new Station speaks before anybody configures it, with no backfill migration and no seed step; and the bot can never go mute, because an absent row is a valid state that resolves to the constant in engine.ts. Required rows would make a missing one a silence a listener experiences and nobody sees.';

-- Partial on deleted_at, so clearing an override frees the key. A total
-- unique index would let an operator clear a text and never set another.
create unique index station_message_templates_key_unique
  on public.station_message_templates (company_id, key)
  where deleted_at is null;

alter table public.station_message_templates enable row level security;
revoke all on public.station_message_templates from anon, authenticated;
grant select on public.station_message_templates to authenticated;

create policy station_message_templates_select_view on public.station_message_templates
  for select to authenticated
  using (deleted_at is null and public.has_permission('templates.view', company_id));

-- service_role READS, and that is not a convenience: the conversation engine
-- runs in the worker under service_role and resolves a Station's wording on
-- every turn. It writes nothing — the operator doors are SECURITY DEFINER and
-- run as the table owner (0099's reasoning, applied to a second module).
grant select on public.station_message_templates to service_role;
revoke truncate on public.station_message_templates from service_role;

-- The two codes. NOT the three-way split Block 7 needed: nothing here
-- destroys the way a merge does. Removing an override falls back to a default
-- the code still holds, and there is no history to lose. Recorded as a
-- decision rather than an omission (spec §5).
insert into public.permissions (code, description, introduced_by_block, module, label, scope, display_order) values
  ('templates.view',   'Read the Station''s message templates',        'Templates', 'templates', 'See the message templates',    'company', 10),
  ('templates.manage', 'Edit the Station''s message templates',        'Templates', 'templates', 'Edit the message templates',   'company', 20);
```

- [ ] **Step 4: Run and watch it pass**

Run: `npm run db:test` — 10 new assertions.

- [ ] **Step 5: Regenerate types and commit**

```bash
npm run db:types && npm run typecheck
git add supabase/migrations/0109_station_message_templates.sql supabase/tests/18_templates.test.sql src/lib/supabase/database.types.ts
git commit -m "feat(templates): a Station's own words, overridden one text at a time"
```

---

## Task 2: The approved-template registry

**Files:** Create `supabase/migrations/0110_message_templates.sql`; modify `supabase/tests/18_templates.test.sql` (raise the plan).

**Interfaces produced:** `public.template_purpose` enum (`PICKUP_REMINDER`); `public.message_templates`.

- [ ] **Step 1: Append the failing assertions**

Raise `plan(10)` to `plan(17)` and append. Assert: the purpose enum has exactly `PICKUP_REMINDER`; a blank `name`/`language`/`body` is refused; **one live row per (company_id, purpose)**, with the partial index freeing it on archive; `authenticated` cannot insert directly; `service_role` reads (the enqueue resolves through it) and cannot truncate.

**One assertion that is not obvious and must be written:** that the table does **not** have a `status` column. Spec §3.2 rules it out deliberately — this system records what the operator was told at registration and cannot know whether Meta still approves it, so a `status` here would look like live truth and be a memory. Assert it against `information_schema.columns`, with the reason in the comment, so a later reader adding one has to argue with the test.

- [ ] **Step 2–4: fail, write, pass**

Create `supabase/migrations/0110_message_templates.sql`. The table, in full — these are the exact names later tasks reference:

```sql
create type public.template_purpose as enum ('PICKUP_REMINDER');

create table public.message_templates (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id),
  company_id      uuid not null,
  purpose         public.template_purpose not null,
  -- The name and language as REGISTERED WITH META. Together they are what the
  -- Cloud API takes; neither is chosen here, both are transcribed from what
  -- Meta approved (D4).
  name            text not null,
  language        text not null,
  -- The approved text, with its {{1}}…{{n}} placeholders. Portuguese, like
  -- every other string a listener reads.
  body            text not null,
  -- Ordered. What each position MEANS, so the screen can label the fields and
  -- a reader can compare against what was submitted. jsonb array of strings.
  variables       jsonb not null default '[]'::jsonb,
  created_by      uuid references auth.users (id),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  deleted_at      timestamptz,
  constraint message_templates_company_org_fk
    foreign key (company_id, organization_id)
    references public.companies (id, organization_id),
  constraint message_templates_name_not_blank     check (btrim(name) <> ''),
  constraint message_templates_language_not_blank check (btrim(language) <> ''),
  constraint message_templates_body_not_blank     check (btrim(body) <> ''),
  constraint message_templates_variables_is_array check (jsonb_typeof(variables) = 'array')
);

create unique index message_templates_purpose_unique
  on public.message_templates (company_id, purpose)
  where deleted_at is null;
```

**Deliberately absent: a `status` column** (spec §3.2). This system records what the operator was told at registration and cannot know whether Meta still approves it; a `status` here would look like live truth and be a memory. The first rejected send is what discovers a revocation. Say that in the table comment, because the column is the obvious thing to add and the reason not to is not obvious.

`unique (company_id, purpose) where deleted_at is null` — one approved template per purpose per Station, which is what lets code reference a template by purpose and skips the environment variable the original decision had planned for the name and language.

Same RLS shape as Task 1: `select` to `authenticated` under `templates.view`, `select` to `service_role` (the enqueue resolves through it), `revoke truncate`, no direct write for anyone.

Regenerate types. Commit.

---

## Task 3: The outbox learns templates, and the enqueue resolves them

**Files:** Create `supabase/migrations/0111_outbox_template.sql`; modify `supabase/tests/18_templates.test.sql`.

**Interfaces produced:** `outbox_messages.template_name`, `.template_language`, `.template_variables`; `claim_outbox_batch(integer)` returning them (**third definition**); `enqueue_whatsapp_outbound(p_integration_id, p_to_phone, p_body, p_interactive, p_dedupe_key, p_template_purpose, p_template_variables)`.

**Read `supabase/migrations/0067_outbox_interactive.sql` in full before writing.** It is the exact precedent and it states both moves this task must repeat: `drop function if exists` because the returned table gains columns and Postgres refuses to replace a function whose OUT parameters change, and re-issuing the grant because a dropped function takes its ACL with it — *"losing this one would answer 42501 to every send."*

- [ ] **Step 1: Write the failing assertions first**

The proof that matters here is **D6's agreement**: enqueue a template message and assert the stored `body` is the registry's text with those variables substituted — not merely that both columns are non-null. A rendered body that drifts from the variables actually sent makes the audit trail confidently wrong, which is worse than absent because somebody will believe it.

Also assert: a purpose with no live registry row is refused at enqueue with `P0002`; a variable count disagreeing with the body's highest `{{n}}` is refused with `22023`; and a text send still works unchanged with the new signature.

- [ ] **Step 2: Write the migration**

Three columns, nullable and null together, mirroring `0067`'s comment style — including *why* `body` still carries words (0059: it is what an operator asking "what were they actually told?" has left once the phone is pruned).

Then `drop function if exists public.claim_outbox_batch(integer);` and re-create it returning the three new columns alongside the existing six, re-issuing `revoke`/`grant to service_role` and the comment.

Then `drop function public.enqueue_whatsapp_outbound(uuid, text, text, jsonb, text);` and re-create with the two new arguments. The body gains, before the insert:

```sql
  if p_template_purpose is not null then
    select * into v_tpl
      from public.message_templates
     where company_id = v_integ.company_id
       and purpose = p_template_purpose
       and deleted_at is null;

    if not found then
      raise exception 'no approved template registered for % in this station', p_template_purpose
        using errcode = 'P0002';
    end if;

    -- The highest {{n}} the approved body actually uses. Meta rejects a send
    -- whose variable count disagrees; refusing here turns a delivery failure
    -- nobody watches into a validation error somebody reads.
    v_expected := coalesce((
      select max((regexp_matches[1])::integer)
      from regexp_matches(v_tpl.body, '\{\{(\d+)\}\}', 'g')
    ), 0);

    if coalesce(jsonb_array_length(p_template_variables), 0) <> v_expected then
      raise exception 'template % expects % variable(s), got %',
        v_tpl.name, v_expected, coalesce(jsonb_array_length(p_template_variables), 0)
        using errcode = '22023';
    end if;

    -- RENDERED HERE, not by the caller (D6). One function reads the approved
    -- text and writes both the audit body and the variables, so the two cannot
    -- be produced from different sources and cannot drift.
    v_body := v_tpl.body;
    for v_i in 1 .. v_expected loop
      v_body := replace(v_body, '{{' || v_i || '}}',
                        p_template_variables ->> (v_i - 1));
    end loop;
  else
    v_body := p_body;
  end if;
```

…storing `v_body` in `body` and `v_tpl.name` / `v_tpl.language` / `p_template_variables` in the new columns.

Re-issue `revoke`/`grant to service_role` and the comment on the new signature.

**Note for the implementer:** verify `regexp_matches`' exact return shape against the local Postgres before trusting the snippet above — it returns `text[]`, and the aggregation over a set-returning function in a scalar subquery is the part most likely to need adjusting. If it needs a different form, use one and say so in your report. Do not change what it computes.

- [ ] **Steps 3–5:** watch it pass, regenerate types, commit.

---

## Task 4: The sweep that finally speaks

**Files:** Create `supabase/migrations/0112_sweep_pickup_reminders.sql`, `supabase/tests/19_pickup_reminders.test.sql`; modify `src/app/api/worker/tick/route.ts`.

**Read `supabase/migrations/0094_sweep_pickup_deadlines.sql` first.** This is its sibling and must match its shape: a **procedure**, committing per winner, and **not `SECURITY DEFINER`** — Block 6d's report records that a procedure that commits cannot be.

- [ ] **Step 1: Write the failing pgTAP first**

Five assertions the sweep must earn, each for its own reason:

1. A winner whose deadline is inside the window gets exactly one outbox row.
2. **Running the sweep twice enqueues nothing the second time** — proved by running it, not by reading the constraint (D9).
3. A winner whose draw was `CANCELLED` is skipped. **This is the case Blocks 6c and 6d each lost once.**
4. A winner already `DELIVERED` is skipped.
5. A winner whose deadline has **already passed** is skipped — the lower bound of D8's window. Reminding about an expired deadline tells somebody to collect a prize the clock already returned to stock, which is the one moment the message is worse than silence.
6. A Station with no registered `PICKUP_REMINDER` template enqueues nothing and does not abort the sweep for other Stations.
7. A winner whose listener has been anonymised is skipped. `anonymize_member` (0034) nulls `full_name`, so the reminder would go out addressed to nobody — and sending fresh messages to somebody who exercised erasure is precisely what that erasure was for. This is the same exclusion `searchStationListeners` and `create_music_request` both carry, for the same reason.

- [ ] **Step 2: Write the procedure**

```sql
create procedure public.sweep_pickup_reminders()
language plpgsql
as $$
declare
  v_ids uuid[];
  v_id  uuid;
begin
  -- Collected FIRST, then acted on, so no cursor is held across a commit —
  -- 0094's own rule, and the reason is the same: the list is microseconds
  -- stale by the time it is walked, and that is safe because the enqueue
  -- re-reads and the dedupe key refuses a repeat.
  select coalesce(array_agg(w.id), '{}') into v_ids
    from public.winners w
    join public.draws d on d.id = w.draw_id
   where w.status = 'AWAITING_PICKUP'
     and d.status <> 'CANCELLED'
     -- BOTH BOUNDS (D8). Without the lower one the sweep reminds about
     -- deadlines that have already passed.
     and w.deadline_at > now()
     and w.deadline_at <= now() + interval '2 days';

  foreach v_id in array v_ids loop
    begin
      perform public.enqueue_pickup_reminder(v_id);
      commit;
    exception when others then
      -- Per winner, on purpose, and this is the whole difference from Block
      -- 7b's merge: an unattended sweep must not let one bad row stop every
      -- Station, where one operator pressing one button must not get half a
      -- merge. A Station with no registered template lands here and the sweep
      -- continues.
      rollback;
    end;
  end loop;
end;
$$;
```

`enqueue_pickup_reminder(p_winner_id)` is a `SECURITY DEFINER` function this task also writes. It resolves the winner's Station, integration, listener phone, prize name and deadline, and calls `enqueue_whatsapp_outbound` with `p_template_purpose => 'PICKUP_REMINDER'`, `p_dedupe_key => 'pickup-reminder:' || p_winner_id`, `p_body => null` and `p_interactive => null`.

**The three variables, in this order — this is the contract the operator's registered template must match, and the runbook has to state it:**

| position | value |
|---|---|
| `{{1}}` | the listener's first name |
| `{{2}}` | the prize name |
| `{{3}}` | the deadline, as a date in **the Station's own timezone** |

The timezone is not a detail: `companies.timezone` exists precisely because spec L2 requires every period to render in the Station's local time rather than the reader's, and a reminder that names tomorrow when the Station means the day after is the one error this message cannot survive. Read the Station's zone and format there, the way every dated screen in this codebase already does.

First name rather than the full one because it is a message, not a record — and because `members.full_name` is nullable and null for an anonymised listener. **An anonymised listener must be skipped by the sweep entirely**, not reminded with an empty name; add that predicate and the assertion for it alongside the other exclusions.

**The dedupe key needs no hashing**, unlike the confirmation keys 0059 describes: a winner id is not a phone number, and `dedupe_key` is never pruned.

- [ ] **Step 3:** wire it into `src/app/api/worker/tick/route.ts` beside `sweep_pickup_deadlines`.
- [ ] **Steps 4–6:** watch it pass, regenerate types, commit.

---

## Task 5: The isolation suite

**Files:** Create `tests/isolation/templates.test.ts`; modify `scripts/verify-isolation-suite.mjs`.

Cases, all with real JWTs — the only layer that sees permissions:

1. A caller with `templates.view` and not `templates.manage` cannot write an override (`42501`).
2. A caller with neither cannot read one.
3. A caller with `templates.manage` at Station A cannot write an override at Station B, and the refusal does not reveal whether the Station exists.
4. The same pair for the registry.
5. **`templates.view` alone SUCCEEDS at reading both tables** — the positive branch, which is what makes the screens reachable and which pgTAP cannot prove.

`minTests` floor to match. Every label stamped.

**Run `npm run test:isolation` and report exactly what it says, by which route.**

---

## Task 6: The transport learns to send a template

**Files:** Create `src/lib/integrations/whatsapp/template.ts`, `tests/unit/template-payload.test.ts`; modify `transport.ts`, `graph.ts`, `fake.ts`, `src/services/whatsapp.ts`.

**Read `src/lib/integrations/whatsapp/interactive.ts` first** — `buildInteractivePayload` / `parseInteractive` are the pair yours mirrors, and the reason the application's own shape is stored rather than Meta's wire format (0067's column comment: *"the worker builds that at send time, so Meta's payload shape stays in one file"*).

- `SendTemplateInput { phoneNumberId, to, name, language, variables: string[] }` and `sendTemplate` on `WhatsAppTransport`.
- `graph.ts`: the `type: 'template'` payload with its `components` array.
- `fake.ts`: **this one matters** — it is what every test that is not a live send runs against.
- `drainOutbox` (`src/services/whatsapp.ts`, around line 327): a third branch. Follow the existing shape exactly — a stored payload that is not sendable is **parked with a reason on the row**, not retried, because Meta answers 400 to it every time and the ladder would spend six paid attempts arriving at the same answer.

Unit tests for the payload builder and the parser, against real values — not mocks.

---

## Task 7: The engine resolves a Station's wording

**Files:** Modify `src/lib/conversation/engine.ts`; create `tests/unit/system-message-resolution.test.ts`.

The ten constants stay exactly where they are and become the **defaults**. A resolver takes a Station's override map and a key and returns the override or the constant.

**The resolution is per text, not per Station** (D2) — a Station overriding one prompt keeps the defaults for the other nine. **Write the test that fails if somebody makes it all-or-nothing**, because that is the plausible wrong implementation and it is invisible until a Station with one override goes quiet on nine messages.

`engine.ts`'s own comment says these are constants "because the owner called them copy, changeable without a migration". That reasoning is not overturned — extend the comment to say they remain changeable without a migration and now without a deploy, and that they are the floor the resolver falls back to.

---

## Task 8: Schemas and services

**Files:** Create `src/schemas/templates.ts`, `src/services/templates.ts`, `tests/unit/templates-schema.test.ts`.

Schemas mirroring the two tables' refusals so each arrives as a field message rather than a round trip: a blank body; a `{{n}}` count in the registry body that disagrees with the number of variable descriptions given.

Services: read the override map for a Station, set one override, clear one; read the registry, upsert a row, archive one. Follow `src/services/music.ts`'s idiom — `asCaller(accessToken)` for writes, `createUserClient()` for reads, one `mapTemplateError` with the code taxonomy documented.

---

## Task 9: The Messages screen

**Files:** `src/app/(app)/templates/messages/…`

Follow `src/app/(app)/music/requests/page.tsx` for the skeleton, including `listCompanyAccess(supabase, 'templates.view', stationSearch)` and **`stationSwitchHref('/templates/messages', company.id, stationSearch)`** — the source-shape guard in `tests/unit/station-switch.test.ts` fails `npm test` if the switcher query is built by hand, and it will enrol this screen automatically.

All ten texts render whether overridden or not, each marked as the Station's own wording or the system default, **with the default visible while overriding** — an operator has to see what they are replacing. Clearing is a real button with its own action, not an empty save.

Write-side rendered only when `templates.manage` is held; the doors re-check regardless.

---

## Task 10: The registry screen, and the navigation

**Files:** `src/app/(app)/templates/whatsapp/…`; modify `src/lib/auth/shell.ts`.

The registry list and its form, showing the body with its placeholders and the variables in order, so the person can compare against what they submitted to Meta.

A new sidebar section, Templates, with Messages and WhatsApp. Keep the section's existing property — visible to every member, because each page refuses on its own and the database re-checks; hiding a link is a courtesy. Check `ICONS` in `src/components/layout/app-shell.tsx` for names that exist, and honour the rule that two adjacent rows never share an icon.

---

## Task 11: The round trip, the report and the runbook

**Files:** `tests/e2e/templates.spec.ts`, `docs/block-templates-report.md`, `docs/block-templates-runbook.md`.

**e2e:** override a system text, register a template, and confirm both persist and render as the Station's own. Run at `--workers=1` and report both parallelism results honestly.

**The report must record:**

1. **The four behaviours this block deliberately did not build** (D3) — inactivity, wait, audio rejection, call rejection — each with what it would cost, so the owner can price them.
2. **The Interaction Templates screen and why it is not here** (D1), so the 2026-08-03 three-screen decision does not read as half-delivered.
3. **That `message_templates` has no `status` column on purpose**, and that a revoked approval is discovered by the first rejected send.
4. The real isolation and e2e status, described fresh.

**The runbook must open with the two-deploy trap** — `has_permission` refuses a permission code that is not yet in `public.permissions`, so `templates.view`/`templates.manage` do not exist until `supabase db push` — and then walk: apply `0109`–`0112`, register the pickup-reminder template **in Meta's console**, wait for approval, record it on the WhatsApp screen, and watch one reminder go out.

**State plainly that no reminder can send until Meta approves the template**, which takes days and is outside this system. That is the one step a runbook cannot make faster, and an operator who does not know it will read the silence as a bug.

---

## Self-review — spec coverage

| spec requirement | task |
|---|---|
| D1 — two screens, Interaction deferred | 9, 10; recorded in 11 |
| D2 — override per text, absent row means the default | 1, 7 |
| D3 — text only, four behaviours named not built | 1 (enum comment), 11 (report) |
| D4 — registry records, does not submit | 2, 10 |
| D5 — registry per Station | 2 |
| D6 — rendered body and variables agree | 3, proved by its own assertion |
| D7 — sweep commits per winner | 4 |
| D8 — two days, both bounds | 4 |
| D9 — idempotency from the outbox, no new column | 4 |
| §3.1 / §3.2 / §3.3 — the three data changes | 1, 2, 3 |
| §4 — the send path | 3, 6 |
| §5 — the screens and two permission codes | 1, 9, 10 |
| §6 — every named proof | 3 (agreement), 4 (twice, exclusions), 5 (boundary), 7 (per-text fallback) |
| §7 — what other blocks inherit | 11 |

**Deliberately not in this plan:** the four missing behaviours, the Interaction Templates screen, Graph API submission, and any second `template_purpose` — the draw result and delivery confirmation add a purpose and a registry row, not a mechanism.
