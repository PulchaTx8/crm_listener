# Block 23 — Prize record tabs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the prize record dialog on `/inventory` into five tabs — the
record, entries, exits, reservations and one unified history — with invoice data
on entries, a reversal for entries and exits, and reservations that carry an
owner and an identity.

**Architecture:** The ledger stays immutable and stays the single source of every
balance. "Archiving" writes a compensating movement rather than deleting or
flagging one. Five new columns on `inventory_movements` carry the invoice, the
programme a reservation is held for, and the pointer from a reversal to what it
reverses. Every write still goes through `apply_inventory_movement`, and every
read through one widened `list_movements`.

**Tech Stack:** Next.js 15 (App Router, Server Components, Server Actions),
React 19, TypeScript, Supabase (Postgres + PostgREST + RLS), next-intl, Zod 3,
Vitest, Playwright, pgTAP.

**Spec:** `docs/superpowers/specs/2026-08-14-block-23-prize-record-tabs-design.md` —
read it before Task 1. Decisions are referenced below as D1…D12.

## Global Constraints

- **Migrations are append-only and numbered.** The next free numbers are `0192`
  through `0196`. Never edit a migration that has shipped.
- **`inventory_movements` is immutable BY GRANT** — `0026`'s own comment: "No
  role holds UPDATE or DELETE on it — the immutability is a grant, not a
  convention." Nothing in this block updates a movement row. "This entry was
  reversed" is DERIVED from the existence of a row pointing at it, never stored
  on it.
- **`apply_inventory_movement` is the single writer.** Every door goes through
  it; it maintains the `inventory_balances` projection and refuses a movement
  that would drive a bucket negative. No door in this block writes
  `inventory_movements` directly.
- **The enumerated `inventory_movements_legal_transition` constraint is
  extended, never bypassed.** It is what makes an illegal bucket transition
  unrepresentable.
- **A value added by `ALTER TYPE … ADD VALUE` cannot be USED in the same
  transaction.** Supabase runs one migration file per transaction, so `0192`
  adds the two enum values and nothing else.
- **Permission before existence**, `22023` for a business refusal, `42501` for a
  missing permission, `security definer` + `set search_path = pg_catalog,
  public`, `revoke … from public` then `grant … to authenticated` — the house
  rules every migration in this repository follows.
- **Code, comments, commit messages and documentation in English.** UI copy goes
  through `next-intl`; every key exists in `messages/en.json`, `pt.json` and
  `es.json` or `tests/unit/i18n/catalogue.test.ts` fails.
- **Gate order:** `npm run typecheck`, `npm run lint`, `npm test`,
  `npm run db:reset`, `npm run db:test`, `npm run seed:branding`,
  `npm run test:e2e`, `npm run test:isolation`. `db:test` after the reset and
  never after an e2e run.
- **Run every suite in the foreground** with an explicit long timeout. Never run
  two things against the database at once.
- **Branch:** `block-23-prize-record-tabs`, already created off `main`.
- **Commit after every task.**

---

## File Structure

**Created**

| Path | Responsibility |
|---|---|
| `supabase/migrations/0192_inventory_movement_types.sql` | The two enum values, alone |
| `supabase/migrations/0193_inventory_movement_columns.sql` | Five columns, their constraints, two indexes, the widened transition check |
| `supabase/migrations/0194_inventory_doors_widened.sql` | `apply_inventory_movement` and the four existing doors, widened |
| `supabase/migrations/0195_reverse_movement.sql` | `reverse_movement` |
| `supabase/migrations/0196_list_movements_tabs.sql` | `list_movements`, dropped and recreated |
| `supabase/tests/52_inventory_tabs.test.sql` | pgTAP for everything above |
| `src/app/(app)/inventory/entries-tab.tsx` | The Entradas form and its history |
| `src/app/(app)/inventory/exits-tab.tsx` | The Saídas form and its history |
| `src/app/(app)/inventory/reservations-tab.tsx` | The Reservas form, its dependent control, its history |
| `src/app/(app)/inventory/movement-history.tsx` | The one history list all four tabs render |
| `tests/isolation/inventory-reversal.test.ts` | `reverse_movement` across two Stations |

**Modified**

| Path | Change |
|---|---|
| `src/lib/record-params.ts` | `PRIZE_TABS` gains three entries |
| `src/lib/supabase/database.types.ts` | Regenerated |
| `src/services/inventory.ts` | Movement types, the new fields, the new doors |
| `src/app/(app)/inventory/actions.ts` | Actions for the widened doors and the reversal |
| `src/app/(app)/inventory/prize-record-dialog.tsx` | Five tabs; the four forms leave the data tab |
| `src/app/(app)/inventory/stock-entry-form.tsx` | Type, invoice, unit and total |
| `src/app/(app)/inventory/stock-exit-form.tsx` | Type |
| `src/app/(app)/inventory/reservation-forms.tsx` | Three types and the dependent control |
| `src/app/(app)/inventory/movements/*` | The period and type filters |
| `messages/{en,pt,es}.json` | All new copy, added once in Task 5 |
| `tests/e2e/inventory-flow.spec.ts` | The five-tab journey |

---

### Task 1: The enum values and the columns

**Files:**
- Create: `supabase/migrations/0192_inventory_movement_types.sql`
- Create: `supabase/migrations/0193_inventory_movement_columns.sql`
- Create: `supabase/tests/52_inventory_tabs.test.sql`

**Interfaces:**
- Consumes: nothing.
- Produces: `BARTER_ENTRY` and `TRANSFER_EXIT` on
  `public.inventory_movement_type`; on `public.inventory_movements` the columns
  `invoice_number`, `unit_amount`, `total_amount`, `reserved_for_show_id`,
  `reverses_movement_id`.

- [ ] **Step 1: Write the failing test**

Create `supabase/tests/52_inventory_tabs.test.sql`:

