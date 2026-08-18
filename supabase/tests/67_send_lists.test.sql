begin;
select plan(42);

-- Block 29d-1. The permissions a send list and, later, a campaign are guarded
-- by. Born beside the feature they guard, which is 0010's own rule.
select is(
  (select count(*)::int from public.permissions
    where code in ('messaging.view', 'messaging.manage', 'messaging.send')),
  3, 'the three messaging permissions exist');

-- SEND IS SEPARATE FROM MANAGE, and that is the whole reason there are three
-- rather than two: approving a send to twenty thousand people is not the act of
-- drafting one, and a Station may want those in different hands.
-- `code` IS the primary key here -- this table has no `id` column.
select isnt(
  (select label from public.permissions where code = 'messaging.send'),
  (select label from public.permissions where code = 'messaging.manage'),
  'send is its own code with its own label, not an alias of manage');

select is(
  (select count(distinct module)::int from public.permissions
    where code like 'messaging.%'),
  1, 'and all three sit in one module, so a role screen groups them together');

select ok(
  (select bool_and(label is not null and label <> '')
     from public.permissions where code like 'messaging.%'),
  'each carries a label, because a role screen shows codes to nobody');

-- Task 2. A list is a name, a Station, and either people or a question.
select has_table('public', 'send_lists', 'the list table exists');
select has_table('public', 'send_list_members', 'and the table holding a fixed list''s people');

select col_is_pk('public', 'send_list_members', array['list_id', 'member_id'],
  'a person appears in a list once -- Requests and Participations are per event, and somebody who asked for twelve songs is one recipient');

select ok(
  (select count(*)::int from information_schema.columns
    where table_schema = 'public' and table_name = 'send_lists'
      and column_name in ('company_id', 'organization_id', 'source', 'kind', 'filters', 'name')) = 6,
  'a list carries its Station, its origin, its kind and the filters that built it');

-- Task 3. The three doors -- create_send_list, rename_send_list and
-- delete_send_list -- and nothing else writes send_lists or
-- send_list_members (0238 grants authenticated SELECT only on the first and
-- nothing on the second).

select has_function('public', 'create_send_list', 'create_send_list exists');
select has_function('public', 'rename_send_list', 'rename_send_list exists');
select has_function('public', 'delete_send_list', 'delete_send_list exists');

