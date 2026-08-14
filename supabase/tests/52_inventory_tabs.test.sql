begin;
select plan(34);

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

-- ---------------------------------------------------------------------------
-- Block 23, Task 3's fixtures, seeded HERE rather than beside the assertions
-- that use them (19-27, at the foot of this file). Everything below `set local
-- role authenticated` runs as a role holding no INSERT grant on any of these
-- tables — 0029 revokes every write on the inventory tables from every role
-- including service_role, and 0044/0046 do the same for promotions and
-- promotion_prizes — so a direct insert down there is refused with 42501
-- before it can seed anything.

-- A second prize with a ledger of its own. Assertions 22 and 23 need one
-- bucket at an exact figure (10 in, 6 out, so 4 available), and the eighteen
-- movements above have already moved Camiseta 23's.
insert into public.prizes (id, organization_id, company_id, name) values
  ('00000000-0000-0000-0000-0000000023d3', '00000000-0000-0000-0000-0000000023f1',
   '00000000-0000-0000-0000-0000000023c1', 'Bone 23');

-- A draw and a promotion link, for assertions 24 and 25. Written directly
-- rather than through their own doors: reaching a real DRAW means a promotion
-- window, a participation and a winner, and what those two assertions test is
-- what reverse_movement REFUSES, not how the row came to exist. The promotion
-- and the link above them exist only because
-- inventory_movements_promotion_reference (0045, widened in 0077) requires
-- both of these movement types to name a promotion link.
insert into public.promotions (id, organization_id, company_id, name, starts_at, ends_at) values
  ('00000000-0000-0000-0000-0000000023ba', '00000000-0000-0000-0000-0000000023f1',
   '00000000-0000-0000-0000-0000000023c1', 'Promo 23 tabs', '2026-08-01Z', '2026-08-31Z');
insert into public.promotion_prizes
  (id, promotion_id, prize_id, organization_id, company_id) values
  ('00000000-0000-0000-0000-0000000023bb', '00000000-0000-0000-0000-0000000023ba',
   '00000000-0000-0000-0000-0000000023d1', '00000000-0000-0000-0000-0000000023f1',
   '00000000-0000-0000-0000-0000000023c1');
insert into public.inventory_movements
  (id, organization_id, company_id, prize_id, movement_type, quantity,
   from_bucket, to_bucket, promotion_prize_id)
values
  ('00000000-0000-0000-0000-0000000023e3', '00000000-0000-0000-0000-0000000023f1',
   '00000000-0000-0000-0000-0000000023c1', '00000000-0000-0000-0000-0000000023d1',
   'DRAW', 1, 'linked', 'awaiting_pickup', '00000000-0000-0000-0000-0000000023bb'),
  ('00000000-0000-0000-0000-0000000023e4', '00000000-0000-0000-0000-0000000023f1',
   '00000000-0000-0000-0000-0000000023c1', '00000000-0000-0000-0000-0000000023d1',
   'PROMOTION_LINK', 1, 'available', 'linked', '00000000-0000-0000-0000-0000000023bb');
-- ---------------------------------------------------------------------------

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

-- ---------------------------------------------------------------------------
-- Block 23, Task 3: reverse_movement, the one door behind every Arquivar
-- button. These nine are the assertions that matter most in the block: a
-- wrong reverse_movement does not fail loudly, it corrupts a balance quietly.

-- 19: an entry reversed once returns the available balance to what it was
-- BEFORE the entry — the whole of design D1 in one number. The figure is
-- captured first rather than hard-coded, because it is the sum of eighteen
-- earlier assertions and a hard-coded 63 would go red for the wrong reason
-- the first time anybody edits one of them.
--
-- A door that mirrors an entry with another entry leaves this at before + 20;
-- one that never reaches apply_inventory_movement at all leaves it at
-- before + 10; one that reverses the wrong quantity leaves it somewhere else
-- again. Each scores `not ok`.
create temporary table t23_available_before as
select available from public.inventory_balances
 where company_id = '00000000-0000-0000-0000-0000000023c1'
   and prize_id = '00000000-0000-0000-0000-0000000023d1';