```sql
begin;
select plan(8);

-- Block 23, Task 1. The columns, and the constraints that keep each of them on
-- the movement kinds it belongs to.

insert into public.organizations (id, name) values
  ('00000000-0000-0000-0000-0000000023f1', 'Org 23 tabs');
insert into public.companies (id, organization_id, name, timezone) values
  ('00000000-0000-0000-0000-0000000023c1', '00000000-0000-0000-0000-0000000023f1',
   'Station 23 tabs', 'America/Sao_Paulo');
insert into public.prizes (id, organization_id, company_id, name) values
  ('00000000-0000-0000-0000-0000000023d1', '00000000-0000-0000-0000-0000000023f1',
   '00000000-0000-0000-0000-0000000023c1', 'Camiseta 23');
insert into public.shows (id, organization_id, company_id, name) values
  ('00000000-0000-0000-0000-0000000023aa', '00000000-0000-0000-0000-0000000023f1',
   '00000000-0000-0000-0000-0000000023c1', 'Programa da Tarde');

-- 1-2: the two new movement types exist in the vocabulary.
select is(
  (select count(*)::int from pg_enum e
     join pg_type t on t.oid = e.enumtypid
    where t.typname = 'inventory_movement_type' and e.enumlabel = 'BARTER_ENTRY'),
  1, 'BARTER_ENTRY is part of the movement vocabulary');
select is(
  (select count(*)::int from pg_enum e
     join pg_type t on t.oid = e.enumtypid
    where t.typname = 'inventory_movement_type' and e.enumlabel = 'TRANSFER_EXIT'),
  1, 'TRANSFER_EXIT is part of the movement vocabulary');

-- 3: a barter entry writes the same bucket pair a purchase does, so the widened
-- transition constraint accepts it.
select lives_ok($$
  insert into public.inventory_movements
    (organization_id, company_id, prize_id, movement_type, quantity, from_bucket, to_bucket,
     invoice_number, unit_amount, total_amount)
  values
    ('00000000-0000-0000-0000-0000000023f1', '00000000-0000-0000-0000-0000000023c1',
     '00000000-0000-0000-0000-0000000023d1', 'BARTER_ENTRY', 10, null, 'available',
     'NF-1', 10.00, 100.00)
$$, 'a barter entry lands with its invoice');

-- 4: and a transfer exit takes available away, like a manual exit.
select lives_ok($$
  insert into public.inventory_movements
    (organization_id, company_id, prize_id, movement_type, quantity, from_bucket, to_bucket)
  values
    ('00000000-0000-0000-0000-0000000023f1', '00000000-0000-0000-0000-0000000023c1',
     '00000000-0000-0000-0000-0000000023d1', 'TRANSFER_EXIT', 1, 'available', null)
$$, 'a transfer exit lands');

-- 5: the invoice trio is refused on a movement that is not an entry. This is
-- the constraint that stops "how much did we spend" from summing over rows that
-- were never a purchase.
select throws_ok($$
  insert into public.inventory_movements
    (organization_id, company_id, prize_id, movement_type, quantity, from_bucket, to_bucket,
     invoice_number)
  values
    ('00000000-0000-0000-0000-0000000023f1', '00000000-0000-0000-0000-0000000023c1',
     '00000000-0000-0000-0000-0000000023d1', 'RESERVATION', 1, 'available', 'reserved', 'NF-2')
$$, '23514', null, 'an invoice number is refused on anything but an entry');

-- 6: a programme belongs to a reservation and nowhere else.
select throws_ok($$
  insert into public.inventory_movements
    (organization_id, company_id, prize_id, movement_type, quantity, from_bucket, to_bucket,
     reserved_for_show_id)
  values
    ('00000000-0000-0000-0000-0000000023f1', '00000000-0000-0000-0000-0000000023c1',
     '00000000-0000-0000-0000-0000000023d1', 'MANUAL_EXIT', 1, 'available', null,
     '00000000-0000-0000-0000-0000000023aa')
$$, '23514', null, 'a programme is refused on anything but a reservation');

-- 7: a reservation CAN name one.
select lives_ok($$
  insert into public.inventory_movements
    (organization_id, company_id, prize_id, movement_type, quantity, from_bucket, to_bucket,
     reserved_for_show_id)
  values
    ('00000000-0000-0000-0000-0000000023f1', '00000000-0000-0000-0000-0000000023c1',
     '00000000-0000-0000-0000-0000000023d1', 'RESERVATION', 2, 'available', 'reserved',
     '00000000-0000-0000-0000-0000000023aa')
$$, 'a reservation names the programme it is held for');

-- 8: one entry is reversed once. The second reversal collides on the unique
-- index rather than on a check somebody has to remember to write.
select throws_ok($$
  insert into public.inventory_movements
    (organization_id, company_id, prize_id, movement_type, quantity, from_bucket, to_bucket,
     reverses_movement_id)
  select '00000000-0000-0000-0000-0000000023f1', '00000000-0000-0000-0000-0000000023c1',
         '00000000-0000-0000-0000-0000000023d1', 'MANUAL_EXIT', 10, 'available', null, m.id
    from public.inventory_movements m
   where m.movement_type = 'BARTER_ENTRY'
   union all
  select '00000000-0000-0000-0000-0000000023f1', '00000000-0000-0000-0000-0000000023c1',
         '00000000-0000-0000-0000-0000000023d1', 'MANUAL_EXIT', 10, 'available', null, m.id
    from public.inventory_movements m
   where m.movement_type = 'BARTER_ENTRY'
$$, '23505', null, 'a movement cannot be reversed twice');

select * from finish();
rollback;
```

- [ ] **Step 2: Run it to make sure it fails**

```bash
npm run db:reset && npm run db:test
```

Expected: fails — `BARTER_ENTRY` is not a member of the enum.

- [ ] **Step 3: Write `0192` — the two values, alone**

```sql
-- supabase/migrations/0192_inventory_movement_types.sql

-- Block 23, Task 1: two words the stock vocabulary was missing.
--
-- ALONE IN THIS FILE, AND THAT IS NOT TIDINESS. PostgreSQL refuses to USE a
-- value added by ALTER TYPE ... ADD VALUE inside the transaction that added it,
-- and Supabase runs one migration file per transaction. A single file that adds
-- BARTER_ENTRY and then writes a check constraint naming 'BARTER_ENTRY' fails
-- with "unsafe use of new value of enum type" on every machine, every db:reset.
-- 0193 is the file that reads them.
--
-- Both are the owner's decision of 2026-08-14 (design D4): the operator picks
-- from a fixed list rather than typing a reason, so that "how much came in by
-- barter this year" is a sum rather than a search through free text.

alter type public.inventory_movement_type add value 'BARTER_ENTRY';
alter type public.inventory_movement_type add value 'TRANSFER_EXIT';
```

- [ ] **Step 4: Write `0193` — the columns and the constraints**

