# Block 4b — Prize linking, and the surgery on the ledger — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `PROMOTION_LINK` and `PROMOTION_UNLINK` reachable — a promotion holds N units of a prize, the ledger records every move, a second projection counts them per promotion, and cancelling or archiving hands the undrawn ones back.

**Architecture:** Two new tables (`promotion_prizes`, the link; `promotion_prize_balances`, the H1 projection), one new nullable column on the append-only ledger, and surgery on the ledger's single writer so it feeds both projections inside the one transaction. Two write RPCs and two read RPCs sit on top; `cancel_promotion` and `archive_promotion` are recreated to return undrawn units through a shared helper. The screen gains the record dialog's fourth tab.

**Tech Stack:** Postgres 15 (Supabase local), plpgsql SECURITY DEFINER RPCs, pgTAP, Next.js 15 App Router (React 19 server actions), TypeScript, Zod, Vitest, Playwright.

**Source spec:** `docs/superpowers/specs/2026-07-30-block-4b-promotion-prizes-design.md` — read it before Task 1.

## Global Constraints

- **Every gate at real defaults.** `npm run lint`, `npm run typecheck`, `npm test`, `npm run db:test`, `npm run test:isolation`, `npm run test:e2e` — no flags that weaken them, no skipped files.
- **Everything in English**: identifiers, comments, UI copy, commit messages. (Project vocabulary: Station = company, Organization, Member.)
- **No `revalidatePath` in `src/app/(app)/promotions/actions.ts`** — the banner comment at the top of that file states why, and this block must not break it. Every write inside the record dialog re-reads that one record; never the list.
- **No write grants on any table.** Every write goes through a SECURITY DEFINER RPC. `revoke truncate ... from service_role` too — 0029's own late fix.
- **Private helpers are SECURITY INVOKER with EXECUTE granted to nobody**, called only from inside a DEFINER body (`ensure_inventory_balance_row`, `promotion_write_error` are the two precedents).
- **New permission code:** `promotions.prizes`, module `promotions`, scope `company`, `introduced_by_block` `'4b'`, `display_order` 60.
- **Migrations are numbered `0045`–`0051`** and are append-only: never edit a migration that has been committed; add another.
- **Postgres has no partial function redefinition.** Recreating a function restates its whole body, so the migrations in Tasks 3, 4 and 6 necessarily repeat code from 0027/0028/0030/0042. That is not duplication to be factored out — it is how `create or replace` works, and 0030 is the project's own precedent for it.
- **A guard that cannot fire does not ship.** Where one is deliberately unreachable today (the Block 6 tripwire in Task 3), it says so in its own comment and is tested by removing what makes it unreachable.

## Decision taken during planning, beyond the spec

The spec's §2 D1 asserts "archiving still refuses while the promotion is accepting entries (4a), so by the time a promotion can be archived it has been cancelled and nothing is held." **That premise is false against 4a's shipped code.** `archive_promotion` (0042:335) refuses only *inside* the window; `cancel_promotion` (0042:279) refuses a promotion that has already *ended*. So an ended-but-never-cancelled promotion can be archived with prizes still linked — stranded stock, which is the exact failure D1 exists to prevent.

**The owner chose: `archive_promotion` returns the units itself**, the same way cancelling does. Archiving stops being a pure record operation and becomes one that moves stock, and that is stated in the function's own comment. Both callers share one helper (`return_promotion_prizes`), so the rule has one implementation and one set of tests. Task 9 amends the spec to record this.

## Second decision taken during planning: how the tab reads prize names

The spec's §5 assumes the Prêmios tab can render one row per linked prize. It cannot, through ordinary reads: a prize's **name** lives in `public.prizes`, whose policy (0029) gates every read on `inventory.view`. An operator holding `promotions.view` and `promotions.prizes` but not `inventory.view` would get a tab of blank names. Two SECURITY DEFINER read functions close that — `list_promotion_prizes` (gated `promotions.view`) and `list_linkable_prizes` (gated `promotions.prizes`) — and each restates the archived-promotion rule that 0044's policy enforces for the record itself, because a DEFINER body never consults that policy.

---

## File Structure

**Migrations (create):**
- `supabase/migrations/0045_promotion_prizes.sql` — the two tables, the ledger's new column, check, foreign key and index, and the permission.
- `supabase/migrations/0046_rls_promotion_prizes.sql` — grants and read policies. Deliberately *before* the function migrations, unlike 0029/0044 which sit last in their blocks: every task after this one asserts state by reading these two tables, and a suite that cannot read them would have to assert through functions that do not exist yet.
- `supabase/migrations/0047_promotion_prize_ledger.sql` — `ensure_promotion_prize_balance_row`, and `apply_inventory_movement` dropped and recreated with a ninth parameter.
- `supabase/migrations/0048_reconcile_promotion_prizes.sql` — `reconcile_inventory` dropped and recreated with two more output columns.
- `supabase/migrations/0049_promotion_prize_rpcs.sql` — `link_prize_to_promotion`, `unlink_prize_from_promotion`.
- `supabase/migrations/0050_promotion_lifecycle_returns_prizes.sql` — `return_promotion_prizes`, and `cancel_promotion` and `archive_promotion` recreated around it.
- `supabase/migrations/0051_promotion_prize_reads.sql` — `list_promotion_prizes`, `list_linkable_prizes`.

**pgTAP (create/modify):**
- `supabase/tests/04_promotion_prizes.test.sql` — new; every constraint in this block, both ways.
- `supabase/tests/03_promotions.test.sql:22` — five permissions becomes six.
- `supabase/tests/02_permissions.test.sql:364,369,373,377` — `apply_inventory_movement`'s pinned signature gains the ninth argument.

**Server (create/modify):**
- `src/services/promotions.ts` — `PromotionPrizeRow`, `LinkablePrize`, the fourth read inside `getPromotionRecord`, `listLinkablePrizes`, `linkPrizeToPromotion`, `unlinkPrizeFromPromotion`.
- `src/services/inventory.ts` — `ReconciliationRow` gains two fields.
- `src/schemas/promotions.ts` — `promotionPrizeLinkSchema`.
- `src/app/(app)/promotions/access.ts` — `PromotionPowers.prizes`.
- `src/app/(app)/promotions/actions.ts` — `linkPrizeAction`, `unlinkPrizeAction`, `searchLinkablePrizesAction`.
- `src/lib/supabase/database.types.ts` — regenerated.

**Client (create/modify):**
- `src/app/(app)/promotions/prizes-tab.tsx` — new.
- `src/app/(app)/promotions/promotion-record-dialog.tsx` — the fourth tab.
- `src/app/(app)/inventory/reconciliation-panel.tsx` — a Promotion column.

**Tests (create/modify):**
- `tests/isolation/harness.ts` — `setPromotionPrizeDrawnDirectly`.
- `tests/isolation/promotion-prizes.test.ts` — new; the block's real proof.
- `tests/unit/promotions-schema.test.ts` — the link schema.
- `tests/e2e/promotion-prizes.spec.ts` — new.

**Docs:**
- `docs/block-4b-report.md` — new.
- `docs/superpowers/specs/2026-07-30-block-4b-promotion-prizes-design.md` — amended in Task 9.

---

I will hand you the tasks in order. Each ends with a green gate and a commit.

## Task 1: The two tables, the ledger's new column, and the permission

**Files:**
- Create: `supabase/migrations/0045_promotion_prizes.sql`
- Create: `supabase/tests/04_promotion_prizes.test.sql`
- Modify: `supabase/tests/03_promotions.test.sql:21-23`

**Interfaces:**
- Produces: tables `public.promotion_prizes` (`id`, `promotion_id`, `prize_id`, `organization_id`, `company_id`, `created_by`, `created_at`, `updated_at`, `deleted_at`) and `public.promotion_prize_balances` (`promotion_prize_id` pk, `prize_id`, `company_id`, `organization_id`, `linked`, `drawn`, `updated_at`); column `public.inventory_movements.promotion_prize_id uuid`; unique constraint `promotion_prizes_id_prize_company_unique (id, prize_id, company_id)`; permission code `promotions.prizes`.
- Consumes: `promotions_id_company_unique (id, company_id)` (0040:177), `prizes_id_company_unique (id, company_id)` (0025:77), `companies (id, organization_id)`.

- [ ] **Step 1: Write the failing pgTAP suite**

Create `supabase/tests/04_promotion_prizes.test.sql`:

```sql
begin;
select plan(21);

-- Structure -------------------------------------------------------------------

select has_table('public', 'promotion_prizes', 'promotion_prizes exists');
select has_table('public', 'promotion_prize_balances', 'promotion_prize_balances exists');

select is(relrowsecurity, true, 'RLS enabled on promotion_prizes')
  from pg_class where oid = 'public.promotion_prizes'::regclass;
select is(relrowsecurity, true, 'RLS enabled on promotion_prize_balances')
  from pg_class where oid = 'public.promotion_prize_balances'::regclass;

select ok(not has_table_privilege('authenticated', 'public.promotion_prizes', 'INSERT'),
          'authenticated may not link a prize directly');
select ok(not has_table_privilege('service_role', 'public.promotion_prize_balances', 'UPDATE'),
          'service_role may not write the per-promotion projection directly');

select has_column('public', 'inventory_movements', 'promotion_prize_id',
                  'the ledger can name a promotion link');

-- Fixtures ---------------------------------------------------------------------
-- Two Stations in one Organization: the second exists only for the
-- cross-Station link below.

insert into public.organizations (id, name) values
  ('00000000-0000-0000-0000-0000000004b1', 'Org 4b');
insert into public.companies (id, organization_id, name, timezone) values
  ('00000000-0000-0000-0000-0000000004c1', '00000000-0000-0000-0000-0000000004b1',
   'Station 4b One', 'America/Sao_Paulo'),
  ('00000000-0000-0000-0000-0000000004c2', '00000000-0000-0000-0000-0000000004b1',
   'Station 4b Two', 'America/Sao_Paulo');

insert into public.prizes (id, organization_id, company_id, name) values
  ('00000000-0000-0000-0000-0000000004a1', '00000000-0000-0000-0000-0000000004b1',
   '00000000-0000-0000-0000-0000000004c1', 'Bicycle'),
  ('00000000-0000-0000-0000-0000000004a2', '00000000-0000-0000-0000-0000000004b1',
   '00000000-0000-0000-0000-0000000004c1', 'Headphones'),
  ('00000000-0000-0000-0000-0000000004a9', '00000000-0000-0000-0000-0000000004b1',
   '00000000-0000-0000-0000-0000000004c2', 'Prize in the other Station');

insert into public.promotions (id, organization_id, company_id, name, starts_at, ends_at) values
  ('00000000-0000-0000-0000-0000000004d1', '00000000-0000-0000-0000-0000000004b1',
   '00000000-0000-0000-0000-0000000004c1', 'Prize host', '2026-08-01Z', '2026-08-31Z');

insert into public.promotion_prizes
  (id, promotion_id, prize_id, organization_id, company_id) values
  ('00000000-0000-0000-0000-0000000004e1', '00000000-0000-0000-0000-0000000004d1',
   '00000000-0000-0000-0000-0000000004a1', '00000000-0000-0000-0000-0000000004b1',
   '00000000-0000-0000-0000-0000000004c1');

-- The link proves its Station structurally ------------------------------------

select throws_ok(
  $$insert into public.promotion_prizes (promotion_id, prize_id, organization_id, company_id)
    values ('00000000-0000-0000-0000-0000000004d1',
            '00000000-0000-0000-0000-0000000004a9',
            '00000000-0000-0000-0000-0000000004b1',
            '00000000-0000-0000-0000-0000000004c1')$$,
  '23503', null, 'a prize from another Station cannot be linked');

select throws_ok(
  $$insert into public.promotion_prizes (promotion_id, prize_id, organization_id, company_id)
    values ('00000000-0000-0000-0000-0000000004d1',
            '00000000-0000-0000-0000-0000000004a1',
            '00000000-0000-0000-0000-0000000004b1',
            '00000000-0000-0000-0000-0000000004c1')$$,
  '23505', null, 'the same prize cannot be linked twice while the first link is live');

-- The partial index is what makes the relink possible; a plain unique index
-- would refuse it, and only this case tells the two apart.
update public.promotion_prizes set deleted_at = now()
 where id = '00000000-0000-0000-0000-0000000004e1';

prepare relink as
  insert into public.promotion_prizes (promotion_id, prize_id, organization_id, company_id)
  values ('00000000-0000-0000-0000-0000000004d1',
          '00000000-0000-0000-0000-0000000004a1',
          '00000000-0000-0000-0000-0000000004b1',
          '00000000-0000-0000-0000-0000000004c1');
select lives_ok('relink', 'a prize can be linked again after its link was unwound');

update public.promotion_prizes set deleted_at = null
 where id = '00000000-0000-0000-0000-0000000004e1';
delete from public.promotion_prizes
 where id <> '00000000-0000-0000-0000-0000000004e1';

-- The projection ---------------------------------------------------------------

insert into public.promotion_prize_balances
  (promotion_prize_id, prize_id, company_id, organization_id, linked, drawn)
values ('00000000-0000-0000-0000-0000000004e1',
        '00000000-0000-0000-0000-0000000004a1',
        '00000000-0000-0000-0000-0000000004c1',
        '00000000-0000-0000-0000-0000000004b1', 5, 2);

select throws_ok(
  $$update public.promotion_prize_balances set drawn = 6
     where promotion_prize_id = '00000000-0000-0000-0000-0000000004e1'$$,
  '23514', null, 'drawn may not exceed linked');

-- D4's floor, stated as the table check rather than only as an RPC guard: this
-- is the case that stays red if unlink_prize_from_promotion's own check is
-- removed.
select throws_ok(
  $$update public.promotion_prize_balances set linked = 1
     where promotion_prize_id = '00000000-0000-0000-0000-0000000004e1'$$,
  '23514', null, 'linked may not be pushed below what has been drawn');

select throws_ok(
  $$update public.promotion_prize_balances set linked = -1, drawn = -1
     where promotion_prize_id = '00000000-0000-0000-0000-0000000004e1'$$,
  '23514', null, 'a negative bucket is refused');

select throws_ok(
  $$insert into public.promotion_prize_balances
      (promotion_prize_id, prize_id, company_id, organization_id)
    values ('00000000-0000-0000-0000-0000000004e1',
            '00000000-0000-0000-0000-0000000004a2',
            '00000000-0000-0000-0000-0000000004c1',
            '00000000-0000-0000-0000-0000000004b1')$$,
  '23503', null, 'a balance row may not name a prize its link is not for');

-- The ledger's new column -------------------------------------------------------

select throws_ok(
  $$insert into public.inventory_movements
      (organization_id, company_id, prize_id, movement_type, quantity, from_bucket, to_bucket)
    values ('00000000-0000-0000-0000-0000000004b1','00000000-0000-0000-0000-0000000004c1',
            '00000000-0000-0000-0000-0000000004a1', 'PROMOTION_LINK', 1,
            'available', 'linked')$$,
  '23514', null, 'a PROMOTION_LINK that names no promotion is refused');

select throws_ok(
  $$insert into public.inventory_movements
      (organization_id, company_id, prize_id, movement_type, quantity, from_bucket, to_bucket)
    values ('00000000-0000-0000-0000-0000000004b1','00000000-0000-0000-0000-0000000004c1',
            '00000000-0000-0000-0000-0000000004a1', 'PROMOTION_UNLINK', 1,
            'linked', 'available')$$,
  '23514', null, 'a PROMOTION_UNLINK that names no promotion is refused');

-- The other half of the same check. Block 6 widens it to DRAW and DELIVERY;
-- until then a movement that could name a promotion but must not is exactly
-- what this refuses.
select throws_ok(
  $$insert into public.inventory_movements
      (organization_id, company_id, prize_id, movement_type, quantity,
       from_bucket, to_bucket, promotion_prize_id)
    values ('00000000-0000-0000-0000-0000000004b1','00000000-0000-0000-0000-0000000004c1',
            '00000000-0000-0000-0000-0000000004a1', 'MANUAL_ENTRY', 1,
            null, 'available', '00000000-0000-0000-0000-0000000004e1')$$,
  '23514', null, 'a movement that is not a link may not name a promotion');

-- Three columns in the foreign key, not two: this is the case that a
-- (promotion_prize_id, company_id) key would let through.
select throws_ok(
  $$insert into public.inventory_movements
      (organization_id, company_id, prize_id, movement_type, quantity,
       from_bucket, to_bucket, promotion_prize_id)
    values ('00000000-0000-0000-0000-0000000004b1','00000000-0000-0000-0000-0000000004c1',
            '00000000-0000-0000-0000-0000000004a2', 'PROMOTION_LINK', 1,
            'available', 'linked', '00000000-0000-0000-0000-0000000004e1')$$,
  '23503', null, 'a link movement may not name a link that is for another prize');

prepare linked_movement as
  insert into public.inventory_movements
    (organization_id, company_id, prize_id, movement_type, quantity,
     from_bucket, to_bucket, promotion_prize_id)
  values ('00000000-0000-0000-0000-0000000004b1','00000000-0000-0000-0000-0000000004c1',
          '00000000-0000-0000-0000-0000000004a1', 'PROMOTION_LINK', 3,
          'available', 'linked', '00000000-0000-0000-0000-0000000004e1');
select lives_ok('linked_movement', 'a PROMOTION_LINK naming its own link is legal');

-- Every row the ledger already holds stays legal: the column is nullable and
-- the check exempts every type that is not a link.
prepare plain_entry as
  insert into public.inventory_movements
    (organization_id, company_id, prize_id, movement_type, quantity, from_bucket, to_bucket)
  values ('00000000-0000-0000-0000-0000000004b1','00000000-0000-0000-0000-0000000004c1',
          '00000000-0000-0000-0000-0000000004a1', 'MANUAL_ENTRY', 10, null, 'available');
select lives_ok('plain_entry', 'a movement that names no promotion is still legal');

select * from finish();
rollback;
```

- [ ] **Step 2: Run it and confirm it fails for the right reason**

Run: `npm run db:reset && npm run db:test`

Expected: `04_promotion_prizes.test.sql` fails at the first `has_table` — `relation "public.promotion_prizes" does not exist`. `00`–`03` stay green.

- [ ] **Step 3: Write the migration**

Create `supabase/migrations/0045_promotion_prizes.sql`:

