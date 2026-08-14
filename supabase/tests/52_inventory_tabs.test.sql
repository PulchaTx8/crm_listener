begin;
select plan(18);

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

-- ---------------------------------------------------------------------------
-- Block 23, Task 2: the widened doors. A caller holding inventory.entry,
-- inventory.exit and inventory.reserve — a real role, role_permissions grant,
-- auth.users row and company_membership, never a platform_admin bypass — the
-- same fixture shape 13_pickup_reads.test.sql's own family uses, so
-- has_permission's own predicate is exercised the way a real caller reaches
-- it rather than bypassed by running as the unauthenticated pgTAP session.

insert into public.roles (id, organization_id, name) values
  ('00000000-0000-0000-0000-000000002341', '00000000-0000-0000-0000-0000000023f1', 'Inventory operator 23');
-- inventory.view too -- not to exercise any door, but because
-- inventory_movements_select_inventory_view (0029) gates SELECT on it, and
-- without it every assertion below that reads the movement back through this
-- role's own connection (rather than through the door's SECURITY DEFINER
-- body, which is not subject to RLS) would find nothing: the row would exist
-- and be correct, and this suite would report it as absent regardless.
insert into public.role_permissions (role_id, permission_code) values
  ('00000000-0000-0000-0000-000000002341', 'inventory.entry'),
  ('00000000-0000-0000-0000-000000002341', 'inventory.exit'),
  ('00000000-0000-0000-0000-000000002341', 'inventory.reserve'),
  ('00000000-0000-0000-0000-000000002341', 'inventory.view');
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-000000002342', 'inventory-doors-23@example.test');
insert into public.company_memberships (user_id, company_id, organization_id, role_id) values
  ('00000000-0000-0000-0000-000000002342', '00000000-0000-0000-0000-0000000023c1',
   '00000000-0000-0000-0000-0000000023f1', '00000000-0000-0000-0000-000000002341');

set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-000000002342", "role": "authenticated"}';

-- 10: record_stock_entry with PURCHASE_ENTRY and an invoice stores all three
-- invoice columns. A door that never threads p_invoice_number/p_unit_amount/
-- p_total_amount through to apply_inventory_movement — or threads them onto
-- the wrong positional slot — leaves one or more of the three null here.
create temporary table t23_purchase as
select public.record_stock_entry(
  '00000000-0000-0000-0000-0000000023c1', '00000000-0000-0000-0000-0000000023d1',
  'PURCHASE_ENTRY', 50, 'opening purchase', null,
  'NF-2301', 2.50, 125.00) as movement_id;

select ok(
  (select invoice_number = 'NF-2301' and unit_amount = 2.50 and total_amount = 125.00
     from public.inventory_movements where id = (select movement_id from t23_purchase)),
  'record_stock_entry with PURCHASE_ENTRY and an invoice stores all three invoice columns'
);

-- 11: the same call with BARTER_ENTRY stores the type as barter, not
-- purchase. A door that ignores p_type, or that refuses BARTER_ENTRY because
-- its own allow-list was never widened past 0027's original three, fails
-- this — either the type comes back wrong or the call throws.
create temporary table t23_barter as
select public.record_stock_entry(
  '00000000-0000-0000-0000-0000000023c1', '00000000-0000-0000-0000-0000000023d1',
  'BARTER_ENTRY', 20, 'traded stock', null,
  'NF-2302', 0, 0) as movement_id;

select is(
  (select movement_type::text from public.inventory_movements where id = (select movement_id from t23_barter)),
  'BARTER_ENTRY',
  'record_stock_entry with BARTER_ENTRY stores the type as barter, distinguishable from a purchase in a later sum'
);

-- 12: record_stock_exit with TRANSFER_EXIT writes that type, not the door's
-- old hardcoded MANUAL_EXIT. A door that still ignores its new p_type
-- parameter (or defaults it away silently) writes MANUAL_EXIT regardless of
-- what the caller asked for, and this assertion catches exactly that.
create temporary table t23_transfer as
select public.record_stock_exit(
  '00000000-0000-0000-0000-0000000023c1', '00000000-0000-0000-0000-0000000023d1',
  5, 'sent to another station', null, 'TRANSFER_EXIT') as movement_id;

select is(
  (select movement_type::text from public.inventory_movements where id = (select movement_id from t23_transfer)),
  'TRANSFER_EXIT',
  'record_stock_exit with TRANSFER_EXIT writes that type, not MANUAL_EXIT'
);

-- 13: reserve_stock with a programme stores reserved_for_show_id. A door
-- that drops p_show_id on the floor leaves this column null here too, the
-- same failure case 14 checks from the other direction.
create temporary table t23_reservation_show as
select public.reserve_stock(
  '00000000-0000-0000-0000-0000000023c1', '00000000-0000-0000-0000-0000000023d1',
  10, 'held for the afternoon show', null,
  '00000000-0000-0000-0000-0000000023aa') as movement_id;