```sql
-- supabase/migrations/0193_inventory_movement_columns.sql

-- Block 23, Task 1: what a movement can now carry, and where each of those
-- things is forbidden.
--
-- NOTHING HERE MAKES A MOVEMENT MUTABLE. 0026's own comment states the rule:
-- "No role holds UPDATE or DELETE on it — the immutability is a grant, not a
-- convention." So "this entry was reversed" is never written onto the entry.
-- It is the existence of another row pointing at it, and 0196's read derives
-- it. A column on the original would be a column no door could ever set.

alter table public.inventory_movements
  -- The invoice, on entries only (design D3). One prize per entry: an invoice
  -- covering three prizes is three rows repeating its number, which is what the
  -- owner chose over a document-with-items model, because this dialog belongs
  -- to one prize and is the wrong place to type another prize's line.
  add column invoice_number       text,
  add column unit_amount          numeric(12,2),
  add column total_amount         numeric(12,2),
  -- The programme a reservation is held for (design D7). A programme
  -- reservation is a reservation with an owner and nothing more: bucket
  -- `reserved`, no binding table, no delivery, no deadline. A promotion is the
  -- other thing entirely and goes through the promotion link, which already
  -- exists.
  add column reserved_for_show_id uuid,
  -- "This movement undoes that one" (design D1 and D2). One column for the
  -- entry reversal, the exit reversal and the reservation release alike, rather
  -- than three mechanisms that can drift.
  add column reverses_movement_id uuid references public.inventory_movements (id),

  add constraint inventory_movements_show_company_fk
    foreign key (reserved_for_show_id, company_id)
    references public.shows (id, company_id),

  -- Each of the three constraints below is the shape 0045 established for
  -- promotion_prize_id: the column is permitted on exactly the movement kinds
  -- it means something for, and null everywhere else. A nullable column with no
  -- such constraint is a column that eventually holds a value nobody can
  -- interpret.
  add constraint inventory_movements_invoice_reference check (
    (movement_type in ('INITIAL_ENTRY', 'PURCHASE_ENTRY', 'MANUAL_ENTRY', 'BARTER_ENTRY'))
    or (invoice_number is null and unit_amount is null and total_amount is null)
  ),
  add constraint inventory_movements_show_reference check (
    movement_type = 'RESERVATION' or reserved_for_show_id is null
  ),
  add constraint inventory_movements_reversal_reference check (
    (movement_type in ('MANUAL_ENTRY', 'MANUAL_EXIT', 'RESERVATION_RELEASE'))
    or reverses_movement_id is null
  ),
  add constraint inventory_movements_amounts_nonnegative check (
    (unit_amount is null or unit_amount >= 0)
    and (total_amount is null or total_amount >= 0)
  );

comment on column public.inventory_movements.invoice_number is
  'The supplier invoice this entry came in on. Repeated across the entries of one invoice covering several prizes (design D3) and indexed, so grouping them later is a screen rather than a data migration.';
comment on column public.inventory_movements.reserved_for_show_id is
  'The programme a reservation is held for. A programme reservation separates and labels stock and does nothing else on its own — somebody from that programme writes it off through the Exits tab when it is handed over (design D7).';
comment on column public.inventory_movements.reverses_movement_id is
  'The movement this one undoes. Set on an entry or exit reversal and on a reservation release; null everywhere else. The original is never updated — it cannot be, and does not need to be.';

-- ONE ENTRY IS REVERSED ONCE. Partial and excluding releases on purpose: a
-- reservation is released in instalments, so several releases legitimately point
-- at one reservation, while a second reversal of one entry is a double refund.
-- The door checks this too, for the message; the index is what makes it true.
create unique index inventory_movements_reversal_unique
  on public.inventory_movements (reverses_movement_id)
  where reverses_movement_id is not null
    and movement_type <> 'RESERVATION_RELEASE';

create index inventory_movements_invoice_idx
  on public.inventory_movements (company_id, invoice_number)
  where invoice_number is not null;

-- The enumerated transition check, widened. DROP and ADD rather than a second
-- constraint beside it: two constraints describing the same thing is how one of
-- them stops being read. BARTER_ENTRY takes PURCHASE_ENTRY's pair and
-- TRANSFER_EXIT takes MANUAL_EXIT's — a barter still arrives into available and
-- a transfer still leaves it.
alter table public.inventory_movements
  drop constraint inventory_movements_legal_transition;

alter table public.inventory_movements
  add constraint inventory_movements_legal_transition check (
       (movement_type in ('INITIAL_ENTRY', 'PURCHASE_ENTRY', 'MANUAL_ENTRY',
                          'BARTER_ENTRY', 'ADJUSTMENT_POSITIVE')
          and from_bucket is null and to_bucket = 'available')
    or (movement_type in ('MANUAL_EXIT', 'TRANSFER_EXIT', 'ADJUSTMENT_NEGATIVE')
          and from_bucket = 'available' and to_bucket is null)
    or (movement_type = 'RESERVATION'
          and from_bucket = 'available' and to_bucket = 'reserved')
    or (movement_type = 'RESERVATION_RELEASE'
          and from_bucket = 'reserved' and to_bucket = 'available')
    or (movement_type = 'PROMOTION_LINK'
          and from_bucket = 'available' and to_bucket = 'linked')
    or (movement_type = 'PROMOTION_UNLINK'
          and from_bucket = 'linked' and to_bucket = 'available')
    or (movement_type = 'DRAW'
          and from_bucket = 'linked' and to_bucket = 'awaiting_pickup')
    or (movement_type = 'DRAW_CANCEL'
          and from_bucket = 'awaiting_pickup' and to_bucket = 'linked')
    or (movement_type = 'DELIVERY'
          and from_bucket = 'awaiting_pickup' and to_bucket = 'delivered')
    or (movement_type = 'RETURN_PENDING'
          and from_bucket = 'awaiting_pickup' and to_bucket = 'pending_return')
    or (movement_type = 'RETURN_TO_STOCK'
          and from_bucket = 'pending_return' and to_bucket = 'available')
    or (movement_type = 'WRITE_OFF'
          and from_bucket in ('pending_return', 'awaiting_pickup') and to_bucket = 'written_off')
  );
```

**Read the live constraint before writing this.** The block above is `0026`'s
text with two branches widened; if the constraint has been amended since `0026`,
dump the live definition (`pg_get_constraintdef`) and widen THAT instead.
Recreating it from an old migration would silently revert whatever came after.

- [ ] **Step 5: Run the tests**

```bash
npm run db:reset && npm run db:test
```

