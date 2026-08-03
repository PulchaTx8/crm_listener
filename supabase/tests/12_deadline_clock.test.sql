begin;
select plan(24);

-- Block 6d: the clock, the pile it makes, and the way back.
--
-- Fixtures live in the ...00d0xx range. 09_draws.test.sql owns ...00a0xx
-- through ...00a3xx and 10_delivery.test.sql owns ...00b0xx; a collision
-- would fail in whichever file ran second.

select ok(
  'RETURN_PENDING' = any (enum_range(null::public.winner_status)::text[]),
  'winner_status carries RETURN_PENDING');
select ok(
  'RETURN_PENDING_CANCEL' = any (enum_range(null::public.inventory_movement_type)::text[]),
  'inventory_movement_type carries RETURN_PENDING_CANCEL');

-- ---------------------------------------------------------------------------
-- THE SHARED FIXTURE: a Station, a promotion with two linked units of one
-- prize, two listeners who entered, and a draw that awarded them both. Built
-- once because everything below is about what happens to a winner afterwards.

insert into public.organizations (id, name) values
  ('00000000-0000-0000-0000-00000000d0f1', 'Org 6d clock');
insert into public.companies (id, organization_id, name, timezone) values
  ('00000000-0000-0000-0000-00000000d0c1', '00000000-0000-0000-0000-00000000d0f1',
   'Station 6d clock', 'America/Sao_Paulo');

insert into public.prizes (id, organization_id, company_id, name, allows_return_to_stock)
values
  ('00000000-0000-0000-0000-00000000d0d1', '00000000-0000-0000-0000-00000000d0f1',
   '00000000-0000-0000-0000-00000000d0c1', 'Speaker 6d', true),
  ('00000000-0000-0000-0000-00000000d0d2', '00000000-0000-0000-0000-00000000d0f1',
   '00000000-0000-0000-0000-00000000d0c1', 'Concert pass 6d', false);

insert into public.inventory_balances
  (company_id, prize_id, organization_id, available)
values
  ('00000000-0000-0000-0000-00000000d0c1', '00000000-0000-0000-0000-00000000d0d1',
   '00000000-0000-0000-0000-00000000d0f1', 4),
  ('00000000-0000-0000-0000-00000000d0c1', '00000000-0000-0000-0000-00000000d0d2',
   '00000000-0000-0000-0000-00000000d0f1', 4);

-- The rest of the fixture -- promotion, promotion_prizes, members,
-- participations, draw, winners -- is built through public.apply_inventory_movement
-- and public.apply_draw rather than by inserting balances by hand, so the
-- numbers these tests read were produced the way production produces them.
-- 10_delivery.test.sql:1-120 builds the same shape and is the reference for the
-- call sequence; the ids here are ...00d0xx and the listeners are named
-- 'Maria 6d', 'Joao 6d' and 'Ana 6d', with Ana holding the Concert pass.

insert into public.promotions
  (id, organization_id, company_id, name, starts_at, ends_at, pickup_deadline_days)
values
  ('00000000-0000-0000-0000-00000000d0e1', '00000000-0000-0000-0000-00000000d0f1',
   '00000000-0000-0000-0000-00000000d0c1', 'Promo 6d clock', now() - interval '2 days',
   now() + interval '5 days', 7);

insert into public.promotion_prizes (id, promotion_id, prize_id, organization_id, company_id)
values
  ('00000000-0000-0000-0000-00000000d0a1', '00000000-0000-0000-0000-00000000d0e1',
   '00000000-0000-0000-0000-00000000d0d1', '00000000-0000-0000-0000-00000000d0f1',
   '00000000-0000-0000-0000-00000000d0c1'),
  ('00000000-0000-0000-0000-00000000d0a2', '00000000-0000-0000-0000-00000000d0e1',
   '00000000-0000-0000-0000-00000000d0d2', '00000000-0000-0000-0000-00000000d0f1',
   '00000000-0000-0000-0000-00000000d0c1');

