begin;
select plan(81);

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
          array['AWAITING_PICKUP', 'DELIVERED', 'RETURNED', 'WRITTEN_OFF'],
          'winner_status carries what a prize can become, and SUPERSEDED is not among them');

-- Existence ------------------------------------------------------------------

select has_table('public', 'draws', 'draws exists');
select has_table('public', 'draw_entries', 'draw_entries exists');
select has_table('public', 'winners', 'winners exists');
-- Block 6c, D1: there are no runners-up. A removal nothing asserts is a
-- removal somebody re-adds, so the absence is tested rather than assumed.
select ok(not exists (select 1 from pg_class
                       where relname = 'draw_runners_up' and relnamespace = 'public'::regnamespace),
          'there is no runner-up queue: a draw awards prizes and nothing waits behind them');
select ok(not exists (select 1 from information_schema.columns
                       where table_schema = 'public' and table_name = 'draws'
                         and column_name = 'runner_up_count'),
          'and a draw does not record how many runners-up were asked for');
select ok('SUPERSEDED' <> all(enum_range(null::public.winner_status)::text[]),
          'SUPERSEDED is gone: it existed only for a winner whose prize went to a runner-up');

-- RLS ------------------------------------------------------------------------

select is(relrowsecurity, true, 'RLS enabled on draws')
  from pg_class where oid = 'public.draws'::regclass;
select is(relrowsecurity, true, 'RLS enabled on draw_entries')
  from pg_class where oid = 'public.draw_entries'::regclass;
select is(relrowsecurity, true, 'RLS enabled on winners')
  from pg_class where oid = 'public.winners'::regclass;

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
     seed, algorithm_version, entry_count, offered_count, status, cancelled_at)
  values
    ('00000000-0000-0000-0000-00000000a0b1',
     '00000000-0000-0000-0000-00000000a0e1',
     '00000000-0000-0000-0000-00000000a0f1',
     '00000000-0000-0000-0000-00000000a0c1',
     repeat('a', 64), 1, 5, 5, 'CANCELLED', now())
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

-- ---------------------------------------------------------------------------
-- Task 4: running the draw.
--
-- A seeding helper, because every case below needs the same six-table setup and
-- six hand-written copies of it would drift. It builds a promotion with
-- p_listeners eligible listeners holding one VALID participation each, and
-- p_units of one prize linked THROUGH apply_inventory_movement -- the ledger's
-- single writer -- so the balances these assertions read were produced the way
-- production produces them, not typed in.

create function pg_temp.seed_draw_promotion(
  p_promotion_id uuid,
  p_name         text,
  p_listeners    integer,
  p_units        integer,
  p_promo_days   integer default null,
  p_prize_days   integer default null
)
returns uuid
language plpgsql
as $$
declare
  v_org   uuid := '00000000-0000-0000-0000-00000000a0f1';
  v_co    uuid := '00000000-0000-0000-0000-00000000a0c1';
  v_prize uuid := gen_random_uuid();
  v_link  uuid := gen_random_uuid();
  v_member uuid;
  i integer;
begin
  insert into public.prizes (id, organization_id, company_id, name, default_pickup_deadline_days)
  values (v_prize, v_org, v_co, p_name || ' prize', p_prize_days);

  insert into public.inventory_balances (company_id, prize_id, organization_id, available)
  values (v_co, v_prize, v_org, greatest(p_units, 1));

  insert into public.promotions
    (id, organization_id, company_id, name, starts_at, ends_at,
     allow_multiple_entries, min_hours_between_entries, pickup_deadline_days)
  values (p_promotion_id, v_org, v_co, p_name, now() - interval '2 days',
          now() + interval '1 day', true, 1, p_promo_days);

  insert into public.promotion_prizes (id, promotion_id, prize_id, organization_id, company_id)
  values (v_link, p_promotion_id, v_prize, v_org, v_co);

  if p_units > 0 then
    perform public.apply_inventory_movement(
      v_co, v_prize, 'PROMOTION_LINK'::public.inventory_movement_type, p_units,
      'available'::public.inventory_bucket, 'linked'::public.inventory_bucket,
      null, null, v_link);
  end if;

  for i in 1..p_listeners loop
    v_member := gen_random_uuid();
    insert into public.members (id, organization_id, full_name)
    values (v_member, v_org, p_name || ' listener ' || i);
    insert into public.member_company_links (member_id, company_id, organization_id)
    values (v_member, v_co, v_org);
    insert into public.participations
      (promotion_id, member_id, organization_id, company_id, allows_multiple,
       status, source, participated_at)
    values (p_promotion_id, v_member, v_org, v_co, true, 'VALID', 'MANUAL',
            now() - make_interval(hours => p_listeners - i + 1));
  end loop;

  return v_link;
