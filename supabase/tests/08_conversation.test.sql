begin;
select plan(74);

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

-- Task 2: which steps this listener still has to answer -----------------------
--
-- Both of 0066's functions, pinned exactly as apply_participation (0054) is
-- pinned in 02_permissions.test.sql: prosecdef = false plus has_function_privilege
-- against all three of anon, authenticated and service_role. Placed HERE rather
-- than growing 02_permissions.test.sql further, following the more recent
-- precedent: 0061's four private cores (apply_member_candidates and friends)
-- are pinned the same way in 06_whatsapp.test.sql, the test file for the block
-- that shipped them, not in the central permissions file. This block's own
-- test file is that file for 0066.
--
-- has_function_privilege reads pg_proc.proacl rather than attempting an actual
-- call -- which is the only reason it means anything from THIS session. pgTAP
-- runs as postgres, a superuser, and a superuser bypasses ACL checks on every
-- real call regardless of what proacl says; an assertion that tried to prove
-- the grant by calling the function as postgres would pass whether or not the
-- revoke below ever ran. Reading the catalogue instead of attempting the call
-- is what makes this able to catch a future `grant execute ... to authenticated`
-- slipping past all 611 other assertions in this suite untouched.
select is(
  (select prosecdef from pg_proc
    where oid = 'public.member_field_value(uuid, public.promotion_requested_field)'::regprocedure),
  false,
  'member_field_value is SECURITY INVOKER, not DEFINER');
select ok(
  not has_function_privilege('anon', 'public.member_field_value(uuid, public.promotion_requested_field)', 'EXECUTE'),
  'anon may not call member_field_value');
select ok(
  not has_function_privilege('authenticated', 'public.member_field_value(uuid, public.promotion_requested_field)', 'EXECUTE'),
  'authenticated may not call member_field_value');
select ok(
  not has_function_privilege('service_role', 'public.member_field_value(uuid, public.promotion_requested_field)', 'EXECUTE'),
  'service_role may not call member_field_value');

select is(
  (select prosecdef from pg_proc
    where oid = 'public.whatsapp_conversation_steps(uuid, uuid)'::regprocedure),
  false,
  'whatsapp_conversation_steps is SECURITY INVOKER, not DEFINER');
select ok(
  not has_function_privilege('anon', 'public.whatsapp_conversation_steps(uuid, uuid)', 'EXECUTE'),
  'anon may not call whatsapp_conversation_steps');
select ok(
  not has_function_privilege('authenticated', 'public.whatsapp_conversation_steps(uuid, uuid)', 'EXECUTE'),
  'authenticated may not call whatsapp_conversation_steps');
select ok(
  not has_function_privilege('service_role', 'public.whatsapp_conversation_steps(uuid, uuid)', 'EXECUTE'),
  'service_role may not call whatsapp_conversation_steps');

-- A dedicated Org/Station keeps these fixtures from ever touching the ones
-- above (member 8d1 already carries a 'city' confirmation from Task 1's own
-- fixtures) and from ever touching each other: every promotion below gets its
-- own hashtag, so promotions_hashtag_no_overlap (0040) has nothing to say
-- about any of them regardless of how their windows overlap.

insert into public.organizations (id, name) values
  ('00000000-0000-0000-0000-000000000901', 'Org 5b conversation steps');
insert into public.companies (id, organization_id, name) values
  ('00000000-0000-0000-0000-000000000902', '00000000-0000-0000-0000-000000000901',
   'Station 5b conversation steps');

-- A. A promotion that asks for nothing at all gets the one step every
-- conversation always has, and nothing else.
insert into public.members (id, organization_id) values
  ('00000000-0000-0000-0000-000000000910', '00000000-0000-0000-0000-000000000901');

insert into public.promotions
  (id, organization_id, company_id, name, starts_at, ends_at, requested_fields)
values
  ('00000000-0000-0000-0000-000000000920', '00000000-0000-0000-0000-000000000901',
   '00000000-0000-0000-0000-000000000902', 'Consent alone',
   now() - interval '1 day', now() + interval '1 day', '{}');

select is(
  public.whatsapp_conversation_steps(
    '00000000-0000-0000-0000-000000000920', '00000000-0000-0000-0000-000000000910'),
  '[{"kind": "consent"}]'::jsonb,
  'a promotion with no requested fields and no questions yields consent alone');

