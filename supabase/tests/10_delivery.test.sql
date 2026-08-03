begin;
select plan(42);

-- Block 6b: what an operator does deliberately with a prize that has been won.
--
-- Fixtures live in the ...00b0xx range: 09_draws.test.sql owns ...00a0xx
-- through ...00a3xx, and a collision would fail in whichever file ran second.

-- ---------------------------------------------------------------------------
-- THE SHARED FIXTURE. Every task in this block draws on it: a Station, a
-- promotion with one linked prize, one listener who entered, and one draw that
-- awarded them the unit. Built once here rather than per section, because the
-- thing under test is always what happens to a winner AFTER the draw.

insert into public.organizations (id, name) values
  ('00000000-0000-0000-0000-00000000b0f1', 'Org 6b delivery');
insert into public.companies (id, organization_id, name, timezone) values
  ('00000000-0000-0000-0000-00000000b0c1', '00000000-0000-0000-0000-00000000b0f1',
   'Station 6b delivery', 'America/Sao_Paulo');

insert into public.prizes (id, organization_id, company_id, name) values
  ('00000000-0000-0000-0000-00000000b0d1', '00000000-0000-0000-0000-00000000b0f1',
   '00000000-0000-0000-0000-00000000b0c1', 'Bicycle 6b');

insert into public.inventory_balances (company_id, prize_id, organization_id, available)
values ('00000000-0000-0000-0000-00000000b0c1', '00000000-0000-0000-0000-00000000b0d1',
        '00000000-0000-0000-0000-00000000b0f1', 2);

insert into public.promotions
  (id, organization_id, company_id, name, starts_at, ends_at)
values
  ('00000000-0000-0000-0000-00000000b0e1', '00000000-0000-0000-0000-00000000b0f1',
   '00000000-0000-0000-0000-00000000b0c1', 'Promo 6b', now() - interval '2 days',
   now() + interval '1 day');

insert into public.promotion_prizes (id, promotion_id, prize_id, organization_id, company_id)
values ('00000000-0000-0000-0000-00000000b0a1', '00000000-0000-0000-0000-00000000b0e1',
        '00000000-0000-0000-0000-00000000b0d1', '00000000-0000-0000-0000-00000000b0f1',
        '00000000-0000-0000-0000-00000000b0c1');

-- Through the one writer, so the balances these tests read were produced the
-- way production produces them.
select public.apply_inventory_movement(
  '00000000-0000-0000-0000-00000000b0c1'::uuid,
  '00000000-0000-0000-0000-00000000b0d1'::uuid,
  'PROMOTION_LINK'::public.inventory_movement_type, 2,
  'available'::public.inventory_bucket, 'linked'::public.inventory_bucket,
  null, null,
  '00000000-0000-0000-0000-00000000b0a1'::uuid);

insert into public.members (id, organization_id, full_name) values
  ('00000000-0000-0000-0000-00000000b011', '00000000-0000-0000-0000-00000000b0f1', 'Winner 6b');
insert into public.member_company_links (member_id, company_id, organization_id) values
  ('00000000-0000-0000-0000-00000000b011', '00000000-0000-0000-0000-00000000b0c1',
   '00000000-0000-0000-0000-00000000b0f1');

insert into public.participations
  (id, promotion_id, member_id, organization_id, company_id, allows_multiple,
   status, source, participated_at)
values
  ('00000000-0000-0000-0000-00000000b101', '00000000-0000-0000-0000-00000000b0e1',
   '00000000-0000-0000-0000-00000000b011', '00000000-0000-0000-0000-00000000b0f1',
   '00000000-0000-0000-0000-00000000b0c1', false, 'VALID', 'MANUAL', now() - interval '5 hours');

insert into public.draws
  (id, promotion_id, organization_id, company_id, seed, algorithm_version,
   runner_up_count, entry_count)
values
  ('00000000-0000-0000-0000-00000000b201', '00000000-0000-0000-0000-00000000b0e1',
   '00000000-0000-0000-0000-00000000b0f1', '00000000-0000-0000-0000-00000000b0c1',
   repeat('b', 64), 1, 0, 1);

insert into public.draw_entries (draw_id, company_id, participation_id, member_id, position)
values ('00000000-0000-0000-0000-00000000b201', '00000000-0000-0000-0000-00000000b0c1',
        '00000000-0000-0000-0000-00000000b101', '00000000-0000-0000-0000-00000000b011', 1);

