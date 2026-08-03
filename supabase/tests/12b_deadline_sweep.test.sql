-- Block 6d, Task 4: the clock, exercised end to end.
--
-- NOT wrapped in begin/rollback, unlike every other file here, and it cannot
-- be: sweep_pickup_deadlines is a PROCEDURE that commits after each winner
-- (design spec D6), and CALL inside an open transaction block raises
--   ERROR: invalid transaction termination
-- So this file builds its fixture, runs, asserts, and deletes what it made.

select plan(14);

-- ---------------------------------------------------------------------------
-- SELF-HEALING: the same cleanup this file runs at the bottom, run again here
-- first. A file that does not roll back and dies mid-script (a bad assertion,
-- a typo in a fixture statement) never reaches its own bottom-of-file
-- cleanup, and the NEXT run then collides on organizations_pkey instead of
-- reporting whatever actually broke -- measured, twice, while writing this
-- file. Every DELETE below is a no-op on a genuinely fresh database, so
-- running it unconditionally here costs nothing.

delete from public.winner_status_history
 where company_id = '00000000-0000-0000-0000-00000000d1c1';
delete from public.winners where company_id = '00000000-0000-0000-0000-00000000d1c1';
delete from public.draw_entries where company_id = '00000000-0000-0000-0000-00000000d1c1';
delete from public.draws where company_id = '00000000-0000-0000-0000-00000000d1c1';
delete from public.inventory_movements
 where company_id = '00000000-0000-0000-0000-00000000d1c1';
delete from public.inventory_balances
 where company_id = '00000000-0000-0000-0000-00000000d1c1';
delete from public.participations where company_id = '00000000-0000-0000-0000-00000000d1c1';
delete from public.promotion_prize_balances
 where company_id = '00000000-0000-0000-0000-00000000d1c1';
delete from public.promotion_prizes where company_id = '00000000-0000-0000-0000-00000000d1c1';
delete from public.promotions where company_id = '00000000-0000-0000-0000-00000000d1c1';
delete from public.prizes where company_id = '00000000-0000-0000-0000-00000000d1c1';
delete from public.member_company_links where company_id = '00000000-0000-0000-0000-00000000d1c1';
delete from public.members where organization_id = '00000000-0000-0000-0000-00000000d1f1';
delete from public.audit_logs where company_id = '00000000-0000-0000-0000-00000000d1c1';
delete from public.companies where id = '00000000-0000-0000-0000-00000000d1c1';
delete from public.organizations where id = '00000000-0000-0000-0000-00000000d1f1';

delete from public.winner_status_history
 where company_id = '00000000-0000-0000-0000-00000000d1c2';
delete from public.winners where company_id = '00000000-0000-0000-0000-00000000d1c2';
delete from public.draw_entries where company_id = '00000000-0000-0000-0000-00000000d1c2';
delete from public.draws where company_id = '00000000-0000-0000-0000-00000000d1c2';
delete from public.inventory_movements
 where company_id = '00000000-0000-0000-0000-00000000d1c2';
delete from public.inventory_balances
 where company_id = '00000000-0000-0000-0000-00000000d1c2';
delete from public.participations where company_id = '00000000-0000-0000-0000-00000000d1c2';
delete from public.promotion_prize_balances
 where company_id = '00000000-0000-0000-0000-00000000d1c2';
delete from public.promotion_prizes where company_id = '00000000-0000-0000-0000-00000000d1c2';
delete from public.promotions where company_id = '00000000-0000-0000-0000-00000000d1c2';
delete from public.prizes where company_id = '00000000-0000-0000-0000-00000000d1c2';
delete from public.member_company_links where company_id = '00000000-0000-0000-0000-00000000d1c2';
delete from public.members where organization_id = '00000000-0000-0000-0000-00000000d1f2';
delete from public.audit_logs where company_id = '00000000-0000-0000-0000-00000000d1c2';
delete from public.companies where id = '00000000-0000-0000-0000-00000000d1c2';
delete from public.organizations where id = '00000000-0000-0000-0000-00000000d1f2';

-- The cancellation actor the cancelled-draw fixture needs, cleaned up here
-- too: this file does not roll back, and it is the only auth.users row it
-- ever creates.
delete from auth.users where id = '00000000-0000-0000-0000-00000000d1ab';

-- Pinned so a future migration cannot quietly re-grant EXECUTE to
-- service_role and reintroduce the silent no-op finding 1 of the first
-- review round caught (a service_role CALL would fail every winner --
-- service_role holds nothing on apply_winner_transition or
-- apply_inventory_movement -- and still report success). 09/10/11's own
-- test files pin their writers' ACLs the same way.
select ok(not has_function_privilege('service_role',
            'public.sweep_pickup_deadlines()', 'EXECUTE'),
          'the sweep is owner-only: a service_role CALL would fail every winner and report success');

