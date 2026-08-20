# Block 30c — Promotion Fields, Rules Gate and Menu Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Two new fields on a promotion (an authorization certificate number and an optional Programme), a rule making the entry text mandatory once a door is open, two layout corrections, a confirmation before discarding a half-written promotion, and the PROMOTIONS menu in the order the errand runs.

**Architecture:** One migration adds the two columns, the Programme by a composite `(show_id, company_id)` foreign key so a cross-Station reference is unrepresentable. A second recreates `create_promotion` / `update_promotion` — which have been redefined six times — from their **live** definitions, adding the two parameters and a gate that refuses a *transition* into "door on, rules blank" rather than the state itself, because promotions in production may already be in it.

**Tech Stack:** PostgreSQL 17 (RLS, pgTAP), Next.js 15 App Router (Server Actions, `typedRoutes`), TypeScript, Zod, next-intl, Playwright, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-20-block-30c-promotion-fields-design.md`

## Global Constraints

- Comments explain WHY, never WHAT. **A comment that states something false is a defect of the same severity as false code.** Blocks 30a and 30b closed **twelve** of these between them, every one in text a plan supplied. Read each sentence you write as a claim; if you cite a file:line, resolve it. Three shapes recur and are worth knowing: a claim that was true when written and died with a later change; a "correction" that adds a true sentence beside a false one instead of removing it (that produced a Critical); and a guarantee attributed to an assertion that does not provide it.
- **If your change falsifies a comment you did not touch, that comment is yours to fix.**
- No new user-facing English strings outside `messages/{en,pt,es}.json`. All three catalogues get every key; `catalogue.test.ts` is the guard. A duplicate key in one JSON object is not a compiler error — the later one silently wins, so check before adding.
- `src/lib/supabase/database.types.ts` is generated, never hand-edited. Regenerate with `npm run db:types`.
- One string literal for a PostgREST `.select(...)`, never a concatenation.
- pgTAP `plan(N)` is the file's **running total**.
- Migrations already merged are never edited in place. Next free migration number: **0258**. Next free pgTAP file number: **71**.
- Gate order is `npm run db:reset` → `npm run db:test` → `npm run test:isolation`, then `npm run seed:branding` → `npm run test:e2e`. `db:reset` wipes the storage bucket, which is why `seed:branding` precedes any e2e run.
- **Run the e2e suite whole and once.** `playwright.config.ts:30-42` pins one worker locally because `next dev` compiles each route on first visit and the test paying for it blows its budget, reporting as a broken sign-in. Sharding multiplies that by restarting the server per shard.
- Every conditionally rendered `<Button>` gets a distinct `key`.

## Run every suite in the FOREGROUND

Never background a suite and never poll for one. **If a command is auto-backgrounded on you, stop immediately and report `NEEDS_CONTEXT` naming it** — the controller runs it and hands you the result. This has happened repeatedly on this machine; it is a normal outcome, not a failure.

## The trap that dominates this plan

`create_promotion` and `update_promotion` have been redefined **six times**: `0042`, `0050`, `0055`, `0144`, `0172`, `0184`. Task 2 recreates them a seventh.

**Their new bodies are `pg_get_functiondef` of the LIVE functions with the change applied** — never `0184`'s text retyped, never an earlier one. `0172`'s own header records why, and names the incident: *"Retyping a shipped body is how 0168 silently reverted 0163's public-key pin one block ago."* Re-deriving from `0172` would revert `0184`'s hashtag collision guard; from `0144`, five rounds at once. **Nothing would turn red.**

**And adding a parameter is a `drop` + `create`, not a replace.** `create or replace` with a different argument list creates an **overload**: the old 17-argument function would survive beside the new 19-argument one, and PostgREST would keep resolving to whichever matches the call. `0172` faced exactly this and dropped both old signatures explicitly before creating. **`drop` destroys the ACL**, so both grants are restated — `0172` does that at `:371-385`, and Task 2 verifies it afterwards against `pg_proc.proacl`.

## Facts verified before this plan was written

- Both doors currently take **17 parameters**, ending `…, p_max_entries_per_member integer, p_web_enabled boolean, p_rules text`. Dumped live from `pg_proc`.
- `shows` already carries `shows_id_company_unique UNIQUE (id, company_id)`, so the composite FK needs no new index.
- `shows` is soft-deleted through `deleted_at` (`0098:109`) — nothing is ever hard-deleted, which is why `show_id` needs no referential action.
- `promotion-fields.tsx:57-124` is a `grid gap-4 sm:grid-cols-2` and holds a spacer at `:85`; `:126-196` is a `flex flex-col` bordered box holding both repeats fields.
- `PromotionRecordDialog:164` holds `dirty` and `:278` guards closing with `window.confirm`; `RegisterPromotionForm` passes `onDirty={() => undefined}` to both field groups.

## File Structure

| File | Responsibility |
|---|---|
| `supabase/migrations/0258_promotion_certificate_and_show.sql` | The two columns, the composite FK, two `comment on column` |
| `supabase/migrations/0259_promotion_rules_gate.sql` | Both doors recreated: two parameters, and the transition gate |
| `supabase/tests/71_promotion_rules_gate.test.sql` | pgTAP for the FK and for the gate's four rows |
| `src/services/promotions.ts` | The two fields on the detail type, and `showArchived` |
| `src/schemas/promotions.ts` | Validation for both |
| `src/app/(app)/promotions/promotion-fields.tsx` | Items 10 and 16 |
| `src/app/(app)/promotions/register-promotion-form.tsx` | Item 13 |
| `src/lib/auth/shell.ts` | Item 11 |

---

### Task 1: The two columns

**Files:**
- Create: `supabase/migrations/0258_promotion_certificate_and_show.sql`, `supabase/tests/71_promotion_rules_gate.test.sql`
- Modify: `src/lib/supabase/database.types.ts` (regenerated)

**Interfaces:**
- Produces: `promotions.authorization_certificate text` (nullable, no uniqueness) and `promotions.show_id uuid` with `promotions_show_fk`.

- [ ] **Step 1: Write the failing pgTAP**

Create `supabase/tests/71_promotion_rules_gate.test.sql`. This task adds the first three assertions; Task 2 extends the same file.

```sql
begin;
select plan(3);

