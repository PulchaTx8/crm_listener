-- Block Templates, Task 4: the sweep that finally speaks.
--
-- NOT wrapped in begin/rollback, the same reason 12b_deadline_sweep.test.sql
-- gives and cannot avoid: sweep_pickup_reminders is a PROCEDURE that commits
-- after each winner (0094's own shape, restated by 0112's header), and CALL
-- inside an open transaction block raises "invalid transaction termination".
-- So this file builds its fixture, runs, asserts, and deletes what it made.

select plan(13);

-- ---------------------------------------------------------------------------
-- SELF-HEALING: the same cleanup this file runs at the bottom, run again here
-- first, for the identical reason 12b's own header gives -- a file that dies
-- mid-script before reaching its own teardown must not leave the NEXT run
-- colliding on organizations_pkey instead of reporting whatever actually
-- broke. Every DELETE below is a no-op on a genuinely fresh database.

delete from public.outbox_messages where company_id in (
  '00000000-0000-0000-0000-00000000e5c1', '00000000-0000-0000-0000-00000000e5c2',
  '00000000-0000-0000-0000-00000000e5c3');
delete from public.winners where company_id in (
  '00000000-0000-0000-0000-00000000e5c1', '00000000-0000-0000-0000-00000000e5c2',
  '00000000-0000-0000-0000-00000000e5c3');
delete from public.participations where company_id in (
  '00000000-0000-0000-0000-00000000e5c1', '00000000-0000-0000-0000-00000000e5c2',
  '00000000-0000-0000-0000-00000000e5c3');
delete from public.draws where company_id in (
  '00000000-0000-0000-0000-00000000e5c1', '00000000-0000-0000-0000-00000000e5c2',
  '00000000-0000-0000-0000-00000000e5c3');
delete from public.promotion_prizes where company_id in (
  '00000000-0000-0000-0000-00000000e5c1', '00000000-0000-0000-0000-00000000e5c2',
  '00000000-0000-0000-0000-00000000e5c3');
delete from public.promotions where company_id in (
  '00000000-0000-0000-0000-00000000e5c1', '00000000-0000-0000-0000-00000000e5c2',
  '00000000-0000-0000-0000-00000000e5c3');
delete from public.prizes where company_id in (
  '00000000-0000-0000-0000-00000000e5c1', '00000000-0000-0000-0000-00000000e5c2',
  '00000000-0000-0000-0000-00000000e5c3');
delete from public.message_templates where company_id in (
  '00000000-0000-0000-0000-00000000e5c1', '00000000-0000-0000-0000-00000000e5c2',
  '00000000-0000-0000-0000-00000000e5c3');
delete from public.integrations where company_id in (
  '00000000-0000-0000-0000-00000000e5c1', '00000000-0000-0000-0000-00000000e5c2',
  '00000000-0000-0000-0000-00000000e5c3');
delete from public.member_company_links where company_id in (
  '00000000-0000-0000-0000-00000000e5c1', '00000000-0000-0000-0000-00000000e5c2',
  '00000000-0000-0000-0000-00000000e5c3');
delete from public.members where organization_id = '00000000-0000-0000-0000-00000000e5f1';
delete from public.companies where id in (
  '00000000-0000-0000-0000-00000000e5c1', '00000000-0000-0000-0000-00000000e5c2',
  '00000000-0000-0000-0000-00000000e5c3');
delete from public.organizations where id = '00000000-0000-0000-0000-00000000e5f1';
delete from auth.users where id = '00000000-0000-0000-0000-00000000e5ab';

-- ---------------------------------------------------------------------------
-- 1-2: pinned ACLs. Both routines are owner-only -- the convention 0094 uses
-- for every SECURITY INVOKER writer, extended here to enqueue_pickup_reminder
-- even though it is SECURITY DEFINER: nothing but the sweep itself calls it,
-- and a leaked grant would let a caller who holds no Station membership at
-- all enqueue a WhatsApp send by naming a bare winner id.

select ok(
  not has_function_privilege('service_role', 'public.sweep_pickup_reminders()', 'EXECUTE'),
  'the sweep is owner-only: nothing but pg_cron, running as the migration role, may call it');

