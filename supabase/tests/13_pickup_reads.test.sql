begin;
select plan(29);

-- Block 6d, Task 5: the pickups list, as one function.
--
-- Fixtures live in the ...00d2xx range. 12_deadline_clock owns ...00d0xx and
-- 12b_deadline_sweep owns ...00d1xx; a collision would fail in whichever file
-- ran second.
--
-- This file walks the keyset, the two filters and the total_count -- the
-- mechanics list_pickups shares with list_participations (0090). The four
-- rules SECURITY DEFINER stopped applying for free (the permission gate
-- itself aside, which pgTAP does exercise here) are pinned in
-- tests/isolation/pickups.test.ts instead: an archived promotion's winners,
-- names withheld without members.view, and a search-without-members.view
-- oracle all need a REAL second user with a REAL, narrower grant to mean
-- anything, which is exactly what pgTAP -- a single unauthenticated or
-- single-role session per statement -- cannot cheaply set up twice over.
--
-- Case 11 is the exception: a cancelled draw's winner is a fact pgTAP CAN
-- see on its own, because it is not gated on who is asking. It was added in
-- this task's own review round, alongside the identical exclusion in
-- sweep_pickup_deadlines (0094) -- see that migration's header for what
-- happens without it.

insert into public.organizations (id, name) values
  ('00000000-0000-0000-0000-00000000d2f1', 'Org 6d pickups');
insert into public.companies (id, organization_id, name, timezone) values
  ('00000000-0000-0000-0000-00000000d2c1', '00000000-0000-0000-0000-00000000d2f1',
   'Station 6d pickups', 'America/Sao_Paulo');

-- Two prizes, one per promotion below, so the promotion filter and the
-- prize/promotion columns in the result are never accidentally right because
-- there was only ever one of each in the fixture.
insert into public.prizes (id, organization_id, company_id, name, allows_return_to_stock)
values
  ('00000000-0000-0000-0000-00000000d2d1', '00000000-0000-0000-0000-00000000d2f1',
   '00000000-0000-0000-0000-00000000d2c1', 'Speaker 6d list', true),
  ('00000000-0000-0000-0000-00000000d2d2', '00000000-0000-0000-0000-00000000d2f1',
   '00000000-0000-0000-0000-00000000d2c1', 'Trip 6d list', false);

insert into public.promotions
  (id, organization_id, company_id, name, starts_at, ends_at)
values
  ('00000000-0000-0000-0000-00000000d2e1', '00000000-0000-0000-0000-00000000d2f1',
   '00000000-0000-0000-0000-00000000d2c1', 'List promo A', now() - interval '9 days',
   now() + interval '1 day'),
  ('00000000-0000-0000-0000-00000000d2e2', '00000000-0000-0000-0000-00000000d2f1',
   '00000000-0000-0000-0000-00000000d2c1', 'List promo B', now() - interval '9 days',
   now() + interval '1 day');

insert into public.promotion_prizes (id, promotion_id, prize_id, organization_id, company_id)
values
  ('00000000-0000-0000-0000-00000000d2a1', '00000000-0000-0000-0000-00000000d2e1',
   '00000000-0000-0000-0000-00000000d2d1', '00000000-0000-0000-0000-00000000d2f1',
   '00000000-0000-0000-0000-00000000d2c1'),
  ('00000000-0000-0000-0000-00000000d2a2', '00000000-0000-0000-0000-00000000d2e2',
   '00000000-0000-0000-0000-00000000d2d2', '00000000-0000-0000-0000-00000000d2f1',
   '00000000-0000-0000-0000-00000000d2c1');

insert into public.members (id, organization_id, full_name) values
  ('00000000-0000-0000-0000-00000000d211', '00000000-0000-0000-0000-00000000d2f1', 'Listener One'),
  ('00000000-0000-0000-0000-00000000d212', '00000000-0000-0000-0000-00000000d2f1', 'Listener Two'),
  ('00000000-0000-0000-0000-00000000d213', '00000000-0000-0000-0000-00000000d2f1', 'Listener Three'),
  ('00000000-0000-0000-0000-00000000d214', '00000000-0000-0000-0000-00000000d2f1', 'Listener Four'),
  ('00000000-0000-0000-0000-00000000d215', '00000000-0000-0000-0000-00000000d2f1', 'Listener Five'),
  ('00000000-0000-0000-0000-00000000d216', '00000000-0000-0000-0000-00000000d2f1', 'Listener Six');

insert into public.member_company_links (member_id, company_id, organization_id)
select id, '00000000-0000-0000-0000-00000000d2c1', '00000000-0000-0000-0000-00000000d2f1'
from public.members where organization_id = '00000000-0000-0000-0000-00000000d2f1';

insert into public.participations
  (id, promotion_id, member_id, organization_id, company_id, allows_multiple,
   status, source, participated_at)
