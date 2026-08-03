# Block 6d — The Pickup Deadline Clock — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A pickup deadline that expires on its own, parks the prize in `pending_return`, offers a way back when the listener turns up late, and two screens where an operator can see all of it.

**Architecture:** `winner_status` gains `RETURN_PENDING` and the ledger gains one arm (`pending_return → awaiting_pickup`). A `pg_cron` job calls a plpgsql procedure hourly — no HTTP, no application code in the path — that walks expired winners one at a time, committing after each. Two new `SECURITY DEFINER` list functions feed two new screens, and each re-states by hand every rule RLS used to apply for free.

**Tech Stack:** Postgres 15 (Supabase), `pg_cron`, plpgsql, Next.js 15 App Router, TypeScript strict, Vitest, pgTAP, Playwright.

**Spec:** `docs/superpowers/specs/2026-08-03-block-6d-deadline-clock-design.md`

## Global Constraints

- **Language:** every identifier, comment, migration, test name, UI string and commit message is in **English**. Listener-facing WhatsApp copy stays Portuguese — this block writes none.
- **Migrations are append-only and never edited once merged.** `0091`–`0096` are new files. Nothing in `0001`–`0090` is edited in place; functions are changed by `create or replace` in a new file.
- **`ALTER TYPE ... ADD VALUE` cannot be used in the transaction that creates it.** `0091` contains the two `alter type` statements and nothing else. Anything naming those literals goes in `0092` or later.
- **Every new `SECURITY DEFINER` function checks its permission before revealing whether a row exists.** The existing `P0002`-before-permission leak was quoted as "eight migrations" when this plan was written; that figure was never counted and did not survive being counted (Task 3, Task 11 — see `docs/block-6d-report.md` §5.3 for the method: **45** functions leak, **5** check permission first, **9** raise `P0002` with no permission check in the same body at all). This block adds no new instance either way.
- **Every new `SECURITY DEFINER` function re-states the rules RLS used to apply**: Station scope by permission, the archived-promotion rule, and the `members.view` gate on listener identity. `npm run test:isolation` runs in the same task that writes each function, never deferred to the end.
- **Permission checks in the UI are a courtesy, never the boundary.** Every RPC re-checks.
- **Gates, all of which must pass before the block is called done:** `npm run lint`, `npm run typecheck`, `npm run build`, `npm test`, `npm run db:test`, `npm run test:isolation`, `npm run test:e2e`.
- **Commit after every task.** Message body in English, imperative subject, prefixed `feat(deadline):`, `fix(...)`, `test(...)` or `docs:`.

---

## File Structure

**Created:**
- `supabase/migrations/0091_return_pending_enum.sql` — the two enum values, alone
- `supabase/migrations/0092_return_pending_transitions.sql` — ledger arm + `apply_winner_transition`
- `supabase/migrations/0093_reopen_pickup_deadline.sql` — permission row + the door
- `supabase/migrations/0094_sweep_pickup_deadlines.sql` — the procedure + the schedule
- `supabase/migrations/0095_list_pickups.sql` — the Pickups read
- `supabase/migrations/0096_list_movements.sql` — the Movements read
- `supabase/tests/12_deadline_clock.test.sql` — pgTAP for tasks 1–4
- `supabase/tests/13_pickup_reads.test.sql` — pgTAP for tasks 5–6
- `tests/isolation/pickups.test.ts` — cross-Station and permission cases for both reads
- `src/services/pickups.ts` — `listPickups`, `reopenPickupDeadline`
- `src/services/movements.ts` — `listMovements`
- `src/app/(app)/pickups/page.tsx`, `list-params.ts`, `pickups-grid.tsx`, `pickups-filters.tsx`, `reopen-form.tsx`
- `src/app/(app)/inventory/movements/page.tsx`, `list-params.ts`, `movements-grid.tsx`, `movements-filters.tsx`
- `tests/unit/pickup-params.test.ts`, `tests/unit/movement-params.test.ts`
- `tests/e2e/deadline.spec.ts`

**Modified:**
- `src/lib/keyset.ts` — the uuid check in `decodeCursor`
- `src/app/(app)/participations/page.tsx`, `errors.ts`, `list-params.ts`, `src/services/participations.ts` — comments the fix makes false
- `src/components/draws/winner-actions.tsx` — `reopen` action and `RETURN_PENDING`
- `src/lib/auth/shell.ts` — the two nav sections
- `src/lib/supabase/database.types.ts` — regenerated, never hand-edited
- `tests/unit/winner-actions.test.ts` — the new status and action

---

## Task 1: The two enum values

**Files:**
- Create: `supabase/migrations/0091_return_pending_enum.sql`
- Test: `supabase/tests/12_deadline_clock.test.sql`

**Interfaces:**
- Consumes: nothing.
- Produces: `public.winner_status` value `'RETURN_PENDING'`; `public.inventory_movement_type` value `'RETURN_PENDING_CANCEL'`. Every later task depends on both existing.

- [ ] **Step 1: Write the failing test**

Create `supabase/tests/12_deadline_clock.test.sql`:

```sql
begin;
select plan(2);

-- Block 6d: the clock, the pile it makes, and the way back.
--
-- Fixtures live in the ...00d0xx range. 09_draws.test.sql owns ...00a0xx
-- through ...00a3xx and 10_delivery.test.sql owns ...00b0xx; a collision
-- would fail in whichever file ran second.

select has_enum_label('public', 'winner_status', 'RETURN_PENDING',
  'winner_status carries RETURN_PENDING');
select has_enum_label('public', 'inventory_movement_type', 'RETURN_PENDING_CANCEL',
  'inventory_movement_type carries RETURN_PENDING_CANCEL');

select * from finish();
rollback;
```

If `has_enum_label` is not available in this pgTAP build, use instead:

```sql
select ok(
  'RETURN_PENDING' = any (enum_range(null::public.winner_status)::text[]),
  'winner_status carries RETURN_PENDING');
select ok(
  'RETURN_PENDING_CANCEL' = any (enum_range(null::public.inventory_movement_type)::text[]),
  'inventory_movement_type carries RETURN_PENDING_CANCEL');
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm run db:test`
Expected: FAIL — `12_deadline_clock` reports both assertions false (the labels do not exist yet).

- [ ] **Step 3: Write the migration**

Create `supabase/migrations/0091_return_pending_enum.sql`:

```sql
-- Block 6d, Task 1: two words, and nothing else.
--
-- Separate from 0092 for the reason Postgres enforces rather than a
-- preference, and 0082 hit it first: a value added by ALTER TYPE ... ADD VALUE
-- cannot be USED in the same transaction, and 0092's CHECK constraint names
-- RETURN_PENDING_CANCEL as a literal. In one file it fails with
--   ERROR: unsafe use of new value "RETURN_PENDING_CANCEL" of enum type
-- which reads like a mystery and is not one.
--
-- RETURN_PENDING on winner_status restores what the master spec §6 always
-- asked for and Block 6b argued against: an expired deadline moves the unit to
-- pending_return and it RESTS there until an operator finishes. 6b's argument
-- was that the bucket is only passed through; the owner's ruling of 2026-08-03
-- is that it is also rested in. See the design spec, D1.
--
-- RETURN_PENDING_CANCEL is the inverse of RETURN_PENDING exactly as
-- DELIVERY_CANCEL is the inverse of DELIVERY, and is named to say so. It is the
-- way back for a listener who turns up late while the prize is still on the
-- shelf (D2).

alter type public.winner_status add value 'RETURN_PENDING' after 'AWAITING_PICKUP';

alter type public.inventory_movement_type
  add value 'RETURN_PENDING_CANCEL' after 'RETURN_PENDING';
```

- [ ] **Step 4: Run it and watch it pass**

Run: `npm run db:reset && npm run db:test`
Expected: PASS — `12_deadline_clock` reports 2/2.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/0091_return_pending_enum.sql supabase/tests/12_deadline_clock.test.sql
git commit -m "feat(deadline): the two words, alone, because Postgres insists"
```

---

## Task 2: The ledger arm and the four new transitions

**Files:**
- Create: `supabase/migrations/0092_return_pending_transitions.sql`
- Modify: `supabase/tests/12_deadline_clock.test.sql`
- Read for reference: `supabase/migrations/0085_return_prize.sql` (the body being replaced), `supabase/migrations/0083_delivery_ledger.sql:16-56` (the CHECK surgery)

**Interfaces:**
- Consumes: both enum values from Task 1.
- Produces: `public.apply_winner_transition(p_winner_id uuid, p_to public.winner_status, p_reason text, p_deadline_at timestamptz default null) returns void`. **The fourth parameter is new** and only Task 3's door passes it. Signature change means `drop function` then `create` — `create or replace` cannot change an argument list (`0047` hit this).

- [ ] **Step 1: Write the failing tests**

Append to `supabase/tests/12_deadline_clock.test.sql`, and raise the `plan(2)` at the top to `plan(20)`:

```sql
-- ---------------------------------------------------------------------------
-- THE SHARED FIXTURE: a Station, a promotion with two linked units of one
-- prize, two listeners who entered, and a draw that awarded them both. Built
-- once because everything below is about what happens to a winner afterwards.

insert into public.organizations (id, name) values
  ('00000000-0000-0000-0000-00000000d0f1', 'Org 6d clock');
insert into public.companies (id, organization_id, name, timezone) values
  ('00000000-0000-0000-0000-00000000d0c1', '00000000-0000-0000-0000-00000000d0f1',
   'Station 6d clock', 'America/Sao_Paulo');

insert into public.prizes (id, organization_id, company_id, name, allows_return_to_stock)
values
  ('00000000-0000-0000-0000-00000000d0d1', '00000000-0000-0000-0000-00000000d0f1',
   '00000000-0000-0000-0000-00000000d0c1', 'Speaker 6d', true),
  ('00000000-0000-0000-0000-00000000d0d2', '00000000-0000-0000-0000-00000000d0f1',
   '00000000-0000-0000-0000-00000000d0c1', 'Concert pass 6d', false);

insert into public.inventory_balances
  (company_id, prize_id, organization_id, available)
values
  ('00000000-0000-0000-0000-00000000d0c1', '00000000-0000-0000-0000-00000000d0d1',
   '00000000-0000-0000-0000-00000000d0f1', 4),
  ('00000000-0000-0000-0000-00000000d0c1', '00000000-0000-0000-0000-00000000d0d2',
   '00000000-0000-0000-0000-00000000d0f1', 4);

-- The rest of the fixture -- promotion, promotion_prizes, members,
-- participations, draw, winners -- is built through public.apply_inventory_movement
-- and public.apply_draw rather than by inserting balances by hand, so the
-- numbers these tests read were produced the way production produces them.
-- 10_delivery.test.sql:1-120 builds the same shape and is the reference for the
-- call sequence; the ids here are ...00d0xx and the listeners are named
-- 'Maria 6d', 'Joao 6d' and 'Ana 6d', with Ana holding the Concert pass.

