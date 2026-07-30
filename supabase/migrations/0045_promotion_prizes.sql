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
