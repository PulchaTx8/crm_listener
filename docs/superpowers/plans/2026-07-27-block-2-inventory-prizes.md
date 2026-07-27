# Block 2 — Inventory & Prizes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the prize catalogue and an immutable stock ledger with a transactional projection, so that the number on the screen is the truth and the system says so when it is not.

**Architecture:** `inventory_movements` is append-only — no role holds `UPDATE` or `DELETE`. `inventory_balances` is a projection per `(company, prize)` maintained in the same transaction, under a row lock, by one private routine that every public RPC funnels through. Reconciliation recomputes from the ledger and reports divergence without repairing it.

**Tech Stack:** PostgreSQL 15 (Supabase), PL/pgSQL `SECURITY DEFINER` RPCs, Next.js 15 App Router, Zod, Vitest, pgTAP, Playwright.

**Spec:** `docs/superpowers/specs/2026-07-27-block-2-inventory-prizes-design.md`

## Global Constraints

- Everything in English: identifiers, comments, error messages, UI copy, docs.
- Vocabulary: `organizations` (Organization), `companies` (**Station** in prose and UI), `company_memberships` (internal panel users — not the audience).
- Every new table: RLS enabled, `revoke all from anon, authenticated`, explicit grants per role, explicit `service_role` grant. `BYPASSRLS` is not a substitute for a `GRANT`.
- **No role holds `UPDATE` or `DELETE` on `inventory_movements` or `inventory_balances`**, including `service_role`. Every write is a `SECURITY DEFINER` RPC.
- Every business uniqueness rule is a partial unique index `where deleted_at is null`.
- `USING (true)` is forbidden in policies.
- Every `SECURITY DEFINER` function re-checks the caller in its own body, resolves the Organization from the row it was given rather than a caller-supplied id, and on denial uses `RAISE LOG` then `RAISE EXCEPTION` — never an `audit_logs` insert before a raise.
- Cross-tenant integrity is declarative: composite foreign keys sharing the tenant column, never a runtime check alone.
- Migrations numbered sequentially from `0025`.
- Commands: `npm run lint`, `npm run typecheck`, `npm test`, `npm run test:isolation`, `npm run test:e2e`, `npx supabase db reset`, `npx supabase test db`, `npm run db:types`.

## Lessons carried from Block 1c — these are requirements, not advice

1. **Every UI scenario has a non-owner operating.** Block 1c shipped two defects that thirteen reviews missed because every screen scenario had the owner driving, and the owner's bypass hid the delegate's failure. Any e2e or manual walkthrough in this block that uses the owner for a permission-gated action is wrong.
2. **A `language sql` function whose body names a dropped column or table breaks on any call, at plan time.** When a migration drops something, grep every helper for it.
3. **A composite foreign key cannot see a partial index**, so it cannot see `deleted_at`. Anywhere archival must be respected, the check is explicit and takes a row lock.
4. **pgTAP proves structure; only the isolation suite proves enforcement.** It runs as superuser with no session user, so a check reading `auth.uid()` is untestable there.
5. **An assertion that passes for the wrong reason is worse than a missing one.** Pin the error code or the message, never just "an error happened".

---

### Task 1: Catalogue — enums, categories, prizes, permissions

**Files:**
- Create: `supabase/migrations/0025_inventory_catalogue.sql`
- Modify: `supabase/tests/02_permissions.test.sql`

**Interfaces:**
- Produces: types `public.inventory_bucket`, `public.inventory_movement_type`; tables `public.prize_categories`, `public.prizes`; unique constraint `prizes_id_company_unique`; permission codes `inventory.view`, `inventory.catalogue`, `inventory.entry`, `inventory.exit`, `inventory.adjust`, `inventory.reserve`.

- [ ] **Step 1: Write the migration**