```sql
-- supabase/migrations/0045_promotion_prizes.sql

-- The link itself: N units of a prize committed to one promotion. Not a prize
-- linked to a promotion — *N units of it* (spec D2), which is why the count
-- lives in the projection below rather than on this row.
create table public.promotion_prizes (
  id              uuid primary key default gen_random_uuid(),
  promotion_id    uuid not null,
  prize_id        uuid not null,
  organization_id uuid not null references public.organizations (id),
  company_id      uuid not null,

  created_by uuid references auth.users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,

  -- Composite keys to both parents, so a prize from one Station cannot be
  -- linked to a promotion in another. Structural rather than checked: the pair
  -- (id, company_id) is unique on each parent precisely so a child can prove
  -- the Station in one constraint (0040:177, 0025:77).
  constraint promotion_prizes_promotion_fk
    foreign key (promotion_id, company_id)
    references public.promotions (id, company_id),
  constraint promotion_prizes_prize_fk
    foreign key (prize_id, company_id)
    references public.prizes (id, company_id),
  constraint promotion_prizes_company_org_fk
    foreign key (company_id, organization_id)
    references public.companies (id, organization_id)
);

comment on table public.promotion_prizes is
  'One live row per (promotion, prize). Linking more units of a prize already linked adds to the count on the row that is there; a link unwound to nothing is soft-deleted and leaves the Prizes tab, because its history is in the ledger and a row of zeros on screen is not history.';
comment on column public.promotion_prizes.deleted_at is
  'Set by unlink_prize_from_promotion when the last undrawn unit goes back, and by return_promotion_prizes when a promotion is cancelled or archived (0049). Never set while anything has been drawn: those units belong to a winner and the row still has to show them.';

-- The project's N5 idiom. A plain unique index would forbid ever linking the
-- same prize to the same promotion again after unwinding it; what is actually
-- forbidden is two LIVE links for one pair.
create unique index promotion_prizes_live_unique
  on public.promotion_prizes (promotion_id, prize_id)
  where deleted_at is null;

create index promotion_prizes_promotion_idx
  on public.promotion_prizes (promotion_id)
  where deleted_at is null;

-- The foreign-key target both children below use. Three columns rather than
-- two: with (id, company_id) a movement could name prize X through a link that
-- is for prize Y, and the projection would move under a prize nothing in the
-- ledger says it moved under. This makes that unrepresentable rather than
-- merely unlikely, the same trade 0026's legal-transition check makes.
alter table public.promotion_prizes
  add constraint promotion_prizes_id_prize_company_unique unique (id, prize_id, company_id);

-- The H1 projection. Keyed on the link, because "how many units does THIS
-- promotion hold of THIS prize" is a different question from the Station-wide
-- linked bucket in inventory_balances, and the two are reconciled separately
-- (0048).
create table public.promotion_prize_balances (
  promotion_prize_id uuid primary key,

  -- Carried so both this table and inventory_movements prove the same three
  -- facts through the one unique constraint above, and so reconciliation can
  -- name the prize without a third join.
  prize_id        uuid not null,
  company_id      uuid not null,
  organization_id uuid not null references public.organizations (id),

  linked integer not null default 0 check (linked >= 0),
  drawn  integer not null default 0 check (drawn  >= 0),

  updated_at timestamptz not null default now(),

  constraint promotion_prize_balances_link_fk
    foreign key (promotion_prize_id, prize_id, company_id)
    references public.promotion_prizes (id, prize_id, company_id),
  constraint promotion_prize_balances_company_org_fk
    foreign key (company_id, organization_id)
    references public.companies (id, organization_id),

  -- D4's floor, and the reason it is here rather than only inside the RPC: an
  -- unlink that would push linked below drawn cannot be written at all,
  -- whether or not the function checked first.
  constraint promotion_prize_balances_drawn_within_linked check (drawn <= linked)
);

comment on table public.promotion_prize_balances is
  'Projection of the ledger per promotion link. Written only by apply_inventory_movement (0047), inside the transaction that appends the movement, and recomputed from the ledger by reconcile_inventory (0048).';
comment on column public.promotion_prize_balances.linked is
  'Units committed to this promotion. NOT decremented when a unit is drawn — drawn is its own counter and Resto is linked - drawn, which is what the owner''s screen shows as Vinculados / Sorteados / Resto.';
comment on column public.promotion_prize_balances.drawn is
  'Written by Block 6, which brings the draw. 4b only reads it and guards on it: it is what stops an unlink from returning a unit that already belongs to a winner. There is deliberately NO delivered column here — a DELIVERY movement cannot carry a promotion_prize_id until Block 6 widens the ledger check below, so nothing could ever increment one, and a column whose only writer does not exist yet is the same shape as a guard that can never fire.';

-- The ledger ------------------------------------------------------------------
-- Nullable and additive, so every row Block 2 already wrote stays legal.

alter table public.inventory_movements
  add column promotion_prize_id uuid;

comment on column public.inventory_movements.promotion_prize_id is
  'Which promotion link this movement is part of. Required for PROMOTION_LINK and PROMOTION_UNLINK and forbidden everywhere else — see inventory_movements_promotion_reference.';

-- MATCH SIMPLE (the default) is what makes this work on a nullable column: if
-- ANY column of the key is null the constraint is not enforced at all. prize_id
-- and company_id are NOT NULL, so the key is either wholly null in its one
-- nullable slot — every movement that names no promotion, which is all of Block
-- 2's — or wholly present and fully checked. Stated because a partially-null
-- composite foreign key is a classic place to be wrong by accident.
alter table public.inventory_movements
  add constraint inventory_movements_promotion_prize_fk
  foreign key (promotion_prize_id, prize_id, company_id)
  references public.promotion_prizes (id, prize_id, company_id);

-- Required for exactly the two types that are meaningless without it: a
-- PROMOTION_LINK that cannot say which promotion is a row nobody can reconcile.
--
-- DRAW, DELIVERY and the return types will need the same reference in Block 6
-- and are deliberately NOT admitted here: this block has no way to write one,
-- and a check admitting a column no caller can fill is a rule that cannot be
-- tested. Block 6 widens this check; apply_inventory_movement (0047) raises if
-- it is widened without teaching that function what the new type projects to.
alter table public.inventory_movements
  add constraint inventory_movements_promotion_reference check (
    (movement_type in ('PROMOTION_LINK', 'PROMOTION_UNLINK') and promotion_prize_id is not null)
    or (movement_type not in ('PROMOTION_LINK', 'PROMOTION_UNLINK') and promotion_prize_id is null)
  );

create index inventory_movements_promotion_prize_idx
  on public.inventory_movements (promotion_prize_id, created_at desc)
  where promotion_prize_id is not null;

alter table public.promotion_prizes         enable row level security;
alter table public.promotion_prize_balances enable row level security;

-- A permission is born beside the feature it guards. Its own code rather than
-- promotions.edit: linking moves stock, and somebody who may reword a promotion
-- is not thereby somebody who may commit inventory to it. inventory.reserve is
-- the other candidate and reads wrongly — a reservation is not a promotion link.
insert into public.permissions (code, description, introduced_by_block, module, label, scope, display_order) values
  ('promotions.prizes', 'Link prizes to a promotion and unlink them', '4b', 'promotions',
   'Link prizes to a promotion', 'company', 60);
```

- [ ] **Step 4: Update the permission count in 03**

In `supabase/tests/03_promotions.test.sql`, replace lines 21–23:

```sql
select is(
  (select count(*)::int from public.permissions where code like 'promotions.%'),
  6, 'six promotion permissions are catalogued');
```

- [ ] **Step 5: Run the suite green**

Run: `npm run db:reset && npm run db:test`

Expected: all four files pass; `04_promotion_prizes.test.sql` reports 20 of 20.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/0045_promotion_prizes.sql supabase/tests/04_promotion_prizes.test.sql supabase/tests/03_promotions.test.sql
git commit -m "$(cat <<'EOF'
feat(promotions): the link, its projection, and the column the ledger lacked

PROMOTION_LINK and PROMOTION_UNLINK have been legal transitions since 0026 and
unreachable ever since, because inventory_movements carried no promotion
reference at all. It does now: nullable, additive, and required for exactly the
two types that are meaningless without it.

The foreign key is three columns rather than two. With (promotion_prize_id,
company_id) a movement could name prize X through a link that is for prize Y,
and the projection would move under a prize nothing in the ledger says it moved
under; the third column makes that unrepresentable.

drawn <= linked is a table check, not only an RPC guard, so D4's floor holds
whether or not the function checks first.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: The read gate on both tables

**Files:**
- Create: `supabase/migrations/0046_rls_promotion_prizes.sql`
- Modify: `supabase/tests/04_promotion_prizes.test.sql` (plan count 20 → 27, new section at the end)

**Interfaces:**
- Consumes: `public.has_permission(text, uuid)` (0024), the `promotions` read policy (0044:43).
- Produces: policies `promotion_prizes_select_promotions_view`, `promotion_prize_balances_select_promotions_view`; `select` granted to `authenticated` and `service_role` on both tables and nothing else.

This task's pgTAP proves the tables **fail closed** and that the grants are exactly what they should be. It does not prove that a delegate holding `promotions.view` can read them — that needs a real membership, and it arrives in Task 6's isolation suite driven by the production path. Do not read this task's green as full coverage of the policies.

- [ ] **Step 1: Write the failing assertions**

In `supabase/tests/04_promotion_prizes.test.sql`, change line 2 to `select plan(27);` — the file holds 20 assertions today and this section adds 7 — and insert this section immediately before the final `select * from finish();`:

```sql
-- The read gate --------------------------------------------------------------

select ok(has_table_privilege('authenticated', 'public.promotion_prizes', 'SELECT'),
          'authenticated may read links, subject to policy');
select ok(has_table_privilege('service_role', 'public.promotion_prize_balances', 'SELECT'),
          'service_role may read the projection — BYPASSRLS is not a grant');
select ok(not has_table_privilege('service_role', 'public.promotion_prizes', 'TRUNCATE'),
          'service_role may not truncate the links');
select ok(not has_table_privilege('service_role', 'public.promotion_prize_balances', 'TRUNCATE'),
          'service_role may not truncate the projection');

select is(
  (select count(*)::int from pg_policies
    where schemaname = 'public' and tablename = 'promotion_prizes'),
  1, 'promotion_prizes carries exactly one policy, and it is a read policy');
select is(
  (select count(*)::int from pg_policies
    where schemaname = 'public' and tablename = 'promotion_prize_balances'),
  1, 'promotion_prize_balances carries exactly one policy, and it is a read policy');

-- Fails closed. The claim names a user with no membership anywhere, so
-- has_permission is false for every Station and both policies must return
-- nothing — including for the link and balance rows this file inserted above.
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-0000000004f9", "role": "authenticated"}';

create temporary view stranger_links as
  select id from public.promotion_prizes;

reset role;
select is(
  (select count(*)::int from stranger_links),
  0, 'a caller holding promotions.view nowhere reads no links at all');
```

- [ ] **Step 2: Run it and confirm it fails for the right reason**

Run: `npm run db:reset && npm run db:test`

Expected: the two `has_table_privilege(... 'SELECT')` assertions fail (no grant exists yet) and the policy counts read 0, not 1. The fail-closed assertion passes already — RLS with no policy denies everything — which is why it is not the assertion this task rests on.

- [ ] **Step 3: Write the migration**

Create `supabase/migrations/0046_rls_promotion_prizes.sql`:

```sql
-- supabase/migrations/0046_rls_promotion_prizes.sql
--
-- Earlier in the block than 0029 and 0044 sat in theirs, and deliberately: every
-- task after this one asserts state by reading these two tables, and a suite
-- that cannot read them would have to assert through functions that do not
-- exist yet. There was no readable window either way — 0045 enabled RLS on both
-- tables at creation, and the default ACL on `public` grants a fresh table only
-- Dxtm to the Supabase roles, the point 0029's own comment settled with
-- evidence.

revoke all on public.promotion_prizes         from anon, authenticated;
revoke all on public.promotion_prize_balances from anon, authenticated;

-- No table takes an insert, update or delete grant from any role, service_role
-- included: every write goes through a SECURITY DEFINER RPC that runs as the
-- table owner and needs no grant of its own. On promotion_prize_balances this
-- is what makes apply_inventory_movement (0047) the single writer rather than
-- merely the intended one.
grant select on public.promotion_prizes         to authenticated, service_role;
grant select on public.promotion_prize_balances to authenticated, service_role;

-- `revoke all` above ran against anon and authenticated only, so service_role
-- kept the default ACL's TRUNCATE on both — the hole 0029 found late and closed
-- for the four inventory tables. Closed here at the same time as the grant,
-- rather than after somebody notices again.
revoke truncate on public.promotion_prizes         from service_role;
revoke truncate on public.promotion_prize_balances from service_role;

-- `deleted_at is null` is baked in here, unlike 0044's policy on promotions
-- itself. That exception exists so the owner can filter for archived
-- promotions; there is no equivalent screen for unwound links, and their
-- history lives in the ledger, so an ordinary read must not list them.
--
-- The `promotion_id in (select ...)` clause is not redundant with the
-- permission check beside it: that subquery is itself filtered by 0044's
-- policy, so an archived promotion's links are visible to exactly whoever can
-- see the archived promotion. Without it a delegate who kept an id could read
-- the links of a promotion that has left every one of their other reads — the
-- links, not the promotion, would become the leak.
create policy promotion_prizes_select_promotions_view on public.promotion_prizes
  for select to authenticated
  using (
    deleted_at is null
    and public.has_permission('promotions.view', company_id)
    and promotion_id in (select id from public.promotions)
  );

-- Same shape one level down, and the subquery is what carries both the
-- soft-delete filter and the archived-promotion rule from the policy above
-- rather than restating either.
create policy promotion_prize_balances_select_promotions_view on public.promotion_prize_balances
  for select to authenticated
  using (
    public.has_permission('promotions.view', company_id)
    and promotion_prize_id in (select id from public.promotion_prizes)
  );
```

- [ ] **Step 4: Run the suite green**

Run: `npm run db:reset && npm run db:test`

Expected: `04_promotion_prizes.test.sql` reports 27 of 27; the other three files unchanged and green.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/0046_rls_promotion_prizes.sql supabase/tests/04_promotion_prizes.test.sql
git commit -m "$(cat <<'EOF'
feat(promotions): the read gate on the link and its projection

Read-only for both roles, gated on promotions.view, with the archived-promotion
rule inherited through a subquery over promotions rather than restated — a
delegate who kept an id must not be able to read the links of a promotion that
has left every one of their other reads.

TRUNCATE is revoked from service_role in the same migration as the grant rather
than in a later fix, which is where 0029 ended up having to do it.

Earlier in the block than the RLS migration usually sits, because every
following task asserts state by reading these two tables.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: The ledger's single writer, feeding both projections

**Files:**
- Create: `supabase/migrations/0047_promotion_prize_ledger.sql`
- Modify: `supabase/tests/02_permissions.test.sql:364,369,373,377` (the pinned signature)
- Modify: `supabase/tests/04_promotion_prizes.test.sql` (plan count 27 → 34, new section)

**Interfaces:**
- Consumes: `public.ensure_inventory_balance_row(uuid, uuid, uuid)` (0030), `public.promotion_prize_balances` (0045).
- Produces: `public.ensure_promotion_prize_balance_row(uuid, uuid, uuid, uuid) returns void`; `public.apply_inventory_movement(uuid, uuid, public.inventory_movement_type, integer, public.inventory_bucket, public.inventory_bucket, text, text, uuid) returns uuid` — the ninth parameter is `p_promotion_prize_id uuid default null`, and **every existing eight-argument call site in 0027 and 0030 keeps working through that default.**

**The trap this task exists to avoid:** `create or replace function` cannot change a function's argument list. Adding the ninth parameter that way creates a *second* overload and leaves the eight-argument one in place — every existing caller would keep resolving to the old body and would silently never write the new projection, which is the precise defect this block exists to prevent. The old signature must be dropped first. Postgres does not track plpgsql body dependencies, so the drop succeeds and the five RPCs in 0027/0030 re-resolve to the new function at their next call.

- [ ] **Step 1: Repoint the pinned signature in 02_permissions**

Four occurrences in `supabase/tests/02_permissions.test.sql` (lines 364, 369, 373, 377) spell the signature out for `::regprocedure` and `has_function_privilege`. Each must gain `, uuid` before the closing parenthesis:

```
'public.apply_inventory_movement(uuid, uuid, public.inventory_movement_type, integer, public.inventory_bucket, public.inventory_bucket, text, text, uuid)'
```

Leave the assertion texts as they are. Add this comment immediately above the block that starts at line 357:

```sql
-- The signature is spelled out rather than matched by name because pinning
-- SECURITY INVOKER and the empty grant grid on "whichever overload exists" is
-- exactly the assertion that would survive 0047 leaving the old eight-argument
-- function behind alongside the new one. Block 4b widened it to nine; if a
-- later block widens it again, this lookup fails loudly rather than silently
-- checking the wrong function.
```

- [ ] **Step 2: Write the failing assertions for the projection write**

In `supabase/tests/04_promotion_prizes.test.sql`, change the plan to `select plan(34);` — 27 before this task, and this section adds 7 — and insert this section immediately before the read-gate section added in Task 2:

```sql
-- The ledger's single writer feeds both projections ---------------------------
-- Called directly, which nothing outside a SECURITY DEFINER body can do: the
-- function holds EXECUTE for nobody and this file runs as the owner. That is
-- the point — these assertions are about the mechanics, not about who may
-- reach them, and 02_permissions.test.sql pins the grant grid separately.

select has_function('public', 'ensure_promotion_prize_balance_row',
                    'the projection has exactly one INSERT statement, in its own function');

insert into public.inventory_movements
  (organization_id, company_id, prize_id, movement_type, quantity, from_bucket, to_bucket)
values ('00000000-0000-0000-0000-0000000004b1','00000000-0000-0000-0000-0000000004c1',
        '00000000-0000-0000-0000-0000000004a2', 'MANUAL_ENTRY', 20, null, 'available');
insert into public.inventory_balances
  (company_id, prize_id, organization_id, available)
values ('00000000-0000-0000-0000-0000000004c1', '00000000-0000-0000-0000-0000000004a2',
        '00000000-0000-0000-0000-0000000004b1', 20);

insert into public.promotion_prizes
  (id, promotion_id, prize_id, organization_id, company_id) values
  ('00000000-0000-0000-0000-0000000004e2', '00000000-0000-0000-0000-0000000004d1',
   '00000000-0000-0000-0000-0000000004a2', '00000000-0000-0000-0000-0000000004b1',
   '00000000-0000-0000-0000-0000000004c1');

select lives_ok(
  $$select public.apply_inventory_movement(
      '00000000-0000-0000-0000-0000000004c1'::uuid,
      '00000000-0000-0000-0000-0000000004a2'::uuid,
      'PROMOTION_LINK'::public.inventory_movement_type, 4,
      'available'::public.inventory_bucket, 'linked'::public.inventory_bucket,
      null, null,
      '00000000-0000-0000-0000-0000000004e2'::uuid)$$,
  'a link movement goes through the one writer');

select is(
  (select linked from public.promotion_prize_balances
    where promotion_prize_id = '00000000-0000-0000-0000-0000000004e2'),
  4, 'the per-promotion projection was written inside the same transaction');

select is(
  (select available from public.inventory_balances
    where company_id = '00000000-0000-0000-0000-0000000004c1'
      and prize_id = '00000000-0000-0000-0000-0000000004a2'),
  16, 'and the Station-wide projection moved too');

select lives_ok(
  $$select public.apply_inventory_movement(
      '00000000-0000-0000-0000-0000000004c1'::uuid,
      '00000000-0000-0000-0000-0000000004a2'::uuid,
      'PROMOTION_UNLINK'::public.inventory_movement_type, 1,
      'linked'::public.inventory_bucket, 'available'::public.inventory_bucket,
      null, null,
      '00000000-0000-0000-0000-0000000004e2'::uuid)$$,
  'an unlink movement goes through the one writer');

select is(
  (select linked from public.promotion_prize_balances
    where promotion_prize_id = '00000000-0000-0000-0000-0000000004e2'),
  3, 'and takes the per-promotion figure back down');

-- The Block 6 tripwire. The branch below is unreachable while
-- inventory_movements_promotion_reference (0045) admits promotion_prize_id on
-- exactly two movement types — so the check is dropped here, inside a
-- transaction that rolls back, which is the only way to reach it. Its whole
-- purpose is that Block 6, which widens that constraint to DRAW and DELIVERY,
-- finds this function refusing rather than silently not projecting.
alter table public.inventory_movements drop constraint inventory_movements_promotion_reference;

select throws_ok(
  $$select public.apply_inventory_movement(
      '00000000-0000-0000-0000-0000000004c1'::uuid,
      '00000000-0000-0000-0000-0000000004a2'::uuid,
      'DRAW'::public.inventory_movement_type, 1,
      'linked'::public.inventory_bucket, 'awaiting_pickup'::public.inventory_bucket,
      null, null,
      '00000000-0000-0000-0000-0000000004e2'::uuid)$$,
  'XX000', null,
  'a movement type this function cannot project onto a promotion is refused, not ignored');
```

- [ ] **Step 3: Run and confirm both suites fail for the right reason**

Run: `npm run db:reset && npm run db:test`

Expected: `02_permissions.test.sql` errors on the `::regprocedure` lookup (`function "public.apply_inventory_movement(...uuid)" does not exist`), and `04` fails at `has_function('public', 'ensure_promotion_prize_balance_row', ...)`.

- [ ] **Step 4: Write the migration**

Create `supabase/migrations/0047_promotion_prize_ledger.sql`. Take the body of `apply_inventory_movement` from `0030_inventory_adjustment_semantics.sql:67-186` **verbatim** and make exactly the three insertions marked below — the locking, the replay detection, the sufficiency check and the audit write are otherwise unchanged, the same way 0030 changed only the bootstrap.