select ok(
  not has_function_privilege('service_role',
    'public.enqueue_pickup_reminder(uuid)', 'EXECUTE'),
  'enqueue_pickup_reminder is owner-only too: only the sweep calls it, from inside its own loop');

-- ---------------------------------------------------------------------------
-- THE FIXTURE. Two Stations under one Organization. Station A (...e5c1) has a
-- live WhatsApp integration AND a registered PICKUP_REMINDER template; Station
-- B (...e5c2) has the integration but NO template, which is the case
-- assertion 10 needs. Winners are inserted directly into `winners`, the same
-- choice 13_pickup_reads.test.sql makes and explains: what is under test is
-- the sweep's own predicate and the render, not apply_draw's machinery, and
-- driving the whole draw pipeline to get six winners would make one failure
-- mean six different things.
--
-- Fixtures live in the ...00e5xx range: 18_templates.test.sql owns ...00e4xx;
-- a collision would fail in whichever file ran second.

insert into public.organizations (id, name) values
  ('00000000-0000-0000-0000-00000000e5f1', 'Org pickup reminders');

-- Station C (...e5c3, fix round 1) is a THIRD Station in a DIFFERENT
-- timezone -- America/Manaus, a constant UTC-4 with no DST, distinct from
-- Sao Paulo's constant UTC-3. Without it, assertions 4 and 5 only prove the
-- deadline is converted through SOME `at time zone` expression: both other
-- Stations share 'America/Sao_Paulo', so an implementation that hardcoded
-- that literal instead of reading companies.timezone would still pass every
-- other assertion in this file. Station C's own winner (assertion 6 below)
-- is the one case that distinguishes "reads the column" from "reads the
-- literal that happens to be right twice".
insert into public.companies (id, organization_id, name, timezone) values
  ('00000000-0000-0000-0000-00000000e5c1', '00000000-0000-0000-0000-00000000e5f1',
   'Station reminders', 'America/Sao_Paulo'),
  ('00000000-0000-0000-0000-00000000e5c2', '00000000-0000-0000-0000-00000000e5f1',
   'Station reminders no template', 'America/Sao_Paulo'),
  ('00000000-0000-0000-0000-00000000e5c3', '00000000-0000-0000-0000-00000000e5f1',
   'Station reminders Manaus', 'America/Manaus');

insert into public.integrations
  (id, organization_id, company_id, provider, phone_number_id, enabled)
values
  ('00000000-0000-0000-0000-00000000e5a1', '00000000-0000-0000-0000-00000000e5f1',
   '00000000-0000-0000-0000-00000000e5c1', 'WHATSAPP', '5511900001001', true),
  ('00000000-0000-0000-0000-00000000e5a2', '00000000-0000-0000-0000-00000000e5f1',
   '00000000-0000-0000-0000-00000000e5c2', 'WHATSAPP', '5511900002001', true),
  ('00000000-0000-0000-0000-00000000e5a3', '00000000-0000-0000-0000-00000000e5f1',
   '00000000-0000-0000-0000-00000000e5c3', 'WHATSAPP', '5511900003001', true);

-- Station A's and Station C's approved templates. Three placeholders each,
-- matching the contract Task 4 fixes: {{1}} first name, {{2}} prize name,
-- {{3}} the deadline. Station B registers none -- that absence is the whole
-- point of its fixture.
insert into public.message_templates
  (organization_id, company_id, purpose, channel, internal_name, name, language, body)
values
  ('00000000-0000-0000-0000-00000000e5f1', '00000000-0000-0000-0000-00000000e5c1',
   'PICKUP_REMINDER', 'WHATSAPP', 'Lembrete de retirada', 'Lembrete de retirada', 'pt_BR',
   'Oi {{1}}, seu prêmio {{2}} te espera até {{3}}!'),
  ('00000000-0000-0000-0000-00000000e5f1', '00000000-0000-0000-0000-00000000e5c3',
   'PICKUP_REMINDER', 'WHATSAPP', 'Lembrete de retirada Manaus', 'Lembrete de retirada Manaus', 'pt_BR',
   'Oi {{1}}, seu prêmio {{2}} te espera até {{3}}!');