-- `create function` grants EXECUTE to PUBLIC by default. Each door revokes
-- that and grants back only to authenticated (0199's own convention), so
-- both anon and the PUBLIC pseudo-role itself must hold nothing.

select ok(
  has_function_privilege('authenticated',
    'public.create_send_list(uuid, text, public.send_list_source, public.send_list_kind, jsonb, uuid[])',
    'EXECUTE'),
  'authenticated may create a send list');
select ok(
  not has_function_privilege('anon',
    'public.create_send_list(uuid, text, public.send_list_source, public.send_list_kind, jsonb, uuid[])',
    'EXECUTE'),
  'anon may not');
select ok(
  not has_function_privilege('public',
    'public.create_send_list(uuid, text, public.send_list_source, public.send_list_kind, jsonb, uuid[])',
    'EXECUTE'),
  'and PUBLIC holds nothing');

select ok(
  has_function_privilege('authenticated', 'public.rename_send_list(uuid, text)', 'EXECUTE'),
  'authenticated may rename a send list');
select ok(
  not has_function_privilege('anon', 'public.rename_send_list(uuid, text)', 'EXECUTE'),
  'anon may not');
select ok(
  not has_function_privilege('public', 'public.rename_send_list(uuid, text)', 'EXECUTE'),
  'and PUBLIC holds nothing');

select ok(
  has_function_privilege('authenticated', 'public.delete_send_list(uuid)', 'EXECUTE'),
  'authenticated may delete a send list');
select ok(
  not has_function_privilege('anon', 'public.delete_send_list(uuid)', 'EXECUTE'),
  'anon may not');
select ok(
  not has_function_privilege('public', 'public.delete_send_list(uuid)', 'EXECUTE'),
  'and PUBLIC holds nothing');

-- Task 5 fix round 1 (F3). send_list_member_ids (0240) -- the one read door
-- onto send_list_members, which carries no policy of its own -- gated on
-- messaging.view rather than messaging.manage, since it is a read and the
-- same permission the list itself is gated on (0238).

select has_function('public', 'send_list_member_ids', 'send_list_member_ids exists');

select ok(
  has_function_privilege('authenticated', 'public.send_list_member_ids(uuid)', 'EXECUTE'),
  'authenticated may read a send list''s frozen members');
select ok(
  not has_function_privilege('anon', 'public.send_list_member_ids(uuid)', 'EXECUTE'),
  'anon may not');
select ok(
  not has_function_privilege('public', 'public.send_list_member_ids(uuid)', 'EXECUTE'),
  'and PUBLIC holds nothing');

-- Fixtures: one Organization, two Stations, three listeners. member1 and
-- member2 are linked to Station A -- the Station every door call below
-- names. memberX is linked ONLY to Station B, the other Station in the same
-- Organization -- a real cross-Station listener, not merely an id that
-- matches nothing.

insert into public.organizations (id, name) values
  ('00000000-0000-0000-0000-0000000029d0', 'Org send lists');
insert into public.companies (id, organization_id, name) values
  ('00000000-0000-0000-0000-0000000029d1', '00000000-0000-0000-0000-0000000029d0', 'Station 29d A'),
  ('00000000-0000-0000-0000-0000000029d2', '00000000-0000-0000-0000-0000000029d0', 'Station 29d B');

insert into public.members (id, organization_id, full_name) values
  ('00000000-0000-0000-0000-0000000029d3', '00000000-0000-0000-0000-0000000029d0', 'Ouvinte A1'),
  ('00000000-0000-0000-0000-0000000029d4', '00000000-0000-0000-0000-0000000029d0', 'Ouvinte A2'),
  ('00000000-0000-0000-0000-0000000029d5', '00000000-0000-0000-0000-0000000029d0', 'Ouvinte so da B');

insert into public.member_company_links (member_id, company_id, organization_id) values
  ('00000000-0000-0000-0000-0000000029d3', '00000000-0000-0000-0000-0000000029d1', '00000000-0000-0000-0000-0000000029d0'),
  ('00000000-0000-0000-0000-0000000029d4', '00000000-0000-0000-0000-0000000029d1', '00000000-0000-0000-0000-0000000029d0'),
  ('00000000-0000-0000-0000-0000000029d5', '00000000-0000-0000-0000-0000000029d2', '00000000-0000-0000-0000-0000000029d0');

insert into public.roles (id, organization_id, name) values
  ('00000000-0000-0000-0000-0000000029d6', '00000000-0000-0000-0000-0000000029d0', 'Messaging Manager 29d'),
  ('00000000-0000-0000-0000-0000000029d7', '00000000-0000-0000-0000-0000000029d0', 'Messaging Viewer 29d');
insert into public.role_permissions (role_id, permission_code) values
  ('00000000-0000-0000-0000-0000000029d6', 'messaging.manage'),
  ('00000000-0000-0000-0000-0000000029d6', 'messaging.view'),
  ('00000000-0000-0000-0000-0000000029d7', 'messaging.view');

-- 29da holds NO company_membership row anywhere -- not at Station A, not at
-- Station B, not in any other Organization -- the starkest "lacks
-- messaging.view" case there is, for send_list_member_ids' own 42501 below.
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000029d8', 'send-lists-manager-29d@example.test'),
  ('00000000-0000-0000-0000-0000000029d9', 'send-lists-viewer-29d@example.test'),
  ('00000000-0000-0000-0000-0000000029da', 'send-lists-nobody-29d@example.test');
insert into public.company_memberships (user_id, company_id, organization_id, role_id) values
  ('00000000-0000-0000-0000-0000000029d8', '00000000-0000-0000-0000-0000000029d1',
   '00000000-0000-0000-0000-0000000029d0', '00000000-0000-0000-0000-0000000029d6'),
  ('00000000-0000-0000-0000-0000000029d9', '00000000-0000-0000-0000-0000000029d1',
   '00000000-0000-0000-0000-0000000029d0', '00000000-0000-0000-0000-0000000029d7');

-- messaging.view alone -----------------------------------------------------

set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-0000000029d9", "role": "authenticated"}';

select throws_ok(
  $$select public.create_send_list('00000000-0000-0000-0000-0000000029d1', 'Nao deveria existir',
      'members', 'fixed', '{}'::jsonb, array['00000000-0000-0000-0000-0000000029d3'::uuid])$$,
  '42501', null, 'messaging.view alone cannot create a send list');

reset role;

-- messaging.manage -- every write in this block, no reads: send_list_members
-- carries no policy at all (0238) and send_lists' own policy hides a row
-- this same caller just deleted, so every verification below runs as the
-- pgTAP superuser instead, once role is reset back.

set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-0000000029d8", "role": "authenticated"}';

select throws_ok(
  $$select public.create_send_list('00000000-0000-0000-0000-0000000029d1', '   ',
      'members', 'fixed', '{}'::jsonb, array['00000000-0000-0000-0000-0000000029d3'::uuid])$$,
  '22023', null, 'a blank name is refused by the door as a sentence');

create temporary table t29d_fixed as
select public.create_send_list(
  '00000000-0000-0000-0000-0000000029d1', 'Engajados 29d', 'members', 'fixed', '{}'::jsonb,
  array['00000000-0000-0000-0000-0000000029d3'::uuid, '00000000-0000-0000-0000-0000000029d4'::uuid]
) as list_id;

-- THE ASSERTION STEP 5 MUTATES AGAINST: without member_linked_to_company, a
-- caller who names another Station's listener by id alone would succeed
-- here, because Station A's own permission check has already passed.
select throws_ok(
  $$select public.create_send_list('00000000-0000-0000-0000-0000000029d1', 'Lista intrusa',
      'members', 'fixed', '{}'::jsonb,
      array['00000000-0000-0000-0000-0000000029d3'::uuid, '00000000-0000-0000-0000-0000000029d5'::uuid])$$,
  'P0002', null, 'create_send_list refuses a member linked only to another Station');

select throws_ok(
  $$select public.create_send_list('00000000-0000-0000-0000-0000000029d1', 'Devia ser fixed',
      'members', 'fixed', '{}'::jsonb, array[]::uuid[])$$,
  '22023', null, 'a fixed list needs at least one person');

create temporary table t29d_living as
select public.create_send_list(
  '00000000-0000-0000-0000-0000000029d1', 'Todos os ouvintes 29d', 'members', 'living',
  '{"segment": "all"}'::jsonb, array[]::uuid[]
) as list_id;

select throws_ok(
  $$select public.create_send_list('00000000-0000-0000-0000-0000000029d1', 'Devia ser living',
      'members', 'living', '{}'::jsonb, array['00000000-0000-0000-0000-0000000029d3'::uuid])$$,
  '22023', null, 'a living list may not be given people directly');

reset role;

-- Verification as the pgTAP superuser, which bypasses RLS and every grant --
-- exactly what a normal `authenticated` session cannot do to
-- send_list_members, the table with no policy at all.

select is(
  (select array_agg(member_id order by member_id) from public.send_list_members
    where list_id = (select list_id from t29d_fixed)),
  array['00000000-0000-0000-0000-0000000029d3'::uuid, '00000000-0000-0000-0000-0000000029d4'::uuid],
  'a fixed list stores exactly the people it was given');

select is(
  (select count(*)::int from public.send_list_members
    where list_id = (select list_id from t29d_living)),
  0, 'a living list stores no people -- its filters are resolved again on every send');

select is(
  (select action from public.audit_logs
    where target_table = 'send_lists' and target_id = (select list_id from t29d_fixed)),
  'create_send_list', 'the create is audited under the door''s own name');

-- messaging.view alone, again, on the fixed list just created -------------

set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-0000000029d9", "role": "authenticated"}';

select throws_ok(
  (select format('select public.rename_send_list(%L, %L)', list_id, 'Sequestrado') from t29d_fixed),
  '42501', null, 'messaging.view alone cannot rename a send list');

select throws_ok(
  (select format('select public.delete_send_list(%L)', list_id) from t29d_fixed),
  '42501', null, 'messaging.view alone cannot delete a send list');

-- Task 5 fix round 1 (F3). Unlike rename and delete above, send_list_member_ids
-- is gated on messaging.view itself, so THIS caller -- view, no manage -- is
-- exactly the one who should succeed, and get back the list's people and
-- nothing else (not memberX, who is linked only to Station B and was never in
-- this list at all).
select is(
  (select array_agg(member_id order by member_id)
     from public.send_list_member_ids((select list_id from t29d_fixed)) as t(member_id)),
  array['00000000-0000-0000-0000-0000000029d3'::uuid, '00000000-0000-0000-0000-0000000029d4'::uuid],
  'messaging.view alone is enough to read a fixed list''s members, and returns exactly that list''s people');

reset role;

-- send_list_member_ids' 42501, for a caller holding NEITHER permission at
-- Station A nor anywhere else -- the case rename/delete's own tests above
-- have no equivalent of, since both of those are gated on messaging.manage
-- and 29d9 already proves the view-only refusal for THAT pair of doors.

set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-0000000029da", "role": "authenticated"}';

select throws_ok(
  (select format('select public.send_list_member_ids(%L)', list_id) from t29d_fixed),
  '42501', null, 'a caller with no messaging.view anywhere cannot read a fixed list''s members');

reset role;

-- messaging.manage, again ---------------------------------------------------

set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-0000000029d8", "role": "authenticated"}';

select throws_ok(
  $$select public.rename_send_list('00000000-0000-0000-0000-0000000029de', 'Ninguem em casa')$$,
  'P0002', null, 'renaming an unknown list is P0002');
select throws_ok(
  $$select public.delete_send_list('00000000-0000-0000-0000-0000000029de')$$,
  'P0002', null, 'deleting an unknown list is P0002');

select public.rename_send_list((select list_id from t29d_fixed), 'Engajados 29d (renomeado)');

reset role;

select is(
  (select name from public.send_lists where id = (select list_id from t29d_fixed)),
  'Engajados 29d (renomeado)', 'rename_send_list writes the new name');

set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-0000000029d8", "role": "authenticated"}';

select public.delete_send_list((select list_id from t29d_fixed));

reset role;

select is(
  (select deleted_at is not null from public.send_lists where id = (select list_id from t29d_fixed)),
  true, 'delete_send_list is a soft delete');
select is(
  (select count(*)::int from public.send_list_members where list_id = (select list_id from t29d_fixed)),
  0, 'and its people go with it');

-- Task 5 fix round 1 (F3). This list is now soft-deleted -- send_list_member_ids
-- checks `deleted_at is null` before it checks permission at all (the same
-- order rename_send_list and delete_send_list use above), so it answers
-- P0002 here regardless of who is asking.
select throws_ok(
  (select format('select public.send_list_member_ids(%L)', list_id) from t29d_fixed),
  'P0002', null, 'send_list_member_ids refuses a soft-deleted list, the same as rename/delete');

reset request.jwt.claims;

select finish();
rollback;