```sql
-- supabase/migrations/0025_inventory_catalogue.sql

-- The full bucket vocabulary, including the four this block cannot move. The
-- ledger is immutable: its shape has to account from the first row for the
-- transitions Blocks 4 and 6 will make, or those blocks backfill a projection
-- from a ledger that never recorded the distinction.
create type public.inventory_bucket as enum (
  'available', 'reserved', 'linked', 'awaiting_pickup', 'pending_return',
  'delivered', 'written_off'
);

comment on type public.inventory_bucket is
  'Partition of stock. available..pending_return are physical; delivered and written_off are cumulative counters outside the physical total.';

create type public.inventory_movement_type as enum (
  'INITIAL_ENTRY', 'PURCHASE_ENTRY', 'MANUAL_ENTRY', 'MANUAL_EXIT',
  'ADJUSTMENT_POSITIVE', 'ADJUSTMENT_NEGATIVE',
  'RESERVATION', 'RESERVATION_RELEASE',
  'PROMOTION_LINK', 'PROMOTION_UNLINK',
  'DRAW', 'DRAW_CANCEL', 'DELIVERY',
  'RETURN_PENDING', 'RETURN_TO_STOCK', 'WRITE_OFF'
);

create table public.prize_categories (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id),
  company_id      uuid not null,
  name            text not null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  deleted_at      timestamptz,
  constraint prize_categories_company_org_fk
    foreign key (company_id, organization_id)
    references public.companies (id, organization_id)
);

comment on table public.prize_categories is 'Flat grouping for prizes within a Station. Not a tree — nobody has asked for nesting.';

create unique index prize_categories_name_unique
  on public.prize_categories (company_id, lower(name))
  where deleted_at is null;

create table public.prizes (
  id                     uuid primary key default gen_random_uuid(),
  organization_id        uuid not null references public.organizations (id),
  company_id             uuid not null,
  category_id            uuid references public.prize_categories (id),
  name                   text not null,
  internal_code          text,
  description            text,
  allows_return_to_stock boolean not null default true,
  created_by             uuid references auth.users (id),
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  deleted_at             timestamptz,
  constraint prizes_company_org_fk
    foreign key (company_id, organization_id)
    references public.companies (id, organization_id)
);

comment on table public.prizes is 'What a Station can give away. Quantity lives in inventory_balances; this table never carries a count.';
comment on column public.prizes.allows_return_to_stock is
  'Spec N11. Read by Block 6''s return flow, which does not exist yet — this is the one column in this block that nothing yet consumes. Set at registration by the person who knows the answer; deliberate debt, not dead weight.';

-- The code is optional, so two prizes without one must not collide.
create unique index prizes_internal_code_unique
  on public.prizes (company_id, lower(internal_code))
  where deleted_at is null and internal_code is not null;

create index prizes_company_idx on public.prizes (company_id) where deleted_at is null;
create index prizes_category_idx on public.prizes (category_id) where deleted_at is null;

-- For the composite foreign keys in 0026: a balance or a movement cannot name a
-- prize belonging to another Station. Non-partial, because a foreign key cannot
-- reference a partial index — which is exactly why archival needs its own
-- explicit check in the RPCs (Block 1c §3).
alter table public.prizes add constraint prizes_id_company_unique unique (id, company_id);

-- A permission is born beside the feature it guards. These appear in the role
-- editor without that screen being touched; if they do not, Block 1c's catalogue
-- was built wrong and this is where we find out.
insert into public.permissions (code, description, introduced_by_block, module, label, scope, display_order) values
  ('inventory.view',      'Read prizes and stock levels',              '2', 'inventory', 'See prizes and stock',                      'company', 10),
  ('inventory.catalogue', 'Register, edit and archive prizes',         '2', 'inventory', 'Register, edit and archive prizes',         'company', 20),
  ('inventory.entry',     'Add quantity to stock',                     '2', 'inventory', 'Add stock',                                 'company', 30),
  ('inventory.exit',      'Record a manual exit from stock',           '2', 'inventory', 'Record a manual exit',                      'company', 40),
  ('inventory.adjust',    'Adjust stock to match a physical count',    '2', 'inventory', 'Adjust stock to match a count',             'company', 50),
  ('inventory.reserve',   'Reserve stock and release a reservation',   '2', 'inventory', 'Reserve stock and release a reservation',   'company', 60);
```

- [ ] **Step 2: Append the pgTAP assertions**

Append to `supabase/tests/02_permissions.test.sql` and set its plan count from the runner, not by arithmetic.