create temporary table t23_reversible_entry as
select public.record_stock_entry(
  '00000000-0000-0000-0000-0000000023c1', '00000000-0000-0000-0000-0000000023d1',
  'PURCHASE_ENTRY', 10, 'entry that will be archived', null,
  'NF-2304', 4.00, 40.00) as movement_id;

create temporary table t23_entry_reversal as
select public.reverse_movement(
  (select movement_id from t23_reversible_entry),
  'archived by the operator') as movement_id;

select is(
  (select available from public.inventory_balances
    where company_id = '00000000-0000-0000-0000-0000000023c1'
      and prize_id = '00000000-0000-0000-0000-0000000023d1'),
  (select available from t23_available_before),
  'an entry reversed once returns the available balance to what it was before the entry');

-- 20: the reversal row itself. It is a MANUAL_EXIT of the same quantity
-- naming the entry, and it carries NO invoice of its own —
-- inventory_movements_invoice_reference (0193) permits the trio on the four
-- entry types alone, so a reversal that copied it would not be a wrong row,
-- it would be an impossible one (23514), and the pair is already joined by
-- reverses_movement_id, which is what 0196's read follows.
--
-- BE CLEAR ABOUT WHICH HALF OF THIS ASSERTION CAN ACTUALLY FAIL. The three
-- invoice pins cannot: the row is asserted MANUAL_EXIT two lines above, and
-- the constraint makes those columns unwritable on that type, so a door that
-- started copying the invoice would abort this whole FILE back at the
-- reversal, not turn this assertion red. The pins are a statement of intent,
-- and the CONSTRAINT is the guarantee — so relaxing
-- inventory_movements_invoice_reference on the belief that this test covers
-- the behaviour would remove the only thing that does.
--
-- What can fail here is the rest of it. A door that drops p_reverses leaves
-- reverses_movement_id null; one that picks the wrong mirror direction writes
-- MANUAL_ENTRY; one that reverses the wrong quantity writes something other
-- than 10. Each scores `not ok`.
select ok(
  (select r.reverses_movement_id = (select movement_id from t23_reversible_entry)
      and r.movement_type = 'MANUAL_EXIT'
      and r.quantity = 10
      and r.invoice_number is null
      and r.unit_amount is null
      and r.total_amount is null
     from public.inventory_movements r
    where r.id = (select movement_id from t23_entry_reversal)),
  'the reversal of an entry is a manual exit of the same quantity naming it, carrying no invoice of its own');

-- 21: one entry is reversed once. The unique index (0193) is the backstop;
-- this door owes the operator a sentence instead of a constraint name. A door
-- with no check of its own collides on the index and raises 23505; a door
-- reaching a database whose index was dropped raises nothing at all. Either
-- way throws_ok fails.
select throws_ok($$
  select public.reverse_movement(
    (select movement_id from t23_reversible_entry), 'archived twice')
$$, '22023', 'this movement has already been reversed',
  'the same entry cannot be reversed a second time');

-- 22: the refusal an operator will actually meet. Ten in, six out, four left
-- — reversing the entry of ten would drive available to minus six.
-- apply_inventory_movement would refuse it too, with 23514 and a message
-- about buckets; this door refuses it first, with a business code and the
-- number that is in the way.
--
-- A door with no pre-check of its own scores `not ok` on BOTH halves: wrong
-- errcode (23514) and wrong message. A door with no check anywhere drives the
-- bucket negative and dies on inventory_balances' own CHECK — 23514 again.
create temporary table t23_short_entry as
select public.record_stock_entry(
  '00000000-0000-0000-0000-0000000023c1', '00000000-0000-0000-0000-0000000023d3',
  'MANUAL_ENTRY', 10, 'ten in', null) as movement_id;

create temporary table t23_short_exit as
select public.record_stock_exit(
  '00000000-0000-0000-0000-0000000023c1', '00000000-0000-0000-0000-0000000023d3',
  6, 'six out', null) as movement_id;

select throws_ok($$
  select public.reverse_movement(
    (select movement_id from t23_short_entry), 'archive what is no longer here')
$$, '22023', 'only 4 unit(s) are available, and 10 are needed to reverse this entry',
  'reversing an entry whose stock has since left is refused, naming the shortfall');