Expected: `52_inventory_tabs` reports `ok 1..8`, and every other pgTAP file still
passes — `08_*` through `13_*` exercise this table heavily.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/0192_inventory_movement_types.sql supabase/migrations/0193_inventory_movement_columns.sql supabase/tests/52_inventory_tabs.test.sql
git commit -m "feat(db): a movement can carry its invoice, its programme and what it undoes"
```

---

### Task 2: The widened writer and the widened doors

**Files:**
- Create: `supabase/migrations/0194_inventory_doors_widened.sql`
- Modify: `supabase/tests/52_inventory_tabs.test.sql`

**Interfaces:**
- Consumes: Task 1's columns and enum values.
- Produces:
  - `apply_inventory_movement(uuid, uuid, inventory_movement_type, integer, inventory_bucket, inventory_bucket, text, text, text, numeric, numeric, uuid, uuid)` — the eight it had, then `p_invoice_number`, `p_unit_amount`, `p_total_amount`, `p_show_id`, `p_reverses`, all defaulted to null
  - `record_stock_entry(uuid, uuid, inventory_movement_type, integer, text, text, text, numeric, numeric)`
  - `record_stock_exit(uuid, uuid, integer, text, text, inventory_movement_type)`
  - `reserve_stock(uuid, uuid, integer, text, text, uuid)`
  - `release_reservation(uuid, uuid, integer, text, text, uuid)`

- [ ] **Step 1: Write the failing test**

Change `select plan(8);` to `select plan(16);` and append before
`select * from finish();`. The fixture needs an identity holding the inventory
codes — read `supabase/tests/08_*` or `13_*` for how this file family provisions
one, and follow it rather than inventing a shape.

Eight assertions, each falsifying a specific broken door:

1. `record_stock_entry` with `PURCHASE_ENTRY` and an invoice stores all three
   invoice columns.
2. The same call with `BARTER_ENTRY` stores the type as barter, so the two are
   distinguishable in a later sum.
3. `record_stock_exit` with `TRANSFER_EXIT` writes that type, not `MANUAL_EXIT`.
4. `reserve_stock` with a programme stores `reserved_for_show_id`.
5. `reserve_stock` without one stores null — an anonymous hold is not a
   programme hold with a missing name.
6. `release_reservation` naming a reservation stores `reverses_movement_id`
   pointing at it.
7. `release_reservation` for more than the reservation has left is refused with
   `22023`.
8. A second `release_reservation` on the same reservation, within what remains,
   succeeds — releases are instalments, and the unique index must not have
   caught them.

- [ ] **Step 2: Run it to make sure it fails**

```bash
npm run db:reset && npm run db:test
```

Expected: fails — `record_stock_entry` has no `p_invoice_number`.

- [ ] **Step 3: Write the migration**

`apply_inventory_movement` first. **It must be DROPPED and recreated, not
`create or replace`d**: `CREATE OR REPLACE FUNCTION` with a different argument
count creates an OVERLOAD rather than replacing, and the repository would then
hold two writers, one of which silently ignores the new columns.

```sql
drop function if exists public.apply_inventory_movement(
  uuid, uuid, public.inventory_movement_type, integer,
  public.inventory_bucket, public.inventory_bucket, text, text);
```

The recreated body is the live one — dump it with `pg_get_functiondef` — with
five appended parameters, all defaulted to null, threaded into its INSERT.
Existing callers pass eight positional arguments and resolve to the new function
unchanged; that is the whole reason the new parameters are appended rather than
inserted.

Then the four doors, each `create or replace` where the argument list is
unchanged or only appended-with-defaults, and dropped-and-recreated where a
parameter lands in the middle. State which you did for each, in the migration's
own comments.

Each door's widening is small and the rules are in the spec's §5. The two that
carry real logic:

- **`record_stock_entry`** already takes `p_type`; it gains only the invoice
  trio, and it must refuse a type that is not an entry (it does not today —
  check, and if it does not, this block is where it starts, because the invoice
  constraint would otherwise reject the row with a constraint error rather than
  a sentence).
- **`release_reservation`** gains `p_reservation_id` and the arithmetic that
  makes D5 true: the reservation's quantity minus the sum of releases already
  pointing at it, and a refusal naming the remainder when the request exceeds
  it.

- [ ] **Step 4: Run the tests**

```bash
npm run db:reset && npm run db:test
```

Expected: `52_inventory_tabs` reports `ok 1..16`; every other pgTAP file still
passes, `08_*`–`13_*` included, since they call these doors with their old
argument lists.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/0194_inventory_doors_widened.sql supabase/tests/52_inventory_tabs.test.sql
git commit -m "feat(db): the stock doors learn the invoice, the programme and the reservation"
```

---

### Task 3: `reverse_movement`

**Files:**
- Create: `supabase/migrations/0195_reverse_movement.sql`
- Modify: `supabase/tests/52_inventory_tabs.test.sql`
- Create: `tests/isolation/inventory-reversal.test.ts`

**Interfaces:**
- Consumes: Tasks 1 and 2.
- Produces: `public.reverse_movement(p_movement_id uuid, p_note text) returns uuid`.

- [ ] **Step 1: Write the failing test**

Change `plan(16)` to `plan(24)` and append eight assertions. These are the ones
that matter most in the block — a wrong `reverse_movement` corrupts a balance:

1. An entry of 10 reversed once succeeds, and the prize's available balance
   returns to what it was before the entry.
2. The reversal row carries `reverses_movement_id` naming the entry, and the
   entry's own `invoice_number`.
3. The same entry reversed a second time is refused with `22023`.
4. An entry of 10 whose stock has since left (only 4 available) is refused with
   `22023`, and the message names the shortfall.
5. An exit reversed puts the stock back.
6. A `DRAW` movement is refused — this door is not a general eraser.
7. A `PROMOTION_LINK` is refused, for the same reason.
8. Reversing writes exactly one `audit_logs` row (read after `reset role`;
   `audit_logs` has RLS — precedent `15_music_rpcs.test.sql:109-115`).

- [ ] **Step 2: Run it to make sure it fails**

```bash
npm run db:reset && npm run db:test
```

Expected: `function public.reverse_movement(uuid, text) does not exist`.

- [ ] **Step 3: Write the migration**

