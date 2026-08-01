begin;
select plan(15);

-- Block 5b, Task 1: the freshness rule on promotions, and the three tables the
-- conversation needs to run -- member_field_confirmations (D2/D3),
-- promotion_refusals (D4) and whatsapp_conversations (D5/D6). Nothing reads or
-- writes these from application code yet; this file is the only thing that
-- exercises them until the tasks that follow.

select has_column('public', 'promotions', 'data_validity_months',
                  'promotions carries the per-promotion freshness rule');

-- Fixtures for the negative-value check -------------------------------------

insert into public.organizations (id, name) values
  ('00000000-0000-0000-0000-0000000008f1', 'Org 5b conversation');
insert into public.companies (id, organization_id, name, timezone) values
  ('00000000-0000-0000-0000-0000000008c1', '00000000-0000-0000-0000-0000000008f1',
   'Station 5b conversation', 'America/Sao_Paulo');

select throws_ok($$
  insert into public.promotions
    (id, organization_id, company_id, name, starts_at, ends_at, data_validity_months)
  values
    ('00000000-0000-0000-0000-0000000008e1', '00000000-0000-0000-0000-0000000008f1',
     '00000000-0000-0000-0000-0000000008c1', 'Negative validity', now(), now() + interval '1 day',
     -1)
$$, '23514', null, 'a negative data_validity_months is refused');

-- Existence and RLS -----------------------------------------------------------

select has_table('public', 'member_field_confirmations',
                 'member_field_confirmations exists');
select has_table('public', 'promotion_refusals', 'promotion_refusals exists');
select has_table('public', 'whatsapp_conversations', 'whatsapp_conversations exists');

select is(relrowsecurity, true, 'RLS enabled on member_field_confirmations')
  from pg_class where oid = 'public.member_field_confirmations'::regclass;
select is(relrowsecurity, true, 'RLS enabled on promotion_refusals')
  from pg_class where oid = 'public.promotion_refusals'::regclass;
select is(relrowsecurity, true, 'RLS enabled on whatsapp_conversations')
  from pg_class where oid = 'public.whatsapp_conversations'::regclass;

-- THE GRANT. Block 5a shipped three tables with a comment saying
-- "service_role only" and no grant behind it, so RLS-bypass privilege was
-- never actually held and every write returned 42501 in production while
-- pgTAP -- which runs as postgres and ignores ACLs entirely -- kept passing.
-- has_table_privilege reads the catalogue rather than attempting a read, which
-- is what makes this assertion able to catch that specific class of miss.
select ok(has_table_privilege('service_role', 'public.member_field_confirmations', 'SELECT'),
          'service_role may read the per-field confirmations it is meant to write and the operator screens are meant to show');

-- TRUNCATE, which the default ACL grants and which no assertion about SELECT,
-- INSERT or UPDATE would ever catch. anon is the unauthenticated PostgREST
-- role, so this is the one privilege check that matters on every table here
-- regardless of what each table's own SELECT/INSERT story turns out to be.
select ok(not has_table_privilege('anon', 'public.member_field_confirmations', 'TRUNCATE'),
          'anon may not truncate the per-field confirmations');
select ok(not has_table_privilege('anon', 'public.promotion_refusals', 'TRUNCATE'),
          'anon may not truncate the refusals');
select ok(not has_table_privilege('anon', 'public.whatsapp_conversations', 'TRUNCATE'),
          'anon may not truncate the conversation store');

-- member_field_confirmations' two foreign keys ---------------------------------

insert into public.members (id, organization_id, full_name) values
  ('00000000-0000-0000-0000-0000000008d1', '00000000-0000-0000-0000-0000000008f1',
   'Listener 5b');
insert into public.organizations (id, name) values
  ('00000000-0000-0000-0000-0000000008f2', 'Org 5b conversation, other');

-- organization_id here (…8f2) is a REAL organization, so the column's own
-- plain FK to organizations is satisfied on its own. What fails is the
-- composite FK to members(id, organization_id): the member named (…8d1)
-- exists only under …8f1, not …8f2, so the pair together names no row.
select throws_ok($$
  insert into public.member_field_confirmations (member_id, organization_id, field)
  values ('00000000-0000-0000-0000-0000000008d1', '00000000-0000-0000-0000-0000000008f2', 'city')
$$, '23503', null, 'a member and an organization that disagree with each other are refused');

insert into public.member_field_confirmations (member_id, organization_id, field) values
  ('00000000-0000-0000-0000-0000000008d1', '00000000-0000-0000-0000-0000000008f1', 'city');

select throws_ok($$
  insert into public.member_field_confirmations (member_id, organization_id, field)
  values ('00000000-0000-0000-0000-0000000008d1', '00000000-0000-0000-0000-0000000008f1', 'city')
$$, '23505', null, 'the same member cannot be confirmed on the same field twice');

-- The backfill, exercised directly ---------------------------------------------
--
-- Nothing above touches it: this project ships no seed.sql, so at db:reset
-- time public.members is empty and the migration's own call to
-- backfill_member_field_confirmations() has nothing to backfill. Calling the
-- SAME function again here, against a fixture of this test's own, is what
-- actually exercises D3's decision -- without this, editing that function to
-- read updated_at instead of created_at passes every other assertion in this
-- file and in the suite.
--
-- created_at and updated_at are set far apart on purpose so the two can never
-- be mistaken for one another by accident.
insert into public.members (id, organization_id, full_name, created_at, updated_at) values
  ('00000000-0000-0000-0000-0000000008d5', '00000000-0000-0000-0000-0000000008f1',
   'Backfill Timestamp Listener', now() - interval '400 days', now() - interval '5 days');

select public.backfill_member_field_confirmations();

select is(
  (select confirmed_at from public.member_field_confirmations
    where member_id = '00000000-0000-0000-0000-0000000008d5' and field = 'full_name'),
  (select created_at from public.members where id = '00000000-0000-0000-0000-0000000008d5'),
  'the backfill dates a confirmation from when the value was created, not from its last edit');

select * from finish();
rollback;