-- ---------------------------------------------------------------------------
-- THE FIRST FIXTURE: a Station, one prize with four units, four listeners and
-- one draw that awards all four. Built through apply_inventory_movement and
-- apply_draw, the way 10_delivery.test.sql:1-120 builds its own, so the
-- winners these tests read were produced the way production produces them.
--
-- Fixtures live in the ...00d1xx range: 12_deadline_clock.test.sql owns
-- ...00d0xx; a collision would fail in whichever file ran second.

insert into public.organizations (id, name) values
  ('00000000-0000-0000-0000-00000000d1f1', 'Org 6d sweep');
insert into public.companies (id, organization_id, name, timezone) values
  ('00000000-0000-0000-0000-00000000d1c1', '00000000-0000-0000-0000-00000000d1f1',
   'Station 6d sweep', 'America/Sao_Paulo');

insert into public.prizes (id, organization_id, company_id, name) values
  ('00000000-0000-0000-0000-00000000d1d1', '00000000-0000-0000-0000-00000000d1f1',
   '00000000-0000-0000-0000-00000000d1c1', 'Radio 6d sweep');

insert into public.inventory_balances (company_id, prize_id, organization_id, available)
values ('00000000-0000-0000-0000-00000000d1c1', '00000000-0000-0000-0000-00000000d1d1',
        '00000000-0000-0000-0000-00000000d1f1', 4);

insert into public.promotions
  (id, organization_id, company_id, name, starts_at, ends_at)
values
  ('00000000-0000-0000-0000-00000000d1e1', '00000000-0000-0000-0000-00000000d1f1',
   '00000000-0000-0000-0000-00000000d1c1', 'Promo 6d sweep', now() - interval '2 days',
   now() + interval '5 days');

insert into public.promotion_prizes (id, promotion_id, prize_id, organization_id, company_id)
values ('00000000-0000-0000-0000-00000000d1a1', '00000000-0000-0000-0000-00000000d1e1',
        '00000000-0000-0000-0000-00000000d1d1', '00000000-0000-0000-0000-00000000d1f1',
        '00000000-0000-0000-0000-00000000d1c1');

-- Through the one writer, so the balances these tests read were produced the
-- way production produces them.
select public.apply_inventory_movement(
  '00000000-0000-0000-0000-00000000d1c1'::uuid,
  '00000000-0000-0000-0000-00000000d1d1'::uuid,
  'PROMOTION_LINK'::public.inventory_movement_type, 4,
  'available'::public.inventory_bucket, 'linked'::public.inventory_bucket,
  null, null,
  '00000000-0000-0000-0000-00000000d1a1'::uuid);

insert into public.members (id, organization_id, full_name) values
  ('00000000-0000-0000-0000-00000000d111', '00000000-0000-0000-0000-00000000d1f1', 'Overdue 6d'),
  ('00000000-0000-0000-0000-00000000d112', '00000000-0000-0000-0000-00000000d1f1', 'InTime 6d'),
  ('00000000-0000-0000-0000-00000000d113', '00000000-0000-0000-0000-00000000d1f1', 'NoDeadline 6d'),
  ('00000000-0000-0000-0000-00000000d114', '00000000-0000-0000-0000-00000000d1f1', 'Delivered 6d');

insert into public.member_company_links (member_id, company_id, organization_id) values
  ('00000000-0000-0000-0000-00000000d111', '00000000-0000-0000-0000-00000000d1c1',
   '00000000-0000-0000-0000-00000000d1f1'),
  ('00000000-0000-0000-0000-00000000d112', '00000000-0000-0000-0000-00000000d1c1',
   '00000000-0000-0000-0000-00000000d1f1'),
  ('00000000-0000-0000-0000-00000000d113', '00000000-0000-0000-0000-00000000d1c1',
   '00000000-0000-0000-0000-00000000d1f1'),
  ('00000000-0000-0000-0000-00000000d114', '00000000-0000-0000-0000-00000000d1c1',
   '00000000-0000-0000-0000-00000000d1f1');

insert into public.participations
  (id, promotion_id, member_id, organization_id, company_id, allows_multiple,
   status, source, participated_at)
