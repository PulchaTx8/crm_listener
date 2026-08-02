begin;
select plan(36);

-- Block 6a, Task 1: the four tables the draw needs, the deadline columns it
-- freezes, and the two permission codes that guard it. Nothing reads or writes
-- these from application code yet; this file is the only thing that exercises
-- them until run_draw arrives in 0077.
--
-- Fixtures live in the ...00a0xx range: 08_conversation already owns ...0008xx
-- and ...0009xx entirely, and a collision here would fail in whichever file
-- happened to run second.

-- The enums ------------------------------------------------------------------

select has_type('public', 'draw_status', 'the draw status enum exists');
select is(enum_range(null::public.draw_status)::text[],
          array['COMPLETED', 'CANCELLED'],
          'draw_status carries exactly the two states a draw can be in');

-- winner_status is created with the FULL set 6b will use, and this block writes
-- only AWAITING_PICKUP (spec 3.3). Asserting all five now is what stops 6b from
-- re-shaping a column that other rows already hold.
select has_type('public', 'winner_status', 'the winner status enum exists');
select is(enum_range(null::public.winner_status)::text[],
          array['AWAITING_PICKUP', 'DELIVERED', 'RETURNED', 'WRITTEN_OFF', 'SUPERSEDED'],
          'winner_status carries the full set 6b will use, declared now rather than added later');

-- Existence ------------------------------------------------------------------

select has_table('public', 'draws', 'draws exists');
select has_table('public', 'draw_entries', 'draw_entries exists');
select has_table('public', 'winners', 'winners exists');
select has_table('public', 'draw_runners_up', 'draw_runners_up exists');

-- RLS ------------------------------------------------------------------------

select is(relrowsecurity, true, 'RLS enabled on draws')
  from pg_class where oid = 'public.draws'::regclass;
select is(relrowsecurity, true, 'RLS enabled on draw_entries')
  from pg_class where oid = 'public.draw_entries'::regclass;
select is(relrowsecurity, true, 'RLS enabled on winners')
  from pg_class where oid = 'public.winners'::regclass;
select is(relrowsecurity, true, 'RLS enabled on draw_runners_up')
  from pg_class where oid = 'public.draw_runners_up'::regclass;

-- The grants -----------------------------------------------------------------
--
-- Block 5a shipped three tables with a comment saying who could reach them and
-- no grant behind it: RLS-bypass privilege was never actually held, every write
-- returned 42501 in production, and pgTAP -- which runs as postgres and ignores
-- ACLs entirely -- kept passing. has_table_privilege reads the catalogue rather
-- than attempting a read, which is what makes these assertions able to catch
-- that specific class of miss. Task 8 drives the same tables across the real
-- HTTP boundary, because these two together are what the lesson cost.

select ok(has_table_privilege('authenticated', 'public.draws', 'SELECT'),
          'authenticated may read draws: the draws screen is a screen');
select ok(has_table_privilege('authenticated', 'public.winners', 'SELECT'),
          'authenticated may read winners');

select ok(not has_table_privilege('anon', 'public.draws', 'TRUNCATE')
      and not has_table_privilege('authenticated', 'public.draws', 'TRUNCATE'),
          'nobody at the PostgREST roles may truncate draws');
select ok(not has_table_privilege('anon', 'public.draw_entries', 'TRUNCATE')
      and not has_table_privilege('authenticated', 'public.draw_entries', 'TRUNCATE'),
          'nobody at the PostgREST roles may truncate the frozen hat');
select ok(not has_table_privilege('anon', 'public.winners', 'TRUNCATE')
      and not has_table_privilege('authenticated', 'public.winners', 'TRUNCATE'),
          'nobody at the PostgREST roles may truncate winners');
select ok(not has_table_privilege('anon', 'public.draw_runners_up', 'TRUNCATE')
      and not has_table_privilege('authenticated', 'public.draw_runners_up', 'TRUNCATE'),
          'nobody at the PostgREST roles may truncate the runner-up queue');

select ok(has_table_privilege('service_role', 'public.draws', 'SELECT')
      and has_table_privilege('service_role', 'public.draws', 'INSERT'),
          'service_role may read and write draws');

-- The permission codes -------------------------------------------------------
--
-- Two codes, not one (spec 4.3): whoever may run a draw is not thereby somebody
-- who may undo one.
select is(
  (select count(*)::int from public.permissions
    where code in ('draws.execute', 'draws.cancel')),
  2, 'both draw permission codes are in the catalogue');