-- Block 30c. Two fields a promotion gains, and the rule that the entry text
-- cannot be blank once a door is open. This task covers the columns; the gate's
-- own cases are appended by 0259's task.

insert into public.organizations (id, name) values
  ('00000000-0000-0000-0000-0000000030c1', 'Org 30c');
insert into public.companies (id, organization_id, name, timezone) values
  ('00000000-0000-0000-0000-0000000030a1', '00000000-0000-0000-0000-0000000030c1', 'Station A', 'America/Sao_Paulo'),
  ('00000000-0000-0000-0000-0000000030b1', '00000000-0000-0000-0000-0000000030c1', 'Station B', 'America/Sao_Paulo');

insert into public.shows (id, organization_id, company_id, name) values
  ('00000000-0000-0000-0000-0000000030f1', '00000000-0000-0000-0000-0000000030c1', '00000000-0000-0000-0000-0000000030a1', 'Manha de A');

insert into public.promotions
  (id, organization_id, company_id, name, starts_at, ends_at)
values
  ('00000000-0000-0000-0000-0000000030d1', '00000000-0000-0000-0000-0000000030c1',
   '00000000-0000-0000-0000-0000000030a1', 'Promo A', now(), now() + interval '30 days');

-- 1: the certificate is free text and carries NO uniqueness, deliberately (D1).
-- A second promotion may hold the same number: the number is issued outside this
-- system, which has no way to know whether two promotions sharing one is an error
-- or a licence covering both.
insert into public.promotions
  (id, organization_id, company_id, name, starts_at, ends_at, authorization_certificate)
values
  ('00000000-0000-0000-0000-0000000030d2', '00000000-0000-0000-0000-0000000030c1',
   '00000000-0000-0000-0000-0000000030a1', 'Promo A2', now(), now() + interval '30 days', 'CERT-1'),
  ('00000000-0000-0000-0000-0000000030d3', '00000000-0000-0000-0000-0000000030c1',
   '00000000-0000-0000-0000-0000000030a1', 'Promo A3', now(), now() + interval '30 days', 'CERT-1');
select is(
  (select count(*)::int from public.promotions where authorization_certificate = 'CERT-1'),
  2, 'two promotions may carry the same certificate number');

-- 2: a Programme of the SAME Station attaches.
update public.promotions set show_id = '00000000-0000-0000-0000-0000000030f1'
 where id = '00000000-0000-0000-0000-0000000030d1';
select is(
  (select show_id from public.promotions where id = '00000000-0000-0000-0000-0000000030d1'),
  '00000000-0000-0000-0000-0000000030f1'::uuid, 'a Programme of the same Station attaches');

-- 3: and one from ANOTHER Station cannot be represented at all. The FK is
-- composite on (show_id, company_id), which is how this schema makes a
-- cross-Station reference impossible rather than merely unlikely -- the same
-- device promotion_questions (0041) and promotions itself already use.
insert into public.shows (id, organization_id, company_id, name) values
  ('00000000-0000-0000-0000-0000000030f2', '00000000-0000-0000-0000-0000000030c1', '00000000-0000-0000-0000-0000000030b1', 'Manha de B');
select throws_ok($$
  update public.promotions set show_id = '00000000-0000-0000-0000-0000000030f2'
   where id = '00000000-0000-0000-0000-0000000030d1'
$$, '23503', null, 'a Programme from another Station cannot be attached');