values
  ('00000000-0000-0000-0000-00000000d121', '00000000-0000-0000-0000-00000000d1e1',
   '00000000-0000-0000-0000-00000000d111', '00000000-0000-0000-0000-00000000d1f1',
   '00000000-0000-0000-0000-00000000d1c1', false, 'VALID', 'MANUAL', now() - interval '5 hours'),
  ('00000000-0000-0000-0000-00000000d122', '00000000-0000-0000-0000-00000000d1e1',
   '00000000-0000-0000-0000-00000000d112', '00000000-0000-0000-0000-00000000d1f1',
   '00000000-0000-0000-0000-00000000d1c1', false, 'VALID', 'MANUAL', now() - interval '4 hours'),
  ('00000000-0000-0000-0000-00000000d123', '00000000-0000-0000-0000-00000000d1e1',
   '00000000-0000-0000-0000-00000000d113', '00000000-0000-0000-0000-00000000d1f1',
   '00000000-0000-0000-0000-00000000d1c1', false, 'VALID', 'MANUAL', now() - interval '3 hours'),
  ('00000000-0000-0000-0000-00000000d124', '00000000-0000-0000-0000-00000000d1e1',
   '00000000-0000-0000-0000-00000000d114', '00000000-0000-0000-0000-00000000d1f1',
   '00000000-0000-0000-0000-00000000d1c1', false, 'VALID', 'MANUAL', now() - interval '2 hours');

-- One draw, one prize, four units for four entrants: apply_draw awards
-- everybody supplied when quantity equals the count offered, so which
-- listener gets which of the four units is fixed by the fixture rather than
-- left to the walk's random seed.
select public.apply_draw(
  '00000000-0000-0000-0000-00000000d1e1'::uuid,
  '00000000-0000-0000-0000-00000000d1f1'::uuid,
  '00000000-0000-0000-0000-00000000d1c1'::uuid,
  jsonb_build_array(jsonb_build_object(
    'promotion_prize_id', '00000000-0000-0000-0000-00000000d1a1', 'quantity', 4)),
  array['00000000-0000-0000-0000-00000000d121', '00000000-0000-0000-0000-00000000d122',
        '00000000-0000-0000-0000-00000000d123', '00000000-0000-0000-0000-00000000d124']::uuid[]);

-- Same helper as 12_deadline_clock, because apply_draw decides who gets what
-- and an id in an assertion would be a guess:
create function pg_temp.winner_of(p_name text) returns uuid language sql stable as $$
  select w.id from public.winners w
    join public.members m on m.id = w.member_id
   where m.full_name = p_name
     and w.company_id = '00000000-0000-0000-0000-00000000d1c1';
$$;

-- The four states the sweep must tell apart. Set directly, because the point
-- is the sweep's predicate and not how a deadline gets its value.
update public.winners set deadline_at = now() - interval '1 day'
  where id = pg_temp.winner_of('Overdue 6d');
update public.winners set deadline_at = now() + interval '5 days'
  where id = pg_temp.winner_of('InTime 6d');
update public.winners set deadline_at = null
  where id = pg_temp.winner_of('NoDeadline 6d');
update public.winners set deadline_at = now() - interval '1 day'
  where id = pg_temp.winner_of('Delivered 6d');
select public.apply_winner_transition(
  pg_temp.winner_of('Delivered 6d'), 'DELIVERED'::public.winner_status, null);

call public.sweep_pickup_deadlines();

select is((select status::text from public.winners where id = pg_temp.winner_of('Overdue 6d')),
  'RETURN_PENDING', 'the overdue winner expired');

select is((select status::text from public.winners where id = pg_temp.winner_of('InTime 6d')),
  'AWAITING_PICKUP', 'a deadline still in the future is left alone');

-- The rule 0075 wrote down: null means this winner has NO deadline, because
-- neither the promotion nor the prize set one, and a Station that has not
-- configured one has not agreed to a rule. A sweep reading null as zero would
-- start clocks nobody agreed to.
select is((select status::text from public.winners where id = pg_temp.winner_of('NoDeadline 6d')),
  'AWAITING_PICKUP', 'a null deadline is skipped, not treated as expired');

select is((select status::text from public.winners where id = pg_temp.winner_of('Delivered 6d')),
  'DELIVERED', 'a delivered prize is not expired out from under the operator');

call public.sweep_pickup_deadlines();

select is((select status::text from public.winners where id = pg_temp.winner_of('Overdue 6d')),
  'RETURN_PENDING', 'running twice changes nothing the first run did');

select is(
  (select count(*)::integer from public.inventory_movements
    where movement_type = 'RETURN_PENDING'
      and prize_id = '00000000-0000-0000-0000-00000000d1d1'),
  1, 'and emits no second movement');