```sql
-- supabase/migrations/0195_reverse_movement.sql

-- Block 23, Task 3: the one door behind every Arquivar button.
--
-- THE LEDGER IS NOT EDITED. 0026 grants no role UPDATE or DELETE on
-- inventory_movements, and this door does not want them: reversing writes a
-- SECOND movement in the opposite direction, carrying the original's invoice
-- number so the pair reads as a pair. The balance corrects itself by
-- arithmetic, which is why no other query in this database — the reconciliation
-- panel, the dashboards, the stock list — has to learn that reversals exist.
--
-- The owner chose this over a cancelled_at flag on 2026-08-14 (design D1). The
-- flag reads more simply in one list and moves the definition of "the balance"
-- out of one sum and into every place that computes one.
--
-- WHAT THIS DOOR REFUSES, and why the refusals are the feature:
--   * a movement already reversed -- the unique index in 0193 is the truth, this
--     check is the sentence;
--   * anything that is not a plain entry or exit. A draw, a delivery, a
--     promotion link each have their own screen and their own door, with rules
--     this door does not know. A general-purpose eraser is exactly what a
--     ledger must not have;
--   * a reversal the stock cannot pay for. Reversing an entry of 10 when 4
--     remain available would drive the bucket negative;
--     apply_inventory_movement would refuse it anyway, but with its own generic
--     message -- this door names the number in the way, because that is the
--     refusal an operator will actually meet.

create function public.reverse_movement(p_movement_id uuid, p_note text default null)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor    uuid := auth.uid();
  v_m        public.inventory_movements%rowtype;
  v_needed   text;
  v_new_type public.inventory_movement_type;
  v_id       uuid;
begin
  select * into v_m from public.inventory_movements where id = p_movement_id;

  if not found then
    raise log 'reverse_movement denied: actor=% movement=%', v_actor, p_movement_id;
    raise exception 'permission denied' using errcode = '42501';
  end if;

  -- The permission the ORIGINAL movement's kind required, not a code of this
  -- door's own (design D8's second half): undoing a purchase entry is the same
  -- authority as making one, and a separate inventory.reverse would be a code
  -- nobody holds until somebody remembers to grant it.
  v_needed := case
    when v_m.movement_type in ('INITIAL_ENTRY', 'PURCHASE_ENTRY', 'MANUAL_ENTRY', 'BARTER_ENTRY')
      then 'inventory.entry'
    when v_m.movement_type in ('MANUAL_EXIT', 'TRANSFER_EXIT')
      then 'inventory.exit'
    else null
  end;

  if v_needed is null then
    raise exception 'only a stock entry or a stock exit can be reversed here'
      using errcode = '22023';
  end if;

  if not public.has_permission(v_needed, v_m.company_id) then
    raise log 'reverse_movement denied: actor=% movement=%', v_actor, p_movement_id;
    raise exception 'permission denied: % required', v_needed using errcode = '42501';
  end if;

  perform 1 from public.inventory_movements
   where reverses_movement_id = p_movement_id
     and movement_type <> 'RESERVATION_RELEASE';

  if found then
    raise exception 'this movement has already been reversed' using errcode = '22023';
  end if;

  -- The mirror. An entry is undone by a manual exit and an exit by a manual
  -- entry: the reversal is itself an ordinary movement, so every projection and
  -- every report that already understands entries and exits understands it too.
  v_new_type := case
    when v_m.to_bucket = 'available' then 'MANUAL_EXIT'::public.inventory_movement_type
    else 'MANUAL_ENTRY'::public.inventory_movement_type
  end;

  v_id := public.apply_inventory_movement(
    v_m.company_id, v_m.prize_id, v_new_type, v_m.quantity,
    case when v_new_type = 'MANUAL_EXIT' then 'available' else null end,
    case when v_new_type = 'MANUAL_ENTRY' then 'available' else null end,
    coalesce(p_note, 'reversal'), null,
    v_m.invoice_number, v_m.unit_amount, v_m.total_amount, null, p_movement_id);

  insert into public.audit_logs
    (actor_id, action, target_table, target_id, organization_id, company_id, detail)
  values
    (v_actor, 'reverse_movement', 'inventory_movements', p_movement_id,
     v_m.organization_id, v_m.company_id,
     jsonb_build_object('reversal_id', v_id, 'movement_type', v_m.movement_type));

  return v_id;
end;
$$;
```

**Two things to verify against the live `apply_inventory_movement` before
trusting the block above**, and correct it if either is wrong — say which in
your report:

- whether it refuses a negative bucket with an error this door should catch and
  re-raise with the shortfall named, or whether it returns silently;
- the exact positional order of its five new parameters.

Then `revoke execute … from public` and `grant execute … to authenticated`, plus
the `comment on function`.

- [ ] **Step 4: Write the isolation test**

Create `tests/isolation/inventory-reversal.test.ts`, following
`tests/isolation/inventory.test.ts`'s provisioning shape. Three cases:

1. An operator holding `inventory.entry` in Station A reverses an entry in
   Station A.
2. The same operator, handed a movement id from Station B, is refused. **This is
   the case that matters**: `reverse_movement` takes a movement id and no
   Station, so its whole boundary is the `has_permission` call in its body.
3. An operator holding `inventory.exit` but not `inventory.entry` is refused an
   entry reversal — the permission follows the original movement's kind.

Register the file in `scripts/verify-isolation-suite.mjs`'s
`REQUIRED_TEST_FILES` with `minTests: 3`; that runner enforces a registry, and a
file absent from it is never demanded.

- [ ] **Step 5: Run the tests**

```bash
npm run db:reset && npm run db:test
npm run db:reset && npm run test:isolation
```

Both green. If the isolation run dies with "Worker exited unexpectedly" on a file
you did not touch, that is this repository's documented flake — re-run.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/0195_reverse_movement.sql supabase/tests/52_inventory_tabs.test.sql tests/isolation/inventory-reversal.test.ts scripts/verify-isolation-suite.mjs
git commit -m "feat(db): a stock entry or exit can be undone, by writing its opposite"
```

---

### Task 4: The read, and the service layer

**Files:**
- Create: `supabase/migrations/0196_list_movements_tabs.sql`
- Modify: `src/lib/supabase/database.types.ts` (generated)
- Modify: `src/services/inventory.ts`
- Modify: `tests/unit/movement-params.test.ts`

**Interfaces:**
- Consumes: Tasks 1–3.
- Produces: `list_movements` returning the five new columns plus
  `reversed_at`, `reversal_id`, `remaining_quantity` and `show_name`; and in
  `src/services/inventory.ts` the matching fields on the movement summary type,
  plus `reverseMovement`, and the widened entry/exit/reserve/release callers.

- [ ] **Step 1: Dump the live definition first — do not skip**

`list_movements` `returns table`, so it is dropped and recreated. **The body
comes from `pg_get_functiondef` against the live database**, never from `0096`.
This repository has had a shipped fix reverted by copying a function body
forward from an older migration; the discipline is recorded in
`copiar-corpo-de-funcao-para-frente`.

After `npm run db:reset`, dump it with a throwaway node script under the
scratchpad directory connecting to `postgresql://postgres:postgres@127.0.0.1:54322/postgres`
(the `pg` package is a devDependency), diff it against `0096`, and say in your
report whether they agree. If they do not, the live definition wins and that
matters — it means a later migration changed this function.