insert into public.prizes (id, organization_id, company_id, name) values
  ('00000000-0000-0000-0000-00000000e5d1', '00000000-0000-0000-0000-00000000e5f1',
   '00000000-0000-0000-0000-00000000e5c1', 'Fone de ouvido'),
  ('00000000-0000-0000-0000-00000000e5d2', '00000000-0000-0000-0000-00000000e5f1',
   '00000000-0000-0000-0000-00000000e5c2', 'Caneca'),
  ('00000000-0000-0000-0000-00000000e5d3', '00000000-0000-0000-0000-00000000e5f1',
   '00000000-0000-0000-0000-00000000e5c3', 'Camiseta');

insert into public.promotions
  (id, organization_id, company_id, name, starts_at, ends_at)
values
  ('00000000-0000-0000-0000-00000000e5e1', '00000000-0000-0000-0000-00000000e5f1',
   '00000000-0000-0000-0000-00000000e5c1', 'Promo reminders A',
   now() - interval '2 days', now() + interval '5 days'),
  ('00000000-0000-0000-0000-00000000e5e2', '00000000-0000-0000-0000-00000000e5f1',
   '00000000-0000-0000-0000-00000000e5c2', 'Promo reminders B',
   now() - interval '2 days', now() + interval '5 days'),
  ('00000000-0000-0000-0000-00000000e5e3', '00000000-0000-0000-0000-00000000e5f1',
   '00000000-0000-0000-0000-00000000e5c3', 'Promo reminders C',
   now() - interval '2 days', now() + interval '5 days');

insert into public.promotion_prizes (id, promotion_id, prize_id, organization_id, company_id)
values
  ('00000000-0000-0000-0000-00000000e5b1', '00000000-0000-0000-0000-00000000e5e1',
   '00000000-0000-0000-0000-00000000e5d1', '00000000-0000-0000-0000-00000000e5f1',
   '00000000-0000-0000-0000-00000000e5c1'),
  ('00000000-0000-0000-0000-00000000e5b2', '00000000-0000-0000-0000-00000000e5e2',
   '00000000-0000-0000-0000-00000000e5d2', '00000000-0000-0000-0000-00000000e5f1',
   '00000000-0000-0000-0000-00000000e5c2'),
  ('00000000-0000-0000-0000-00000000e5b3', '00000000-0000-0000-0000-00000000e5e3',
   '00000000-0000-0000-0000-00000000e5d3', '00000000-0000-0000-0000-00000000e5f1',
   '00000000-0000-0000-0000-00000000e5c3');

-- Draws written by hand, not through run_draw/apply_draw -- the identical
-- choice 13's own header explains: what is under test is the sweep's read,
-- and driving the whole draw machinery buys nothing here. Two for Station A
-- (one COMPLETED holding four winners, one CANCELLED holding the fifth) and
-- one for Station B.
insert into public.draws
  (id, promotion_id, organization_id, company_id, seed, algorithm_version, entry_count, offered_count)
values
  ('00000000-0000-0000-0000-00000000e531', '00000000-0000-0000-0000-00000000e5e1',
   '00000000-0000-0000-0000-00000000e5f1', '00000000-0000-0000-0000-00000000e5c1',
   repeat('1', 64), 1, 4, 4),
  ('00000000-0000-0000-0000-00000000e533', '00000000-0000-0000-0000-00000000e5e2',
   '00000000-0000-0000-0000-00000000e5f1', '00000000-0000-0000-0000-00000000e5c2',
   repeat('3', 64), 1, 1, 1),
  ('00000000-0000-0000-0000-00000000e534', '00000000-0000-0000-0000-00000000e5e3',
   '00000000-0000-0000-0000-00000000e5f1', '00000000-0000-0000-0000-00000000e5c3',
   repeat('4', 64), 1, 1, 1);

-- draws_cancellation_shape (0075) needs a real actor for cancelled_by.
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-00000000e5ab', 'pickup-reminder-canceller@example.test');

insert into public.draws
  (id, promotion_id, organization_id, company_id, seed, algorithm_version, entry_count,
   offered_count, status, cancelled_at, cancelled_by, cancellation_reason)
