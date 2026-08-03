# Block 6b — Handing the prize over, and taking it back — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An operator hands a prize over, undoes that when it was recorded wrong, or takes the unit back to stock or to a write-off — and every one of those moves the ledger, writes its own history row, and can be told apart from the others by whoever reads the record later.

**Architecture:** Four doors, each checking its own permission beside its own operation, delegating to one private core (`apply_winner_transition`) that validates the transition against a fixed table, emits the ledger movements through `apply_inventory_movement`, writes the status, writes one history row and one audit row — all in the transaction that moves the stock. The receipt is attached **after** the delivery is already recorded, so storage can never block a handover that physically happened.

**Tech Stack:** Supabase Postgres 17 (plpgsql, RLS, Supabase Storage), Next.js App Router server actions, TypeScript strict, Zod, Vitest, pgTAP, Playwright, the isolation harness in `tests/isolation/harness.ts`.

**Spec:** `docs/superpowers/specs/2026-08-02-block-6b-delivery-design.md`. Read it before Task 1. Decision references (D1–D6) point at its §2.

## Global Constraints

- **Everything in English** — code, comments, identifiers, commit messages. The only Portuguese is what an operator or a listener reads on screen.
- **Vocabulary:** `Station` = a `companies` row, `Organization` = an `organizations` row, `Member`/listener = a `members` row.
- **Migrations are sequential. The next free number is `0081`.** Never edit a migration applied outside a local stack; within this unmerged branch, editing in place is sanctioned with a clean `supabase db reset` as the proof.
- **Every gate is checked beside its own operation**, never inside a shared helper. Private cores are `SECURITY INVOKER` with EXECUTE granted to nobody — the pattern `apply_participation` (0054), `participation_status_for` (0069) and `apply_draw` (0078) established.
- **`service_role` needs an explicit grant on every new table**, and `authenticated` needs one for anything a screen reads. This schema revokes Supabase's default ACL and grants back by hand. Block 5a shipped three tables with the comment and without the grant and was non-functional end to end.
- **The ledger has one writer.** Inventory moves only through `apply_inventory_movement` (0027/0047/0077). No table this block adds may write `inventory_movements`, `inventory_balances` or `promotion_prize_balances` directly.
- **A movement type that reaches `project_promotion_prize_movement` (0077) without an explicit branch raises `XX000`.** That is a tripwire, not an accident: every one of this block's five types needs a branch, and the four that change nothing need one that says so.
- **No personal data in `audit_logs`.** Block 3's rule, absolute. A transition's audit row carries ids and statuses, never a name or a phone.
- **The gate before every commit:** `npm run lint && npm run typecheck && npm test`, plus `npm run db:test` when SQL changes. On `npm run test:isolation` only a **guard-complete** run counts.
- **After `supabase db reset`, the auth container answers `createUser failed: {}` until the stack is restarted.** Run `npx supabase stop && npx supabase start` before any isolation or Playwright run that follows a reset. This cost twenty minutes in Block 6a.
- **Commit messages** end with `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.
- **This repo sets `noUncheckedIndexedAccess`.** In tests `toBe(v)`/`toEqual(v)`/`toBeNull()` are safe with optional chaining; `toBeUndefined()`/`toBeFalsy()` can pass vacuously on an empty array.
- **Branch:** `block-6b`, cut from `block-6a` because migrations `0075`–`0080` are unmerged.

---

## File Structure

**New migrations**

| File | Responsibility |
|---|---|
| `supabase/migrations/0081_delivery_tables.sql` | `winner_status_history`; the three receipt columns; `winners (id, company_id)` unique; the four permission codes |
| `supabase/migrations/0082_delivery_ledger.sql` | `DELIVERY_CANCEL` in the movement enum and the transition check; the promotion-reference check widened; `project_promotion_prize_movement` taught all five types |
| `supabase/migrations/0083_deliver_prize.sql` | `apply_winner_transition` (private), `deliver_prize`, `cancel_delivery` |
| `supabase/migrations/0084_return_prize.sql` | `return_prize`, `write_off_prize` |
| `supabase/migrations/0085_delivery_receipts.sql` | the private bucket, its `storage.objects` policies, `attach_delivery_receipt` |
| `supabase/migrations/0086_storage_erasure.sql` | `storage_erasure_queue`; `anonymize_member` extended to clear and enqueue |

**New TypeScript**

| File | Responsibility |
|---|---|
| `src/services/winners.ts` | `deliverPrize`, `cancelDelivery`, `returnPrize`, `writeOffPrize`, `attachDeliveryReceipt`, `signReceiptUrl` |
| `src/lib/storage/erasure.ts` | `drainStorageErasures` — the worker's half of the erasure |
| `src/components/draws/winner-actions.tsx` | the four buttons and their rules, with the pure validator exported |
| `tests/unit/winner-actions.test.ts` | the validator's cases |
| `supabase/tests/10_delivery.test.sql` | this block's pgTAP |

**Modified**

| File | Change |
|---|---|
| `src/app/api/worker/tick/route.ts` | drains the erasure queue alongside the conversation tick |
| `src/components/draws/draw-detail.tsx` | each winner gains its actions and its receipt |
| `src/app/(app)/promotions/[id]/draws/actions.ts` | the four server actions and the upload |
| `src/lib/supabase/database.types.ts` | regenerated after every migration |
| `tests/isolation/draw.test.ts` | the boundary and concurrency cases for the new tables |
| `scripts/verify-isolation-suite.mjs` | the raised floor |

**Fixture UUID range:** `…00b0xx`–`…00b9xx`. `09_draws.test.sql` owns `…00a0xx`–`…00a3xx`; check before writing.

---

### Task 1: The history, the receipt columns, and who may do what

**Files:**
- Create: `supabase/migrations/0081_delivery_tables.sql`
- Create: `supabase/tests/10_delivery.test.sql`

**Interfaces:**
- Produces: table `public.winner_status_history`; columns `winners.receipt_path`, `winners.receipt_uploaded_at`, `winners.receipt_erased_at`; constraint `winners_id_company_unique`; permission codes `winners.deliver`, `winners.deliver_cancel`, `winners.return`, `winners.write_off`.

- [ ] **Step 1: Write the failing pgTAP file**

Create `supabase/tests/10_delivery.test.sql` beginning `begin; select plan(N);` — write the assertions first and set `N` to the number you actually wrote, not to an estimate. Assert, in this order:

1. `winner_status_history` exists, and RLS is enabled on it.
2. `authenticated` holds `SELECT` on it; neither `anon` nor `authenticated` holds `TRUNCATE`; `service_role` holds `SELECT, INSERT`.
3. `winners` has all three receipt columns (`has_column`).
4. All four permission codes are in `public.permissions` (one assertion, `count(*) = 4`).
5. A `winner_status_history` row whose `to_status` is not `DELIVERED` and whose `reason` is blank is refused (`throws_ok`, `23514`) — the CHECK from spec §3.2.
6. A row whose `to_status` is `DELIVERED` and whose `reason` is null is accepted (`lives_ok`) — the asymmetry is the point.
7. A `winners` row carrying both `receipt_path` and `receipt_erased_at` is refused (`23514`).

Seed fixtures in the `…00b0xx` range: an Organization, a Station, a promotion, a prize, a linked prize, a member with a company link, a participation, a draw and one winner. You will need that winner in every task below, so write the fixture block as the file's own opening section with a comment saying so.

- [ ] **Step 2: Run it to make sure it fails**

Run: `npm run db:test`
Expected: FAIL — `relation "public.winner_status_history" does not exist`.

- [ ] **Step 3: Write the migration**

`0081_delivery_tables.sql`, in this order:

1. The composite key the history needs, the same one-line addition `prizes` (0025:77), `promotions` (0040:177) and `participations`/`promotion_prizes` (0075) already carry:

```sql
alter table public.winners
  add constraint winners_id_company_unique unique (id, company_id);