-- NO TEST BELOW CARRIES A WINNER ID. apply_draw decides which listener gets
-- which unit, so an id written into an assertion would be a guess. Winners are
-- addressed by the listener holding them instead:
create function pg_temp.winner_of(p_name text) returns uuid language sql stable as $$
  select w.id
    from public.winners w
    join public.members m on m.id = w.member_id
   where m.full_name = p_name
     and w.company_id = '00000000-0000-0000-0000-00000000d0c1';
$$;

-- ---------------------------------------------------------------------------
-- The ledger's new arm.

select lives_ok($$
  select public.apply_inventory_movement(
    '00000000-0000-0000-0000-00000000d0c1'::uuid,
    '00000000-0000-0000-0000-00000000d0d1'::uuid,
    'RETURN_PENDING'::public.inventory_movement_type, 1,
    'awaiting_pickup'::public.inventory_bucket,
    'pending_return'::public.inventory_bucket,
    'fixture', 'd6-arm-out', null)
$$, 'awaiting_pickup to pending_return is admitted');

select lives_ok($$
  select public.apply_inventory_movement(
    '00000000-0000-0000-0000-00000000d0c1'::uuid,
    '00000000-0000-0000-0000-00000000d0d1'::uuid,
    'RETURN_PENDING_CANCEL'::public.inventory_movement_type, 1,
    'pending_return'::public.inventory_bucket,
    'awaiting_pickup'::public.inventory_bucket,
    'fixture', 'd6-arm-back', null)
$$, 'pending_return to awaiting_pickup is admitted');

select throws_ok($$
  select public.apply_inventory_movement(
    '00000000-0000-0000-0000-00000000d0c1'::uuid,
    '00000000-0000-0000-0000-00000000d0d1'::uuid,
    'RETURN_PENDING_CANCEL'::public.inventory_movement_type, 1,
    'awaiting_pickup'::public.inventory_bucket,
    'pending_return'::public.inventory_bucket,
    'fixture', 'd6-arm-wrong', null)
$$, '23514', null,
  'RETURN_PENDING_CANCEL in the wrong direction is refused by the CHECK');

-- ---------------------------------------------------------------------------
-- The clock's transition.

select lives_ok($$
  select public.apply_winner_transition(
    pg_temp.winner_of('Maria 6d'), 'RETURN_PENDING'::public.winner_status, 'pickup deadline expired')
$$, 'AWAITING_PICKUP moves to RETURN_PENDING');

select is(
  (select status::text from public.winners where id = pg_temp.winner_of('Maria 6d')),
  'RETURN_PENDING', 'the winner rests in RETURN_PENDING');

select is(
  (select pending_return from public.inventory_balances
    where company_id = '00000000-0000-0000-0000-00000000d0c1'
      and prize_id = '00000000-0000-0000-0000-00000000d0d1'),
  1, 'one unit rests in pending_return');

select is(
  (select count(*)::integer from public.inventory_movements
    where idempotency_key like '%' and movement_type = 'RETURN_PENDING'
      and from_bucket = 'awaiting_pickup' and to_bucket = 'pending_return'
      and prize_id = '00000000-0000-0000-0000-00000000d0d1'),
  1, 'exactly ONE movement -- the clock does not emit the pair a return does');

select throws_ok($$
  select public.apply_winner_transition(
    pg_temp.winner_of('Maria 6d'), 'RETURN_PENDING'::public.winner_status, 'again')
$$, '22023', null,
  'a winner already in RETURN_PENDING cannot expire twice');

-- ---------------------------------------------------------------------------
-- The way back. It is the ONLY transition that writes deadline_at.

select lives_ok($$
  select public.apply_winner_transition(
    pg_temp.winner_of('Maria 6d'), 'AWAITING_PICKUP'::public.winner_status,
    'listener called, coming Friday', now() + interval '5 days')
$$, 'RETURN_PENDING reopens to AWAITING_PICKUP');

select ok(
  (select deadline_at from public.winners where id = pg_temp.winner_of('Maria 6d')) > now() + interval '4 days',
  'the reopen wrote the new deadline');

select is(
  (select awaiting_pickup from public.inventory_balances
    where company_id = '00000000-0000-0000-0000-00000000d0c1'
      and prize_id = '00000000-0000-0000-0000-00000000d0d1'),
  1, 'the unit came back to awaiting_pickup');

-- The guard that matters: every OTHER transition must leave deadline_at alone,
-- and a test asserting only the status would pass one that zeroed it. Joao's
-- deadline is recorded here, before he expires and is returned below, and
-- checked at the end of this file.
create temp table deadline_before as
  select (select deadline_at from public.winners
           where id = pg_temp.winner_of('Joao 6d')) as at;

select throws_ok($$
  select public.apply_winner_transition(
    pg_temp.winner_of('Maria 6d'), 'AWAITING_PICKUP'::public.winner_status, 'no date given')
$$, '22023', null,
  'reopening without a new deadline is refused');

-- ---------------------------------------------------------------------------
-- Out of RETURN_PENDING the operator's two ways.

select lives_ok($$
  select public.apply_winner_transition(
    pg_temp.winner_of('Joao 6d'), 'RETURN_PENDING'::public.winner_status, 'pickup deadline expired')
$$, 'the second winner expires too');

select lives_ok($$
  select public.apply_winner_transition(
    pg_temp.winner_of('Joao 6d'), 'RETURNED'::public.winner_status, 'nobody came')
$$, 'RETURN_PENDING returns to stock');

select is(
  (select count(*)::integer from public.inventory_movements
    where movement_type = 'RETURN_TO_STOCK'
      and from_bucket = 'pending_return' and to_bucket = 'available'
      and prize_id = '00000000-0000-0000-0000-00000000d0d1'),
  1, 'ONE movement out of the resting bucket, not the two-step pair');

-- Ana holds the Concert pass, registered as one that cannot go back to stock.
select lives_ok($$
  select public.apply_winner_transition(
    pg_temp.winner_of('Ana 6d'), 'RETURN_PENDING'::public.winner_status, 'pickup deadline expired')
$$, 'a non-returnable prize expires like any other');

select throws_ok($$
  select public.apply_winner_transition(
    pg_temp.winner_of('Ana 6d'), 'RETURNED'::public.winner_status, 'try anyway')
$$, '22023', null,
  'allows_return_to_stock is honoured out of RETURN_PENDING too');

select lives_ok($$
  select public.apply_winner_transition(
    pg_temp.winner_of('Ana 6d'), 'WRITTEN_OFF'::public.winner_status, 'never collected')
$$, 'RETURN_PENDING writes off');

select is(
  (select count(*)::integer from public.inventory_movements
    where movement_type = 'WRITE_OFF' and from_bucket = 'pending_return'
      and prize_id = '00000000-0000-0000-0000-00000000d0d2'),
  1, 'the write-off leaves pending_return, not awaiting_pickup');

-- The frozen column, checked after two transitions that had no business
-- touching it.
select is(
  (select deadline_at from public.winners where id = pg_temp.winner_of('Joao 6d')),
  (select at from deadline_before),
  'expiring and returning left deadline_at exactly where the draw froze it');
```

- [ ] **Step 2: Run and watch it fail**

Run: `npm run db:test`
Expected: FAIL — the CHECK refuses `RETURN_PENDING_CANCEL` and `apply_winner_transition` has no branch for `RETURN_PENDING`.

- [ ] **Step 3: Write the migration**

Create `supabase/migrations/0092_return_pending_transitions.sql`.

Start from `0085_return_prize.sql`'s body. The `DELIVERED` and `AWAITING_PICKUP`-from-`DELIVERED` branches are copied **byte-identical** except where noted; plpgsql offers no way to extend a function in place, and `0085` says so about `0084`.

Three things change and nothing else does.

**(a) The CHECK constraint gains one arm** — the surgery `0083` performed once:

```sql
alter table public.inventory_movements
  drop constraint inventory_movements_legal_transition;

alter table public.inventory_movements
  add constraint inventory_movements_legal_transition check (
    -- every branch of 0026/0083 reproduced verbatim, then:
    or (movement_type = 'RETURN_PENDING_CANCEL'
          and from_bucket = 'pending_return' and to_bucket = 'awaiting_pickup')
  );
```

Copy the existing branches from the current definition rather than retyping them — `\d+ public.inventory_movements` in `psql`, or read `0083:19-56`.

**(b) The signature gains a fourth parameter.** `create or replace` cannot change an argument list, so:

```sql
drop function public.apply_winner_transition(uuid, public.winner_status, text);

create function public.apply_winner_transition(
  p_winner_id   uuid,
  p_to          public.winner_status,
  p_reason      text,
  p_deadline_at timestamptz default null
)
returns void
language plpgsql
set search_path = pg_catalog, public
as $$
```

The default keeps every existing caller — `deliver_prize`, `cancel_delivery`, `return_prize`, `write_off_prize` — compiling and behaving unchanged.

**(c) Four branches are added and one existing comment is rewritten.**

The `RETURN_PENDING` branch:

```sql
  elsif p_to = 'RETURN_PENDING' then
    if v_from <> 'AWAITING_PICKUP' then
      raise exception 'a prize that is % cannot have its deadline expire', v_from
        using errcode = '22023';
    end if;
    -- ONE movement, not the pair a return emits. This is the whole of D1: the
    -- unit stops in pending_return and stays there until an operator finishes,
    -- which is why winner_status needed a value for it.
    perform public.apply_inventory_movement(
      v_company, v_prize, 'RETURN_PENDING'::public.inventory_movement_type, 1,
      'awaiting_pickup'::public.inventory_bucket, 'pending_return'::public.inventory_bucket,
      v_reason, v_history::text, v_link);
```

The reopen branch. Note it **replaces** the existing `elsif p_to = 'AWAITING_PICKUP'` branch, which until now accepted only `DELIVERED` as a source:

```sql
  elsif p_to = 'AWAITING_PICKUP' then
    if v_from = 'DELIVERED' then
      perform public.apply_inventory_movement(
        v_company, v_prize, 'DELIVERY_CANCEL'::public.inventory_movement_type, 1,
        'delivered'::public.inventory_bucket, 'awaiting_pickup'::public.inventory_bucket,
        v_reason, v_history::text, v_link);

    elsif v_from = 'RETURN_PENDING' then
      -- THE ONE PLACE IN THIS FUNCTION THAT WRITES deadline_at (D3).
      --
      -- 6a's D5 froze the column at the draw and this does not thaw it. What
      -- D5 forbids is the PROMOTION's configuration reaching rows it was never
      -- agreed for -- editing pickup_deadline_days in September must not
      -- shorten the deadline of somebody who won in August. Giving one named
      -- person more time, on purpose, with an actor and a reason on the
      -- history row, is the opposite of drift.
      if p_deadline_at is null then
        raise exception 'reopening a deadline needs the new deadline'
          using errcode = '22023';
      end if;
      if p_deadline_at <= now() then
        raise exception 'the new deadline must be in the future'
          using errcode = '22023';
      end if;
      perform public.apply_inventory_movement(
        v_company, v_prize, 'RETURN_PENDING_CANCEL'::public.inventory_movement_type, 1,
        'pending_return'::public.inventory_bucket, 'awaiting_pickup'::public.inventory_bucket,
        v_reason, v_history::text, v_link);
      update public.winners set deadline_at = p_deadline_at where id = p_winner_id;

    else
      raise exception 'a prize that is % cannot be moved back to awaiting pickup', v_from
        using errcode = '22023';
    end if;
