begin;
select plan(16);

select has_table('public', 'permissions', 'permissions exists');
select has_table('public', 'role_permissions', 'role_permissions exists');
select has_table('public', 'invitations', 'invitations exists');

select is(relrowsecurity, true, 'RLS enabled on invitations')
  from pg_class where oid = 'public.invitations'::regclass;
select is(relrowsecurity, true, 'RLS enabled on permissions')
  from pg_class where oid = 'public.permissions'::regclass;

-- The seed is the security policy of this block, so it is asserted, not assumed.
select ok(
  exists (select 1 from public.role_permissions
          where role = 'owner' and permission_code = 'users.invite'),
  'owner may invite'
);
select ok(
  not exists (select 1 from public.role_permissions
              where role = 'operator' and permission_code = 'users.invite'),
  'operator may not invite'
);
select ok(
  not exists (select 1 from public.role_permissions
              where role = 'viewer' and permission_code = 'users.manage'),
  'viewer may not manage members'
);
select is(
  (select count(*)::int from public.role_permissions where role in ('operator', 'viewer')),
  0,
  'operator and viewer hold no permissions in this block'
);

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
  not has_function_privilege('anon', 'public.create_invitation(uuid, text, public.member_role, text, integer)', 'EXECUTE'),
  'anon may not call create_invitation'
);

-- Fail closed, with no session in play.
select is(public.has_permission('no.such.code', gen_random_uuid()), false,
          'an unknown permission code returns false');

select * from finish();
rollback;