```

2. The receipt columns:

```sql
alter table public.winners
  add column receipt_path        text,
  add column receipt_uploaded_at timestamptz,
  add column receipt_erased_at   timestamptz,
  -- A receipt cannot be both present and erased. receipt_erased_at is what
  -- makes "never had one" different from "had one, and it is gone" (spec 3.1).
  add constraint winners_receipt_shape check (
    receipt_erased_at is null or receipt_path is null
  );
```

3. The history:

```sql
create table public.winner_status_history (
  id          uuid primary key default gen_random_uuid(),
  winner_id   uuid not null,
  company_id  uuid not null,
  from_status public.winner_status not null,
  to_status   public.winner_status not null,
  reason      text,
  changed_by  uuid references auth.users (id),
  changed_at  timestamptz not null default now(),

  constraint winner_status_history_winner_fk
    foreign key (winner_id, company_id)
    references public.winners (id, company_id),

  -- Mandatory on the three transitions that undo or destroy something somebody
  -- has already been told about; optional on the one that was supposed to
  -- happen. Handing a prize to the person who won it needs no justification.
  constraint winner_status_history_reason_shape check (
    to_status = 'DELIVERED' or length(btrim(coalesce(reason, ''))) > 0
  )
);

create index winner_status_history_winner_idx
  on public.winner_status_history (winner_id, changed_at desc);
```

4. RLS, a `select` policy for `authenticated` on `has_permission('promotions.view', company_id)` — reading a winner's history is reading a promotion — and the grants: `revoke all` from `anon, authenticated`; `revoke truncate` from `service_role`; `grant select` to `authenticated`; `grant select, insert` to `service_role`.

5. The permissions. Check `0075`'s insert for the exact column set and copy its `module`/`scope` vocabulary; `display_order` 70 and 80 are taken by the draw codes, so these are 90–120:

```sql
insert into public.permissions
  (code, description, introduced_by_block, module, label, scope, display_order)