values
  ('00000000-0000-0000-0000-00000000d221', '00000000-0000-0000-0000-00000000d2e1',
   '00000000-0000-0000-0000-00000000d211', '00000000-0000-0000-0000-00000000d2f1',
   '00000000-0000-0000-0000-00000000d2c1', false, 'VALID', 'MANUAL', now() - interval '5 hours'),
  ('00000000-0000-0000-0000-00000000d222', '00000000-0000-0000-0000-00000000d2e1',
   '00000000-0000-0000-0000-00000000d212', '00000000-0000-0000-0000-00000000d2f1',
   '00000000-0000-0000-0000-00000000d2c1', false, 'VALID', 'MANUAL', now() - interval '4 hours'),
  ('00000000-0000-0000-0000-00000000d223', '00000000-0000-0000-0000-00000000d2e1',
   '00000000-0000-0000-0000-00000000d213', '00000000-0000-0000-0000-00000000d2f1',
   '00000000-0000-0000-0000-00000000d2c1', false, 'VALID', 'MANUAL', now() - interval '3 hours'),
  ('00000000-0000-0000-0000-00000000d224', '00000000-0000-0000-0000-00000000d2e1',
   '00000000-0000-0000-0000-00000000d214', '00000000-0000-0000-0000-00000000d2f1',
   '00000000-0000-0000-0000-00000000d2c1', false, 'VALID', 'MANUAL', now() - interval '2 hours'),
  ('00000000-0000-0000-0000-00000000d225', '00000000-0000-0000-0000-00000000d2e1',
   '00000000-0000-0000-0000-00000000d215', '00000000-0000-0000-0000-00000000d2f1',
   '00000000-0000-0000-0000-00000000d2c1', false, 'VALID', 'MANUAL', now() - interval '1 hours'),
  ('00000000-0000-0000-0000-00000000d226', '00000000-0000-0000-0000-00000000d2e2',
   '00000000-0000-0000-0000-00000000d216', '00000000-0000-0000-0000-00000000d2f1',
   '00000000-0000-0000-0000-00000000d2c1', false, 'VALID', 'MANUAL', now() - interval '6 hours');

-- Two completed draws, one per promotion. Written by hand rather than through
-- run_draw/apply_draw: what is under test is the READ, and driving the whole
-- draw machinery to get five winners would make a failure here mean five
-- different things, the same reasoning 11_filtered_hat.test.sql's eligibility
-- section gives for inserting winners directly.
insert into public.draws
  (id, promotion_id, organization_id, company_id, seed, algorithm_version, entry_count, offered_count)
values
  ('00000000-0000-0000-0000-00000000d231', '00000000-0000-0000-0000-00000000d2e1',
   '00000000-0000-0000-0000-00000000d2f1', '00000000-0000-0000-0000-00000000d2c1',
   repeat('1', 64), 1, 5, 5),
  ('00000000-0000-0000-0000-00000000d232', '00000000-0000-0000-0000-00000000d2e2',
   '00000000-0000-0000-0000-00000000d2f1', '00000000-0000-0000-0000-00000000d2c1',
   repeat('2', 64), 1, 1, 1);

-- Six winners. Five on promo A with a spread of deadlines -- including one
-- with NO deadline at all, the terminal null region -- and one on promo B,
-- held back for the promotion filter.
insert into public.winners
  (id, draw_id, company_id, promotion_prize_id, member_id, participation_id,
   awarded_rank, status, deadline_at)
values
  ('00000000-0000-0000-0000-00000000d2b1', '00000000-0000-0000-0000-00000000d231',
   '00000000-0000-0000-0000-00000000d2c1', '00000000-0000-0000-0000-00000000d2a1',
   '00000000-0000-0000-0000-00000000d211', '00000000-0000-0000-0000-00000000d221',
   1, 'AWAITING_PICKUP', now() + interval '1 day'),
  ('00000000-0000-0000-0000-00000000d2b2', '00000000-0000-0000-0000-00000000d231',
   '00000000-0000-0000-0000-00000000d2c1', '00000000-0000-0000-0000-00000000d2a1',
   '00000000-0000-0000-0000-00000000d212', '00000000-0000-0000-0000-00000000d222',
   2, 'AWAITING_PICKUP', now() + interval '2 days'),
  -- The one already resting in RETURN_PENDING -- the status filter's target.
  ('00000000-0000-0000-0000-00000000d2b3', '00000000-0000-0000-0000-00000000d231',
   '00000000-0000-0000-0000-00000000d2c1', '00000000-0000-0000-0000-00000000d2a1',
   '00000000-0000-0000-0000-00000000d213', '00000000-0000-0000-0000-00000000d223',
   3, 'RETURN_PENDING', now() + interval '3 days'),
  ('00000000-0000-0000-0000-00000000d2b4', '00000000-0000-0000-0000-00000000d231',
   '00000000-0000-0000-0000-00000000d2c1', '00000000-0000-0000-0000-00000000d2a1',
   '00000000-0000-0000-0000-00000000d214', '00000000-0000-0000-0000-00000000d224',
   4, 'AWAITING_PICKUP', now() + interval '4 days'),
  -- No deadline at all: neither the promotion nor the prize set one (spec 6).
  ('00000000-0000-0000-0000-00000000d2b5', '00000000-0000-0000-0000-00000000d231',
   '00000000-0000-0000-0000-00000000d2c1', '00000000-0000-0000-0000-00000000d2a1',
   '00000000-0000-0000-0000-00000000d215', '00000000-0000-0000-0000-00000000d225',
   5, 'AWAITING_PICKUP', null),
  -- The OTHER promotion's only winner -- the promotion filter's target.
  ('00000000-0000-0000-0000-00000000d2b6', '00000000-0000-0000-0000-00000000d232',
   '00000000-0000-0000-0000-00000000d2c1', '00000000-0000-0000-0000-00000000d2a2',
   '00000000-0000-0000-0000-00000000d216', '00000000-0000-0000-0000-00000000d226',
   1, 'AWAITING_PICKUP', now() + interval '10 days');

