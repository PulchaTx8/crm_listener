begin;
select plan(32);

select has_table('public', 'permissions', 'permissions exists');
select has_table('public', 'role_permissions', 'role_permissions exists');
select has_table('public', 'invitations', 'invitations exists');

select is(relrowsecurity, true, 'RLS enabled on invitations')
  from pg_class where oid = 'public.invitations'::regclass;
select is(relrowsecurity, true, 'RLS enabled on permissions')
  from pg_class where oid = 'public.permissions'::regclass;

-- No client may write the catalogue or the invitations: both are RPC-only.
select ok(not has_table_privilege('authenticated', 'public.permissions', 'INSERT'),
          'authenticated may not write the permission catalogue');
select ok(not has_table_privilege('authenticated', 'public.role_permissions', 'UPDATE'),
          'authenticated may not rewrite role grants');
select ok(not has_table_privilege('authenticated', 'public.invitations', 'INSERT'),
          'authenticated may not insert invitations directly');
select ok(not has_table_privilege('anon', 'public.invitations', 'SELECT'),
          'anon may not read invitations');

-- anon must not reach any of the new privileged functions.
select ok(
  not has_function_privilege('anon', 'public.accept_invitation(text, uuid, text)', 'EXECUTE'),
  'anon may not call accept_invitation'
);
select ok(
  not has_function_privilege('anon', 'public.create_invitation(uuid, text, boolean, uuid, uuid[], text, integer)', 'EXECUTE'),
  'anon may not call create_invitation'
);

-- Fail closed, with no session in play.
select is(public.has_permission('no.such.code', gen_random_uuid()), false,
          'an unknown permission code returns false');

-- The same guarantee for the Organization-scoped helper. It doubles as a canary:
-- this function is `language sql`, so a body referencing a dropped column errors
-- at plan time — calling it at all is what proves it still resolves.
select is(public.has_org_permission('no.such.code', gen_random_uuid()), false,
          'an unknown Organization-scoped permission code returns false');

-- Block 1c: the catalogue carries what the editor needs to render itself.
select col_not_null('public', 'permissions', 'module', 'module is required');
select col_not_null('public', 'permissions', 'label',  'label is required');
select col_not_null('public', 'permissions', 'scope',  'scope is required');

select is(
  (select scope::text from public.permissions where code = 'roles.manage'),
  'organization',
  'roles.manage reaches the whole Organization'
);

select has_table('public', 'roles', 'roles exists');

-- Two live roles of the same name in one Organization is a mistake; the same
-- name after archiving one is not.
select has_index('public', 'roles', 'roles_name_unique', 'role names are unique per Organization while live');

-- The catalogue's own seed, in the new model.
select is(
  (select introduced_by_block from public.permissions where code = 'roles.manage'),
  '1c',
  'roles.manage is seeded by this block'
);

-- role_permissions is keyed by the role now, not by a fixed enum. Asserting the
-- absence matters as much as the presence: a leftover `role` column would mean
-- the drop-and-recreate silently did not happen.
select has_column('public', 'role_permissions', 'role_id', 'role_permissions is keyed by role');
select hasnt_column('public', 'role_permissions', 'role', 'the fixed-role column is gone');

-- Created in Tasks 1 and 4, secured here. A table that misses this migration
-- looks exactly like one that did not need it, so the claim is asserted rather
-- than left to whoever reads the migration list.
select is(relrowsecurity, true, 'RLS enabled on roles')
  from pg_class where oid = 'public.roles'::regclass;
select is(relrowsecurity, true, 'RLS enabled on role_permissions')
  from pg_class where oid = 'public.role_permissions'::regclass;
select is(relrowsecurity, true, 'RLS enabled on invitation_companies')
  from pg_class where oid = 'public.invitation_companies'::regclass;

-- No client writes any of them: every write goes through a SECURITY DEFINER
-- function that carries the audit entry with it.
select ok(not has_table_privilege('authenticated', 'public.roles', 'INSERT'),
          'authenticated may not write roles directly');
select ok(not has_table_privilege('authenticated', 'public.role_permissions', 'INSERT'),
          'authenticated may not write role_permissions directly');
select ok(not has_table_privilege('authenticated', 'public.invitation_companies', 'INSERT'),
          'authenticated may not write invitation Stations directly');

-- Block 3: the raw CPF has nowhere to live.
select hasnt_column('public', 'members', 'cpf', 'there is no raw CPF column');

-- Normalisation IS identity. If these stop being generated, dedup stops working and
-- the duplicates look legitimate.
select is(
  (select is_generated from information_schema.columns
    where table_name = 'members' and column_name = 'phone_normalized'),
  'ALWAYS',
  'phone_normalized is generated, not hand-maintained'
);

-- Two Members with no e-mail must not collide. A partial unique index that omits the
-- not-null term makes the second one impossible to register.
insert into public.organizations (id, name) values ('eeeeeeee-0000-0000-0000-000000000001', 'Org M');
insert into public.members (organization_id, full_name) values
  ('eeeeeeee-0000-0000-0000-000000000001', 'No Contact One'),
  ('eeeeeeee-0000-0000-0000-000000000001', 'No Contact Two');
select pass('two Members without an e-mail can both exist');

select is(
  (select count(*)::int from public.permissions where module = 'members' and scope = 'company'),
  6,
  'six Member permissions, all Company-scoped'
);

select * from finish();
rollback;