-- Fixtures for the two CHECK constraints -------------------------------------

insert into public.organizations (id, name) values
  ('00000000-0000-0000-0000-00000000a0f1', 'Org 6a draws');
insert into public.companies (id, organization_id, name, timezone) values
  ('00000000-0000-0000-0000-00000000a0c1', '00000000-0000-0000-0000-00000000a0f1',
   'Station 6a draws', 'America/Sao_Paulo');

select throws_ok($$
  insert into public.prizes
    (id, organization_id, company_id, name, default_pickup_deadline_days)
  values
    ('00000000-0000-0000-0000-00000000a0d1', '00000000-0000-0000-0000-00000000a0f1',
     '00000000-0000-0000-0000-00000000a0c1', 'Negative deadline', -1)
$$, '23514', null, 'a negative default_pickup_deadline_days is refused');

insert into public.promotions
  (id, organization_id, company_id, name, starts_at, ends_at)
values
  ('00000000-0000-0000-0000-00000000a0e1', '00000000-0000-0000-0000-00000000a0f1',
   '00000000-0000-0000-0000-00000000a0c1', 'Promo 6a draws', now(), now() + interval '1 day');

-- A cancellation is three facts or none of them. Without this a row can claim
-- it was cancelled and not say by whom or why, which is the one thing a
-- cancelled draw has to say.
select throws_ok($$
  insert into public.draws
    (id, promotion_id, organization_id, company_id,
     seed, algorithm_version, runner_up_count, entry_count, status, cancelled_at)
  values
    ('00000000-0000-0000-0000-00000000a0b1',
     '00000000-0000-0000-0000-00000000a0e1',
     '00000000-0000-0000-0000-00000000a0f1',
     '00000000-0000-0000-0000-00000000a0c1',
     repeat('a', 64), 1, 3, 5, 'CANCELLED', now())
$$, '23514', null, 'a draw cancelled without a reason or a canceller is refused');

-- ---------------------------------------------------------------------------
-- Task 2: who is in the hat.
--
-- Every exclusion gets its OWN listener, so a failure names one rule rather
-- than leaving three candidates. The promotion allows multiple entries,
-- because the case this whole block leans on -- two entries by one person are
-- two chances (D1) -- cannot be set up in a promotion that forbids the second.

insert into public.promotions
  (id, organization_id, company_id, name, starts_at, ends_at,
   allow_multiple_entries, min_hours_between_entries)
values
  ('00000000-0000-0000-0000-00000000a0e2', '00000000-0000-0000-0000-00000000a0f1',
   '00000000-0000-0000-0000-00000000a0c1', 'Promo 6a eligibility', now() - interval '1 day',
   now() + interval '1 day', true, 1);

insert into public.members (id, organization_id, full_name) values
  ('00000000-0000-0000-0000-00000000a011', '00000000-0000-0000-0000-00000000a0f1', 'Valid Listener'),
  ('00000000-0000-0000-0000-00000000a012', '00000000-0000-0000-0000-00000000a0f1', 'Duplicate Listener'),
  ('00000000-0000-0000-0000-00000000a013', '00000000-0000-0000-0000-00000000a0f1', 'Too Soon Listener'),
  ('00000000-0000-0000-0000-00000000a014', '00000000-0000-0000-0000-00000000a0f1', 'Over Limit Listener'),
  ('00000000-0000-0000-0000-00000000a015', '00000000-0000-0000-0000-00000000a0f1', 'Soft Deleted Listener'),
  ('00000000-0000-0000-0000-00000000a016', '00000000-0000-0000-0000-00000000a0f1', 'Anonymised Listener'),
  ('00000000-0000-0000-0000-00000000a017', '00000000-0000-0000-0000-00000000a0f1', 'Draw Banned Listener'),
  ('00000000-0000-0000-0000-00000000a018', '00000000-0000-0000-0000-00000000a0f1', 'Suspended Listener'),
  ('00000000-0000-0000-0000-00000000a019', '00000000-0000-0000-0000-00000000a0f1', 'Block Lifted Listener'),
  ('00000000-0000-0000-0000-00000000a01a', '00000000-0000-0000-0000-00000000a0f1', 'Twice Entered Listener');

