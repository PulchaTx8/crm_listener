-- Block 6b, Task 1: the history, the receipt columns, and who may do what.
--
-- Block 6a ended at the moment a winner exists. This block is everything an
-- operator does deliberately from there. What the clock does is 6c.

-- The composite key the history hangs from: the same one-line addition prizes
-- (0025:77), promotions (0040:177) and participations/promotion_prizes (0075)
-- already carry, and for the same reason -- the pair (id, company_id) unique on
-- a parent is what lets a child prove the Station in a single constraint rather
-- than a trigger.
alter table public.winners
  add constraint winners_id_company_unique unique (id, company_id);

-- ---------------------------------------------------------------------------
-- The receipt, on the winner it belongs to.

alter table public.winners
  add column receipt_path        text,
  add column receipt_uploaded_at timestamptz,
  add column receipt_erased_at   timestamptz,
  add constraint winners_receipt_shape check (
    receipt_erased_at is null or receipt_path is null
  );

comment on column public.winners.receipt_path is
  'Where the receipt lives in the private delivery-receipts bucket. Null means there is none -- either one was never attached, or it was erased, and receipt_erased_at is what tells those apart. ONE SLOT: attach_delivery_receipt (0085) refuses a second, and cancelling a delivery KEEPS this one, because clearing it would delete a photograph of a real handover because somebody corrected a record. The only thing that ever clears it is erasure (0086).';
comment on column public.winners.receipt_erased_at is
  'When anonymize_member removed the receipt. Kept so that "never had one" and "had one, and it is gone" are different facts on the screen -- the difference between a gap and an erasure.';

-- ---------------------------------------------------------------------------
-- One row per transition. The ONLY writer is apply_winner_transition (0083).

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
  -- happen. Handing a prize to the person who won it needs no justification,
  -- and demanding one would teach operators to type a full stop.
  constraint winner_status_history_reason_shape check (
    to_status = 'DELIVERED' or length(btrim(coalesce(reason, ''))) > 0
  )
);

create index winner_status_history_winner_idx
  on public.winner_status_history (winner_id, changed_at desc);

comment on table public.winner_status_history is
  'Every change of a winner''s status, with who made it and why. Written ONLY by apply_winner_transition (0083) -- the single-writer discipline apply_inventory_movement (0027) already holds for the ledger, chosen over a trigger on winners because a trigger cannot carry a reason or an actor without a session variable, and those two are most of what this table is for. Carries no personal data: ids and statuses.';

alter table public.winner_status_history enable row level security;

-- Reading a winner's history is reading a promotion, the same gate the draw's
-- own four tables carry (0075).
create policy winner_status_history_select_by_promotion_view
  on public.winner_status_history for select to authenticated
  using (public.has_permission('promotions.view', company_id));

revoke all on public.winner_status_history from anon, authenticated;
revoke truncate on public.winner_status_history from service_role;
grant select on public.winner_status_history to authenticated;
grant select, insert on public.winner_status_history to service_role;

-- ---------------------------------------------------------------------------
-- Four codes, and the two separations each has a precedent for in this
-- codebase: 6a separated draws.cancel from draws.execute because undoing is not
-- doing, and Block 2 separated inventory.exit from inventory.entry because
-- destroying stock is not adding it. Writing a prize off destroys value;
-- returning it to stock does not.

insert into public.permissions
  (code, description, introduced_by_block, module, label, scope, display_order)
values
  ('winners.deliver',        'Record that a prize was handed over',       '6b', 'promotions', 'Deliver a prize',         'company', 90),
  ('winners.deliver_cancel', 'Undo a delivery recorded by mistake',       '6b', 'promotions', 'Undo a delivery',         'company', 100),
  ('winners.return',         'Return an uncollected prize to stock',      '6b', 'promotions', 'Return a prize to stock', 'company', 110),
  ('winners.write_off',      'Write off a prize that will not come back', '6b', 'promotions', 'Write off a prize',       'company', 120);
