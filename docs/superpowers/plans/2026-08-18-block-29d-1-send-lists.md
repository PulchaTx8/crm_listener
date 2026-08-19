# Block 29d-1 — Send Lists Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an operator turn any filtered listing — Members, Requests or Participations — into a named send list scoped to one Station, and see how many of its people are reachable on each channel.

**Architecture:** A list stores either the listener ids of one moment (fixed) or the filter payload that found them (living). **No filter logic is written anywhere in this block**: resolution calls the same three listing services the screens call, with a high limit, and collects distinct member ids. Reach per channel is `members_marketing_eligible_bulk` (0235) asked as the operator, because that function refuses a caller with no identity.

**Tech Stack:** PostgreSQL 17 (RLS, pgTAP), Next.js 15 App Router (Server Actions, `typedRoutes`), TypeScript, Zod, next-intl, Playwright, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-18-block-29d-campaigns-design.md` — §4, the list half of §7, the list half of §9. §2b says why this ships before the send.

## Global Constraints

- Comments explain WHY, never WHAT. A comment that states something **false** is a defect of the same severity as false code.
- No new user-facing English strings outside `messages/{en,pt,es}.json`. Zod messages inside `src/schemas/` are an established exception.
- The generated Supabase types file is generated, never hand-edited, and **must be committed** when it changes.
- One string literal for a PostgREST `.select(...)`, never a concatenation.
- `create or replace` preserves a function's ACL; `drop` + `create` destroys it. A recreated function is rebuilt from its **live** definition (`pg_get_functiondef`), never from the migration that first created it. `psql` is **not installed**; use a Node script with the repo's `pg` dependency against `LOCAL_SUPABASE_DB_URL`.
- pgTAP `plan(N)` is a file's running total — recount with `grep -c`, never by arithmetic.
- A migration that adds an enum value carries nothing else.
- Gate order is `db:reset` → `db:test` → `test:isolation`. `db:test` after another suite gives a red that is not code.
- **`git status --short` must print nothing before a `tsc` result is trusted.** A clean compile in a dirty tree proves nothing about the commit.
- Every conditionally rendered `<button>` gets a distinct `key`.

## The rule this block turns on

**Nothing here re-implements a filter.** `listOrganizationMembers` (`src/services/members.ts:477`), `listParticipationsPage` (`src/services/participations.ts:144`) and `listMusicRequestsPage` (`src/services/music.ts:1677`) already hold the only correct definition of what each screen shows. A resolver that restated any of their predicates would make a list mean something different from what the operator saw on the screen they made it from — which is the one failure this design exists to avoid.

## File Structure

| File | Responsibility |
|---|---|
| `supabase/migrations/0236_messaging_permissions.sql` | The three `messaging.*` permission codes |
| `supabase/migrations/0237_send_lists.sql` | `send_lists` + `send_list_members`, RLS, and the three doors |
| `supabase/tests/67_send_lists.test.sql` | pgTAP for both migrations |
| `src/schemas/send-lists.ts` | The Zod shapes a list is created and renamed with |
| `src/services/send-lists.ts` | Resolution (delegating to the three listing services), CRUD, reach |
| `src/app/(app)/messages/lists/page.tsx` | The list screen |
| `src/app/(app)/messages/lists/lists-grid.tsx` | The grid, its empty state and its actions |
| `src/app/(app)/messages/lists/actions.ts` | Server Actions for create, rename, delete |
| `src/components/send-lists/create-list-dialog.tsx` | The dialog the three source screens open |
| `tests/isolation/send-lists.test.ts` | Tenancy, with real sessions |

---

### Task 1: The permissions

**Files:**
- Create: `supabase/migrations/0236_messaging_permissions.sql`, `supabase/tests/67_send_lists.test.sql`

**Interfaces:**
- Produces: permission codes `messaging.view`, `messaging.manage`, `messaging.send`.

- [ ] **Step 1: Write the failing pgTAP**

Create `supabase/tests/67_send_lists.test.sql`:

```sql
begin;
select plan(4);

-- Block 29d-1. The permissions a send list and, later, a campaign are guarded
-- by. Born beside the feature they guard, which is 0010's own rule.
select is(
  (select count(*)::int from public.permissions
    where code in ('messaging.view', 'messaging.manage', 'messaging.send')),
  3, 'the three messaging permissions exist');

