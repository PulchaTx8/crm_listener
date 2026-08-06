begin;
select plan(12);

-- Block 10a. The audit listing and the integration RPCs.
--
-- WHAT THIS FILE CANNOT DO, stated first because it shapes every assertion
-- below: pgTAP runs as superuser with a null auth.uid(), so RLS never applies
-- to it. The whole POINT of list_audit_logs is that RLS applies -- so the
-- permission behaviour is proved in tests/isolation/audit.test.ts, with real
-- sessions, and what is proved here is the SHAPE that makes that possible.
--
-- Fixtures use the 10a tag.

select has_function('public', 'list_audit_logs',
  array['uuid', 'text', 'text', 'uuid', 'timestamptz', 'timestamptz', 'boolean',
        'timestamptz', 'bigint', 'integer'],
  'list_audit_logs exists');

-- ---------------------------------------------------------------------------
-- THE ASSERTION THE WHOLE BLOCK RESTS ON.
--
-- Every other list RPC here is SECURITY DEFINER. This one must not be, because
-- audit_logs' two policies already carry the rule and a rewrite of them would
-- be invisible: the screen would still render, still paginate, and still look
-- like an audit trail. There is no behavioural test that catches a DEFINER
-- version -- it passes everything on the day it is written -- so the attribute
-- itself is asserted.
-- ---------------------------------------------------------------------------
select ok(
  not (select prosecdef from pg_proc
        where proname = 'list_audit_logs' and pronargs = 10),
  'list_audit_logs is SECURITY INVOKER, so the policies keep applying');

-- And it holds no permission check of its own, which would be the same mistake
-- wearing a different hat: a second implementation of a rule that has a home.
select ok(
  (select prosrc from pg_proc where proname = 'list_audit_logs' and pronargs = 10)
    not like '%has_org_permission%',
  'list_audit_logs restates no permission rule of its own');

-- service_role is deliberately NOT granted: it bypasses RLS, so this function
-- would answer it with every Organization's trail at once.
select ok(
  not has_function_privilege('service_role',
    'public.list_audit_logs(uuid, text, text, uuid, timestamptz, timestamptz, boolean, timestamptz, bigint, integer)',
    'EXECUTE'),
  'service_role cannot call the audit listing');
select ok(
  has_function_privilege('authenticated',
    'public.list_audit_logs(uuid, text, text, uuid, timestamptz, timestamptz, boolean, timestamptz, bigint, integer)',
    'EXECUTE'),
  'authenticated can call the audit listing');

-- ---------------------------------------------------------------------------
-- Fixtures. As superuser, RLS is off, so these assertions are about the QUERY
-- -- the keyset, the count, the two actor columns -- and not about permission.
-- ---------------------------------------------------------------------------

insert into public.organizations (id, name) values
  ('00000000-0000-0000-0000-00000a010001', 'Org 10a');
insert into public.companies (id, organization_id, name, timezone) values
  ('00000000-0000-0000-0000-00000a020001', '00000000-0000-0000-0000-00000a010001',
   'Station 10a', 'America/Sao_Paulo');
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-00000a050001', '10a-actor@example.test');
-- A profile with NO full_name, on purpose: it is the case that proves
-- actor_name being null does not mean the system acted.
insert into public.profiles (id, email) values
  ('00000000-0000-0000-0000-00000a050001', '10a-actor@example.test');

insert into public.audit_logs
  (actor_id, action, target_table, target_id, organization_id, company_id, detail, created_at)
values
  ('00000000-0000-0000-0000-00000a050001', 'test_action_a', 'members',
   '00000000-0000-0000-0000-00000a030001',
   '00000000-0000-0000-0000-00000a010001', '00000000-0000-0000-0000-00000a020001',
   '{"k": 1}'::jsonb, '2026-08-01 12:00:00+00'),
  ('00000000-0000-0000-0000-00000a050001', 'test_action_b', 'members',
   '00000000-0000-0000-0000-00000a030002',
   '00000000-0000-0000-0000-00000a010001', '00000000-0000-0000-0000-00000a020001',
   '{"k": 2}'::jsonb, '2026-08-02 12:00:00+00'),
  -- The clock: no actor at all. 0094's shape -- pg_cron carries no auth.uid().
  (null, 'test_action_c', 'winners', null,
   '00000000-0000-0000-0000-00000a010001', '00000000-0000-0000-0000-00000a020001',
   '{}'::jsonb, '2026-08-03 12:00:00+00');

-- total_count counts the FILTERED set, not the page and not what is left after
-- the cursor: a count that shrank per page would read as rows disappearing.
select is(
  (select distinct l.total_count from public.list_audit_logs(
     p_company_id => '00000000-0000-0000-0000-00000a020001', p_limit => 1) l),
  3::bigint,
  'total_count counts every matching row, not the page');

-- The filter narrows both the rows and the count together.
select is(
  (select distinct l.total_count from public.list_audit_logs(
     p_company_id => '00000000-0000-0000-0000-00000a020001',
     p_action => 'test_action_b', p_limit => 10) l),
  1::bigint,
  'an action filter narrows the count with the rows');

-- The keyset, with a BIGINT cursor -- the one place in this codebase where it
-- is not a uuid.
select is(
  (select l2.action from public.list_audit_logs(
     p_company_id => '00000000-0000-0000-0000-00000a020001',
     p_cursor_at => (select l1.created_at from public.list_audit_logs(
        p_company_id => '00000000-0000-0000-0000-00000a020001', p_limit => 1) l1),
     p_cursor_id => (select l1.id from public.list_audit_logs(
        p_company_id => '00000000-0000-0000-0000-00000a020001', p_limit => 1) l1),
     p_limit => 1) l2),
  'test_action_b',
  'the second page resumes after the first');

-- Newest first.
select is(
  (select l.action from public.list_audit_logs(
     p_company_id => '00000000-0000-0000-0000-00000a020001', p_limit => 1) l),
  'test_action_c',
  'the newest row comes first');

-- THE TWO ACTOR COLUMNS. A human with no display name has a null actor_name and
-- a real actor_id; the clock has null in both. A screen that keyed "(system)"
-- off the NAME would label the first one the system, which is 0096's warning
-- carried into this block.
select is(
  (select l.actor_name from public.list_audit_logs(
     p_company_id => '00000000-0000-0000-0000-00000a020001',
     p_action => 'test_action_a', p_limit => 1) l),
  null,
  'a human with no display name has a null actor_name');
select isnt(
  (select l.actor_id from public.list_audit_logs(
     p_company_id => '00000000-0000-0000-0000-00000a020001',
     p_action => 'test_action_a', p_limit => 1) l),
  null,
  '...and a real actor_id beside it, which is what tells it from the clock');
select is(
  (select l.actor_id from public.list_audit_logs(
     p_company_id => '00000000-0000-0000-0000-00000a020001',
     p_action => 'test_action_c', p_limit => 1) l),
  null,
  'the clock has no actor_id at all');

select * from finish();
rollback;