- [ ] **Step 2: Write the failing tests**

Change `plan(24)` to `plan(30)` and append six assertions:

1. The list returns `invoice_number`, `unit_amount` and `total_amount` on an
   entry that has them.
2. A reversed entry reports a non-null `reversed_at` and the `reversal_id`.
3. Its reversal reports `reverses_movement_id` naming the entry.
4. A reservation reports `remaining_quantity` equal to its quantity minus the
   releases pointing at it — assert it after a partial release, where a wrong
   implementation returning the raw quantity gives a different number.
5. A reservation held for a programme reports the programme's `show_name`.
6. The movement-type filter narrows to one kind, and the period filter narrows
   by date.

- [ ] **Step 3: Write the migration and regenerate the types**

Drop the old signature explicitly, recreate from the dumped body with the new
returned columns and two new parameters (`p_types` as an array of
`inventory_movement_type`, `p_from`/`p_to` as timestamps if the live definition
does not already have them — check; the movements screen has filters today).

`reversed_at` and `reversal_id` come from a `left join lateral` onto the
reversal row; `remaining_quantity` from a correlated sum over releases.
**Neither is stored** — Task 1's migration says why.

Then:

```bash
npm run db:reset && npm run db:types && npm run typecheck
```

- [ ] **Step 4: Write the service layer**

`src/services/inventory.ts` gains the new fields on its movement summary type
and a thin `reverseMovement(movementId, accessToken)` beside the existing
writers, mapping errors through this module's existing `mapInventoryError`. Do
not add a second error taxonomy.

- [ ] **Step 5: Run the tests**

```bash
npm run db:reset && npm run db:test
npm test
npm run typecheck
```

