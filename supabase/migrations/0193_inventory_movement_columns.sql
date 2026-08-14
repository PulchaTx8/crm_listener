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
  -- than three mechanisms that can drift. Left bare here -- no inline
  -- `references public.inventory_movements (id)` -- because a plain reference
  -- proves nothing about which Station the pointer lands in; the composite
  -- form below is what actually constrains it, and it needs
  -- inventory_movements_id_company_unique to exist first.
  add column reverses_movement_id uuid,

  -- What every other cross-table reference in this migration already leans
  -- on -- prizes, shows, promotions and companies all carry a composite
  -- unique key for exactly this reason (0025's own comments argue it at
  -- length) -- turned on this table itself, so a foreign key naming
  -- (reverses_movement_id, company_id) can pin both the row and its Station
  -- together rather than trusting company_id to agree by convention.
  add constraint inventory_movements_id_company_unique unique (id, company_id),

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

-- The composite foreign key reverses_movement_id needed, added as its own
-- statement -- not because Postgres requires it. A single ALTER TABLE clause
-- combining inventory_movements_id_company_unique above with this foreign key
-- was tested directly against a freshly reset database and succeeds; the
-- split is a clarity choice, not a technical necessity -- each statement
-- reads as one fact (first that (id, company_id) is unique, then that this
-- column trusts that uniqueness) rather than one statement asserting both at
-- once. Whatever RPC later writes a
-- reversal will copy company_id from the movement it points at rather than
-- accept one from its caller, so this constraint can never actually fire in
-- practice -- but that makes it defence, not a fix to a live bug: a reversal
-- that pointed across Stations would be a row no screen could explain and no
-- reconciliation could balance, and this constraint makes that row impossible
-- to write rather than merely unlikely, the same argument 0026 already made
-- for inventory_movements_legal_transition.
alter table public.inventory_movements
  add constraint inventory_movements_reversal_company_fk
    foreign key (reverses_movement_id, company_id)
    references public.inventory_movements (id, company_id);

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
--
-- Widened from the LIVE definition, not from 0026's text: 0083 added the
-- DELIVERY_CANCEL pair and 0092 added RETURN_PENDING_CANCEL after 0026 shipped,
-- and recreating the constraint from the original migration would silently
-- drop both. Checked with pg_get_constraintdef against a freshly reset local
-- database before writing this file.
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
    or (movement_type = 'DELIVERY_CANCEL'
          and from_bucket = 'delivered' and to_bucket = 'awaiting_pickup')
    or (movement_type = 'RETURN_PENDING'
          and from_bucket = 'awaiting_pickup' and to_bucket = 'pending_return')
    or (movement_type = 'RETURN_TO_STOCK'
          and from_bucket = 'pending_return' and to_bucket = 'available')
    or (movement_type = 'WRITE_OFF'
          and from_bucket in ('pending_return', 'awaiting_pickup') and to_bucket = 'written_off')
    or (movement_type = 'RETURN_PENDING_CANCEL'
          and from_bucket = 'pending_return' and to_bucket = 'awaiting_pickup')
  );