-- ---------------------------------------------------------------------------
-- THE CANCELLED-DRAW FIXTURE, inserted between the first fixture above and
-- the poison fixture below rather than after it: at this point Overdue 6d has
-- already left AWAITING_PICKUP and nothing else in this Station is due, so
-- the extra sweep call this section adds cannot reprocess anything the
-- assertions above already checked, and it runs before the poison fixture
-- breaks a balance on purpose. A winner whose DRAW was cancelled, built the way
-- cancel_draw (0079) actually leaves one: its unit reversed back to `linked`
-- through the same apply_inventory_movement call cancel_draw itself makes,
-- draws.status set to CANCELLED, and winners.status left UNTOUCHED at
-- AWAITING_PICKUP -- 6a had no vocabulary for "un-awarded", and 0079's own
-- header says so. Before this block that combination was inert. It is not
-- any more: sweep_pickup_deadlines selects on winners.status alone, so
-- without the join this task's review added, this winner matches every
-- clause (AWAITING_PICKUP, a real deadline, overdue) while its actual unit
-- sits in `linked`, not `awaiting_pickup` -- and NOTHING else in this Station
-- holds a live unit of this prize, so a naive sweep would fail this winner's
-- movement (balance CHECK, insufficient awaiting_pickup), count it as
-- failed, and this procedure's own end-of-loop guard would raise. This file
-- has no ON_ERROR_STOP toggle here (unlike the poison fixture below, which
-- adds one because IT expects the raise): a regression that dropped the
-- join would abort THIS script at the CALL two statements down, and every
-- assertion after it -- including the whole poison fixture -- would never
-- run, which is exactly the mutation check this task's report records by
-- hand. Same Station as the first fixture (...00d1c1): every id below is
-- already covered by that fixture's own cleanup, except the cancelling
-- actor, cleaned up separately above and below.

insert into public.prizes (id, organization_id, company_id, name) values
  ('00000000-0000-0000-0000-00000000d1d4', '00000000-0000-0000-0000-00000000d1f1',
   '00000000-0000-0000-0000-00000000d1c1', 'Cancelled draw prize 6d sweep');

insert into public.inventory_balances (company_id, prize_id, organization_id, available)
values ('00000000-0000-0000-0000-00000000d1c1', '00000000-0000-0000-0000-00000000d1d4',
        '00000000-0000-0000-0000-00000000d1f1', 1);

insert into public.promotion_prizes (id, promotion_id, prize_id, organization_id, company_id)
values ('00000000-0000-0000-0000-00000000d1a4', '00000000-0000-0000-0000-00000000d1e1',
        '00000000-0000-0000-0000-00000000d1d4', '00000000-0000-0000-0000-00000000d1f1',
        '00000000-0000-0000-0000-00000000d1c1');

select public.apply_inventory_movement(
  '00000000-0000-0000-0000-00000000d1c1'::uuid, '00000000-0000-0000-0000-00000000d1d4'::uuid,
  'PROMOTION_LINK'::public.inventory_movement_type, 1,
  'available'::public.inventory_bucket, 'linked'::public.inventory_bucket,
  null, null, '00000000-0000-0000-0000-00000000d1a4'::uuid);

insert into public.members (id, organization_id, full_name) values
  ('00000000-0000-0000-0000-00000000d117', '00000000-0000-0000-0000-00000000d1f1', 'CancelledDraw 6d');
insert into public.member_company_links (member_id, company_id, organization_id) values
  ('00000000-0000-0000-0000-00000000d117', '00000000-0000-0000-0000-00000000d1c1',
   '00000000-0000-0000-0000-00000000d1f1');

insert into public.participations
  (id, promotion_id, member_id, organization_id, company_id, allows_multiple,
   status, source, participated_at)
values
  ('00000000-0000-0000-0000-00000000d127', '00000000-0000-0000-0000-00000000d1e1',
   '00000000-0000-0000-0000-00000000d117', '00000000-0000-0000-0000-00000000d1f1',
   '00000000-0000-0000-0000-00000000d1c1', false, 'VALID', 'MANUAL', now() - interval '1 hour');

select public.apply_draw(
  '00000000-0000-0000-0000-00000000d1e1'::uuid,
  '00000000-0000-0000-0000-00000000d1f1'::uuid,
  '00000000-0000-0000-0000-00000000d1c1'::uuid,
  jsonb_build_array(jsonb_build_object(
    'promotion_prize_id', '00000000-0000-0000-0000-00000000d1a4', 'quantity', 1)),
  array['00000000-0000-0000-0000-00000000d127']::uuid[]);

update public.winners set deadline_at = now() - interval '1 day'
  where id = pg_temp.winner_of('CancelledDraw 6d');

-- The reversal cancel_draw itself performs -- awaiting_pickup back to
-- linked, through the ledger's one writer -- BEFORE draws.status is touched,
-- the same order cancel_draw's own body uses.
select public.apply_inventory_movement(
  '00000000-0000-0000-0000-00000000d1c1'::uuid, '00000000-0000-0000-0000-00000000d1d4'::uuid,
  'DRAW_CANCEL'::public.inventory_movement_type, 1,
  'awaiting_pickup'::public.inventory_bucket, 'linked'::public.inventory_bucket,
  null, 'fixture:cancel-draw-mirror',
  '00000000-0000-0000-0000-00000000d1a4'::uuid);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-00000000d1ab', 'sweep-canceller@example.test');