select * from finish();
rollback;
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm run db:reset && npm run db:test`
Expected: FAIL — `column "authorization_certificate" of relation "promotions" does not exist`.

- [ ] **Step 3: Write the migration**

Create `supabase/migrations/0258_promotion_certificate_and_show.sql`:

```sql
-- supabase/migrations/0258_promotion_certificate_and_show.sql

-- Block 30c, items 10 and 17. Two things a promotion can now record: the number
-- of the authorisation that licenses it, and the Programme it belongs to.
--
-- NEITHER IS USED BY ANY RULE IN THIS BLOCK. The certificate is shown and
-- stored; the Programme is stored so Block 30e can bound a participation window
-- by its schedule, which is what the owner's item 17 says in as many words
-- ("It will be used later for filtering and eligibility"). Recording that here
-- so the next reader does not go looking for the logic.

alter table public.promotions
  add column authorization_certificate text,
  add column show_id                   uuid;

-- NO UNIQUE INDEX, and that is a decision rather than an omission (D1).
-- site_integration_code carries one (0040) because this system issues it. The
-- certificate number is issued OUTSIDE this system, which has no way to know
-- whether two promotions sharing one is a mistake or one licence covering both
-- -- and a unique index would turn a question about paperwork into a save that
-- fails with a message the operator cannot act on.
comment on column public.promotions.authorization_certificate is
  'The number of the authorisation that licenses this promotion, as the operator transcribes it. Free text, optional, and deliberately NOT unique: it is issued outside this system, so two promotions covered by one licence are a legitimate shape here. Never validated against a format -- if one is ever required, it is a rule somebody outside this system owns.';

-- COMPOSITE, so a cross-Station reference is unrepresentable rather than merely
-- unlikely -- the device promotion_questions (0041) and promotions' own
-- company/organization FK already use. shows already carries the matching
-- shows_id_company_unique (id, company_id), so this needs no new index.
--
-- NO ON DELETE ACTION, and none is needed: shows is soft-deleted through
-- deleted_at (0098), so a Programme is never actually removed for a rule to
-- fire on. A promotion keeps pointing at an archived Programme on purpose (D3)
-- -- a promotion that ran inside a Programme ran inside it whether or not the
-- Programme is still on air, and the screen says "archived" beside the name
-- rather than implying it is still scheduled. Same treatment list_music_requests
-- gives an archived song, and for the reason 0101 gives: a historical fact
-- outlives the thing it names.
alter table public.promotions
  add constraint promotions_show_fk
  foreign key (show_id, company_id) references public.shows (id, company_id);

comment on column public.promotions.show_id is
  'The Programme this promotion belongs to, or null. Optional. Survives the Programme being archived (shows.deleted_at) rather than being cleared, so that a promotion which ran inside a Programme still says so and Block 30e can still read that Programme''s schedule. The FK is composite on (show_id, company_id) so a Programme from another Station cannot be attached.';
```

- [ ] **Step 4: Run it and watch it pass**

Run: `npm run db:reset && npm run db:test`
Expected: PASS, including `71_promotion_rules_gate`.

- [ ] **Step 5: Regenerate the types**

Run: `npm run db:types && npm run typecheck`
Expected: both columns appear on the `promotions` row type; typecheck green.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/0258_promotion_certificate_and_show.sql supabase/tests/71_promotion_rules_gate.test.sql src/lib/supabase/database.types.ts
git commit -m "feat(30c): the licence a promotion is run under, and the programme it belongs to"
```

---

### Task 2: The gate that refuses a transition

**Files:**
- Create: `supabase/migrations/0259_promotion_rules_gate.sql`
- Modify: `supabase/tests/71_promotion_rules_gate.test.sql`, `src/lib/supabase/database.types.ts`

**Interfaces:**
- Produces: `create_promotion` and `update_promotion`, each with **19** parameters — the existing 17 plus `p_authorization_certificate text default null` and `p_show_id uuid default null` — and D2's gate.

- [ ] **Step 1: Dump the live definitions**

`psql` is **not installed**. Use a Node script with the repo's `pg` dependency against `LOCAL_SUPABASE_DB_URL` (default `postgresql://postgres:postgres@127.0.0.1:54322/postgres`):

```js
// scripts/dump-fn.mjs — throwaway, delete before committing
import pg from 'pg';
const c = new pg.Client(process.env.LOCAL_SUPABASE_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres');
await c.connect();
const { rows } = await c.query(
  "select pg_get_functiondef(p.oid) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname='public' and p.proname = $1",
  [process.argv[2]],
);
console.log(rows.map((r) => r.pg_get_functiondef).join('\n\n'));
await c.end();
```

Dump `create_promotion` and `update_promotion`. **Those two outputs are the basis of the migration.** Keep them open.

- [ ] **Step 2: Write the failing pgTAP**

Append to `supabase/tests/71_promotion_rules_gate.test.sql` and raise `plan(3)` to `plan(7)`.

The four rows of D2's table, each as its own assertion. Seed an actor holding `promotions.manage` at Station A using this suite's own role/grant idiom — copy it from `supabase/tests/03_promotions.test.sql` rather than inventing one, and raise `plan(N)` again if the fixture adds assertions of its own.

