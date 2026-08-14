begin;
select plan(9);

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

-- A second Station, and a movement that belongs to it, for assertion 9: a
-- reversal that reaches across Stations has to have something on the other
-- side to reach for.
insert into public.companies (id, organization_id, name, timezone) values
  ('00000000-0000-0000-0000-0000000023c2', '00000000-0000-0000-0000-0000000023f1',
   'Station 23 tabs B', 'America/Sao_Paulo');
insert into public.prizes (id, organization_id, company_id, name) values
  ('00000000-0000-0000-0000-0000000023d2', '00000000-0000-0000-0000-0000000023f1',
   '00000000-0000-0000-0000-0000000023c2', 'Caneca 23');
insert into public.inventory_movements
  (id, organization_id, company_id, prize_id, movement_type, quantity, from_bucket, to_bucket)
values
  ('00000000-0000-0000-0000-0000000023e2', '00000000-0000-0000-0000-0000000023f1',
   '00000000-0000-0000-0000-0000000023c2', '00000000-0000-0000-0000-0000000023d2',
   'INITIAL_ENTRY', 5, null, 'available');

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
--
-- Every literal in this UNION ALL is cast explicitly. Two SELECTs of bare
-- string literals resolve their shared column type to text (Postgres's rule
-- for a set operation over all-unknown inputs), and assigning that text into
-- inventory_movements' uuid/enum columns is refused with 42804 -- a real error,
-- just the wrong one, and one that would hide the 23505 this test is for.
select throws_ok($$
  insert into public.inventory_movements
    (organization_id, company_id, prize_id, movement_type, quantity, from_bucket, to_bucket,
     reverses_movement_id)
  select '00000000-0000-0000-0000-0000000023f1'::uuid, '00000000-0000-0000-0000-0000000023c1'::uuid,
         '00000000-0000-0000-0000-0000000023d1'::uuid, 'MANUAL_EXIT'::public.inventory_movement_type,
         10, 'available'::public.inventory_bucket, null::public.inventory_bucket, m.id
    from public.inventory_movements m
   where m.movement_type = 'BARTER_ENTRY'
   union all
  select '00000000-0000-0000-0000-0000000023f1'::uuid, '00000000-0000-0000-0000-0000000023c1'::uuid,
         '00000000-0000-0000-0000-0000000023d1'::uuid, 'MANUAL_EXIT'::public.inventory_movement_type,
         10, 'available'::public.inventory_bucket, null::public.inventory_bucket, m.id
    from public.inventory_movements m
   where m.movement_type = 'BARTER_ENTRY'
$$, '23505', null, 'a movement cannot be reversed twice');

-- 9: a reversal cannot point at a movement belonging to another Station.
-- inventory_movements_reversal_company_fk is the composite foreign key that
-- makes that row impossible to write, closing the one reference in 0193 that
-- used to be weaker than its siblings -- reserved_for_show_id already proved
-- the Station through its own composite FK to shows.
select throws_ok($$
  insert into public.inventory_movements
    (organization_id, company_id, prize_id, movement_type, quantity, from_bucket, to_bucket,
     reverses_movement_id)
  values
    ('00000000-0000-0000-0000-0000000023f1', '00000000-0000-0000-0000-0000000023c1',
     '00000000-0000-0000-0000-0000000023d1', 'MANUAL_EXIT', 1, 'available', null,
     '00000000-0000-0000-0000-0000000023e2')
$$, '23503', null, 'a reversal cannot point at a movement from another Station');

select * from finish();
rollback;