values
  ('winners.deliver',        'Record that a prize was handed over',      '6b', 'promotions', 'Deliver a prize',        'company', 90),
  ('winners.deliver_cancel', 'Undo a delivery recorded by mistake',      '6b', 'promotions', 'Undo a delivery',        'company', 100),
  ('winners.return',         'Return an uncollected prize to stock',     '6b', 'promotions', 'Return a prize to stock','company', 110),
  ('winners.write_off',      'Write off a prize that will not come back','6b', 'promotions', 'Write off a prize',      'company', 120);
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run db:reset && npm run db:test`

- [ ] **Step 5: Regenerate types, run the gate, commit**

```bash
npm run db:types
npm run lint && npm run typecheck && npm test
git add supabase/migrations/0081_delivery_tables.sql supabase/tests/10_delivery.test.sql src/lib/supabase/database.types.ts
git commit -m "feat(delivery): the history, and a reason where a reason is owed

winner_status_history requires a reason on every transition except the one
that was supposed to happen. Handing a prize to the person who won it needs
no justification; undoing, returning and writing off each undo or destroy
something somebody has already been told about, and a row that does not say
why is the one thing those must say.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: Teaching the ledger the other five movements

**Files:**
- Create: `supabase/migrations/0082_delivery_ledger.sql`
- Modify: `supabase/tests/10_delivery.test.sql`, `supabase/tests/04_promotion_prizes.test.sql`

**Interfaces:**
- Consumes: `project_promotion_prize_movement(uuid, public.inventory_movement_type, integer)` (0077).
- Produces: `DELIVERY_CANCEL` in `public.inventory_movement_type`; the widened `inventory_movements_legal_transition` and `inventory_movements_promotion_reference`; the five new branches in the projection.

**Read `supabase/migrations/0077_draw_ledger.sql` in full before writing this.** It is the file this one extends, and its header explains why the projection was lifted out of `apply_inventory_movement` in the first place: so that this task is four branches rather than a 180-line function restated.

- [ ] **Step 1: Write the failing tests**

Append to `10_delivery.test.sql`, raising the plan. For each of the five types, call `apply_inventory_movement` directly (as `postgres`, which pgTAP already is) against the Task 1 fixture and assert what happens to `promotion_prize_balances`:

| Movement | buckets | `linked` after | `drawn` after |
|---|---|---|---|
| `DELIVERY` | `awaiting_pickup → delivered` | unchanged | unchanged |
| `DELIVERY_CANCEL` | `delivered → awaiting_pickup` | unchanged | unchanged |
| `RETURN_PENDING` | `awaiting_pickup → pending_return` | unchanged | unchanged |
| `RETURN_TO_STOCK` | `pending_return → available` | **−1** | **−1** |
| `WRITE_OFF` | `awaiting_pickup → written_off` | unchanged | unchanged |

Set the fixture up so the figures start at `linked = 2, drawn = 1` and assert the exact pair after each call, not just the one that moves. A test that asserts only the changed figure cannot catch a branch that changes both when it should change neither.

Also assert `'DELIVERY_CANCEL' = any(enum_range(null::public.inventory_movement_type)::text[])`.

- [ ] **Step 2: Run them to make sure they fail**

Run: `npm run db:test`
Expected: FAIL — `new row for relation "inventory_movements" violates check constraint "inventory_movements_promotion_reference"` on the first `DELIVERY`.

- [ ] **Step 3: Write the migration**

```sql
alter type public.inventory_movement_type add value 'DELIVERY_CANCEL' after 'DELIVERY';
```

**This must be its own statement, and nothing in this migration may use the new value.** Postgres refuses to use an enum value added in the same transaction; put the constraint and function changes in a second migration file if the reset complains, and say so in a comment rather than working around it silently.

Then widen both checks — drop and re-add, the shape 0077 used:

```sql
alter table public.inventory_movements
  drop constraint inventory_movements_legal_transition;

alter table public.inventory_movements
  add constraint inventory_movements_legal_transition check (
    -- every arm 0026 and 0077 already carried, unchanged, plus:
    (movement_type = 'DELIVERY_CANCEL'
       and from_bucket = 'delivered' and to_bucket = 'awaiting_pickup')
    or ...
  );
```

Copy the existing arms verbatim from `0026_inventory_ledger.sql` rather than retyping them from memory — an arm dropped by accident here silently legalises nothing and illegalises a movement some other block depends on.

Widen `inventory_movements_promotion_reference` to admit the whole set: `PROMOTION_LINK`, `PROMOTION_UNLINK`, `DRAW`, `DRAW_CANCEL`, `DELIVERY`, `DELIVERY_CANCEL`, `RETURN_PENDING`, `RETURN_TO_STOCK`, `WRITE_OFF`.

Then `create or replace function public.project_promotion_prize_movement` with the five new branches. The four no-ops are **explicit**:

