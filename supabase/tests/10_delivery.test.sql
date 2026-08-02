begin;
select plan(16);

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

select * from finish();
rollback;