end;
$$;

-- The operator who may draw, and the one who may not. Two roles rather than
-- one, so "refused without draws.execute" is a statement about that code and
-- not about being a stranger to the Station.
insert into public.roles (id, organization_id, name) values
  ('00000000-0000-0000-0000-00000000a201', '00000000-0000-0000-0000-00000000a0f1', 'Draw Operator'),
  ('00000000-0000-0000-0000-00000000a202', '00000000-0000-0000-0000-00000000a0f1', 'Promotions Viewer');
insert into public.role_permissions (role_id, permission_code) values
  ('00000000-0000-0000-0000-00000000a201', 'draws.execute'),
  ('00000000-0000-0000-0000-00000000a201', 'draws.cancel'),
  ('00000000-0000-0000-0000-00000000a201', 'promotions.view'),
  ('00000000-0000-0000-0000-00000000a202', 'promotions.view');

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-00000000a203', 'draw-operator@example.test'),
  ('00000000-0000-0000-0000-00000000a204', 'draw-nobody@example.test');

insert into public.company_memberships (user_id, company_id, organization_id, role_id) values
  ('00000000-0000-0000-0000-00000000a203', '00000000-0000-0000-0000-00000000a0c1',
   '00000000-0000-0000-0000-00000000a0f1', '00000000-0000-0000-0000-00000000a201'),
  ('00000000-0000-0000-0000-00000000a204', '00000000-0000-0000-0000-00000000a0c1',
   '00000000-0000-0000-0000-00000000a0f1', '00000000-0000-0000-0000-00000000a202');

select pg_temp.seed_draw_promotion('00000000-0000-0000-0000-00000000a2e1', 'Happy draw', 3, 1);

set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000a203", "role": "authenticated"}';

create temporary table happy_draw as
select public.run_draw('00000000-0000-0000-0000-00000000a2e1'::uuid, null) as draw_id;

reset role;

select is(
  (select count(*)::int from public.winners w join happy_draw h on h.draw_id = w.draw_id),
  1, 'one unit on offer awards exactly one winner');
select is(
  (select count(*)::int from public.draw_entries e join happy_draw h on h.draw_id = e.draw_id),
  3, 'all three eligible participations were frozen into the hat');
select ok(
  (select d.seed ~ '^[0-9a-f]{64}$' from public.draws d join happy_draw h on h.draw_id = d.id),
  'the seed is 64 hex characters, generated inside the function');
select is(
  (select d.entry_count from public.draws d join happy_draw h on h.draw_id = d.id),
  3, 'entry_count records the size of the hat');
select is(
  (select d.algorithm_version from public.draws d join happy_draw h on h.draw_id = d.id),
  1, 'the draw records which version of the contract produced it');
select is(
  (select b.drawn from public.promotion_prize_balances b
     join public.promotion_prizes l on l.id = b.promotion_prize_id
    where l.promotion_id = '00000000-0000-0000-0000-00000000a2e1'),
  1, 'the unit moved from linked to awaiting_pickup through the ledger');
select ok(
  (select w.deadline_at is null from public.winners w join happy_draw h on h.draw_id = w.draw_id),
  'neither the promotion nor the prize set a deadline, so the winner has none');

-- No personal data in an audit row. Block 3's rule, absolute.
select ok(
  (select d.detail ? 'draw_id' and not (d.detail ? 'member_id')
          and d.detail::text not like '%' || (select w.member_id::text from public.winners w
                                                join happy_draw h on h.draw_id = w.draw_id) || '%'
     from public.audit_logs d
    where d.action = 'run_draw'
      and d.target_id = (select draw_id from happy_draw)),
  'the audit row carries ids and counts, and no listener');