-- B. Blank counts as empty, and empty is asked WHATEVER the validity says --
-- even a confirmation timestamped this instant does not save a field whose
-- current value is blank.
insert into public.members (id, organization_id, neighbourhood) values
  ('00000000-0000-0000-0000-000000000911', '00000000-0000-0000-0000-000000000901', '   ');
insert into public.member_field_confirmations (member_id, organization_id, field, confirmed_at) values
  ('00000000-0000-0000-0000-000000000911', '00000000-0000-0000-0000-000000000901', 'neighbourhood', now());

insert into public.promotions
  (id, organization_id, company_id, name, starts_at, ends_at,
   whatsapp_enabled, hashtag, requested_fields, data_validity_months)
values
  ('00000000-0000-0000-0000-000000000921', '00000000-0000-0000-0000-000000000901',
   '00000000-0000-0000-0000-000000000902', 'Blank counts as empty',
   now() - interval '1 day', now() + interval '1 day',
   true, '#t2blank', array['neighbourhood']::public.promotion_requested_field[], 12);

select is(
  public.whatsapp_conversation_steps(
    '00000000-0000-0000-0000-000000000921', '00000000-0000-0000-0000-000000000911'),
  '[{"kind": "consent"}, {"kind": "field", "field": "neighbourhood"}]'::jsonb,
  'a blank field is included even though it was confirmed moments ago -- emptiness never reaches the validity check');

-- C/D/E/F. One promotion, four listeners, walking the freshness boundary for
-- `address`. The window fixtures are built from the SAME now() and the SAME
-- make_interval(months => 6) the function itself evaluates -- now() is fixed
-- for the whole transaction this file runs in, so "one day either side" and
-- "exactly on it" are exact, not approximate, and a boundary written `<=`
-- instead of `<` has something in this file to disagree with.
insert into public.promotions
  (id, organization_id, company_id, name, starts_at, ends_at,
   whatsapp_enabled, hashtag, requested_fields, data_validity_months)
values
  ('00000000-0000-0000-0000-000000000922', '00000000-0000-0000-0000-000000000901',
   '00000000-0000-0000-0000-000000000902', 'Address freshness window',
   now() - interval '1 day', now() + interval '1 day',
   true, '#t2window', array['address']::public.promotion_requested_field[], 6);

-- C: confirmed one day INSIDE the window (fresher than the cutoff) -- excluded.
insert into public.members (id, organization_id, address_line) values
  ('00000000-0000-0000-0000-000000000912', '00000000-0000-0000-0000-000000000901', 'Rua Inside');
insert into public.member_field_confirmations (member_id, organization_id, field, confirmed_at) values
  ('00000000-0000-0000-0000-000000000912', '00000000-0000-0000-0000-000000000901', 'address',
   now() - make_interval(months => 6) + interval '1 day');

select is(
  public.whatsapp_conversation_steps(
    '00000000-0000-0000-0000-000000000922', '00000000-0000-0000-0000-000000000912'),
  '[{"kind": "consent"}]'::jsonb,
  'a field confirmed one day inside the validity window is excluded');

-- D: confirmed EXACTLY on the boundary -- still "within", so still excluded.
-- This is the assertion a `<=` in place of `<` flips: it is the only one of
-- the four with no daylight at all between confirmed_at and the cutoff.
insert into public.members (id, organization_id, address_line) values
  ('00000000-0000-0000-0000-000000000913', '00000000-0000-0000-0000-000000000901', 'Rua Boundary');
insert into public.member_field_confirmations (member_id, organization_id, field, confirmed_at) values
  ('00000000-0000-0000-0000-000000000913', '00000000-0000-0000-0000-000000000901', 'address',
   now() - make_interval(months => 6));

select is(
  public.whatsapp_conversation_steps(
    '00000000-0000-0000-0000-000000000922', '00000000-0000-0000-0000-000000000913'),
  '[{"kind": "consent"}]'::jsonb,
  'a field confirmed exactly data_validity_months ago is still within the window and is excluded');

-- E: confirmed one day OUTSIDE the window (older than the cutoff) -- included.
insert into public.members (id, organization_id, address_line) values
  ('00000000-0000-0000-0000-000000000914', '00000000-0000-0000-0000-000000000901', 'Rua Outside');
insert into public.member_field_confirmations (member_id, organization_id, field, confirmed_at) values
  ('00000000-0000-0000-0000-000000000914', '00000000-0000-0000-0000-000000000901', 'address',
   now() - make_interval(months => 6) - interval '1 day');