```sql
  elsif p_type in ('DELIVERY', 'DELIVERY_CANCEL', 'RETURN_PENDING', 'WRITE_OFF') then
    -- Deliberately nothing. These four move a unit between buckets without
    -- changing what the PROMOTION spent: `linked` counts units the promotion
    -- took from stock and has not given back, and a prize that was handed over
    -- or written off was spent BY the promotion. Written as a branch rather
    -- than left to the else, because the else raises XX000 on purpose and a
    -- silent fallthrough is exactly the failure that tripwire exists to catch.
    null;
  elsif p_type = 'RETURN_TO_STOCK' then
    -- The one that does change them: the unit leaves the promotion for general
    -- stock, so it is neither linked nor drawn any more. Without both
    -- decrements it would be counted twice — once in `available` and once in
    -- this promotion's Resto.
    update public.promotion_prize_balances
       set linked = linked - p_quantity,
           drawn  = drawn  - p_quantity,
           updated_at = now()
     where promotion_prize_id = p_promotion_prize_id;
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run db:reset && npm run db:test`

- [ ] **Step 5: Move the Block 6b tripwire**

`04_promotion_prizes.test.sql` reaches the `XX000` branch through `MANUAL_ENTRY` (Block 6a moved it there from `DRAW`). `MANUAL_ENTRY` is still unknown to the projection after this task, so **that test should still pass untouched** — confirm it does, and do not change it. If it fails, you have admitted a type to `inventory_movements_promotion_reference` that this block does not emit.

- [ ] **Step 6: Mutation-prove the decrements**

Remove `drawn = drawn - p_quantity` from the `RETURN_TO_STOCK` branch, re-run, and confirm the `RETURN_TO_STOCK` figures case goes red and nothing else does. Restore byte-identical and report both outputs.

- [ ] **Step 7: Run the gate and commit**

```bash
npm run db:types
npm run lint && npm run typecheck && npm test && npm run db:test
git add supabase/migrations/0082_delivery_ledger.sql supabase/tests/10_delivery.test.sql src/lib/supabase/database.types.ts
git commit -m "feat(delivery): the ledger learns the other five movements

Four of them change nothing about what the promotion spent, and each says so
in its own branch. The else still raises XX000, which is the whole reason
0077 lifted this projection out of the ledger's single writer.

RETURN_TO_STOCK decrements both linked and drawn, because a unit that goes
back to general stock would otherwise be counted twice: once in available and
once in the promotion's Resto.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: Delivering, and undoing a delivery

**Files:**
- Create: `supabase/migrations/0083_deliver_prize.sql`
- Modify: `supabase/tests/10_delivery.test.sql`

**Interfaces:**
- Consumes: `apply_inventory_movement(p_company_id, p_prize_id, p_type, p_quantity, p_from, p_to, p_note, p_idempotency_key, p_promotion_prize_id)` (0047/0077).
- Produces:
  - `public.apply_winner_transition(p_winner_id uuid, p_to public.winner_status, p_reason text) returns void`, `SECURITY INVOKER`, EXECUTE to nobody;
  - `public.deliver_prize(p_winner_id uuid, p_note text default null) returns void`, `SECURITY DEFINER`, EXECUTE to `authenticated`;
  - `public.cancel_delivery(p_winner_id uuid, p_reason text) returns void`, `SECURITY DEFINER`, EXECUTE to `authenticated`.

- [ ] **Step 1: Write the failing tests**

Append, raising the plan. Cover, each with its own winner so a failure names one rule:

- delivering an `AWAITING_PICKUP` winner sets `DELIVERED`, writes one `DELIVERY` movement, and writes one history row whose `from_status` is `AWAITING_PICKUP`;
- delivering with a null note succeeds (D1's asymmetry, and the CHECK from Task 1);
- delivering a winner that is already `DELIVERED` is refused (`22023`) and names the status it is in;
- a caller without `winners.deliver` gets `42501`;
- cancelling a delivery sets `AWAITING_PICKUP`, writes one `DELIVERY_CANCEL` movement and a second history row;
- **cancelling does not touch `deadline_at`** — read it before and after and assert equality (D4);
- cancelling with a blank reason is refused (`22023`);
- cancelling a winner that is not `DELIVERED` is refused (`22023`);
- a caller holding `winners.deliver` but not `winners.deliver_cancel` gets `42501`;
- after a delivery and its cancellation, `promotion_prize_balances` is exactly where it started.

You will need two operator fixtures: one holding all four codes plus `promotions.view`, one holding only `winners.deliver` plus `promotions.view`. Copy the role/`role_permissions`/`auth.users`/`company_memberships` shape from `09_draws.test.sql`'s Task 4 section.

- [ ] **Step 2: Run them to make sure they fail**

Run: `npm run db:test`
Expected: FAIL — `function public.deliver_prize(uuid, unknown) does not exist`.

- [ ] **Step 3: Write the migration**

The core first. It takes `FOR UPDATE` on the winner, validates against the transition table, emits the movements, writes the status, the history row and the audit row:

```sql
create function public.apply_winner_transition(
  p_winner_id uuid,
  p_to        public.winner_status,
  p_reason    text
)
returns void
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  v_actor   uuid := auth.uid();
  v_from    public.winner_status;
  v_company uuid;
  v_org     uuid;
  v_link    uuid;
  v_prize   uuid;
  v_reason  text := nullif(btrim(coalesce(p_reason, '')), '');
  v_allows  boolean;