-- The deadline, frozen at the draw ------------------------------------------

select pg_temp.seed_draw_promotion('00000000-0000-0000-0000-00000000a2e2', 'Promo deadline', 2, 1, 7, 30);
select pg_temp.seed_draw_promotion('00000000-0000-0000-0000-00000000a2e3', 'Prize deadline', 2, 1, null, 15);

set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000a203", "role": "authenticated"}';
create temporary table promo_deadline_draw as
select public.run_draw('00000000-0000-0000-0000-00000000a2e2'::uuid, null) as draw_id;
create temporary table prize_deadline_draw as
select public.run_draw('00000000-0000-0000-0000-00000000a2e3'::uuid, null) as draw_id;
reset role;

select ok(
  (select w.deadline_at = d.drawn_at + make_interval(days => 7)
     from public.winners w
     join public.draws d on d.id = w.draw_id
     join promo_deadline_draw p on p.draw_id = d.id),
  'the promotion''s days override the prize''s');
select ok(
  (select w.deadline_at = d.drawn_at + make_interval(days => 15)
     from public.winners w
     join public.draws d on d.id = w.draw_id
     join prize_deadline_draw p on p.draw_id = d.id),
  'the prize''s default applies when the promotion sets none');

-- One person, one prize, however many entries they hold ----------------------

select pg_temp.seed_draw_promotion('00000000-0000-0000-0000-00000000a2e4', 'Weighted', 2, 3);
-- Two more entries for each of the two listeners: three each, six in the hat.
insert into public.participations
  (promotion_id, member_id, organization_id, company_id, allows_multiple, status, source, participated_at)
select '00000000-0000-0000-0000-00000000a2e4', p.member_id,
       '00000000-0000-0000-0000-00000000a0f1', '00000000-0000-0000-0000-00000000a0c1',
       true, 'VALID', 'MANUAL', now() - make_interval(mins => g.n)
from (select distinct member_id from public.participations
       where promotion_id = '00000000-0000-0000-0000-00000000a2e4') p
cross join generate_series(10, 20, 10) as g(n);

set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000a203", "role": "authenticated"}';
create temporary table weighted_draw as
select public.run_draw('00000000-0000-0000-0000-00000000a2e4'::uuid, null) as draw_id;
reset role;

select is(
  (select count(*)::int from public.draw_entries e join weighted_draw w on w.draw_id = e.draw_id),
  6, 'six entries went into the hat: two listeners with three each (D1)');
select is(
  (select count(*)::int from public.winners w join weighted_draw d on d.draw_id = w.draw_id),
  2, 'and three units on offer awarded only two prizes, because there are only two people (D2)');

-- The refusals ---------------------------------------------------------------

select pg_temp.seed_draw_promotion('00000000-0000-0000-0000-00000000a2e5', 'Short stock', 3, 1);
select pg_temp.seed_draw_promotion('00000000-0000-0000-0000-00000000a2e6', 'Nobody', 0, 1);
select pg_temp.seed_draw_promotion('00000000-0000-0000-0000-00000000a2e7', 'Cancelled', 2, 1);
select pg_temp.seed_draw_promotion('00000000-0000-0000-0000-00000000a2e8', 'Archived', 2, 1);
select pg_temp.seed_draw_promotion('00000000-0000-0000-0000-00000000a2e9', 'Forbidden', 2, 1);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-00000000a205', 'draw-canceller@example.test');
update public.promotions
   set cancelled_at = now(), cancelled_by = '00000000-0000-0000-0000-00000000a205',
       cancellation_reason = 'called off'
 where id = '00000000-0000-0000-0000-00000000a2e7';
update public.promotions
   set deleted_at = now(), deleted_by = '00000000-0000-0000-0000-00000000a205'
 where id = '00000000-0000-0000-0000-00000000a2e8';

set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000a203", "role": "authenticated"}';

select throws_ok($$
  select public.run_draw('00000000-0000-0000-0000-00000000a2e5'::uuid,
    jsonb_build_array(jsonb_build_object(
      'promotion_prize_id',
      (select id from public.promotion_prizes where promotion_id = '00000000-0000-0000-0000-00000000a2e5'),
      'quantity', 5)))
$$, '22023', null, 'asking for more units than are linked is refused');