```sql
-- supabase/migrations/0047_promotion_prize_ledger.sql

-- The bootstrap for the second projection, in its own function for the reason
-- ensure_inventory_balance_row's comment gives: the schema should hold exactly
-- one INSERT statement against a projection table, so that a future auditor
-- grepping for writers finds one. SECURITY INVOKER, EXECUTE granted to nobody
-- — reachable only from inside a SECURITY DEFINER body, where it runs with
-- that body's privileges.
create or replace function public.ensure_promotion_prize_balance_row(
  p_promotion_prize_id uuid,
  p_prize_id           uuid,
  p_company_id         uuid,
  p_org                uuid
)
returns void
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  insert into public.promotion_prize_balances
    (promotion_prize_id, prize_id, company_id, organization_id)
  values (p_promotion_prize_id, p_prize_id, p_company_id, p_org)
  on conflict (promotion_prize_id) do nothing;
end;
$$;

revoke execute on function public.ensure_promotion_prize_balance_row(uuid, uuid, uuid, uuid) from public;

comment on function public.ensure_promotion_prize_balance_row(uuid, uuid, uuid, uuid) is
  'The only INSERT statement against promotion_prize_balances anywhere in the schema. Creates an all-zero row the first time a link is moved. Every arithmetic UPDATE against that table happens exclusively inside apply_inventory_movement, the same division ensure_inventory_balance_row (0030) has with it.';

-- ---------------------------------------------------------------------------
-- apply_inventory_movement, DROPPED and recreated rather than replaced.
--
-- create or replace cannot change a function's argument list: it would create a
-- second, nine-argument overload and leave the eight-argument one in place.
-- Every existing caller — record_stock_entry, record_stock_exit, adjust_stock,
-- reserve_stock, release_reservation — would keep resolving to the old body and
-- would silently never write the new projection, which is the exact defect this
-- block exists to prevent. Postgres does not track plpgsql body dependencies,
-- so the drop succeeds and those five re-resolve to this function, through the
-- default on the new parameter, at their next call.
--
-- Nothing else about this function changes. The lock order is now prize ->
-- inventory_balances -> promotion_prize_balances, taken in that order by every
-- caller, so two concurrent movements cannot deadlock against each other.
-- ---------------------------------------------------------------------------
drop function public.apply_inventory_movement(
  uuid, uuid, public.inventory_movement_type, integer,
  public.inventory_bucket, public.inventory_bucket, text, text);

create function public.apply_inventory_movement(
  p_company_id         uuid,
  p_prize_id           uuid,
  p_type               public.inventory_movement_type,
  p_quantity           integer,
  p_from               public.inventory_bucket,
  p_to                 public.inventory_bucket,
  p_note               text,
  p_idempotency_key    text,
  p_promotion_prize_id uuid default null
)
returns uuid
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  v_actor    uuid := auth.uid();
  v_org      uuid;
  v_id       uuid;
  v_current  integer;
begin
  -- [ 0030:87-119 verbatim: the quantity guard, the prize FOR SHARE with its
  --   whole comment, ensure_inventory_balance_row, and the FOR UPDATE on
  --   inventory_balances. ]

  -- INSERTION 1, immediately after the FOR UPDATE on inventory_balances and
  -- before the movement is appended. Taken here rather than beside the
  -- arithmetic below so the lock order is the same for every caller; a replay
  -- that returns early will have bootstrapped an all-zero row and written
  -- nothing to it, which is exactly what ensure_inventory_balance_row already
  -- does on the same path.
  if p_promotion_prize_id is not null then
    perform public.ensure_promotion_prize_balance_row(
      p_promotion_prize_id, p_prize_id, p_company_id, v_org);

    perform 1 from public.promotion_prize_balances
     where promotion_prize_id = p_promotion_prize_id
       for update;
  end if;

  -- [ 0030:121-175 verbatim: the append with ON CONFLICT, the replay return,
  --   the source sufficiency check and both bucket updates. The INSERT gains
  --   promotion_prize_id in its column list and p_promotion_prize_id in its
  --   VALUES list — see below. ]

  -- INSERTION 2, inside the existing INSERT into inventory_movements: add
  -- `promotion_prize_id` as the last column and `p_promotion_prize_id` as the
  -- last value. The check constraint in 0045 is what refuses the two ways that
  -- can be wrong.

  -- INSERTION 3, after the p_to bucket update and before the audit write.
  --
  -- This reads movement_type, which the bucket arithmetic above deliberately
  -- does not. It has to: `linked` on this projection is not the `linked`
  -- bucket. It counts units committed to the promotion and is NOT decremented
  -- when one is drawn — drawn is its own counter and Resto is linked - drawn
  -- (0045's column comments). Driving it from the bucket pair would be right
  -- today and wrong the moment Block 6's DRAW moves linked -> awaiting_pickup
  -- carrying a promotion reference.
  if p_promotion_prize_id is not null then
    if p_type = 'PROMOTION_LINK' then
      update public.promotion_prize_balances
         set linked = linked + p_quantity, updated_at = now()
       where promotion_prize_id = p_promotion_prize_id;
    elsif p_type = 'PROMOTION_UNLINK' then
      update public.promotion_prize_balances
         set linked = linked - p_quantity, updated_at = now()
       where promotion_prize_id = p_promotion_prize_id;
    else
      -- Unreachable while inventory_movements_promotion_reference (0045)
      -- admits promotion_prize_id on exactly those two types, and said so
      -- rather than left to look like protection. It is a tripwire for Block
      -- 6: that block widens the constraint to DRAW, DELIVERY and the return
      -- types, and this is what makes it fail loudly instead of appending a
      -- movement the projection never hears about. Reached in
      -- 04_promotion_prizes.test.sql by dropping that constraint inside a
      -- transaction that rolls back.
      raise exception
        'apply_inventory_movement cannot project movement type % onto a promotion prize', p_type
        using errcode = 'XX000';
    end if;
  end if;

  -- [ 0030:177-184 verbatim: the audit write and `return v_id;`. The audit
  --   detail gains 'promotion_prize_id', p_promotion_prize_id as a final key —
  --   null on every movement that names no promotion, which is how the audit
  --   log stays readable for Block 2's rows. ]
end;
$$;

revoke execute on function public.apply_inventory_movement(uuid, uuid, public.inventory_movement_type, integer, public.inventory_bucket, public.inventory_bucket, text, text, uuid) from public;

comment on function public.apply_inventory_movement(uuid, uuid, public.inventory_movement_type, integer, public.inventory_bucket, public.inventory_bucket, text, text, uuid) is
  'Private ledger mechanics shared by every movement RPC: locks the balance row (bootstrap shared with adjust_stock via ensure_inventory_balance_row, 0030), locks the per-promotion balance row when the movement names one, appends the movement (a replay is detected via ON CONFLICT on the partial unique index over (company_id, idempotency_key) and returns the original movement with both projections untouched), moves the buckets, moves the per-promotion figure, and writes the audit row. Dropped and recreated in 0047 rather than replaced, because create or replace cannot change an argument list and the eight-argument overload left behind would have made every eight-argument call ambiguous between the two and raised 42725 at call time — 02_permissions.test.sql counts pg_proc entries by this name for exactly that reason, the signature lookups beside it being unable to see a twin. SECURITY INVOKER, EXECUTE granted to nobody. Lock order is prize (FOR SHARE), inventory_balances, promotion_prize_balances — the same order for every caller. Idempotency keys are scoped to the Station, not to a prize: a client reusing "retry-1" across two prizes in one Station silently gets the first movement back. p_promotion_prize_id is projected by movement_type, not by the bucket pair, because linked on that projection counts units committed to the promotion and is not decremented by a draw; a type it does not know is refused with XX000 rather than appended silently.';
```

- [ ] **Step 5: Run both suites green**

Run: `npm run db:reset && npm run db:test`

Expected: `02_permissions.test.sql` 208 of 208, `04_promotion_prizes.test.sql` 34 of 34, `00`/`01`/`03` unchanged. If `02` fails on an inventory movement case rather than the signature, the eight-argument overload was not really dropped — check for a second row in `pg_proc` for `apply_inventory_movement`.

- [ ] **Step 6: Prove the five existing callers still reach it**

Run: `npm run test:isolation -- tests/isolation/inventory.test.ts`

Expected: every case green, unchanged. This is the assertion that the default on the ninth parameter actually carries the old call sites; nothing in pgTAP covers it, because those five RPCs are only exercised end to end.

- [ ] **Step 7: Commit**

```bash
git add supabase/migrations/0047_promotion_prize_ledger.sql supabase/tests/02_permissions.test.sql supabase/tests/04_promotion_prizes.test.sql
git commit -m "$(cat <<'EOF'
feat(inventory): the one writer now feeds the per-promotion projection too

apply_inventory_movement is dropped and recreated rather than replaced. create
or replace cannot change an argument list: it would have left the eight-argument
overload in place, and all five existing movement RPCs would have gone on
resolving to it and silently never writing the new projection — the exact defect
this block exists to prevent. 02_permissions.test.sql pins the signature
literally, so that mistake fails the suite rather than passing it.

The per-promotion figure is projected from movement_type, not from the bucket
pair the rest of the function reads. It has to be: linked there counts units
committed to the promotion and is not decremented when one is drawn. A type the
function does not know is refused with XX000 — unreachable today, and reached in
pgTAP by dropping the constraint that makes it so, because it is the tripwire
Block 6 will hit if it widens that constraint without coming back here.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Reconciliation reaches the second projection

**Files:**
- Create: `supabase/migrations/0048_reconcile_promotion_prizes.sql`
- Modify: `src/services/inventory.ts:90-96` (`ReconciliationRow`), `:550-556` (the mapping)
- Modify: `src/app/(app)/inventory/reconciliation-panel.tsx:49-67`
- Modify: `src/lib/supabase/database.types.ts` (regenerated, not hand-edited — it is stale as of Task 3 and this is the task that fixes it)
- Modify: `tests/isolation/inventory.test.ts` (two new cases)
- Modify: `supabase/tests/02_permissions.test.sql` (plan 208 → 212, four assertions)

**Two gaps Task 3 surfaced are closed here**, both added to this task rather than left for the final review because this is the task that already touches the two files involved:

1. **`release_reservation` is never called anywhere in the isolation suite.** It is one of the five RPCs that reach `apply_inventory_movement` through the default on its new ninth parameter, and it was the only one with no end-to-end net under it when that function was dropped and recreated. Nothing in pgTAP covers those call sites; the isolation suite is the only thing that can.
2. **`ensure_promotion_prize_balance_row`'s SECURITY INVOKER and empty grant grid are not pinned**, while its twin `ensure_inventory_balance_row` is pinned four ways at `supabase/tests/02_permissions.test.sql:390-407`. A private helper that quietly became DEFINER, or that picked up an EXECUTE grant, is a second unaudited write path into a projection — which is the property those four assertions exist to protect.

**Interfaces:**
- Produces: `public.reconcile_inventory(uuid)` returning `(prize_id uuid, prize_name text, promotion_prize_id uuid, promotion_name text, bucket text, stored integer, computed integer)`. The two new columns are **null on every per-prize row**, which is what tells the two kinds of row apart.
- Consumes: `public.promotion_prize_balances` (0045), `public.inventory_movements.promotion_prize_id` (0045).

**Why the return type changes rather than a second function being added:** a projection nothing reconciles is a projection that drifts silently, and an operator who has to remember to run a *second* check has a projection that drifts silently in practice. One button, one answer.

- [ ] **Step 1: Write the failing isolation case**

Append to `tests/isolation/inventory.test.ts`, inside the same `describe` as the existing reconciliation case (it sits at line 381). It needs `promotion_prizes` seeded through the real RPC, which does not exist until Task 5 — so this case drives the *ledger* directly through `apply_inventory_movement`'s public callers and asserts the per-promotion half only after Task 5 lands. Write it now as the per-prize regression it is, and Task 5 adds the per-promotion assertions:

```ts
  it('reconciliation still reports the per-prize divergence, and now says which promotion a row belongs to', async () => {
    const label = `inv-recon-shape-${Date.now()}`;
    const customer = await provisionCustomer(label);
    const prizeId = await createPrizeAs(customer, `Prize ${label}`);
    const delegate = await grantRoleWith(customer, label, ['inventory.view', 'inventory.entry']);
    const client = await signInAs(delegate.email, delegate.password);

    await client.rpc('record_stock_entry', {
      p_company_id: customer.companyId,
      p_prize_id: prizeId,
      p_type: 'MANUAL_ENTRY',
      p_quantity: 6,
    });

    corruptBalanceDirectly(customer.companyId, prizeId, 'written_off', 2);

    const dirty = await client.rpc('reconcile_inventory', { p_company_id: customer.companyId });
    expect(dirty.error).toBeNull();
    expect(dirty.data).toHaveLength(1);

    // The two new columns are null on a per-prize row, and that is what tells
    // the two kinds of row apart on screen. Asserted explicitly rather than
    // left to toMatchObject, which would pass if they were missing entirely.
    expect(dirty.data![0]).toEqual({
      prize_id: prizeId,
      prize_name: `Prize ${label}`,
      promotion_prize_id: null,
      promotion_name: null,
      bucket: 'written_off',
      stored: 2,
      computed: 0,
    });
  });
```

- [ ] **Step 2: Run it and confirm it fails for the right reason**

Run: `npm run test:isolation -- tests/isolation/inventory.test.ts`

Expected: the new case fails on the `toEqual` — the row has five keys, not seven. Every other case in the file stays green.

- [ ] **Step 3: Write the migration**

Create `supabase/migrations/0048_reconcile_promotion_prizes.sql`:

```sql
-- supabase/migrations/0048_reconcile_promotion_prizes.sql
--
-- reconcile_inventory gains the second projection. Dropped and recreated
-- because its OUT parameter list changes, which create or replace cannot do —
-- the same constraint 0047 hit, with none of that one's danger: this function
-- has no callers inside the database, only PostgREST and the isolation suite,
-- and both resolve it by name.
--
-- It still reports; it does not repair. No INSERT, UPDATE or DELETE appears in
-- it, and none should ever be added: a projection that silently self-heals
-- turns a bug in a movement RPC into a number that is briefly wrong and then
-- quietly right, which is the hardest kind to find.
--
-- Every reference below is table-qualified. The OUT parameters share their
-- names with columns in the body, and an unqualified reference to any of them
-- is an ambiguity error at plan time rather than at call time — which is the
-- shape 0028 was already written in, for this reason.
drop function public.reconcile_inventory(uuid);