```sql
-- 4: creating with a door on and blank rules is refused.
select throws_ok($$
  select public.create_promotion(
    '00000000-0000-0000-0000-0000000030a1', 'Sem regras',
    now(), now() + interval '10 days',
    null, null, false, null, false, false, null, null, null, '{}', null,
    true,  -- p_web_enabled
    null)  -- p_rules
$$, '22023', null, 'a promotion cannot be created with a door open and no rules');

-- 5: turning a door on with blank rules is refused.
-- (Seed a promotion with both doors off and no rules first, then update it.)
select throws_ok($$
  select public.update_promotion(
    '00000000-0000-0000-0000-0000000030d4', 'Promo D4',
    now(), now() + interval '10 days',
    null, null, false, null, false, true, 'hash30c', null, null, '{}', null,
    false, null)
$$, '22023', null, 'a door cannot be opened while the rules are blank');

-- 6: clearing the rules while a door is on is refused.
select throws_ok($$
  select public.update_promotion(
    '00000000-0000-0000-0000-0000000030d5', 'Promo D5',
    now(), now() + interval '10 days',
    null, null, false, null, false, false, null, null, null, '{}', null,
    true, null)
$$, '22023', null, 'the rules cannot be cleared while a door is open');

-- 7: AND THE ONE THAT MUST BE ALLOWED, which is the decision this gate exists
-- to express. A promotion already door-on and rules-blank -- a shape reachable
-- since 0171 made rules nullable -- stays editable. An operator correcting a
-- closing date is not held hostage to a text they may not have.
select lives_ok($$
  select public.update_promotion(
    '00000000-0000-0000-0000-0000000030d6', 'Promo D6 renomeada',
    now(), now() + interval '20 days',
    null, null, false, null, false, false, null, null, null, '{}', null,
    true, null)
$$, 'a promotion already door-on and rules-blank stays editable');
```

Seed `…30d4` with both doors off and no rules, `…30d5` with a door on **and** rules, and `…30d6` with a door on and no rules — written directly with `insert`, because `create_promotion` will refuse the last one once the gate exists.

- [ ] **Step 3: Run it and watch it fail**

Run: `npm run db:reset && npm run db:test`
Expected: FAIL — assertions 4-6 do not throw, because no gate exists yet. Assertion 7 passes already, which is correct: it asserts something that must remain true.

- [ ] **Step 4: Write the migration**

Create `supabase/migrations/0259_promotion_rules_gate.sql`. Its header, before the drops:

```sql
-- supabase/migrations/0259_promotion_rules_gate.sql

-- Block 30c, items 15 and (the plumbing for) 10 and 17.
--
-- BOTH BODIES BELOW ARE THE LIVE DEFINITIONS (pg_get_functiondef), with the
-- edits listed here and nothing else. These two functions have been redefined
-- SIX times -- 0042, 0050, 0055, 0144, 0172, 0184 -- and 0172's own header
-- records what retyping one costs: "Retyping a shipped body is how 0168
-- silently reverted 0163's public-key pin one block ago." Re-deriving from 0172
-- would revert 0184's hashtag collision guard; from 0144, five rounds at once.
-- Nothing would turn red.
--
-- The edits are only these:
--
--   * p_authorization_certificate and p_show_id are appended to both parameter
--     lists and written to the row.
--   * update_promotion gains the rules gate below. create_promotion gains its
--     simpler half: there is no previous row, so any door-on-and-blank is
--     refused outright.
--
-- DROP AND CREATE, NOT create or replace, and this is not housekeeping: adding
-- a parameter changes the signature, and `create or replace` with a different
-- argument list creates an OVERLOAD -- the 17-argument function would survive
-- beside the 19-argument one and PostgREST would keep resolving to whichever
-- matched the call. 0172 faced this and dropped explicitly for the same reason.
-- The drop destroys the ACL, so both grants are restated at the end.
```

The gate itself, in `update_promotion`, after the existing row is read and before the `update`:

```sql
  -- Block 30c D2. THE GATE REFUSES A TRANSITION, NOT A STATE, and that is the
  -- decision rather than a shortcut.
  --
  -- `rules` was added nullable and unconstrained (0171) and both doors have been
  -- enable-able without it ever since, so promotions in production may already
  -- be door-on and rules-blank. Refusing the STATE would hold an operator
  -- correcting a closing date hostage to a text they may not have; refusing the
  -- TRANSITION stops anyone making it worse while leaving the existing shape
  -- editable.
  --
  -- A CHECK cannot express this -- not even NOT VALID -- because a CHECK sees
  -- only the row being written and never the row being replaced. That is why
  -- this lives in the door, which has already read the current row.
  --
  -- WHAT THIS REPLACES IS A SILENT ABSENCE. A web_enabled promotion with no
  -- rules is already invisible in the widget: widget_promotions (0186) filters
  -- it out, on the grounds that a promotion which cannot be presented honestly
  -- should be absent rather than broken on screen. Today the operator gets no
  -- signal at all; now they get one at the moment they cause it.
  if (coalesce(p_whatsapp_enabled, false) or coalesce(p_web_enabled, false))
     and nullif(btrim(coalesce(p_rules, '')), '') is null
     and not (
       (v_existing.whatsapp_enabled or v_existing.web_enabled)
       and nullif(btrim(coalesce(v_existing.rules, '')), '') is null
     )
  then
    raise exception 'a promotion that takes part by WhatsApp or on the website needs its rules'
      using errcode = '22023';
  end if;
```