values
  ('00000000-0000-0000-0000-00000000e532', '00000000-0000-0000-0000-00000000e5e1',
   '00000000-0000-0000-0000-00000000e5f1', '00000000-0000-0000-0000-00000000e5c1',
   repeat('2', 64), 1, 1, 1, 'CANCELLED', now(), '00000000-0000-0000-0000-00000000e5ab',
   'fixture: proves a cancelled draw''s winner is never offered a reminder');

-- Five listeners at Station A, one at Station B. Anonymized 6d already carries
-- full_name = null and phone = null -- exactly the shape anonymize_member
-- (0034) leaves, built by hand for the same reason 13's cancelled-draw
-- fixture is built by hand rather than by calling the real door: what is
-- under test is the sweep's predicate, not the erasure RPC's own permission
-- chain.
insert into public.members (id, organization_id, full_name, phone, anonymized_at) values
  ('00000000-0000-0000-0000-00000000e521', '00000000-0000-0000-0000-00000000e5f1',
   'Ana Pickup', '5511900010001', null),
  ('00000000-0000-0000-0000-00000000e522', '00000000-0000-0000-0000-00000000e5f1',
   'Bruno Cancelled', '5511900010002', null),
  ('00000000-0000-0000-0000-00000000e523', '00000000-0000-0000-0000-00000000e5f1',
   'Carla Delivered', '5511900010003', null),
  ('00000000-0000-0000-0000-00000000e524', '00000000-0000-0000-0000-00000000e5f1',
   'Diego Expired', '5511900010004', null),
  ('00000000-0000-0000-0000-00000000e525', '00000000-0000-0000-0000-00000000e5f1',
   null, null, now()),
  ('00000000-0000-0000-0000-00000000e526', '00000000-0000-0000-0000-00000000e5f1',
   'Elis NoTemplate', '5511900020001', null),
  ('00000000-0000-0000-0000-00000000e527', '00000000-0000-0000-0000-00000000e5f1',
   'Fabio Manaus', '5511900030001', null);

insert into public.member_company_links (member_id, company_id, organization_id) values
  ('00000000-0000-0000-0000-00000000e521', '00000000-0000-0000-0000-00000000e5c1',
   '00000000-0000-0000-0000-00000000e5f1'),
  ('00000000-0000-0000-0000-00000000e522', '00000000-0000-0000-0000-00000000e5c1',
   '00000000-0000-0000-0000-00000000e5f1'),
  ('00000000-0000-0000-0000-00000000e523', '00000000-0000-0000-0000-00000000e5c1',
   '00000000-0000-0000-0000-00000000e5f1'),
  ('00000000-0000-0000-0000-00000000e524', '00000000-0000-0000-0000-00000000e5c1',
   '00000000-0000-0000-0000-00000000e5f1'),
  ('00000000-0000-0000-0000-00000000e525', '00000000-0000-0000-0000-00000000e5c1',
   '00000000-0000-0000-0000-00000000e5f1'),
  ('00000000-0000-0000-0000-00000000e526', '00000000-0000-0000-0000-00000000e5c2',
   '00000000-0000-0000-0000-00000000e5f1'),
  ('00000000-0000-0000-0000-00000000e527', '00000000-0000-0000-0000-00000000e5c3',
   '00000000-0000-0000-0000-00000000e5f1');

insert into public.participations
  (id, promotion_id, member_id, organization_id, company_id, allows_multiple,
   status, source, participated_at)