-- ---------------------------------------------------------------------------
-- A THIRD promotion, holding exactly one winner whose DRAW was cancelled --
-- built by hand into the shape cancel_draw (0079) actually leaves, rather
-- than through cancel_draw itself (which needs an authenticated actor holding
-- draws.cancel, and what is under test here is the READ, not the cancellation
-- door): draws.status = CANCELLED with the three facts
-- draws_cancellation_shape requires, and winners.status left UNTOUCHED at
-- AWAITING_PICKUP -- 6a had no vocabulary for "un-awarded", 0079's own header
-- says so in as many words. Its own promotion, separate from A and B, so a
-- regression here cannot hide behind the paging fixture's own counts.

insert into public.promotions
  (id, organization_id, company_id, name, starts_at, ends_at)
values
  ('00000000-0000-0000-0000-00000000d2e3', '00000000-0000-0000-0000-00000000d2f1',
   '00000000-0000-0000-0000-00000000d2c1', 'List promo C (cancelled draw)',
   now() - interval '9 days', now() + interval '1 day');

insert into public.promotion_prizes (id, promotion_id, prize_id, organization_id, company_id)
values
  ('00000000-0000-0000-0000-00000000d2a3', '00000000-0000-0000-0000-00000000d2e3',
   '00000000-0000-0000-0000-00000000d2d1', '00000000-0000-0000-0000-00000000d2f1',
   '00000000-0000-0000-0000-00000000d2c1');

insert into public.members (id, organization_id, full_name) values
  ('00000000-0000-0000-0000-00000000d217', '00000000-0000-0000-0000-00000000d2f1', 'Listener Seven');
insert into public.member_company_links (member_id, company_id, organization_id) values
  ('00000000-0000-0000-0000-00000000d217', '00000000-0000-0000-0000-00000000d2c1',
   '00000000-0000-0000-0000-00000000d2f1');

insert into public.participations
  (id, promotion_id, member_id, organization_id, company_id, allows_multiple,
   status, source, participated_at)
values
  ('00000000-0000-0000-0000-00000000d228', '00000000-0000-0000-0000-00000000d2e3',
   '00000000-0000-0000-0000-00000000d217', '00000000-0000-0000-0000-00000000d2f1',
   '00000000-0000-0000-0000-00000000d2c1', false, 'VALID', 'MANUAL', now() - interval '7 hours');

-- draws_cancellation_shape (0075) requires a real actor for cancelled_by.
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-00000000d2aa', 'pickup-list-canceller@example.test');

insert into public.draws
  (id, promotion_id, organization_id, company_id, seed, algorithm_version, entry_count,
   offered_count, status, cancelled_at, cancelled_by, cancellation_reason)
values
  ('00000000-0000-0000-0000-00000000d233', '00000000-0000-0000-0000-00000000d2e3',
   '00000000-0000-0000-0000-00000000d2f1', '00000000-0000-0000-0000-00000000d2c1',
   repeat('3', 64), 1, 1, 1, 'CANCELLED', now(), '00000000-0000-0000-0000-00000000d2aa',
   'fixture: proves a cancelled draw''s winner does not list as a pickup');

insert into public.winners
  (id, draw_id, company_id, promotion_prize_id, member_id, participation_id,
   awarded_rank, status, deadline_at)
values
  ('00000000-0000-0000-0000-00000000d2b7', '00000000-0000-0000-0000-00000000d233',
   '00000000-0000-0000-0000-00000000d2c1', '00000000-0000-0000-0000-00000000d2a3',
   '00000000-0000-0000-0000-00000000d217', '00000000-0000-0000-0000-00000000d228',
   1, 'AWAITING_PICKUP', now() + interval '1 day');

-- ---------------------------------------------------------------------------
-- Block 6d, Task 6: list_movements fixtures. Reuses the org, the Station, the
-- two prizes above (d2d1, d2d2) and List promo A's own live link (d2a1) --
-- promo A's name is exercised by data that already exists here rather than a
-- fourth copy of it. Adds exactly one further promotion, ALREADY ARCHIVED by
-- direct insert -- the identical reasoning the winners/draws fixtures above
-- give for building state by hand: what is under test is the READ.

insert into public.promotions
  (id, organization_id, company_id, name, starts_at, ends_at, deleted_at, deleted_by)
values
  ('00000000-0000-0000-0000-00000000d2e4', '00000000-0000-0000-0000-00000000d2f1',
   '00000000-0000-0000-0000-00000000d2c1', 'List promo D (archived)',
   now() - interval '30 days', now() - interval '20 days',
   now() - interval '10 days', '00000000-0000-0000-0000-00000000d2aa');