insert into public.winners
  (id, draw_id, company_id, promotion_prize_id, member_id, participation_id, awarded_rank)
values
  ('00000000-0000-0000-0000-00000000b301', '00000000-0000-0000-0000-00000000b201',
   '00000000-0000-0000-0000-00000000b0c1', '00000000-0000-0000-0000-00000000b0a1',
   '00000000-0000-0000-0000-00000000b011', '00000000-0000-0000-0000-00000000b101', 1);

-- ---------------------------------------------------------------------------
-- Task 1: the history, the receipt columns, and who may do what.

select has_table('public', 'winner_status_history', 'winner_status_history exists');

select is(relrowsecurity, true, 'RLS enabled on winner_status_history')
  from pg_class where oid = 'public.winner_status_history'::regclass;

-- Block 5a shipped three tables with a comment about who could reach them and
-- no grant behind it: pgTAP runs as postgres and ignores ACLs, so every
-- assertion stayed green while production returned 42501.
select ok(has_table_privilege('authenticated', 'public.winner_status_history', 'SELECT'),
          'authenticated may read the history: it is what the winner''s screen shows');
select ok(not has_table_privilege('anon', 'public.winner_status_history', 'TRUNCATE')
      and not has_table_privilege('authenticated', 'public.winner_status_history', 'TRUNCATE'),
          'nobody at the PostgREST roles may truncate the history');
select ok(has_table_privilege('service_role', 'public.winner_status_history', 'SELECT')
      and has_table_privilege('service_role', 'public.winner_status_history', 'INSERT'),
          'service_role may read and write the history');

select has_column('public', 'winners', 'receipt_path', 'winners carries the receipt path');
select has_column('public', 'winners', 'receipt_uploaded_at', 'winners records when a receipt arrived');
select has_column('public', 'winners', 'receipt_erased_at', 'winners records when one was erased');

select is(
  (select count(*)::int from public.permissions
    where code in ('winners.deliver', 'winners.deliver_cancel',
                   'winners.return', 'winners.write_off')),
  4, 'all four delivery permission codes are in the catalogue');

-- The reason asymmetry (spec 3.2) -------------------------------------------
--
-- Mandatory on the three transitions that undo or destroy something somebody
-- has already been told about; optional on the one that was supposed to happen.

select throws_ok($$
  insert into public.winner_status_history
    (winner_id, company_id, from_status, to_status, reason)
  values
    ('00000000-0000-0000-0000-00000000b301', '00000000-0000-0000-0000-00000000b0c1',
     'AWAITING_PICKUP', 'RETURNED', '   ')
$$, '23514', null, 'a return with a blank reason is refused');

select throws_ok($$
  insert into public.winner_status_history
    (winner_id, company_id, from_status, to_status, reason)
  values
    ('00000000-0000-0000-0000-00000000b301', '00000000-0000-0000-0000-00000000b0c1',
     'AWAITING_PICKUP', 'WRITTEN_OFF', null)
$$, '23514', null, 'a write-off with no reason at all is refused');

select lives_ok($$
  insert into public.winner_status_history
    (winner_id, company_id, from_status, to_status, reason)
  values
    ('00000000-0000-0000-0000-00000000b301', '00000000-0000-0000-0000-00000000b0c1',
     'AWAITING_PICKUP', 'DELIVERED', null)
$$, 'a delivery needs no reason: handing a prize to the person who won it is what was supposed to happen');

-- The receipt shape ----------------------------------------------------------

select throws_ok($$
  update public.winners
     set receipt_path = 'x/y/z.png', receipt_erased_at = now()
   where id = '00000000-0000-0000-0000-00000000b301'
$$, '23514', null, 'a receipt cannot be both present and erased');

select lives_ok($$
  update public.winners
     set receipt_path = null, receipt_erased_at = now()
   where id = '00000000-0000-0000-0000-00000000b301'
$$, 'an erased receipt is a null path with a date beside it');

-- The composite key the history hangs from ------------------------------------

select ok(
  exists (
    select 1 from pg_constraint
    where conrelid = 'public.winners'::regclass
      and conname = 'winners_id_company_unique'
      and contype = 'u'),
  'winners carries (id, company_id) unique, so a child proves the Station in one constraint');

select is(
  (select count(*)::int from pg_policies
    where schemaname = 'public' and tablename = 'winner_status_history'),
  1, 'the history carries exactly one policy, and it is a read policy');