select throws_ok($$
  select public.run_draw('00000000-0000-0000-0000-00000000a2e6'::uuid, null)
$$, '22023', null, 'a promotion with nobody eligible is refused');

-- Cancelled and archived, which the spec was silent about. A draw over a
-- cancelled promotion would award prizes for something that is not happening.
-- The codes follow this schema's existing vocabulary rather than the plan's
-- suggestion of 22023 for both: link_prize_to_promotion (0049) and
-- apply_participation (0054) both answer P0002 for a soft-deleted promotion
-- and 22023 for a cancelled one, and a third dialect here would be the drift
-- those two exist to prevent.
select throws_ok($$
  select public.run_draw('00000000-0000-0000-0000-00000000a2e7'::uuid, null)
$$, '22023', null, 'a cancelled promotion cannot be drawn');

select throws_ok($$
  select public.run_draw('00000000-0000-0000-0000-00000000a2e8'::uuid, null)
$$, 'P0002', null, 'an archived promotion cannot be drawn');

reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000a204", "role": "authenticated"}';

select throws_ok($$
  select public.run_draw('00000000-0000-0000-0000-00000000a2e9'::uuid, null)
$$, '42501', null, 'promotions.view is not draws.execute');

reset role;

-- Nothing happened, and a row saying it did is worse than none.
select is(
  (select count(*)::int from public.draws
    where promotion_id in ('00000000-0000-0000-0000-00000000a2e6',
                           '00000000-0000-0000-0000-00000000a2e7',
                           '00000000-0000-0000-0000-00000000a2e8',
                           '00000000-0000-0000-0000-00000000a2e9')),
  0, 'a refused draw leaves no draws row behind');

select is(
  (select b.drawn from public.promotion_prize_balances b
     join public.promotion_prizes l on l.id = b.promotion_prize_id
    where l.promotion_id = '00000000-0000-0000-0000-00000000a2e5'),
  0, 'and a refused draw spends no stock');

-- The doors ------------------------------------------------------------------

select ok(has_function_privilege('authenticated', 'public.run_draw(uuid, jsonb, uuid[])', 'EXECUTE'),
          'run_draw is the door an operator comes through');
select ok(not has_function_privilege('authenticated', 'public.apply_draw(uuid, uuid, uuid, jsonb, uuid[])', 'EXECUTE'),
          'apply_draw is the private core behind it');

-- ---------------------------------------------------------------------------
-- Task 6: cancelling a draw.
--
-- D7: cancelling reverses the inventory and marks the draw, and deletes
-- nothing. The hat, the seed and the winners stay, because the record of a
-- cancelled draw is the evidence that it was cancelled and who cancelled it.

-- An operator who may draw and may NOT undo one, which is the whole reason
-- 4.3 asks for two codes rather than one.
insert into public.roles (id, organization_id, name) values
  ('00000000-0000-0000-0000-00000000a206', '00000000-0000-0000-0000-00000000a0f1', 'Draw Only');
insert into public.role_permissions (role_id, permission_code) values
  ('00000000-0000-0000-0000-00000000a206', 'draws.execute'),
  ('00000000-0000-0000-0000-00000000a206', 'promotions.view');
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-00000000a207', 'draw-no-cancel@example.test');
insert into public.company_memberships (user_id, company_id, organization_id, role_id) values
  ('00000000-0000-0000-0000-00000000a207', '00000000-0000-0000-0000-00000000a0c1',
   '00000000-0000-0000-0000-00000000a0f1', '00000000-0000-0000-0000-00000000a206');

select pg_temp.seed_draw_promotion('00000000-0000-0000-0000-00000000a2ea', 'Cancel me', 3, 2);
select pg_temp.seed_draw_promotion('00000000-0000-0000-0000-00000000a2eb', 'Cancel twice', 2, 1);
select pg_temp.seed_draw_promotion('00000000-0000-0000-0000-00000000a2ec', 'Blank reason', 2, 1);
select pg_temp.seed_draw_promotion('00000000-0000-0000-0000-00000000a2ed', 'Already delivered', 2, 1);
select pg_temp.seed_draw_promotion('00000000-0000-0000-0000-00000000a2ee', 'Forbidden cancel', 2, 1);