create function public.reconcile_inventory(p_company_id uuid)
returns table (
  prize_id           uuid,
  prize_name         text,
  promotion_prize_id uuid,
  promotion_name     text,
  bucket             text,
  stored             integer,
  computed           integer
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor uuid := auth.uid();
begin
  if not public.has_permission('inventory.view', p_company_id) then
    raise log 'reconcile_inventory denied: actor=% company=%', v_actor, p_company_id;
    raise exception 'permission denied: inventory.view required' using errcode = '42501';
  end if;

  return query
    -- [ 0028:49-83 verbatim: the movement_totals, computed and stored CTEs,
    --   with their whole comments. Nothing about the per-prize half changes. ]
    with movement_totals as ( ... ),
    computed_buckets as ( ... ),   -- 0028's `computed`, renamed only to keep it
                                   -- distinct from the OUT parameter of the
                                   -- same name now that a second half of this
                                   -- query also has one
    stored_buckets as ( ... ),     -- 0028's `stored`, renamed for the same reason

    per_prize as (
      select
        coalesce(s.prize_id, c.prize_id)   as prize_id,
        coalesce(s.bucket, c.bucket)::text as bucket,
        coalesce(s.stored, 0)              as stored,
        coalesce(c.computed, 0)            as computed
      from stored_buckets s
      full outer join computed_buckets c
        on c.prize_id = s.prize_id and c.bucket = s.bucket
      where coalesce(s.stored, 0) <> coalesce(c.computed, 0)
    ),

    -- The per-promotion half reads movement_type, which the half above
    -- deliberately does not. It has to: `linked` on promotion_prize_balances is
    -- not the `linked` bucket. It counts units committed to the promotion and
    -- is NOT decremented when one is drawn — drawn is its own counter, and
    -- Resto is linked - drawn. The two halves of this one function now read the
    -- ledger differently, and each is right for what it measures; said out loud
    -- rather than left for the next reader to reconcile on their own.
    promotion_computed as (
      select
        m.promotion_prize_id,
        'linked'::text as bucket,
        sum(case when m.movement_type = 'PROMOTION_LINK'   then  m.quantity
                 when m.movement_type = 'PROMOTION_UNLINK' then -m.quantity
                 else 0 end)::integer as computed
      from public.inventory_movements m
      where m.company_id = p_company_id and m.promotion_prize_id is not null
      group by m.promotion_prize_id
      union all
      -- DRAW and DRAW_CANCEL cannot carry a promotion_prize_id until Block 6
      -- widens the ledger check (0045), so this arm computes 0 for every row
      -- today. It is here rather than omitted because `drawn` IS stored, and a
      -- stored figure nothing recomputes is a figure that can be wrong forever:
      -- a hand-written drawn surfaces as stored = N against computed = 0, which
      -- is the truth — the ledger has no record of it. When Block 6 starts
      -- writing those movements this arm begins returning real figures with no
      -- change here.
      select
        m.promotion_prize_id,
        'drawn'::text,
        sum(case when m.movement_type = 'DRAW'        then  m.quantity
                 when m.movement_type = 'DRAW_CANCEL' then -m.quantity
                 else 0 end)::integer
      from public.inventory_movements m
      where m.company_id = p_company_id and m.promotion_prize_id is not null
      group by m.promotion_prize_id
    ),

    promotion_stored as (
      select b.promotion_prize_id, v.bucket, v.stored
      from public.promotion_prize_balances b,
      lateral (values
        ('linked'::text, b.linked),
        ('drawn'::text,  b.drawn)
      ) as v(bucket, stored)
      where b.company_id = p_company_id
    ),

    -- FULL OUTER JOIN for the same reason the half above uses one: a link with
    -- movements and no balance row, and a balance row with no movements behind
    -- it, are exactly the two divergences an inner join would drop.
    per_promotion as (
      select
        coalesce(ps.promotion_prize_id, pc.promotion_prize_id) as promotion_prize_id,
        coalesce(ps.bucket, pc.bucket)                         as bucket,
        coalesce(ps.stored, 0)                                 as stored,
        coalesce(pc.computed, 0)                               as computed
      from promotion_stored ps
      full outer join promotion_computed pc
        on pc.promotion_prize_id = ps.promotion_prize_id and pc.bucket = ps.bucket
      where coalesce(ps.stored, 0) <> coalesce(pc.computed, 0)
    )

    select pp.prize_id, pz.name, null::uuid, null::text, pp.bucket, pp.stored, pp.computed
    from per_prize pp
    join public.prizes pz on pz.id = pp.prize_id
    union all
    -- The link is joined without its deleted_at filter on purpose: a link that
    -- was unwound to nothing still has ledger rows behind it, and a divergence
    -- on a soft-deleted link is exactly as much of a problem as one on a live
    -- link. Filtering it out here would make unlinking a way to hide a broken
    -- figure.
    select l.prize_id, pz.name, x.promotion_prize_id, pr.name, x.bucket, x.stored, x.computed
    from per_promotion x
    join public.promotion_prizes l on l.id = x.promotion_prize_id
    join public.prizes pz          on pz.id = l.prize_id
    join public.promotions pr      on pr.id = l.promotion_id
    order by 2, 4 nulls first, 5;
end;
$$;

comment on function public.reconcile_inventory(uuid) is
  'Recomputes both projections for a Station from inventory_movements alone and returns only the rows where the stored figure differs. Per-prize rows carry a null promotion_prize_id and promotion_name, and are computed from the bucket pair — computed(b) = sum(quantity where to_bucket = b) - sum(quantity where from_bucket = b) — so a movement type introduced by a later Block needs no change here. Per-promotion rows name the link and the promotion, and are computed from movement_type instead, because linked on that projection counts units committed to the promotion and is NOT decremented by a draw. The drawn arm computes 0 for every row until Block 6 starts writing DRAW movements that carry a promotion reference; it is present today so that a hand-written drawn surfaces as stored=N against computed=0. It reports; it does not repair — no INSERT, UPDATE or DELETE appears in this function. Both halves use a FULL OUTER JOIN so a key present on only one side is not silently dropped. Soft-deleted links are included: unlinking must not become a way to hide a divergence. Gated on inventory.view, resolved from p_company_id — never from a caller-supplied Organization id.';

revoke execute on function public.reconcile_inventory(uuid) from public;
grant execute on function public.reconcile_inventory(uuid) to authenticated;
```

- [ ] **Step 4: Regenerate the database types**

Run: `npm run db:reset && npm run db:types`

Expected: `src/lib/supabase/database.types.ts` shows `reconcile_inventory` returning the seven columns. Never hand-edit this file.

- [ ] **Step 5: Widen the TypeScript row**

In `src/services/inventory.ts`, replace the `ReconciliationRow` interface (lines 90–96):

```ts
export interface ReconciliationRow {
  prizeId: string;
  prizeName: string;
  /** Null on a per-prize row. Non-null names the promotion link the figure belongs to. */
  promotionPrizeId: string | null;
  /** Null on a per-prize row, for the same reason. */
  promotionName: string | null;
  bucket: string;
  stored: number;
  computed: number;
}
```

and the mapping inside `reconcileInventory` (lines 550–556):

```ts
  return (data ?? []).map((row) => ({
    prizeId: row.prize_id,
    prizeName: row.prize_name,
    promotionPrizeId: row.promotion_prize_id,
    promotionName: row.promotion_name,
    bucket: row.bucket,
    stored: row.stored,
    computed: row.computed,
  }));
```

- [ ] **Step 6: Show it on the panel**

In `src/app/(app)/inventory/reconciliation-panel.tsx`, add a header cell after `Prize` (line 49) and a body cell after the prize name (line 62):

```tsx
                  <th className="px-3 py-2 font-medium">Promotion</th>
```

```tsx
                    <td className="px-3 py-2 text-muted-foreground">
                      {row.promotionName ?? '—'}
                    </td>
```

and widen the row key (line 58) so two rows differing only by link are distinct:

```tsx
                    key={`${row.prizeId}-${row.promotionPrizeId ?? 'station'}-${row.bucket}-${index}`}
```

- [ ] **Step 7: Pin the new helper's grant grid**

In `supabase/tests/02_permissions.test.sql`, change `select plan(208);` to `select plan(212);` and add, immediately after the four `ensure_inventory_balance_row` assertions that end at line 407:

```sql
-- Block 4b's second bootstrap, pinned exactly as the first one above is. A
-- private helper that quietly became DEFINER, or that picked up an EXECUTE
-- grant, is a second unaudited write path into a projection — which is the
-- whole property these assertions exist to protect, and it is worth no less
-- here than it was for inventory_balances.
select is(
  (select prosecdef from pg_proc
    where oid = 'public.ensure_promotion_prize_balance_row(uuid, uuid, uuid, uuid)'::regprocedure),
  false,
  'ensure_promotion_prize_balance_row is SECURITY INVOKER, not DEFINER'
);
select ok(
  not has_function_privilege('anon', 'public.ensure_promotion_prize_balance_row(uuid, uuid, uuid, uuid)', 'EXECUTE'),
  'anon may not call ensure_promotion_prize_balance_row'
);
select ok(
  not has_function_privilege('authenticated', 'public.ensure_promotion_prize_balance_row(uuid, uuid, uuid, uuid)', 'EXECUTE'),
  'authenticated may not call ensure_promotion_prize_balance_row'
);
select ok(
  not has_function_privilege('service_role', 'public.ensure_promotion_prize_balance_row(uuid, uuid, uuid, uuid)', 'EXECUTE'),
  'service_role may not call ensure_promotion_prize_balance_row'
);
```

- [ ] **Step 8: Put a net under the fifth caller**

`release_reservation` is the one RPC reaching `apply_inventory_movement` that the isolation suite never calls, which means Task 3 dropped and recreated that function with four of its five call sites covered and this one resting on inspection alone. Append to `tests/isolation/inventory.test.ts`, in the same `describe` as the other movement cases:

```ts
  it('releases a reservation back into available, which is the fifth call site into the one writer', async () => {
    const label = `inv-release-${Date.now()}`;
    const customer = await provisionCustomer(label);
    const prizeId = await createPrizeAs(customer, `Prize ${label}`);
    const delegate = await grantRoleWith(customer, label, [
      'inventory.view',
      'inventory.entry',
      'inventory.reserve',
    ]);
    const client = await signInAs(delegate.email, delegate.password);

    await client.rpc('record_stock_entry', {
      p_company_id: customer.companyId,
      p_prize_id: prizeId,
      p_type: 'MANUAL_ENTRY',
      p_quantity: 9,
    });
    await client.rpc('reserve_stock', {
      p_company_id: customer.companyId,
      p_prize_id: prizeId,
      p_quantity: 4,
      p_note: 'held for the afternoon show',
    });

    const released = await client.rpc('release_reservation', {
      p_company_id: customer.companyId,
      p_prize_id: prizeId,
      p_quantity: 3,
      p_note: 'show cancelled',
    });
    expect(released.error).toBeNull();

    const balance = await client
      .from('inventory_balances')
      .select('available, reserved')
      .eq('prize_id', prizeId)
      .single();
    expect(balance.data).toEqual({ available: 8, reserved: 1 });

    // The projection agrees with the ledger it was written from. This is what
    // would go red if release_reservation stopped reaching the one writer —
    // an eight-argument call resolving to a function that no longer exists
    // fails loudly, but one resolving to a stale overload would not.
    const check = await client.rpc('reconcile_inventory', { p_company_id: customer.companyId });
    expect(check.error).toBeNull();
    expect(check.data).toEqual([]);
  });
```

- [ ] **Step 9: Run every gate green**

Run: `npm run typecheck && npm run lint && npm test && npm run db:test && npm run test:isolation -- tests/isolation/inventory.test.ts`

Expected: all green — the two new cases, `02_permissions.test.sql` at 212 of 212, and the two pre-existing reconciliation cases at `inventory.test.ts:70` and `:381`; the latter asserts with `toMatchObject`, so the two extra null keys do not disturb it.

- [ ] **Step 10: Commit**

```bash
git add supabase/migrations/0048_reconcile_promotion_prizes.sql src/services/inventory.ts src/app/\(app\)/inventory/reconciliation-panel.tsx src/lib/supabase/database.types.ts tests/isolation/inventory.test.ts supabase/tests/02_permissions.test.sql
git commit -m "$(cat <<'EOF'
feat(inventory): reconciliation reaches the per-promotion projection

One button, one answer: a second check an operator has to remember to run is a
projection that drifts silently in practice.

The two halves of this one function now read the ledger differently. The
per-prize half reads the bucket pair, as it always has. The per-promotion half
reads movement_type, because linked on that projection counts units committed to
the promotion and is not decremented when one is drawn — driving it from the
buckets would be right today and wrong the moment Block 6's DRAW moves linked to
awaiting_pickup carrying a promotion reference.

The drawn arm computes zero for every row until Block 6 writes those movements.
It is here anyway: drawn IS stored, and a stored figure nothing recomputes can be
wrong forever.

Soft-deleted links are included, so unlinking cannot become a way to hide a
divergence.

Two gaps 0047 surfaced close here as well. release_reservation was the one of
the five callers into the single writer that no test ever called, so it went
through that function being dropped and recreated on inspection alone; it has a
case now. And the new bootstrap's SECURITY INVOKER and empty grant grid are
pinned the four ways its twin has been pinned since 0030 — a private helper that
quietly becomes DEFINER is a second unaudited write path into a projection.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Linking and unlinking

**Files:**
- Create: `supabase/migrations/0049_promotion_prize_rpcs.sql` (link and unlink only; Task 6's shared helper and the two recreated lifecycle functions go in `0050`, because this file is committed at the end of this task)
- Create: `tests/isolation/promotion-prizes.test.ts`
- Modify: `tests/isolation/harness.ts` (append `setPromotionPrizeDrawnDirectly`)

**Interfaces:**
- Produces:
  - `public.link_prize_to_promotion(p_promotion_id uuid, p_prize_id uuid, p_quantity integer, p_note text default null) returns uuid` — the `promotion_prizes.id`.
  - `public.unlink_prize_from_promotion(p_promotion_id uuid, p_prize_id uuid, p_quantity integer, p_note text default null) returns void`.
  - `setPromotionPrizeDrawnDirectly(promotionPrizeId: string, drawn: number): void` in the harness.
- Consumes: `public.apply_inventory_movement(..., uuid)` (0047), `public.has_permission` (0024).

**Neither RPC requires a note**, unlike `record_stock_exit` and `reserve_stock`. The link itself names the promotion, which is the explanation an exit or a reservation lacks; a mandatory note here would be ceremony. Neither takes an idempotency key either — 4a's five RPCs do not, and the record dialog generates none.

- [ ] **Step 1: Add the harness helper**

`drawn` has no writer until Block 6, so D4's floor cannot be reached through any API. Append to `tests/isolation/harness.ts`:

```ts
/**
 * Sets `drawn` on one promotion_prize_balances row directly, outside
 * apply_inventory_movement — the same escape hatch corruptBalanceDirectly uses
 * and for a narrower reason: nothing writes `drawn` until Block 6 brings the
 * draw, so D4's floor ("do not unlink below what has been drawn") has no
 * reachable fixture through any RPC. 0046 revokes every write grant on this
 * table from every role, service_role included, so a direct connection to
 * Postgres as its superuser is the only route left, exactly as it is there.
 *
 * A row set this way is a real divergence and reconcile_inventory (0048) will
 * report it as stored=N against computed=0 — which is the truth, because the
 * ledger has no record of it. Do not use this helper inside a test that also
 * asserts reconciliation is clean.
 *
 * Invoked through node.exe against the CLI's own JS entrypoint rather than the
 * .bin shim, and the `UPDATE 1` command tag is checked rather than discarded,
 * both for the reasons corruptBalanceDirectly's comment sets out at length.
 */
export function setPromotionPrizeDrawnDirectly(promotionPrizeId: string, drawn: number): void {
  if (!UUID_RE.test(promotionPrizeId)) {
    throw new Error('setPromotionPrizeDrawnDirectly: promotion_prize_id must be a UUID');
  }
  if (!Number.isInteger(drawn) || drawn < 0) {
    throw new Error('setPromotionPrizeDrawnDirectly: drawn must be a non-negative integer');
  }

  const script = path.join(REPO_ROOT, 'node_modules', 'supabase', 'dist', 'supabase.js');
  const sql =
    `update promotion_prize_balances set drawn = ${drawn} ` +
    `where promotion_prize_id = '${promotionPrizeId}';`;

  const output = execFileSync(process.execPath, [script, 'db', 'query', '--local', sql], {
    encoding: 'utf8',
  });

  if (!/\bUPDATE 1\b/.test(output)) {
    throw new Error(
      `setPromotionPrizeDrawnDirectly: expected to update exactly one row ` +
        `(promotion_prize_id=${promotionPrizeId}); the CLI reported: ${output.trim()}`,
    );
  }
}
```

- [ ] **Step 2: Write the failing isolation suite**

Create `tests/isolation/promotion-prizes.test.ts`:

```ts
import { afterAll, describe, expect, it } from 'vitest';
import {
  addCompany,
  cleanupUsers,
  createPrizeAs,
  grantRoleWith,
  provisionCustomer,
  setPromotionPrizeDrawnDirectly,
  signInAs,
} from './harness';
import type { ProvisionedCustomer } from './harness';

afterAll(cleanupUsers);

/**
 * Block 4b's write RPCs, driven end to end.
 *
 * Every case is driven by a NON-OWNER delegate, for the reason members.test.ts's
 * own header gives: Block 1c shipped two defects that thirteen reviews missed
 * because every scenario had the owner driving, and the owner's bypass hid the
 * delegate's failure. The owner appears below only as fixture setup.
 */
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

async function clientFor(user: { email: string; password: string }) {
  return signInAs(user.email, user.password);
}

/** A promotion inside its window, registered by the owner. Fixture, never the operation under test. */
async function promotionAsOwner(
  customer: ProvisionedCustomer,
  window: { startsAt: string; endsAt: string } = {
    startsAt: new Date(Date.now() - HOUR).toISOString(),
    endsAt: new Date(Date.now() + 30 * DAY).toISOString(),
  },
): Promise<string> {
  const owner = await clientFor(customer);
  const { data, error } = await owner.rpc('create_promotion', {
    p_company_id: customer.companyId,
    p_name: `Promo ${Math.random().toString(36).slice(2, 8)}`,
    p_starts_at: window.startsAt,
    p_ends_at: window.endsAt,
  });
  if (error) throw new Error(`create_promotion failed: ${error.message}`);
  return data as string;
}

/** Puts `units` into `available` for a prize, as the owner. */
async function stockAsOwner(
  customer: ProvisionedCustomer,
  prizeId: string,
  units: number,
): Promise<void> {
  const owner = await clientFor(customer);
  const { error } = await owner.rpc('record_stock_entry', {
    p_company_id: customer.companyId,
    p_prize_id: prizeId,
    p_type: 'MANUAL_ENTRY',
    p_quantity: units,
  });
  if (error) throw new Error(`record_stock_entry failed: ${error.message}`);
}

describe('linking a prize to a promotion', () => {
  it('moves the units out of available and into the promotion, in one transaction', async () => {
    const label = `link-ok-${Date.now()}`;
    const customer = await provisionCustomer(label);
    const prizeId = await createPrizeAs(customer, `Bicycle ${label}`);
    await stockAsOwner(customer, prizeId, 10);
    const promotionId = await promotionAsOwner(customer);

    const delegate = await grantRoleWith(customer, label, [
      'promotions.view',
      'promotions.prizes',
      'inventory.view',
    ]);
    const client = await clientFor(delegate);

    const linked = await client.rpc('link_prize_to_promotion', {
      p_promotion_id: promotionId,
      p_prize_id: prizeId,
      p_quantity: 4,
    });
    expect(linked.error).toBeNull();
    const linkId = linked.data as string;

    const balance = await client
      .from('promotion_prize_balances')
      .select('linked, drawn')
      .eq('promotion_prize_id', linkId)
      .single();
    expect(balance.data).toEqual({ linked: 4, drawn: 0 });

    const station = await client
      .from('inventory_balances')
      .select('available, linked')
      .eq('prize_id', prizeId)
      .single();
    expect(station.data).toEqual({ available: 6, linked: 4 });
  });

  it('adds to the row that is there rather than creating a second one', async () => {
    const label = `link-again-${Date.now()}`;
    const customer = await provisionCustomer(label);
    const prizeId = await createPrizeAs(customer, `Headphones ${label}`);
    await stockAsOwner(customer, prizeId, 10);
    const promotionId = await promotionAsOwner(customer);

    const delegate = await grantRoleWith(customer, label, ['promotions.view', 'promotions.prizes']);
    const client = await clientFor(delegate);

    const first = await client.rpc('link_prize_to_promotion', {
      p_promotion_id: promotionId,
      p_prize_id: prizeId,
      p_quantity: 2,
    });
    const second = await client.rpc('link_prize_to_promotion', {
      p_promotion_id: promotionId,
      p_prize_id: prizeId,
      p_quantity: 3,
    });
    expect(second.error).toBeNull();
    // The same link, not a second one — which is what the partial unique index
    // in 0045 guarantees and what makes "Vinculados" a single figure on screen.
    expect(second.data).toBe(first.data);

    const links = await client
      .from('promotion_prizes')
      .select('id')
      .eq('promotion_id', promotionId);
    expect(links.data).toHaveLength(1);

    const balance = await client
      .from('promotion_prize_balances')
      .select('linked')
      .eq('promotion_prize_id', first.data as string)
      .single();
    expect(balance.data?.linked).toBe(5);
  });

  it('is allowed after the window has closed, and refused once cancelled', async () => {
    const label = `link-ended-${Date.now()}`;
    const customer = await provisionCustomer(label);
    const prizeId = await createPrizeAs(customer, `Speaker ${label}`);
    await stockAsOwner(customer, prizeId, 5);
    // Ends in a moment, so the window closes without anything being cancelled.
    const promotionId = await promotionAsOwner(customer, {
      startsAt: new Date(Date.now() - 2 * HOUR).toISOString(),
      endsAt: new Date(Date.now() - HOUR).toISOString(),
    });

    const delegate = await grantRoleWith(customer, label, ['promotions.view', 'promotions.prizes']);
    const client = await clientFor(delegate);

    // The draw happens after entries close (Block 6), so an ended promotion is
    // exactly when its prizes are most likely to be adjusted. Not an oversight.
    const ended = await client.rpc('link_prize_to_promotion', {
      p_promotion_id: promotionId,
      p_prize_id: prizeId,
      p_quantity: 1,
    });
    expect(ended.error).toBeNull();
  });

  it('refuses more units than are available, naming the figure', async () => {
    const label = `link-short-${Date.now()}`;
    const customer = await provisionCustomer(label);
    const prizeId = await createPrizeAs(customer, `Ticket ${label}`);
    await stockAsOwner(customer, prizeId, 3);
    const promotionId = await promotionAsOwner(customer);

    const delegate = await grantRoleWith(customer, label, ['promotions.view', 'promotions.prizes']);
    const client = await clientFor(delegate);

    const denied = await client.rpc('link_prize_to_promotion', {
      p_promotion_id: promotionId,
      p_prize_id: prizeId,
      p_quantity: 5,
    });
    expect(denied.error?.code).toBe('23514');
    expect(denied.error?.message).toContain('3');
  });

  it('refuses a non-positive quantity', async () => {
    const label = `link-zero-${Date.now()}`;
    const customer = await provisionCustomer(label);
    const prizeId = await createPrizeAs(customer, `Mug ${label}`);
    await stockAsOwner(customer, prizeId, 3);
    const promotionId = await promotionAsOwner(customer);

    const delegate = await grantRoleWith(customer, label, ['promotions.view', 'promotions.prizes']);
    const client = await clientFor(delegate);

    const denied = await client.rpc('link_prize_to_promotion', {
      p_promotion_id: promotionId,
      p_prize_id: prizeId,
      p_quantity: 0,
    });
    expect(denied.error?.code).toBe('22023');
  });

  it('refuses a prize from another Station', async () => {
    const label = `link-cross-${Date.now()}`;
    const customer = await provisionCustomer(label);
    const otherCompanyId = await addCompany(customer, `Second ${label}`);
    const foreignPrizeId = await createPrizeAs(customer, `Foreign ${label}`, otherCompanyId);
    const promotionId = await promotionAsOwner(customer);

    const delegate = await grantRoleWith(customer, label, ['promotions.view', 'promotions.prizes']);
    const client = await clientFor(delegate);

    const denied = await client.rpc('link_prize_to_promotion', {
      p_promotion_id: promotionId,
      p_prize_id: foreignPrizeId,
      p_quantity: 1,
    });
    expect(denied.error?.code).toBe('P0002');
  });

  it('refuses a delegate who holds promotions.edit but not promotions.prizes', async () => {
    const label = `link-perm-${Date.now()}`;
    const customer = await provisionCustomer(label);
    const prizeId = await createPrizeAs(customer, `Guarded ${label}`);
    await stockAsOwner(customer, prizeId, 5);
    const promotionId = await promotionAsOwner(customer);

    // The whole reason promotions.prizes is its own code: rewording a
    // promotion is not committing inventory to it.
    const delegate = await grantRoleWith(customer, label, ['promotions.view', 'promotions.edit']);
    const client = await clientFor(delegate);

    const denied = await client.rpc('link_prize_to_promotion', {
      p_promotion_id: promotionId,
      p_prize_id: prizeId,
      p_quantity: 1,
    });
    expect(denied.error?.code).toBe('42501');
  });
});

describe('unlinking', () => {
  it('returns the units and leaves no row behind once the link reaches zero', async () => {
    const label = `unlink-all-${Date.now()}`;
    const customer = await provisionCustomer(label);
    const prizeId = await createPrizeAs(customer, `Radio ${label}`);
    await stockAsOwner(customer, prizeId, 8);
    const promotionId = await promotionAsOwner(customer);

    const delegate = await grantRoleWith(customer, label, [
      'promotions.view',
      'promotions.prizes',
      'inventory.view',
    ]);
    const client = await clientFor(delegate);

    await client.rpc('link_prize_to_promotion', {
      p_promotion_id: promotionId,
      p_prize_id: prizeId,
      p_quantity: 3,
    });
    const undo = await client.rpc('unlink_prize_from_promotion', {
      p_promotion_id: promotionId,
      p_prize_id: prizeId,
      p_quantity: 3,
    });
    expect(undo.error).toBeNull();

    const station = await client
      .from('inventory_balances')
      .select('available, linked')
      .eq('prize_id', prizeId)
      .single();
    expect(station.data).toEqual({ available: 8, linked: 0 });

    // Soft-deleted, so the tab shows nothing rather than a row of zeros. The
    // policy in 0046 filters deleted_at, which is why this read comes back
    // empty rather than with a zeroed row.
    const links = await client
      .from('promotion_prizes')
      .select('id')
      .eq('promotion_id', promotionId);
    expect(links.data).toHaveLength(0);

    // And the same pair can be linked again afterwards — the partial unique
    // index is what makes that possible.
    const relink = await client.rpc('link_prize_to_promotion', {
      p_promotion_id: promotionId,
      p_prize_id: prizeId,
      p_quantity: 1,
    });
    expect(relink.error).toBeNull();
  });

  it('refuses to go below what has been drawn, naming both figures', async () => {
    const label = `unlink-floor-${Date.now()}`;
    const customer = await provisionCustomer(label);
    const prizeId = await createPrizeAs(customer, `Console ${label}`);
    await stockAsOwner(customer, prizeId, 10);
    const promotionId = await promotionAsOwner(customer);

    const delegate = await grantRoleWith(customer, label, ['promotions.view', 'promotions.prizes']);
    const client = await clientFor(delegate);

    const linked = await client.rpc('link_prize_to_promotion', {
      p_promotion_id: promotionId,
      p_prize_id: prizeId,
      p_quantity: 5,
    });
    const linkId = linked.data as string;

    // Nothing writes `drawn` until Block 6; see the helper's own comment for
    // why this is the only fixture available and why this test must not go on
    // to assert that reconciliation is clean.
    setPromotionPrizeDrawnDirectly(linkId, 2);

    // Three of the five may come back.
    const allowed = await client.rpc('unlink_prize_from_promotion', {
      p_promotion_id: promotionId,
      p_prize_id: prizeId,
      p_quantity: 3,
    });
    expect(allowed.error).toBeNull();

    // The fourth may not, and the refusal names the two that are spoken for.
    const denied = await client.rpc('unlink_prize_from_promotion', {
      p_promotion_id: promotionId,
      p_prize_id: prizeId,
      p_quantity: 1,
    });
    expect(denied.error?.code).toBe('23514');
    expect(denied.error?.message).toContain('2');
  });

  it('refuses a prize that is not linked to this promotion', async () => {
    const label = `unlink-none-${Date.now()}`;
    const customer = await provisionCustomer(label);
    const prizeId = await createPrizeAs(customer, `Unlinked ${label}`);
    const promotionId = await promotionAsOwner(customer);

    const delegate = await grantRoleWith(customer, label, ['promotions.view', 'promotions.prizes']);
    const client = await clientFor(delegate);

    const denied = await client.rpc('unlink_prize_from_promotion', {
      p_promotion_id: promotionId,
      p_prize_id: prizeId,
      p_quantity: 1,
    });
    expect(denied.error?.code).toBe('P0002');
  });

  it('reports no divergence after a link and unlink round trip', async () => {
    const label = `unlink-recon-${Date.now()}`;
    const customer = await provisionCustomer(label);
    const prizeId = await createPrizeAs(customer, `Audited ${label}`);
    await stockAsOwner(customer, prizeId, 12);
    const promotionId = await promotionAsOwner(customer);

    const delegate = await grantRoleWith(customer, label, [
      'promotions.view',
      'promotions.prizes',
      'inventory.view',
    ]);
    const client = await clientFor(delegate);

    await client.rpc('link_prize_to_promotion', {
      p_promotion_id: promotionId,
      p_prize_id: prizeId,
      p_quantity: 7,
    });
    await client.rpc('unlink_prize_from_promotion', {
      p_promotion_id: promotionId,
      p_prize_id: prizeId,
      p_quantity: 2,
    });

    // The second projection recomputed from the ledger must equal what the RPCs
    // wrote. This is the assertion that goes red if the per-promotion write is
    // dropped from apply_inventory_movement — see the mutation log in Task 9.
    const check = await client.rpc('reconcile_inventory', { p_company_id: customer.companyId });
    expect(check.error).toBeNull();
    expect(check.data).toEqual([]);
  });
});
```

- [ ] **Step 3: Run it and confirm it fails for the right reason**

Run: `npm run test:isolation -- tests/isolation/promotion-prizes.test.ts`

Expected: every case fails with `Could not find the function public.link_prize_to_promotion` (PostgREST `PGRST202`). Nothing fails on a fixture.

- [ ] **Step 4: Write the migration**

Create `supabase/migrations/0049_promotion_prize_rpcs.sql`:

```sql
-- supabase/migrations/0049_promotion_prize_rpcs.sql
--
-- The writes a promotion's prizes take. Each checks its own permission beside
-- the operation rather than inside a shared helper, for the reason 0027's own
-- comment gives: a reader looking for "who may do this" finds it next to the
-- thing being done. Each resolves the Organization and the Station from the
-- promotion row, never from a parameter — a caller must not be able to redirect
-- the permission check at a Station where they happen to hold the code.
--
-- Neither takes a note as a requirement, unlike record_stock_exit and
-- reserve_stock. The link itself names the promotion, which is the explanation
-- an exit or a reservation lacks.

create or replace function public.link_prize_to_promotion(
  p_promotion_id uuid,
  p_prize_id     uuid,
  p_quantity     integer,
  p_note         text default null
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor     uuid := auth.uid();
  v_org       uuid;
  v_company   uuid;
  v_cancelled timestamptz;
  v_deleted   timestamptz;
  v_note      text := nullif(btrim(coalesce(p_note, '')), '');
  v_link      uuid;
begin
  -- FOR UPDATE before anything is read or decided. Two links racing would
  -- otherwise both read the same `available` and each pass a check the other
  -- has already spent — and both would find no live link row and both insert
  -- one, which the partial unique index would then refuse with a constraint
  -- name instead of a sentence. This lock serialises every link and unlink
  -- against one promotion, which is what makes both of those impossible rather
  -- than merely unlikely. Same shape archive_prize uses, for the reason its own
  -- comment gives.
  select organization_id, company_id, cancelled_at, deleted_at
    into v_org, v_company, v_cancelled, v_deleted
  from public.promotions
  where id = p_promotion_id
    for update;

  if not found or v_deleted is not null then
    raise exception 'promotion not found: %', p_promotion_id using errcode = 'P0002';
  end if;

  if not public.has_permission('promotions.prizes', v_company) then
    raise log 'link_prize_to_promotion denied: actor=% promotion=%', v_actor, p_promotion_id;
    raise exception 'permission denied: promotions.prizes required' using errcode = '42501';
  end if;

  if p_quantity is null or p_quantity <= 0 then
    raise exception 'the number of units must be a positive whole number' using errcode = '22023';
  end if;

  if v_cancelled is not null then
    raise exception 'this promotion is cancelled and its prizes have already gone back to stock'
      using errcode = '22023';
  end if;

  -- A promotion whose window has CLOSED still accepts links, and that is not an
  -- oversight: the draw happens after entries close (Block 6), so an ended
  -- promotion is exactly when its prizes are most likely to be adjusted. Only
  -- cancellation, above, and archiving, through deleted_at, close the door.

  -- The composite foreign key on promotion_prizes would refuse a prize from
  -- another Station too, but with a constraint name rather than the message a
  -- caller can act on — the same reasoning apply_inventory_movement gives for
  -- its own sufficiency check.
  if not exists (
    select 1 from public.prizes
    where id = p_prize_id and company_id = v_company and deleted_at is null
  ) then
    raise exception 'prize not found in this station: %', p_prize_id using errcode = 'P0002';
  end if;

  select id into v_link
  from public.promotion_prizes
  where promotion_id = p_promotion_id and prize_id = p_prize_id and deleted_at is null;

  if not found then
    insert into public.promotion_prizes
      (promotion_id, prize_id, organization_id, company_id, created_by)
    values (p_promotion_id, p_prize_id, v_org, v_company, v_actor)
    returning id into v_link;
  end if;

  -- apply_inventory_movement is what refuses an over-link: it reads `available`
  -- under the balance row's own lock and names the figure ("only 3 unit(s) are
  -- in available, and 5 were requested"), which is exactly what the screen
  -- needs to say. Checking it here as well would be a second, weaker copy
  -- racing the first.
  perform public.apply_inventory_movement(
    v_company, p_prize_id, 'PROMOTION_LINK', p_quantity,
    'available', 'linked', v_note, null, v_link);

  insert into public.audit_logs
    (actor_id, action, target_table, target_id, organization_id, company_id, detail)
  values
    (v_actor, 'link_prize_to_promotion', 'promotion_prizes', v_link, v_org, v_company,
     jsonb_build_object('promotion_id', p_promotion_id, 'prize_id', p_prize_id,
                        'quantity', p_quantity));

  return v_link;
end;
$$;

comment on function public.link_prize_to_promotion(uuid, uuid, integer, text) is
  'Commits N units of a prize to a promotion: creates the link row if there is not a live one, then appends PROMOTION_LINK and moves available -> linked through the ledger''s single writer. Returns the promotion_prizes id, the same one on every call for a pair already linked. Gated on promotions.prizes — its own code, because somebody who may reword a promotion is not thereby somebody who may commit inventory to it. Takes FOR UPDATE on the promotion row first, which serialises every link and unlink against that promotion. Refuses a cancelled or archived promotion, a prize from another Station, a non-positive quantity, and — through apply_inventory_movement, which names the figure — more units than are available. A promotion whose window has closed is deliberately still accepted.';

create or replace function public.unlink_prize_from_promotion(
  p_promotion_id uuid,
  p_prize_id     uuid,
  p_quantity     integer,
  p_note         text default null
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor   uuid := auth.uid();
  v_org     uuid;
  v_company uuid;
  v_deleted timestamptz;
  v_note    text := nullif(btrim(coalesce(p_note, '')), '');
  v_link    uuid;
  v_linked  integer;
  v_drawn   integer;
  v_free    integer;
begin
  -- Same lock, same reason as link_prize_to_promotion: the figure this function
  -- decides on must not move between being read and being spent.
  select organization_id, company_id, deleted_at
    into v_org, v_company, v_deleted
  from public.promotions
  where id = p_promotion_id
    for update;

  if not found or v_deleted is not null then
    raise exception 'promotion not found: %', p_promotion_id using errcode = 'P0002';
  end if;

  if not public.has_permission('promotions.prizes', v_company) then
    raise log 'unlink_prize_from_promotion denied: actor=% promotion=%', v_actor, p_promotion_id;
    raise exception 'permission denied: promotions.prizes required' using errcode = '42501';
  end if;

  if p_quantity is null or p_quantity <= 0 then
    raise exception 'the number of units must be a positive whole number' using errcode = '22023';
  end if;

  select l.id, coalesce(b.linked, 0), coalesce(b.drawn, 0)
    into v_link, v_linked, v_drawn
  from public.promotion_prizes l
  left join public.promotion_prize_balances b on b.promotion_prize_id = l.id
  where l.promotion_id = p_promotion_id and l.prize_id = p_prize_id and l.deleted_at is null;

  if not found then
    raise exception 'this prize is not linked to this promotion' using errcode = 'P0002';
  end if;

  v_free := v_linked - v_drawn;

  -- D4's floor. The table check (0045) refuses this too, and would refuse it
  -- with a constraint name; the operator deserves both figures — "only 3 of the
  -- 5 unit(s) linked can be returned; 2 have already been drawn" is a sentence
  -- somebody can act on.
  if p_quantity > v_free then
    raise exception
      'only % of the % unit(s) linked can be returned; % have already been drawn',
      v_free, v_linked, v_drawn
      using errcode = '23514';
  end if;

  perform public.apply_inventory_movement(
    v_company, p_prize_id, 'PROMOTION_UNLINK', p_quantity,
    'linked', 'available', v_note, null, v_link);

  -- A link unwound to nothing leaves the Prizes tab rather than sitting there
  -- as a row of zeros; its history is in the ledger, which is where history
  -- belongs. Reachable only when nothing has been drawn — the refusal above
  -- makes linked - p_quantity = 0 impossible while drawn > 0 — so this never
  -- hides a unit that belongs to a winner. The partial unique index (0045) is
  -- what lets the same pair be linked again afterwards.
  if v_linked - p_quantity = 0 then
    update public.promotion_prizes
       set deleted_at = now(), updated_at = now()
     where id = v_link;
  end if;

  insert into public.audit_logs
    (actor_id, action, target_table, target_id, organization_id, company_id, detail)
  values
    (v_actor, 'unlink_prize_from_promotion', 'promotion_prizes', v_link, v_org, v_company,
     jsonb_build_object('promotion_id', p_promotion_id, 'prize_id', p_prize_id,
                        'quantity', p_quantity, 'closed', v_linked - p_quantity = 0));
end;
$$;

comment on function public.unlink_prize_from_promotion(uuid, uuid, integer, text) is
  'Returns N committed units to available: appends PROMOTION_UNLINK and moves linked -> available through the ledger''s single writer. Gated on promotions.prizes. Refused below what has been drawn (D4), naming both the free figure and the drawn one — the table check on promotion_prize_balances refuses the same thing structurally, so the floor holds whether or not this check runs first. A link unwound to zero is soft-deleted, which is reachable only when nothing has been drawn; the pair can then be linked again through the partial unique index. Takes FOR UPDATE on the promotion row, so the free figure cannot move between being read and being spent.';

revoke execute on function public.link_prize_to_promotion(uuid, uuid, integer, text)     from public;
revoke execute on function public.unlink_prize_from_promotion(uuid, uuid, integer, text) from public;

grant execute on function public.link_prize_to_promotion(uuid, uuid, integer, text)      to authenticated;
grant execute on function public.unlink_prize_from_promotion(uuid, uuid, integer, text)  to authenticated;
```

- [ ] **Step 5: Run the suite green**

Run: `npm run db:reset && npm run test:isolation -- tests/isolation/promotion-prizes.test.ts`

Expected: every case passes. If `refuses more units than are available` fails with `P0002` rather than `23514`, the prize existence check is running against the wrong Station; if `reports no divergence` fails with a `linked` row, Task 3's projection write is not landing.

- [ ] **Step 6: Run every gate**

Run: `npm run lint && npm run typecheck && npm run db:test && npm run test:isolation`

- [ ] **Step 7: Commit**

```bash
git add supabase/migrations/0049_promotion_prize_rpcs.sql tests/isolation/promotion-prizes.test.ts tests/isolation/harness.ts
git commit -m "$(cat <<'EOF'
feat(promotions): linking and unlinking, and the floor that holds twice

Both take FOR UPDATE on the promotion row before reading anything. That one lock
does two jobs: two links racing cannot both spend the same available units, and
two cannot both find no live link row and both insert one — which the partial
unique index would refuse with a constraint name instead of a sentence.

D4's floor is refused in two places on purpose. The RPC names both figures,
because "only 3 of the 5 unit(s) linked can be returned; 2 have already been
drawn" is something an operator can act on; the table check refuses the same
write whether or not that check ran. Removing either leaves the other standing,
which is the point.

drawn has no writer until Block 6, so the floor has no reachable fixture through
any API. setPromotionPrizeDrawnDirectly is the same escape hatch
corruptBalanceDirectly opened, with its own warning: a row set that way is a real
divergence, and a test that uses it must not also assert reconciliation is clean.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Cancelling and archiving hand the undrawn units back

**Files:**
- Create: `supabase/migrations/0050_promotion_lifecycle_returns_prizes.sql`
- Modify: `tests/isolation/promotion-prizes.test.ts` (a third `describe`)

**Interfaces:**
- Produces: `public.return_promotion_prizes(p_promotion_id uuid, p_company_id uuid, p_note text) returns integer` — the number of units returned; SECURITY INVOKER, EXECUTE granted to nobody. `public.cancel_promotion(uuid, text)` and `public.archive_promotion(uuid)` recreated, signatures unchanged.
- Consumes: `public.apply_inventory_movement(..., uuid)` (0047), `public.promotion_prize_balances` (0045).

**This is where the spec's §2 premise gets corrected.** D1 said archiving could only follow a cancellation, so cancelling alone was enough to stop prizes being stranded. It is not: `archive_promotion` refuses only *inside* the window, and `cancel_promotion` refuses a promotion that has already *ended*, so an ended-but-never-cancelled promotion could be archived with prizes still linked. **The owner's decision: archiving returns the units itself**, exactly as cancelling does. One helper, two callers, one rule.

- [ ] **Step 1: Write the failing isolation cases**

Append to `tests/isolation/promotion-prizes.test.ts`:

```ts
describe('a promotion that ends its life hands its prizes back', () => {
  it('cancelling returns every undrawn unit and leaves the drawn ones alone', async () => {
    const label = `cancel-d1-${Date.now()}`;
    const customer = await provisionCustomer(label);
    const prizeId = await createPrizeAs(customer, `Watch ${label}`);
    await stockAsOwner(customer, prizeId, 10);
    const promotionId = await promotionAsOwner(customer);

    const delegate = await grantRoleWith(customer, label, [
      'promotions.view',
      'promotions.prizes',
      'promotions.cancel',
      'inventory.view',
    ]);
    const client = await clientFor(delegate);

    const linked = await client.rpc('link_prize_to_promotion', {
      p_promotion_id: promotionId,
      p_prize_id: prizeId,
      p_quantity: 6,
    });
    const linkId = linked.data as string;
    setPromotionPrizeDrawnDirectly(linkId, 2);

    const cancelled = await client.rpc('cancel_promotion', {
      p_promotion_id: promotionId,
      p_reason: 'sponsor pulled out',
    });
    expect(cancelled.error).toBeNull();

    // Four of the six come back. The two that are drawn are in awaiting_pickup
    // and belong to a winner; nothing here may take them.
    const station = await client
      .from('inventory_balances')
      .select('available, linked')
      .eq('prize_id', prizeId)
      .single();
    expect(station.data).toEqual({ available: 8, linked: 2 });

    // The link row survives, because it still has to show Sorteados 2.
    const balance = await client
      .from('promotion_prize_balances')
      .select('linked, drawn')
      .eq('promotion_prize_id', linkId)
      .single();
    expect(balance.data).toEqual({ linked: 2, drawn: 2 });

    // The movement carries the cancellation, so the ledger explains itself
    // without anybody having to cross-reference the promotion.
    const movements = await client
      .from('inventory_movements')
      .select('movement_type, quantity, note')
      .eq('promotion_prize_id', linkId)
      .eq('movement_type', 'PROMOTION_UNLINK');
    expect(movements.data).toHaveLength(1);
    expect(movements.data![0].quantity).toBe(4);
    expect(movements.data![0].note).toContain('sponsor pulled out');
  });

  it('cancelling closes a link that had nothing drawn', async () => {
    const label = `cancel-close-${Date.now()}`;
    const customer = await provisionCustomer(label);
    const prizeId = await createPrizeAs(customer, `Camera ${label}`);
    await stockAsOwner(customer, prizeId, 4);
    const promotionId = await promotionAsOwner(customer);

    const delegate = await grantRoleWith(customer, label, [
      'promotions.view',
      'promotions.prizes',
      'promotions.cancel',
    ]);
    const client = await clientFor(delegate);

    await client.rpc('link_prize_to_promotion', {
      p_promotion_id: promotionId,
      p_prize_id: prizeId,
      p_quantity: 4,
    });
    await client.rpc('cancel_promotion', {
      p_promotion_id: promotionId,
      p_reason: 'no longer running',
    });

    const links = await client
      .from('promotion_prizes')
      .select('id')
      .eq('promotion_id', promotionId);
    expect(links.data).toHaveLength(0);
  });

  it('archiving an ended promotion returns its prizes rather than stranding them', async () => {
    const label = `archive-strand-${Date.now()}`;
    const customer = await provisionCustomer(label);
    const prizeId = await createPrizeAs(customer, `Tablet ${label}`);
    await stockAsOwner(customer, prizeId, 9);
    // Ended, never cancelled. cancel_promotion refuses this one outright, so
    // before this task its prizes had no way back at all.
    const promotionId = await promotionAsOwner(customer, {
      startsAt: new Date(Date.now() - 2 * DAY).toISOString(),
      endsAt: new Date(Date.now() - HOUR).toISOString(),
    });

    const delegate = await grantRoleWith(customer, label, [
      'promotions.view',
      'promotions.prizes',
      'promotions.archive',
      'inventory.view',
    ]);
    const client = await clientFor(delegate);

    await client.rpc('link_prize_to_promotion', {
      p_promotion_id: promotionId,
      p_prize_id: prizeId,
      p_quantity: 5,
    });

    const archived = await client.rpc('archive_promotion', { p_promotion_id: promotionId });
    expect(archived.error).toBeNull();

    const station = await client
      .from('inventory_balances')
      .select('available, linked')
      .eq('prize_id', prizeId)
      .single();
    expect(station.data).toEqual({ available: 9, linked: 0 });
  });

  it('archiving after a cancellation finds nothing left to return', async () => {
    const label = `archive-after-${Date.now()}`;
    const customer = await provisionCustomer(label);
    const prizeId = await createPrizeAs(customer, `Voucher ${label}`);
    await stockAsOwner(customer, prizeId, 3);
    const promotionId = await promotionAsOwner(customer);

    const delegate = await grantRoleWith(customer, label, [
      'promotions.view',
      'promotions.prizes',
      'promotions.cancel',
      'promotions.archive',
      'inventory.view',
    ]);
    const client = await clientFor(delegate);

    await client.rpc('link_prize_to_promotion', {
      p_promotion_id: promotionId,
      p_prize_id: prizeId,
      p_quantity: 3,
    });
    await client.rpc('cancel_promotion', {
      p_promotion_id: promotionId,
      p_reason: 'called off',
    });
    const archived = await client.rpc('archive_promotion', { p_promotion_id: promotionId });
    expect(archived.error).toBeNull();

    // Three back, and exactly one PROMOTION_UNLINK — not two. A second one
    // would mean the cancellation's own return had been repeated, which the
    // linked bucket floor would have refused anyway; asserting the count is
    // what proves the helper found the link already closed rather than
    // silently failing to.
    const station = await client
      .from('inventory_balances')
      .select('available, linked')
      .eq('prize_id', prizeId)
      .single();
    expect(station.data).toEqual({ available: 3, linked: 0 });

    const movements = await client
      .from('inventory_movements')
      .select('id')
      .eq('prize_id', prizeId)
      .eq('movement_type', 'PROMOTION_UNLINK');
    expect(movements.data).toHaveLength(1);
  });

  it('reports no divergence after a cancellation returned the units', async () => {
    const label = `cancel-recon-${Date.now()}`;
    const customer = await provisionCustomer(label);
    const prizeId = await createPrizeAs(customer, `Checked ${label}`);
    await stockAsOwner(customer, prizeId, 6);
    const promotionId = await promotionAsOwner(customer);

    const delegate = await grantRoleWith(customer, label, [
      'promotions.view',
      'promotions.prizes',
      'promotions.cancel',
      'inventory.view',
    ]);
    const client = await clientFor(delegate);

    await client.rpc('link_prize_to_promotion', {
      p_promotion_id: promotionId,
      p_prize_id: prizeId,
      p_quantity: 6,
    });
    await client.rpc('cancel_promotion', {
      p_promotion_id: promotionId,
      p_reason: 'weather',
    });

    const check = await client.rpc('reconcile_inventory', { p_company_id: customer.companyId });
    expect(check.error).toBeNull();
    expect(check.data).toEqual([]);
  });
});
```

- [ ] **Step 2: Run and confirm they fail for the right reason**

Run: `npm run test:isolation -- tests/isolation/promotion-prizes.test.ts`

Expected: the five new cases fail on the balance assertions — `{ available: 4, linked: 6 }` where 8/2 was expected, and so on. Cancelling and archiving succeed; they simply do not move anything. The Task 5 cases stay green.

- [ ] **Step 3: Write the migration**

Create `supabase/migrations/0050_promotion_lifecycle_returns_prizes.sql`:

```sql
-- supabase/migrations/0050_promotion_lifecycle_returns_prizes.sql
--
-- D1: a promotion that ends its life hands its undrawn prizes back, in the same
-- transaction. Without it a cancelled promotion strands them — out of
-- available, counted in the balance, inside a record nobody will open again.
--
-- The spec's §2 said this only needed to happen on cancellation, reasoning that
-- archiving already refuses while a promotion is accepting entries, so anything
-- archivable had been cancelled first. That is not what 0042 shipped:
-- archive_promotion refuses only INSIDE the window, and cancel_promotion
-- refuses a promotion that has already ENDED. An ended, never-cancelled
-- promotion was therefore archivable with prizes still linked — the exact
-- stranding D1 exists to prevent. The owner's decision was that archiving
-- should return the units itself rather than grow a new refusal, so archiving
-- stops being a pure record operation and becomes one that moves stock. That is
-- the trade, and it is stated in archive_promotion's own comment.

-- Shared by both, so the rule has one implementation and one set of tests.
-- SECURITY INVOKER with EXECUTE granted to nobody: only ever called from inside
-- a SECURITY DEFINER body, where it runs with that body's privileges — the
-- shape ensure_inventory_balance_row and promotion_write_error already use.
create or replace function public.return_promotion_prizes(
  p_promotion_id uuid,
  p_company_id   uuid,
  p_note         text
)
returns integer
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  v_link  record;
  v_units integer := 0;
begin
  -- No row lock is taken here. Both callers already hold FOR UPDATE on the
  -- promotion row, and every link and unlink against that promotion is
  -- serialised behind that same lock (0049), so these rows cannot move under
  -- this loop. Ordered by id only so the ledger reads the same way twice for
  -- the same input, which makes a diff of two runs meaningful.
  for v_link in
    select l.id,
           l.prize_id,
           coalesce(b.linked, 0) as linked,
           coalesce(b.drawn, 0)  as drawn
    from public.promotion_prizes l
    left join public.promotion_prize_balances b on b.promotion_prize_id = l.id
    where l.promotion_id = p_promotion_id and l.deleted_at is null
    order by l.id
  loop
    -- What has been drawn does not come back: those units are in
    -- awaiting_pickup and belong to a winner.
    if v_link.linked - v_link.drawn > 0 then
      perform public.apply_inventory_movement(
        p_company_id, v_link.prize_id, 'PROMOTION_UNLINK', v_link.linked - v_link.drawn,
        'linked', 'available', p_note, null, v_link.id);
      v_units := v_units + (v_link.linked - v_link.drawn);
    end if;

    -- Nothing drawn means nothing is left holding this link open, so it leaves
    -- the Prizes tab the same way an unlink to zero does. A link with drawn > 0
    -- stays: it still has to show Vinculados and Sorteados against each other.
    if v_link.drawn = 0 then
      update public.promotion_prizes
         set deleted_at = now(), updated_at = now()
       where id = v_link.id;
    end if;
  end loop;

  return v_units;
end;
$$;

revoke execute on function public.return_promotion_prizes(uuid, uuid, text) from public;

comment on function public.return_promotion_prizes(uuid, uuid, text) is
  'D1, shared by cancel_promotion and archive_promotion: appends one PROMOTION_UNLINK per live link for everything committed and not drawn, moving linked -> available, and closes each link that had nothing drawn. Returns the number of units handed back, which both callers record in their audit row. Takes no lock of its own — both callers hold FOR UPDATE on the promotion, and 0049 serialises every link and unlink behind that same lock. SECURITY INVOKER, EXECUTE granted to nobody.';

-- ---------------------------------------------------------------------------
-- cancel_promotion, recreated. Everything 0042 wrote is unchanged — the
-- FOR UPDATE, the reason, the already-cancelled refusal, the already-ended
-- refusal — and the return happens after the row is marked, so a failure
-- anywhere in it takes the cancellation with it.
-- ---------------------------------------------------------------------------
create or replace function public.cancel_promotion(
  p_promotion_id uuid,
  p_reason       text
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor     uuid := auth.uid();
  v_org       uuid;
  v_company   uuid;
  v_cancelled timestamptz;
  v_ends      timestamptz;
  v_reason    text := nullif(btrim(coalesce(p_reason, '')), '');
  v_returned  integer;
begin
  -- [ 0042:250-289 verbatim: the FOR UPDATE select, the not-found raise, the
  --   promotions.cancel check, the missing-reason raise, the already-cancelled
  --   raise, the already-ended raise, and the UPDATE that marks the row. ]

  -- D1. The cancellation is the note, so the ledger explains itself without
  -- anybody having to cross-reference the promotion to find out why six units
  -- came back on a Tuesday.
  v_returned := public.return_promotion_prizes(
    p_promotion_id, v_company, 'promotion cancelled: ' || v_reason);

  insert into public.audit_logs
    (actor_id, action, target_table, target_id, organization_id, company_id, detail)
  values
    (v_actor, 'cancel_promotion', 'promotions', p_promotion_id, v_org, v_company,
     jsonb_build_object('reason', v_reason, 'units_returned', v_returned));
end;
$$;

comment on function public.cancel_promotion(uuid, text) is
  'Stops a promotion accepting entries before its end, and hands its prizes back (D1). Gated on promotions.cancel. Requires a reason, refuses a promotion already cancelled, and refuses one whose window has already closed — cancelling something already over would only mislabel it, and archiving is what returns that one''s prizes. Every unit still linked and not drawn goes back to available as its own PROMOTION_UNLINK carrying the cancellation as its note, in this transaction; what has been drawn stays where it is, because it belongs to a winner. The number returned is recorded on the audit row.';

-- ---------------------------------------------------------------------------
-- archive_promotion, recreated. Its refusal is unchanged; what is new is that
-- it returns the prizes before it files the record away.
-- ---------------------------------------------------------------------------
create or replace function public.archive_promotion(p_promotion_id uuid)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor     uuid := auth.uid();
  v_org       uuid;
  v_company   uuid;
  v_starts    timestamptz;
  v_ends      timestamptz;
  v_cancelled timestamptz;
  v_returned  integer;
begin
  -- [ 0042:316-338 verbatim: the FOR UPDATE select, the not-found raise, the
  --   promotions.archive check, and the "still accepting entries" refusal with
  --   its whole comment. ]

  -- Before the row is filed away, not after: an archived promotion is one
  -- nobody will open again, and units still counted in its balance would be out
  -- of available with nothing on any screen pointing at them. A cancelled
  -- promotion has already been through this and its links are closed, so the
  -- helper finds nothing and returns 0 — which is why this is safe to run on
  -- every archival rather than only on the ones that skipped cancellation.
  v_returned := public.return_promotion_prizes(p_promotion_id, v_company, 'promotion archived');

  update public.promotions set
    deleted_at = now(),
    deleted_by = v_actor,
    updated_at = now()
  where id = p_promotion_id;

  insert into public.audit_logs
    (actor_id, action, target_table, target_id, organization_id, company_id, detail)
  values
    (v_actor, 'archive_promotion', 'promotions', p_promotion_id, v_org, v_company,
     jsonb_build_object('units_returned', v_returned));
end;
$$;

comment on function public.archive_promotion(uuid) is
  'Soft-deletes a promotion, recording who did it, and hands its undrawn prizes back first. Gated on promotions.archive. Refused while the promotion is inside its window and not cancelled: archiving frees the hashtag for another promotion, and doing that while listeners are still texting it would hand their entries to the wrong promotion. Archiving MOVES STOCK, which it did not before Block 4b — an ended, never-cancelled promotion cannot be cancelled (cancel_promotion refuses one whose window has closed) and so had no other way to give its prizes back; the alternative was a new refusal that would have left the operator unlinking by hand first. A promotion already cancelled has nothing left to return.';
```

- [ ] **Step 4: Run the suite green**

Run: `npm run db:reset && npm run test:isolation -- tests/isolation/promotion-prizes.test.ts`

Expected: every case passes, Task 5's included. If `archiving after a cancellation` reports two `PROMOTION_UNLINK` rows, the cancellation is not closing its links.

- [ ] **Step 5: Confirm 4a's own suite still holds**

Run: `npm run test:isolation -- tests/isolation/promotions.test.ts && npm run db:test`

Expected: green. Both recreated functions keep their signatures and every refusal 4a shipped, so nothing in that file should move.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/0050_promotion_lifecycle_returns_prizes.sql tests/isolation/promotion-prizes.test.ts
git commit -m "$(cat <<'EOF'
feat(promotions): cancelling and archiving hand the undrawn prizes back

D1, and a correction to the premise it rested on. The spec reasoned that only
cancellation needed to return prizes, because archiving already refuses while a
promotion is accepting entries — so anything archivable had been cancelled
first. That is not what 0042 shipped: archive_promotion refuses only INSIDE the
window and cancel_promotion refuses a promotion that has already ENDED, so an
ended, never-cancelled promotion was archivable with its prizes still linked.
The exact stranding D1 exists to prevent, reachable by doing nothing at all.

The owner chose to have archiving return the units rather than grow a new
refusal. Archiving therefore moves stock now, which it did not before; that is
written into its own comment rather than left to be discovered.

One helper, two callers. What has been drawn never comes back — those units are
in awaiting_pickup and belong to a winner — and a link that still has drawn units
stays open so the tab can go on showing them.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: The two reads the tab needs

**Files:**
- Create: `supabase/migrations/0051_promotion_prize_reads.sql`
- Modify: `tests/isolation/promotion-prizes.test.ts` (a fourth `describe`)

**Interfaces:**
- Produces:
  - `public.list_promotion_prizes(p_promotion_id uuid)` → `(promotion_prize_id uuid, prize_id uuid, prize_name text, linked integer, drawn integer)`, gated on `promotions.view`.
  - `public.list_linkable_prizes(p_company_id uuid, p_search text default null)` → `(prize_id uuid, name text, available integer)`, gated on `promotions.prizes`, capped at 50 rows.
- Consumes: `public.has_permission` (0024), `public.is_owner_of_company` (0044:11).

**Why these are SECURITY DEFINER reads rather than ordinary policy-gated selects:** a prize's *name* lives in `public.prizes`, whose policy (0029) gates every read on `inventory.view`. An operator holding `promotions.view` and `promotions.prizes` and nothing from the inventory module would get a Prizes tab of blank names — a screen that half-works for its own permission. Each function therefore restates, in its own body, the archived-promotion rule that 0044's policy enforces for the record itself: a DEFINER body runs as the table owner and never consults that policy, which is the same trap 0024's comment documents.

- [ ] **Step 1: Write the failing isolation cases**

Append to `tests/isolation/promotion-prizes.test.ts`:

```ts
describe('reading the Prizes tab', () => {
  it('names the prize for a delegate who holds no inventory permission at all', async () => {
    const label = `read-names-${Date.now()}`;
    const customer = await provisionCustomer(label);
    const prizeId = await createPrizeAs(customer, `Turntable ${label}`);
    await stockAsOwner(customer, prizeId, 5);
    const promotionId = await promotionAsOwner(customer);

    const linker = await grantRoleWith(customer, `${label}-w`, [
      'promotions.view',
      'promotions.prizes',
    ]);
    const linkerClient = await clientFor(linker);
    await linkerClient.rpc('link_prize_to_promotion', {
      p_promotion_id: promotionId,
      p_prize_id: prizeId,
      p_quantity: 3,
    });

    // promotions.view alone. This delegate cannot read public.prizes at all —
    // which is exactly why the tab goes through a SECURITY DEFINER read.
    const reader = await grantRoleWith(customer, `${label}-r`, ['promotions.view']);
    const client = await clientFor(reader);

    const direct = await client.from('prizes').select('name').eq('id', prizeId);
    expect(direct.data).toEqual([]);

    const tab = await client.rpc('list_promotion_prizes', { p_promotion_id: promotionId });
    expect(tab.error).toBeNull();
    expect(tab.data).toEqual([
      {
        promotion_prize_id: expect.any(String),
        prize_id: prizeId,
        prize_name: `Turntable ${label}`,
        linked: 3,
        drawn: 0,
      },
    ]);
  });

  it('refuses a delegate holding nothing in this Station', async () => {
    const label = `read-denied-${Date.now()}`;
    const customer = await provisionCustomer(label);
    const promotionId = await promotionAsOwner(customer);

    const stranger = await grantRoleWith(customer, label, ['members.view']);
    const client = await clientFor(stranger);

    const denied = await client.rpc('list_promotion_prizes', { p_promotion_id: promotionId });
    expect(denied.error?.code).toBe('42501');
  });

  it('returns nothing for a promotion this caller cannot see, rather than saying it exists', async () => {
    const label = `read-oracle-${Date.now()}`;
    const customer = await provisionCustomer(label);
    const client = await clientFor(await grantRoleWith(customer, label, ['promotions.view']));

    // A promotion id that is not there at all reads the same as one in a
    // Station this caller cannot reach: empty. Telling those apart would make
    // the function an oracle for ids, which is the reasoning the record read
    // already carries.
    const missing = await client.rpc('list_promotion_prizes', {
      p_promotion_id: '00000000-0000-0000-0000-0000000000ff',
    });
    expect(missing.error).toBeNull();
    expect(missing.data).toEqual([]);
  });

  it('hides an archived promotion’s prizes from a delegate and shows them to the owner', async () => {
    const label = `read-archived-${Date.now()}`;
    const customer = await provisionCustomer(label);
    const prizeId = await createPrizeAs(customer, `Filed ${label}`);
    await stockAsOwner(customer, prizeId, 4);
    const promotionId = await promotionAsOwner(customer, {
      startsAt: new Date(Date.now() + DAY).toISOString(),
      endsAt: new Date(Date.now() + 30 * DAY).toISOString(),
    });

    const delegate = await grantRoleWith(customer, label, [
      'promotions.view',
      'promotions.prizes',
      'promotions.archive',
    ]);
    const client = await clientFor(delegate);

    await client.rpc('link_prize_to_promotion', {
      p_promotion_id: promotionId,
      p_prize_id: prizeId,
      p_quantity: 2,
    });
    // Archiving now returns the units and closes the link (Task 6), so link
    // something that survives it: a second link with drawn units would be the
    // only survivor, and that needs the direct fixture.
    const second = await client.rpc('link_prize_to_promotion', {
      p_promotion_id: promotionId,
      p_prize_id: prizeId,
      p_quantity: 2,
    });
    setPromotionPrizeDrawnDirectly(second.data as string, 2);

    await client.rpc('archive_promotion', { p_promotion_id: promotionId });

    // 0044 admits an archived promotion to the owner and the platform admin
    // only. A DEFINER body never consults that policy, so the rule has to be
    // restated inside the function — and this is the case that proves it was.
    const hidden = await client.rpc('list_promotion_prizes', { p_promotion_id: promotionId });
    expect(hidden.error).toBeNull();
    expect(hidden.data).toEqual([]);

    const ownerClient = await clientFor(customer);
    const visible = await ownerClient.rpc('list_promotion_prizes', {
      p_promotion_id: promotionId,
    });
    expect(visible.data).toHaveLength(1);
    expect(visible.data![0]).toMatchObject({ linked: 2, drawn: 2 });
  });

  it('offers linkable prizes with their available stock, and caps the list', async () => {
    const label = `read-picker-${Date.now()}`;
    const customer = await provisionCustomer(label);
    const prizeId = await createPrizeAs(customer, `Zither ${label}`);
    await stockAsOwner(customer, prizeId, 7);

    const delegate = await grantRoleWith(customer, label, ['promotions.view', 'promotions.prizes']);
    const client = await clientFor(delegate);

    const all = await client.rpc('list_linkable_prizes', { p_company_id: customer.companyId });
    expect(all.error).toBeNull();
    expect(all.data).toContainEqual({
      prize_id: prizeId,
      name: `Zither ${label}`,
      available: 7,
    });

    // The search is a plain substring, not a LIKE pattern: a term with a % in
    // it is a term, not a wildcard.
    const found = await client.rpc('list_linkable_prizes', {
      p_company_id: customer.companyId,
      p_search: 'zither',
    });
    expect(found.data).toHaveLength(1);

    const none = await client.rpc('list_linkable_prizes', {
      p_company_id: customer.companyId,
      p_search: '%',
    });
    expect(none.data).toEqual([]);
  });

  it('refuses the picker to a delegate who may see promotions but not commit stock to them', async () => {
    const label = `read-picker-denied-${Date.now()}`;
    const customer = await provisionCustomer(label);
    const client = await clientFor(await grantRoleWith(customer, label, ['promotions.view']));

    const denied = await client.rpc('list_linkable_prizes', { p_company_id: customer.companyId });
    expect(denied.error?.code).toBe('42501');
  });
});
```

- [ ] **Step 2: Run and confirm they fail for the right reason**

Run: `npm run test:isolation -- tests/isolation/promotion-prizes.test.ts`

Expected: the six new cases fail with `PGRST202`; everything before them stays green.

- [ ] **Step 3: Write the migration**

Create `supabase/migrations/0051_promotion_prize_reads.sql`:

```sql
-- supabase/migrations/0051_promotion_prize_reads.sql
--
-- The Prizes tab reads through these rather than through the tables directly,
-- and not for convenience: a prize's NAME lives in public.prizes, whose policy
-- (0029) gates every read on inventory.view. An operator holding promotions.view
-- and promotions.prizes and nothing from the inventory module would otherwise
-- get a tab of blank names — a screen that half-works for its own permission.
--
-- Both are SECURITY DEFINER and so run past RLS entirely, which means each has
-- to restate in its own body the rules the policies would have applied. That is
-- the same trap 0024's comment documents, and the archived-promotion rule below
-- is where it would have bitten.

create or replace function public.list_promotion_prizes(p_promotion_id uuid)
returns table (
  promotion_prize_id uuid,
  prize_id           uuid,
  prize_name         text,
  linked             integer,
  drawn              integer
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor   uuid := auth.uid();
  v_company uuid;
  v_deleted timestamptz;
begin
  select p.company_id, p.deleted_at into v_company, v_deleted
  from public.promotions p
  where p.id = p_promotion_id;

  -- Returns nothing rather than raising. A promotion that does not exist and
  -- one in a Station this caller cannot reach must read the same, or the
  -- function becomes an oracle for ids — the reasoning getPromotionRecord
  -- already carries for the record itself.
  if not found then
    return;
  end if;

  if not public.has_permission('promotions.view', v_company) then
    raise log 'list_promotion_prizes denied: actor=% promotion=%', v_actor, p_promotion_id;
    raise exception 'permission denied: promotions.view required' using errcode = '42501';
  end if;

  -- 0044's policy admits an archived promotion to the owner and the platform
  -- admin and to nobody else. This body never consults that policy, so without
  -- this the archived record's prizes would be the leak the policy closed for
  -- the record.
  if v_deleted is not null and not public.is_owner_of_company(v_company) then
    return;
  end if;

  return query
    select l.id, l.prize_id, pz.name,
           coalesce(b.linked, 0), coalesce(b.drawn, 0)
    from public.promotion_prizes l
    join public.prizes pz on pz.id = l.prize_id
    left join public.promotion_prize_balances b on b.promotion_prize_id = l.id
    where l.promotion_id = p_promotion_id and l.deleted_at is null
    order by pz.name;
end;
$$;

comment on function public.list_promotion_prizes(uuid) is
  'One row per live link on a promotion: the prize, its name, and the two figures the owner''s screen calls Vinculados and Sorteados. Resto is linked - drawn and is computed on screen, never stored — a stored total is one more thing that can disagree with its parts. Gated on promotions.view, resolved from the promotion row. SECURITY DEFINER on purpose: the prize name is unreadable to a caller without inventory.view, and the Prizes tab must work for somebody who holds only the promotions codes. Returns nothing for a promotion that does not exist, one this caller cannot reach, and an archived one unless the caller is the owner or the platform admin — the same rule 0044''s policy applies to the record, restated because a DEFINER body never consults it. A LEFT JOIN to the projection, so a link whose balance row has not been created yet reads as zeros rather than vanishing.';

create or replace function public.list_linkable_prizes(
  p_company_id uuid,
  p_search     text default null
)
returns table (
  prize_id  uuid,
  name      text,
  available integer
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor  uuid := auth.uid();
  v_search text := nullif(btrim(coalesce(p_search, '')), '');
begin
  -- promotions.prizes rather than promotions.view: this list exists to be
  -- linked from, and showing somebody the Station's stock is not something
  -- reading a promotion should carry with it.
  if not public.has_permission('promotions.prizes', p_company_id) then
    raise log 'list_linkable_prizes denied: actor=% company=%', v_actor, p_company_id;
    raise exception 'permission denied: promotions.prizes required' using errcode = '42501';
  end if;

  return query
    select pz.id, pz.name, coalesce(b.available, 0)
    from public.prizes pz
    left join public.inventory_balances b
      on b.company_id = pz.company_id and b.prize_id = pz.id
    where pz.company_id = p_company_id
      and pz.deleted_at is null
      -- A plain substring rather than ILIKE with the term interpolated: a
      -- search for "50%" is a search for "50%", not for everything beginning
      -- with 50. No escaping to get wrong, because there are no
      -- metacharacters to escape.
      and (v_search is null or position(lower(v_search) in lower(pz.name)) > 0)
    order by pz.name
    -- Capped, and the screen says so rather than presenting a truncated list as
    -- the whole catalogue. Fifty is what a person can scan; the search is how
    -- they reach the fifty-first.
    limit 50;
end;
$$;

comment on function public.list_linkable_prizes(uuid, text) is
  'The prize picker behind the Link control: every live prize in the Station with its available count, ordered by name and capped at 50 — the screen must say the list is capped rather than presenting it as the whole catalogue. Prizes with zero available are included on purpose: hiding one would leave an operator hunting for a prize they can see on the inventory screen, and link_prize_to_promotion refuses the quantity anyway, naming the figure. Gated on promotions.prizes rather than promotions.view — showing somebody the Station''s stock is not something reading a promotion should carry with it — and SECURITY DEFINER for the same reason as list_promotion_prizes: the caller may hold nothing from the inventory module. The search is a plain substring match, not a LIKE pattern, so a term containing % or _ is a term.';

revoke execute on function public.list_promotion_prizes(uuid)      from public;
revoke execute on function public.list_linkable_prizes(uuid, text) from public;

grant execute on function public.list_promotion_prizes(uuid)      to authenticated;
grant execute on function public.list_linkable_prizes(uuid, text) to authenticated;
```

- [ ] **Step 4: Run the suite green**

Run: `npm run db:reset && npm run test:isolation -- tests/isolation/promotion-prizes.test.ts`

Expected: every case passes. If `hides an archived promotion's prizes` fails with a row for the delegate, `is_owner_of_company` is not being consulted; if it fails with an empty list for the owner, the check is inverted.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/0051_promotion_prize_reads.sql tests/isolation/promotion-prizes.test.ts
git commit -m "$(cat <<'EOF'
feat(promotions): the two reads the Prizes tab needs

A prize's name lives in public.prizes, gated on inventory.view. An operator with
promotions.view and promotions.prizes and nothing from the inventory module
would have got a tab of blank names — a screen that half-works for its own
permission. Both reads are SECURITY DEFINER for that reason, and both therefore
run past RLS, so each restates the rules the policies would have applied. The
archived-promotion rule is where that would have bitten: 0044 hides an archived
promotion from everyone but the owner, and without the restatement its prizes
would have been the leak that policy closed for the record.

The picker's search is a plain substring, not an interpolated LIKE pattern.
Nothing to escape, so nothing to escape wrongly.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: The server layer

**Files:**
- Modify: `src/lib/supabase/database.types.ts` (regenerated)
- Modify: `src/schemas/promotions.ts` (append)
- Modify: `src/services/promotions.ts`
- Modify: `src/app/(app)/promotions/access.ts`
- Modify: `src/app/(app)/promotions/actions.ts` (append)
- Modify: `tests/unit/promotions-schema.test.ts` (append)

**Interfaces:**
- Produces:
  - `promotionPrizeLinkSchema` → `PromotionPrizeLinkInput { promotionId: string; prizeId: string; quantity: number }`.
  - `PromotionPrizeRow { promotionPrizeId; prizeId; prizeName; linked; drawn }` and `LinkablePrize { prizeId; name; available }` in `@/services/promotions`.
  - `PromotionDetail.prizes: PromotionPrizeRow[]`.
  - `listLinkablePrizes`, `linkPrizeToPromotion`, `unlinkPrizeFromPromotion` in the service.
  - `PromotionPowers.prizes: boolean`.
  - `linkPrizeAction`, `unlinkPrizeAction` (both `(prev: PrizeLinkState, formData: FormData) => Promise<PrizeLinkState>`) and `searchLinkablePrizesAction(companyId: string, search: string)` in the actions file.
- Consumes: `list_promotion_prizes`, `list_linkable_prizes`, `link_prize_to_promotion`, `unlink_prize_from_promotion` (0049, 0051).

- [ ] **Step 1: Regenerate the types**

Run: `npm run db:reset && npm run db:types`

Expected: `database.types.ts` gains the four functions and the two tables. Never hand-edit it.

- [ ] **Step 2: Write the failing unit test**

Append to `tests/unit/promotions-schema.test.ts`:

```ts
describe('promotionPrizeLinkSchema', () => {
  const valid = {
    promotionId: '11111111-1111-1111-1111-111111111111',
    prizeId: '22222222-2222-2222-2222-222222222222',
    quantity: 3,
  };

  it('accepts a whole number of units', () => {
    expect(promotionPrizeLinkSchema.safeParse(valid).success).toBe(true);
  });

  it('refuses zero, because a link of nothing is not an event', () => {
    const result = promotionPrizeLinkSchema.safeParse({ ...valid, quantity: 0 });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain('at least one');
  });

  it('refuses a fraction — units are things, not amounts', () => {
    expect(promotionPrizeLinkSchema.safeParse({ ...valid, quantity: 1.5 }).success).toBe(false);
  });

  it('refuses a quantity that arrived as text the form could not read', () => {
    expect(promotionPrizeLinkSchema.safeParse({ ...valid, quantity: Number.NaN }).success).toBe(
      false,
    );
  });

  it('refuses an id that is not a uuid, so a hand-edited form cannot reach the RPC', () => {
    expect(promotionPrizeLinkSchema.safeParse({ ...valid, prizeId: 'not-an-id' }).success).toBe(
      false,
    );
  });
});
```

Add `promotionPrizeLinkSchema` to that file's import from `@/schemas/promotions`.

- [ ] **Step 3: Run it and confirm it fails**

Run: `npm test -- tests/unit/promotions-schema.test.ts`

Expected: fails to import `promotionPrizeLinkSchema`.

- [ ] **Step 4: Write the schema**

Append to `src/schemas/promotions.ts`:

```ts
/**
 * The Link and Unlink controls on the Prizes tab. Both post the same three
 * fields, and the direction is which action they post to rather than a flag in
 * the payload — a flag would make "unlink 5" and "link 5" one keystroke apart
 * in a form the operator cannot see.
 *
 * Every rule here has a refusal behind it in 0049, and that duplication is the
 * point rather than an oversight: this one gives the verdict on the screen
 * without a round trip, and the RPC gives it whether or not this ran.
 */
export const promotionPrizeLinkSchema = z.object({
  promotionId: z.string().uuid('Which promotion? Reopen the record.'),
  prizeId: z.string().uuid('Choose a prize.'),
  quantity: z
    .number({ invalid_type_error: 'How many units?' })
    .int('Units come in whole numbers.')
    .min(1, 'Link at least one unit.'),
});

export type PromotionPrizeLinkInput = z.infer<typeof promotionPrizeLinkSchema>;
```

- [ ] **Step 5: Run the unit test green**

Run: `npm test -- tests/unit/promotions-schema.test.ts`

- [ ] **Step 6: Widen the service**

In `src/services/promotions.ts`:

a. Add the two row types above `PromotionDetail`:

```ts
export interface PromotionPrizeRow {
  promotionPrizeId: string;
  prizeId: string;
  prizeName: string;
  /** Units committed to this promotion. Includes the drawn ones — the screen calls it Vinculados. */
  linked: number;
  /** Written by Block 6. Zero on every row until then, and the floor an unlink cannot go below. */
  drawn: number;
}

export interface LinkablePrize {
  prizeId: string;
  name: string;
  available: number;
}
```

b. Add `prizes: PromotionPrizeRow[];` to `PromotionDetail`, immediately after `questions`.

c. Inside `getPromotionRecord`, after the options read and before the `return`, add the fourth read:

```ts
  // The Prizes tab, read here rather than when the tab is opened: moving
  // between tabs must not reach the server, because a server round trip from
  // inside the dialog is how the list behind it gets re-rendered. Four reads
  // per opening, still one opening.
  //
  // list_promotion_prizes is SECURITY DEFINER (0051) and re-checks
  // promotions.view itself, so this is not a hole in the read gate: it is the
  // only way to get the prize NAME to a caller who holds no inventory
  // permission, which is most of the people who will use this tab.
  const { data: prizes, error: prizeError } = await supabase.rpc('list_promotion_prizes', {
    p_promotion_id: promotionId,
  });

  if (prizeError) {
    throw new InternalError(`Could not read the linked prizes: ${prizeError.message}`);
  }
```

and in the returned object, after `questions: ...`:

```ts
    prizes: (prizes ?? []).map((row) => ({
      promotionPrizeId: row.promotion_prize_id,
      prizeId: row.prize_id,
      prizeName: row.prize_name,
      linked: row.linked,
      drawn: row.drawn,
    })),
```

d. Append the three call wrappers at the end of the file:

```ts
/** What the picker shows. The RPC reads one more than this and the extra row is the signal. */
export const LINKABLE_PRIZE_PAGE_SIZE = 50;

export interface LinkablePrizePage {
  prizes: LinkablePrize[];
  /** True when the catalogue holds more than this page shows, so the screen can say so truthfully. */
  hasMore: boolean;
}

/**
 * `list_linkable_prizes` (0051) reads fifty-one rows and returns them all. The
 * fifty-first is not a result — it is the answer to "is there more", which is
 * the same convention listPromotionsPage uses with PROMOTION_PAGE_SIZE + 1 and
 * keysetPage. Counting instead would cost a second scan of the catalogue on
 * every keystroke; asking the screen to infer truncation from a full page would
 * make it announce a cut that did not happen to a Station holding exactly fifty
 * prizes, which is worse than saying nothing.
 */
export async function listLinkablePrizes(
  companyId: string,
  search: string | null,
  accessToken: string,
): Promise<LinkablePrizePage> {
  const { data, error } = await asCaller(accessToken).rpc('list_linkable_prizes', {
    p_company_id: companyId,
    p_search: search || undefined,
  });
  if (error) throw mapPromotionError(error.code, error.message);

  const rows = data ?? [];
  return {
    prizes: rows.slice(0, LINKABLE_PRIZE_PAGE_SIZE).map((row) => ({
      prizeId: row.prize_id,
      name: row.name,
      available: row.available,
    })),
    hasMore: rows.length > LINKABLE_PRIZE_PAGE_SIZE,
  };
}

export async function linkPrizeToPromotion(
  input: PromotionPrizeLinkInput,
  accessToken: string,
): Promise<string> {
  const { data, error } = await asCaller(accessToken).rpc('link_prize_to_promotion', {
    p_promotion_id: input.promotionId,
    p_prize_id: input.prizeId,
    p_quantity: input.quantity,
  });
  if (error) throw mapPromotionError(error.code, error.message);
  return data as string;
}

export async function unlinkPrizeFromPromotion(
  input: PromotionPrizeLinkInput,
  accessToken: string,
): Promise<void> {
  const { error } = await asCaller(accessToken).rpc('unlink_prize_from_promotion', {
    p_promotion_id: input.promotionId,
    p_prize_id: input.prizeId,
    p_quantity: input.quantity,
  });
  if (error) throw mapPromotionError(error.code, error.message);
}
```

Add `PromotionPrizeLinkInput` to the existing type import from `@/schemas/promotions`.

`mapPromotionError` already covers every code these raise: `23514` is the over-link and the D4 floor and becomes a `BusinessRuleError` whose message names the figures; `22023` is the non-positive quantity and the cancelled promotion; `P0002` is a stale promotion, prize or link; `42501` is `promotions.prizes`. Nothing new to map — check the comment above it still reads true and extend it with a line naming 4b's two RPCs.

- [ ] **Step 7: Widen the powers**

In `src/app/(app)/promotions/access.ts`, add `'promotions.prizes'` to `WRITE_CODES` (last), add `prizes: boolean;` to `PromotionPowers` with the comment `/** Linking moves stock, so it is its own code rather than part of promotions.edit. */`, and add `prizes: writes[4]?.data === true,` to the returned object.

- [ ] **Step 8: Add the actions**

Append to `src/app/(app)/promotions/actions.ts` (the file's no-`revalidatePath` banner covers these too — every write below is invoked from inside the record dialog and the dialog re-reads its own record):

```ts
export interface PrizeLinkState {
  status: 'idle' | 'saved' | 'error';
  message?: string;
}

function readPrizeLinkForm(formData: FormData) {
  const raw = String(formData.get('quantity') ?? '').trim();
  return promotionPrizeLinkSchema.safeParse({
    promotionId: formData.get('promotionId'),
    prizeId: formData.get('prizeId'),
    // Number('') is 0, which would reach the schema as a real quantity and be
    // refused with "Link at least one unit" for a field the operator left
    // blank. NaN gets the "How many units?" message instead, which is the true
    // one.
    quantity: raw === '' ? Number.NaN : Number(raw),
  });
}

export async function linkPrizeAction(
  _prev: PrizeLinkState,
  formData: FormData,
): Promise<PrizeLinkState> {
  const parsed = readPrizeLinkForm(formData);
  if (!parsed.success) {
    return { status: 'error', message: parsed.error.issues[0]?.message ?? 'Check the form.' };
  }

  const token = await requireAccessToken();
  try {
    await linkPrizeToPromotion(parsed.data, token);
    return { status: 'saved' };
  } catch (cause) {
    logger.error({ err: cause, promotionId: parsed.data.promotionId }, 'link prize failed');
    return {
      status: 'error',
      message: describePromotionsWriteError(cause, 'link this prize'),
    };
  }
}

export async function unlinkPrizeAction(
  _prev: PrizeLinkState,
  formData: FormData,
): Promise<PrizeLinkState> {
  const parsed = readPrizeLinkForm(formData);
  if (!parsed.success) {
    return { status: 'error', message: parsed.error.issues[0]?.message ?? 'Check the form.' };
  }

  const token = await requireAccessToken();
  try {
    await unlinkPrizeFromPromotion(parsed.data, token);
    return { status: 'saved' };
  } catch (cause) {
    logger.error({ err: cause, promotionId: parsed.data.promotionId }, 'unlink prize failed');
    return {
      status: 'error',
      message: describePromotionsWriteError(cause, 'return this prize to stock'),
    };
  }
}

/**
 * The prize picker's own read, called from the tab rather than folded into the
 * record: the record is read once per opening and this list changes with every
 * keystroke in the search box. Not a form action — it takes arguments directly,
 * because there is no form.
 */
export async function searchLinkablePrizesAction(
  companyId: string,
  search: string,
): Promise<
  { status: 'ok'; page: LinkablePrizePage } | { status: 'error'; message: string }
> {
  const token = await requireAccessToken();
  try {
    return { status: 'ok', page: await listLinkablePrizes(companyId, search.trim(), token) };
  } catch (cause) {
    logger.error({ err: cause, companyId }, 'could not list linkable prizes');
    return { status: 'error', message: describePromotionsReadError(cause) };
  }
}
```

Extend the imports at the top of the file: `linkPrizeToPromotion`, `unlinkPrizeFromPromotion`, `listLinkablePrizes` and the type `LinkablePrizePage` from `@/services/promotions`; `promotionPrizeLinkSchema` from `@/schemas/promotions`; and `describePromotionsReadError` from `./errors` alongside the write one.

- [ ] **Step 9: Run every gate**

Run: `npm run lint && npm run typecheck && npm test`

Expected: green. `typecheck` is the one that matters here — it is what proves the regenerated `database.types.ts` and the four hand-written mappings agree.

- [ ] **Step 10: Commit**

```bash
git add src/lib/supabase/database.types.ts src/schemas/promotions.ts src/services/promotions.ts src/app/\(app\)/promotions/access.ts src/app/\(app\)/promotions/actions.ts tests/unit/promotions-schema.test.ts
git commit -m "$(cat <<'EOF'
feat(promotions): the server layer for prize linking

The Prizes tab is read with the record, not when the tab is opened. Four reads
per opening instead of three, and still one opening — moving between tabs must
not reach the server, because a round trip from inside the dialog is how the
list behind it gets re-rendered.

An empty quantity field reaches the schema as NaN rather than as Number('') === 0,
so a blank field is told "How many units?" instead of "Link at least one unit",
which is a sentence about a number the operator never typed.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: The fourth tab

**Files:**
- Create: `src/app/(app)/promotions/prizes-tab.tsx`
- Modify: `src/app/(app)/promotions/promotion-record-dialog.tsx`
- Create: `tests/e2e/promotion-prizes.spec.ts`

**Interfaces:**
- Consumes: `PromotionDetail.prizes`, `linkPrizeAction`, `unlinkPrizeAction`, `searchLinkablePrizesAction`, `PromotionRecordPowers`.
- Produces: `PROMOTION_TABS` becomes `['data', 'whatsapp', 'quiz', 'prizes']`; `PromotionRecordPowers` gains `prizes: boolean`.

- [ ] **Step 1: Write the tab**

Create `src/app/(app)/promotions/prizes-tab.tsx`:

```tsx
'use client';

import { useActionState, useEffect, useState, useTransition } from 'react';
import { Button } from '@/components/ui/button';
import { Input, Select } from '@/components/ui/input';
import { LINKABLE_PRIZE_PAGE_SIZE } from '@/services/promotions';
import type { LinkablePrize, PromotionPrizeRow } from '@/services/promotions';
import {
  linkPrizeAction,
  searchLinkablePrizesAction,
  unlinkPrizeAction,
  type PrizeLinkState,
} from './actions';

const INITIAL: PrizeLinkState = { status: 'idle' };

/**
 * Vinculados / Sorteados / Resto, one row per linked prize, plus the two
 * controls that move units in and out.
 *
 * Resto is computed here and stored nowhere: a stored total is one more thing
 * that can disagree with its parts, and this one has two parts that are already
 * reconciled against the ledger.
 *
 * Every write calls `onSaved`, which re-reads this one record. That is not a
 * hole in the rule this screen rests on: the prohibition is on re-running the
 * LIST, not on reading one record again, and nothing behind the dialog is
 * re-rendered.
 */
export function PrizesTab({
  promotionId,
  companyId,
  prizes,
  canLink,
  onSaved,
}: {
  promotionId: string;
  companyId: string;
  prizes: PromotionPrizeRow[];
  canLink: boolean;
  onSaved: () => void;
}) {
  const [linking, setLinking] = useState(false);

  return (
    <div className="flex flex-col gap-5">
      {prizes.length === 0 && !linking && (
        <p className="text-sm text-muted-foreground">
          No prize is linked to this promotion yet. A promotion can run without one, but nothing can
          be drawn from it.
        </p>
      )}

      {prizes.length > 0 && (
        <div className="overflow-x-auto rounded-md border">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/50 text-left text-muted-foreground">
                <th className="px-3 py-2 font-medium">Prize</th>
                <th className="px-3 py-2 font-medium">Linked</th>
                <th className="px-3 py-2 font-medium">Drawn</th>
                <th className="px-3 py-2 font-medium">Left</th>
                {canLink && <th className="px-3 py-2 font-medium sr-only">Return to stock</th>}
              </tr>
            </thead>
            <tbody>
              {prizes.map((row) => (
                <tr
                  key={row.promotionPrizeId}
                  className="border-b last:border-0"
                  data-testid="promotion-prize-row"
                >
                  <td className="px-3 py-2">{row.prizeName}</td>
                  <td className="px-3 py-2" data-testid="promotion-prize-linked">
                    {row.linked}
                  </td>
                  <td className="px-3 py-2">{row.drawn}</td>
                  <td className="px-3 py-2">{row.linked - row.drawn}</td>
                  {canLink && (
                    <td className="px-3 py-2">
                      <UnlinkControl
                        promotionId={promotionId}
                        prizeId={row.prizeId}
                        free={row.linked - row.drawn}
                        onSaved={onSaved}
                      />
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {canLink && !linking && (
        <div>
          <Button type="button" variant="outline" onClick={() => setLinking(true)} data-testid="prize-link-open">
            Link a prize
          </Button>
        </div>
      )}

      {canLink && linking && (
        <LinkForm
          promotionId={promotionId}
          companyId={companyId}
          onCancel={() => setLinking(false)}
          onSaved={() => {
            setLinking(false);
            onSaved();
          }}
        />
      )}

      {!canLink && (
        <p className="text-sm text-muted-foreground">
          You do not hold promotions.prizes at this Station, so what is linked can be read here but
          not changed.
        </p>
      )}
    </div>
  );
}

/**
 * Bounded by Resto rather than by Vinculados: the drawn units belong to a
 * winner. The RPC refuses the same thing and names both figures, so this is the
 * verdict without a round trip and not the boundary.
 */
function UnlinkControl({
  promotionId,
  prizeId,
  free,
  onSaved,
}: {
  promotionId: string;
  prizeId: string;
  free: number;
  onSaved: () => void;
}) {
  const [state, action, pending] = useActionState(unlinkPrizeAction, INITIAL);
  const [quantity, setQuantity] = useState('1');

  useEffect(() => {
    if (state.status === 'saved') onSaved();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  if (free === 0) {
    return <span className="text-xs text-muted-foreground">All drawn</span>;
  }

  return (
    <form action={action} className="flex items-center gap-2">
      <input type="hidden" name="promotionId" value={promotionId} />
      <input type="hidden" name="prizeId" value={prizeId} />
      <Input
        name="quantity"
        type="number"
        min={1}
        max={free}
        value={quantity}
        onChange={(e) => setQuantity(e.target.value)}
        aria-label="Units to return to stock"
        className="w-20"
        data-testid="prize-unlink-quantity"
      />
      <Button type="submit" variant="outline" disabled={pending} data-testid="prize-unlink">
        {pending ? 'Returning…' : 'Return'}
      </Button>
      {state.status === 'error' && (
        <span className="text-xs text-destructive" data-testid="prize-unlink-error">
          {state.message}
        </span>
      )}
    </form>
  );
}

function LinkForm({
  promotionId,
  companyId,
  onCancel,
  onSaved,
}: {
  promotionId: string;
  companyId: string;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const [state, action, pending] = useActionState(linkPrizeAction, INITIAL);
  const [search, setSearch] = useState('');
  const [options, setOptions] = useState<LinkablePrize[]>([]);
  const [cut, setCut] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [loading, startLoading] = useTransition();

  useEffect(() => {
    if (state.status === 'saved') onSaved();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  // Debounced, because this runs per keystroke and each run is a server round
  // trip. 250ms is the same figure the Station search uses.
  useEffect(() => {
    const timer = setTimeout(() => {
      startLoading(async () => {
        const result = await searchLinkablePrizesAction(companyId, search);
        if (result.status === 'ok') {
          setOptions(result.page.prizes);
          setCut(result.page.hasMore);
          setFailure(null);
          return;
        }
        setOptions([]);
        setCut(false);
        setFailure(result.message);
      });
    }, 250);
    return () => clearTimeout(timer);
  }, [companyId, search]);

  return (
    <form action={action} className="flex flex-col gap-4 rounded-md border p-4" data-testid="prize-link-form">
      <input type="hidden" name="promotionId" value={promotionId} />

      <label className="flex flex-col gap-1 text-sm">
        <span className="text-muted-foreground">Find a prize</span>
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Part of the name"
          data-testid="prize-link-search"
        />
      </label>

      <label className="flex flex-col gap-1 text-sm">
        <span className="text-muted-foreground">Prize</span>
        <Select name="prizeId" required data-testid="prize-link-select">
          <option value="">Choose a prize…</option>
          {options.map((prize) => (
            <option key={prize.prizeId} value={prize.prizeId}>
              {prize.name} — {prize.available} available
            </option>
          ))}
        </Select>
        {/* No silent caps: a list that stops must say so, or an operator
            hunting for the prize that is not there concludes it is gone.
            Driven by the service's own hasMore — which comes from the RPC
            returning one row past the page — rather than from a full page,
            because a Station holding exactly fifty prizes would otherwise be
            told about a truncation that did not happen. */}
        {cut && (
          <span className="text-xs text-muted-foreground">
            Showing the first {LINKABLE_PRIZE_PAGE_SIZE}. Narrow the search to reach the rest.
          </span>
        )}
        {loading && <span className="text-xs text-muted-foreground">Looking…</span>}
        {failure && <span className="text-xs text-destructive">{failure}</span>}
      </label>

      <label className="flex flex-col gap-1 text-sm">
        <span className="text-muted-foreground">Units</span>
        <Input
          name="quantity"
          type="number"
          min={1}
          defaultValue={1}
          required
          className="w-28"
          data-testid="prize-link-quantity"
        />
      </label>

      {state.status === 'error' && (
        <p className="text-sm text-destructive" data-testid="prize-link-error">
          {state.message}
        </p>
      )}

      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={pending} data-testid="prize-link-save">
          {pending ? 'Linking…' : 'Link'}
        </Button>
      </div>
    </form>
  );
}
```

- [ ] **Step 2: Wire the tab into the dialog**

In `src/app/(app)/promotions/promotion-record-dialog.tsx`:

a. Line 16 — `export const PROMOTION_TABS = ['data', 'whatsapp', 'quiz', 'prizes'] as const;`

b. Line 19–23 — add `prizes: 'Prizes',` to `TAB_LABELS`.

c. Line 25–27 — `PromotionRecordPowers` gains `prizes: boolean;`.

d. After the `QuizTab` block (line 266–273):

```tsx
            {tab === 'prizes' && (
              <PrizesTab
                promotionId={record.id}
                companyId={record.companyId}
                prizes={record.prizes}
                canLink={powers.prizes}
                onSaved={refresh}
              />
            )}
```

e. Import `PrizesTab` from `./prizes-tab`.

f. **Line 297 — the footer's Save button.** It renders for every tab but `quiz`; the Prizes tab has no fields on the shared form either, and leaving Save there would submit the promotion's own form from a tab that shows none of it:

```tsx
        {record && !readOnly && tab !== 'quiz' && tab !== 'prizes' && (
```

g. The page passes `powers` straight through (`page.tsx:176`), and `getPromotionPowers` gained `prizes` in Task 8, so nothing there changes. Confirm with `npm run typecheck` — `PromotionRecordPowers` and `PromotionPowers` are structurally compatible, so a missing field surfaces there.

- [ ] **Step 3: Write the e2e**

Create `tests/e2e/promotion-prizes.spec.ts`. Copy the fixture scaffolding from `tests/e2e/promotions-flow.spec.ts:1-86` verbatim — the admin client, `createdUserIds`, `beforeAll`/`afterAll`, `countListRenders` with its whole warning comment, and `test.describe.configure({ mode: 'serial' })` — changing only the `stamp`-derived names to `e2e-prize-*`. Then:

```ts
test('linking a prize moves stock without the list behind the dialog being re-queried', async ({
  page,
}) => {
  // [ Sign in as the platform admin, provision the customer, set the owner's
  //   password at the change-password gate, and register one prize with stock
  //   and one promotion — the same sequence promotions-flow.spec.ts performs in
  //   its first test, through the real screens. ]

  const renders = countListRenders(page);

  await page.goto('/promotions');
  await page.getByRole('link', { name: promotionName }).click();
  await page.getByTestId('promotion-tab-prizes').click();

  // The tab renders from the record that was already read. Nothing about
  // switching to it may reach the server.
  const rendersBeforeLink = renders.length;

  await page.getByTestId('prize-link-open').click();
  await page.getByTestId('prize-link-search').fill(prizeName);
  await page.getByTestId('prize-link-select').selectOption({ label: `${prizeName} — 10 available` });
  await page.getByTestId('prize-link-quantity').fill('4');
  await page.getByTestId('prize-link-save').click();

  await expect(page.getByTestId('promotion-prize-row')).toHaveCount(1);
  await expect(page.getByTestId('promotion-prize-linked')).toHaveText('4');

  // The whole point of the block's screen rule: the write and the re-read both
  // happened, and the list behind the dialog was rendered neither time.
  expect(renders.length).toBe(rendersBeforeLink);

  await page.getByTestId('prize-unlink-quantity').fill('4');
  await page.getByTestId('prize-unlink').click();

  await expect(page.getByTestId('promotion-prize-row')).toHaveCount(0);
  expect(renders.length).toBe(rendersBeforeLink);

  // And the units are actually back — asserted against the inventory screen
  // rather than against the tab that just said so.
  await page.goto('/inventory');
  await expect(page.getByText(prizeName)).toBeVisible();
  await expect(page.getByTestId('prize-available').first()).toHaveText('10');
});
```

Fill the bracketed setup in from `promotions-flow.spec.ts`'s own first test; check the actual `data-testid` on the inventory list's available cell before writing the last assertion, and if there is none, assert on the row's text instead of inventing one.

- [ ] **Step 4: Run every gate**

Run: `npm run lint && npm run typecheck && npm test && npm run test:e2e -- tests/e2e/promotion-prizes.spec.ts`

Expected: green. If the e2e's render counter trips, something in the tab is calling a server action that returns a re-rendered tree — check that no `revalidatePath` was added to `actions.ts`.

- [ ] **Step 5: Run the full e2e suite**

Run: `npm run test:e2e`

Expected: green, `promotions-flow.spec.ts` included — the fourth tab changes `PROMOTION_TABS`, which `parseRecordParam` validates against, so a `?tab=` value in that spec would surface here.

- [ ] **Step 6: Commit**

```bash
git add src/app/\(app\)/promotions/prizes-tab.tsx src/app/\(app\)/promotions/promotion-record-dialog.tsx tests/e2e/promotion-prizes.spec.ts
git commit -m "$(cat <<'EOF'
feat(promotions): the Prizes tab

Vinculados, Sorteados and Resto, matching the owner's screen. Resto is computed
and stored nowhere — a stored total is one more thing that can disagree with its
parts, and these two parts are already reconciled against the ledger.

The Return control is bounded by Resto rather than by Vinculados, because the
drawn units belong to a winner. The RPC refuses the same thing and names both
figures; the bound on screen is the verdict without a round trip, not the
boundary.

The picker says when it is showing only the first fifty. A list that stops
silently reads as the whole catalogue to an operator hunting for the
fifty-first.

The footer's Save button now hides on this tab as well as on Quiz: it submits
the promotion's own form, and offering it from a tab that shows none of those
fields is offering to save something the operator cannot see.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 10: Mutation, the spec amendment, and the block report

**Files:**
- Modify: `docs/superpowers/specs/2026-07-30-block-4b-promotion-prizes-design.md`
- Create: `docs/block-4b-report.md`

An assertion that passes is not evidence until you have seen it fail. Both mutations below were planned before the code was written (spec §6) and each names a specific assertion that must go red. **Revert every mutation before committing** — `git checkout --` the file, never a hand-undo.

- [ ] **Step 1: Mutation 1 — remove `drawn` from the unlink floor**

In `supabase/migrations/0049_promotion_prize_rpcs.sql`, change `v_free := v_linked - v_drawn;` to `v_free := v_linked;`.

Run: `npm run db:reset && npm run test:isolation -- tests/isolation/promotion-prizes.test.ts`

Expected RED: `refuses to go below what has been drawn, naming both figures`. It must fail on the *fourth* unit being accepted, not on the message. If it stays green, the RPC's check is not what that case is testing and the case is worthless.

Note in the report what the table check does here: the fourth unlink is still refused, but by `promotion_prize_balances_drawn_within_linked` with a bare constraint name, so the assertion on `23514` alone would survive. That is why the case asserts the message contains the drawn figure.

Revert: `git checkout -- supabase/migrations/0049_promotion_prize_rpcs.sql`

- [ ] **Step 2: Mutation 2 — drop the per-promotion write from the ledger**

In `supabase/migrations/0047_promotion_prize_ledger.sql`, comment out the whole `if p_promotion_prize_id is not null then` block that does the arithmetic (INSERTION 3), leaving the bootstrap and the lock in place.

Run: `npm run db:reset && npm run test:isolation -- tests/isolation/promotion-prizes.test.ts && npm run db:test`

Expected RED, in this order:
1. `04_promotion_prizes.test.sql` — `the per-promotion projection was written inside the same transaction`.
2. `reports no divergence after a link and unlink round trip` — reconciliation returns the `linked` rows it should not.
3. `moves the units out of available and into the promotion` — the balance reads 0.

The second is the one that matters: it is the assertion that proves reconciliation would have *caught* this in production, rather than the two that prove the write happens.

Revert: `git checkout -- supabase/migrations/0047_promotion_prize_ledger.sql`

- [ ] **Step 3: Mutation 3 — remove the archived-promotion rule from the read**

In `supabase/migrations/0051_promotion_prize_reads.sql`, delete the `if v_deleted is not null and not public.is_owner_of_company(v_company) then return; end if;` block.

Run: `npm run db:reset && npm run test:isolation -- tests/isolation/promotion-prizes.test.ts`

Expected RED: `hides an archived promotion's prizes from a delegate and shows them to the owner`, on the delegate half. This is the leak a DEFINER read opens by default, so seeing it open is worth the thirty seconds.

Revert: `git checkout -- supabase/migrations/0051_promotion_prize_reads.sql`

- [ ] **Step 4: Confirm everything is reverted and green**

Run: `git status --short && npm run db:reset && npm run lint && npm run typecheck && npm test && npm run db:test && npm run test:isolation && npm run test:e2e`

Expected: `git status` shows no modified migration, and every gate green at real defaults.

- [ ] **Step 5: Amend the spec**

In `docs/superpowers/specs/2026-07-30-block-4b-promotion-prizes-design.md`:

a. In §2 D1, replace the paragraph beginning "Archiving still refuses while the promotion is accepting entries (4a)…" with:

```markdown
**Archiving returns them too, and that is a correction to this spec rather than
an extension of it.** The paragraph that stood here reasoned that archiving
already refuses while a promotion is accepting entries, so anything archivable
had been cancelled first and D1 was enough on its own. That is not what 4a
shipped: `archive_promotion` refuses only *inside* the window, and
`cancel_promotion` refuses a promotion that has already *ended*. An ended,
never-cancelled promotion was therefore archivable with its prizes still linked
— the exact stranding this decision exists to prevent, reachable by doing
nothing at all. The owner's call was that archiving should hand the units back
itself rather than grow a new refusal, so archiving now moves stock, which it
did not before. Both paths share one helper (`return_promotion_prizes`, 0050).
```

b. Add to §7:

```markdown
- **Archiving moves stock now** (§2 D1). It is the only operation in the project
  whose name suggests filing a record away and which also touches a balance;
  that was the owner's choice over a new refusal, and it is worth revisiting if
  Block 6's draw gives an ended promotion another way to let go of its prizes.
- **`list_linkable_prizes` caps at 50** and the picker says so. A Station with
  hundreds of prizes has a search box and nothing else; whether that is enough
  is a question for the first operator who has one.
```

c. In §3.2, after the paragraph about `Resto`, add:

```markdown
`drawn` has no writer in this block, so D4's floor has no fixture reachable
through any RPC. `setPromotionPrizeDrawnDirectly` in the isolation harness is
the escape hatch, the same shape `corruptBalanceDirectly` opened for the
per-prize projection and with the same warning attached: a row set that way is a
genuine divergence and reconciliation reports it.
```

- [ ] **Step 6: Write the block report**

Create `docs/block-4b-report.md`, following `docs/block-4a-report.md`'s structure. It must contain, and not merely gesture at:

- **What shipped** — the seven migrations 0045–0051, one line each, and the screen.
- **The two decisions taken during planning that the spec did not contain**: the archive hole and the owner's answer to it, and the two DEFINER reads that exist because a prize's name is gated on `inventory.view`. Both with the reasoning, not just the outcome.
- **The mutation log** — the three mutations above, what went red, and the note from Step 1 about the table check keeping the SQLSTATE alive while the message dies. That note is the reason the assertion checks the message.
- **What Block 6 inherits**, each with the file and the line to change:
  - Widen `inventory_movements_promotion_reference` (0045) to `DRAW`, `DRAW_CANCEL`, `DELIVERY` and the return types, and teach `apply_inventory_movement`'s type dispatch (0047) about each — it raises `XX000` for anything it does not know, which is the tripwire.
  - Add `delivered` to `promotion_prize_balances` with the movement that fills it (0045's column comment says so).
  - The `drawn` arm of `reconcile_inventory` (0048) starts returning real figures with no change there.
  - `setPromotionPrizeDrawnDirectly` becomes unnecessary and should be deleted, along with the tests' reliance on it.
- **Open items**, copied from the spec's §7 as amended.

- [ ] **Step 7: Commit and open the PR**

```bash
git add docs/block-4b-report.md docs/superpowers/specs/2026-07-30-block-4b-promotion-prizes-design.md
git commit -m "$(cat <<'EOF'
docs: the Block 4b report, and the correction the spec needed

D1 rested on a premise 4a's code does not hold. The spec now says so in the
decision itself rather than in a report nobody reads next to it.

Three mutations, three assertions red. The one worth keeping is the first:
removing drawn from the unlink floor leaves the table check refusing the same
write, so an assertion on the SQLSTATE alone would have survived it. The case
asserts the message names the drawn figure, and that is what dies.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"

git push -u origin block-4b
gh pr create --base main --title "Block 4b — prize linking, and the surgery on the ledger" --body "$(cat <<'EOF'
## What this is

The second of Block 4's three passes. `PROMOTION_LINK` and `PROMOTION_UNLINK`
have been legal transitions in the ledger since 0026 and unreachable ever since,
because `inventory_movements` carried no promotion reference at all. This makes
them reachable, adds the per-promotion projection the design document calls H1,
and gives the record dialog its fourth tab.

## The two things a reviewer should look at first

**`apply_inventory_movement` is dropped and recreated, not replaced.** Its
argument list changes, and `create or replace` cannot do that — it would have
left the eight-argument overload in place alongside the new nine-argument one,
and every eight-argument call site would have become ambiguous between them,
raising `42725` on the five oldest write paths in the schema.

**This paragraph used to say something else, and the correction is the most
useful thing in the block's mutation round.** It claimed those five callers
"would have gone on resolving to it and silently never writing the new
projection", and that `02_permissions.test.sql` "pins the signature literally so
that mistake fails the suite". Both were false, and nobody noticed for seven
tasks. The failure is loud, not silent; and `::regprocedure` resolves the
signature it is handed and succeeds regardless of what else shares the name, so
pgTAP passed **331 of 331 with both overloads live**. `02_permissions.test.sql`
now counts `pg_proc` entries by name, which does catch it, and that assertion
was proved by re-running the mutation against it. Full account in
`docs/block-4b-report.md` §4.4.

**Archiving moves stock now.** The spec's D1 assumed cancelling was the only way
a promotion could let go of its prizes; it is not, because `cancel_promotion`
refuses an ended promotion and `archive_promotion` permits one. The owner chose
to have archiving return the units rather than grow a new refusal. See
`docs/block-4b-report.md`.

## Verification

Every gate at real defaults: lint, typecheck, unit, pgTAP, isolation, e2e.
Three planned mutations, each with the assertion it killed, in the report.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Self-Review

Run against the spec with fresh eyes before executing Task 1.

**Spec coverage.** §3.1 `promotion_prizes` → Task 1. §3.2 `promotion_prize_balances`, no `delivered`, `Resto` computed → Task 1 (table), Task 9 (Resto on screen). §3.3 the ledger column and its check → Task 1. §3.4 `apply_inventory_movement` → Task 3; `reconcile_inventory` → Task 4. §4's three RPCs → Tasks 5 and 6; the `for update` discipline → both; every refusal in the table → Task 5's isolation cases, one each. §4's "an ended promotion still accepts links" → Task 5, `is allowed after the window has closed`. §4's `promotions.prizes` → Task 1. §5 the Prêmios tab → Task 9; "part of the record read" → Task 8, the fourth read inside `getPromotionRecord`; "the inventory screen's prize record gains nothing here" → nothing in this plan touches it, correctly. §6 pgTAP per constraint → Tasks 1–3; the two isolation cases that matter most → Task 6 (D1) and Task 5 (reconciliation round trip); mutation planned in advance → Task 10.

Two things the spec asks for that this plan deliberately does **not** do, both stated where they arise: the spec's §2 premise about archiving is corrected rather than implemented (Task 6), and §5's assumption that the tab can read prize names is replaced with two DEFINER reads (Task 7).

**Placeholder scan.** The three bracketed `[ ... verbatim ]` markers in Tasks 3, 4 and 6 name a file and a line range in this repository and describe exactly what changes inside it; they are diffs against readable source, not "fill in details". Task 9's e2e has one bracketed setup block with the same property, plus an explicit instruction to check the inventory list's actual `data-testid` rather than invent one. Everywhere else the code is whole.

**Type consistency.** `promotion_prize_id` is the column, the RPC output field and `promotionPrizeId` in TypeScript throughout. `linked`/`drawn` never change name across the SQL, the RPC, the service and the tab; `Resto` appears only as UI text and as `linked - drawn`. `PromotionPrizeRow` is used by `PromotionDetail.prizes` (Task 8) and consumed by `PrizesTab` (Task 9) with the same five fields. `PrizeLinkState` is produced in Task 8 and consumed in Task 9. `PromotionPowers.prizes` (Task 8) and `PromotionRecordPowers.prizes` (Task 9) are both added, and `typecheck` is what proves they meet. `link_prize_to_promotion` returns `uuid` in 0049 and is typed `Promise<string>` in the service.

**One ordering hazard worth restating:** Task 6's `archive_promotion` change makes Task 7's archived-promotion test need a link with `drawn > 0` to have anything left to hide — archiving now closes every undrawn link. That is why that case links twice and sets `drawn` on the second. Written that way from the start rather than discovered when the test comes back empty.