select is(
  public.whatsapp_conversation_steps(
    '00000000-0000-0000-0000-000000000922', '00000000-0000-0000-0000-000000000914'),
  '[{"kind": "consent"}, {"kind": "field", "field": "address"}]'::jsonb,
  'a field confirmed one day outside the validity window is included');

-- F: filled but NEVER confirmed at all. No row to coalesce to -infinity from
-- but the real thing: a listener who has never confirmed reads exactly like
-- one confirmed infinitely long ago, and is included -- not treated as fresh
-- for lack of a row to check.
insert into public.members (id, organization_id, address_line) values
  ('00000000-0000-0000-0000-000000000915', '00000000-0000-0000-0000-000000000901', 'Rua Never');

select is(
  public.whatsapp_conversation_steps(
    '00000000-0000-0000-0000-000000000922', '00000000-0000-0000-0000-000000000915'),
  '[{"kind": "consent"}, {"kind": "field", "field": "address"}]'::jsonb,
  'a filled field that was never confirmed is included, not treated as fresh');

-- G. Null validity means no freshness requirement at all -- not even "never
-- confirmed" reaches the staleness check, because that check is itself gated
-- on data_validity_months is not null. A filled, never-confirmed field is
-- excluded here, the opposite of F's outcome under a real window.
insert into public.members (id, organization_id, full_name, discovery_source) values
  ('00000000-0000-0000-0000-000000000916', '00000000-0000-0000-0000-000000000901',
   'G Filled', 'Instagram');
insert into public.promotions
  (id, organization_id, company_id, name, starts_at, ends_at,
   whatsapp_enabled, hashtag, requested_fields, data_validity_months)
values
  ('00000000-0000-0000-0000-000000000923', '00000000-0000-0000-0000-000000000901',
   '00000000-0000-0000-0000-000000000902', 'Null validity',
   now() - interval '1 day', now() + interval '1 day',
   true, '#t2null', array['full_name', 'discovery_source']::public.promotion_requested_field[], null);

select is(
  public.whatsapp_conversation_steps(
    '00000000-0000-0000-0000-000000000923', '00000000-0000-0000-0000-000000000916'),
  '[{"kind": "consent"}]'::jsonb,
  'a null data_validity_months excludes every filled field even when none was ever confirmed');

-- H. data_validity_months = 0 asks every requested field every time, even one
-- confirmed a minute ago -- 0 is a real ceiling, not "no ceiling" spelled
-- differently.
insert into public.members (id, organization_id, birth_date, cpf_hash, passport) values
  ('00000000-0000-0000-0000-000000000917', '00000000-0000-0000-0000-000000000901',
   '1990-01-01', repeat('a', 64), 'H1234567');
insert into public.member_field_confirmations (member_id, organization_id, field, confirmed_at) values
  ('00000000-0000-0000-0000-000000000917', '00000000-0000-0000-0000-000000000901', 'age', now() - interval '1 minute'),
  ('00000000-0000-0000-0000-000000000917', '00000000-0000-0000-0000-000000000901', 'cpf', now() - interval '1 minute'),
  ('00000000-0000-0000-0000-000000000917', '00000000-0000-0000-0000-000000000901', 'passport', now() - interval '1 minute');

insert into public.promotions
  (id, organization_id, company_id, name, starts_at, ends_at,
   whatsapp_enabled, hashtag, requested_fields, data_validity_months)
values
  ('00000000-0000-0000-0000-000000000924', '00000000-0000-0000-0000-000000000901',
   '00000000-0000-0000-0000-000000000902', 'Ask every time',
   now() - interval '1 day', now() + interval '1 day',
   true, '#t2zero', array['age', 'cpf', 'passport']::public.promotion_requested_field[], 0);

select is(
  public.whatsapp_conversation_steps(
    '00000000-0000-0000-0000-000000000924', '00000000-0000-0000-0000-000000000917'),
  '[{"kind": "consent"}, {"kind": "field", "field": "age"}, {"kind": "field", "field": "cpf"}, {"kind": "field", "field": "passport"}]'::jsonb,
  'data_validity_months = 0 includes every requested field even when confirmed a minute ago');

-- I. Questions come after the fields, in POSITION order. The three below are
-- inserted out of position order AND their ids deliberately disagree with
-- both the insertion order and the position order, so an implementation that
-- (wrongly) followed id or insertion order would produce a different sequence
-- than one that follows position.
insert into public.promotions
  (id, organization_id, company_id, name, starts_at, ends_at,
   whatsapp_enabled, hashtag, requested_fields)