> `v_existing` is this plan's name for whatever the live body already calls the record it reads for the promotion being updated. **Use the body's own variable** — if it reads columns individually rather than into a record, add the three it needs to that read rather than introducing a second select.

`create_promotion` gets the same test without the second half:

```sql
  -- The same rule with no previous row to compare against: a promotion cannot
  -- be BORN door-on and rules-blank. See update_promotion's comment for why the
  -- update case is a transition test instead.
  if (coalesce(p_whatsapp_enabled, false) or coalesce(p_web_enabled, false))
     and nullif(btrim(coalesce(p_rules, '')), '') is null
  then
    raise exception 'a promotion that takes part by WhatsApp or on the website needs its rules'
      using errcode = '22023';
  end if;
```

Then the drops, before the creates:

```sql
drop function if exists public.update_promotion(
  uuid, text, timestamptz, timestamptz, integer, text, boolean, integer, boolean,
  boolean, text, text, text, public.promotion_requested_field[], integer,
  boolean, text);
drop function if exists public.create_promotion(
  uuid, text, timestamptz, timestamptz, integer, text, boolean, integer, boolean,
  boolean, text, text, text, public.promotion_requested_field[], integer,
  boolean, text);
```

and the grants after, copying `0172:371-385`'s shape with the two new parameter types appended.

- [ ] **Step 5: Run it and watch it pass**

Run: `npm run db:reset && npm run db:test`
Expected: PASS, all seven assertions.

- [ ] **Step 6: Verify the ACL survived the drop**

This is the Block 24 defect and the reason this step exists as its own step:

```js
// same throwaway script shape as Step 1
"select proname, prosecdef, array_to_string(proacl, ' | ') from pg_proc where proname in ('create_promotion','update_promotion')"
```

Expected: both show `authenticated=X/postgres` and `prosecdef` true. A `NULL` acl means owner-only and every caller gets 42501. **Delete the throwaway script and confirm `git status --porcelain` is clean.**

- [ ] **Step 7: Regenerate the types**

Run: `npm run db:types && npm run typecheck`

- [ ] **Step 8: Commit**

```bash
git add supabase/migrations/0259_promotion_rules_gate.sql supabase/tests/71_promotion_rules_gate.test.sql src/lib/supabase/database.types.ts
git commit -m "feat(30c): the rules a promotion needs once a door is open"
```

---

### Task 3: The two fields reach the application

**Files:**
- Modify: `src/services/promotions.ts`, `src/schemas/promotions.ts`, `src/app/(app)/promotions/actions.ts`, `src/app/(app)/promotions/record.ts`, `tests/isolation/promotions.test.ts`, `scripts/verify-isolation-suite.mjs`

**Interfaces:**
- Consumes: the 19-parameter doors from Task 2.
- Produces: `PromotionDetail.authorizationCertificate: string | null`, `PromotionDetail.showId: string | null`, `PromotionDetail.showName: string | null`, `PromotionDetail.showArchived: boolean`; and both fields on the create/update input types.

- [ ] **Step 1: Write the failing isolation case**

Append to `tests/isolation/promotions.test.ts`, using that file's own fixture idiom:

```ts
  /**
   * Block 30c D2. The gate through a real caller, because update_promotion is
   * SECURITY DEFINER and pgTAP runs as the superuser — the pgTAP proves the
   * rule, this proves an operator meets it.
   *
   * The THIRD case is the one worth the fixture: a promotion already door-on
   * and rules-blank stays editable. A gate written as a state test rather than
   * a transition test passes the first two and fails this one, while looking
   * stricter and therefore better.
   */
  it('refuses to open a door with blank rules, and leaves an already-blank promotion editable', async () => {
    const label = `rules-gate-${Date.now()}`;
    const customer = await provisionCustomer(label);
    const owner = await signInAs(customer.email, customer.password);

    const clean = await createPromotionAs(customer, `${label} clean`);
    const opening = await owner.rpc('update_promotion', {
      p_promotion_id: clean,
      p_name: `${label} clean`,
      p_starts_at: new Date(Date.now() - 3600_000).toISOString(),
      p_ends_at: new Date(Date.now() + 86_400_000).toISOString(),
      p_web_enabled: true,
      p_rules: null,
    });
    expect(opening.error?.code).toBe('22023');

    // The grandfathered shape, written past the door because the door now
    // refuses to create it.
    const { data: legacy } = await admin
      .from('promotions')
      .insert({
        organization_id: customer.organizationId,
        company_id: customer.companyId,
        name: `${label} legacy`,
        starts_at: new Date(Date.now() - 3600_000).toISOString(),
        ends_at: new Date(Date.now() + 86_400_000).toISOString(),
        web_enabled: true,
      })
      .select('id')
      .single();

    const editing = await owner.rpc('update_promotion', {
      p_promotion_id: legacy!.id,
      p_name: `${label} legacy renamed`,
      p_starts_at: new Date(Date.now() - 3600_000).toISOString(),
      p_ends_at: new Date(Date.now() + 172_800_000).toISOString(),
      p_web_enabled: true,
      p_rules: null,
    });
    expect(editing.error).toBeNull();
  });
```