```sql
-- Block 2: the catalogue's own seed, and the scope that decides which helper
-- resolves it. inventory.* must be company-scoped — an Organization-scoped
-- inventory permission would grant stock rights in Stations the holder has no
-- role in, which is the opposite of what Block 1c built.
select is(
  (select count(*)::int from public.permissions where module = 'inventory'),
  6,
  'six inventory permissions are seeded'
);
select is(
  (select count(*)::int from public.permissions where module = 'inventory' and scope = 'company'),
  6,
  'every inventory permission is Company-scoped'
);
select is(
  (select introduced_by_block from public.permissions where code = 'inventory.adjust'),
  '2',
  'inventory.adjust is seeded by this block'
);

select has_table('public', 'prizes', 'prizes exists');
select has_table('public', 'prize_categories', 'prize_categories exists');
select has_index('public', 'prizes', 'prizes_internal_code_unique',
  'an internal code is unique per Station while the prize is live');
```

- [ ] **Step 3: Run the database suite**

Run: `npx supabase db reset && npx supabase test db`
Expected: green, with the six new assertions in the output.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/0025_inventory_catalogue.sql supabase/tests/02_permissions.test.sql
git commit -m "feat(db): add the prize catalogue and its permissions"
```

---

### Task 2: The ledger and the projection

**Files:**
- Create: `supabase/migrations/0026_inventory_ledger.sql`
- Modify: `supabase/tests/02_permissions.test.sql`

**Interfaces:**
- Consumes: both enums, `prizes_id_company_unique`, `companies_id_org_unique` (Task 1 and `0015`).
- Produces: tables `public.inventory_movements`, `public.inventory_balances`.

- [ ] **Step 1: Write the migration**

```sql
-- supabase/migrations/0026_inventory_ledger.sql

-- The ledger. Append-only: no updated_at and no deleted_at, because both would
-- be lies on a table that is never rewritten. A mistake is corrected by a new
-- movement, the way a bank statement is corrected by a reversal.
create table public.inventory_movements (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id),
  company_id      uuid not null,
  prize_id        uuid not null,
  movement_type   public.inventory_movement_type not null,
  quantity        integer not null check (quantity > 0),
  from_bucket     public.inventory_bucket,
  to_bucket       public.inventory_bucket,
  note            text,
  idempotency_key text,
  actor_id        uuid references auth.users (id),
  created_at      timestamptz not null default now(),

  constraint inventory_movements_company_org_fk
    foreign key (company_id, organization_id)
    references public.companies (id, organization_id),
  constraint inventory_movements_prize_company_fk
    foreign key (prize_id, company_id)
    references public.prizes (id, company_id),

  -- A movement must move something, somewhere.
  constraint inventory_movements_has_direction
    check (from_bucket is not null or to_bucket is not null),
  constraint inventory_movements_not_circular
    check (from_bucket is distinct from to_bucket),

  -- Reconciliation reads the buckets, not the type, so a pair that disagrees
  -- with its movement type would corrupt the projection AND its own check in the
  -- same direction — the divergence would never show up. Enumerating the legal
  -- pairs is long and worth it: it makes that class of defect unrepresentable
  -- rather than merely unlikely.
  constraint inventory_movements_legal_transition check (
       (movement_type in ('INITIAL_ENTRY', 'PURCHASE_ENTRY', 'MANUAL_ENTRY', 'ADJUSTMENT_POSITIVE')
          and from_bucket is null and to_bucket = 'available')
    or (movement_type in ('MANUAL_EXIT', 'ADJUSTMENT_NEGATIVE')
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
  )
);

comment on table public.inventory_movements is
  'Immutable stock ledger. No role holds UPDATE or DELETE on it — the immutability is a grant, not a convention.';
comment on column public.inventory_movements.quantity is
  'Always positive. Direction lives in from_bucket/to_bucket, so no query has to read a sign correctly.';
comment on column public.inventory_movements.idempotency_key is
  'Optional. A replay collides on the partial unique index below and returns the original movement instead of recording a second one.';

create unique index inventory_movements_idempotency_unique
  on public.inventory_movements (company_id, idempotency_key)
  where idempotency_key is not null;

create index inventory_movements_prize_idx
  on public.inventory_movements (prize_id, created_at desc);
create index inventory_movements_company_idx
  on public.inventory_movements (company_id, created_at desc);