insert into public.member_company_links (member_id, company_id, organization_id)
select id, '00000000-0000-0000-0000-00000000a0c1', '00000000-0000-0000-0000-00000000a0f1'
from public.members
where organization_id = '00000000-0000-0000-0000-00000000a0f1';

update public.members set deleted_at = now()
  where id = '00000000-0000-0000-0000-00000000a015';
update public.members set anonymized_at = now()
  where id = '00000000-0000-0000-0000-00000000a016';

insert into public.member_blocks (organization_id, member_id, company_id, kind, reason) values
  ('00000000-0000-0000-0000-00000000a0f1', '00000000-0000-0000-0000-00000000a017',
   '00000000-0000-0000-0000-00000000a0c1', 'draw_ban', 'barred from draws'),
  ('00000000-0000-0000-0000-00000000a0f1', '00000000-0000-0000-0000-00000000a018',
   '00000000-0000-0000-0000-00000000a0c1', 'suspension', 'suspended, and D6 says that excludes too');

-- Lifted, so it bars nobody. The row survives; what makes it inactive is
-- lifted_at, read at query time rather than a maintained status column.
insert into public.member_blocks
  (organization_id, member_id, company_id, kind, reason, lifted_at, lift_reason)
values
  ('00000000-0000-0000-0000-00000000a0f1', '00000000-0000-0000-0000-00000000a019',
   '00000000-0000-0000-0000-00000000a0c1', 'draw_ban', 'was barred', now(), 'appealed and won');

insert into public.participations
  (id, promotion_id, member_id, organization_id, company_id, allows_multiple, status, source, participated_at)
values
  ('00000000-0000-0000-0000-00000000a101', '00000000-0000-0000-0000-00000000a0e2',
   '00000000-0000-0000-0000-00000000a011', '00000000-0000-0000-0000-00000000a0f1',
   '00000000-0000-0000-0000-00000000a0c1', true, 'VALID', 'MANUAL', now() - interval '10 hours'),
  ('00000000-0000-0000-0000-00000000a102', '00000000-0000-0000-0000-00000000a0e2',
   '00000000-0000-0000-0000-00000000a012', '00000000-0000-0000-0000-00000000a0f1',
   '00000000-0000-0000-0000-00000000a0c1', true, 'DUPLICATE', 'MANUAL', now() - interval '9 hours'),
  ('00000000-0000-0000-0000-00000000a103', '00000000-0000-0000-0000-00000000a0e2',
   '00000000-0000-0000-0000-00000000a013', '00000000-0000-0000-0000-00000000a0f1',
   '00000000-0000-0000-0000-00000000a0c1', true, 'TOO_SOON', 'MANUAL', now() - interval '8 hours'),
  ('00000000-0000-0000-0000-00000000a104', '00000000-0000-0000-0000-00000000a0e2',
   '00000000-0000-0000-0000-00000000a014', '00000000-0000-0000-0000-00000000a0f1',
   '00000000-0000-0000-0000-00000000a0c1', true, 'OVER_LIMIT', 'MANUAL', now() - interval '7 hours'),
  ('00000000-0000-0000-0000-00000000a105', '00000000-0000-0000-0000-00000000a0e2',
   '00000000-0000-0000-0000-00000000a015', '00000000-0000-0000-0000-00000000a0f1',
   '00000000-0000-0000-0000-00000000a0c1', true, 'VALID', 'MANUAL', now() - interval '6 hours'),
  ('00000000-0000-0000-0000-00000000a106', '00000000-0000-0000-0000-00000000a0e2',
   '00000000-0000-0000-0000-00000000a016', '00000000-0000-0000-0000-00000000a0f1',
   '00000000-0000-0000-0000-00000000a0c1', true, 'VALID', 'MANUAL', now() - interval '5 hours'),
  ('00000000-0000-0000-0000-00000000a107', '00000000-0000-0000-0000-00000000a0e2',
   '00000000-0000-0000-0000-00000000a017', '00000000-0000-0000-0000-00000000a0f1',
   '00000000-0000-0000-0000-00000000a0c1', true, 'VALID', 'MANUAL', now() - interval '4 hours'),
  ('00000000-0000-0000-0000-00000000a108', '00000000-0000-0000-0000-00000000a0e2',
   '00000000-0000-0000-0000-00000000a018', '00000000-0000-0000-0000-00000000a0f1',
   '00000000-0000-0000-0000-00000000a0c1', true, 'VALID', 'MANUAL', now() - interval '3 hours'),
  ('00000000-0000-0000-0000-00000000a109', '00000000-0000-0000-0000-00000000a0e2',
   '00000000-0000-0000-0000-00000000a019', '00000000-0000-0000-0000-00000000a0f1',
   '00000000-0000-0000-0000-00000000a0c1', true, 'VALID', 'MANUAL', now() - interval '2 hours'),
  ('00000000-0000-0000-0000-00000000a10a', '00000000-0000-0000-0000-00000000a0e2',
   '00000000-0000-0000-0000-00000000a01a', '00000000-0000-0000-0000-00000000a0f1',
   '00000000-0000-0000-0000-00000000a0c1', true, 'VALID', 'MANUAL', now() - interval '90 minutes'),
  ('00000000-0000-0000-0000-00000000a10b', '00000000-0000-0000-0000-00000000a0e2',
   '00000000-0000-0000-0000-00000000a01a', '00000000-0000-0000-0000-00000000a0f1',
   '00000000-0000-0000-0000-00000000a0c1', true, 'VALID', 'MANUAL', now() - interval '30 minutes');

