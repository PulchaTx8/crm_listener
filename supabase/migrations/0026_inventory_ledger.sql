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