values
  ('00000000-0000-0000-0000-000000000925', '00000000-0000-0000-0000-000000000901',
   '00000000-0000-0000-0000-000000000902', 'Fields then questions in position order',
   now() - interval '1 day', now() + interval '1 day',
   true, '#t2order', array['city']::public.promotion_requested_field[]);

insert into public.promotion_questions
  (id, promotion_id, organization_id, company_id, position, kind, prompt, menu_title, button_label)
values
  ('00000000-0000-0000-0000-000000000931', '00000000-0000-0000-0000-000000000925',
   '00000000-0000-0000-0000-000000000901', '00000000-0000-0000-0000-000000000902',
   2, 'ESSAY', 'Second question', null, null),
  ('00000000-0000-0000-0000-000000000932', '00000000-0000-0000-0000-000000000925',
   '00000000-0000-0000-0000-000000000901', '00000000-0000-0000-0000-000000000902',
   3, 'MULTIPLE_CHOICE', 'Third question', 'Menu 3', 'Button 3'),
  ('00000000-0000-0000-0000-000000000933', '00000000-0000-0000-0000-000000000925',
   '00000000-0000-0000-0000-000000000901', '00000000-0000-0000-0000-000000000902',
   1, 'QUIZ', 'First question', 'Menu 1', 'Button 1');

select is(
  public.whatsapp_conversation_steps(
    '00000000-0000-0000-0000-000000000925', '00000000-0000-0000-0000-000000000910'),
  ('[{"kind": "consent"}, {"kind": "field", "field": "city"},'
   || ' {"kind": "question", "questionId": "00000000-0000-0000-0000-000000000933", "questionKind": "QUIZ"},'
   || ' {"kind": "question", "questionId": "00000000-0000-0000-0000-000000000931", "questionKind": "ESSAY"},'
   || ' {"kind": "question", "questionId": "00000000-0000-0000-0000-000000000932", "questionKind": "MULTIPLE_CHOICE"}]')::jsonb,
  'questions appear in position order after the fields, regardless of insertion or id order');

-- J. Fields come out in the ENUM's own order, not the order an operator
-- ticked them: ticked discovery_source, city, full_name -- in that order --
-- and expected back full_name, city, discovery_source, which is
-- promotion_requested_field's declared order (0040). That is also neither the
-- ticked order nor alphabetical order, so a sort by either would disagree too.
insert into public.promotions
  (id, organization_id, company_id, name, starts_at, ends_at,
   whatsapp_enabled, hashtag, requested_fields)
values
  ('00000000-0000-0000-0000-000000000926', '00000000-0000-0000-0000-000000000901',
   '00000000-0000-0000-0000-000000000902', 'Enum order, not tick order',
   now() - interval '1 day', now() + interval '1 day',
   true, '#t2enum',
   array['discovery_source', 'city', 'full_name']::public.promotion_requested_field[]);

select is(
  public.whatsapp_conversation_steps(
    '00000000-0000-0000-0000-000000000926', '00000000-0000-0000-0000-000000000910'),
  '[{"kind": "consent"}, {"kind": "field", "field": "full_name"}, {"kind": "field", "field": "city"}, {"kind": "field", "field": "discovery_source"}]'::jsonb,
  'requested fields come out in the enum''s own order, regardless of the order they were ticked');

-- The entry question, asked twice (Task 7d, D8) -------------------------------
--
-- The conversation has to know at the START whether this listener could enter
-- at all -- answering five questions and being told afterwards that the
-- chances were already spent is the cruelty D8 exists to avoid -- and again at
-- the END, where the answer is authoritative. Two readers, and therefore the
-- rules moved into a function of their own rather than being re-stated in the
-- second one.

select has_function('public', 'participation_status_for',
                    array['uuid', 'uuid', 'timestamp with time zone'],
                    'the entry rules have a home of their own');

-- PRIVATE CORE, the convention this schema holds for every rule body: reachable
-- only from inside a SECURITY DEFINER caller that has checked its own
-- permission. All three roles, because a grant handed to any one of them is the
-- regression this pins.
select ok(not has_function_privilege('anon',
            'public.participation_status_for(uuid, uuid, timestamp with time zone)', 'EXECUTE'),
          'anon may not ask the entry rules anything');
select ok(not has_function_privilege('authenticated',
            'public.participation_status_for(uuid, uuid, timestamp with time zone)', 'EXECUTE'),
          'and neither may authenticated');
select ok(not has_function_privilege('service_role',
            'public.participation_status_for(uuid, uuid, timestamp with time zone)', 'EXECUTE'),
          'and neither may service_role -- it is called from inside, never over HTTP');