update public.draws set
  status = 'CANCELLED',
  cancelled_at = now(),
  cancelled_by = '00000000-0000-0000-0000-00000000d1ab',
  cancellation_reason = 'fixture: mirrors cancel_draw for the sweep exclusion case'
where id = (select draw_id from public.winners where id = pg_temp.winner_of('CancelledDraw 6d'));

-- Nothing else in this Station is currently due (Overdue 6d already
-- RETURN_PENDING, InTime/NoDeadline not due, Delivered not AWAITING_PICKUP
-- at all) -- so this call's candidate set is exactly {CancelledDraw 6d} under
-- the join, and empty under it.
call public.sweep_pickup_deadlines();

-- Reached only if the CALL above did not raise. Under the unfixed query
-- (verified by mutation, recorded in the task report) this line is never
-- executed at all: the CALL raises 'pickup deadline sweep: 1 of 1 due
-- winner(s) failed', ON_ERROR_STOP aborts the script here, and pg_prove
-- reports every assertion below as never run.
select pass('the sweep did not raise for a winner whose draw was cancelled');

select is((select status::text from public.winners where id = pg_temp.winner_of('CancelledDraw 6d')),
  'AWAITING_PICKUP', 'the cancelled draw''s winner is untouched -- it is not awaiting anything, but the sweep did not touch it either');

select is(
  (select awaiting_pickup from public.inventory_balances
    where company_id = '00000000-0000-0000-0000-00000000d1c1'
      and prize_id = '00000000-0000-0000-0000-00000000d1d4'),
  0, 'nothing moved into pending_return: the unit was already back in linked');

select is(
  (select linked from public.inventory_balances
    where company_id = '00000000-0000-0000-0000-00000000d1c1'
      and prize_id = '00000000-0000-0000-0000-00000000d1d4'),
  1, 'and the unit reversed by the cancellation stayed exactly where it was left');

-- ---------------------------------------------------------------------------
-- THE SECOND FIXTURE, for D6. A SECOND Station, ...00d1c2, with two overdue
-- winners on two DIFFERENT prizes -- 'Poison 6d' (...00d1d2) and 'Neighbour
-- 6d' (...00d1d3), one unit each, held by listeners 'Poisoned 6d' and
-- 'Neighbour 6d'.
--
-- An earlier version of this file tried to prove D6 more directly, by giving
-- a SECOND winner the same overdue deadline as Overdue 6d above (both
-- succeeding, no poisoning) and asserting count(distinct xmin) = 2 across the
-- pair -- xmin being the id of the transaction that last wrote a row.
-- Measured, and it does not discriminate: xmin is type xid, which has no
-- ordering operator class (count(distinct xmin) itself fails to plan --
-- `could not identify an ordering operator for type xid` -- before the more
-- important problem is even reached), and once cast to text for the
-- comparison, TWO ROWS WRITTEN IN SEPARATE begin...exception...end BLOCKS,
-- WITH NO COMMIT BETWEEN THEM, ALREADY CARRY DIFFERENT xmin VALUES. Verified
-- directly: two INSERTs inside two separate exception blocks in one DO block,
-- same top-level transaction, no explicit commit anywhere, produced xmin
-- 2422 and 2423. The mandated `begin ... exception when others` around every
-- iteration is itself an implicit SAVEPOINT, and Postgres assigns a
-- subtransaction its own transaction id lazily, on its first write, whether
-- or not that subtransaction is ever rolled back. So two winners processed in
-- two loop iterations get two different xmins purely from the exception
-- block every iteration already has -- which is mandated and pre-existing --
-- with or without the `commit;` this task adds. xmin cannot tell "committed
-- separately" apart from "merely handled in separate exception blocks," and
-- the mutation this file's assertions are all meant to survive (removing
-- `commit;` and confirming the RIGHT ones go red) proved it: with `commit;`
-- deleted, that xmin assertion stayed green.
--
-- What DOES discriminate, found by taking the mutation seriously rather than
-- trusting the assertion's own name: THIS fixture, together with the
-- procedure's own raise-if-any-failed (added for the cron.job_run_details
-- finding below). Poisoned 6d's failure means v_failed > 0, so the procedure
-- raises after the loop -- but by then, with real per-iteration commits,
-- Neighbour 6d's success is already durable, and the raise costs it nothing.
-- Delete the `commit;` statement (there is exactly one, inside the loop) and
-- rerun this fixture and the raise still fires (Poisoned still fails), but
-- now there was never a commit checkpoint
-- to protect Neighbour 6d's own success from it: the raise aborts the WHOLE
-- transaction the loop has been running in, and Neighbour 6d's transition is
-- rolled back right along with Poisoned 6d's -- measured, and it is exactly
-- assertions 9 and 10 below, and only those, that go red. That is what "commit
-- per winner" (D6) actually buys: not merely that one winner's OWN exception
-- cannot corrupt its neighbour (the exception block already guarantees that,
-- commit or not) but that a LATER winner's failure -- or, as here, the
-- summary raise after the whole batch -- cannot reach back and undo an
-- EARLIER winner's already-finished success.
--
-- Its own Station rather than a second link in the first, so that poisoning
-- one balance below cannot bleed into the assertions already read.
--
-- Two prizes and not one, deliberately: apply_inventory_movement locks and
-- reads the balance of the prize it is moving, so a single zeroed balance
-- shared by both winners would fail both and prove nothing about isolation
-- between iterations.