-- SEND IS SEPARATE FROM MANAGE, and that is the whole reason there are three
-- rather than two: approving a send to twenty thousand people is not the act of
-- drafting one, and a Station may want those in different hands.
-- `code` IS the primary key here -- this table has no `id` column.
select isnt(
  (select label from public.permissions where code = 'messaging.send'),
  (select label from public.permissions where code = 'messaging.manage'),
  'send is its own code with its own label, not an alias of manage');

select is(
  (select count(distinct module)::int from public.permissions
    where code like 'messaging.%'),
  1, 'and all three sit in one module, so a role screen groups them together');

select ok(
  (select bool_and(label is not null and label <> '')
     from public.permissions where code like 'messaging.%'),
  'each carries a label, because a role screen shows codes to nobody');

select finish();
rollback;
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run db:reset && npm run db:test 2>&1 | tail -6`
Expected: `67_send_lists.test.sql` fails its four assertions.

- [ ] **Step 3: Write the migration**

Read `supabase/migrations/0010_permissions.sql` first for the catalogue's columns and the display-order convention, then create `supabase/migrations/0236_messaging_permissions.sql` inserting the three codes.

The live columns, verified against the running database rather than taken from that migration, are: `code` (the primary key — **there is no `id`**), `description`, `introduced_by_block`, `created_at`, `module`, `label`, `scope`, `display_order`. Fill `introduced_by_block` with this block's number; `scope` is company-scoped, as every module since Block 2.

The comment must say why `messaging.send` is separate — spec §7 gives the sentence, and it is the only one of the three whose existence needs an argument.

- [ ] **Step 4: Run to verify it passes**

Run: `npm run db:reset && npm run db:test 2>&1 | tail -6`
Expected: `Result: PASS`.

- [ ] **Step 5: Find the counts no compiler holds**

Adding permissions moves any test that counts the catalogue.

```bash
grep -rn "from public.permissions" supabase/tests/ | head
grep -rn "toHaveCount(\|toHaveLength(" tests/ | grep -iE "permission|role"
```

Update every count that counts permissions; leave anything counting something else and say so in your report.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/0236_messaging_permissions.sql supabase/tests/67_send_lists.test.sql supabase/tests tests
git commit -m "feat(messaging): three permissions, and why sending is not managing"
```

---

### Task 2: The tables

**Files:**
- Create: `supabase/migrations/0237_send_lists.sql`
- Modify: `supabase/tests/67_send_lists.test.sql`

**Interfaces:**
- Produces: tables `send_lists` and `send_list_members`.

- [ ] **Step 1: Write the failing pgTAP**

Recount the plan with `grep -c` and append before `finish()`:

```sql
-- Task 2. A list is a name, a Station, and either people or a question.
select has_table('public', 'send_lists', 'the list table exists');
select has_table('public', 'send_list_members', 'and the table holding a fixed list''s people');

select col_is_pk('public', 'send_list_members', array['list_id', 'member_id'],
  'a person appears in a list once -- Requests and Participations are per event, and somebody who asked for twelve songs is one recipient');

select ok(
  (select count(*)::int from information_schema.columns
    where table_schema = 'public' and table_name = 'send_lists'
      and column_name in ('company_id', 'organization_id', 'source', 'kind', 'filters', 'name')) = 6,
  'a list carries its Station, its origin, its kind and the filters that built it');
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run db:reset && npm run db:test 2>&1 | tail -6`
Expected: the file fails from `has_table` onward.

- [ ] **Step 3: Write the migration**

Create `supabase/migrations/0237_send_lists.sql` with the two tables. Follow `supabase/migrations/0178_widget_link_tokens.sql` for the composite foreign key shape this project uses to prove a Station and an Organization agree.

