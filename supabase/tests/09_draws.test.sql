begin;
select plan(22);

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

select * from finish();
rollback;