set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000a203", "role": "authenticated"}';
create temporary table cancel_draws as
select 'a2ea' as tag, public.run_draw('00000000-0000-0000-0000-00000000a2ea'::uuid, null) as draw_id
union all
select 'a2eb', public.run_draw('00000000-0000-0000-0000-00000000a2eb'::uuid, null)
union all
select 'a2ec', public.run_draw('00000000-0000-0000-0000-00000000a2ec'::uuid, null)
union all
select 'a2ed', public.run_draw('00000000-0000-0000-0000-00000000a2ed'::uuid, null)
union all
select 'a2ee', public.run_draw('00000000-0000-0000-0000-00000000a2ee'::uuid, null);
reset role;

-- One winner of a2ed has already collected, which is the guard 6b needs from
-- the start so it cannot introduce the hole by forgetting it.
update public.winners set status = 'DELIVERED'
 where draw_id = (select draw_id from cancel_draws where tag = 'a2ed');

select is(
  (select count(*)::int from public.winners
    where draw_id = (select draw_id from cancel_draws where tag = 'a2ea')),
  2, 'the draw about to be cancelled awarded two units');

set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000a203", "role": "authenticated"}';

select lives_ok($$
  select public.cancel_draw(
    (select draw_id from cancel_draws where tag = 'a2ea'),
    'drawn against the wrong promotion')
$$, 'a draw can be cancelled with a reason');

select throws_ok($$
  select public.cancel_draw(
    (select draw_id from cancel_draws where tag = 'a2ea'),
    'again')
$$, '22023', null, 'cancelling a cancelled draw is refused');

select throws_ok($$
  select public.cancel_draw(
    (select draw_id from cancel_draws where tag = 'a2ec'), '   ')
$$, '22023', null, 'a blank reason is refused');

select throws_ok($$
  select public.cancel_draw(
    (select draw_id from cancel_draws where tag = 'a2ed'), 'too late')
$$, '22023', null, 'a draw whose prize has already been handed over cannot be cancelled');

reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000a207", "role": "authenticated"}';

select throws_ok($$
  select public.cancel_draw(
    (select draw_id from cancel_draws where tag = 'a2ee'), 'not mine to undo')
$$, '42501', null, 'draws.execute is not draws.cancel');

reset role;

-- The inventory went back -----------------------------------------------------

select is(
  (select b.drawn from public.promotion_prize_balances b
     join public.promotion_prizes l on l.id = b.promotion_prize_id
    where l.promotion_id = '00000000-0000-0000-0000-00000000a2ea'),
  0, 'every unit went back from awaiting_pickup to linked');
select is(
  (select b.linked from public.promotion_prize_balances b
     join public.promotion_prizes l on l.id = b.promotion_prize_id
    where l.promotion_id = '00000000-0000-0000-0000-00000000a2ea'),
  2, 'and linked is untouched: the units are still committed to the promotion');
select is(
  (select count(*)::int from public.inventory_movements m
     join public.promotion_prizes l on l.id = m.promotion_prize_id
    where l.promotion_id = '00000000-0000-0000-0000-00000000a2ea'
      and m.movement_type = 'DRAW_CANCEL'),
  2, 'one DRAW_CANCEL movement per winner, through the one writer');

-- The record survives whole (D7) ----------------------------------------------

select is(
  (select status::text from public.draws
    where id = (select draw_id from cancel_draws where tag = 'a2ea')),
  'CANCELLED', 'the draw says it was cancelled');
select ok(
  (select cancelled_at is not null and cancelled_by is not null
      and length(btrim(cancellation_reason)) > 0
     from public.draws
    where id = (select draw_id from cancel_draws where tag = 'a2ea')),
  'and says when, by whom and why');
select is(
  (select count(*)::int from public.winners
    where draw_id = (select draw_id from cancel_draws where tag = 'a2ea')),
  2, 'the winners are still there: they are the evidence of what was undone');
select is(
  (select count(*)::int from public.draw_entries
    where draw_id = (select draw_id from cancel_draws where tag = 'a2ea')),
  3, 'the hat is still there');