-- The projection. Exists only because summing the ledger on every render would
-- be slow; it must be reconstructible from the ledger at any moment, and
-- reconcile_inventory (0028) is how we check that it still is.
create table public.inventory_balances (
  company_id      uuid not null,
  prize_id        uuid not null,
  organization_id uuid not null references public.organizations (id),

  available       integer not null default 0 check (available       >= 0),
  reserved        integer not null default 0 check (reserved        >= 0),
  linked          integer not null default 0 check (linked          >= 0),
  awaiting_pickup integer not null default 0 check (awaiting_pickup >= 0),
  pending_return  integer not null default 0 check (pending_return  >= 0),

  delivered       integer not null default 0 check (delivered       >= 0),
  written_off     integer not null default 0 check (written_off     >= 0),

  updated_at      timestamptz not null default now(),

  primary key (company_id, prize_id),
  constraint inventory_balances_company_org_fk
    foreign key (company_id, organization_id)
    references public.companies (id, organization_id),
  constraint inventory_balances_prize_company_fk
    foreign key (prize_id, company_id)
    references public.prizes (id, company_id)
);

comment on table public.inventory_balances is
  'Projection of the ledger per (Station, prize). Written only by apply_inventory_movement, inside the transaction that appends the movement.';
comment on column public.inventory_balances.delivered is
  'Cumulative, and OUTSIDE the physical total. physical = available + reserved + linked + awaiting_pickup + pending_return. Do not add this to it.';
comment on column public.inventory_balances.written_off is
  'Cumulative, and OUTSIDE the physical total. See delivered.';
```

- [ ] **Step 2: Append the pgTAP assertions**

```sql
-- Block 2: the constraints that make a wrong number unrepresentable.
select col_not_null('public', 'inventory_movements', 'quantity', 'a movement has a quantity');
select hasnt_column('public', 'inventory_movements', 'updated_at',
  'the ledger has no updated_at, because it is never updated');
select hasnt_column('public', 'inventory_movements', 'deleted_at',
  'the ledger has no deleted_at, because it is never deleted');

-- The bucket floor. Declaring it and having it bite are different claims.
select throws_ok(
  $$insert into public.inventory_balances (company_id, prize_id, organization_id, available)
    select c.id, p.id, c.organization_id, -1
    from public.companies c join public.prizes p on p.company_id = c.id limit 1$$,
  '23514',
  null,
  'a negative bucket is rejected by the check constraint'
);
```

Note: the `throws_ok` above needs a Station and a prize to exist. Seed them in the
test file immediately before it, inside the same transaction the file already rolls
back — follow the pattern `01_identity.test.sql` uses for its cross-Organization
probe. If no prize can be seeded without an `auth.users` row, seed one the same way
that file does.

- [ ] **Step 3: Run the database suite, then prove the transition constraint by hand**

Run: `npx supabase db reset && npx supabase test db`

Then confirm the legal-transition check bites, since it is the constraint protecting reconciliation from agreeing with a corrupt ledger. Insert a movement whose type and buckets disagree — a `RESERVATION` with `from_bucket = 'linked'` — and record the verbatim error in your report. If it succeeds, the enumeration is wrong.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/0026_inventory_ledger.sql supabase/tests/02_permissions.test.sql
git commit -m "feat(db): add the immutable stock ledger and its projection"
```

---

### Task 3: The movement engine and the catalogue RPCs

**Files:**
- Create: `supabase/migrations/0027_inventory_rpcs.sql`

**Interfaces:**
- Produces: private `public.apply_inventory_movement(...)`; public `create_prize_category`, `create_prize`, `update_prize`, `archive_prize`, `record_stock_entry`, `record_stock_exit`, `adjust_stock`, `reserve_stock`, `release_reservation`.

- [ ] **Step 1: Write the private routine**