insert into public.promotion_prizes (id, promotion_id, prize_id, organization_id, company_id)
values
  ('00000000-0000-0000-0000-00000000d2a4', '00000000-0000-0000-0000-00000000d2e4',
   '00000000-0000-0000-0000-00000000d2d1', '00000000-0000-0000-0000-00000000d2f1',
   '00000000-0000-0000-0000-00000000d2c1');

-- The one caller whose display name list_movements has to resolve. Never
-- signed in through this suite -- actor_id only has to reference a real
-- auth.users row, exactly as pickup-list-canceller@example.test above proves
-- for cancelled_by.
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-00000000d291', 'movements-operator@example.test');
insert into public.profiles (id, email, full_name) values
  ('00000000-0000-0000-0000-00000000d291', 'movements-operator@example.test', 'Operator Six D');

-- A second real actor who never set a display name: full_name is nullable in
-- production (0003, 0013, 0018), so actor_name comes back null here too --
-- the SAME null the clock leaves, told apart only by actor_id, which is
-- non-null for this one and null for the clock's own movement (d277 below).
-- A coalesce onto this profile's email was tried and removed in review: it
-- would put a colleague's email in front of anyone holding inventory.view
-- alone, for a distinction actor_id already draws at no cost.
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-00000000d292', 'movements-noname@example.test');
insert into public.profiles (id, email, full_name) values
  ('00000000-0000-0000-0000-00000000d292', 'movements-noname@example.test', null);

-- Seven movements over both prizes, a live promotion and an archived one, a
-- real actor and a genuinely absent one, and one TIED created_at -- every
-- fact list_movements' own header claims about ordering, the two nullable
-- identities and the three promotion states has to be provable from ROWS.
insert into public.inventory_movements
  (id, organization_id, company_id, prize_id, movement_type, quantity,
   from_bucket, to_bucket, note, actor_id, promotion_prize_id, created_at)
values
  -- No promotion, no actor: an ordinary opening entry.
  ('00000000-0000-0000-0000-00000000d271', '00000000-0000-0000-0000-00000000d2f1',
   '00000000-0000-0000-0000-00000000d2c1', '00000000-0000-0000-0000-00000000d2d1',
   'MANUAL_ENTRY', 10, null, 'available', 'opening stock', null, null,
   now() - interval '5 hours'),
  -- Promo A -- LIVE. promotion_name must come back even though the caller
  -- below never holds promotions.view.
  ('00000000-0000-0000-0000-00000000d272', '00000000-0000-0000-0000-00000000d2f1',
   '00000000-0000-0000-0000-00000000d2c1', '00000000-0000-0000-0000-00000000d2d1',
   'PROMOTION_LINK', 3, 'available', 'linked', null, null,
   '00000000-0000-0000-0000-00000000d2a1', now() - interval '4 hours'),
  -- Promo D -- ARCHIVED. The tri-state case: the row lists, the name does
  -- not, and promotion_archived says which null this is.
  ('00000000-0000-0000-0000-00000000d273', '00000000-0000-0000-0000-00000000d2f1',
   '00000000-0000-0000-0000-00000000d2c1', '00000000-0000-0000-0000-00000000d2d1',
   'PROMOTION_LINK', 2, 'available', 'linked', null, null,
   '00000000-0000-0000-0000-00000000d2a4', now() - interval '3 hours'),
  -- A genuine actor -- resolved to a name, not left null beside the clock's.
  ('00000000-0000-0000-0000-00000000d274', '00000000-0000-0000-0000-00000000d2f1',
   '00000000-0000-0000-0000-00000000d2c1', '00000000-0000-0000-0000-00000000d2d1',
   'MANUAL_EXIT', 1, 'available', null, 'shrinkage',
   '00000000-0000-0000-0000-00000000d291', null, now() - interval '2 hours'),
  -- The OTHER prize, and a TIE with the row below: identical created_at, so
  -- only movement_id desc can be what puts one ahead of the other.
  ('00000000-0000-0000-0000-00000000d275', '00000000-0000-0000-0000-00000000d2f1',
   '00000000-0000-0000-0000-00000000d2c1', '00000000-0000-0000-0000-00000000d2d2',
   'MANUAL_ENTRY', 4, null, 'available', null, null, null,
   now() - interval '1 hour'),
  ('00000000-0000-0000-0000-00000000d276', '00000000-0000-0000-0000-00000000d2f1',
   '00000000-0000-0000-0000-00000000d2c1', '00000000-0000-0000-0000-00000000d2d2',
   'MANUAL_ENTRY', 6, null, 'available', null, null, null,
   now() - interval '1 hour'),
  -- No actor at all: the clock's own shape (0094), for the read this task
  -- adds rather than the write that one already has.
  ('00000000-0000-0000-0000-00000000d277', '00000000-0000-0000-0000-00000000d2f1',
   '00000000-0000-0000-0000-00000000d2c1', '00000000-0000-0000-0000-00000000d2d1',
   'ADJUSTMENT_POSITIVE', 1, null, 'available', 'reconciliation', null, null,
   now() - interval '30 minutes'),
  -- The nameless actor, oldest of all eight so it cannot disturb the
  -- ordering/tie-break cases above, which are pinned to the seven newest.
  ('00000000-0000-0000-0000-00000000d278', '00000000-0000-0000-0000-00000000d2f1',
   '00000000-0000-0000-0000-00000000d2c1', '00000000-0000-0000-0000-00000000d2d1',
   'MANUAL_EXIT', 1, 'available', null, 'shrinkage 2',
   '00000000-0000-0000-0000-00000000d292', null, now() - interval '6 hours');