begin
  -- FOR UPDATE before anything is decided, so two operators acting on one
  -- winner cannot both read the same status and both act on it.
  select w.status, w.company_id, d.organization_id, w.promotion_prize_id, l.prize_id,
         pz.allows_return_to_stock
    into v_from, v_company, v_org, v_link, v_prize, v_allows
  from public.winners w
  join public.draws d on d.id = w.draw_id
  join public.promotion_prizes l on l.id = w.promotion_prize_id
  join public.prizes pz on pz.id = l.prize_id
  where w.id = p_winner_id
    for update of w;

  if not found then
    raise exception 'winner not found: %', p_winner_id using errcode = 'P0002';
  end if;

  if p_to <> 'DELIVERED' and v_reason is null then
    raise exception 'this change needs a reason' using errcode = '22023';
  end if;
  ...
```

Then one `if` per legal transition, each raising `22023` naming both statuses when the `from` does not match, and each issuing its movements with `p_idempotency_key = p_winner_id || ':' || p_to || ':' || <a counter or the history row id>`. **Read `0079_cancel_draw.sql` for the idempotency-key shape before choosing one**, and make sure a winner delivered, undone and delivered again does not collide with its own first key — that is the case a naive `winner_id || ':DELIVERED'` gets wrong.

The two doors are thin: check the permission, then delegate.

```sql
create function public.deliver_prize(p_winner_id uuid, p_note text default null)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare v_company uuid;
begin
  select company_id into v_company from public.winners where id = p_winner_id;
  if not found then
    raise exception 'winner not found: %', p_winner_id using errcode = 'P0002';
  end if;
  if not public.has_permission('winners.deliver', v_company) then
    raise log 'deliver_prize denied: actor=% winner=%', auth.uid(), p_winner_id;
    raise exception 'permission denied: winners.deliver required' using errcode = '42501';
  end if;
  perform public.apply_winner_transition(p_winner_id, 'DELIVERED', p_note);
end;
$$;
```

`cancel_delivery` is the same shape against `winners.deliver_cancel` and `'AWAITING_PICKUP'`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run db:reset && npm run db:test`

- [ ] **Step 5: Mutation-prove the lock**

Remove `for update of w` and confirm Task 8's concurrency case fails. It does not exist yet, so **record this as owed** and do it in Task 8 — do not claim it here. Block 6a made exactly this mistake and had to carry the debt for four tasks.

- [ ] **Step 6: Run the gate and commit**

```bash
npm run db:types
npm run lint && npm run typecheck && npm test && npm run db:test
git add supabase/migrations/0083_deliver_prize.sql supabase/tests/10_delivery.test.sql src/lib/supabase/database.types.ts
git commit -m "feat(delivery): the handover, and the undo that mirrors it

A delivery recorded against the wrong winner is a certainty, not a
hypothetical, and correcting it with a stock adjustment would fix the count
and leave the winner's row saying DELIVERED for ever -- which is the row
somebody reads when the listener telephones.

Undoing does not touch deadline_at. It was frozen at the draw and the
delivery never moved it, so a winner whose deadline passed comes back
overdue, which is true.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: Returning to stock, and writing off

**Files:**
- Create: `supabase/migrations/0084_return_prize.sql`
- Modify: `supabase/tests/10_delivery.test.sql`

**Interfaces:**
- Consumes: `apply_winner_transition` (Task 3).
- Produces: `public.return_prize(p_winner_id uuid, p_reason text)` and `public.write_off_prize(p_winner_id uuid, p_reason text)`, both `SECURITY DEFINER`, EXECUTE to `authenticated`.

- [ ] **Step 1: Write the failing tests**

- returning an `AWAITING_PICKUP` winner sets `RETURNED`, writes **two** movements (`RETURN_PENDING` then `RETURN_TO_STOCK`), and puts the unit back in `available`;
- and drops the promotion's `linked` and `drawn` by one each;
- returning a prize whose `allows_return_to_stock` is false is refused (`22023`) and the message names the prize;
- writing that same prize off succeeds and sets `WRITTEN_OFF`;
- writing off writes one `WRITE_OFF` movement and leaves `linked`/`drawn` alone;
- returning or writing off a `DELIVERED` winner is refused (`22023`);
- a blank reason is refused on both (`22023`);
- `winners.return` does not grant `winners.write_off` (`42501`), and vice versa.

Seed a second prize with `allows_return_to_stock = false` — `create_prize` (0027) takes `p_allows_return_to_stock`.

- [ ] **Step 2: Run them to make sure they fail**

- [ ] **Step 3: Write the migration**

Both doors are the Task 3 shape. The `allows_return_to_stock` refusal lives in the **core**, beside the transition it governs, not in the door — it is a fact about the prize and not about the caller:

```sql
  elsif p_to = 'RETURNED' then
    if v_from <> 'AWAITING_PICKUP' then
      raise exception 'a prize that is % cannot be returned to stock', v_from
        using errcode = '22023';
    end if;
    if not v_allows then
      raise exception
        'this prize is marked as one that cannot go back to stock; write it off instead'
        using errcode = '22023';
    end if;