```sql
-- supabase/migrations/0027_inventory_rpcs.sql

-- One place where the ledger mechanics live. The permission check deliberately
-- stays OUT of here and in each public function, so a reader looking for "who may
-- do this" finds it beside the operation rather than inside a shared helper.
--
-- This function holds EXECUTE for nobody. It is SECURITY INVOKER: it is only ever
-- called from inside a SECURITY DEFINER body, where it already runs with the
-- definer's privileges. Making it DEFINER too would let a future GRANT turn it
-- into an unchecked write path.
create or replace function public.apply_inventory_movement(
  p_company_id      uuid,
  p_prize_id        uuid,
  p_type            public.inventory_movement_type,
  p_quantity        integer,
  p_from            public.inventory_bucket,
  p_to              public.inventory_bucket,
  p_note            text,
  p_idempotency_key text
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
  if p_quantity is null or p_quantity <= 0 then
    raise exception 'quantity must be a positive whole number' using errcode = '22023';
  end if;

  -- The prize must be live and belong to this Station. The composite foreign key
  -- proves the Station; it cannot see deleted_at, because it references a
  -- non-partial constraint — a foreign key cannot reference a partial index.
  select organization_id into v_org
  from public.prizes
  where id = p_prize_id and company_id = p_company_id and deleted_at is null;

  if not found then
    raise exception 'prize not found in this station: %', p_prize_id using errcode = 'P0002';
  end if;

  -- Create the balance row if this is the prize's first movement, then lock it.
  -- ON CONFLICT DO NOTHING rather than a select-then-insert: two first movements
  -- racing would otherwise both see nothing and both insert.
  insert into public.inventory_balances (company_id, prize_id, organization_id)
  values (p_company_id, p_prize_id, v_org)
  on conflict (company_id, prize_id) do nothing;

  perform 1 from public.inventory_balances
   where company_id = p_company_id and prize_id = p_prize_id
     for update;

  -- Append first, so a replay is decided before anything is moved. ON CONFLICT
  -- on the idempotency index returns no row, which is how we know.
  insert into public.inventory_movements
    (organization_id, company_id, prize_id, movement_type, quantity,
     from_bucket, to_bucket, note, idempotency_key, actor_id)
  values
    (v_org, p_company_id, p_prize_id, p_type, p_quantity,
     p_from, p_to, nullif(trim(coalesce(p_note, '')), ''), p_idempotency_key, v_actor)
  on conflict (company_id, idempotency_key) where idempotency_key is not null
  do nothing
  returning id into v_id;

  if v_id is null then
    -- A replay. Return the original movement and touch nothing else: the balance
    -- already reflects it.
    select id into v_id
    from public.inventory_movements
    where company_id = p_company_id and idempotency_key = p_idempotency_key;

    if v_id is null then
      raise exception 'movement could not be recorded' using errcode = 'XX000';
    end if;
    return v_id;
  end if;

  -- Source sufficiency. The CHECK constraints would also refuse this, but they
  -- would refuse it with a constraint name; the caller deserves the number.
  if p_from is not null then
    execute format('select %I from public.inventory_balances where company_id = $1 and prize_id = $2', p_from)
      into v_current using p_company_id, p_prize_id;

    if v_current < p_quantity then
      raise exception 'only % unit(s) are in %, and % were requested', v_current, p_from, p_quantity
        using errcode = '23514';
    end if;

    execute format(
      'update public.inventory_balances set %I = %I - $1, updated_at = now() where company_id = $2 and prize_id = $3',
      p_from, p_from
    ) using p_quantity, p_company_id, p_prize_id;
  end if;

  if p_to is not null then
    execute format(
      'update public.inventory_balances set %I = %I + $1, updated_at = now() where company_id = $2 and prize_id = $3',
      p_to, p_to
    ) using p_quantity, p_company_id, p_prize_id;
  end if;

  insert into public.audit_logs
    (actor_id, action, target_table, target_id, organization_id, company_id, detail)
  values
    (v_actor, 'inventory_movement', 'inventory_movements', v_id, v_org, p_company_id,
     jsonb_build_object('prize_id', p_prize_id, 'type', p_type, 'quantity', p_quantity,
                        'from', p_from, 'to', p_to));

  return v_id;
end;
$$;

revoke execute on function public.apply_inventory_movement(uuid, uuid, public.inventory_movement_type, integer, public.inventory_bucket, public.inventory_bucket, text, text) from public;
```

> **Implementer note.** `format(%I)` with a bucket enum cast to text is dynamic SQL against a column name. It is safe here because `p_from`/`p_to` are enum-typed, so they cannot carry anything but a bucket name — Postgres rejects an invalid value before the function runs. Do not change those parameters to `text`; if you find yourself wanting to, stop and report rather than opening an injection path.