-- ---------------------------------------------------------------------------
-- Case 1: the permission, first, and a refusal rather than an empty page.
--
-- No jwt claims set at all here -- the same "nobody is authenticated in
-- pgTAP" state 12_deadline_clock.test.sql's own final cases rely on -- so
-- has_permission is false and the function must raise rather than hand back
-- zero rows indistinguishable from "nobody has won anything at this Station".

select throws_ok($$
  select * from public.list_pickups('00000000-0000-0000-0000-00000000d2c1'::uuid)
$$, '42501', null, 'a caller holding no session at all is refused, not shown an empty page');

-- The identical invariant, for list_movements: no jwt claims exist yet in
-- this transaction, so has_permission is false and the function must raise
-- rather than hand back rows from the seven movements just inserted above.
select throws_ok($$
  select * from public.list_movements('00000000-0000-0000-0000-00000000d2c1'::uuid)
$$, '42501', null, 'a caller holding no session at all is refused list_movements too, not shown an empty page');

-- ---------------------------------------------------------------------------
-- The operator for every case below: promotions.view only. members.view is
-- deliberately withheld here too -- names and the search-without-names oracle
-- are pinned in tests/isolation/pickups.test.ts, where a SECOND, narrower-role
-- user actually exists to prove the difference; that is not attempted again
-- here.

insert into public.roles (id, organization_id, name) values
  ('00000000-0000-0000-0000-00000000d241', '00000000-0000-0000-0000-00000000d2f1', 'Pickups reader');
insert into public.role_permissions (role_id, permission_code) values
  ('00000000-0000-0000-0000-00000000d241', 'promotions.view'),
  -- Block 6d, Task 6: this same delegate drives every list_movements
  -- mechanics case below too, holding BOTH permissions. Proving list_movements
  -- needs ONLY inventory.view is tests/isolation/pickups.test.ts's job, with a
  -- caller who holds inventory.view and NOT promotions.view -- pgTAP reuses
  -- this role purely for the keyset/filter/total_count mechanics, the same
  -- division 13's own header draws for list_pickups' four RLS-replacement
  -- rules.
  ('00000000-0000-0000-0000-00000000d241', 'inventory.view');
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-00000000d242', 'pickups-reader@example.test');
insert into public.company_memberships (user_id, company_id, organization_id, role_id) values
  ('00000000-0000-0000-0000-00000000d242', '00000000-0000-0000-0000-00000000d2c1',
   '00000000-0000-0000-0000-00000000d2f1', '00000000-0000-0000-0000-00000000d241');

set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000d242", "role": "authenticated"}';

-- ---------------------------------------------------------------------------
-- The keyset, forward, ordered soonest-first -- ties (there are none in this
-- fixture) broken by id, exactly as list_participations (0090) walks
-- participated_at.

create temporary table page_one as
select * from public.list_pickups(
  '00000000-0000-0000-0000-00000000d2c1', null, '00000000-0000-0000-0000-00000000d2e1',
  null, null, null, false, 2);

-- Case 2. Content, not merely count: a page ordered DESCENDING or unordered
-- would put a different pair here, so this is the "ascending" case.
select ok(
  (select count(*)::int from page_one) = 2
  and exists (select 1 from page_one where winner_id = '00000000-0000-0000-0000-00000000d2b1')
  and exists (select 1 from page_one where winner_id = '00000000-0000-0000-0000-00000000d2b2'),
  'the first page (soonest first) holds exactly the two nearest deadlines');

-- Case 3. total_count computed from the SAME set the rows come from: five
-- winners of promo A regardless of the status filter (none applied here).
select is(
  (select distinct total_count from page_one), 5,
  'total_count is the whole filtered set (5), not the page (2)');

create temporary table page_two as
select * from public.list_pickups(
  '00000000-0000-0000-0000-00000000d2c1', null, '00000000-0000-0000-0000-00000000d2e1',
  null,
  (select max(deadline_at) from page_one),
  (select winner_id from page_one order by deadline_at desc, winner_id desc limit 1),
  false, 2);

-- Case 4. The next two, and only the next two.
select ok(
  (select count(*)::int from page_two) = 2
  and exists (select 1 from page_two where winner_id = '00000000-0000-0000-0000-00000000d2b3')
  and exists (select 1 from page_two where winner_id = '00000000-0000-0000-0000-00000000d2b4'),
  'the second page holds exactly the next two nearest deadlines');

-- Case 5. Consistent across pages: the cursor moved, the filtered set (and
-- therefore its count) did not.
select is(
  (select distinct total_count from page_two), 5,
  'total_count agrees with the first page: a page and its count cannot narrow differently');