values
  ('00000000-0000-0000-0000-00000000e541', '00000000-0000-0000-0000-00000000e5e1',
   '00000000-0000-0000-0000-00000000e521', '00000000-0000-0000-0000-00000000e5f1',
   '00000000-0000-0000-0000-00000000e5c1', false, 'VALID', 'MANUAL', now() - interval '5 hours'),
  ('00000000-0000-0000-0000-00000000e542', '00000000-0000-0000-0000-00000000e5e1',
   '00000000-0000-0000-0000-00000000e522', '00000000-0000-0000-0000-00000000e5f1',
   '00000000-0000-0000-0000-00000000e5c1', false, 'VALID', 'MANUAL', now() - interval '4 hours'),
  ('00000000-0000-0000-0000-00000000e543', '00000000-0000-0000-0000-00000000e5e1',
   '00000000-0000-0000-0000-00000000e523', '00000000-0000-0000-0000-00000000e5f1',
   '00000000-0000-0000-0000-00000000e5c1', false, 'VALID', 'MANUAL', now() - interval '3 hours'),
  ('00000000-0000-0000-0000-00000000e544', '00000000-0000-0000-0000-00000000e5e1',
   '00000000-0000-0000-0000-00000000e524', '00000000-0000-0000-0000-00000000e5f1',
   '00000000-0000-0000-0000-00000000e5c1', false, 'VALID', 'MANUAL', now() - interval '2 hours'),
  ('00000000-0000-0000-0000-00000000e545', '00000000-0000-0000-0000-00000000e5e1',
   '00000000-0000-0000-0000-00000000e525', '00000000-0000-0000-0000-00000000e5f1',
   '00000000-0000-0000-0000-00000000e5c1', false, 'VALID', 'MANUAL', now() - interval '1 hours'),
  ('00000000-0000-0000-0000-00000000e546', '00000000-0000-0000-0000-00000000e5e2',
   '00000000-0000-0000-0000-00000000e526', '00000000-0000-0000-0000-00000000e5f1',
   '00000000-0000-0000-0000-00000000e5c2', false, 'VALID', 'MANUAL', now() - interval '1 hours'),
  ('00000000-0000-0000-0000-00000000e547', '00000000-0000-0000-0000-00000000e5e3',
   '00000000-0000-0000-0000-00000000e527', '00000000-0000-0000-0000-00000000e5f1',
   '00000000-0000-0000-0000-00000000e5c3', false, 'VALID', 'MANUAL', now() - interval '1 hours');

-- Seven winners, the six states the sweep must tell apart at Station A/B, plus
-- Station C's own in-window winner for the cross-timezone proof.
--
-- InWindow's deadline is deliberately 02:00 UTC TOMORROW rather than a plain
-- `now() + interval '1 day'`: this Postgres container runs in UTC (0062's own
-- comment says so plainly -- "the server runs UTC"), and 02:00 UTC is 23:00
-- the PREVIOUS day in America/Sao_Paulo (UTC-3). If enqueue_pickup_reminder
-- ever formatted the deadline without `at time zone`, to_char would use the
-- session's UTC clock and print TOMORROW's date; formatted correctly in the
-- Station's own zone it prints TODAY's. Picking a deadline that straddles
-- that boundary is what makes assertion 4 below discriminate rather than pass
-- whichever way the bug goes.
insert into public.winners
  (id, draw_id, company_id, promotion_prize_id, member_id, participation_id,
   awarded_rank, status, deadline_at)