- [ ] **Step 2: Write the public movement RPCs**

Each follows the same shape: resolve the Organization from the Company, check its own permission with `has_permission`, then delegate. Write all five — `record_stock_entry`, `record_stock_exit`, `adjust_stock`, `reserve_stock`, `release_reservation`. The entry function restricts `p_type` to the three entry kinds and rejects anything else with `22023`.

`adjust_stock` is the one with real logic: it takes the **counted figure**, reads current `available` under the lock, and derives an `ADJUSTMENT_POSITIVE` or `ADJUSTMENT_NEGATIVE` of the difference. If the count equals the current figure it records nothing and returns null — an adjustment of zero is not an event. Its note is mandatory.

`record_stock_exit` and both reservation functions also take a mandatory note; `record_stock_entry` does not.

- [ ] **Step 3: Write the catalogue RPCs**

`create_prize_category`, `create_prize`, `update_prize` and `archive_prize`, each gated on `inventory.catalogue`.

`archive_prize` is the one with a rule:

```sql
  -- Refused while stock exists. Archiving it would strand the units: the balance
  -- row survives, no screen shows it, and reconciliation still counts it. Same
  -- shape as delete_role refusing a role in use.
  select available + reserved + linked + awaiting_pickup + pending_return
    into v_physical
  from public.inventory_balances
  where company_id = v_company and prize_id = p_prize_id;

  if coalesce(v_physical, 0) > 0 then
    raise exception 'this prize still has % unit(s) in stock; move them out first', v_physical
      using errcode = '23503';
  end if;
```

- [ ] **Step 4: Grants**

`revoke execute ... from public` and `grant execute ... to authenticated` for every public function, each with its full argument-type signature. Postgres matches by signature: a mismatch leaves a function ungrantable and the failure appears much later as a runtime permission error.

- [ ] **Step 5: Run the database suite**

Run: `npx supabase db reset && npx supabase test db`
Expected: green. These functions have no pgTAP coverage — their substance is a permission check under a real session, which Task 6 proves.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/0027_inventory_rpcs.sql
git commit -m "feat(db): add the inventory movement engine and catalogue RPCs"
```

---

### Task 4: Reconciliation

**Files:**
- Create: `supabase/migrations/0028_reconcile_inventory.sql`

**Interfaces:**
- Produces: `public.reconcile_inventory(p_company_id uuid) returns table (prize_id uuid, prize_name text, bucket text, stored integer, computed integer)`.

- [ ] **Step 1: Write the migration**

It recomputes each bucket from the ledger — for a bucket `b`, the sum of quantities where `to_bucket = b` minus the sum where `from_bucket = b` — and returns only the rows where the stored figure and the computed figure differ.

```sql
-- It reports; it does not repair. A projection that silently self-heals turns a
-- bug in a movement RPC into a number that is briefly wrong and then quietly
-- right, which is the hardest kind to find. If this returns rows, something is
-- broken and a person needs to know.
```

Gated on `inventory.view`. Read-only: it must contain no `insert`, `update` or `delete`, and the review will check that.

- [ ] **Step 2: Run the database suite**

Run: `npx supabase db reset && npx supabase test db`

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/0028_reconcile_inventory.sql
git commit -m "feat(db): add inventory reconciliation that reports rather than repairs"
```

---

### Task 5: RLS and grants

**Files:**
- Create: `supabase/migrations/0029_rls_inventory.sql`
- Modify: `supabase/tests/02_permissions.test.sql`

- [ ] **Step 1: Write the migration**

All four tables: `enable row level security`, `revoke all from anon, authenticated`, `grant select to authenticated`, a `select` policy gated on `has_permission('inventory.view', company_id)`, and `grant select to service_role`.

**No `insert`, `update` or `delete` grant to any role on any of the four**, including `service_role`. On `inventory_movements` and `inventory_balances` this is what makes immutability and single-writer real rather than promised.

- [ ] **Step 2: Assert it**