```

The `RETURNED` branch accepts a second source and loses a comment that has become false:

```sql
  elsif p_to = 'RETURNED' then
    if v_from not in ('AWAITING_PICKUP', 'RETURN_PENDING') then
      raise exception 'a prize that is % cannot be returned to stock', v_from
        using errcode = '22023';
    end if;

    if not v_allows then
      raise exception
        'the prize "%" is registered as one that cannot go back to stock; write it off instead',
        v_name using errcode = '22023';
    end if;

    if v_from = 'AWAITING_PICKUP' then
      -- TWO movements, one transaction: the ledger has no shortcut from
      -- awaiting_pickup to available (0026). This is the operator returning a
      -- prize whose deadline has NOT expired -- the listener declined it, or
      -- said they cannot come -- and the unit passes through pending_return
      -- without stopping.
      --
      -- The comment that used to stand here argued this traversal was what let
      -- winner_status have no RETURN_PENDING. Block 6d withdrew that argument
      -- (D1): the bucket is now also rested in. It also said the enum kept
      -- "the five values 6a froze", which has been wrong since 6c withdrew
      -- SUPERSEDED and left four.
      perform public.apply_inventory_movement(
        v_company, v_prize, 'RETURN_PENDING'::public.inventory_movement_type, 1,
        'awaiting_pickup'::public.inventory_bucket, 'pending_return'::public.inventory_bucket,
        v_reason, v_history::text || ':pending', v_link);
      perform public.apply_inventory_movement(
        v_company, v_prize, 'RETURN_TO_STOCK'::public.inventory_movement_type, 1,
        'pending_return'::public.inventory_bucket, 'available'::public.inventory_bucket,
        v_reason, v_history::text || ':stock', v_link);
    else
      -- Already resting in pending_return, put there by the clock. One
      -- movement finishes the journey.
      perform public.apply_inventory_movement(
        v_company, v_prize, 'RETURN_TO_STOCK'::public.inventory_movement_type, 1,
        'pending_return'::public.inventory_bucket, 'available'::public.inventory_bucket,
        v_reason, v_history::text, v_link);
    end if;
```

The `WRITTEN_OFF` branch accepts a second source and picks the right bucket:

```sql
  elsif p_to = 'WRITTEN_OFF' then
    if v_from not in ('AWAITING_PICKUP', 'RETURN_PENDING') then
      raise exception 'a prize that is % cannot be written off here', v_from
        using errcode = '22023';
    end if;
    -- 0026 admits WRITE_OFF out of BOTH buckets, so the source is whichever
    -- one the unit is actually in. Getting this wrong would not raise -- it
    -- would move a unit that is not there and fail on the balance CHECK,
    -- which is a worse error to read.
    perform public.apply_inventory_movement(
      v_company, v_prize, 'WRITE_OFF'::public.inventory_movement_type, 1,
      case v_from when 'RETURN_PENDING'
        then 'pending_return'::public.inventory_bucket
        else 'awaiting_pickup'::public.inventory_bucket end,
      'written_off'::public.inventory_bucket,
      v_reason, v_history::text, v_link);
```

Then re-issue the grants and the comment, exactly as `0085` does — a dropped function takes its ACL and its comment with it:

```sql
revoke execute on function
  public.apply_winner_transition(uuid, public.winner_status, text, timestamptz) from public;

comment on function
  public.apply_winner_transition(uuid, public.winner_status, text, timestamptz) is
  'Moves a winner from one status to the next: locks the row, refuses a transition that is not in its table, writes the history row, emits the ledger movements through apply_inventory_movement and writes the new status -- all in one transaction. It touches deadline_at in exactly ONE case, the reopen from RETURN_PENDING, which is the only caller permitted to pass p_deadline_at; every other transition leaves the column frozen where the draw put it (6a D5, Block 6d D3). The history row''s id is the movements'' idempotency key, because a key built from the winner and the status would collide with itself on a second delivery of the same prize, and apply_inventory_movement treats a repeated key as a replay -- so the collision would not raise, it would silently fail to move the stock. A return from AWAITING_PICKUP emits TWO movements because the ledger has no shortcut from awaiting_pickup to available; a return from RETURN_PENDING emits one, because the clock already moved the unit halfway. The allows_return_to_stock refusal lives here rather than in the door because it is a fact about the prize, not about the caller. PRIVATE: SECURITY INVOKER, EXECUTE granted to nobody.';
```

- [ ] **Step 4: Run and watch it pass**

Run: `npm run db:reset && npm run db:test`
Expected: PASS — `12_deadline_clock` 20/20, and `10_delivery.test.sql` still passes untouched, which is the proof the copied branches really are byte-identical.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/0092_return_pending_transitions.sql supabase/tests/12_deadline_clock.test.sql
git commit -m "feat(deadline): the bucket that is rested in, and the way back out of it"
```

---

## Task 3: The permission and the door that reopens

**Files:**
- Create: `supabase/migrations/0093_reopen_pickup_deadline.sql`
- Modify: `supabase/tests/12_deadline_clock.test.sql`
- Read for reference: `supabase/migrations/0081_delivery_tables.sql:85-88` (the permission rows), `supabase/migrations/0085_return_prize.sql:140-195` (the doors)

**Interfaces:**
- Consumes: `apply_winner_transition(uuid, winner_status, text, timestamptz)` from Task 2.
- Produces: `public.reopen_pickup_deadline(p_winner_id uuid, p_deadline_at timestamptz, p_reason text) returns void`, granted to `authenticated`; permission code `winners.reopen_deadline`.

- [ ] **Step 1: Write the failing tests**

Append to `supabase/tests/12_deadline_clock.test.sql`, raising the plan to `plan(25)`:

```sql
select is(
  (select count(*)::integer from public.permissions where code = 'winners.reopen_deadline'),
  1, 'the permission exists');

select is(
  (select scope::text from public.permissions where code = 'winners.reopen_deadline'),
  'company', 'it is a per-Station power, like every other winners.* code');

select has_function('public', 'reopen_pickup_deadline',
  array['uuid', 'timestamptz', 'text'], 'the door exists');

-- Nobody is authenticated in pgTAP, so has_permission is false and the
-- function must refuse. 42501 and NOT P0002 is the point: an unknown id and
-- an unauthorised Station answer identically (design spec §4.1).
select throws_ok($$
  select public.reopen_pickup_deadline(
    pg_temp.winner_of('Maria 6d'), now() + interval '3 days', 'because')
$$, '42501', null,
  'the door refuses without the permission');

select throws_ok($$
  select public.reopen_pickup_deadline(
    '00000000-0000-0000-0000-0000000000ff'::uuid, now() + interval '3 days', 'because')
$$, '42501', null,
  'an id that does not exist answers 42501 too, never P0002');
```

- [ ] **Step 2: Run and watch it fail**

Run: `npm run db:test`
Expected: FAIL — no such permission row, no such function.

- [ ] **Step 3: Write the migration**

Create `supabase/migrations/0093_reopen_pickup_deadline.sql`:

```sql
-- Block 6d, Task 3: giving one person more time, on the record.

insert into public.permissions
  (code, description, block, permission_group, label, scope, ordering)
values
  ('winners.reopen_deadline',
   'Give a listener more time to collect a prize whose deadline expired',
   '6d', 'promotions', 'Reopen a pickup deadline', 'company', 140);

-- Its own code rather than folded into winners.return, and the distinction is
-- not bureaucratic: returning a prize to stock CLOSES a matter, reopening a
-- deadline GRANTS a second chance at a unit the Station had already recovered.
-- Whoever may do the first should not acquire the second by implication -- the
-- same separation Block 2 made between inventory.entry and inventory.exit.

create function public.reopen_pickup_deadline(
  p_winner_id   uuid,
  p_deadline_at timestamptz,
  p_reason      text
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare v_company uuid;
begin
  -- DELIBERATELY NOT SHAPED LIKE ITS 6b SIBLINGS. return_prize and
  -- write_off_prize read the winner, raise P0002 when it is missing, and only
  -- then ask about the permission -- which tells an unauthorised caller
  -- whether an id exists. That leak was quoted as "eight migrations" when this
  -- brief was written; counted properly during the block it turned out to be
  -- 45 functions leaking, 5 checking permission first, 9 raising P0002 with no
  -- permission check in the same body at all (docs/block-6d-report.md §5.3).
  -- Block 6d promised not to add a new instance, and did not.
  --
  -- The winner id is this function's only input, so the Station cannot be
  -- named by the caller the way list_participations (0090) has it named. One
  -- gated query resolves it instead: an unknown id and a Station the caller
  -- holds nothing in are indistinguishable from out here, both 42501. The
  -- cost is that an operator who mistypes an id is told "permission denied";
  -- it is smaller than the alternative. This does not fix the eight before it.
  select company_id into v_company
    from public.winners
   where id = p_winner_id
     and public.has_permission('winners.reopen_deadline', company_id);

  if not found then
    raise log 'reopen_pickup_deadline denied: actor=% winner=%', auth.uid(), p_winner_id;
    raise exception 'permission denied: winners.reopen_deadline required'
      using errcode = '42501';
  end if;

  -- Mandatory, and for the reason the write-off's is: six months later this
  -- sentence is the only thing that explains why a recovered prize became
  -- live again.
  if nullif(btrim(coalesce(p_reason, '')), '') is null then
    raise exception 'reopening a deadline needs a reason' using errcode = '22023';
  end if;

  perform public.apply_winner_transition(
    p_winner_id, 'AWAITING_PICKUP'::public.winner_status, p_reason, p_deadline_at);
end;
$$;

comment on function public.reopen_pickup_deadline(uuid, timestamptz, text) is
  'Gives a listener who turned up late another chance at a prize the clock had already parked in pending_return: the unit goes back to awaiting_pickup, the winner back to AWAITING_PICKUP, and deadline_at forward to the date the operator supplies. Gated on winners.reopen_deadline. The only path in the schema that writes deadline_at after the draw (Block 6d D3) -- 6a''s freeze is against a promotion''s configuration drifting into rows it was never agreed for, not against a named person being given more time on purpose. Refuses a source that is not RETURN_PENDING, a deadline at or before now, and an empty reason. Unlike return_prize and write_off_prize it answers 42501 for an unknown id rather than P0002, so it does not extend the existence leak those two carry.';

revoke execute on function public.reopen_pickup_deadline(uuid, timestamptz, text) from public;
grant execute on function public.reopen_pickup_deadline(uuid, timestamptz, text) to authenticated;
```