insert into public.organizations (id, name) values
  ('00000000-0000-0000-0000-00000000d1f2', 'Org 6d sweep poison');
insert into public.companies (id, organization_id, name, timezone) values
  ('00000000-0000-0000-0000-00000000d1c2', '00000000-0000-0000-0000-00000000d1f2',
   'Station 6d sweep poison', 'America/Sao_Paulo');

insert into public.prizes (id, organization_id, company_id, name) values
  ('00000000-0000-0000-0000-00000000d1d2', '00000000-0000-0000-0000-00000000d1f2',
   '00000000-0000-0000-0000-00000000d1c2', 'Poison 6d'),
  ('00000000-0000-0000-0000-00000000d1d3', '00000000-0000-0000-0000-00000000d1f2',
   '00000000-0000-0000-0000-00000000d1c2', 'Neighbour 6d');

insert into public.inventory_balances (company_id, prize_id, organization_id, available)
values
  ('00000000-0000-0000-0000-00000000d1c2', '00000000-0000-0000-0000-00000000d1d2',
   '00000000-0000-0000-0000-00000000d1f2', 1),
  ('00000000-0000-0000-0000-00000000d1c2', '00000000-0000-0000-0000-00000000d1d3',
   '00000000-0000-0000-0000-00000000d1f2', 1);

insert into public.promotions
  (id, organization_id, company_id, name, starts_at, ends_at)
values
  ('00000000-0000-0000-0000-00000000d1e2', '00000000-0000-0000-0000-00000000d1f2',
   '00000000-0000-0000-0000-00000000d1c2', 'Promo 6d sweep poison', now() - interval '2 days',
   now() + interval '5 days');

insert into public.promotion_prizes (id, promotion_id, prize_id, organization_id, company_id)
values
  ('00000000-0000-0000-0000-00000000d1a2', '00000000-0000-0000-0000-00000000d1e2',
   '00000000-0000-0000-0000-00000000d1d2', '00000000-0000-0000-0000-00000000d1f2',
   '00000000-0000-0000-0000-00000000d1c2'),
  ('00000000-0000-0000-0000-00000000d1a3', '00000000-0000-0000-0000-00000000d1e2',
   '00000000-0000-0000-0000-00000000d1d3', '00000000-0000-0000-0000-00000000d1f2',
   '00000000-0000-0000-0000-00000000d1c2');

select public.apply_inventory_movement(
  '00000000-0000-0000-0000-00000000d1c2'::uuid,
  '00000000-0000-0000-0000-00000000d1d2'::uuid,
  'PROMOTION_LINK'::public.inventory_movement_type, 1,
  'available'::public.inventory_bucket, 'linked'::public.inventory_bucket,
  null, null,
  '00000000-0000-0000-0000-00000000d1a2'::uuid);

select public.apply_inventory_movement(
  '00000000-0000-0000-0000-00000000d1c2'::uuid,
  '00000000-0000-0000-0000-00000000d1d3'::uuid,
  'PROMOTION_LINK'::public.inventory_movement_type, 1,
  'available'::public.inventory_bucket, 'linked'::public.inventory_bucket,
  null, null,
  '00000000-0000-0000-0000-00000000d1a3'::uuid);

insert into public.members (id, organization_id, full_name) values
  ('00000000-0000-0000-0000-00000000d115', '00000000-0000-0000-0000-00000000d1f2', 'Poisoned 6d'),
  ('00000000-0000-0000-0000-00000000d116', '00000000-0000-0000-0000-00000000d1f2', 'Neighbour 6d');

