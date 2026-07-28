begin;
select plan(51);

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

-- Block 2: the catalogue's own seed, and the scope that decides which helper
-- resolves it. inventory.* must be company-scoped — an Organization-scoped
-- inventory permission would grant stock rights in Stations the holder has no
-- role in, which is the opposite of what Block 1c built.
select is(
  (select count(*)::int from public.permissions where module = 'inventory'),
  6,
  'six inventory permissions are seeded'
);
select is(
  (select count(*)::int from public.permissions where module = 'inventory' and scope = 'company'),
  6,
  'every inventory permission is Company-scoped'
);
select is(
  (select introduced_by_block from public.permissions where code = 'inventory.adjust'),
  '2',
  'inventory.adjust is seeded by this block'
);

select has_table('public', 'prizes', 'prizes exists');
select has_table('public', 'prize_categories', 'prize_categories exists');
select has_index('public', 'prizes', 'prizes_internal_code_unique',
  'an internal code is unique per Station while the prize is live');

-- Block 2, Task 2: the constraints that make a wrong number unrepresentable.
select col_not_null('public', 'inventory_movements', 'quantity', 'a movement has a quantity');
select hasnt_column('public', 'inventory_movements', 'updated_at',
  'the ledger has no updated_at, because it is never updated');
select hasnt_column('public', 'inventory_movements', 'deleted_at',
  'the ledger has no deleted_at, because it is never deleted');

-- The bucket floor. Declaring it and having it bite are different claims. A
-- Station and a prize must exist first, following the same pattern
-- 01_identity.test.sql uses for its cross-Organization probe — otherwise a
-- fabricated id would trip an unrelated foreign key before the throws_ok below
-- ever reaches the check constraint it means to prove. prizes.created_by is
-- nullable, so no auth.users row is needed to seed one here.
insert into public.organizations (id, name) values
  ('99999999-0000-0000-0000-000000000001', 'Ledger Test Org');
insert into public.companies (id, organization_id, name) values
  ('99999999-0000-0000-0000-000000000002', '99999999-0000-0000-0000-000000000001', 'Ledger Test Station');
insert into public.prizes (id, organization_id, company_id, name) values
  ('99999999-0000-0000-0000-000000000003', '99999999-0000-0000-0000-000000000001',
   '99999999-0000-0000-0000-000000000002', 'Ledger Test Prize');

select throws_ok(
  $$insert into public.inventory_balances (company_id, prize_id, organization_id, available)
    select c.id, p.id, c.organization_id, -1
    from public.companies c join public.prizes p on p.company_id = c.id limit 1$$,
  '23514',
  'new row for relation "inventory_balances" violates check constraint "inventory_balances_available_check"',
  'a negative bucket is rejected by the check constraint'
);

-- Block 2, Task 5: the four inventory tables, built in Tasks 1 and 2, are
-- secured only now. A table this migration misses looks exactly like one
-- that never needed securing (this project has shipped that mistake once
-- already — rate_limit_counters, Block 0) — so the state is asserted here
-- rather than left to whoever reads the migration list.
select is(relrowsecurity, true, 'RLS enabled on inventory_movements')
  from pg_class where oid = 'public.inventory_movements'::regclass;
select is(relrowsecurity, true, 'RLS enabled on inventory_balances')
  from pg_class where oid = 'public.inventory_balances'::regclass;
select is(relrowsecurity, true, 'RLS enabled on prizes')
  from pg_class where oid = 'public.prizes'::regclass;
select is(relrowsecurity, true, 'RLS enabled on prize_categories')
  from pg_class where oid = 'public.prize_categories'::regclass;

-- The ledger's immutability, and the projection's single-writer property, are
-- grants, not comments. No role — not even service_role — holds UPDATE or
-- DELETE on either table; every write goes through a SECURITY DEFINER RPC
-- that runs as the table owner.
select ok(not has_table_privilege('authenticated', 'public.inventory_movements', 'UPDATE'),
          'authenticated may not update the ledger');
select ok(not has_table_privilege('authenticated', 'public.inventory_movements', 'DELETE'),
          'authenticated may not delete from the ledger');