create temporary table walked_back as
select * from public.list_pickups(
  '00000000-0000-0000-0000-00000000d2c1', null, '00000000-0000-0000-0000-00000000d2e1',
  null,
  (select min(deadline_at) from page_two),
  (select winner_id from page_two order by deadline_at asc, winner_id asc limit 1),
  true, 2);

-- Case 6. Walking back from page two lands exactly on page one again -- not
-- merely "overlaps it", the stronger claim 0090's own walk-back case settles
-- for because participated_at there is never null; deadline_at here can be,
-- so a filter that mishandled the null region could easily return the RIGHT
-- COUNT while including the wrong row.
select ok(
  (select count(*)::int from walked_back) = 2
  and exists (select 1 from walked_back where winner_id = '00000000-0000-0000-0000-00000000d2b1')
  and exists (select 1 from walked_back where winner_id = '00000000-0000-0000-0000-00000000d2b2'),
  'walking back from page two lands exactly on page one again');

-- ---------------------------------------------------------------------------
-- Case 7. The status filter.

select ok(
  (select count(*)::int from public.list_pickups(
     '00000000-0000-0000-0000-00000000d2c1', 'RETURN_PENDING'::public.winner_status,
     '00000000-0000-0000-0000-00000000d2e1', null, null, null, false, 50)) = 1
  and exists (
    select 1 from public.list_pickups(
      '00000000-0000-0000-0000-00000000d2c1', 'RETURN_PENDING'::public.winner_status,
      '00000000-0000-0000-0000-00000000d2e1', null, null, null, false, 50)
    where winner_id = '00000000-0000-0000-0000-00000000d2b3'),
  'filtering to RETURN_PENDING returns exactly the one winner resting there');

-- ---------------------------------------------------------------------------
-- Case 8. The promotion filter -- the OTHER promotion, holding a single
-- winner none of the cases above ever touch.

select ok(
  (select count(*)::int from public.list_pickups(
     '00000000-0000-0000-0000-00000000d2c1', null, '00000000-0000-0000-0000-00000000d2e2',
     null, null, null, false, 50)) = 1
  and exists (
    select 1 from public.list_pickups(
      '00000000-0000-0000-0000-00000000d2c1', null, '00000000-0000-0000-0000-00000000d2e2',
      null, null, null, false, 50)
    where winner_id = '00000000-0000-0000-0000-00000000d2b6'),
  'filtering to promo B returns exactly its one winner, from a Station holding six');

-- ---------------------------------------------------------------------------
-- Case 9. Nulls land after every dated row -- walked all the way there rather
-- than merely asserted about ordering in the abstract: after the two pages of
-- two above have exhausted the four dated winners of promo A, the very next
-- page holds exactly the null-deadline one and nothing else.

create temporary table page_three as
select * from public.list_pickups(
  '00000000-0000-0000-0000-00000000d2c1', null, '00000000-0000-0000-0000-00000000d2e1',
  null,
  (select max(deadline_at) from page_two),
  (select winner_id from page_two order by deadline_at desc, winner_id desc limit 1),
  false, 2);

select ok(
  (select count(*)::int from page_three) = 1
  and (select winner_id from page_three limit 1) = '00000000-0000-0000-0000-00000000d2b5'
  and (select deadline_at from page_three limit 1) is null,
  'the null-deadline winner is reached only once every dated row has been, exactly where nulls-last places it');

-- ---------------------------------------------------------------------------
-- Case 10. No promotion filter spans the whole Station, not one promotion --
-- the product requirement itself ("every prize awaiting collection across
-- all of a Station's promotions"), not merely the promotion filter's absence.
--
-- Still 6, not 7, even though a SEVENTH winner now exists (promo C's,
-- below) -- which makes this count a second, independent witness to Case 11:
-- if the cancelled-draw exclusion regressed, this assertion would go red too,
-- for a different-sounding reason pointing at the same root cause.

select is(
  (select count(*)::int from public.list_pickups(
     '00000000-0000-0000-0000-00000000d2c1', null, null, null, null, null, false, 50)),
  6, 'with no promotion named, the list spans every promotion of the Station');

-- ---------------------------------------------------------------------------
-- Case 11. THE FIFTH FACT, NOT A FIFTH RULE. A winner whose draw was
-- CANCELLED does not list, whatever winners.status still says. Scoped to
-- promo C, which holds exactly one winner and no other: a non-zero count
-- here can only be that one row. This is the Critical gap this task's own
-- review round found and fixed -- cancel_draw (0079) reverses the unit but
-- deliberately leaves winners.status at AWAITING_PICKUP (6a had no
-- vocabulary for "un-awarded"), and RLS never hid this either
-- (winners_select_by_promotion_view does not look at draws.status): before
-- this block, that combination was inert.

select is(
  (select count(*)::int from public.list_pickups(
     '00000000-0000-0000-0000-00000000d2c1', null, '00000000-0000-0000-0000-00000000d2e3',
     null, null, null, false, 50)),
  0, 'a winner whose draw was cancelled does not list, whatever winners.status still says');

-- ---------------------------------------------------------------------------
-- Block 6d, Task 6: list_movements. The same delegate as every case above
-- (242, now also holding inventory.view) drives every case below -- what
-- pgTAP proves here is the mechanics list_movements shares with list_pickups
-- and list_participations (the keyset, the filters, total_count) plus two
-- facts a single role CAN settle on its own: the tie-break on movement_id,
-- and the promotion tri-state against a caller who is provably not this
-- Organization's owner (this fixture never inserts an owner membership at
-- all, so is_owner_of_company is false for every user here). Whether the
-- OWNER sees the name this same caller cannot is tests/isolation's job --
-- the identical reasoning 0095's own header gives for deferring the
-- archived-promotion CONTRAST there rather than one side of it.