insert into public.member_company_links (member_id, company_id, organization_id) values
  ('00000000-0000-0000-0000-00000000d115', '00000000-0000-0000-0000-00000000d1c2',
   '00000000-0000-0000-0000-00000000d1f2'),
  ('00000000-0000-0000-0000-00000000d116', '00000000-0000-0000-0000-00000000d1c2',
   '00000000-0000-0000-0000-00000000d1f2');

insert into public.participations
  (id, promotion_id, member_id, organization_id, company_id, allows_multiple,
   status, source, participated_at)
values
  ('00000000-0000-0000-0000-00000000d125', '00000000-0000-0000-0000-00000000d1e2',
   '00000000-0000-0000-0000-00000000d115', '00000000-0000-0000-0000-00000000d1f2',
   '00000000-0000-0000-0000-00000000d1c2', false, 'VALID', 'MANUAL', now() - interval '3 hours'),
  ('00000000-0000-0000-0000-00000000d126', '00000000-0000-0000-0000-00000000d1e2',
   '00000000-0000-0000-0000-00000000d116', '00000000-0000-0000-0000-00000000d1f2',
   '00000000-0000-0000-0000-00000000d1c2', false, 'VALID', 'MANUAL', now() - interval '2 hours');

-- Two draws, one per prize, so each listener is awarded the unit the fixture
-- names them for rather than left to the walk's random seed.
select public.apply_draw(
  '00000000-0000-0000-0000-00000000d1e2'::uuid,
  '00000000-0000-0000-0000-00000000d1f2'::uuid,
  '00000000-0000-0000-0000-00000000d1c2'::uuid,
  jsonb_build_array(jsonb_build_object(
    'promotion_prize_id', '00000000-0000-0000-0000-00000000d1a2', 'quantity', 1)),
  array['00000000-0000-0000-0000-00000000d125']::uuid[]);

select public.apply_draw(
  '00000000-0000-0000-0000-00000000d1e2'::uuid,
  '00000000-0000-0000-0000-00000000d1f2'::uuid,
  '00000000-0000-0000-0000-00000000d1c2'::uuid,
  jsonb_build_array(jsonb_build_object(
    'promotion_prize_id', '00000000-0000-0000-0000-00000000d1a3', 'quantity', 1)),
  array['00000000-0000-0000-0000-00000000d126']::uuid[]);

-- Both overdue: the point under test is the SECOND one succeeding despite the
-- first's failure, not which winners are due.
update public.winners w
   set deadline_at = now() - interval '1 day'
  from public.members m
 where w.member_id = m.id
   and w.company_id = '00000000-0000-0000-0000-00000000d1c2'
   and m.full_name in ('Poisoned 6d', 'Neighbour 6d');

-- The balance is driven to an impossible figure behind the ledger's back --
-- the only way to make one movement fail while its neighbour succeeds. Without
-- this test, "commit per winner" (D6) is an intention living in a comment --
-- see this fixture's own header comment for what actually makes it discriminate
-- (the interaction with the procedure's raise-if-any-failed, not merely the
-- per-iteration exception handling on its own).
update public.inventory_balances
   set awaiting_pickup = 0
 where company_id = '00000000-0000-0000-0000-00000000d1c2'
   and prize_id = '00000000-0000-0000-0000-00000000d1d2';