```

- [ ] **Step 4: Run the tests to verify they pass**

- [ ] **Step 5: Mutation-prove the `allows_return_to_stock` refusal**

Remove the `if not v_allows` block, re-run, and confirm **only** that case goes red. Restore byte-identical and report both outputs. This is the column's first reader in the whole schema; if the test does not fail, it is not testing it.

- [ ] **Step 6: Run the gate and commit**

```bash
npm run lint && npm run typecheck && npm test && npm run db:test
git add supabase/migrations/0084_return_prize.sql supabase/tests/10_delivery.test.sql
git commit -m "feat(delivery): back to stock, or written off, and the prize decides which

allows_return_to_stock has sat unread since 0025 registered it as deliberate
debt. This is its first reader: a prize marked as one that cannot go back is
refused with a sentence naming it, and write-off is the only exit.

The refusal lives in the core beside the transition it governs rather than in
the door, because it is a fact about the prize and not about the caller.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: The receipt

**Files:**
- Create: `supabase/migrations/0085_delivery_receipts.sql`
- Modify: `supabase/tests/10_delivery.test.sql`

**Interfaces:**
- Produces: bucket `delivery-receipts`; policies on `storage.objects`; `public.attach_delivery_receipt(p_winner_id uuid, p_path text) returns void`, `SECURITY DEFINER`, EXECUTE to `authenticated`.

- [ ] **Step 1: Write the failing tests**

- the bucket exists and is **not public** (`select public from storage.buckets where id = 'delivery-receipts'` is false);
- `attach_delivery_receipt` sets `receipt_path` and `receipt_uploaded_at`;
- attaching to a winner that is not `DELIVERED` is refused (`22023`);
- attaching when a receipt is already present is refused (`22023`) — spec §3.1's one-slot rule;
- attaching a path whose first segment is not the winner's `company_id` is refused (`22023`);
- a caller without `winners.deliver` gets `42501`;
- the `storage.objects` policies exist for the bucket (count them in `pg_policies`).

- [ ] **Step 2: Run them to make sure they fail**

- [ ] **Step 3: Write the migration**

```sql
insert into storage.buckets (id, name, public)
values ('delivery-receipts', 'delivery-receipts', false)
on conflict (id) do nothing;
```

Paths are `<company_id>/<winner_id>/<uuid><ext>`, so a policy can decide from the path alone:

```sql
create policy delivery_receipts_read
  on storage.objects for select to authenticated
  using (
    bucket_id = 'delivery-receipts'
    and public.has_permission('promotions.view',
          ((storage.foldername(name))[1])::uuid)
  );

create policy delivery_receipts_write
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'delivery-receipts'
    and public.has_permission('winners.deliver',
          ((storage.foldername(name))[1])::uuid)
  );
```

`storage.foldername('a/b/c.png')` returns `{a,b}`, so `[1]` is the Station. Verify that in psql before relying on it — a policy that reads the wrong element is a policy that admits the wrong Station, and it will not announce itself.

`attach_delivery_receipt` checks `winners.deliver`, refuses a winner that is not `DELIVERED`, refuses a second receipt, and refuses a path whose first segment is not the winner's own `company_id`.

- [ ] **Step 4: Run the tests, run the gate, commit**

---

### Task 6: Making the erasure true

**Files:**
- Create: `supabase/migrations/0086_storage_erasure.sql`, `src/lib/storage/erasure.ts`
- Modify: `src/app/api/worker/tick/route.ts`, `supabase/tests/10_delivery.test.sql`

**Interfaces:**
- Produces: table `public.storage_erasure_queue`; `anonymize_member` extended; `drainStorageErasures(client): Promise<{ deleted: number; failed: number }>`.

**Read `0034_member_rpcs.sql`'s `anonymize_member` in full before editing it.** It is Block 3's erasure and it carries a long comment describing exactly what it promises; that comment has to grow with the behaviour or it becomes a lie.

- [ ] **Step 1: Write the failing tests**

pgTAP: `storage_erasure_queue` exists, RLS on, no policy, `service_role` holds `select, insert, update` and not `truncate`; `anonymize_member` on a member holding a receipt nulls `receipt_path`, stamps `receipt_erased_at`, and leaves **exactly one** queue row naming that path; the `DELIVERY` movement and its actor survive.

- [ ] **Step 2: Run them to make sure they fail**

- [ ] **Step 3: Write the migration**