values
  ('00000000-0000-0000-0000-00000000e551', '00000000-0000-0000-0000-00000000e531',
   '00000000-0000-0000-0000-00000000e5c1', '00000000-0000-0000-0000-00000000e5b1',
   '00000000-0000-0000-0000-00000000e521', '00000000-0000-0000-0000-00000000e541',
   1, 'AWAITING_PICKUP', (current_date + 1 + time '02:00:00') at time zone 'UTC'),
  -- CancelledDraw: same deadline shape as InWindow, on the CANCELLED draw.
  ('00000000-0000-0000-0000-00000000e552', '00000000-0000-0000-0000-00000000e532',
   '00000000-0000-0000-0000-00000000e5c1', '00000000-0000-0000-0000-00000000e5b1',
   '00000000-0000-0000-0000-00000000e522', '00000000-0000-0000-0000-00000000e542',
   1, 'AWAITING_PICKUP', now() + interval '1 day'),
  -- Delivered: already handed over. Status alone must exclude it.
  ('00000000-0000-0000-0000-00000000e553', '00000000-0000-0000-0000-00000000e531',
   '00000000-0000-0000-0000-00000000e5c1', '00000000-0000-0000-0000-00000000e5b1',
   '00000000-0000-0000-0000-00000000e523', '00000000-0000-0000-0000-00000000e543',
   2, 'DELIVERED', now() + interval '1 day'),
  -- Expired: the deadline already passed. Reminding here would tell somebody
  -- to collect a prize the clock already returned to stock.
  ('00000000-0000-0000-0000-00000000e554', '00000000-0000-0000-0000-00000000e531',
   '00000000-0000-0000-0000-00000000e5c1', '00000000-0000-0000-0000-00000000e5b1',
   '00000000-0000-0000-0000-00000000e524', '00000000-0000-0000-0000-00000000e544',
   3, 'AWAITING_PICKUP', now() - interval '1 hour'),
  -- Anonymized: the listener exercised erasure. full_name is null on this row
  -- (set above), so a reminder would be addressed to nobody.
  ('00000000-0000-0000-0000-00000000e555', '00000000-0000-0000-0000-00000000e531',
   '00000000-0000-0000-0000-00000000e5c1', '00000000-0000-0000-0000-00000000e5b1',
   '00000000-0000-0000-0000-00000000e525', '00000000-0000-0000-0000-00000000e545',
   4, 'AWAITING_PICKUP', now() + interval '1 day'),
  -- NoTemplate: eligible in every other respect, at a Station that never
  -- registered a PICKUP_REMINDER template.
  ('00000000-0000-0000-0000-00000000e556', '00000000-0000-0000-0000-00000000e533',
   '00000000-0000-0000-0000-00000000e5c2', '00000000-0000-0000-0000-00000000e5b2',
   '00000000-0000-0000-0000-00000000e526', '00000000-0000-0000-0000-00000000e546',
   1, 'AWAITING_PICKUP', now() + interval '1 day'),
  -- ManausInWindow (fix round 1): the cross-timezone proof. 03:30 UTC TOMORROW
  -- is 23:30 TODAY in America/Manaus (UTC-4) but 00:30 TOMORROW in
  -- America/Sao_Paulo (UTC-3) -- a full calendar day apart from the SAME
  -- instant. If enqueue_pickup_reminder ever read a hardcoded
  -- 'America/Sao_Paulo' instead of this Station's own companies.timezone,
  -- this winner's rendered date would be wrong by exactly one day.
  ('00000000-0000-0000-0000-00000000e557', '00000000-0000-0000-0000-00000000e534',
   '00000000-0000-0000-0000-00000000e5c3', '00000000-0000-0000-0000-00000000e5b3',
   '00000000-0000-0000-0000-00000000e527', '00000000-0000-0000-0000-00000000e547',
   1, 'AWAITING_PICKUP', (current_date + 1 + time '03:30:00') at time zone 'UTC');

-- ---------------------------------------------------------------------------
-- THE FIRST SWEEP. Its candidate set, under the procedure's own predicate, is
-- exactly {InWindow, NoTemplate, ManausInWindow}: CancelledDraw is excluded
-- by the join to draws, Delivered by winners.status, Expired by the
-- deadline's lower bound, Anonymized by the listener predicate -- none of
-- those four is ever handed to enqueue_pickup_reminder at all. NoTemplate IS
-- handed to it, fails inside enqueue_whatsapp_outbound's own P0002, and is
-- caught by the per-winner exception block -- which is what assertion 10
-- (together with 3) proves. Collected in id order (fix round 1): the walk is
-- InWindow (...e551), NoTemplate (...e556), then ManausInWindow (...e557) --
-- so InWindow's success is already committed BEFORE NoTemplate's failure,
-- and ManausInWindow's success is committed AFTER it. Between assertions 11
-- and 13 this proves survival on both sides of the failure, not merely
-- whichever side the planner happened to visit first.

call public.sweep_pickup_reminders();

-- 3: THE CASE THAT MATTERS MOST. A winner inside the window, at a Station
-- that registered a template, gets exactly one outbox row.
select is(
  (select count(*)::integer from public.outbox_messages
    where dedupe_key = 'pickup-reminder:00000000-0000-0000-0000-00000000e551'),
  1, 'a winner inside the window gets exactly one outbox row');