-- Case 13. The first page, newest first, limit 2: d277 (-30min) is
-- unambiguous, but d276 and d275 TIE on created_at (-1h) -- only
-- movement_id desc can be what keeps d276 on this page and d275 off it.
create temporary table lm_page_one as
select * from public.list_movements(
  '00000000-0000-0000-0000-00000000d2c1', null, null, null, null, null, null, null, false, 2);

select ok(
  (select count(*)::int from lm_page_one) = 2
  and exists (select 1 from lm_page_one where movement_id = '00000000-0000-0000-0000-00000000d277')
  and exists (select 1 from lm_page_one where movement_id = '00000000-0000-0000-0000-00000000d276')
  and not exists (select 1 from lm_page_one where movement_id = '00000000-0000-0000-0000-00000000d275'),
  'the first page (newest first) holds the two most recent movements, the created_at tie broken by movement_id desc');

select is(
  (select distinct total_count from lm_page_one), 8,
  'total_count is the whole filtered set (8), not the page (2)');

-- Case 14. The next page, continuing from d276: the tied d275 belongs HERE,
-- not on page one -- the cursor's own tuple comparison has to resolve the
-- identical tie the base ordering did.
create temporary table lm_page_two as
select * from public.list_movements(
  '00000000-0000-0000-0000-00000000d2c1', null, null, null, null, null,
  (select created_at from lm_page_one where movement_id = '00000000-0000-0000-0000-00000000d276'),
  '00000000-0000-0000-0000-00000000d276',
  false, 2);

select ok(
  (select count(*)::int from lm_page_two) = 2
  and exists (select 1 from lm_page_two where movement_id = '00000000-0000-0000-0000-00000000d275')
  and exists (select 1 from lm_page_two where movement_id = '00000000-0000-0000-0000-00000000d274')
  and not exists (select 1 from lm_page_two where movement_id = '00000000-0000-0000-0000-00000000d276'),
  'the second page picks up exactly where the first left off, tied row included, no row repeated');

select is(
  (select distinct total_count from lm_page_two), 8,
  'total_count agrees with the first page: a page and its count cannot narrow differently');

-- Case 15. Walking back from page two lands on page one again -- exactly,
-- not merely overlapping it, which is the stronger claim a tie makes worth
-- checking: a walk-back that mishandled it could easily land on the right
-- COUNT while holding the wrong row.
create temporary table lm_walked_back as
select * from public.list_movements(
  '00000000-0000-0000-0000-00000000d2c1', null, null, null, null, null,
  (select created_at from lm_page_two where movement_id = '00000000-0000-0000-0000-00000000d275'),
  '00000000-0000-0000-0000-00000000d275',
  true, 2);

select ok(
  (select count(*)::int from lm_walked_back) = 2
  and exists (select 1 from lm_walked_back where movement_id = '00000000-0000-0000-0000-00000000d277')
  and exists (select 1 from lm_walked_back where movement_id = '00000000-0000-0000-0000-00000000d276'),
  'walking back from page two lands exactly on page one again');

-- Case 16. The type filter: exactly the two PROMOTION_LINK movements, live
-- and archived promotion alike.
select ok(
  (select count(*)::int from public.list_movements(
     '00000000-0000-0000-0000-00000000d2c1', 'PROMOTION_LINK'::public.inventory_movement_type,
     null, null, null, null, null, null, false, 50)) = 2
  and exists (select 1 from public.list_movements(
     '00000000-0000-0000-0000-00000000d2c1', 'PROMOTION_LINK'::public.inventory_movement_type,
     null, null, null, null, null, null, false, 50)
    where movement_id = '00000000-0000-0000-0000-00000000d272')
  and exists (select 1 from public.list_movements(
     '00000000-0000-0000-0000-00000000d2c1', 'PROMOTION_LINK'::public.inventory_movement_type,
     null, null, null, null, null, null, false, 50)
    where movement_id = '00000000-0000-0000-0000-00000000d273'),
  'filtering to PROMOTION_LINK returns exactly the two link movements, live and archived promotion alike');

-- Case 17. The prize filter -- the OTHER prize, exclusive to d275/d276.
select is(
  (select count(*)::int from public.list_movements(
     '00000000-0000-0000-0000-00000000d2c1', null, '00000000-0000-0000-0000-00000000d2d2'::uuid,
     null, null, null, null, null, false, 50)),
  2, 'filtering to the other prize returns exactly its two movements');