-- 23: the other direction. Reversing the exit of six puts six units back, as
-- a MANUAL_ENTRY naming the exit — available goes 4 back to 10. A door that
-- mirrors an exit with another exit would try to take six more out of four
-- and raise; a door that ignores direction entirely leaves the balance at 4.
create temporary table t23_exit_reversal as
select public.reverse_movement(
  (select movement_id from t23_short_exit), 'the transfer was cancelled') as movement_id;

select ok(
  (select b.available = 10
     from public.inventory_balances b
    where b.company_id = '00000000-0000-0000-0000-0000000023c1'
      and b.prize_id = '00000000-0000-0000-0000-0000000023d3')
  and (select r.movement_type = 'MANUAL_ENTRY'
          and r.quantity = 6
          and r.reverses_movement_id = (select movement_id from t23_short_exit)
         from public.inventory_movements r
        where r.id = (select movement_id from t23_exit_reversal)),
  'reversing an exit puts the stock back, as a manual entry naming the exit');

-- 24 and 25: this door is not a general-purpose eraser. A draw and a
-- promotion link are each undone by their own screen's own door, with rules
-- this one does not know.
--
-- Both are worth more than they look. A door with no type gate does not
-- refuse these and does not fail on them either: a DRAW's to_bucket is
-- awaiting_pickup and a PROMOTION_LINK's is linked, so a mirror derived from
-- "not available" writes a MANUAL_ENTRY INTO available — inventing stock out
-- of units that are already committed elsewhere, and passing every constraint
-- on the way. throws_ok is what catches that: the call would simply succeed.
select throws_ok($$
  select public.reverse_movement('00000000-0000-0000-0000-0000000023e3', 'not this door')
$$, '22023', 'only a stock entry or a stock exit can be reversed here',
  'a draw cannot be reversed here');

select throws_ok($$
  select public.reverse_movement('00000000-0000-0000-0000-0000000023e4', 'not this door')
$$, '22023', 'only a stock entry or a stock exit can be reversed here',
  'a promotion link cannot be reversed here');

-- 26: a reversal must say why. record_stock_exit (0194:375-377), reserve_stock
-- and release_reservation (0194:529-531) all refuse a blank note with 22023,
-- and a reversal is the row in the Saidas tab a reader most wants explained —
-- without this it would be the one movement the history can show with no
-- reason at all.
--
-- Asserted against an entry that is otherwise perfectly reversible: recorded
-- immediately above, with stock behind it and nothing pointing at it, so the
-- refusal below can only be the note. A door that never checks writes the
-- reversal and returns an id instead of raising; a door that checks only
-- `p_note is null` while its siblings also trim would still pass this one, so
-- the migration keeps the siblings' nullif(trim(...)) shape rather than a bare
-- null test.
create temporary table t23_unexplained_entry as
select public.record_stock_entry(
  '00000000-0000-0000-0000-0000000023c1', '00000000-0000-0000-0000-0000000023d3',
  'MANUAL_ENTRY', 2, 'two more in', null) as movement_id;

select throws_ok($$
  select public.reverse_movement(
    (select movement_id from t23_unexplained_entry), null::text)
$$, '22023', 'a note is required to reverse a movement',
  'a reversal must say why: a blank note is refused, as it is on every other door that moves stock out');

reset role;

-- 27: exactly one audit row per reversal, naming the movement that was
-- archived. Read as the superuser pgTAP connects as, deliberately: audit_logs'
-- only select policy (0006_rls_policies.sql) is platform-admin-only and this
-- actor is not one, so under `authenticated` this count reads 0 whether or not
-- the row was written — the precedent is 15_music_rpcs.test.sql:109-115.
--
-- Counted on action + target_id rather than on the whole table because
-- apply_inventory_movement writes its own 'inventory_movement' row for the
-- mirror movement; the two are different facts and both belong there. A door
-- that writes no audit row of its own scores 0; one that names the reversal
-- instead of the original in target_id also scores 0; one that writes the row
-- more than once scores 2.
select is(
  (select count(*)::int from public.audit_logs
    where action = 'reverse_movement'
      and target_id = (select movement_id from t23_reversible_entry)),
  1, 'reversing writes exactly one audit row, naming the movement that was archived');