select is(
  (select reserved_for_show_id from public.inventory_movements where id = (select movement_id from t23_reservation_show)),
  '00000000-0000-0000-0000-0000000023aa'::uuid,
  'reserve_stock with a programme stores reserved_for_show_id'
);

-- 14: reserve_stock without one stores null — an anonymous hold is not a
-- programme hold with a missing name. A door that defaulted to some other
-- show, or that always wrote the last show_id it ever saw (a variable-reuse
-- bug), would fail this precisely because case 13 ran first.
--
-- The call is captured into a temporary table in its own statement, the same
-- shape every other case in this block uses, rather than nested inline inside
-- the assertion's own WHERE clause: a volatile, row-inserting function nested
-- that way is hoisted into an InitPlan evaluated against the snapshot the
-- outer SELECT already holds, so the row it just inserted is invisible to
-- that same SELECT — reproduced directly against this database (a working
-- two-statement call found the row; the identical call nested inline found
-- none). Not a defect in reserve_stock — a Postgres same-statement MVCC
-- visibility gap this suite avoids by never relying on it.
create temporary table t23_reservation_anon as
select public.reserve_stock(
  '00000000-0000-0000-0000-0000000023c1', '00000000-0000-0000-0000-0000000023d1',
  5, 'anonymous hold', null) as movement_id;

select ok(
  (select reserved_for_show_id is null
     from public.inventory_movements where id = (select movement_id from t23_reservation_anon)),
  'reserve_stock without a programme stores reserved_for_show_id null'
);

-- 15: release_reservation naming a reservation stores reverses_movement_id
-- pointing at it. A door that still ignores p_reservation_id releases the
-- stock but leaves no trace of which reservation shrank, and this column
-- comes back null instead of matching case 13's own movement id.
create temporary table t23_release_1 as
select public.release_reservation(
  '00000000-0000-0000-0000-0000000023c1', '00000000-0000-0000-0000-0000000023d1',
  4, 'partial release', null,
  (select movement_id from t23_reservation_show)) as movement_id;

select is(
  (select reverses_movement_id from public.inventory_movements where id = (select movement_id from t23_release_1)),
  (select movement_id from t23_reservation_show),
  'release_reservation naming a reservation stores reverses_movement_id pointing at it'
);

-- 16: releasing more than the reservation has left is refused with 22023.
-- Case 13 reserved 10, case 15 already released 4, so 6 remain; asking for 7
-- must be refused. A door with no arithmetic at all (or one that checks the
-- reservation's original quantity instead of what remains after case 15)
-- would let this succeed instead of throwing.
select throws_ok($$
  select public.release_reservation(
    '00000000-0000-0000-0000-0000000023c1', '00000000-0000-0000-0000-0000000023d1',
    7, 'too much', null,
    (select movement_id from t23_reservation_show))
$$, '22023', 'only 6 unit(s) remain on this reservation, and 7 were requested',
  'releasing more than a reservation has left is refused, naming the remainder');

-- 17: a second release_reservation on the same reservation, within what
-- remains (exactly the 6 units left after case 15, and unaffected by case
-- 16's refusal), succeeds. Releases are instalments, and
-- inventory_movements_reversal_unique (0193) deliberately excludes
-- RESERVATION_RELEASE from the one-reversal-per-movement rule so two releases
-- pointing at one reservation do not collide. A door that treated a release
-- like any other reversal, or an index that forgot that exclusion, would
-- refuse this with 23505 instead of succeeding.
select lives_ok($$
  select public.release_reservation(
    '00000000-0000-0000-0000-0000000023c1', '00000000-0000-0000-0000-0000000023d1',
    6, 'final release', null,
    (select movement_id from t23_reservation_show))
$$, 'a second release on the same reservation, within what remains, succeeds');

-- 18: a retried release_reservation carrying the same idempotency key returns
-- the original movement id rather than raising -- the replay hole from fix
-- round 1. A door whose arithmetic runs before the replay is resolved counts
-- the first attempt's own release in v_released and refuses the identical
-- retry with 22023, naming a remainder that is a lie about what already
-- happened. Uses t23_reservation_anon (case 14's anonymous hold of 5, never
-- released before this point) rather than t23_reservation_show, which case
-- 17 already exhausted -- this assertion needs a reservation with room left,
-- not one at its own remainder of zero.
create temporary table t23_release_replay_1 as
select public.release_reservation(
  '00000000-0000-0000-0000-0000000023c1', '00000000-0000-0000-0000-0000000023d1',
  3, 'replay probe', 'BLOCK23-RELEASE-REPLAY-1',
  (select movement_id from t23_reservation_anon)) as movement_id;

select is(
  (select public.release_reservation(
    '00000000-0000-0000-0000-0000000023c1', '00000000-0000-0000-0000-0000000023d1',
    3, 'replay probe', 'BLOCK23-RELEASE-REPLAY-1',
    (select movement_id from t23_reservation_anon))),
  (select movement_id from t23_release_replay_1),
  'a retried release_reservation with the same idempotency key returns the original movement id, not a 22023 refusal'
);

reset role;

select * from finish();
rollback;