> **Two corrections to the snippet above, both verified — apply them rather than the snippet.**
>
> **`admin.from('promotions').insert(...)` will be refused.** `0044_rls_promotions.sql:35` grants `service_role` **select only** on `promotions` — there is no insert grant. Seed the grandfathered row through the harness's superuser path instead: `harness.ts:403` has a private `superuserStatement` and `:425` a `superuserQuery`, and `setPromotionPrizeDrawnDirectly` (`harness.ts:699`) is the exported wrapper to copy. Add a sibling in that shape rather than reaching for the admin client.
>
> `tests/isolation/promotions.test.ts` **does** exist. Read its own promotion fixture helper and use that name; this plan's `createPromotionAs` is a placeholder for whatever it already calls it. `ProvisionedCustomer.organizationId` exists (`harness.ts:33`), so that part of the snippet is correct as written.

- [ ] **Step 2: Run it and watch it fail**

Run: `npm run test:isolation`
Expected: FAIL — the first `expect` finds no error, because nothing refuses yet at this commit… **unless Task 2 has landed, in which case it passes.** If it passes immediately, say so in your report and move on: the case still earns its place as the live-caller proof and as the guard on the third scenario.

- [ ] **Step 3: Widen the service and the schema**

In `src/services/promotions.ts`, add to `PromotionDetail`:

```ts
  /** Free text, optional, not unique (0258). See its comment on the column for why. */
  authorizationCertificate: string | null;
  showId: string | null;
  /** Null when no Programme is linked, or when the caller cannot read it. */
  showName: string | null;
  /**
   * True once the linked Programme has been archived. The link is kept on
   * purpose (0258) — a promotion that ran inside a Programme ran inside it
   * whether or not it is still on air — so this is what lets the screen say
   * "archived" rather than imply it is still scheduled. Same shape and same
   * reason as RequestSummary.songArchived (services/music.ts).
   */
  showArchived: boolean;
```

Read the Programme through the existing select literal by embedding `shows(name, deleted_at)` — **one string literal, never a concatenation**, because supabase-js infers the row type from the literal at compile time.

Add both to the create/update input types and pass them to the RPCs as `p_authorization_certificate` and `p_show_id`.

In `src/schemas/promotions.ts`, add:

```ts
  /**
   * Alphanumeric as the operator transcribes it. Trimmed, capped, and NOT
   * pattern-checked: the format belongs to whoever issues the licence, and a
   * rule invented here would refuse a valid number from a state that writes
   * them differently.
   */
  authorizationCertificate: z.string().trim().max(60).optional(),
  showId: z.string().uuid().optional(),
```

- [ ] **Step 4: Raise the isolation floor**

In `scripts/verify-isolation-suite.mjs:434`, bump `minTests` for `tests/isolation/promotions.test.ts` from **21 to 22** — verified value, not an assumption. A case added without a floor bump can later be deleted for free.

- [ ] **Step 5: Run the gate, in order**

Run: `npm run typecheck && npm run lint && npm test && npm run db:reset && npm run db:test && npm run test:isolation`

- [ ] **Step 6: Commit**

```bash
git add src/services/promotions.ts src/schemas/promotions.ts src/app/\(app\)/promotions tests/isolation/promotions.test.ts scripts/verify-isolation-suite.mjs
git commit -m "feat(30c): the certificate and the programme travel to the screen"
```

---

### Task 4: The form

**Files:**
- Modify: `src/app/(app)/promotions/promotion-fields.tsx`, `src/app/(app)/promotions/whatsapp-fields.tsx`, `messages/{en,pt,es}.json`

**Interfaces:**
- Consumes: `PromotionDetail.authorizationCertificate`, `.showId`, `.showName`, `.showArchived` from Task 3.

- [ ] **Step 1: Add the catalogue keys**

Under `promotions` in all three catalogues. **Check each before adding.**

