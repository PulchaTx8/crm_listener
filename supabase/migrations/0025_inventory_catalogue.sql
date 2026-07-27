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