```sql
select is(relrowsecurity, true, 'RLS enabled on inventory_movements')
  from pg_class where oid = 'public.inventory_movements'::regclass;
-- …and the other three.

-- The ledger's immutability is a grant, not a comment.
select ok(not has_table_privilege('authenticated', 'public.inventory_movements', 'UPDATE'),
          'authenticated may not update the ledger');
select ok(not has_table_privilege('authenticated', 'public.inventory_movements', 'DELETE'),
          'authenticated may not delete from the ledger');
select ok(not has_table_privilege('service_role', 'public.inventory_movements', 'UPDATE'),
          'service_role may not update the ledger either');
select ok(not has_table_privilege('service_role', 'public.inventory_movements', 'DELETE'),
          'service_role may not delete from the ledger either');
select ok(not has_table_privilege('service_role', 'public.inventory_balances', 'UPDATE'),
          'service_role may not write the projection directly');
```

- [ ] **Step 3: Run the database suite and commit**

```bash
git add supabase/migrations/0029_rls_inventory.sql supabase/tests/02_permissions.test.sql
git commit -m "feat(db): enable RLS on the inventory tables and seal the ledger"
```

---

### Task 6: Isolation coverage under real JWTs

**Files:**
- Create: `tests/isolation/inventory.test.ts`
- Modify: `tests/isolation/harness.ts`

**Interfaces:**
- Produces: harness helpers `createPrizeAs(customer, name)` and `grantRoleWith(customer, label, codes[])` if the existing helpers do not already cover composing a role and attaching a member to a Station.

- [ ] **Step 1: Write the suite**

This is the block's proof. Every case runs under a real JWT, and **the actor is a non-owner delegate holding a composed role** except where the owner is explicitly the subject.

Cases:

1. A movement cannot drive a bucket below zero — reserve more than is available, expect the RPC's own message naming the available count, not a bare constraint error.
2. Each operation is refused without its permission and allowed with it. Six codes, six pairs. Include a delegate holding every code **except** `inventory.adjust`, and confirm adjustment alone is refused.
3. A replayed `idempotency_key` yields one movement and returns the same id. Assert the ledger row count for that prize, not just the returned value.
4. `inventory.entry` held in Station A does not act in Station B — the same shape Block 1c's headline test needed correcting for: the delegate must hold a live membership in B under a role granting nothing, so the refusal comes from permission resolution and not from the access gate.
5. Reconciliation reports nothing after a real sequence of movements, and reports the exact divergence after a balance is corrupted directly with the service client.
6. Archiving a prize with stock is refused; archiving one without stock succeeds.
7. `adjust_stock` with a count equal to the current figure records no movement.
8. The ledger cannot be updated or deleted with a real JWT, nor with the service client.

- [ ] **Step 2: Run it, then the whole suite**

Run: `npm run test:isolation -- inventory`, then `npm run test:isolation`
Expected: green. **A failure here is a real defect in Tasks 1–5, not a reason to adjust an assertion.**

- [ ] **Step 3: Commit**

```bash
git add tests/isolation
git commit -m "test: prove the inventory invariants under real JWTs"
```

---

### Task 7: Types, service layer and schemas

**Files:**
- Modify: `src/lib/supabase/database.types.ts` (generated)
- Create: `src/schemas/inventory.ts`, `src/services/inventory.ts`
- Test: `tests/unit/inventory-schema.test.ts`

- [ ] **Step 1: Regenerate the types and run the binding probe**

Run `npm run db:types`, then temporarily add `await supabase.from('no_such_table').select('*')` inside a server file and confirm `npm run typecheck` **FAILS** naming it. Remove it and confirm it passes. Block 1a recorded a version pairing where the generics landed wrong and `.from()` silently accepted any string.

- [ ] **Step 2: Write the schema, test-first**

`prizeFormSchema` and `movementFormSchema`. Cover, with a case each that would fail if the rule were deleted: quantity is a positive integer (reject 0, reject -1, reject 2.5); the mandatory notes are non-empty after trimming; `internal_code` is optional but bounded; the counted figure in an adjustment may be zero but not negative.

- [ ] **Step 3: Write the service**