```sql
-- supabase/migrations/0237_send_lists.sql

-- Block 29d-1. A send list: the people a campaign will go to, or the question
-- that finds them.
--
-- ONE STATION, ALWAYS (spec D3). member_consents.company_id is not null and a
-- campaign goes out as one Station, so a list spanning Stations would show a
-- number that is never the number sent. A group reaching three Stations makes
-- three lists, which is honest: those are three separate consents.
--
-- TWO KINDS (spec D2). A FIXED list stores its people in send_list_members and
-- never changes. A LIVING list stores `filters` and is resolved again on each
-- send. "Todos os ouvintes" wants to be living; "who requested a song between
-- 18:00 and 20:00 yesterday" is historical and wants to be fixed.
--
-- `filters` IS STORED FOR BOTH KINDS, not only living ones. A fixed list needs
-- it too: a list called "engajados" says nothing three months later, and the
-- question asked then is always "what exactly did I filter here". For a fixed
-- list it is a record; for a living one it is the query.
--
-- WHAT IS NOT HERE: eligibility. A list holds people, not permission to write to
-- them. Consent is applied when a campaign snapshots (29d-2) and again at send,
-- because it changes and a list should not silently come to mean something its
-- filters never said.
create type public.send_list_source as enum ('members', 'participations', 'requests');
create type public.send_list_kind as enum ('fixed', 'living');
```

**That enum creation goes in its own migration** — this project's rule for new types used in the same transaction. Split it: `0237_send_list_vocabulary.sql` carries the two `create type` statements and nothing else; `0238_send_lists.sql` carries the tables, RLS and doors. Renumber the rest of this plan accordingly and say in your report that you did.

The tables:

```sql
create table public.send_lists (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id),
  company_id      uuid not null,
  name            text not null check (btrim(name) <> ''),
  source          public.send_list_source not null,
  kind            public.send_list_kind not null,
  filters         jsonb not null default '{}'::jsonb,
  created_by      uuid references auth.users (id),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  deleted_at      timestamptz,

  constraint send_lists_company_org_fk
    foreign key (company_id, organization_id)
    references public.companies (id, organization_id)
);

create table public.send_list_members (
  list_id   uuid not null references public.send_lists (id) on delete cascade,
  member_id uuid not null references public.members (id) on delete cascade,
  primary key (list_id, member_id)
);
```

`on delete cascade` on both: a deleted list's people are not a fact about anything, and a member erased under §12 must not survive in a list. Say that in the comment — it is the kind of choice a reader will otherwise assume was carelessness.

Enable RLS on both. `send_lists` gets `select` for callers holding `messaging.view` at that Station and the usual platform-admin bypass; `send_list_members` gets no policy at all, because nothing reads it as a user — the doors and the resolver reach it. Say so, as `0232_unsubscribe_tokens.sql` does for its own table.

- [ ] **Step 4: Run to verify it passes**

Run: `npm run db:reset && npm run db:test 2>&1 | tail -6`
Expected: `Result: PASS`.

- [ ] **Step 5: Regenerate types and commit**

```bash
npm run db:types
git status --short
npx tsc --noEmit
git add supabase/migrations src/lib/supabase/database.types.ts supabase/tests/67_send_lists.test.sql
git commit -m "feat(lists): a list is a Station, a name, and either people or a question"
```

`git status --short` must print nothing after the commit before you trust `tsc`.

---

### Task 3: The doors

**Files:**
- Create: the doors inside the migration Task 2 created
- Modify: `supabase/tests/67_send_lists.test.sql`

**Interfaces:**
- Produces: `create_send_list(p_company_id uuid, p_name text, p_source public.send_list_source, p_kind public.send_list_kind, p_filters jsonb, p_member_ids uuid[]) returns uuid`; `rename_send_list(p_list_id uuid, p_name text) returns void`; `delete_send_list(p_list_id uuid) returns void`.

- [ ] **Step 1: Write the failing pgTAP**

Recount the plan and append assertions covering: each door exists; each raises `42501` for a caller without `messaging.manage` at that Station; `create_send_list` refuses a member id not linked to `p_company_id`; a fixed list stores its people and a living one stores none; `delete_send_list` is a soft delete and its people go with it; and the grants — `authenticated` holds EXECUTE, `anon` and PUBLIC do not.

Write each assertion out in full rather than describing it; the file already shows the shape.

- [ ] **Step 2: Run to verify it fails**

Run: `npm run db:reset && npm run db:test 2>&1 | tail -8`

- [ ] **Step 3: Write the doors**