- [ ] **Step 4: Run and watch it pass**

Run: `npm run db:reset && npm run db:test`
Expected: PASS — `12_deadline_clock` 25/25.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/0093_reopen_pickup_deadline.sql supabase/tests/12_deadline_clock.test.sql
git commit -m "feat(deadline): reopening is its own power, and its own refusal"
```

---

## Task 4: The clock

**Files:**
- Create: `supabase/migrations/0094_sweep_pickup_deadlines.sql`
- Modify: `supabase/tests/12_deadline_clock.test.sql`
- Read for reference: `supabase/migrations/0064_schedule_worker_tick.sql` (the schedule shape), `supabase/migrations/0072_sweep_conversations.sql` (the sweep it is not)

**Interfaces:**
- Consumes: `apply_winner_transition` from Task 2.
- Produces: `public.sweep_pickup_deadlines()` — a **procedure**, called as `CALL public.sweep_pickup_deadlines()`. EXECUTE is granted to nobody but the owner: the procedure is `SECURITY INVOKER` (a procedure carrying `security definer` or any function-level `SET` clause cannot `commit` at all), so a grantee without EXECUTE on `apply_winner_transition` would fail every winner silently. Anything calling it — including Task 11 — needs a direct connection as the owner, not a PostgREST client.

- [ ] **Step 1: Write the failing tests**

The sweep commits, so it cannot run inside pgTAP's transaction. These tests go in a **second** file that does not wrap itself in `begin`/`rollback`, cleaning up after itself instead.

Create `supabase/tests/12b_deadline_sweep.test.sql`:

```sql
-- NOT wrapped in begin/rollback, unlike every other file here, and it cannot
-- be: sweep_pickup_deadlines is a PROCEDURE that commits after each winner
-- (design spec D6), and CALL inside an open transaction block raises
--   ERROR: invalid transaction termination
-- So this file builds its fixture, runs, asserts, and deletes what it made.

select plan(6);

-- Fixture in the ...00d1xx range, built through apply_inventory_movement and
-- apply_draw the way 10_delivery.test.sql:1-120 builds its own. Station
-- ...00d1c1, prize 'Radio 6d sweep' = ...00d1d1, four listeners named
-- 'Overdue 6d', 'InTime 6d', 'NoDeadline 6d' and 'Delivered 6d'.
--
-- Same helper as 12_deadline_clock, because apply_draw decides who gets what
-- and an id in an assertion would be a guess:
create function pg_temp.winner_of(p_name text) returns uuid language sql stable as $$
  select w.id from public.winners w
    join public.members m on m.id = w.member_id
   where m.full_name = p_name
     and w.company_id = '00000000-0000-0000-0000-00000000d1c1';
$$;

-- The four states the sweep must tell apart. Set directly, because the point
-- is the sweep's predicate and not how a deadline gets its value.
update public.winners set deadline_at = now() - interval '1 day'
  where id = pg_temp.winner_of('Overdue 6d');
update public.winners set deadline_at = now() + interval '5 days'
  where id = pg_temp.winner_of('InTime 6d');
update public.winners set deadline_at = null
  where id = pg_temp.winner_of('NoDeadline 6d');
update public.winners set deadline_at = now() - interval '1 day'
  where id = pg_temp.winner_of('Delivered 6d');
select public.apply_winner_transition(
  pg_temp.winner_of('Delivered 6d'), 'DELIVERED'::public.winner_status, null);

call public.sweep_pickup_deadlines();

select is((select status::text from public.winners where id = pg_temp.winner_of('Overdue 6d')),
  'RETURN_PENDING', 'the overdue winner expired');

select is((select status::text from public.winners where id = pg_temp.winner_of('InTime 6d')),
  'AWAITING_PICKUP', 'a deadline still in the future is left alone');

-- The rule 0075 wrote down: null means this winner has NO deadline, because
-- neither the promotion nor the prize set one, and a Station that has not
-- configured one has not agreed to a rule. A sweep reading null as zero would
-- start clocks nobody agreed to.
select is((select status::text from public.winners where id = pg_temp.winner_of('NoDeadline 6d')),
  'AWAITING_PICKUP', 'a null deadline is skipped, not treated as expired');

select is((select status::text from public.winners where id = pg_temp.winner_of('Delivered 6d')),
  'DELIVERED', 'a delivered prize is not expired out from under the operator');

call public.sweep_pickup_deadlines();

select is((select status::text from public.winners where id = pg_temp.winner_of('Overdue 6d')),
  'RETURN_PENDING', 'running twice changes nothing the first run did');

select is(
  (select count(*)::integer from public.inventory_movements
    where movement_type = 'RETURN_PENDING'
      and prize_id = '00000000-0000-0000-0000-00000000d1d1'),
  1, 'and emits no second movement');

select * from finish();

-- Clean up, children first: this file did not roll back.
delete from public.winner_status_history
 where company_id = '00000000-0000-0000-0000-00000000d1c1';
delete from public.winners where company_id = '00000000-0000-0000-0000-00000000d1c1';
delete from public.draw_entries where company_id = '00000000-0000-0000-0000-00000000d1c1';
delete from public.draws where company_id = '00000000-0000-0000-0000-00000000d1c1';
delete from public.inventory_movements
 where company_id = '00000000-0000-0000-0000-00000000d1c1';
delete from public.inventory_balances
 where company_id = '00000000-0000-0000-0000-00000000d1c1';
delete from public.participations where company_id = '00000000-0000-0000-0000-00000000d1c1';
delete from public.promotion_prizes where company_id = '00000000-0000-0000-0000-00000000d1c1';
delete from public.promotions where company_id = '00000000-0000-0000-0000-00000000d1c1';
delete from public.prizes where company_id = '00000000-0000-0000-0000-00000000d1c1';
delete from public.member_company_links where company_id = '00000000-0000-0000-0000-00000000d1c1';
delete from public.members where organization_id = '00000000-0000-0000-0000-00000000d1f1';
delete from public.audit_logs where company_id = '00000000-0000-0000-0000-00000000d1c1';
delete from public.companies where id = '00000000-0000-0000-0000-00000000d1c1';
delete from public.organizations where id = '00000000-0000-0000-0000-00000000d1f1';
```

Run `\d public.<table>` for any child table this list has missed — a foreign key
violation on cleanup fails the file after its assertions have already passed,
which is a confusing way to find out.

Then the test D6 exists for, in the same file (raise the plan to 9). A winner is poisoned by driving its prize's `awaiting_pickup` balance to zero behind its back, so its movement fails the balance CHECK while its neighbours' succeed:

```sql
-- A SECOND Station, ...00d1c2, with two overdue winners on two DIFFERENT
-- prizes -- 'Poison 6d' (...00d1d2) and 'Neighbour 6d' (...00d1d3), one unit
-- each, held by listeners 'Poisoned 6d' and 'Neighbour 6d'.
--
-- Two prizes and not one, deliberately: apply_inventory_movement locks and
-- reads the balance of the prize it is moving, so a single zeroed balance
-- shared by both winners would fail both and prove nothing about isolation
-- between iterations.
--
-- The balance is driven to an impossible figure behind the ledger's back --
-- the only way to make one movement fail while its neighbour succeeds. Without
-- this test, "commit per winner" (D6) is an intention living in a comment.
update public.inventory_balances
   set awaiting_pickup = 0
 where company_id = '00000000-0000-0000-0000-00000000d1c2'
   and prize_id = '00000000-0000-0000-0000-00000000d1d2';

call public.sweep_pickup_deadlines();

select is(
  (select status::text from public.winners w join public.members m on m.id = w.member_id
    where m.full_name = 'Poisoned 6d'
      and w.company_id = '00000000-0000-0000-0000-00000000d1c2'),
  'AWAITING_PICKUP', 'the poisoned winner did not move');

select is(
  (select status::text from public.winners w join public.members m on m.id = w.member_id
    where m.full_name = 'Neighbour 6d'
      and w.company_id = '00000000-0000-0000-0000-00000000d1c2'),
  'RETURN_PENDING', 'and its neighbour expired anyway -- the commit held');

select is(
  (select count(*)::integer from public.winners
    where company_id = '00000000-0000-0000-0000-00000000d1c2'
      and status = 'RETURN_PENDING'),
  1, 'exactly one of the pair went through');
```

Clean up this second Station the same way, after `finish()`.

- [ ] **Step 2: Run and watch it fail**

Run: `npm run db:test`
Expected: FAIL — `procedure public.sweep_pickup_deadlines() does not exist`.

- [ ] **Step 3: Write the migration**

Create `supabase/migrations/0094_sweep_pickup_deadlines.sql`:

```sql
-- Block 6d, Task 4: the clock. What finally reads the column 6a froze.
--
-- A PROCEDURE and not a function, because only a procedure may commit, and it
-- must commit per winner. The sweep is global -- every Station in the
-- installation -- and in one transaction a single winner whose movement is
-- refused (an inconsistent awaiting_pickup balance for its prize, say) would
-- roll back every other Station's expirations, every hour, for ever.
--
-- No HTTP and no application code in the path. 0064 reaches the app over
-- pg_net because the WhatsApp worker must talk to Meta and therefore lives in
-- TypeScript; nothing here does. Going through HTTP would add a URL and a
-- secret to configure, and docs/block-5a-runbook.md has a section on what
-- happens when they are wrong.
--
-- Not folded into that worker's ten-second tick either, the way 0072's
-- conversation sweep was: that would make prize deadlines in a Station with no
-- WhatsApp integration depend on the WhatsApp worker running.

create procedure public.sweep_pickup_deadlines()
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_ids     uuid[];
  v_id      uuid;
  v_expired integer := 0;
  v_failed  integer := 0;