`src/services/inventory.ts`, following `src/services/roles.ts`: `import 'server-only'`, reads through `createUserClient()`, writes through a token-bound client, and Postgres codes mapped to the project's error taxonomy — `23514` from a bucket floor is a `BusinessRuleError` carrying the database's own sentence (it names the available count and the screen needs it), `P0002` a `NotFoundError`, `42501` an `UnauthorizedError`, `23503` a `BusinessRuleError`, `22023` a `ValidationError`, anything else an `InternalError`.

**Surface every read's error.** Block 1c shipped three reads that discarded theirs; one of them rendered a form with every checkbox unchecked, and saving then wiped the record.

- [ ] **Step 4: Run lint, typecheck, unit; commit**

---

### Task 8: The inventory screens

**Files:**
- Create: `src/app/(app)/inventory/page.tsx`, `actions.ts`, and the components it needs
- Create: `src/app/(app)/inventory/[prizeId]/page.tsx`
- Modify: `src/lib/auth/shell.ts`, `src/components/layout/app-shell.tsx`

Follow `src/app/(app)/roles/` for the Server Component page plus Server Actions shape, and its treatment of typed service errors as sentences a person can act on.

The list shows every bucket per prize plus the physical total. The detail shows the balance broken out and the movement history newest first, with who and why — **the ledger is the feature here**, because "why does this say 47" is the question the screen exists to answer.

Add an `ICONS` entry following the existing convention: a single inline SVG path string on a 24×24 viewBox, stroked with `currentColor`, no fill.

**Then use the screens as a non-owner delegate**, not as the owner, and report what you saw step by step.

- [ ] Run `npm run lint && npm run typecheck && npm run build`; commit.

---

### Task 9: Movement forms and reconciliation

**Files:**
- Modify: `src/app/(app)/inventory/` — the forms and the reconciliation view

Each form gated on its own permission, each refusing in the database as well. The adjustment form asks for **the counted figure**, never a delta.

Reconciliation is a button and a result: either "no divergence" with the time checked, or the rows that disagree, each naming prize, bucket, stored and computed.

**A failed action must tell the user something.** Block 1c shipped an action that logged and swallowed, leaving a silent no-op, and another whose error banner could never clear because only an explicit redirect changes the address bar after a Server Action.

- [ ] Walk it as a delegate: register, add stock, reserve with a note, adjust to a wrong count and read the refusal, adjust to a right one, reconcile. Report each step.
- [ ] Run `npm run lint && npm run typecheck && npm run build`; commit.

---

### Task 10: The end-to-end journey

**Files:**
- Create: `tests/e2e/inventory-flow.spec.ts`

The owner composes a "Stock Keeper" role holding `inventory.view`, `inventory.catalogue`, `inventory.entry` and `inventory.reserve` — **not** `inventory.adjust` — and assigns it in one Station. The delegate then: registers a prize, adds 50 units, reserves 10 with a note, sees the movement history explain the numbers, and **finds no way to adjust**, because they do not hold it.

**The delegate drives every step.** The owner appears only to compose and assign the role.

Assert the inventory permissions appear in the role editor without that screen having been modified — that is the test of whether Block 1c's catalogue was built right.

- [ ] Run `npm run test:e2e` — the whole suite, not just this spec. Commit.

---

### Task 11: Full verification and the block report

**Files:**
- Create: `docs/block-2-report.md`

- [ ] **Step 1: Run every gate and capture the real output**

`npm run lint`, `npm run typecheck`, `npm test`, `npx supabase db reset && npx supabase test db`, `npm run test:isolation`, `npm run test:e2e`, and the `docker build` with both `NEXT_PUBLIC_*` build args.

- [ ] **Step 2: Prove the invariant tests still bite**

Two mutations, each reverted after:
1. Remove the source-sufficiency check from `apply_inventory_movement` and confirm the below-zero isolation test fails. If the `CHECK` constraint catches it instead, the test is passing at the wrong layer — say so and pin the message rather than the failure.
2. Make `reconcile_inventory` return no rows unconditionally and confirm the planted-divergence test fails.

Record which test caught each.

- [ ] **Step 3: Write the report**

Follow `docs/block-1c-report.md`: what was verified with verbatim output; defects found in the plan while executing it, stated plainly; deployment steps; the definition-of-done table from the spec's §14 with evidence per row; open items.

- [ ] **Step 4: Commit, push, open the pull request**

Title: `Block 2 — Inventory & prizes`.