insert into public.members (id, organization_id) values
  ('00000000-0000-0000-0000-000000000951', '00000000-0000-0000-0000-000000000901'),
  ('00000000-0000-0000-0000-000000000952', '00000000-0000-0000-0000-000000000901');

-- participations_member_link_fk: an entry names a listener THIS Station knows.
insert into public.member_company_links (member_id, company_id, organization_id) values
  ('00000000-0000-0000-0000-000000000951', '00000000-0000-0000-0000-000000000902',
   '00000000-0000-0000-0000-000000000901'),
  ('00000000-0000-0000-0000-000000000952', '00000000-0000-0000-0000-000000000902',
   '00000000-0000-0000-0000-000000000901');

insert into public.promotions
  (id, organization_id, company_id, name, starts_at, ends_at,
   allow_multiple_entries, min_hours_between_entries, max_entries_per_member)
values
  ('00000000-0000-0000-0000-000000000950', '00000000-0000-0000-0000-000000000901',
   '00000000-0000-0000-0000-000000000902', 'Two entries each',
   now() - interval '1 day', now() + interval '1 day', true, 1, 2);

insert into public.participations
  (promotion_id, member_id, organization_id, company_id, allows_multiple,
   status, source, participated_at)
values
  ('00000000-0000-0000-0000-000000000950', '00000000-0000-0000-0000-000000000951',
   '00000000-0000-0000-0000-000000000901', '00000000-0000-0000-0000-000000000902',
   true, 'VALID', 'MANUAL', now() - interval '2 hours'),
  ('00000000-0000-0000-0000-000000000950', '00000000-0000-0000-0000-000000000951',
   '00000000-0000-0000-0000-000000000901', '00000000-0000-0000-0000-000000000902',
   true, 'VALID', 'MANUAL', now() - interval '1 hour'),
  -- TWO refused attempts, which must not count towards anybody's ceiling: they
  -- are a record that somebody tried, not entries. Two and not one, because the
  -- ceiling here is two: with a single row a count that wrongly included
  -- refusals would still come out under the ceiling, and the assertion below
  -- would pass against the defect it exists to catch.
  ('00000000-0000-0000-0000-000000000950', '00000000-0000-0000-0000-000000000952',
   '00000000-0000-0000-0000-000000000901', '00000000-0000-0000-0000-000000000902',
   true, 'OVER_LIMIT', 'MANUAL', now() - interval '3 hours'),
  ('00000000-0000-0000-0000-000000000950', '00000000-0000-0000-0000-000000000952',
   '00000000-0000-0000-0000-000000000901', '00000000-0000-0000-0000-000000000902',
   true, 'TOO_SOON', 'MANUAL', now() - interval '4 hours');

select is(
  public.participation_status_for(
    '00000000-0000-0000-0000-000000000950',
    '00000000-0000-0000-0000-000000000951', now()),
  'OVER_LIMIT'::public.participation_status,
  'a listener already at the ceiling is over it before the conversation starts');

select is(
  public.participation_status_for(
    '00000000-0000-0000-0000-000000000950',
    '00000000-0000-0000-0000-000000000952', now()),
  'VALID'::public.participation_status,
  'and somebody whose only row is a refused attempt is let in -- that row is not an entry');

-- The turn lease (Task 7c) ----------------------------------------------------
--
-- What serialises two messages from one phone, and the reason it is a table and
-- not pg_advisory_xact_lock: the engine is TypeScript. A turn is load, advance,
-- write, with the middle step in Node, and an advisory lock is released at
-- commit -- before the state is read and before the write goes back. It would
-- cover neither end of the read-modify-write it exists to protect. This is the
-- claim/reclaim shape 0063 already uses, for the same reason it exists there: a
-- claim that has to outlive its transaction cannot be a lock.

insert into public.integrations
  (id, organization_id, company_id, provider, phone_number_id, enabled)
values
  ('00000000-0000-0000-0000-000000000940', '00000000-0000-0000-0000-000000000901',
   '00000000-0000-0000-0000-000000000902', 'WHATSAPP', '940940940940940', true);

select has_table('public', 'whatsapp_conversation_leases', 'the turn lease exists');

select is(relrowsecurity, true, 'RLS enabled on whatsapp_conversation_leases')
  from pg_class where oid = 'public.whatsapp_conversation_leases'::regclass;