| key | en | pt | es |
|---|---|---|---|
| `authorizationCertificate` | Authorization certificate number | Número do certificado de autorização | Número del certificado de autorización |
| `optionalAsIssued` | Optional, exactly as it was issued | Opcional, exatamente como foi emitido | Opcional, tal como fue emitido |
| `programme` | Programme | Programa | Programa |
| `noProgramme` | No programme | Sem programa | Sin programa |
| `programmeArchived` | archived | arquivado | archivado |
| `rulesRequiredWhenADoorIsOpen` | The rules are required once entry by WhatsApp or on the website is on. | As regras passam a ser obrigatórias quando a participação por WhatsApp ou pelo site está ligada. | Las reglas son obligatorias cuando la participación por WhatsApp o por el sitio está activada. |

- [ ] **Step 2: Item 10 — the certificate takes the spacer's cell**

In `promotion-fields.tsx`, replace `<div className="hidden sm:block" aria-hidden="true" />` at `:85` with:

```tsx
        {/* Item 10. This cell held a spacer that existed only to keep the
            two-column grid aligned after Site integration code; the field the
            owner asked for goes exactly where the spacer was, which is what
            "to the right of Site integration code" means in a two-column grid. */}
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted-foreground">{t('authorizationCertificate')}</span>
          <Input
            name="authorizationCertificate"
            maxLength={60}
            defaultValue={record?.authorizationCertificate ?? ''}
            disabled={disabled}
            data-testid="promotion-certificate"
          />
          <span className="text-xs text-muted-foreground">{t('optionalAsIssued')}</span>
        </label>
```

- [ ] **Step 3: Item 16 — the ceiling beside the interval**

The two `{repeats && …}` labels at `:143` and `:181` sit in a `flex flex-col` box (`:126-196`), so they stack however short they are. Wrap **both** in one row:

```tsx
        {repeats && (
          <div className="flex flex-wrap gap-4">
            {/* … the interval label … */}
            {/* … the ceiling label … */}
          </div>
        )}
```

collapsing the two separate `{repeats && …}` guards into this one. `flex-wrap` so the two `w-64` fields drop to two rows on a narrow screen rather than overflowing.

**This also makes an existing comment true.** The block at `:161-162` already calls the ceiling *"the per-person ceiling (design spec D1), beside the interval it depends on"* — beside is what it has never been. Leave that sentence alone; it stops being false when the layout changes. Say so in your report.

- [ ] **Step 4: Item 17 — the Programme combobox**

Add it to `promotion-fields.tsx` beside the certificate. It lists the **live** Programmes of the promotion's own Station, plus — when the record's linked Programme is archived — that one, marked, so an existing choice can be kept but never newly made:

```tsx
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted-foreground">{t('programme')}</span>
          <Select
            name="showId"
            defaultValue={record?.showId ?? ''}
            disabled={disabled}
            data-testid="promotion-show"
          >
            <option value="">{t('noProgramme')}</option>
            {/*
              The archived one is offered ONLY when it is the record's own
              current choice: keeping a link that already exists is not the same
              as making a new one, and D3 keeps the link because a promotion
              that ran inside a Programme ran inside it whether or not the
              Programme is still on air.
            */}
            {record?.showArchived && record.showId && (
              <option value={record.showId}>
                {record.showName} — {t('programmeArchived')}
              </option>
            )}
            {shows.map((show) => (
              <option key={show.id} value={show.id}>
                {show.name}
              </option>
            ))}
          </Select>
        </label>
```

`shows` is a new prop on `PromotionFields`: `{ id: string; name: string }[]`, resolved by the page that renders the form from the Station already in scope. **Read how `promotions/page.tsx` and `promotion-record-dialog.tsx` obtain the Station** and follow it; do not resolve a second Station inside the component.

- [ ] **Step 5: Item 15 — the rules field says so before the door refuses**

In `whatsapp-fields.tsx`, the rules textarea becomes `required` when either checkbox is on, and the hint below it renders `t('rulesRequiredWhenADoorIsOpen')` in that state.

**The browser rule is a courtesy, not the boundary.** `0259` is the boundary and refuses regardless. Say that in the comment, and do **not** disable either checkbox to prevent the state — the operator must be able to see what they are being asked for.

- [ ] **Step 6: Prove it**

Run: `npm run typecheck && npm run lint && npm test`

- [ ] **Step 7: Commit**

```bash
git add src/app/\(app\)/promotions messages
git commit -m "feat(30c): the licence, the programme, and a ceiling that finally sits where its comment says"
```

---

### Task 5: Asking before discarding, and a menu that follows the errand

**Files:**
- Modify: `src/app/(app)/promotions/register-promotion-form.tsx`, `src/lib/auth/shell.ts`

- [ ] **Step 1: Item 13 — wire the dirty tracking that is already there**

`RegisterPromotionForm` passes `onDirty={() => undefined}` to both field groups; `PromotionRecordDialog` already does the whole thing at `:164` (`const [dirty, setDirty] = useState(false)`) and `:278`:

