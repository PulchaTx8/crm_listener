begin;
select plan(29);

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
-- Block 16 retired provision_customer, which created an Organization and a
-- Station in one call. Its replacement inherits the assertion unchanged.
select ok(
  not has_function_privilege('anon', 'public.provision_organization(uuid, text)', 'EXECUTE'),
  'anon may not call provision_organization'
);
select ok(
  not has_function_privilege('anon', 'public.suspend_company(uuid, text)', 'EXECUTE'),
  'anon may not call suspend_company'
);

-- Block 1c: a membership without a role is not representable.
select col_not_null('public', 'company_memberships', 'role_id',
  'a Company membership must carry a role');
select col_not_null('public', 'company_memberships', 'organization_id',
  'a Company membership carries its Organization, for the composite keys');

select has_index('public', 'company_memberships', 'company_memberships_role_idx',
  'live memberships are indexed by role, which delete_role reads');
select has_index('public', 'company_memberships', 'company_memberships_org_idx',
  'live memberships are indexed by Organization, which has_org_permission reads');

-- The composite foreign keys are the whole cross-tenant guarantee.
select fk_ok('public', 'company_memberships', array['role_id', 'organization_id'],
             'public', 'roles', array['id', 'organization_id'],
             'a role can only be assigned inside its own Organization');
select fk_ok('public', 'company_memberships', array['company_id', 'organization_id'],
             'public', 'companies', array['id', 'organization_id'],
             'a membership can only name a Company of its own Organization');

-- Declaring the constraint and having it bite are different claims. This is the
-- one that matters, so it is asserted rather than reasoned about. A real user
-- row is required: company_memberships.user_id references auth.users, and that
-- constraint is older than company_memberships_role_org_fk, so a bare
-- gen_random_uuid() would trip THAT foreign key first and the assertion would
-- pass for the wrong reason. Pinning the message names the constraint that must
-- fire.
insert into public.organizations (id, name) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'Org A'),
  ('aaaaaaaa-0000-0000-0000-000000000002', 'Org B');
insert into public.companies (id, organization_id, name) values
  ('bbbbbbbb-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001', 'Station A');
insert into public.roles (id, organization_id, name) values
  ('cccccccc-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000002', 'Foreign');
insert into auth.users (id, email) values
  ('dddddddd-0000-0000-0000-000000000001', 'fk-probe@example.test');

select throws_ok(
  $$insert into public.company_memberships (user_id, company_id, organization_id, role_id)
    values ('dddddddd-0000-0000-0000-000000000001',
            'bbbbbbbb-0000-0000-0000-000000000001',
            'aaaaaaaa-0000-0000-0000-000000000001',
            'cccccccc-0000-0000-0000-000000000001')$$,
  '23503',
  'insert or update on table "company_memberships" violates foreign key constraint "company_memberships_role_org_fk"',
  'a role from another Organization cannot be assigned'
);

-- If any column or function signature still held member_role, the DROP TYPE in
-- 0018 would have failed the migration — but a future CREATE could bring it
-- back, and a lingering enum beside org_role is exactly the ambiguity this
-- block removed.
select hasnt_type('public', 'member_role', 'the fixed-role enum is gone');

select * from finish();
rollback;