create temporary table eligible_probe as
select * from public.draw_eligible_participations('00000000-0000-0000-0000-00000000a0e2');

select ok(exists (select 1 from eligible_probe where participation_id = '00000000-0000-0000-0000-00000000a101'),
          'a VALID participation is in the hat');
select ok(not exists (select 1 from eligible_probe where participation_id = '00000000-0000-0000-0000-00000000a102'),
          'a DUPLICATE is out: it is the record of an attempt, not an entry');
select ok(not exists (select 1 from eligible_probe where participation_id = '00000000-0000-0000-0000-00000000a103'),
          'a TOO_SOON is out');
select ok(not exists (select 1 from eligible_probe where participation_id = '00000000-0000-0000-0000-00000000a104'),
          'an OVER_LIMIT is out');
select ok(not exists (select 1 from eligible_probe where participation_id = '00000000-0000-0000-0000-00000000a105'),
          'a soft-deleted listener is out');
select ok(not exists (select 1 from eligible_probe where participation_id = '00000000-0000-0000-0000-00000000a106'),
          'an anonymised listener is out');
select ok(not exists (select 1 from eligible_probe where participation_id = '00000000-0000-0000-0000-00000000a107'),
          'a listener under a live draw_ban is out');
select ok(not exists (select 1 from eligible_probe where participation_id = '00000000-0000-0000-0000-00000000a108'),
          'a listener under a live suspension is out too, which is D6');
select ok(exists (select 1 from eligible_probe where participation_id = '00000000-0000-0000-0000-00000000a109'),
          'a listener whose block was lifted is back in');

-- D1, and the case every other rule in this block leans on.
select is(
  (select count(*)::int from eligible_probe
    where member_id = '00000000-0000-0000-0000-00000000a01a'),
  2, 'two participations by one listener are two entries, not one');

-- The order Task 4 freezes as position. Asserted against the function's OWN
-- output order rather than by re-sorting its rows here, which would compare
-- the ordering to itself and pass however the function ordered them.
select is(
  (select participation_id from public.draw_eligible_participations(
     '00000000-0000-0000-0000-00000000a0e2') limit 1),
  '00000000-0000-0000-0000-00000000a101'::uuid,
  'the hat comes out earliest-first, which is the order position freezes');

-- A promotion nobody entered is empty rather than an error: run_draw is what
-- turns that into a refusal, because only run_draw knows it was asked to draw.
select is(
  (select count(*)::int from public.draw_eligible_participations(
     '00000000-0000-0000-0000-00000000a0e1')),
  0, 'a promotion nobody entered yields an empty hat, not an error');

-- The two private cores ------------------------------------------------------
--
-- Both are SECURITY INVOKER with EXECUTE granted to nobody, the pattern
-- apply_participation (0054) and participation_status_for (0069) established:
-- the permission check lives beside the operation in run_draw, not in here.

select ok(not has_function_privilege('authenticated',
            'public.draw_eligible_participations(uuid)', 'EXECUTE'),
          'the eligibility list is a private core, like every other rule body here');
select ok(not has_function_privilege('authenticated',
            'public.member_block_active(uuid, uuid, uuid)', 'EXECUTE'),
          'the block predicate is private: is_member_blocked is the public door and keeps its own guard');

select * from finish();
rollback;