All three are `security definer` with `set search_path = pg_catalog, public`, re-checking `has_permission('messaging.manage', p_company_id)` in their own body and raising `42501` — the boundary is the database's and hiding a button is a courtesy. Each writes an `audit_logs` row, as every write door in this project does.

`create_send_list` additionally refuses a `p_member_ids` entry that is not linked to `p_company_id`, using `member_linked_to_company` (0034). A list is per Station (D3), and a caller who could pass any id could otherwise assemble a list of listeners they cannot see.

For a living list `p_member_ids` must be empty and for a fixed one it must not be; refuse the mismatch with `22023` rather than storing a list that contradicts its own kind.

- [ ] **Step 4: Run to verify it passes**

Run: `npm run db:reset && npm run db:test 2>&1 | tail -6`

- [ ] **Step 5: Prove the tenancy refusal bites**

Remove the `member_linked_to_company` check, re-run, and confirm the cross-Station assertion fails. Report the verbatim line and restore.

- [ ] **Step 6: Commit**

```bash
npm run db:types && git status --short && npx tsc --noEmit
git add supabase/migrations supabase/tests/67_send_lists.test.sql src/lib/supabase/database.types.ts
git commit -m "feat(lists): three doors, each refusing a Station the caller cannot reach"
```

---

### Task 4: Resolution

**Files:**
- Create: `src/schemas/send-lists.ts`, `src/services/send-lists.ts`, `tests/unit/send-lists-resolve.test.ts`

**Interfaces:**
- Consumes: `listOrganizationMembers`, `listParticipationsPage`, `listMusicRequestsPage`.
- Produces: `resolveListMembers(source, filters, accessToken): Promise<string[]>`; `RESOLVE_CAP = 10_000`.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/send-lists-resolve.test.ts` with the three listing services mocked, asserting: the resolver calls the service matching the source and no other; it returns **distinct** member ids when the underlying pages repeat one (Requests and Participations are per event); it **drops a falsy member_id** as a defensive guard rather than for a case that can occur, since `music_requests.member_id` is not null with a mandatory FK and 0191 inner joins members; it pages until exhausted rather than returning only the first page; and it stops at `RESOLVE_CAP` and reports that it was capped rather than silently truncating.

Write the cases out in full, using `vi.mock` on the three service modules.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/unit/send-lists-resolve.test.ts 2>&1 | tail -6`

- [ ] **Step 3: Write the resolver**

```ts
/**
 * The people a list holds, found by asking the same service the screen asked.
 *
 * NOTHING HERE RE-IMPLEMENTS A FILTER, and that is the whole design. The three
 * listing services hold the only correct definition of what each screen shows;
 * a predicate restated here would drift, and a drifted list means something
 * different from what the operator saw when they made it — which is the one
 * failure this feature exists to avoid.
 *
 * DISTINCT PEOPLE, not rows. Requests and Participations are per event:
 * somebody who asked for twelve songs is twelve rows and one recipient.
 *
 * A FALSY member_id IS DROPPED, defensively rather than because one can occur.
 * `music_requests.member_id` is `uuid not null` with a mandatory foreign key
 * (0098:193, 213-215) and `list_music_requests` inner joins `members`
 * (0191:123), so today no row it returns can carry a null. The guard costs
 * nothing and survives a schema that changes later; what it must NOT do is
 * claim a cause that does not exist. (An earlier draft of this plan inferred
 * nullability from `returns table (member_id uuid, …)` omitting `not null` —
 * no `returns table` in this repository declares it, so the omission says
 * nothing at all.)
 *
 * CAPPED, and the cap is reported rather than silently applied. A list that
 * quietly held the first ten thousand of forty thousand would be a number the
 * operator trusts and should not.
 */
export const RESOLVE_CAP = 10_000;
```