-- 4: THE TIMEZONE PROOF. Computed independently of the function under test --
-- from the SAME stored deadline_at, through the SAME `at time zone` idiom
-- 0062's whatsapp_reply_body already uses for a Station's local clock -- not
-- by echoing whatever the function happened to write. If enqueue_pickup_reminder
-- forgot the conversion, this session's own UTC clock would print tomorrow's
-- date instead of today's (see the fixture comment above), and this assertion
-- would fail rather than vacuously agree.
select is(
  (select body from public.outbox_messages
    where dedupe_key = 'pickup-reminder:00000000-0000-0000-0000-00000000e551'),
  format('Oi %s, seu prêmio %s te espera até %s!', 'Ana', 'Fone de ouvido',
    to_char(
      (select deadline_at from public.winners where id = '00000000-0000-0000-0000-00000000e551')
        at time zone 'America/Sao_Paulo',
      'DD/MM/YYYY')),
  'the rendered body carries the first name, the prize name and the deadline, in that order, formatted in the Station''s own timezone');

-- 5: the same three values, in the same order, in the structured column Task
-- 3 added -- a separate assertion from 4, the same way 18's own tests 27 and
-- 30 check the substituted body and the stamped variables apart.
select is(
  (select template_variables from public.outbox_messages
    where dedupe_key = 'pickup-reminder:00000000-0000-0000-0000-00000000e551'),
  jsonb_build_array('Ana', 'Fone de ouvido',
    to_char(
      (select deadline_at from public.winners where id = '00000000-0000-0000-0000-00000000e551')
        at time zone 'America/Sao_Paulo',
      'DD/MM/YYYY')),
  'template_variables is stamped with the same three values, positionally, that the body was rendered from');

-- 6: a winner whose DRAW was cancelled is never offered a reminder -- the
-- exact case Blocks 6c and 6d each lost once (0075's and 0094's own headers).
select is(
  (select count(*)::integer from public.outbox_messages
    where dedupe_key = 'pickup-reminder:00000000-0000-0000-0000-00000000e552'),
  0, 'a winner whose draw was cancelled is skipped, whatever winners.status still says');

-- 7: a winner already DELIVERED is skipped.
select is(
  (select count(*)::integer from public.outbox_messages
    where dedupe_key = 'pickup-reminder:00000000-0000-0000-0000-00000000e553'),
  0, 'a winner already delivered is skipped');

-- 8: a winner whose deadline has ALREADY PASSED is skipped -- the lower bound
-- of the window. Reminding here would tell somebody to collect a prize the
-- clock already returned to stock, the one moment this message is worse than
-- silence.
select is(
  (select count(*)::integer from public.outbox_messages
    where dedupe_key = 'pickup-reminder:00000000-0000-0000-0000-00000000e554'),
  0, 'a winner whose deadline has already passed is skipped');

-- 9: an anonymised listener is skipped -- the same exclusion
-- searchStationListeners and create_music_request (0107) both carry, for the
-- same reason: full_name is null, and a reminder would be addressed to
-- nobody.
select is(
  (select count(*)::integer from public.outbox_messages
    where dedupe_key = 'pickup-reminder:00000000-0000-0000-0000-00000000e555'),
  0, 'a winner whose listener has been anonymised is skipped');

-- 10: FIRST HALF of the Station-with-no-template case -- it enqueues nothing.
select is(
  (select count(*)::integer from public.outbox_messages
    where dedupe_key = 'pickup-reminder:00000000-0000-0000-0000-00000000e556'),
  0, 'a Station with no registered PICKUP_REMINDER template enqueues nothing');

-- 11: SECOND HALF -- and it does not abort the sweep for other Stations.
-- NoTemplate (Station B) and InWindow (Station A) were both candidates of the
-- SAME call above; re-checking InWindow's row survived is what proves the
-- per-winner exception block, not merely per-winner success, actually held.
select is(
  (select count(*)::integer from public.outbox_messages
    where dedupe_key = 'pickup-reminder:00000000-0000-0000-0000-00000000e551'),
  1, 'and Station A''s winner is still enqueued -- Station B''s failure did not abort the sweep');