```tsx
    if (dirty && !window.confirm(t('discardTheChangesYouHaveNotSaved'))) return;
    onClose();
```

Add the same state to the register form, pass `setDirty`-style callbacks to both groups, and route **both** the Cancel button and the `Dialog`'s own `onClose` through one `requestClose`. Reuse the existing `promotions.discardTheChangesYouHaveNotSaved` — verified present, reading *"Discard the changes you have not saved?"*. **Do not add a second string for the same sentence.**

- [ ] **Step 2: Item 11 — move Programmes and reorder**

In `src/lib/auth/shell.ts`, remove `{ href: '/shows', label: t('programmes'), icon: ICONS.radio }` from the `catalog` section and add it to `promotions`, after Pickups. Final order: Promotions, Participations, Pickups, Programmes.

Replace the Block-27 comment that argued for filing it under Catalog — **it becomes false the moment this moves, and leaving it beside the item it no longer describes is the defect class this project has closed twelve times.** The replacement records:

- the owner's ruling of 2026-08-19;
- that this is the screen's **third** section in eighteen blocks (Audience in 18, Catalog in 27, here now);
- that the permission does **not** move with it: `shows` carries one policy gated on `music.view`, so a member who administers promotions and holds nothing in music sees the link and finds nothing behind it;
- and why that is not fixed here — a `shows.view` pair is a permissions migration plus every role a customer has already configured, none of which would grant it, so the screen would hide from everyone; and re-gating on `promotions.view` takes it from whoever administers the catalogue and has it today.

`ICONS.radio` travels with it and collides with nothing — verified: the `promotions` section holds `megaphone`, `ticket` and `box`, and the file's own convention only forbids a repeat on **adjacent rows of the same section** (`pickups`' reuse of `ICONS.box` relies on exactly that distinction, and says so).

- [ ] **Step 3: Prove it**

Run: `npm run typecheck && npm run lint && npm test`

- [ ] **Step 4: Commit**

```bash
git add src/app/\(app\)/promotions/register-promotion-form.tsx src/lib/auth/shell.ts
git commit -m "feat(30c): a half-written promotion asks before it goes, and Programmes joins the errand it belongs to"
```

---

### Task 6: The journey, and the documents

**Files:**
- Create: `tests/e2e/promotion-rules-gate.spec.ts`
- Modify: `docs/DATABASE.md`, `docs/PERMISSIONS.md`

- [ ] **Step 1: Write the journey**

One journey, following a neighbouring spec's sign-in and seeding idiom:

1. Open the promotions screen, press Register, type a name, dismiss the dialog — assert the confirmation appears and that dismissing it keeps the dialog open.
2. Register a promotion properly, open its record, turn on website entry with the rules empty, save — assert the refusal names the rules.
3. Fill the rules, save, assert it saves.
4. Set the certificate and a Programme, save, reopen, assert both read back.

Step 2 is the one that carries the block. Assert the **message**, not merely that a save failed — a refusal for the wrong reason would pass a bare failure check.

- [ ] **Step 2: Run it**

Run: `npm run db:reset && npm run seed:branding && npm run test:e2e -- promotion-rules-gate`

> A first Playwright run can fail on a cold Next compile rather than an assertion — read the failure before concluding. A stale `next dev` holding the port answers 500s that look like a broken build; kill the **server** process, not a task wrapper.

- [ ] **Step 3: Document the two columns and the permission cost**

In `docs/DATABASE.md`, record `authorization_certificate` (free text, optional, deliberately not unique, never format-checked) and `show_id` (optional, composite FK, survives archiving, and why).

In `docs/PERMISSIONS.md`, update the section headed *"Programmes are gated on music, not on the audience (Block 18)"* — it names the section the screen used to live in and is now doubly stale. Record the move, that the permission still does not follow, and both fixes that were considered and why neither is this block.

- [ ] **Step 4: Run the whole gate, in order**

Run: `npm run typecheck && npm run lint && npm test && npm run db:reset && npm run db:test && npm run test:isolation && npm run seed:branding && npm run test:e2e`

Run the e2e suite **whole and once**. If a command is auto-backgrounded, stop and report `NEEDS_CONTEXT` naming it.

- [ ] **Step 5: Commit**

```bash
git add tests/e2e/promotion-rules-gate.spec.ts docs/DATABASE.md docs/PERMISSIONS.md
git commit -m "test(30c): the door that refuses, and the promotion that stays editable"
```

---

## What this plan does not do, on purpose

- **No `shows.view` permission.** Recorded as debt in Task 5 and in `docs/PERMISSIONS.md`; it is a permissions migration touching every configured role.
- **No uniqueness on the certificate.** Owner's ruling, and the column's own comment says why.
- **No use of `show_id` in any query.** Block 30e's item 18 is what reads it.
- **No report of promotions currently door-on and rules-blank.** The gate cannot repair what exists; a listing is a reasonable follow-up and is not this block.