-- NO table grant, and the absence is the design rather than the omission 5a
-- shipped three times: nothing outside the two SECURITY DEFINER functions below
-- ever touches this table, so the way to reach it is to be one of them. Stated
-- here so that adding a PostgREST read of it is a decision somebody makes in
-- this file rather than a 42501 they meet in production.
select ok(not has_table_privilege('service_role', 'public.whatsapp_conversation_leases', 'SELECT'),
          'the lease is reachable only from inside its own functions');
select ok(not has_table_privilege('authenticated', 'public.whatsapp_conversation_leases', 'SELECT'),
          'and authenticated cannot see who is mid-conversation');

select ok(not has_function_privilege('anon',
            'public.claim_conversation_turn(uuid, text, interval)', 'EXECUTE'),
          'anon may not claim a turn');
select ok(has_function_privilege('service_role',
            'public.claim_conversation_turn(uuid, text, interval)', 'EXECUTE'),
          'the worker may claim a turn');

create temporary table lease_first as
  select public.claim_conversation_turn(
    '00000000-0000-0000-0000-000000000940', '5511900009111', '5 minutes') as token;

select isnt((select token from lease_first), null,
            'a free pair is claimed, and the claim hands back the token that owns it');

select is(
  public.claim_conversation_turn(
    '00000000-0000-0000-0000-000000000940', '5511900009111', '5 minutes'),
  null,
  'and a second worker gets nothing while that lease is alive -- which is the whole point');

-- Aged past the staleness interval: a worker that died mid-turn must not hold
-- a phone for ever. The takeover is the same statement as the ordinary claim,
-- so there is no separate reclaim to forget to run.
update public.whatsapp_conversation_leases
   set claimed_at = now() - interval '10 minutes'
 where integration_id = '00000000-0000-0000-0000-000000000940';

create temporary table lease_second as
  select public.claim_conversation_turn(
    '00000000-0000-0000-0000-000000000940', '5511900009111', '5 minutes') as token;

select isnt((select token from lease_second), null,
            'a stale lease is taken over by the next worker to ask');

select isnt((select token from lease_second), (select token from lease_first),
            'and the takeover carries a NEW token, so the old holder can no longer release it');

-- THE TOKEN IS WHY RELEASE TAKES ONE. Without it the worker whose lease was
-- taken over would, on waking, delete the lease of the worker that took it --
-- freeing a phone somebody is mid-turn on, which is exactly the race the lease
-- exists to stop, arrived at the long way round.
select public.release_conversation_turn(
  '00000000-0000-0000-0000-000000000940', '5511900009111', (select token from lease_first));

select is(
  (select count(*)::int from public.whatsapp_conversation_leases
    where integration_id = '00000000-0000-0000-0000-000000000940'),
  1,
  'a release carrying the superseded token frees nothing');

select public.release_conversation_turn(
  '00000000-0000-0000-0000-000000000940', '5511900009111', (select token from lease_second));

select is(
  (select count(*)::int from public.whatsapp_conversation_leases
    where integration_id = '00000000-0000-0000-0000-000000000940'),
  0,
  'and the holder releasing its own lease frees the phone for the next message');

-- Starting a conversation, and what it refuses to do (Task 7d) ----------------

select has_function('public', 'start_whatsapp_conversation',
                    array['uuid', 'uuid', 'uuid', 'text', 'integer'],
                    'the conversation a hashtag opens is assembled by a function of its own');

select ok(not has_function_privilege('anon',
            'public.start_whatsapp_conversation(uuid, uuid, uuid, text, integer)', 'EXECUTE'),
          'anon may not open a conversation');
select ok(not has_function_privilege('authenticated',
            'public.start_whatsapp_conversation(uuid, uuid, uuid, text, integer)', 'EXECUTE'),
          'and neither may authenticated');
select ok(not has_function_privilege('service_role',
            'public.start_whatsapp_conversation(uuid, uuid, uuid, text, integer)', 'EXECUTE'),
          'and neither may service_role -- it is reached from inside the door, never over HTTP');

select is(
  public.start_whatsapp_conversation(
    '00000000-0000-0000-0000-000000000921', '00000000-0000-0000-0000-000000000911',
    '00000000-0000-0000-0000-000000000940', '5511900009999', 1800)
    -> 'conversation' -> 'steps',
  '[{"kind": "consent"}, {"kind": "field", "field": "neighbourhood"}]'::jsonb,
  'it hands back the step list this listener still has to answer');