Expected: pgTAP `ok 1..30`; the unit suite green; `typecheck` fails only in the
inventory screen files, which belong to Tasks 5–8. Report the exact list.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/0196_list_movements_tabs.sql src/lib/supabase/database.types.ts src/services/inventory.ts tests/unit/movement-params.test.ts
git commit -m "feat(inventory): the movements read carries the invoice, the programme and the reversal"
```

---

### Task 5: Five tabs, and the copy they all read

**Files:**
- Modify: `src/lib/record-params.ts`
- Modify: `src/app/(app)/inventory/prize-record-dialog.tsx`
- Create: `src/app/(app)/inventory/movement-history.tsx`
- Modify: `messages/en.json`, `messages/pt.json`, `messages/es.json`

**Interfaces:**
- Consumes: Task 4's service fields.
- Produces:
  - `PRIZE_TABS = ['data', 'entries', 'exits', 'reservations', 'movements']`
  - `export function MovementHistory({ movements, timeZone, onReverse, emptyMessage }): JSX.Element`
  - every message key Tasks 5–8 read.

- [ ] **Step 1: Widen the tab tuple**

In `src/lib/record-params.ts`:

```ts
export const PRIZE_TABS = ['data', 'entries', 'exits', 'reservations', 'movements'] as const;
```

That file's own comment records the rule: **append, never insert**, because the
first element is where an unknown `tab=` lands and where a record opens. `data`
stays first, so no existing link changes meaning, and `movements` stays a legal
value so any link already pointing at it still resolves.

- [ ] **Step 2: Add the copy to all three catalogues**

Into the `inventory` object of `messages/en.json`:

```json
"stockEntries": "Entries",
"stockExits": "Exits",
"stockReservations": "Reservations",
"entryType": "Type",
"entryPurchase": "Purchase",
"entryBarter": "Barter",
"stockAdjustment": "Stock adjustment",
"exitTransfer": "Send to another station",
"invoiceNumber": "Invoice",
"unitAmount": "Unit price",
"totalAmount": "Total",
"reservationTypeReserve": "Reserve",
"reservationTypeProgramme": "Link to programme",
"reservationTypePromotion": "Link to promotion",
"programme": "Programme",
"promotion": "Promotion",
"performedBy": "By",
"archiveMovement": "Archive",
"archiveThisMovement": "Archive this movement?",
"archiveWritesTheOpposite": "Archiving writes the opposite movement. Nothing is deleted: both rows stay in the history, and the balance corrects itself.",
"reversedOn": "Reversed on {date}",
"reversalOfAnEntry": "Reversal",
"remainingOfReserved": "{remaining} of {total} still held",
"releaseThisReservation": "Release",
"unlinkOnThePromotionScreen": "Linked to a promotion — undo it on the promotion's own screen.",
"noMovementsOfThisKind": "Nothing of this kind has been recorded for this prize.",
"periodFrom": "From",
"periodTo": "To",
"consult": "Search",
"everyMovementType": "Every kind"
```

Into `messages/pt.json`:

```json
"stockEntries": "Entradas",
"stockExits": "Saídas",
"stockReservations": "Reservas",
"entryType": "Tipo",
"entryPurchase": "Compra",
"entryBarter": "Permuta",
"stockAdjustment": "Ajuste de estoque",
"exitTransfer": "Envio para outra emissora",
"invoiceNumber": "Nota fiscal",
"unitAmount": "Valor unitário",
"totalAmount": "Valor total",
"reservationTypeReserve": "Reservar",
"reservationTypeProgramme": "Vincular programa",
"reservationTypePromotion": "Vincular promoção",
"programme": "Programa",
"promotion": "Promoção",
"performedBy": "Por",
"archiveMovement": "Arquivar",
"archiveThisMovement": "Arquivar este movimento?",
"archiveWritesTheOpposite": "Arquivar grava o movimento contrário. Nada é apagado: as duas linhas ficam no histórico, e o saldo se corrige sozinho.",
"reversedOn": "Estornado em {date}",
"reversalOfAnEntry": "Estorno",
"remainingOfReserved": "{remaining} de {total} ainda reservados",
"releaseThisReservation": "Liberar",
"unlinkOnThePromotionScreen": "Vinculado a uma promoção — desfaça na tela da própria promoção.",
"noMovementsOfThisKind": "Nada deste tipo foi registrado para este prêmio.",
"periodFrom": "De",
"periodTo": "Até",
"consult": "Consultar",
"everyMovementType": "Todos os tipos"
```

Into `messages/es.json`:

```json
"stockEntries": "Entradas",
"stockExits": "Salidas",
"stockReservations": "Reservas",
"entryType": "Tipo",
"entryPurchase": "Compra",
"entryBarter": "Permuta",
"stockAdjustment": "Ajuste de inventario",
"exitTransfer": "Envío a otra emisora",
"invoiceNumber": "Factura",
"unitAmount": "Valor unitario",
"totalAmount": "Valor total",
"reservationTypeReserve": "Reservar",
"reservationTypeProgramme": "Vincular programa",
"reservationTypePromotion": "Vincular promoción",
"programme": "Programa",
"promotion": "Promoción",
"performedBy": "Por",
"archiveMovement": "Archivar",
"archiveThisMovement": "¿Archivar este movimiento?",
"archiveWritesTheOpposite": "Archivar escribe el movimiento contrario. Nada se borra: las dos líneas quedan en el historial y el saldo se corrige solo.",
"reversedOn": "Revertido el {date}",
"reversalOfAnEntry": "Reversión",
"remainingOfReserved": "{remaining} de {total} aún reservados",
"releaseThisReservation": "Liberar",
"unlinkOnThePromotionScreen": "Vinculado a una promoción — deshazlo en la pantalla de la promoción.",
"noMovementsOfThisKind": "No se ha registrado nada de este tipo para este premio.",
"periodFrom": "Desde",
"periodTo": "Hasta",
"consult": "Consultar",
"everyMovementType": "Todos los tipos"
```

Placeholders must be identical across the three files — `{date}`, `{remaining}`,
`{total}`. A key present in all three with a placeholder renamed in one is the
one defect `tests/unit/i18n/catalogue.test.ts` cannot see.

Run `npx vitest run tests/unit/i18n` before touching a component.

- [ ] **Step 3: Write the shared history list**

Create `src/app/(app)/inventory/movement-history.tsx`. One component renders the
history under all four tabs, because the four lists differ in what they are
filtered to and in nothing else — four components would be four places for one
fix to be applied to three.

It takes the movements, the Station's time zone, an optional `onReverse` (absent
where the tab offers no archiving), and the empty message. Each row shows: the
movement's own label, the quantity and its bucket transition, the date, **the
actor's name**, and — where they exist — the invoice number, the amounts, the
programme, the remaining quantity, and the reversal state.

A reversed row is struck through and names when it was reversed; a reversal row
says what it is. Neither is derived in this component: both come from the read
(Task 4).

- [ ] **Step 4: Render the five tabs**

In `prize-record-dialog.tsx`, extend `TAB_LABEL_KEYS` to five entries and give
each tab its panel. The `data` panel keeps `BalanceStats` and `PrizeDataForm`
and **loses the four movement forms** (design D8) — they move to the tabs Tasks
6–8 build. Until those tasks land, the three new panels render the history alone;
say so in a comment rather than leaving an empty branch that reads as unfinished.

- [ ] **Step 5: Check it compiles**

```bash
npm run typecheck && npm run lint && npx vitest run tests/unit/i18n
```

- [ ] **Step 6: Commit**

```bash
git add src/lib/record-params.ts "src/app/(app)/inventory/prize-record-dialog.tsx" "src/app/(app)/inventory/movement-history.tsx" messages
git commit -m "feat(inventory): the prize record opens on five tabs"
```

---

### Task 6: The Entradas and Saídas tabs

**Files:**
- Create: `src/app/(app)/inventory/entries-tab.tsx`
- Create: `src/app/(app)/inventory/exits-tab.tsx`
- Modify: `src/app/(app)/inventory/stock-entry-form.tsx`
- Modify: `src/app/(app)/inventory/stock-exit-form.tsx`
- Modify: `src/app/(app)/inventory/actions.ts`
- Modify: `src/app/(app)/inventory/prize-record-dialog.tsx`

**Interfaces:**
- Consumes: Task 4's service, Task 5's `MovementHistory` and copy.
- Produces: `EntriesTab` and `ExitsTab`, plus `reverseMovementAction` in
  `actions.ts`.

- [ ] **Step 1: Widen the two forms**

`stock-entry-form.tsx` gains a Tipo select (Compra · Permuta · Ajuste de
estoque), Nota fiscal, Valor unitário and Valor total. **Total is computed from
quantity × unit price and stays editable** (design D9) — hold it as a string in
state, recompute it when quantity or unit price changes *unless the operator has
typed in it*, and stop recomputing once they have. A field that keeps
overwriting what someone typed is worse than one that never helps.

`stock-exit-form.tsx` gains a Tipo select (Envio para outra emissora · Ajuste de
estoque).

**"Ajuste de estoque" in either list routes to `adjust_stock`, not to the entry
or exit door.** The spec's §5 says why: two doors writing the same movement type
under two different permissions is a pair that is discovered years later, by the
one nobody fixed. `adjust_stock` takes a counted total rather than a delta —
read its signature and make the form ask for what it actually needs when that
type is chosen, or state plainly in your report that it cannot be reconciled
without a change the plan did not anticipate.

- [ ] **Step 2: Write the reversal action**

In `actions.ts`, beside the existing movement actions:

```ts
export type ReverseMovementState = { status: 'idle' } | { status: 'saved' } | { status: 'error'; message: string };

