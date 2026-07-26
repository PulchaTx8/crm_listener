begin;
select plan(21);

-- tables exist
select has_table('public', 'profiles', 'profiles exists');
select has_table('public', 'organizations', 'organizations exists');
select has_table('public', 'companies', 'companies exists');
select has_table('public', 'organization_memberships', 'organization_memberships exists');
select has_table('public', 'company_memberships', 'company_memberships exists');
select has_table('public', 'platform_admins', 'platform_admins exists');
select has_table('public', 'audit_logs', 'audit_logs exists');
select has_table('public', 'contact_requests', 'contact_requests exists');

-- RLS is on everywhere it must be
select is(relrowsecurity, true, 'RLS enabled on companies')
  from pg_class where oid = 'public.companies'::regclass;
select is(relrowsecurity, true, 'RLS enabled on company_memberships')
  from pg_class where oid = 'public.company_memberships'::regclass;
select is(relrowsecurity, true, 'RLS enabled on contact_requests')
  from pg_class where oid = 'public.contact_requests'::regclass;
select is(relrowsecurity, true, 'RLS enabled on profiles')
  from pg_class where oid = 'public.profiles'::regclass;

-- anon may insert a contact request and nothing more
select ok(
  has_table_privilege('anon', 'public.contact_requests', 'INSERT'),
  'anon may submit a contact request'
);
select ok(
  not has_table_privilege('anon', 'public.contact_requests', 'SELECT'),
  'anon may not read contact requests back'
);

-- anon has no reach into tenant data at all
select ok(
  not has_table_privilege('anon', 'public.companies', 'SELECT'),
  'anon has no read on companies'
);

-- The password gate is enforced by the grant, not only by the policy. A
-- table-level UPDATE grant here would let any user clear their own gate with
-- one PostgREST PATCH, and a later column-level REVOKE could not take it back.
select ok(
  has_column_privilege('authenticated', 'public.profiles', 'full_name', 'UPDATE'),
  'a user may edit their own display name'
);
select ok(
  not has_column_privilege('authenticated', 'public.profiles', 'must_change_password', 'UPDATE'),
  'a user may not clear their own password gate'
);
select ok(
  not has_column_privilege('authenticated', 'public.profiles', 'provisional_expires_at', 'UPDATE'),
  'a user may not extend their own provisional password'
);
select ok(
  not has_table_privilege('authenticated', 'public.profiles', 'UPDATE'),
  'no table-wide UPDATE grant on profiles, which would override the column grants'
);

-- The privileged RPCs must not be reachable by anon at all.
select ok(
  not has_function_privilege('anon', 'public.provision_customer(uuid, text, text, text)', 'EXECUTE'),
  'anon may not call provision_customer'
);
select ok(
  not has_function_privilege('anon', 'public.suspend_company(uuid, text)', 'EXECUTE'),
  'anon may not call suspend_company'
);

select * from finish();
rollback;