```sql
create table public.storage_erasure_queue (
  id           uuid primary key default gen_random_uuid(),
  bucket       text not null,
  path         text not null,
  enqueued_at  timestamptz not null default now(),
  processed_at timestamptz,
  attempts     integer not null default 0,
  last_error   text
);
```

RLS on, no policy — a system table, the shape `whatsapp_conversations` (0065) uses. `grant select, insert, update` to `service_role`; `revoke truncate`.

Then `create or replace function public.anonymize_member` with the whole existing body plus, before the audit row:

```sql
  -- D5. The object cannot be deleted from SQL: removing the storage.objects row
  -- takes the metadata and leaves the file in the backing store, so an erasure
  -- written here alone would be half an erasure that looked whole. The queue is
  -- written in the SAME transaction as the clearing, so the intent cannot
  -- survive without the instruction.
  insert into public.storage_erasure_queue (bucket, path)
  select 'delivery-receipts', w.receipt_path
  from public.winners w
  where w.member_id = p_member_id and w.receipt_path is not null;

  update public.winners
     set receipt_path = null, receipt_erased_at = now()
   where member_id = p_member_id and receipt_path is not null;
```

Order matters: the `insert ... select` must run **before** the `update` that nulls the column it reads.

- [ ] **Step 4: Write the worker's half**

`src/lib/storage/erasure.ts`:

```ts
import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/supabase/database.types';

/** One tick's worth. Bounded so a large backlog cannot hold the tick open. */
const BATCH = 50;

export async function drainStorageErasures(
  client: SupabaseClient<Database>,
): Promise<{ deleted: number; failed: number }> {
  const { data, error } = await client
    .from('storage_erasure_queue')
    .select('id, bucket, path, attempts')
    .is('processed_at', null)
    .order('enqueued_at')
    .limit(BATCH);
  if (error) throw new Error(`could not read the erasure queue: ${error.message}`);

  let deleted = 0;
  let failed = 0;
  for (const row of data ?? []) {
    const removal = await client.storage.from(row.bucket).remove([row.path]);
    if (removal.error) {
      failed += 1;
      await client
        .from('storage_erasure_queue')
        .update({ attempts: row.attempts + 1, last_error: removal.error.message })
        .eq('id', row.id);
      continue;
    }
    deleted += 1;
    await client
      .from('storage_erasure_queue')
      .update({ processed_at: new Date().toISOString(), last_error: null })
      .eq('id', row.id);
  }
  return { deleted, failed };
}
```

A row that keeps failing is left queued and visible. **Do not add a give-up threshold** — an erasure that quietly stopped trying is the one failure this whole mechanism exists to prevent.

Call it from `src/app/api/worker/tick/route.ts` beside `runTick`, and include its counts in the response body so a failing drain is visible in the tick's own log.

- [ ] **Step 5: The claim is about the file, not the row**

Add to `tests/isolation/draw.test.ts`: deliver a prize, attach a real object through the storage API, anonymise the member, run `drainStorageErasures`, then assert **the object is gone from the bucket** — download it and expect a failure. Asserting the queue row was written proves the mechanism; only this proves the promise.

- [ ] **Step 6: Run the gate and commit**

---

### Task 7: The screen

**Files:**
- Create: `src/services/winners.ts`, `src/components/draws/winner-actions.tsx`, `tests/unit/winner-actions.test.ts`
- Modify: `src/components/draws/draw-detail.tsx`, `src/app/(app)/promotions/[id]/draws/actions.ts`, `src/app/(app)/promotions/[id]/draws/page.tsx`, `src/app/(app)/promotions/access.ts`

**Interfaces:**
- Produces: `deliverPrize`, `cancelDelivery`, `returnPrize`, `writeOffPrize`, `attachDeliveryReceipt`, `signReceiptUrl` in `src/services/winners.ts`, each taking an access token exactly as `src/services/draws.ts` does; `PromotionPowers` gains `winnersDeliver`, `winnersDeliverCancel`, `winnersReturn`, `winnersWriteOff`.

- [ ] **Step 1: Write the failing tests**

Vitest for the pure rule, exported from `winner-actions.tsx`:

```ts
export function availableWinnerActions(input: {
  status: string;
  allowsReturnToStock: boolean;
  powers: { deliver: boolean; deliverCancel: boolean; return: boolean; writeOff: boolean };
}): ('deliver' | 'cancel_delivery' | 'return' | 'write_off')[];
```

Cases: `AWAITING_PICKUP` with every power offers deliver, return and write-off but never cancel; `DELIVERED` offers only cancel; `RETURNED` and `WRITTEN_OFF` offer nothing at all; a prize with `allowsReturnToStock: false` never offers return even to somebody holding the permission; each power missing removes exactly its own action.

- [ ] **Step 2: Run them to make sure they fail**

Run: `npx vitest run tests/unit/winner-actions.test.ts`

- [ ] **Step 3: Build it**