export async function reverseMovementAction(
  _prev: ReverseMovementState,
  formData: FormData,
): Promise<ReverseMovementState>;
```

It parses a uuid, calls the service, and returns the door's refusal message
verbatim for a `ValidationError` — the door names the shortfall, and that number
is the whole point of the message.

- [ ] **Step 3: Build the two tabs**

Each is the form above its own filtered history, with an Archive action per row
opening a confirmation that says what archiving does — `archiveWritesTheOpposite`
exists for that sentence. **A row already reversed offers no Archive**, the same
way Block 22's attend window withholds a button the database would refuse.

- [ ] **Step 4: Verify**

```bash
npm run typecheck && npm run lint && npm test
```

- [ ] **Step 5: Commit**

```bash
git add "src/app/(app)/inventory" 
git commit -m "feat(inventory): entries carry their invoice, and either side can be undone"
```

---

### Task 7: The Reservas tab

**Files:**
- Create: `src/app/(app)/inventory/reservations-tab.tsx`
- Modify: `src/app/(app)/inventory/reservation-forms.tsx`
- Modify: `src/app/(app)/inventory/actions.ts`
- Modify: `src/app/(app)/inventory/prize-record-dialog.tsx`

**Interfaces:**
- Consumes: Tasks 4–6.
- Produces: `ReservationsTab`.

- [ ] **Step 1: The dependent control**

One Tipo select with three values, and the control beneath it follows:

| Tipo | Second control | Door called |
|---|---|---|
| Reservar | none | `reserve_stock`, no programme |
| Vincular programa | Programas — active or starting in the future | `reserve_stock` with `p_show_id` |
| Vincular promoção | Promoções — active or starting in the future | **the existing promotion-link door** |

**Do not write a second promotion-link door** (design D6). Find the one the
Promotions screen calls — start from `promotion_prizes` and `PROMOTION_LINK` in
the migrations, and from the promotions screen's own actions — and call it. If
it turns out that door cannot be called from here (it may take a promotion as
its subject rather than a prize), stop and report that: it is a real finding and
the answer is not to write a second one.

The programme and promotion lists are reads this screen does not have today.
Both need "active or starting in the future" — read how the promotions screen
words that filter and reuse its meaning rather than inventing a second one.

- [ ] **Step 2: The history**

Reservations for this prize, each with its remaining quantity
(`remainingOfReserved`) and a Release action. A row that is a promotion link
shows `unlinkOnThePromotionScreen` instead of a Release button — it is undone by
the promotion, and offering a control that would fail is worse than offering
none.

- [ ] **Step 3: Verify and commit**

```bash
npm run typecheck && npm run lint && npm test
git add "src/app/(app)/inventory"
git commit -m "feat(inventory): a reservation can carry an owner, and be found again"
```

---

### Task 8: The Movimentação tab

**Files:**
- Modify: `src/app/(app)/inventory/prize-record-dialog.tsx`
- Modify: `src/app/(app)/inventory/movements/list-params.ts`
- Modify: `src/app/(app)/inventory/movements/movements-filters.tsx`

- [ ] **Step 1: The filters**

De, Até, a type filter offering every kind (design D10), and a `Consultar`
button. The owner asked for the button explicitly — this filter applies on
submit rather than on change, unlike the rest of the product, and that is
deliberate: a date range is typed in two halves and re-querying after the first
half is a wasted read and a flickering list.

The same three controls belong on the standalone `/inventory/movements` screen,
which already has filters — extend them there rather than building a second
filter bar for the tab.

- [ ] **Step 2: Verify and commit**

```bash
npm run typecheck && npm run lint && npm test
git add "src/app/(app)/inventory"
git commit -m "feat(inventory): the unified history answers a period and a kind"
```

---

### Task 9: The journey, and the gates

**Files:**
- Modify: `tests/e2e/inventory-flow.spec.ts`

- [ ] **Step 1: Write the journey**

Append one `test(...)` reusing the file's existing preamble. One prize through
its own record:

1. Open a prize's record; it opens on Dados do prêmio.
2. Entradas: record a purchase of 10 with an invoice number and a unit price;
   assert the total was computed.
3. Assert the row appears in the Entradas history with the invoice number **and
   the actor's name** — the owner's Observação1, proved at the only layer that
   renders it.
4. Dados do prêmio: assert available went up by 10.
5. Entradas: archive that entry; confirm; assert the row now reads as reversed
   and a reversal row appeared.
6. Dados do prêmio: assert available returned to where it started. **This is the
   assertion the block exists for** — the balance corrected itself by arithmetic.
7. Reservas: reserve 2 for a programme; assert the reservation appears with the
   programme's name and "2 of 2 still held".
8. Movimentação: assert every one of those movements is listed, newest first.

Assert on test ids and on numbers, never on translated labels.

- [ ] **Step 2: Run the eight gates, in order**

```bash
npm run typecheck
npm run lint
npm test
npm run db:reset
npm run db:test
npm run seed:branding
npm run test:e2e
npm run test:isolation
```

`db:test` after `db:reset` and before the e2e run. Two known flakes: a
first-navigation e2e failure is Next compiling, and "Worker exited unexpectedly"
in the isolation suite is unrelated to file content. Re-run each once; report how
many attempts each gate needed and which failures were flakes.

If a gate fails for any other reason, **do not fix it** — report BLOCKED with the
command, the verbatim output, and your reading of whether it is a real defect.

- [ ] **Step 3: Commit and push**

```bash
git add -A
git commit -m "test(e2e): a prize bought, undone, and reserved for a programme"
git push -u origin block-23-prize-record-tabs
```

---

## Self-Review

**Spec coverage.** The owner's five tabs: Dados do prêmio (Task 5, forms removed
per D8), Entradas (Tasks 1–4 and 6), Saídas (Tasks 1–4 and 6), Reservas (Tasks
1–4 and 7), Movimentação (Task 8). The invoice trio (Tasks 1, 2, 6). Archiving
that recomputes stock (Tasks 1–3 and 6). The three reservation types (Tasks 2
and 7). The actor on every history row (Tasks 4, 5 and 9). The three additions
the owner accepted: computed total (Task 6 Step 1), type filter on Movimentação
(Task 8), remaining quantity per reservation (Tasks 4 and 7).

Decisions: D1→3, D2→1, D3→1, D4→1, D5→2, D6→7, D7→1 and 7, D8→5, D9→6, D10→8,
D11→5, D12→1.

**Placeholder scan.** None. Every `plan(N)` is given exactly: `plan(8)` in Task
1, `plan(16)` in Task 2, `plan(24)` in Task 3, `plan(30)` in Task 4.

**Three places the plan says "check, and report if it is not so", deliberately.**
They are the points where I could not verify a fact without running the database,
and guessing would have written a confident wrong instruction: whether
`record_stock_entry` already refuses a non-entry type (Task 2), what
`apply_inventory_movement` does when a bucket would go negative and the order of
its new parameters (Task 3), and whether the promotion-link door can be called
with a prize as its subject (Task 7). Each names what to do if the answer is the
inconvenient one.

**Type consistency.** `PRIZE_TABS`'s five values (Task 5) are the tab names used
in Tasks 6–8. `MovementHistory`'s four props (Task 5) are what Tasks 6–8 pass.
`reverseMovementAction` is defined in Task 6 and used in Task 6 only.
`reverse_movement` is created in Task 3 and called through the service from Task
4 onward.