-- Through the one writer, so the balances these tests read were produced the
-- way production produces them.
select public.apply_inventory_movement(
  '00000000-0000-0000-0000-00000000d0c1'::uuid,
  '00000000-0000-0000-0000-00000000d0d1'::uuid,
  'PROMOTION_LINK'::public.inventory_movement_type, 2,
  'available'::public.inventory_bucket, 'linked'::public.inventory_bucket,
  null, null,
  '00000000-0000-0000-0000-00000000d0a1'::uuid);

select public.apply_inventory_movement(
  '00000000-0000-0000-0000-00000000d0c1'::uuid,
  '00000000-0000-0000-0000-00000000d0d2'::uuid,
  'PROMOTION_LINK'::public.inventory_movement_type, 1,
  'available'::public.inventory_bucket, 'linked'::public.inventory_bucket,
  null, null,
  '00000000-0000-0000-0000-00000000d0a2'::uuid);

insert into public.members (id, organization_id, full_name) values
  ('00000000-0000-0000-0000-00000000d011', '00000000-0000-0000-0000-00000000d0f1', 'Maria 6d'),
  ('00000000-0000-0000-0000-00000000d012', '00000000-0000-0000-0000-00000000d0f1', 'Joao 6d'),
  ('00000000-0000-0000-0000-00000000d013', '00000000-0000-0000-0000-00000000d0f1', 'Ana 6d');

insert into public.member_company_links (member_id, company_id, organization_id) values
  ('00000000-0000-0000-0000-00000000d011', '00000000-0000-0000-0000-00000000d0c1',
   '00000000-0000-0000-0000-00000000d0f1'),
  ('00000000-0000-0000-0000-00000000d012', '00000000-0000-0000-0000-00000000d0c1',
   '00000000-0000-0000-0000-00000000d0f1'),
  ('00000000-0000-0000-0000-00000000d013', '00000000-0000-0000-0000-00000000d0c1',
   '00000000-0000-0000-0000-00000000d0f1');

insert into public.participations
  (id, promotion_id, member_id, organization_id, company_id, allows_multiple,
   status, source, participated_at)
values
  ('00000000-0000-0000-0000-00000000d101', '00000000-0000-0000-0000-00000000d0e1',
   '00000000-0000-0000-0000-00000000d011', '00000000-0000-0000-0000-00000000d0f1',
   '00000000-0000-0000-0000-00000000d0c1', false, 'VALID', 'MANUAL', now() - interval '5 hours'),
  ('00000000-0000-0000-0000-00000000d102', '00000000-0000-0000-0000-00000000d0e1',
   '00000000-0000-0000-0000-00000000d012', '00000000-0000-0000-0000-00000000d0f1',
   '00000000-0000-0000-0000-00000000d0c1', false, 'VALID', 'MANUAL', now() - interval '4 hours'),
  ('00000000-0000-0000-0000-00000000d103', '00000000-0000-0000-0000-00000000d0e1',
   '00000000-0000-0000-0000-00000000d013', '00000000-0000-0000-0000-00000000d0f1',
   '00000000-0000-0000-0000-00000000d0c1', false, 'VALID', 'MANUAL', now() - interval '3 hours');

-- Two draws on the same promotion, one per prize, so which listener gets which
-- unit is fixed by the fixture rather than left to the walk's random seed:
-- Maria and Joao are the only two entrants offered the Speaker, and there are
-- exactly two units of it, so both win one; Ana alone is offered the Concert
-- pass, of which there is exactly one unit.
select public.apply_draw(
  '00000000-0000-0000-0000-00000000d0e1'::uuid,
  '00000000-0000-0000-0000-00000000d0f1'::uuid,
  '00000000-0000-0000-0000-00000000d0c1'::uuid,
  jsonb_build_array(jsonb_build_object(
    'promotion_prize_id', '00000000-0000-0000-0000-00000000d0a1', 'quantity', 2)),
  array['00000000-0000-0000-0000-00000000d101', '00000000-0000-0000-0000-00000000d102']::uuid[]);

select public.apply_draw(
  '00000000-0000-0000-0000-00000000d0e1'::uuid,
  '00000000-0000-0000-0000-00000000d0f1'::uuid,
  '00000000-0000-0000-0000-00000000d0c1'::uuid,
  jsonb_build_array(jsonb_build_object(
    'promotion_prize_id', '00000000-0000-0000-0000-00000000d0a2', 'quantity', 1)),
  array['00000000-0000-0000-0000-00000000d103']::uuid[]);