select ok(not has_table_privilege('service_role', 'public.inventory_movements', 'UPDATE'),
          'service_role may not update the ledger either');
select ok(not has_table_privilege('service_role', 'public.inventory_movements', 'DELETE'),
          'service_role may not delete from the ledger either');
select ok(not has_table_privilege('service_role', 'public.inventory_balances', 'UPDATE'),
          'service_role may not write the projection directly');

-- Block 2, Task 5 (post-review correction): reconcile_inventory (0028) is
-- pure SQL — a recomputation from the ledger, joined against the stored
-- projection — with no automated regression guard before this. A Station, a
-- prize, two movements and a deliberately WRONG balance row are seeded as the
-- table owner (bypassing RLS, same as the ledger fixtures above), then the
-- gated RPC is exercised under a real session, following the same
-- organizations/companies/prize seeding shape 01_identity.test.sql and the
-- ledger probe above already use. The session is a platform_admin rather
-- than a role/role_permissions grant: has_permission ORs in
-- is_platform_admin() for every code, so this needs no company_memberships
-- plumbing to exercise the arithmetic.
insert into public.organizations (id, name) values
  ('99999999-0000-0000-0000-000000000010', 'Reconcile Test Org');
insert into public.companies (id, organization_id, name) values
  ('99999999-0000-0000-0000-000000000011', '99999999-0000-0000-0000-000000000010', 'Reconcile Test Station');
insert into public.prizes (id, organization_id, company_id, name) values
  ('99999999-0000-0000-0000-000000000012', '99999999-0000-0000-0000-000000000010',
   '99999999-0000-0000-0000-000000000011', 'Reconcile Test Prize');

-- INITIAL_ENTRY(10) to available, then RESERVATION(3) available -> reserved.
-- The true figures are available = 10 - 3 = 7, reserved = 0 + 3 = 3.
insert into public.inventory_movements
  (organization_id, company_id, prize_id, movement_type, quantity, from_bucket, to_bucket)
values
  ('99999999-0000-0000-0000-000000000010', '99999999-0000-0000-0000-000000000011',
   '99999999-0000-0000-0000-000000000012', 'INITIAL_ENTRY', 10, null, 'available'),
  ('99999999-0000-0000-0000-000000000010', '99999999-0000-0000-0000-000000000011',
   '99999999-0000-0000-0000-000000000012', 'RESERVATION', 3, 'available', 'reserved');

-- available booked correctly (7); reserved deliberately booked wrong (5, not 3).
insert into public.inventory_balances
  (company_id, prize_id, organization_id, available, reserved)
values
  ('99999999-0000-0000-0000-000000000011', '99999999-0000-0000-0000-000000000012',
   '99999999-0000-0000-0000-000000000010', 7, 5);

insert into auth.users (id, email) values
  ('99999999-0000-0000-0000-000000000013', 'reconcile-probe@example.test');
insert into public.platform_admins (user_id) values
  ('99999999-0000-0000-0000-000000000013');

set local role authenticated;
set local request.jwt.claims = '{"sub": "99999999-0000-0000-0000-000000000013", "role": "authenticated"}';

create temporary table reconcile_probe as
select * from public.reconcile_inventory('99999999-0000-0000-0000-000000000011');

reset role;

-- Exactly the one deliberately wrong bucket, with both figures: a function
-- that silently returned nothing every time would pass a test that never
-- forced a real divergence, so this scenario is built to always disagree
-- somewhere. A dropped term in the recomputation (say, the from_bucket
-- subtraction) would make `available` diverge too, turning this into two
-- rows instead of one — the count assertion catches that as surely as the
-- value assertions catch a wrong sum.
select is(
  (select count(*)::int from reconcile_probe),
  1,
  'reconcile_inventory surfaces exactly the one deliberately wrong bucket'
);
select is(
  (select bucket from reconcile_probe),
  'reserved',
  'the divergence is reported on the reserved bucket'
);
select is(
  (select stored from reconcile_probe),
  5,
  'the stored figure is the deliberately wrong booked value'
);
select is(
  (select computed from reconcile_probe),
  3,
  'the computed figure is the true sum from the ledger (0 + 3 from the reservation, none of it withdrawn)'
);

select * from finish();
rollback;