-- THE ASSERTION THIS FUNCTION EXISTS TO EARN. The state's home is the
-- ConversationStore, which may be Redis: a version of this that inserted here
-- would start conversations in one store while every later turn looked for them
-- in the other, and the bot would go silent after the consent message in
-- exactly the deployment Redis is turned on for. A test that accepted a row
-- would pin that defect in place.
select is(
  (select count(*)::int from public.whatsapp_conversations
    where integration_id = '00000000-0000-0000-0000-000000000940'),
  0,
  'and stores NOTHING: the state belongs to the store, not to this function');

select ok(has_function_privilege('service_role',
            'public.finish_whatsapp_turn(uuid, text)', 'EXECUTE'),
          'the worker may close an event whose turn it decided in Node');

-- The whitelist, which is the whole reason this door exists rather than a grant
-- on finish_whatsapp_event: an outcome carrying a participation is written by
-- the transaction that writes the entry, and cannot be claimed from out here.
select throws_ok(
  $$select public.finish_whatsapp_turn(
      '00000000-0000-0000-0000-0000000009ff', 'recorded')$$,
  '22023',
  null,
  'and may not use it to claim an entry happened');

-- The end of the conversation (Task 8) ----------------------------------------

select ok(has_function_privilege('service_role',
            'public.complete_whatsapp_conversation(uuid, uuid, uuid, uuid, text, jsonb, jsonb, timestamp with time zone, text)',
            'EXECUTE'),
          'the worker may write the end of a conversation');
select ok(not has_function_privilege('authenticated',
            'public.complete_whatsapp_conversation(uuid, uuid, uuid, uuid, text, jsonb, jsonb, timestamp with time zone, text)',
            'EXECUTE'),
          'and a signed-in operator may not: this door belongs to the bot');

insert into public.members (id, organization_id, full_name) values
  ('00000000-0000-0000-0000-000000000960', '00000000-0000-0000-0000-000000000901', 'Ouvinte Fim');
insert into public.member_company_links (member_id, company_id, organization_id) values
  ('00000000-0000-0000-0000-000000000960', '00000000-0000-0000-0000-000000000902',
   '00000000-0000-0000-0000-000000000901');

insert into public.promotions
  (id, organization_id, company_id, name, starts_at, ends_at, requested_fields,
   whatsapp_enabled, hashtag)
values
  ('00000000-0000-0000-0000-000000000961', '00000000-0000-0000-0000-000000000901',
   '00000000-0000-0000-0000-000000000902', 'Fim da conversa',
   now() - interval '1 day', now() + interval '1 day',
   array['city', 'cpf']::public.promotion_requested_field[], true, '#t8fim'),
  ('00000000-0000-0000-0000-000000000964', '00000000-0000-0000-0000-000000000901',
   '00000000-0000-0000-0000-000000000902', 'Outra promocao',
   now() - interval '1 day', now() + interval '1 day', '{}', false, null);

insert into public.promotion_questions
  (id, promotion_id, organization_id, company_id, position, kind, prompt, menu_title, button_label)
values
  ('00000000-0000-0000-0000-000000000962', '00000000-0000-0000-0000-000000000961',
   '00000000-0000-0000-0000-000000000901', '00000000-0000-0000-0000-000000000902',
   1, 'QUIZ', 'Qual estilo?', 'Estilos', 'Escolher'),
  ('00000000-0000-0000-0000-000000000965', '00000000-0000-0000-0000-000000000964',
   '00000000-0000-0000-0000-000000000901', '00000000-0000-0000-0000-000000000902',
   1, 'ESSAY', 'Fale de voce', null, null);

insert into public.promotion_question_options
  (id, question_id, kind, organization_id, company_id, position, label, is_correct)
values
  ('00000000-0000-0000-0000-000000000963', '00000000-0000-0000-0000-000000000962', 'QUIZ',
   '00000000-0000-0000-0000-000000000901', '00000000-0000-0000-0000-000000000902',
   1, 'Sertanejo', true);

insert into public.webhook_events (id, provider, external_id, payload, status, claimed_at) values
  ('00000000-0000-0000-0000-000000000966', 'WHATSAPP', repeat('c', 64),
   '{}'::jsonb, 'PROCESSING', now()),
  ('00000000-0000-0000-0000-000000000967', 'WHATSAPP', repeat('d', 64),
   '{}'::jsonb, 'PROCESSING', now());