-- NO TEST BELOW CARRIES A WINNER ID. apply_draw decides which listener gets
-- which unit, so an id written into an assertion would be a guess. Winners are
-- addressed by the listener holding them instead:
create function pg_temp.winner_of(p_name text) returns uuid language sql stable as $$
  select w.id
    from public.winners w
    join public.members m on m.id = w.member_id
   where m.full_name = p_name
     and w.company_id = '00000000-0000-0000-0000-00000000d0c1';
$$;

-- ---------------------------------------------------------------------------
-- The ledger's new arm, exercised on a prize and link of its own.
--
-- RETURN_PENDING already required a live promotion_prize_id before this block
-- (0083's inventory_movements_promotion_reference), so the null the brief
-- first reached for cannot stand -- and giving these three raw calls Maria's
-- own prize instead would double the count 'exactly ONE movement' reads off
-- prize d0d1 below. A throwaway prize keeps this section's movements out of
-- every count the clock's transition asserts.

insert into public.prizes (id, organization_id, company_id, name)
values ('00000000-0000-0000-0000-00000000d0d9', '00000000-0000-0000-0000-00000000d0f1',
        '00000000-0000-0000-0000-00000000d0c1', 'Arm fixture 6d');

insert into public.inventory_balances (company_id, prize_id, organization_id, available)
values ('00000000-0000-0000-0000-00000000d0c1', '00000000-0000-0000-0000-00000000d0d9',
        '00000000-0000-0000-0000-00000000d0f1', 1);

insert into public.promotion_prizes (id, promotion_id, prize_id, organization_id, company_id)
values ('00000000-0000-0000-0000-00000000d0a9', '00000000-0000-0000-0000-00000000d0e1',
        '00000000-0000-0000-0000-00000000d0d9', '00000000-0000-0000-0000-00000000d0f1',
        '00000000-0000-0000-0000-00000000d0c1');

select public.apply_inventory_movement(
  '00000000-0000-0000-0000-00000000d0c1'::uuid, '00000000-0000-0000-0000-00000000d0d9'::uuid,
  'PROMOTION_LINK'::public.inventory_movement_type, 1,
  'available'::public.inventory_bucket, 'linked'::public.inventory_bucket,
  null, null, '00000000-0000-0000-0000-00000000d0a9'::uuid);

select public.apply_inventory_movement(
  '00000000-0000-0000-0000-00000000d0c1'::uuid, '00000000-0000-0000-0000-00000000d0d9'::uuid,
  'DRAW'::public.inventory_movement_type, 1,
  'linked'::public.inventory_bucket, 'awaiting_pickup'::public.inventory_bucket,
  null, null, '00000000-0000-0000-0000-00000000d0a9'::uuid);

select lives_ok($$
  select public.apply_inventory_movement(
    '00000000-0000-0000-0000-00000000d0c1'::uuid,
    '00000000-0000-0000-0000-00000000d0d9'::uuid,
    'RETURN_PENDING'::public.inventory_movement_type, 1,
    'awaiting_pickup'::public.inventory_bucket,
    'pending_return'::public.inventory_bucket,
    'fixture', 'd6-arm-out', '00000000-0000-0000-0000-00000000d0a9')
$$, 'awaiting_pickup to pending_return is admitted');

select lives_ok($$
  select public.apply_inventory_movement(
    '00000000-0000-0000-0000-00000000d0c1'::uuid,
    '00000000-0000-0000-0000-00000000d0d9'::uuid,
    'RETURN_PENDING_CANCEL'::public.inventory_movement_type, 1,
    'pending_return'::public.inventory_bucket,
    'awaiting_pickup'::public.inventory_bucket,
    'fixture', 'd6-arm-back', '00000000-0000-0000-0000-00000000d0a9')
$$, 'pending_return to awaiting_pickup is admitted');

select throws_ok($$
  select public.apply_inventory_movement(
    '00000000-0000-0000-0000-00000000d0c1'::uuid,
    '00000000-0000-0000-0000-00000000d0d9'::uuid,
    'RETURN_PENDING_CANCEL'::public.inventory_movement_type, 1,
    'awaiting_pickup'::public.inventory_bucket,
    'pending_return'::public.inventory_bucket,
    'fixture', 'd6-arm-wrong', '00000000-0000-0000-0000-00000000d0a9')
$$, '23514', null,
  'RETURN_PENDING_CANCEL in the wrong direction is refused by the CHECK');

-- ---------------------------------------------------------------------------
-- The clock's transition.

select lives_ok($$
  select public.apply_winner_transition(
    pg_temp.winner_of('Maria 6d'), 'RETURN_PENDING'::public.winner_status, 'pickup deadline expired')
$$, 'AWAITING_PICKUP moves to RETURN_PENDING');

select is(
  (select status::text from public.winners where id = pg_temp.winner_of('Maria 6d')),
  'RETURN_PENDING', 'the winner rests in RETURN_PENDING');

select is(
  (select pending_return from public.inventory_balances
    where company_id = '00000000-0000-0000-0000-00000000d0c1'
      and prize_id = '00000000-0000-0000-0000-00000000d0d1'),
  1, 'one unit rests in pending_return');

select is(
  (select count(*)::integer from public.inventory_movements
    where movement_type = 'RETURN_PENDING'
      and from_bucket = 'awaiting_pickup' and to_bucket = 'pending_return'
      and prize_id = '00000000-0000-0000-0000-00000000d0d1'),
  1, 'exactly ONE movement -- the clock does not emit the pair a return does');

select throws_ok($$
  select public.apply_winner_transition(
    pg_temp.winner_of('Maria 6d'), 'RETURN_PENDING'::public.winner_status, 'again')
$$, '22023', null,
  'a winner already in RETURN_PENDING cannot expire twice');

-- ---------------------------------------------------------------------------
-- The way back. It is the ONLY transition that writes deadline_at, and the
-- two guards below are what make that true. Both run HERE, while Maria is
-- still RETURN_PENDING: a version of either that ran after her real reopen
-- (below) would find p_to = v_from = 'AWAITING_PICKUP' and raise 'this prize
-- is already AWAITING_PICKUP' at 0092's own-status check, before the
-- AWAITING_PICKUP branch -- let alone the p_deadline_at guards inside it -- is
-- ever reached, and would pass on entirely the wrong exception without
-- exercising either guard at all.

select throws_ok($$
  select public.apply_winner_transition(
    pg_temp.winner_of('Maria 6d'), 'AWAITING_PICKUP'::public.winner_status, 'no date given')
$$, '22023', 'reopening a deadline needs the new deadline',
  'reopening without a new deadline is refused');

select throws_ok($$
  select public.apply_winner_transition(
    pg_temp.winner_of('Maria 6d'), 'AWAITING_PICKUP'::public.winner_status,
    'trying to backdate it', now() - interval '1 day')
$$, '22023', 'the new deadline must be in the future',
  'reopening with a deadline already in the past is refused');

select lives_ok($$
  select public.apply_winner_transition(
    pg_temp.winner_of('Maria 6d'), 'AWAITING_PICKUP'::public.winner_status,
    'listener called, coming Friday', now() + interval '5 days')
$$, 'RETURN_PENDING reopens to AWAITING_PICKUP');

-- Bounded above as well as below: the draw's own freeze already put
-- deadline_at at now() + 7 days (pickup_deadline_days on the fixture's
-- promotion), which alone would satisfy a lower bound of + 4 days whether or
-- not the reopen wrote anything. Only the reopen's own now() + 5 days sits
-- inside (+4 days, +6 days).
select ok(
  (select deadline_at from public.winners where id = pg_temp.winner_of('Maria 6d'))
    between now() + interval '4 days' and now() + interval '6 days',
  'the reopen wrote the new deadline, not merely left the draw''s own freeze in place');

-- The comment above apply_winner_transition says the reopen is the only
-- transition permitted to pass p_deadline_at. Proving that means proving the
-- opposite fails: Maria is freshly AWAITING_PICKUP again, so DELIVERED is a
-- transition she could legally make -- just not with a deadline riding along.
select throws_ok($$
  select public.apply_winner_transition(
    pg_temp.winner_of('Maria 6d'), 'DELIVERED'::public.winner_status, null, now() + interval '3 days')
$$, '22023', 'p_deadline_at is accepted only when reopening RETURN_PENDING to AWAITING_PICKUP',
  'p_deadline_at is refused on every transition but the reopen');

-- 2, not 1: Joao's own unit of this same prize has been sitting in
-- awaiting_pickup, untouched, since the draw -- he does not expire until the
-- section below -- so the bucket the reopen adds Maria's unit back into
-- already held his.
select is(
  (select awaiting_pickup from public.inventory_balances
    where company_id = '00000000-0000-0000-0000-00000000d0c1'
      and prize_id = '00000000-0000-0000-0000-00000000d0d1'),
  2, 'the unit came back to awaiting_pickup');

-- The guard that matters: every OTHER transition must leave deadline_at alone,
-- and a test asserting only the status would pass one that zeroed it. Joao's
-- deadline is recorded here, before he expires and is returned below, and
-- checked at the end of this file.
create temp table deadline_before as
  select (select deadline_at from public.winners
           where id = pg_temp.winner_of('Joao 6d')) as at;

-- ---------------------------------------------------------------------------
-- Out of RETURN_PENDING the operator's two ways.

select lives_ok($$
  select public.apply_winner_transition(
    pg_temp.winner_of('Joao 6d'), 'RETURN_PENDING'::public.winner_status, 'pickup deadline expired')
$$, 'the second winner expires too');

select lives_ok($$
  select public.apply_winner_transition(
    pg_temp.winner_of('Joao 6d'), 'RETURNED'::public.winner_status, 'nobody came')
$$, 'RETURN_PENDING returns to stock');

-- Counting RETURN_PENDING here, not RETURN_TO_STOCK: the two-step pair a
-- return-from-AWAITING_PICKUP emits contains exactly one RETURN_TO_STOCK
-- movement too, so that count is 1 under the right implementation AND the
-- wrong one -- it does not discriminate. RETURN_PENDING does: Maria's own
-- expiry and Joao's own expiry have already put 2 on this prize; the correct,
-- resting-bucket path Joao's RETURNED just took (v_from = RETURN_PENDING)
-- adds no third, where the two-step pair would.
select is(
  (select count(*)::integer from public.inventory_movements
    where movement_type = 'RETURN_PENDING'
      and from_bucket = 'awaiting_pickup' and to_bucket = 'pending_return'
      and prize_id = '00000000-0000-0000-0000-00000000d0d1'),
  2, 'the resting-bucket path adds no extra RETURN_PENDING movement, unlike the two-step pair');

-- Ana holds the Concert pass, registered as one that cannot go back to stock.
select lives_ok($$
  select public.apply_winner_transition(
    pg_temp.winner_of('Ana 6d'), 'RETURN_PENDING'::public.winner_status, 'pickup deadline expired')
$$, 'a non-returnable prize expires like any other');

select throws_ok($$
  select public.apply_winner_transition(
    pg_temp.winner_of('Ana 6d'), 'RETURNED'::public.winner_status, 'try anyway')
$$, '22023', null,
  'allows_return_to_stock is honoured out of RETURN_PENDING too');

select lives_ok($$
  select public.apply_winner_transition(
    pg_temp.winner_of('Ana 6d'), 'WRITTEN_OFF'::public.winner_status, 'never collected')
$$, 'RETURN_PENDING writes off');

select is(
  (select count(*)::integer from public.inventory_movements
    where movement_type = 'WRITE_OFF' and from_bucket = 'pending_return'
      and prize_id = '00000000-0000-0000-0000-00000000d0d2'),
  1, 'the write-off leaves pending_return, not awaiting_pickup');

-- The frozen column, checked after two transitions that had no business
-- touching it.
select is(
  (select deadline_at from public.winners where id = pg_temp.winner_of('Joao 6d')),
  (select at from deadline_before),
  'expiring and returning left deadline_at exactly where the draw froze it');

select * from finish();
rollback;