select ok(
  (select seed ~ '^[0-9a-f]{64}$' from public.draws
    where id = (select draw_id from cancel_draws where tag = 'a2ea')),
  'and so is the seed, so a cancelled draw stays reproducible');

-- A refused cancellation changed nothing.
select is(
  (select b.drawn from public.promotion_prize_balances b
     join public.promotion_prizes l on l.id = b.promotion_prize_id
    where l.promotion_id = '00000000-0000-0000-0000-00000000a2ed'),
  1, 'the draw that could not be cancelled still holds its unit');
select is(
  (select status::text from public.draws
    where id = (select draw_id from cancel_draws where tag = 'a2ee')),
  'COMPLETED', 'and the one the caller could not touch is untouched');

select ok(has_function_privilege('authenticated', 'public.cancel_draw(uuid, text)', 'EXECUTE'),
          'cancel_draw is the door, and it checks draws.cancel behind it');

-- ---------------------------------------------------------------------------
-- Task 7: the two reads.

-- A Station in another Organization entirely, and an operator who holds
-- promotions.view THERE. Everything about them is real except their reach.
insert into public.organizations (id, name) values
  ('00000000-0000-0000-0000-00000000a3f1', 'Org 6a elsewhere');
insert into public.companies (id, organization_id, name, timezone) values
  ('00000000-0000-0000-0000-00000000a3c1', '00000000-0000-0000-0000-00000000a3f1',
   'Station 6a elsewhere', 'America/Sao_Paulo');
insert into public.roles (id, organization_id, name) values
  ('00000000-0000-0000-0000-00000000a3a1', '00000000-0000-0000-0000-00000000a3f1', 'Elsewhere Viewer');
insert into public.role_permissions (role_id, permission_code) values
  ('00000000-0000-0000-0000-00000000a3a1', 'promotions.view');
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-00000000a3a2', 'draw-elsewhere@example.test');
insert into public.company_memberships (user_id, company_id, organization_id, role_id) values
  ('00000000-0000-0000-0000-00000000a3a2', '00000000-0000-0000-0000-00000000a3c1',
   '00000000-0000-0000-0000-00000000a3f1', '00000000-0000-0000-0000-00000000a3a1');

set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000a203", "role": "authenticated"}';

select is(
  (select count(*)::int from public.list_draws('00000000-0000-0000-0000-00000000a2e1')),
  1, 'the promotion''s one draw is listed for somebody who may see the promotion');
select is(
  (select winner_count from public.list_draws('00000000-0000-0000-0000-00000000a2e1')),
  1, 'and the list carries the winner count already computed');

create temporary table drawn_detail as
select public.get_draw((select draw_id from happy_draw)) as body;

select is(
  (select jsonb_array_length(body->'winners') from drawn_detail),
  1, 'get_draw returns the winners');
select ok(
  (select (body->>'seed') ~ '^[0-9a-f]{64}$' and (body->>'algorithm_version') = '1'
     from drawn_detail),
  'and the seed and the algorithm version, plainly: a proof nobody can see is not a proof');

-- The operator holds draws.execute, promotions.view and draws.cancel, and NOT
-- members.view. Whoever may see a draw may see who won it (owner's ruling,
-- 2026-08-02), so the name comes back anyway -- which is precisely the term
-- worth pinning, because this function is SECURITY DEFINER and
-- members_select_reachable (0035) would refuse this same caller this same name
-- through the ordinary door.
-- Matched by pattern, not by a fixed name: WHICH of the three listeners wins is
-- decided by the seed, and asserting one of them would fail two runs in three
-- for a reason that has nothing to do with what this case is about.
select ok(
  (select body->'winners'->0->>'member_name' like 'Happy draw listener%' from drawn_detail),
  'a caller with promotions.view and no members.view still gets the winner''s name');
select ok(
  (select body->'winners'->0->>'member_id' is not null
      and body->'winners'->0->>'deadline_at' is null
      and body->'winners'->0->>'prize_name' is not null
     from drawn_detail),
  'along with everything that is the draw itself');

reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000a3a2", "role": "authenticated"}';

select throws_ok(
  format($$select public.get_draw(%L::uuid)$$, (select draw_id from happy_draw)),
  '42501', null, 'a draw is invisible to an operator at another Station');

reset role;

select * from finish();
rollback;