-- ALL OR NOTHING, and this is the case the transaction exists for. The answer
-- names a question belonging to another promotion, which apply_participation
-- refuses with P0002 -- and it refuses AFTER the record has already been
-- updated and the confirmations written, which is exactly the ordering that
-- makes a non-transactional version leave a listener's record changed for an
-- entry that was never created.
select throws_ok(
  $$select public.complete_whatsapp_conversation(
      '00000000-0000-0000-0000-000000000966',
      '00000000-0000-0000-0000-000000000940',
      '00000000-0000-0000-0000-000000000961',
      '00000000-0000-0000-0000-000000000960',
      '5511900009600',
      '{"city": "Canoas"}'::jsonb,
      '[{"questionId": "00000000-0000-0000-0000-000000000965", "optionId": null, "answerText": "oi"}]'::jsonb,
      now(), 'cccc:confirmation')$$,
  'P0002',
  null,
  'an answer naming another promotion''s question is refused');

select is(
  (select city from public.members where id = '00000000-0000-0000-0000-000000000960'),
  null,
  'and the record is NOT left updated for an entry that was never written');
select is(
  (select count(*)::int from public.member_field_confirmations
    where member_id = '00000000-0000-0000-0000-000000000960'),
  0, 'nor the confirmations');
select is(
  (select status::text from public.webhook_events
    where id = '00000000-0000-0000-0000-000000000966'),
  'PROCESSING',
  'and the message is not filed as decided, so the next tick tries it again');

-- The whole thing, once it works.
select is(
  public.complete_whatsapp_conversation(
    '00000000-0000-0000-0000-000000000967',
    '00000000-0000-0000-0000-000000000940',
    '00000000-0000-0000-0000-000000000961',
    '00000000-0000-0000-0000-000000000960',
    '5511900009600',
    ('{"city": "Canoas", "cpf": "' || repeat('8b', 32) || '"}')::jsonb,
    '[{"questionId": "00000000-0000-0000-0000-000000000962",
       "optionId": "00000000-0000-0000-0000-000000000963", "answerText": null}]'::jsonb,
    now(), 'dddd:confirmation') ->> 'status',
  'VALID',
  'a conversation that finishes writes the entry');

select is(
  (select city from public.members where id = '00000000-0000-0000-0000-000000000960'),
  'Canoas',
  'the answers land on the listener''s record');

-- One row per field the listener ANSWERED, and stamped now rather than with the
-- message's own time: the confirmation records when we were told.
select is(
  (select array_agg(field::text order by field::text)
     from public.member_field_confirmations
    where member_id = '00000000-0000-0000-0000-000000000960'),
  array['city', 'cpf'],
  'with a confirmation for each of them, and none for anything else');

select is(
  (select count(*)::int from public.outbox_messages where dedupe_key = 'dddd:confirmation'),
  1, 'the reply is enqueued in the same transaction as the entry it announces');

select is(
  (select jsonb_build_object('status', status::text, 'outcome', outcome)
     from public.webhook_events where id = '00000000-0000-0000-0000-000000000967'),
  jsonb_build_object('status', 'DONE', 'outcome', 'recorded'),
  'and the message that completed it is closed by the same transaction, so the two cannot disagree');

-- The sweep (Task 9) -----------------------------------------------------------

insert into public.whatsapp_conversations (integration_id, phone, state, expires_at) values
  ('00000000-0000-0000-0000-000000000940', '5511900009971', '{}'::jsonb, now() - interval '1 minute'),
  ('00000000-0000-0000-0000-000000000940', '5511900009972', '{}'::jsonb, now() + interval '20 minutes');

-- A lease older than the sweep's cut, and one taken a moment ago.
insert into public.whatsapp_conversation_leases (integration_id, phone, claimed_at) values
  ('00000000-0000-0000-0000-000000000940', '5511900009973', now() - interval '2 hours'),
  ('00000000-0000-0000-0000-000000000940', '5511900009974', now());

select is(
  (select conversations from public.sweep_expired_conversations()),
  1, 'the sweep takes the conversation whose window has passed');

select is(
  (select count(*)::int from public.whatsapp_conversations
    where phone = '5511900009972'),
  1, 'and leaves the live one alone');

select is(
  (select count(*)::int from public.whatsapp_conversation_leases
    where phone = '5511900009973'),
  0, 'a lease no live worker can be holding is freed');

-- THE ONE THAT MATTERS MOST HERE. Deleting a lease somebody is holding hands
-- that phone to a second worker mid-turn -- the exact race the lease exists to
-- prevent, arrived at through its own cleanup.
select is(
  (select count(*)::int from public.whatsapp_conversation_leases
    where phone = '5511900009974'),
  1, 'and a lease taken a moment ago is not');

select * from finish();
rollback;