The body pages through the matching service with its own cursor until a page comes back short or the cap is reached, collecting `member_id` into a `Set`.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/unit/send-lists-resolve.test.ts 2>&1 | tail -6 && npx tsc --noEmit`

- [ ] **Step 5: Commit**

```bash
git add src/schemas/send-lists.ts src/services/send-lists.ts tests/unit/send-lists-resolve.test.ts
git commit -m "feat(lists): resolution that asks the same service the screen asked"
```

---

### Task 5: Reach per channel

**Files:**
- Modify: `src/services/send-lists.ts`, `tests/unit/send-lists-resolve.test.ts`

**Interfaces:**
- Produces: `listReach(listId, accessToken): Promise<{ people: number; whatsapp: number; email: number }>`.

- [ ] **Step 1: Write the failing test**

Assert that reach asks `members_marketing_eligible_bulk` once per channel over the list's people, and that the two channel numbers may differ from the people count and from each other.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/unit/send-lists-resolve.test.ts 2>&1 | tail -6`

- [ ] **Step 3: Write it**

The comment must carry the fact the screen depends on:

```ts
/**
 * How many of a list's people may actually be written to, per channel.
 *
 * A list of 500 is not 500 messages. On e-mail it is nearly that; on WhatsApp
 * today it is close to zero, because 29c's D1 requires an explicit opt-in and
 * collection only began with that block. Both numbers sit on the screen before
 * anything is sent — without them the first WhatsApp campaign looks like a
 * defect rather than like an audience that has not been asked yet.
 *
 * ASKED AS THE OPERATOR, never as a worker. members_marketing_eligible_bulk
 * (0235) is SECURITY DEFINER behind a permission gate and refuses a caller with
 * no identity outright.
 */
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run 2>&1 | tail -4 && npx tsc --noEmit`

- [ ] **Step 5: Commit**

```bash
git add src/services/send-lists.ts tests/unit/send-lists-resolve.test.ts
git commit -m "feat(lists): the two numbers that stop a WhatsApp campaign looking broken"
```

---

### Task 6: The list screen

**Files:**
- Create: `src/app/(app)/messages/lists/page.tsx`, `lists-grid.tsx`, `actions.ts`
- Modify: `src/lib/auth/shell.ts`, `messages/{en,pt,es}.json`

- [ ] **Step 1: The route and the menu entry**

Add *Listas* under MENSAGENS in `src/lib/auth/shell.ts`, beside the existing entries, gated on `messaging.view`. Follow how the neighbouring items declare their permission.

- [ ] **Step 2: The grid**

`lists-grid.tsx` shows, per list: name, Station, fixed or living, how many people, the two reach numbers from Task 5, which screen it came from, and the filters as readable text. Actions: rename, delete. Follow `src/app/(app)/messages/templates/marketing-grid.tsx` for the shape, including its deterministic ordering — a grid ordered by a column that is null for every row is a defect this project has already shipped.

The empty state names the act: it tells the operator lists are made from the Ouvintes, Pedidos and Participações screens, because an empty screen with no route out is where somebody gives up.

- [ ] **Step 3: The actions**

`actions.ts` parses with the Zod shapes from Task 4 and delegates to the service, `revalidatePath('/messages/lists')`, and maps errors through a `describe…Error` in the section's own errors module — following `src/app/(app)/messages/errors.ts`.

- [ ] **Step 4: The copy**

Every key in all three catalogues, real Portuguese and Spanish.

- [ ] **Step 5: Run the gates**

```bash
npx tsc --noEmit && npm run lint && npx vitest run 2>&1 | tail -4 && git status --short
```

- [ ] **Step 6: Commit**

```bash
git add "src/app/(app)/messages/lists" src/lib/auth/shell.ts messages
git commit -m "feat(lists): the screen that holds them, and what each one is"
```

---

### Task 7: The button on the three screens

**Files:**
- Create: `src/components/send-lists/create-list-dialog.tsx`
- Modify: `src/app/(app)/members/`, `src/app/(app)/participations/`, `src/app/(app)/music/requests/` — the three listing screens; `messages/{en,pt,es}.json`

- [ ] **Step 1: The dialog**

One component used by all three. It takes the current filters, asks for a name, asks fixed or living, and — when the source screen has no Station chosen — asks which Station (D3). It shows the resolved count before saving, so the operator sees what they are about to keep.

Give every conditionally rendered `<button>` a distinct `key`.

- [ ] **Step 2: The button**

Beside the filtered result on each of the three screens, visible only with `messaging.manage`. **The caller must also be able to see the listing itself** — the button is a door to the same data, and a door that skips the check the front door makes is a side entrance.