begin
  -- Collected FIRST, then acted on, so that no cursor is held across a commit.
  -- The list is microseconds stale by the time it is walked and that is safe by
  -- construction rather than by care: apply_winner_transition re-reads and
  -- locks each row and refuses any source that is not AWAITING_PICKUP, so a
  -- prize delivered in between raises and is counted, not silently skipped.
  --
  -- `deadline_at is not null` is not defensive typing. 0075 wrote the rule
  -- down: null means this winner has NO deadline, because neither the
  -- promotion nor the prize set one, and inventing thirty days would start a
  -- clock the Station never agreed to. This predicate and the partial index
  -- winners_deadline_idx (0075) are the same three conditions, which is what
  -- makes the scan an index-only seek.
  select array_agg(id order by deadline_at)
    into v_ids
    from public.winners
   where status = 'AWAITING_PICKUP'
     and deadline_at is not null
     and deadline_at <= now();

  if v_ids is null then
    raise notice 'pickup deadline sweep: nothing due';
    return;
  end if;

  foreach v_id in array v_ids loop
    begin
      perform public.apply_winner_transition(
        v_id, 'RETURN_PENDING'::public.winner_status, 'pickup deadline expired');
      v_expired := v_expired + 1;
    exception
      -- Catching everything is a smell and it is the price of a sweep that
      -- cannot stop. What makes it acceptable is that the failure is NAMED --
      -- winner and SQLERRM -- rather than swallowed, and that pg_cron keeps
      -- the output in cron.job_run_details, which is where Block 11's §31
      -- alert will read from alongside the retention cron's (N7).
      when others then
        v_failed := v_failed + 1;
        raise warning 'pickup deadline sweep failed for winner %: %', v_id, sqlerrm;
    end;
    -- Outside the exception block on purpose: plpgsql refuses COMMIT inside a
    -- block that has an exception handler.
    commit;
  end loop;

  -- A procedure cannot return a row, so the totals are raised. Nothing calls
  -- this but the scheduler, and the scheduler stores output, not result sets.
  raise notice 'pickup deadline sweep: % expired, % failed', v_expired, v_failed;
end;
$$;

comment on procedure public.sweep_pickup_deadlines() is
  'Moves every winner whose frozen pickup deadline has passed to RETURN_PENDING, and its unit from awaiting_pickup to pending_return, where it rests until an operator returns it or writes it off. Scheduled hourly; deadlines are day-grained so an hour of latency is the whole cost. Skips a null deadline_at, which means this winner has no deadline at all rather than one of zero days (0075). Re-running is safe and not because this is careful: apply_winner_transition refuses any source that is not AWAITING_PICKUP, so twice in an hour and once after a week of downtime give the same result. Commits after each winner so that one whose movement is refused cannot roll back every other Station''s expirations. Records no actor -- auth.uid() is null under pg_cron and all three actor columns are nullable -- which is honest: nobody did this, the deadline did.';

revoke execute on procedure public.sweep_pickup_deadlines() from public;
grant execute on procedure public.sweep_pickup_deadlines() to service_role;

-- Idempotent, exactly as 0064: db:reset runs every migration from empty
-- locally, and a hosted redeploy must re-run this file without cron raising
-- "job already exists".
select cron.unschedule('pickup-deadline-sweep')
where exists (select 1 from cron.job where jobname = 'pickup-deadline-sweep');

-- Standard five-field cron, NOT the '1 hour' interval form. 0064 uses an
-- interval and had to document that second-level schedules need pg_cron >= 1.5
-- with a fallback for older installs. Hourly work needs no such note: every
-- version understands '0 * * * *'.
select cron.schedule(
  'pickup-deadline-sweep',
  '0 * * * *',
  $$ call public.sweep_pickup_deadlines(); $$
);
```

- [ ] **Step 4: Run and watch it pass**

Run: `npm run db:reset && npm run db:test`
Expected: PASS — `12b_deadline_sweep` 9/9.

- [ ] **Step 5: Verify the schedule really landed**

Run:
```bash
supabase db reset >/dev/null 2>&1 && \
  psql "$(supabase status -o env | grep DB_URL | cut -d= -f2- | tr -d '"')" \
  -c "select jobname, schedule, command from cron.job where jobname = 'pickup-deadline-sweep';"
```
Expected: one row, schedule `0 * * * *`. A migration that defines a procedure nobody scheduled would pass every test above and never run in production.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/0094_sweep_pickup_deadlines.sql supabase/tests/12b_deadline_sweep.test.sql
git commit -m "feat(deadline): the clock, committing one winner at a time"
```

---

## Task 5: `list_pickups`

**Files:**
- Create: `supabase/migrations/0095_list_pickups.sql`, `supabase/tests/13_pickup_reads.test.sql`, `tests/isolation/pickups.test.ts`
- Read for reference: `supabase/migrations/0090_list_participations.sql` — **the model for this task in every respect**

**Interfaces:**
- Consumes: nothing from earlier tasks except the `RETURN_PENDING` status existing.
- Produces:

```sql
public.list_pickups(
  p_company_id   uuid,
  p_status       public.winner_status default null,
  p_promotion_id uuid    default null,
  p_search       text    default null,
  p_cursor_at    timestamptz default null,
  p_cursor_id    uuid    default null,
  p_walking_back boolean default false,
  p_limit        integer default 26
) returns table (
  winner_id      uuid,
  member_id      uuid,
  member_name    text,       -- null without members.view
  member_phone   text,       -- null without members.view
  prize_id       uuid,
  prize_name     text,
  allows_return_to_stock boolean,
  promotion_id   uuid,
  promotion_name text,
  status         public.winner_status,
  deadline_at    timestamptz,
  total_count    integer
)
```

- [ ] **Step 1: Write the failing pgTAP tests**

Create `supabase/tests/13_pickup_reads.test.sql` with `plan(10)`, fixtures in the `...00d2xx` range, and cases for: the permission refusal (`42501`, not an empty page); a page ordered by `deadline_at` ascending; the status filter; the promotion filter; nulls landing after dated rows; `total_count` matching the unfiltered count; and a page boundary walked forward and back.

- [ ] **Step 2: Write the failing isolation tests**

Create `tests/isolation/pickups.test.ts`, modelled on `tests/isolation/participations.test.ts`. Four cases, and every one of them is a rule `SECURITY DEFINER` throws away:

```ts
import { afterAll, describe, expect, it } from 'vitest';
import { admin, cleanupUsers, grantRoleWith, provisionCustomer, signInAs } from './harness';

afterAll(cleanupUsers);

/**
 * A SECURITY DEFINER function that replaces a query under RLS inherits
 * NOTHING. Block 6c learned it the expensive way: list_participations became a
 * function and lost the rule hiding participations of archived promotions, for
 * five commits, seen by neither pgTAP nor tsc nor ESLint nor Playwright. Only
 * this suite found it. So these four cases are written in the same task as the
 * function, not after the block.
 */
describe('list_pickups', () => {
  it('refuses a Station the caller holds no role in, with 42501 and not an empty page', async () => {
    // ...provision two customers, sign in as the first, call with the second's
    // company id, expect error.code === '42501'
  });

  it('hides the winners of an archived promotion from a delegate', async () => {
    // ...soft-delete the promotion, assert the row vanishes for the delegate
    // and remains for the Organization's owner
  });

  it('returns rows but null names to a caller without members.view', async () => {
    // ...grant promotions.view only; expect rows.length > 0 and every
    // member_name === null
  });

  it('returns nothing at all when a caller without members.view searches', async () => {
    // ...same caller, p_search set; expect rows.length === 0. Searching a
    // field you may not read is an oracle -- 0090 argues it in full.
  });
});
```

- [ ] **Step 3: Run both and watch them fail**

Run: `npm run db:test && npm run test:isolation`
Expected: FAIL — the function does not exist.

- [ ] **Step 4: Write the migration**

Create `supabase/migrations/0095_list_pickups.sql`. `0090_list_participations.sql` is the model for the keyset CTE and the `total_count` computed from it; read it before writing.

The four rules RLS used to apply, which this function must apply itself, are the whole risk of the task. They are written out here so none is left to inference:

```sql
create function public.list_pickups(
  p_company_id   uuid,
  p_status       public.winner_status default null,
  p_promotion_id uuid    default null,
  p_search       text    default null,
  p_cursor_at    timestamptz default null,
  p_cursor_id    uuid    default null,
  p_walking_back boolean default false,
  p_limit        integer default 26
)
returns table (...)   -- the shape in this task's Interfaces block
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  v_names  boolean;
  v_search text := nullif(btrim(coalesce(p_search, '')), '');
begin
  -- RULE 1. The permission, first, and a refusal rather than an empty page.
  -- winners_select_by_promotion_view (0075) reads has_permission(
  -- 'promotions.view', company_id); SECURITY DEFINER means that policy is no
  -- longer consulted, so it is asked here instead. An empty page would be
  -- indistinguishable from a Station where nobody has won anything.
  if not public.has_permission('promotions.view', p_company_id) then
    raise exception 'permission denied: promotions.view required'
      using errcode = '42501';
  end if;

  -- RULE 2. Identity only to a caller who may read it. Without members.view
  -- the list STILL LISTS -- every row, with name and phone null -- which is
  -- what a plain (non-!inner) join gave before. 0090 settled this for the
  -- participants list and Pickups is the same kind of list; get_draw (0080)
  -- answers differently for one draw, and the design spec's D7 records that
  -- the two now disagree on purpose.
  v_names := public.has_permission('members.view', p_company_id);

  -- RULE 3. Searching a field you may not read is an oracle: it answers
  -- "is there a listener called X here?" to somebody forbidden the names.
  -- Returning nothing is the only honest answer.
  if v_search is not null and not v_names then
    return;
  end if;

  return query
  with visible as (
    select w.id, w.member_id, w.status, w.deadline_at,
           pz.id as prize_id, pz.name as prize_name, pz.allows_return_to_stock,
           pr.id as promotion_id, pr.name as promotion_name,
           m.full_name, m.phone
      from public.winners w
      join public.draws d            on d.id = w.draw_id
      join public.promotions pr      on pr.id = d.promotion_id
      join public.promotion_prizes l on l.id = w.promotion_prize_id
      join public.prizes pz          on pz.id = l.prize_id
      join public.members m          on m.id = w.member_id
     where w.company_id = p_company_id
       -- RULE 4. THE ONE BLOCK 6C LOST FOR FIVE COMMITS. 0044's promotions
       -- policy reads `deleted_at is null or is_owner_of_company(company_id)`,
       -- and a query that joined promotions inherited it for free. This
       -- function inherits nothing, so an archived promotion's winners would
       -- list for every delegate unless this line exists.
       and (pr.deleted_at is null or public.is_owner_of_company(pr.company_id))
       and (p_status is null       or w.status = p_status)
       and (p_promotion_id is null or pr.id = p_promotion_id)
       and (v_search is null       or m.full_name ilike '%' || v_search || '%'
                                   or public.normalize_phone(m.phone)
                                        like '%' || public.normalize_phone(v_search) || '%')
  )
  -- ...then the keyset window over `visible`, ordered
  -- `deadline_at asc nulls last, id asc`, with total_count taken from the SAME
  -- CTE so a page and its count cannot narrow differently (0090's rule), and
  -- full_name/phone projected as `case when v_names then ... else null end`.
  ...
end;
$$;
```

Confirm `public.is_owner_of_company` is the helper `0044` actually uses — read that migration rather than trusting this name — and mirror it exactly.

Ordering is `deadline_at asc nulls last, winner_id asc`: soonest first, because the row needing attention is the one about to expire. The cursor filter is built `nullsLast` to match. `keysetFilter`'s own contract says the ordering and the filter must agree about null placement, and `deadline_at` is nullable with meaning — a winner with no deadline at all — so those rows form a terminal region the paging has to be able to reach.