-- Case 18. The promotion filter -- promo A, named by exactly one movement
-- across the whole Station.
select ok(
  (select count(*)::int from public.list_movements(
     '00000000-0000-0000-0000-00000000d2c1', null, null, '00000000-0000-0000-0000-00000000d2e1'::uuid,
     null, null, null, null, false, 50)) = 1
  and exists (select 1 from public.list_movements(
     '00000000-0000-0000-0000-00000000d2c1', null, null, '00000000-0000-0000-0000-00000000d2e1'::uuid,
     null, null, null, null, false, 50)
    where movement_id = '00000000-0000-0000-0000-00000000d272'),
  'filtering to promo A returns exactly its one movement');

-- Case 19. The date range, spanning exactly d273 (-3h) and d274 (-2h).
select is(
  (select count(*)::int from public.list_movements(
     '00000000-0000-0000-0000-00000000d2c1', null, null, null,
     now() - interval '3 hours 30 minutes', now() - interval '1 hour 30 minutes',
     null, null, false, 50)),
  2, 'the date range returns exactly the two movements inside it');

-- Case 20. No filter at all spans the whole Station: eight movements, not
-- seven or nine -- the product requirement itself, mirroring list_pickups'
-- own Case 10.
create temporary table lm_all as
select * from public.list_movements(
  '00000000-0000-0000-0000-00000000d2c1', null, null, null, null, null, null, null, false, 50);

select is(
  (select count(*)::int from lm_all), 8, 'with no filter at all, the list spans every movement of the Station');

-- Case 21. The tri-state, first branch: no promotion at all.
select ok(
  (select promotion_id is null and promotion_name is null and promotion_archived = false
     from lm_all where movement_id = '00000000-0000-0000-0000-00000000d271'),
  'a movement naming no promotion returns promotion_id null, promotion_name null, promotion_archived false');

-- Case 22. The tri-state, second branch: a LIVE promotion, named in full.
select ok(
  (select promotion_id = '00000000-0000-0000-0000-00000000d2e1'::uuid
      and promotion_name = 'List promo A'
      and promotion_archived = false
     from lm_all where movement_id = '00000000-0000-0000-0000-00000000d272'),
  'a movement under a live promotion returns its id and its name, promotion_archived false');

-- Case 23. The tri-state, third branch: an ARCHIVED promotion. The id is NOT
-- withheld -- only the name is -- and promotion_archived says why it is
-- missing rather than leaving a blank cell indistinguishable from Case 21.
select ok(
  (select promotion_id = '00000000-0000-0000-0000-00000000d2e4'::uuid
      and promotion_name is null
      and promotion_archived = true
     from lm_all where movement_id = '00000000-0000-0000-0000-00000000d273'),
  'a movement under an archived promotion still lists with its id, names nothing, and says promotion_archived true');

-- Case 24. actor_id null means exactly one thing: nobody recorded this by
-- hand, the same shape sweep_pickup_deadlines (0094) leaves under pg_cron.
select ok(
  (select actor_id is null and actor_name is null
     from lm_all where movement_id = '00000000-0000-0000-0000-00000000d277'),
  'a movement with no actor at all returns actor_name null, the clock''s own shape');

-- Case 25. A genuine actor resolves to a genuine name, not left null beside
-- the clock's -- the two nulls this function is built not to conflate.
select ok(
  (select actor_id = '00000000-0000-0000-0000-00000000d291'::uuid
      and actor_name = 'Operator Six D'
     from lm_all where movement_id = '00000000-0000-0000-0000-00000000d274'),
  'a movement with a real actor resolves actor_name from their profile');

-- Case 26. A genuine actor who never set a display name: actor_name is null,
-- the SAME value the clock's own movement carries (Case 24) -- but actor_id
-- is NOT null, which is the one fact a consumer keys its "(deadline)" label
-- off, never actor_name. This is the state a coalesce-to-email fallback
-- existed for, and the one this case pins instead of that removed fallback.
select ok(
  (select actor_id = '00000000-0000-0000-0000-00000000d292'::uuid
      and actor_name is null
     from lm_all where movement_id = '00000000-0000-0000-0000-00000000d278'),
  'an actor with no full_name set returns actor_name null but actor_id non-null -- not the clock''s own row');

-- Case 27. Block 30a D1's structural pin, mirroring
-- 51_music_request_triage.test.sql's own idiom for list_music_requests -- its
-- assertion 18, the pg_get_function_result probe, named here rather than by
-- a line number that Task 8 already found gone stale once: asked of the
-- function's RESULT shape rather than of a row, because a column that was
-- removed cannot be selected to prove its own absence -- the query would
-- fail to parse rather than fail an assertion, and a parse error is not a
-- test result. The populated/withheld pair itself (Rule 2) needs a REAL
-- second user with a REAL, narrower grant, exactly like the four rules this
-- file's own header defers to tests/isolation/pickups.test.ts for -- this
-- assertion is the cheap, always-on half: the whole number has no column to
-- travel through at all, whoever is asking.
select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'list_pickups'
      and pg_get_function_result(p.oid) like '%member_phone_last4%'
      and pg_get_function_result(p.oid) not like '%member_phone text%'),
  1, 'list_pickups offers four digits and no whole-number column at all');

reset role;

select * from finish();
rollback;