- [ ] **Step 3: The copy, in three languages**

- [ ] **Step 4: Run the gates**

```bash
npx tsc --noEmit && npm run lint && npx vitest run 2>&1 | tail -4 && git status --short
```

- [ ] **Step 5: Commit**

```bash
git add src/components/send-lists "src/app/(app)/members" "src/app/(app)/participations" "src/app/(app)/music/requests" messages
git commit -m "feat(lists): the button where the filters already are"
```

---

### Task 8: Tenancy, the journey, and the full gate run

**Files:**
- Create: `tests/isolation/send-lists.test.ts`
- Modify: `tests/e2e/`, `scripts/verify-isolation-suite.mjs`

- [ ] **Step 1: The isolation cases**

Following `tests/isolation/consent.test.ts` for its harness use. At minimum:

1. A caller without `messaging.manage` at that Station cannot create a list there (`42501`).
2. `create_send_list` refuses a member id linked only to another Station.
3. A list of Station A is not visible to a session of Station B.
4. `send_list_members` cannot be read directly by an authenticated caller — only the doors and the resolver reach it.
5. Deleting a member removes them from every list (the cascade), which is §12's obligation reaching this table.

Raise `minTests` in `scripts/verify-isolation-suite.mjs` and register the file in its required list.

- [ ] **Step 2: The e2e**

Filter the Requests screen, click *Criar lista de envio*, name it, choose fixed, save; then assert on the lists screen that it appears with the right count — and assert the **database** holds the right rows, because a screen saying "salvo" proves the action was reached and not that anything was written.

- [ ] **Step 3: The full gate run, in the order that gives an honest verdict**

```bash
npm run db:reset
npm run db:test
npm run test:isolation
npx tsc --noEmit
npm run lint
npx vitest run
```

then the e2e spec you touched with `CI=1 npx playwright test <spec> --workers=1`.

`db:reset` must precede `db:test`, and `db:test` must never follow the isolation suite or the e2e.

**If the isolation wrapper reports INCOMPLETE**, that is this repo's documented `Worker exited unexpectedly` flake. Confirm before blaming code: re-run with `--reporter=default --reporter=json --outputFile=./iso.json` and compare the JSON against the summary line. A JSON report listing every file with zero failures beside a short or corrupted summary IS that crash. Say plainly which it was.

- [ ] **Step 4: The counts no compiler holds**

```bash
grep -rn "toHaveCount(\|toHaveLength(" tests/ | grep -iE "permission|list|messaging"
grep -rn "from public.permissions" supabase/tests/
```

- [ ] **Step 5: Commit**

```bash
git add tests scripts
git commit -m "feat(lists): the tenancy cases, and the journey from a filter to a list"
```

---

## Self-Review

**Spec coverage.** §4's two kinds → Tasks 2 and 3. §4's distinct people → Task 4. §4's "a list holds people, not eligibility" → Task 2's comment and Task 5's separation of reach from membership. §4's reach per channel → Task 5. §4's readable filters → Tasks 2 and 6. D3's one Station → Tasks 2, 3 and 7. D5's button on three screens → Task 7. §7's permissions → Task 1, with the manage-plus-see-the-listing rule in Task 7. §9's list half → Task 8. **Not in this plan, by §2b:** campaigns, the queue, the drain, providers, the test send, and §8's retention — all 29d-2's.

**Placeholders.** Tasks 6 and 7 describe screens rather than reproducing them, and name the precedent file to copy for each. Task 3's pgTAP is described rather than written out, which is a real gap: its implementer must write the assertions in full, and the step says so.

**Type consistency.** `resolveListMembers(source, filters, accessToken)` and `RESOLVE_CAP` are defined in Task 4 and used in Tasks 5 and 6. `listReach` is defined in Task 5 and consumed by Task 6's grid. The three doors' signatures are written once in Task 3's Interfaces block and called under those names in Task 6's actions.

**One correction found while reviewing.** Task 2 originally put two `create type` statements in the same migration as the tables that use them. This project's rule is that a migration adding a type ships alone, so Task 2's Step 3 now splits into `0237_send_list_vocabulary.sql` and `0238_send_lists.sql`, and every later migration number shifts by one.