-- ---------------------------------------------------------------------------
-- Block 23, Task 4: list_movements widened. 28-34, re-entering the same
-- authenticated actor `reset role` above stepped out of -- list_movements is
-- SECURITY DEFINER and raises 42501 with no auth.uid() to resolve
-- has_permission against, so the audit-log read's superuser connection
-- cannot be reused for these.
--
-- Every call below passes p_limit => 500 explicitly (fix round 1, minor):
-- the default is 26, and this file has by now written more than that many
-- movements for company 23c1 across all three prizes -- omitting it would
-- couple every assertion's pass/fail to how many cases precede it in the
-- file, rather than to what each assertion actually claims to test.

set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-000000002342", "role": "authenticated"}';

-- 28: the invoice trio, projected rather than dropped. t23_purchase
-- (assertion 10) is a PURCHASE_ENTRY carrying NF-2301/2.50/125.00 on the
-- table itself; this is the first assertion checking that list_movements'
-- SELECT list actually names those three columns rather than silently
-- leaving them off the RETURNS TABLE the way a copy-paste from 0096 would.
select ok(
  (select invoice_number = 'NF-2301' and unit_amount = 2.50 and total_amount = 125.00
     from public.list_movements(p_company_id => '00000000-0000-0000-0000-0000000023c1',
                                 p_prize_id   => '00000000-0000-0000-0000-0000000023d1',
                                 p_limit      => 500)
    where movement_id = (select movement_id from t23_purchase)),
  'list_movements returns invoice_number, unit_amount and total_amount on an entry that has them');

-- 29: the ORIGINAL of a reversed pair reports a non-null reversed_at and the
-- reversal's own id. t23_reversible_entry (assertion 19) was reversed once,
-- by t23_entry_reversal (assertion 20), and inventory_movements_reversal_
-- unique (0193) guarantees there is exactly one such row for the lateral to
-- find. A read with no lateral leaves both columns null here; one that joins
-- the opposite direction, or that forgets the RESERVATION_RELEASE exclusion
-- the unique index itself carries, finds nothing or the wrong row.
select ok(
  (select reversed_at is not null
      and reversal_id = (select movement_id from t23_entry_reversal)
     from public.list_movements(p_company_id => '00000000-0000-0000-0000-0000000023c1',
                                 p_prize_id   => '00000000-0000-0000-0000-0000000023d1',
                                 p_limit      => 500)
    where movement_id = (select movement_id from t23_reversible_entry)),
  'a reversed entry reports a non-null reversed_at and the reversal''s own id');

-- 30: the REVERSAL half of the same pair reports reverses_movement_id
-- naming the entry it undoes. Stored, not derived (0193) -- this is the
-- assertion that catches a SELECT list that carries every other column
-- forward but forgets this one.
select is(
  (select reverses_movement_id
     from public.list_movements(p_company_id => '00000000-0000-0000-0000-0000000023c1',
                                 p_prize_id   => '00000000-0000-0000-0000-0000000023d1',
                                 p_limit      => 500)
    where movement_id = (select movement_id from t23_entry_reversal)),
  (select movement_id from t23_reversible_entry),
  'the reversal reports reverses_movement_id naming the entry it undoes');