Finish with the grants and a `comment on function` that enumerates all four rules, the way `0090`'s does. The comment is how the next reader learns the function is load-bearing for things RLS no longer does.

- [ ] **Step 5: Run both and watch them pass**

Run: `npm run db:reset && npm run db:test && npm run test:isolation`
Expected: PASS. The isolation suite must report guard-complete.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/0095_list_pickups.sql supabase/tests/13_pickup_reads.test.sql tests/isolation/pickups.test.ts
git commit -m "feat(deadline): the pickups list, and every rule RLS stopped applying"
```

---

## Task 6: `list_movements`

**Files:**
- Create: `supabase/migrations/0096_list_movements.sql`
- Modify: `supabase/tests/13_pickup_reads.test.sql`, `tests/isolation/pickups.test.ts`

**Interfaces:**
- Produces:

```sql
public.list_movements(
  p_company_id   uuid,
  p_type         public.inventory_movement_type default null,
  p_prize_id     uuid    default null,
  p_promotion_id uuid    default null,
  p_from         timestamptz default null,
  p_to           timestamptz default null,
  p_cursor_at    timestamptz default null,
  p_cursor_id    uuid    default null,
  p_walking_back boolean default false,
  p_limit        integer default 26
) returns table (
  movement_id    uuid,
  created_at     timestamptz,
  movement_type  public.inventory_movement_type,
  quantity       integer,
  from_bucket    public.inventory_bucket,
  to_bucket      public.inventory_bucket,
  prize_id       uuid,
  prize_name     text,
  promotion_id   uuid,
  promotion_name text,       -- null when there is no promotion OR it is archived
  promotion_archived boolean,-- which of those two, said out loud (Step 3)
  actor_id       uuid,
  actor_name     text,       -- null when actor_id is null: the clock did it
  note           text,
  total_count    integer
)
```

- [ ] **Step 1: Write the failing tests**

Append to `supabase/tests/13_pickup_reads.test.sql` (raise the plan) and to `tests/isolation/pickups.test.ts` a `describe('list_movements')` block with two cases: another Station is refused with `42501`; and a caller holding `inventory.view` without `promotions.view` still gets `promotion_name` populated.

That second case is the whole reason this function exists rather than a plain query — write the assertion explicitly:

```ts
it('returns the promotion name to an inventory-only caller, because null already means something', async () => {
  // inventory_movements.promotion_prize_id is nullable WITH MEANING: null is a
  // purchase entry or an adjustment, which belongs to no promotion. A name
  // withheld for lack of promotions.view would be indistinguishable from that.
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `npm run db:test && npm run test:isolation`
Expected: FAIL — no such function.

- [ ] **Step 3: Write the migration**

Create `supabase/migrations/0096_list_movements.sql`, same shape as Task 5. Gated on `inventory.view`. Ordering `created_at desc, movement_id desc` — newest first, and `created_at` is `not null`, so no nulls region here.

`actor_name` is resolved through the Organization's membership, and is null when `actor_id` is null. The comment must say what that null means, because the screen renders it: the sweep did it, and `auth.uid()` under `pg_cron` is null.

**The archived promotion, again, and this time it is not a copy of Task 5's rule.** This function joins `promotions` to get a name, and `0044:47` hides an archived promotion from everyone but the Organization's owner. A movement is an inventory fact its caller may legitimately see; the promotion's *name* is the extra this function adds. Hiding the whole row would delete stock history from an inventory screen, which is wrong; showing the name would hand a delegate the name of a promotion `0044` archived away from them.

Neither, and the return type carries the answer — which is why it has one more column than Task 5's:

```sql
  promotion_id       uuid,     -- null when the movement belongs to no promotion
  promotion_name     text,     -- null when there is none OR it is archived
  promotion_archived boolean,  -- which of the two, said out loud
```

The row lists. The name is null for a non-owner when `pr.deleted_at is not null`, and `promotion_archived` is true exactly then, so the screen renders `(archived promotion)` rather than a blank cell. Without that third column the two nulls are indistinguishable — the same ambiguity that made this function `SECURITY DEFINER` in the first place (D7), reappearing one level down.

Add the case to `tests/isolation/pickups.test.ts` in this task, not later:

```ts
it('shows a delegate that a movement belongs to an archived promotion, without naming it', async () => {
  // 0044 archives promotions away from delegates. The movement is still the
  // Station's stock history and still lists; the name does not, and
  // promotion_archived says which null this is.
});
```

- [ ] **Step 4: Run and watch them pass**

Run: `npm run db:reset && npm run db:test && npm run test:isolation`
Expected: PASS, guard-complete.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/0096_list_movements.sql supabase/tests/13_pickup_reads.test.sql tests/isolation/pickups.test.ts
git commit -m "feat(inventory): the ledger as a list, with the promotion it belongs to"
```

---

## Task 7: `decodeCursor` stops accepting anything

**Files:**
- Modify: `src/lib/keyset.ts:26-38`
- Modify: `src/app/(app)/participations/page.tsx:88-105`, `src/app/(app)/participations/errors.ts:25`, `src/app/(app)/participations/list-params.ts:138`, `src/services/participations.ts:770`
- Create: `tests/unit/keyset-cursor.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `decodeCursor` returns `null` for a cursor whose `id` is not a uuid. Behaviour change for all six callers.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/keyset-cursor.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { decodeCursor, encodeCursor } from '@/lib/keyset';

describe('decodeCursor', () => {
  it('round-trips a real cursor', () => {
    const cursor = { value: '2026-08-03T10:00:00Z', id: '3f2504e0-4f89-11d3-9a0c-0305e82c3301' };
    expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor);
  });

  it('round-trips a cursor whose sort value is null', () => {
    const cursor = { value: null, id: '3f2504e0-4f89-11d3-9a0c-0305e82c3301' };
    expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor);
  });

  // The hole this closes. `{"value":null,"id":"abc"}` parsed perfectly, reached
  // Postgres as id.lt."abc" and came back 22P02 -- which at least one screen
  // rendered verbatim, showing a listener raw database text.
  it('refuses an id that is not a uuid', () => {
    const forged = Buffer.from(JSON.stringify({ value: null, id: 'abc' })).toString('base64url');
    expect(decodeCursor(forged)).toBeNull();
  });

  it('refuses a uuid-shaped string with the wrong length', () => {
    const forged = Buffer.from(
      JSON.stringify({ value: null, id: '3f2504e0-4f89-11d3-9a0c-0305e82c33' }),
    ).toString('base64url');
    expect(decodeCursor(forged)).toBeNull();
  });

  it('still returns null for junk, as it always did', () => {
    expect(decodeCursor('not base64 at all!!')).toBeNull();
    expect(decodeCursor('')).toBeNull();
    expect(decodeCursor(undefined)).toBeNull();
  });
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `npx vitest run tests/unit/keyset-cursor.test.ts`
Expected: FAIL — "refuses an id that is not a uuid" returns `{ value: null, id: 'abc' }`.

- [ ] **Step 3: Implement**

In `src/lib/keyset.ts`, above `decodeCursor`:

```ts
/**
 * Every screen's cursor id is a row's uuid primary key -- `cursorFor` puts one
 * there in all six callers, without exception. Anything else is a hand-edited
 * `?after=`, and letting it through sent `id.lt."abc"` to Postgres, which
 * answered 22P02.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
```

and inside it, replacing the id check:

```ts
    if (typeof id !== 'string' || !UUID.test(id)) return null;
```

- [ ] **Step 4: Run and watch it pass**

Run: `npx vitest run tests/unit/keyset-cursor.test.ts`
Expected: PASS, 5/5.

- [ ] **Step 5: Fix the four comments the change makes false**

Each of these describes the hole as live. A comment that explains a defect becomes a lie the moment it is fixed — the same standard `0092` applied to `0085`'s.

In `src/app/(app)/participations/page.tsx`, replace the block at lines 88–105 with:

```ts
  // A bad cursor starts the list over rather than erroring -- decodeCursor
  // (@/lib/keyset) returns null for it, including for a well-formed
  // `{"value":null,"id":"abc"}` whose id is not a uuid. That last case used to
  // reach Postgres as `id.lt."abc"` and come back 22P02, which
  // describeParticipationsReadError renders verbatim; Block 6d closed it in
  // decodeCursor itself, where all six keyset screens share the fix.
```

Update the sentences in `errors.ts:25`, `list-params.ts:138` and `services/participations.ts:770` the same way: they may still name `22P02` as a code the mapper handles, but must not claim `decodeCursor` lets a forged id through.

- [ ] **Step 6: Run the full suite**

Run: `npm test && npm run lint && npm run typecheck`
Expected: PASS. Any list test that relied on a non-uuid cursor is asserting the old hole and should be updated, not worked around.

- [ ] **Step 7: Commit**

```bash
git add src/lib/keyset.ts tests/unit/keyset-cursor.test.ts "src/app/(app)/participations" src/services/participations.ts
git commit -m "fix(keyset): a cursor id that is not a uuid starts the list over"
```

---

## Task 8: Types, services and the reopen action

**Files:**
- Modify: `src/lib/supabase/database.types.ts` (regenerated)
- Create: `src/services/pickups.ts`, `src/services/movements.ts`
- Modify: `src/components/draws/winner-actions.tsx`, `tests/unit/winner-actions.test.ts`

**Interfaces:**
- Consumes: `list_pickups`, `list_movements`, `reopen_pickup_deadline` from Tasks 3, 5, 6.
- Produces: `listPickups(accessToken, params)`, `reopenPickupDeadline(accessToken, {winnerId, deadlineAt, reason})`, `listMovements(accessToken, params)`; `WinnerAction` gains `'reopen'`; `WinnerPowers` gains `reopenDeadline: boolean`.

- [ ] **Step 1: Regenerate the database types**

Run: `npm run db:reset && npm run db:types`
The file is generated — never hand-edit it. Confirm the three new functions appear:

```bash
grep -c "list_pickups\|list_movements\|reopen_pickup_deadline" src/lib/supabase/database.types.ts
```
Expected: at least 3.

- [ ] **Step 2: Write the failing test for the action map**

Append to `tests/unit/winner-actions.test.ts`:

```ts
describe('availableWinnerActions, RETURN_PENDING', () => {
  const all = { deliver: true, deliverCancel: true, return: true, writeOff: true, reopenDeadline: true };

  it('offers reopen, return and write-off, and never a bare handover', () => {
    expect(
      availableWinnerActions({ status: 'RETURN_PENDING', allowsReturnToStock: true, powers: all }),
    ).toEqual(['reopen', 'return', 'write_off']);
  });

  // Handing a prize over from RETURN_PENDING is not a shortcut the ledger has:
  // DELIVERY leaves awaiting_pickup and nowhere else. The way back is the
  // reopen, which is a decision with a reason on it.
  it('never offers deliver from RETURN_PENDING', () => {
    expect(
      availableWinnerActions({ status: 'RETURN_PENDING', allowsReturnToStock: true, powers: all }),
    ).not.toContain('deliver');
  });

  it('drops the return when the prize cannot go back to stock', () => {
    expect(
      availableWinnerActions({ status: 'RETURN_PENDING', allowsReturnToStock: false, powers: all }),
    ).toEqual(['reopen', 'write_off']);
  });

  it('offers nothing to a caller holding none of the powers', () => {
    expect(
      availableWinnerActions({
        status: 'RETURN_PENDING',
        allowsReturnToStock: true,
        powers: { deliver: false, deliverCancel: false, return: false, writeOff: false, reopenDeadline: false },
      }),
    ).toEqual([]);
  });
});
```

- [ ] **Step 3: Run and watch it fail**

Run: `npx vitest run tests/unit/winner-actions.test.ts`
Expected: FAIL — `RETURN_PENDING` falls through to the `return []` at the end.

- [ ] **Step 4: Implement the action map**

In `src/components/draws/winner-actions.tsx`:

```ts
export type WinnerAction = 'deliver' | 'cancel_delivery' | 'return' | 'write_off' | 'reopen';

export interface WinnerPowers {
  deliver: boolean;
  deliverCancel: boolean;
  return: boolean;
  writeOff: boolean;
  reopenDeadline: boolean;
}
```

and, before the final `return []`:

```ts
  // The clock put this prize back on the shelf. Three ways out and no fourth:
  // the ledger has no DELIVERY out of pending_return, so somebody arriving
  // late is given time again -- deliberately, with a reason -- and handed the
  // prize through the ordinary path afterwards.
  if (status === 'RETURN_PENDING') {
    const actions: WinnerAction[] = [];
    if (powers.reopenDeadline) actions.push('reopen');
    if (powers.return && allowsReturnToStock) actions.push('return');
    if (powers.writeOff) actions.push('write_off');
    return actions;
  }
```

Add to `LABELS`: `reopen: 'Reopen the deadline'`. Add to `NEEDS_REASON`: `reopen: true`. The reopen also needs a date, which `reopen-form.tsx` supplies in Task 9 — `WinnerActions` renders the existing reason input for it and a `datetime-local` beside it.

- [ ] **Step 5: Run and watch it pass**

Run: `npx vitest run tests/unit/winner-actions.test.ts`
Expected: PASS.

- [ ] **Step 6: Write the services**

Create `src/services/pickups.ts` and `src/services/movements.ts`, following `src/services/winners.ts` exactly: `asCaller(accessToken)`, an error mapper over the same five codes, one thin function per RPC, `undefined` rather than `null` for omitted PostgREST arguments.

`reopenPickupDeadline` maps `42501` to `UnauthorizedError` as its siblings do — and its message will read "permission denied" for an unknown id as well, which is the door's deliberate shape (`0093`), not a mapping bug.

- [ ] **Step 7: Run the gates**

Run: `npm test && npm run lint && npm run typecheck`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/lib/supabase/database.types.ts src/services/pickups.ts src/services/movements.ts src/components/draws/winner-actions.tsx tests/unit/winner-actions.test.ts
git commit -m "feat(deadline): the reopen, and the three ways out of a parked prize"
```

---

## Task 9: The Pickups screen

**Files:**
- Create: `src/app/(app)/pickups/page.tsx`, `list-params.ts`, `pickups-grid.tsx`, `pickups-filters.tsx`, `reopen-form.tsx`, `actions.ts`, `access.ts`
- Modify: `src/lib/auth/shell.ts:74-77`
- Create: `tests/unit/pickup-params.test.ts`

**Interfaces:**
- Consumes: `listPickups`, `reopenPickupDeadline` from Task 8; `availableWinnerActions` with `'reopen'`.
- Produces: the route `/pickups`.

- [ ] **Step 1: Write the failing params test**

Create `tests/unit/pickup-params.test.ts`, modelled on `tests/unit/record-params.test.ts`. Cover: an unknown `status` falls back to no filter rather than erroring; a malformed `after` yields no cursor (Task 7's contract); the filters survive a round trip through `URLSearchParams`.

Then the case the screen exists for:

```ts
it('renders an expired deadline as overdue even while the row is still AWAITING_PICKUP', () => {
  // Up to an hour passes between a deadline expiring and the sweep running.
  // The column reads the DATE, not the status, so the screen never claims a
  // prize is fine because the cron has not been round yet.
  expect(describeDeadline(new Date(Date.now() - 86_400_000), 'AWAITING_PICKUP'))
    .toMatch(/overdue/i);
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `npx vitest run tests/unit/pickup-params.test.ts`
Expected: FAIL — the module does not exist.

- [ ] **Step 3: Build the screen**

Follow `src/app/(app)/participations/` file for file — it is the closest sibling: `list-params.ts` parses and validates, `page.tsx` is the server component that reads the session and calls the service, `*-grid.tsx` renders rows, `*-filters.tsx` renders the filter bar, `actions.ts` holds the server actions.

Filters: status, promotion, listener search. Columns: listener, prize, promotion, status, deadline. Order `deadline_at` ascending, soonest first.

The status filter's labels are operator English, not enum text: `Awaiting pickup`, `Return pending`, `Delivered`, `Returned`, `Written off`.

`reopen-form.tsx` collects a `datetime-local` and a reason, and calls the server action wrapping `reopenPickupDeadline`. No `revalidatePath` after it — this codebase's standing rule, because re-running a keyset list throws away the operator's place in it. The row updates from the action's return value and the runbook says the list is one refresh behind.

- [ ] **Step 4: Add the nav entry**

In `src/lib/auth/shell.ts`, the Promotions section:

```ts
    {
      label: 'Promotions',
      items: [
        { href: '/promotions', label: 'Promotions', icon: ICONS.megaphone },
        { href: '/pickups', label: 'Pickups', icon: ICONS.package },
      ],
    },
```

Use an icon that already exists in `ICONS`; add one only if none fits, following how `ICONS` is declared in that file.

- [ ] **Step 5: Run everything**

Run: `npm test && npm run lint && npm run typecheck && npm run build`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add "src/app/(app)/pickups" src/lib/auth/shell.ts tests/unit/pickup-params.test.ts
git commit -m "feat(deadline): the counter's screen, where a prize has a name and a clock"
```

---

## Task 10: The Movements screen and the Inventory split

**Files:**
- Create: `src/app/(app)/inventory/movements/page.tsx`, `list-params.ts`, `movements-grid.tsx`, `movements-filters.tsx`
- Modify: `src/lib/auth/shell.ts:39-41`
- Create: `tests/unit/movement-params.test.ts`

**Interfaces:**
- Consumes: `listMovements` from Task 8.
- Produces: the route `/inventory/movements`.

- [ ] **Step 1: Write the failing params test**

Create `tests/unit/movement-params.test.ts`: the type filter accepts only real `inventory_movement_type` values and falls back to none; the period filter rejects a `to` before its `from`; a malformed cursor yields none.

- [ ] **Step 2: Run and watch it fail**

Run: `npx vitest run tests/unit/movement-params.test.ts`
Expected: FAIL — the module does not exist.

- [ ] **Step 3: Build the screen**

Columns: date, type, prize, quantity, `from → to`, promotion, actor, note. Newest first. Filters: type, prize, promotion, period.

**No actions and no buttons.** The ledger is append-only by grant — no role holds UPDATE or DELETE on `inventory_movements` — and a mistake is corrected by a new movement, the way a bank statement is corrected by a reversal. A screen offering to edit a row would offer what the database refuses.

The actor column renders `(deadline)` when `actor_id` is null, because the only thing that writes movements without an actor is the sweep.

**Key it off `actor_id`, never off `actor_name`.** The two nulls mean different things and only one of them is the clock: `actor_name` null with `actor_id` present is a real person who has no display name on record, and rendering them as "(deadline)" credits a machine for something somebody did. Show that case as the row's actor being unnamed, not absent.

Task 6 briefly dodged this by coalescing the name to the operator's email address; review had it removed, because the row already carries the bit that settles it and the coalesce leaked a colleague's email to everyone holding `inventory.view`.

- [ ] **Step 4: Split the Inventory nav**

In `src/lib/auth/shell.ts`, the Inventory section — keeping the long comment above it, which is still true of both items:

```ts
      label: 'Inventory',
      items: [
        { href: '/inventory', label: 'Stock', icon: ICONS.box },
        { href: '/inventory/movements', label: 'Movements', icon: ICONS.list },
      ],
```

The existing route does not move, so no link anywhere breaks; only the label changes.

- [ ] **Step 5: Run everything**

Run: `npm test && npm run lint && npm run typecheck && npm run build`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add "src/app/(app)/inventory/movements" src/lib/auth/shell.ts tests/unit/movement-params.test.ts
git commit -m "feat(inventory): Stock and Movements, and a ledger nobody can edit"
```

---

## Task 11: The round trip, the report and the runbook

**Files:**
- Create: `tests/e2e/deadline.spec.ts`, `docs/block-6d-report.md`, `docs/block-6d-runbook.md`

**Interfaces:**
- Consumes: everything.

- [ ] **Step 1: Write the failing e2e**

Create `tests/e2e/deadline.spec.ts`, following `tests/e2e/`'s existing setup. One test, the whole way round:

1. Seed a Station, a promotion, a prize with stock, a listener, a participation and a draw, through the service-role client as the other e2e specs do.
2. Set the winner's `deadline_at` to an hour ago.
3. Run the sweep. **Do not wait for the schedule** — the test asserts the procedure's effect, and `pg_cron` firing is verified separately in Task 4.

   **Not through the service-role client, which cannot do it — twice over.** Task 4 revoked EXECUTE, leaving the procedure owner-only, precisely because a `service_role` call would fail every winner (it holds no EXECUTE on `apply_winner_transition`), have the failures swallowed by the sweep's broad catch, and return success having done nothing. And separately: a supabase-js/PostgREST client cannot invoke a transaction-controlling PROCEDURE at all, at any privilege.

   Open a direct Postgres connection as the migration-owning role and `CALL public.sweep_pickup_deadlines();` there. The local connection string comes from `supabase status`. If the e2e harness has no direct-pg dependency available, do not add one for this — assert the pre-sweep and post-sweep screen states around a sweep triggered from a SQL-level test instead, and say plainly in the report that the browser test covers the screens while `12b_deadline_sweep.test.sql` covers the procedure.
4. Sign in as an operator holding `promotions.view`, `winners.reopen_deadline` and `winners.deliver`.
5. Open `/pickups`, filter to `Return pending`, and assert the listener's row is there.
6. Reopen the deadline with a reason and a date three days out; assert the row moves to `Awaiting pickup`.
7. Hand the prize over; assert it moves to `Delivered`.
8. Open `/inventory/movements` and assert four rows for that prize in order: `DRAW`, `RETURN_PENDING`, `RETURN_PENDING_CANCEL`, `DELIVERY` — the whole journey, readable by somebody who was not there.

- [ ] **Step 2: Run and watch it fail**

Run: `npm run test:e2e -- deadline`
Expected: FAIL.

- [ ] **Step 3: Make it pass**

Fix whatever it catches. Do not weaken the assertions in step 8 — that sequence of four movements is the block's claim.

- [ ] **Step 4: Run every gate, and record the real numbers**

Run each and write down the count each one reports:

```bash
npm run lint
npm run typecheck
npm run build
npm test
npm run db:test
npm run test:isolation
npm run test:e2e
```

The isolation suite must say guard-complete. Its known flake (Block 4b, live and uncaused) may need a second run; if it does, that goes in the report.

- [ ] **Step 5: Write the report and the runbook**

`docs/block-6d-report.md`, following `docs/block-6c-report.md`'s shape: what shipped, the gate table with **the numbers measured after the fact, not predicted**, decisions taken during implementation, concerns recorded rather than fixed, and what is deferred.

It must state, because they are true and a reader will otherwise assume otherwise:

- nothing notifies anybody; the reminder is in the Templates block, and why (the 24-hour window and Meta's template requirement);
- `get_draw` and `list_pickups` disagree about whether `promotions.view` alone may read a listener's name, and the disagreement is deliberate;
- `reopen_pickup_deadline` answers `42501` where its 6b siblings answer `P0002`, and the eight older migrations still carry the leak;
- `decodeCursor` is fixed, so the count of screens sharing that hole went from four to zero.

`docs/block-6d-runbook.md`, following `docs/block-6b-runbook.md`: how to confirm the schedule is installed (`select * from cron.job where jobname = 'pickup-deadline-sweep'`), how to read a run (`cron.job_run_details`), how to run the sweep by hand, what an operator sees when a deadline expires, and the hour of latency between expiry and the sweep.

- [ ] **Step 6: Commit**

```bash
git add tests/e2e/deadline.spec.ts docs/block-6d-report.md docs/block-6d-runbook.md
git commit -m "test(deadline): the whole journey, and the documents that record it"
```

---

## Task 12: The third door — a cancelled draw awards nothing

**Added mid-execution**, on the owner's ruling of 2026-08-03, after Task 5's review reproduced a stock theft this block had only half closed.

**Files:**
- Create: `supabase/migrations/0097_cancelled_draw_awards_nothing.sql`
- Modify: `supabase/tests/12_deadline_clock.test.sql`
- Read for reference: `supabase/migrations/0079_cancel_draw.sql`, `supabase/migrations/0092_return_pending_transitions.sql`, `supabase/migrations/0084_deliver_prize.sql`

**Interfaces:**
- Consumes: `apply_winner_transition(uuid, public.winner_status, text, timestamptz)` from Task 2.
- Produces: no new signature. The same function, refusing one more thing.

**Why this exists.** `cancel_draw` (`0079`) returns a draw's units from `awaiting_pickup` to `linked` and marks `draws.status = 'CANCELLED'`, but **deliberately leaves its winners at `AWAITING_PICKUP`** — 6a had no vocabulary for "un-awarded" and said so in the migration. Nothing read those rows as live, so the hole was inert.

Block 6d added two readers that do — `list_pickups` and `sweep_pickup_deadlines` — and Task 5 shut both. But a third door was already open before this block and is still open: **`deliver_prize` and `apply_winner_transition` never consult `draws.status`**, and `get_draw` still lists a cancelled draw's winners on the draw-detail screen. Task 5's reviewer reproduced the theft with Task 5's fix in place: delivering the phantom moved the balance to `delivered`, after which the genuinely live winner's delivery failed with `only 0 unit(s) are in awaiting_pickup`.

The two Task 5 exclusions stay. They keep the sweep from ever attempting a doomed movement, which is what stops the hourly job going permanently red. This task closes the boundary underneath them.

- [ ] **Step 1: Write the failing tests**

Append to `supabase/tests/12_deadline_clock.test.sql`, raising the plan by the number you add. Build a draw for one listener, cancel it through `public.cancel_draw`, then assert every transition is refused:

```sql
-- A cancelled draw awards nothing. 0079 leaves its winners AWAITING_PICKUP on
-- purpose -- it had no vocabulary for "un-awarded" -- and returns their units
-- to `linked`. So every one of these would move a unit that is not there:
-- either failing on the balance CHECK, or SUCCEEDING against a unit that
-- belongs to a different, live winner of the same prize. The second is silent,
-- and is what Task 5's review reproduced.
select throws_ok($$
  select public.apply_winner_transition(
    pg_temp.cancelled_winner(), 'DELIVERED'::public.winner_status, 'walk-in')
$$, '22023', 'this prize was un-awarded when its draw was cancelled',
  'a cancelled draw''s winner cannot be handed the prize');

select throws_ok($$
  select public.apply_winner_transition(
    pg_temp.cancelled_winner(), 'RETURN_PENDING'::public.winner_status, 'pickup deadline expired')
$$, '22023', 'this prize was un-awarded when its draw was cancelled',
  'and cannot have its deadline expire');

select throws_ok($$
  select public.apply_winner_transition(
    pg_temp.cancelled_winner(), 'RETURNED'::public.winner_status, 'tidying up')
$$, '22023', 'this prize was un-awarded when its draw was cancelled',
  'and cannot be returned to stock, because it never left it');

select throws_ok($$
  select public.apply_winner_transition(
    pg_temp.cancelled_winner(), 'WRITTEN_OFF'::public.winner_status, 'tidying up')
$$, '22023', 'this prize was un-awarded when its draw was cancelled',
  'and cannot be written off');
```

**Pin the message on all four.** `22023` is shared by every guard in this function, so an unpinned `throws_ok` would pass on the wrong refusal — the exact defect this block shipped once already in Task 2.

Define `pg_temp.cancelled_winner()` alongside the file's existing `pg_temp.winner_of(text)` helper, returning the winner id of the cancelled draw's listener.

Then the case that proves the guard is not too wide:

```sql
select lives_ok($$
  select public.apply_winner_transition(
    pg_temp.winner_of('Maria 6d'), 'RETURN_PENDING'::public.winner_status, 'pickup deadline expired')
$$, 'a winner whose draw still stands is unaffected');
```

- [ ] **Step 2: Run and watch them fail**

Run: `npm run db:test`
Expected: the four `throws_ok` fail — currently these transitions all succeed, which is the defect.

- [ ] **Step 3: Write the migration**

`supabase/migrations/0097_cancelled_draw_awards_nothing.sql`. `apply_winner_transition` gains one lookup and one refusal. Its signature does not change, so `create or replace` is enough — no drop, and the ACL and comment survive.

The function already joins `public.draws d on d.id = w.draw_id` to reach `organization_id`. Select `d.status` in that same query into a new `v_draw_status` variable, and refuse immediately after the not-found check, **before** the `p_to = v_from` check and before any branch:

```sql
  -- 0079 cancels a draw by returning its units to `linked` and marking the
  -- draw CANCELLED, while deliberately leaving its winners AWAITING_PICKUP.
  -- Those rows are a record of what was cancelled, not a claim on stock, and
  -- every transition below would move a unit that is no longer there --
  -- failing on the balance CHECK when no other winner holds one, and
  -- SUCCEEDING against somebody else's unit when one does. The second is
  -- silent, and is the reason this refusal is in the core rather than in the
  -- doors: a screen that forgets to ask is then merely inconvenient.
  if v_draw_status = 'CANCELLED' then
    raise exception 'this prize was un-awarded when its draw was cancelled'
      using errcode = '22023';
  end if;
```

Re-issue nothing else. Update the `comment on function` to name the new refusal alongside the others.

- [ ] **Step 4: Run and watch them pass**

Run: `npm run db:reset && npm run db:test`
Expected: PASS, every file. `10_delivery.test.sql` and `09_draws.test.sql` must be unaffected — their winners belong to draws that stand.

- [ ] **Step 5: Prove it by mutation**

Remove the new refusal, re-run, and confirm the four new assertions go red and the `lives_ok` stays green. Restore. Record the real output in the report — this block has repeatedly shipped assertions that passed without exercising anything, and the mutation is the only thing that settles it.

- [ ] **Step 6: Check whether the screen still offers the button**

`src/components/draws/winner-actions.tsx` decides which actions a winner's row offers, as a courtesy — the RPC is the boundary and now refuses. Find out whether the draw-detail screen has the draw's status available to it (`get_draw`, `0080`, returns the draw). If it does, make `availableWinnerActions` return `[]` for a cancelled draw and add the unit test. If it does not, do NOT plumb it through here — write the finding in your report and it becomes a note for Task 9, which is already building a screen over these actions.

- [ ] **Step 7: Commit**

```bash
git add supabase/migrations/0097_cancelled_draw_awards_nothing.sql supabase/tests/12_deadline_clock.test.sql
git commit -m "fix(draw): a cancelled draw awards nothing, and the core says so"
```

---

## Self-Review Notes

Checked against the spec, section by section:

| Spec | Task |
|---|---|
| D1 `RETURN_PENDING` rests in the bucket | 1, 2 |
| D2 the way back | 2, 8, 9 |
| D3 only the reopen writes `deadline_at` | 2 (and its test, which asserts the other transitions do not) |
| D4 its own permission | 3 |
| D5 SQL, scheduled directly, hourly | 4 |
| D6 commit per winner | 4 (and the poisoned-winner test) |
| D7 both lists `SECURITY DEFINER`, rules re-stated, isolation in the same task | 5, 6 |
| D8 `decodeCursor` | 7 |
| §3.1 enum values alone | 1 |
| §3.2 ledger arm | 2 |
| §3.3 no new columns on `winners` | nothing adds any |
| §4 the state machine | 2 |
| §4.1 the door | 3 |
| §5 the clock | 4 |
| §6.1 navigation | 9, 10 |
| §6.2 Pickups | 9 |
| §6.3 Movements | 10 |
| §7 verification | every task; totals in 11 |
| §7.1 migrations `0091`–`0096` | 1–6 |
| §7.2 inherited items | 11 (recorded, not fixed) |
| §8 out of scope | nothing implements a notification |

**Two things a fresh reader should not mistake:**

`WinnerPowers` gains `reopenDeadline` in Task 8, which means every existing
construction of that object — in `draw-detail.tsx` and its tests — needs the new
field or `tsc` fails. That is the intended blast radius, not a surprise.

The pgTAP fixture ids are `...00d0xx`, `...00d1xx` and `...00d2xx`. `09_draws`
owns `...00a0xx`–`...00a3xx` and `10_delivery` owns `...00b0xx`; a collision
fails in whichever file runs second, which is a confusing way to find out.