Follow `src/services/draws.ts` for the service shape and its `mapDrawError`. The upload order is D1's and is not negotiable: **`deliverPrize` first, then the upload, then `attachDeliveryReceipt`**. A failure in the second or third step leaves a delivery with no receipt, which is what D1 asks for; the reverse order makes storage a hard dependency of recording a handover.

The receipt is shown through a **signed URL** minted server-side — the bucket is private and a path is not a link.

- [ ] **Step 4: Run the tests, the gate, and commit**

- [ ] **Step 5: Add a Playwright case**

An operator delivers a prize with a receipt and sees it on the winner; then undoes the delivery and sees the winner awaiting pickup again. Follow `tests/e2e/draw-flow.spec.ts`, which already seeds a drawn promotion through signed-in RPCs and takes the provisional-password step.

---

### Task 8: The boundary, and two operators on one winner

**Files:**
- Modify: `tests/isolation/draw.test.ts`, `scripts/verify-isolation-suite.mjs`

- [ ] **Step 1: Write the failing tests**

**The boundary.** For `winner_status_history` and `storage_erasure_queue`, and for the bucket, drive the exact read or write the application issues through the harness's `admin` client and through a signed-in operator, and assert it succeeds. pgTAP runs as `postgres` and cannot see a missing grant — and `storage.objects` policies are a place where pgTAP is blind twice over.

**Two operators, one winner, twelve rounds.** Two `deliver_prize` calls fired with `Promise.all` against one `AWAITING_PICKUP` winner. Exactly one succeeds; the other is refused. **Assert the refused one's error code**, not merely that it failed: with the `FOR UPDATE` in place the loser is refused by the transition table with `22023`, and without it the two would interleave differently. Block 6a proved that a count alone cannot tell a working lock from a constraint cleaning up after it.

- [ ] **Step 2: Run them to make sure they fail**

- [ ] **Step 3: Discharge Task 3's owed mutation**

Remove `for update of w` from `apply_winner_transition`, re-run, and confirm the concurrency case fails. **If it does not fail, the case is not reaching the contested code and must be fixed before this task is called done.** Restore byte-identical and report both outputs.

- [ ] **Step 4: Raise the isolation floor, run the gate, commit**

`npm run test:isolation` — guard-complete only. If the run comes back incomplete, re-run: the flake Block 4b recorded is still live and uncaused. The fix is the flake, never the guard.

---

### Task 9: Runbook and report

**Files:**
- Create: `docs/block-6b-runbook.md`, `docs/block-6b-report.md`

- [ ] **Step 1: The runbook**

How an operator delivers a prize and what the receipt is for; when a delivery can be undone and what that does **not** do to the deadline; the difference between returning to stock and writing off, and why a prize sometimes offers only one of them; what a listener's erasure removes and what it leaves; and how to read `winner_status_history` to answer "what happened to this prize?".

- [ ] **Step 2: The report**

Follow `docs/block-6a-report.md`. The gate table carries this block's own measured numbers — run the suites, do not copy. The Concerns section at minimum: that `get_draw` is already a second door onto audience data and this block adds a bucket that is a third; that `RETURN_TO_STOCK`'s double decrement is the only place the per-promotion figures move backwards; and whatever the implementation actually found.

- [ ] **Step 3: Run the whole gate and record the real numbers**

```bash
npm run lint && npm run typecheck && npm test && npm run db:test && npm run test:isolation && CI=1 npx playwright test --workers=1
```

Clear `public.rate_limit_counters` before the Playwright run — the invitation limiter is 10/hour/IP and drops four unrelated specs.

**Do not open the PR** — the owner decides when it opens.

---

## Self-Review

**Spec coverage.** D1→Tasks 5, 7 (the order of operations). D2→Task 4. D3→Task 3. D4→Task 3's deadline assertion. D5→Task 6. D6→Task 1's four codes, enforced in Tasks 3, 4, 5. Spec §3.1→Task 1; §3.2→Task 1; §3.3→Task 6; §4→Task 3; §4.1→Tasks 3, 4; §5→Task 2; §6→Tasks 5, 7; §7→Task 6; §8→Tasks 3, 4, 5, 8; §9→Tasks 1–8; §10 is the out-of-scope list.

**One gap found while reviewing, and closed here rather than left to the implementer:** the spec says a receipt slot is cleared only by erasure, but says nothing about what happens to the queued object if the winner is later deleted — and nothing deletes a winner in this schema, so there is no case. Stated so the next reader does not go looking.

**A second, real one:** `alter type ... add value` cannot be used in the same transaction that uses the value. Task 2 names this and tells the implementer to split the migration if the reset complains, rather than discovering it as a confusing failure.

**Type consistency.** `apply_winner_transition(uuid, winner_status, text)` is declared in Task 3 and consumed unchanged in Task 4. `attach_delivery_receipt(uuid, text)` is declared in Task 5 and consumed by Task 7's service. `drainStorageErasures(client)` is declared in Task 6 and called from the worker route in the same task. `availableWinnerActions` is declared and consumed within Task 7.