-- 31: remaining_quantity on a reservation, asserted AFTER A PARTIAL RELEASE
-- -- the exact case the brief calls out, because it is the one a wrong
-- implementation cannot pass by accident. t23_reservation_anon (case 14)
-- reserved 5 units; case 18's replay probe released 3 of them exactly once
-- (the SECOND call is a same-idempotency-key replay that returns the first
-- movement rather than writing a second one -- fix round 1's own subject),
-- leaving 2. A read that returns the raw stored quantity (5) instead of the
-- derived remainder scores a DIFFERENT number here, not merely a null --
-- t23_reservation_show (cases 13/15/17) is deliberately NOT used for this:
-- it is fully exhausted by the time this runs (10 reserved, 4 then 6
-- released), and 0 remaining would not discriminate "raw quantity" (10) from
-- "some other wrong arithmetic" as sharply as 2 does against 5.
select is(
  (select remaining_quantity
     from public.list_movements(p_company_id => '00000000-0000-0000-0000-0000000023c1',
                                 p_prize_id   => '00000000-0000-0000-0000-0000000023d1',
                                 p_limit      => 500)
    where movement_id = (select movement_id from t23_reservation_anon)),
  2,
  'a reservation reports remaining_quantity as its own quantity minus the releases pointing at it, after a partial release');

-- 32: show_name on a reservation held for a programme. t23_reservation_show
-- (case 13) named Programa da Tarde (00...23aa) -- unaffected by how much of
-- it has since been released, which is assertion 31's concern, not this
-- one's.
select is(
  (select show_name
     from public.list_movements(p_company_id => '00000000-0000-0000-0000-0000000023c1',
                                 p_prize_id   => '00000000-0000-0000-0000-0000000023d1',
                                 p_limit      => 500)
    where movement_id = (select movement_id from t23_reservation_show)),
  'Programa da Tarde',
  'a reservation held for a programme reports the programme''s show_name');

-- 33: the movement-type filter, BOTH directions (fix round 1, I5: the
-- original version of this assertion only checked the negative direction --
-- that no wrong-kind row survives the filter -- which is trivially true of
-- an EMPTY result too, so a p_types bug that matched nothing at all would
-- have passed it silently). p_types naming RESERVATION alone must return at
-- least one row (positive: t23_reservation_anon and t23_reservation_show
-- are both RESERVATION rows on this prize) AND every row it returns must
-- actually be RESERVATION (negative, excluding BARTER_ENTRY, TRANSFER_EXIT,
-- MANUAL_ENTRY, MANUAL_EXIT and RESERVATION_RELEASE, all of which this
-- prize has accumulated by now). A read that ignores p_types entirely
-- fails the negative half; one where the filter is wired to always exclude
-- everything (a type mismatch, a broken cast) fails the new positive half.
select ok(
  (select count(*) from public.list_movements(
      p_company_id => '00000000-0000-0000-0000-0000000023c1',
      p_prize_id   => '00000000-0000-0000-0000-0000000023d1',
      p_limit      => 500,
      p_types      => array['RESERVATION']::public.inventory_movement_type[])) > 0
  and
  (select count(*) from public.list_movements(
      p_company_id => '00000000-0000-0000-0000-0000000023c1',
      p_prize_id   => '00000000-0000-0000-0000-0000000023d1',
      p_limit      => 500,
      p_types      => array['RESERVATION']::public.inventory_movement_type[])
   where movement_type <> 'RESERVATION') = 0,
  'p_types narrows to the one kind named, returning at least one row rather than merely none of the wrong kind');

-- 34: the period filter, p_from AND p_to, each in BOTH directions (fix
-- round 1, I5: the original assertion exercised only a p_from set past
-- every fixture -- an all-negative case that a p_from wired to always
-- return nothing would also have passed -- and never exercised p_to at
-- all). Every fixture in this whole file was written "now", inside this one
-- transaction, so a bound a year in the past or a day in the future is
-- unambiguously on the correct side for every case below.
select ok(
  -- Positive: a p_from safely in the past admits rows.
  (select count(*) from public.list_movements(
      p_company_id => '00000000-0000-0000-0000-0000000023c1',
      p_prize_id   => '00000000-0000-0000-0000-0000000023d1',
      p_limit      => 500,
      p_from       => now() - interval '1 year')) > 0
  -- Negative: a p_from in the future excludes everything.
  and (select count(*) from public.list_movements(
      p_company_id => '00000000-0000-0000-0000-0000000023c1',
      p_prize_id   => '00000000-0000-0000-0000-0000000023d1',
      p_limit      => 500,
      p_from       => now() + interval '1 day')) = 0
  -- Positive: a p_to safely in the future admits rows -- p_to was not
  -- exercised anywhere in this file before this fix round.
  and (select count(*) from public.list_movements(
      p_company_id => '00000000-0000-0000-0000-0000000023c1',
      p_prize_id   => '00000000-0000-0000-0000-0000000023d1',
      p_limit      => 500,
      p_to         => now() + interval '1 day')) > 0
  -- Negative: a p_to in the past excludes everything.
  and (select count(*) from public.list_movements(
      p_company_id => '00000000-0000-0000-0000-0000000023c1',
      p_prize_id   => '00000000-0000-0000-0000-0000000023d1',
      p_limit      => 500,
      p_to         => now() - interval '1 year')) = 0,
  'the period filter narrows by date in both directions, exercising p_from and p_to alike');

reset role;

select * from finish();
rollback;