-- ---------------------------------------------------------------------------
-- Task 2: the ledger learns the other five movements.
--
-- Each is driven through apply_inventory_movement, the one writer, and the
-- assertion reads BOTH per-promotion figures as a pair. Asserting only the one
-- that is supposed to move cannot catch a branch that moves both when it should
-- move neither -- which is precisely the mistake the four no-op branches exist
-- to avoid.

select ok('DELIVERY_CANCEL' = any(enum_range(null::public.inventory_movement_type)::text[]),
          'the ledger has a word for undoing a delivery');

-- A helper, so each assertion below reads as the figures and not as a join.
create function pg_temp.promo_figures() returns text language sql stable as $$
  select b.linked || '/' || b.drawn
  from public.promotion_prize_balances b
  where b.promotion_prize_id = '00000000-0000-0000-0000-00000000b0a1';
$$;

create function pg_temp.move(
  p_type public.inventory_movement_type,
  p_from public.inventory_bucket,
  p_to   public.inventory_bucket
) returns void language sql as $$
  select public.apply_inventory_movement(
    '00000000-0000-0000-0000-00000000b0c1'::uuid,
    '00000000-0000-0000-0000-00000000b0d1'::uuid,
    p_type, 1, p_from, p_to, null, null,
    '00000000-0000-0000-0000-00000000b0a1'::uuid);
$$;

-- The draw itself, so the figures start where a real winner leaves them.
select pg_temp.move('DRAW', 'linked', 'awaiting_pickup');
select is(pg_temp.promo_figures(), '2/1', 'the draw leaves two linked and one drawn');

select pg_temp.move('DELIVERY', 'awaiting_pickup', 'delivered');
select is(pg_temp.promo_figures(), '2/1',
          'DELIVERY changes neither figure: the unit was spent BY the promotion');

select pg_temp.move('DELIVERY_CANCEL', 'delivered', 'awaiting_pickup');
select is(pg_temp.promo_figures(), '2/1',
          'and undoing it changes neither either');

select pg_temp.move('RETURN_PENDING', 'awaiting_pickup', 'pending_return');
select is(pg_temp.promo_figures(), '2/1',
          'a unit on its way back is still committed to the promotion');

select pg_temp.move('RETURN_TO_STOCK', 'pending_return', 'available');
select is(pg_temp.promo_figures(), '1/0',
          'RETURN_TO_STOCK drops both: the unit left the promotion for general stock');

select is(
  (select available from public.inventory_balances
    where company_id = '00000000-0000-0000-0000-00000000b0c1'
      and prize_id = '00000000-0000-0000-0000-00000000b0d1'),
  1, 'and it really is back in available, not merely uncounted');

-- Draw the remaining unit so there is something in awaiting_pickup to destroy.
select pg_temp.move('DRAW', 'linked', 'awaiting_pickup');
select pg_temp.move('WRITE_OFF', 'awaiting_pickup', 'written_off');
select is(pg_temp.promo_figures(), '1/1',
          'a written-off unit stays counted: it was this promotion that consumed it');

-- ---------------------------------------------------------------------------
-- Task 3: delivering, and undoing a delivery.
--
-- Each case gets its OWN winner, with its own prize and its own linked unit, so
-- a failure names one rule. The shared fixture above cannot be reused here: the
-- Task 2 section moved its unit through every bucket and left nothing in
-- awaiting_pickup, which is the one thing a delivery needs.

create function pg_temp.seed_winner(
  p_label  text,
  p_allows boolean default true
)
returns uuid
language plpgsql
as $$
declare
  v_org     uuid := '00000000-0000-0000-0000-00000000b0f1';
  v_co      uuid := '00000000-0000-0000-0000-00000000b0c1';
  v_prize   uuid := gen_random_uuid();
  v_promo   uuid := gen_random_uuid();
  v_link    uuid := gen_random_uuid();
  v_member  uuid := gen_random_uuid();
  v_part    uuid := gen_random_uuid();
  v_draw    uuid := gen_random_uuid();
  v_winner  uuid := gen_random_uuid();