-- 12: THE CROSS-TIMEZONE PROOF (fix round 1). Station C's own zone is
-- America/Manaus (UTC-4), not Station A/B's America/Sao_Paulo (UTC-3) --
-- expected value computed with THAT literal, from the SAME stored
-- deadline_at, so an implementation that hardcoded 'America/Sao_Paulo' for
-- every Station (which assertions 4 and 5 alone cannot catch, since both
-- Stations they check share that zone) would print a date one calendar day
-- off from what this asserts. Also incidental confirmation that a WINNER
-- WALKED AFTER the no-template failure (...e557 sorts after ...e556 in the
-- id-ordered walk) still commits -- the failure does not poison anything
-- that comes after it either.
select is(
  (select body from public.outbox_messages
    where dedupe_key = 'pickup-reminder:00000000-0000-0000-0000-00000000e557'),
  format('Oi %s, seu prêmio %s te espera até %s!', 'Fabio', 'Camiseta',
    to_char(
      (select deadline_at from public.winners where id = '00000000-0000-0000-0000-00000000e557')
        at time zone 'America/Manaus',
      'DD/MM/YYYY')),
  'a Station in a different timezone gets its deadline formatted in ITS OWN zone, not another Station''s');

-- ---------------------------------------------------------------------------
-- 13: RUNNING THE SWEEP TWICE ENQUEUES NOTHING THE SECOND TIME -- proved by
-- actually running it again (D9), not by reading outbox_messages' own unique
-- constraint on (provider, dedupe_key). InWindow is still, after this second
-- call, a candidate every time the query runs (nothing about it changes
-- status or deadline), so this is a real re-offer that dedupe_key must
-- refuse, not a candidate set that has already emptied itself out.

call public.sweep_pickup_reminders();

select is(
  (select count(*)::integer from public.outbox_messages
    where dedupe_key = 'pickup-reminder:00000000-0000-0000-0000-00000000e551'),
  1, 'running the sweep twice enqueues nothing the second time');

select * from finish();

-- ---------------------------------------------------------------------------
-- Clean up, children first: this file did not roll back.

delete from public.outbox_messages where company_id in (
  '00000000-0000-0000-0000-00000000e5c1', '00000000-0000-0000-0000-00000000e5c2',
  '00000000-0000-0000-0000-00000000e5c3');
delete from public.winners where company_id in (
  '00000000-0000-0000-0000-00000000e5c1', '00000000-0000-0000-0000-00000000e5c2',
  '00000000-0000-0000-0000-00000000e5c3');
delete from public.participations where company_id in (
  '00000000-0000-0000-0000-00000000e5c1', '00000000-0000-0000-0000-00000000e5c2',
  '00000000-0000-0000-0000-00000000e5c3');
delete from public.draws where company_id in (
  '00000000-0000-0000-0000-00000000e5c1', '00000000-0000-0000-0000-00000000e5c2',
  '00000000-0000-0000-0000-00000000e5c3');
delete from public.promotion_prizes where company_id in (
  '00000000-0000-0000-0000-00000000e5c1', '00000000-0000-0000-0000-00000000e5c2',
  '00000000-0000-0000-0000-00000000e5c3');
delete from public.promotions where company_id in (
  '00000000-0000-0000-0000-00000000e5c1', '00000000-0000-0000-0000-00000000e5c2',
  '00000000-0000-0000-0000-00000000e5c3');
delete from public.prizes where company_id in (
  '00000000-0000-0000-0000-00000000e5c1', '00000000-0000-0000-0000-00000000e5c2',
  '00000000-0000-0000-0000-00000000e5c3');
delete from public.message_templates where company_id in (
  '00000000-0000-0000-0000-00000000e5c1', '00000000-0000-0000-0000-00000000e5c2',
  '00000000-0000-0000-0000-00000000e5c3');
delete from public.integrations where company_id in (
  '00000000-0000-0000-0000-00000000e5c1', '00000000-0000-0000-0000-00000000e5c2',
  '00000000-0000-0000-0000-00000000e5c3');
delete from public.member_company_links where company_id in (
  '00000000-0000-0000-0000-00000000e5c1', '00000000-0000-0000-0000-00000000e5c2',
  '00000000-0000-0000-0000-00000000e5c3');
delete from public.members where organization_id = '00000000-0000-0000-0000-00000000e5f1';
delete from public.companies where id in (
  '00000000-0000-0000-0000-00000000e5c1', '00000000-0000-0000-0000-00000000e5c2',
  '00000000-0000-0000-0000-00000000e5c3');
delete from public.organizations where id = '00000000-0000-0000-0000-00000000e5f1';
delete from auth.users where id = '00000000-0000-0000-0000-00000000e5ab';