-- This CALL is now expected to raise: the procedure raises an exception when
-- v_failed > 0 (fix for the finding that cron.job_run_details could not
-- otherwise tell a clean run from a total failure), and Poisoned 6d above is
-- built to fail. Every successful winner -- Neighbour 6d included -- is
-- already committed by the time that final raise happens, so the exception
-- costs nothing already done; it only means this plain script, which has no
-- exception handler of its own, must be told not to abort on it. Nesting the
-- CALL inside a DO block to catch it does not work: that reproduces `invalid
-- transaction termination` at the procedure's own COMMIT, the same restriction
-- that rules out SECURITY DEFINER and search_path pinning (0094's header
-- comment) -- a procedure with internal transaction control must be invoked
-- as a bare top-level CALL and nothing else, so the only way to tolerate its
-- expected failure here is to tell psql itself not to stop.
--
-- Saved and restored rather than hard-coded back to "on": this file does not
-- own the harness's own default (pg_prove sets ON_ERROR_STOP=1, but a bare
-- `psql -f` defaults it off), so hard-coding "on" here would silently change
-- that default for the rest of the file under a plain `psql -f` run -- any
-- later error would then abort before this file's own teardown runs, instead
-- of behaving the way the rest of the file already assumed. Verified the
-- save/restore round-trips correctly both ways: invoked without
-- `-v ON_ERROR_STOP=1`, a later error after the restore still does not abort
-- the script; invoked with it (pg_prove's own default), a later error after
-- the restore does.
\set saved_on_error_stop :ON_ERROR_STOP
\set ON_ERROR_STOP off
call public.sweep_pickup_deadlines();
\set ON_ERROR_STOP :saved_on_error_stop

select is(
  (select status::text from public.winners w join public.members m on m.id = w.member_id
    where m.full_name = 'Poisoned 6d'
      and w.company_id = '00000000-0000-0000-0000-00000000d1c2'),
  'AWAITING_PICKUP', 'the poisoned winner did not move');

select is(
  (select status::text from public.winners w join public.members m on m.id = w.member_id
    where m.full_name = 'Neighbour 6d'
      and w.company_id = '00000000-0000-0000-0000-00000000d1c2'),
  'RETURN_PENDING', 'and its neighbour expired anyway -- the commit held');

select is(
  (select count(*)::integer from public.winners
    where company_id = '00000000-0000-0000-0000-00000000d1c2'
      and status = 'RETURN_PENDING'),
  1, 'exactly one of the pair went through');

select * from finish();

-- Clean up, children first: this file did not roll back. A foreign-key
-- violation here fails the file AFTER its assertions have already passed,
-- which is a confusing way to find out, so every child of every table this
-- fixture touched is accounted for before the parent it depends on.

delete from public.winner_status_history
 where company_id = '00000000-0000-0000-0000-00000000d1c1';
delete from public.winners where company_id = '00000000-0000-0000-0000-00000000d1c1';
delete from public.draw_entries where company_id = '00000000-0000-0000-0000-00000000d1c1';
delete from public.draws where company_id = '00000000-0000-0000-0000-00000000d1c1';
delete from public.inventory_movements
 where company_id = '00000000-0000-0000-0000-00000000d1c1';
delete from public.inventory_balances
 where company_id = '00000000-0000-0000-0000-00000000d1c1';
delete from public.participations where company_id = '00000000-0000-0000-0000-00000000d1c1';
-- promotion_prize_balances is a child of promotion_prizes too
-- (0045_promotion_prizes.sql's promotion_prize_balances_link_fk, on
-- (promotion_prize_id, prize_id, company_id)) and has to go before it, or the
-- delete two lines down raises a foreign-key violation after every assertion
-- above has already passed.
delete from public.promotion_prize_balances
 where company_id = '00000000-0000-0000-0000-00000000d1c1';
delete from public.promotion_prizes where company_id = '00000000-0000-0000-0000-00000000d1c1';
delete from public.promotions where company_id = '00000000-0000-0000-0000-00000000d1c1';
delete from public.prizes where company_id = '00000000-0000-0000-0000-00000000d1c1';
delete from public.member_company_links where company_id = '00000000-0000-0000-0000-00000000d1c1';
delete from public.members where organization_id = '00000000-0000-0000-0000-00000000d1f1';
delete from public.audit_logs where company_id = '00000000-0000-0000-0000-00000000d1c1';
delete from public.companies where id = '00000000-0000-0000-0000-00000000d1c1';
delete from public.organizations where id = '00000000-0000-0000-0000-00000000d1f1';

-- The second Station, the same way.
delete from public.winner_status_history
 where company_id = '00000000-0000-0000-0000-00000000d1c2';
delete from public.winners where company_id = '00000000-0000-0000-0000-00000000d1c2';
delete from public.draw_entries where company_id = '00000000-0000-0000-0000-00000000d1c2';
delete from public.draws where company_id = '00000000-0000-0000-0000-00000000d1c2';
delete from public.inventory_movements
 where company_id = '00000000-0000-0000-0000-00000000d1c2';
delete from public.inventory_balances
 where company_id = '00000000-0000-0000-0000-00000000d1c2';
delete from public.participations where company_id = '00000000-0000-0000-0000-00000000d1c2';
delete from public.promotion_prize_balances
 where company_id = '00000000-0000-0000-0000-00000000d1c2';
delete from public.promotion_prizes where company_id = '00000000-0000-0000-0000-00000000d1c2';
delete from public.promotions where company_id = '00000000-0000-0000-0000-00000000d1c2';
delete from public.prizes where company_id = '00000000-0000-0000-0000-00000000d1c2';
delete from public.member_company_links where company_id = '00000000-0000-0000-0000-00000000d1c2';
delete from public.members where organization_id = '00000000-0000-0000-0000-00000000d1f2';
delete from public.audit_logs where company_id = '00000000-0000-0000-0000-00000000d1c2';
delete from public.companies where id = '00000000-0000-0000-0000-00000000d1c2';
delete from public.organizations where id = '00000000-0000-0000-0000-00000000d1f2';

-- The cancellation actor the cancelled-draw fixture created.
delete from auth.users where id = '00000000-0000-0000-0000-00000000d1ab';