begin
  insert into public.prizes (id, organization_id, company_id, name, allows_return_to_stock)
  values (v_prize, v_org, v_co, p_label || ' prize', p_allows);

  insert into public.inventory_balances (company_id, prize_id, organization_id, available)
  values (v_co, v_prize, v_org, 1);

  insert into public.promotions (id, organization_id, company_id, name, starts_at, ends_at)
  values (v_promo, v_org, v_co, p_label, now() - interval '2 days', now() + interval '1 day');

  insert into public.promotion_prizes (id, promotion_id, prize_id, organization_id, company_id)
  values (v_link, v_promo, v_prize, v_org, v_co);

  perform public.apply_inventory_movement(
    v_co, v_prize, 'PROMOTION_LINK'::public.inventory_movement_type, 1,
    'available'::public.inventory_bucket, 'linked'::public.inventory_bucket,
    null, null, v_link);

  insert into public.members (id, organization_id, full_name)
  values (v_member, v_org, p_label || ' listener');
  insert into public.member_company_links (member_id, company_id, organization_id)
  values (v_member, v_co, v_org);

  insert into public.participations
    (id, promotion_id, member_id, organization_id, company_id, allows_multiple,
     status, source, participated_at)
  values (v_part, v_promo, v_member, v_org, v_co, false, 'VALID', 'MANUAL', now() - interval '3 hours');

  insert into public.draws
    (id, promotion_id, organization_id, company_id, seed, algorithm_version,
     runner_up_count, entry_count)
  values (v_draw, v_promo, v_org, v_co, repeat('c', 64), 1, 0, 1);

  insert into public.draw_entries (draw_id, company_id, participation_id, member_id, position)
  values (v_draw, v_co, v_part, v_member, 1);

  insert into public.winners
    (id, draw_id, company_id, promotion_prize_id, member_id, participation_id,
     awarded_rank, deadline_at)
  values (v_winner, v_draw, v_co, v_link, v_member, v_part, 1, now() + interval '7 days');

  -- The draw's own movement, so the unit really is in awaiting_pickup.
  perform public.apply_inventory_movement(
    v_co, v_prize, 'DRAW'::public.inventory_movement_type, 1,
    'linked'::public.inventory_bucket, 'awaiting_pickup'::public.inventory_bucket,
    null, null, v_link);

  return v_winner;
end;
$$;

-- Two operators: one who may do everything, and one who may only deliver. The
-- second is what makes "refused without winners.deliver_cancel" a statement
-- about that code rather than about being a stranger to the Station.
insert into public.roles (id, organization_id, name) values
  ('00000000-0000-0000-0000-00000000b401', '00000000-0000-0000-0000-00000000b0f1', 'Delivery Full'),
  ('00000000-0000-0000-0000-00000000b402', '00000000-0000-0000-0000-00000000b0f1', 'Deliver Only');
insert into public.role_permissions (role_id, permission_code) values
  ('00000000-0000-0000-0000-00000000b401', 'promotions.view'),
  ('00000000-0000-0000-0000-00000000b401', 'winners.deliver'),
  ('00000000-0000-0000-0000-00000000b401', 'winners.deliver_cancel'),
  ('00000000-0000-0000-0000-00000000b401', 'winners.return'),
  ('00000000-0000-0000-0000-00000000b401', 'winners.write_off'),
  ('00000000-0000-0000-0000-00000000b402', 'promotions.view'),
  ('00000000-0000-0000-0000-00000000b402', 'winners.deliver');
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-00000000b403', 'delivery-full@example.test'),
  ('00000000-0000-0000-0000-00000000b404', 'deliver-only@example.test');
insert into public.company_memberships (user_id, company_id, organization_id, role_id) values
  ('00000000-0000-0000-0000-00000000b403', '00000000-0000-0000-0000-00000000b0c1',
   '00000000-0000-0000-0000-00000000b0f1', '00000000-0000-0000-0000-00000000b401'),
  ('00000000-0000-0000-0000-00000000b404', '00000000-0000-0000-0000-00000000b0c1',
   '00000000-0000-0000-0000-00000000b0f1', '00000000-0000-0000-0000-00000000b402');

create temporary table delivery_cases as
select pg_temp.seed_winner('Handover')      as happy,
       pg_temp.seed_winner('Twice')         as twice,
       pg_temp.seed_winner('Forbidden')     as forbidden,
       pg_temp.seed_winner('Undo')          as undo,
       pg_temp.seed_winner('Undo forbidden') as undo_forbidden,
       pg_temp.seed_winner('Never delivered') as never;

-- The table is created by postgres and read back by the operator roles below,
-- which hold nothing on it by default. Granting here rather than inlining the
-- ids keeps each assertion naming the case it is about.
grant select on delivery_cases to authenticated;

set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000b403", "role": "authenticated"}';

select lives_ok(
  format($$select public.deliver_prize(%L::uuid)$$, (select happy from delivery_cases)),
  'a prize awaiting pickup can be handed over, and needs no note to do it');

select is(
  (select status::text from public.winners where id = (select happy from delivery_cases)),
  'DELIVERED', 'the winner says the prize was delivered');

select is(
  (select from_status::text || '->' || to_status::text
     from public.winner_status_history
    where winner_id = (select happy from delivery_cases)),
  'AWAITING_PICKUP->DELIVERED', 'and one history row saying where it came from');

select throws_ok(
  format($$select public.deliver_prize(%L::uuid)$$, (select happy from delivery_cases)),
  '22023', null, 'a prize already delivered cannot be delivered again');

-- Undoing ---------------------------------------------------------------------

select lives_ok(
  format($$select public.deliver_prize(%L::uuid)$$, (select undo from delivery_cases)),
  'a second prize is handed over, to be undone below');

create temporary table undo_deadline as
select deadline_at from public.winners where id = (select undo from delivery_cases);

select lives_ok(
  format($$select public.cancel_delivery(%L::uuid, 'recorded against the wrong winner')$$,
         (select undo from delivery_cases)),
  'a delivery recorded by mistake can be undone');

select is(
  (select status::text from public.winners where id = (select undo from delivery_cases)),
  'AWAITING_PICKUP', 'and the winner is waiting for their prize again');

-- D4. deadline_at was frozen at the draw and the delivery never moved it, so
-- undoing does not either.
select is(
  (select deadline_at from public.winners where id = (select undo from delivery_cases)),
  (select deadline_at from undo_deadline),
  'undoing a delivery does not touch the deadline');

select is(
  (select count(*)::int from public.winner_status_history
    where winner_id = (select undo from delivery_cases)),
  2, 'both passages are on the record');

select throws_ok(
  format($$select public.cancel_delivery(%L::uuid, '   ')$$, (select happy from delivery_cases)),
  '22023', null, 'an undo with a blank reason is refused');

select throws_ok(
  format($$select public.cancel_delivery(%L::uuid, 'never happened')$$,
         (select never from delivery_cases)),
  '22023', null, 'a delivery that never happened cannot be undone');

reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000b404", "role": "authenticated"}';

select lives_ok(
  format($$select public.deliver_prize(%L::uuid)$$, (select undo_forbidden from delivery_cases)),
  'the deliver-only operator may hand a prize over');

select throws_ok(
  format($$select public.cancel_delivery(%L::uuid, 'not mine to undo')$$,
         (select undo_forbidden from delivery_cases)),
  '42501', null, 'winners.deliver is not winners.deliver_cancel');

reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-0000000004ff", "role": "authenticated"}';

select throws_ok(
  format($$select public.deliver_prize(%L::uuid)$$, (select forbidden from delivery_cases)),
  '42501', null, 'a stranger to the Station may not deliver anything');

reset role;

-- Read back as postgres, not as the operator. b403 holds promotions.view and
-- the four delivery codes and NOTHING about inventory, so these two reads come
-- back empty under RLS for a reason that has nothing to do with what they
-- assert -- which is itself the correct behaviour, and is why they moved here.
select is(
  (select count(*)::int from public.inventory_movements m
    where m.movement_type = 'DELIVERY'
      and m.promotion_prize_id = (select w.promotion_prize_id from public.winners w
                                   where w.id = (select happy from delivery_cases))),
  1, 'one DELIVERY movement, through the one writer');

select is(
  (select b.linked || '/' || b.drawn from public.promotion_prize_balances b
    where b.promotion_prize_id = (select w.promotion_prize_id from public.winners w
                                   where w.id = (select undo from delivery_cases))),
  '1/1', 'a delivery and its undo leave the promotion''s figures where they started');

select ok(has_function_privilege('authenticated', 'public.deliver_prize(uuid, text)', 'EXECUTE'),
          'deliver_prize is a door');
select ok(not has_function_privilege('authenticated',
            'public.apply_winner_transition(uuid, public.winner_status, text)', 'EXECUTE'),
          'and the transition core behind it is private, like every rule body here');

select * from finish();
rollback;
