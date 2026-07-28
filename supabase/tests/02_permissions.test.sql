begin;
select plan(88);

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

-- Same guarantee, extended to the catalogue (post-review correction: the
-- constraint is "no insert, update or delete grant to any role on any of the
-- four tables", but until now only inventory_movements/inventory_balances
-- were actually asserted — prizes and prize_categories had zero coverage, so
-- a future migration granting so much as INSERT on prizes to authenticated
-- would have passed this suite). Every write to either table goes through
-- create_prize/update_prize/archive_prize/create_prize_category (0027), all
-- SECURITY DEFINER.
select ok(not has_table_privilege('authenticated', 'public.prizes', 'INSERT'),
          'authenticated may not insert prizes directly');
select ok(not has_table_privilege('authenticated', 'public.prizes', 'UPDATE'),
          'authenticated may not update prizes directly');
select ok(not has_table_privilege('authenticated', 'public.prizes', 'DELETE'),
          'authenticated may not delete prizes directly');
select ok(not has_table_privilege('service_role', 'public.prizes', 'INSERT'),
          'service_role may not insert prizes directly either');
select ok(not has_table_privilege('service_role', 'public.prizes', 'UPDATE'),
          'service_role may not update prizes directly either');
select ok(not has_table_privilege('service_role', 'public.prizes', 'DELETE'),
          'service_role may not delete prizes directly either');
select ok(not has_table_privilege('authenticated', 'public.prize_categories', 'INSERT'),
          'authenticated may not insert prize categories directly');
select ok(not has_table_privilege('authenticated', 'public.prize_categories', 'UPDATE'),
          'authenticated may not update prize categories directly');
select ok(not has_table_privilege('authenticated', 'public.prize_categories', 'DELETE'),
          'authenticated may not delete prize categories directly');
select ok(not has_table_privilege('service_role', 'public.prize_categories', 'INSERT'),
          'service_role may not insert prize categories directly either');
select ok(not has_table_privilege('service_role', 'public.prize_categories', 'UPDATE'),
          'service_role may not update prize categories directly either');
select ok(not has_table_privilege('service_role', 'public.prize_categories', 'DELETE'),
          'service_role may not delete prize categories directly either');

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

-- Block 2, Task 5 fix round 1: the catalogue policies must filter deleted_at
-- is null (review correction — reconcile_inventory does NOT exercise this
-- policy, since it is SECURITY DEFINER and bypasses RLS entirely; the ordinary
-- PostgREST read path is what needed the filter). This is an ORDINARY
-- inventory.view holder — a real role, role_permissions grant and
-- company_membership, not a platform_admin bypass — so the policy's own
-- has_permission predicate is exercised the same way a real user would reach
-- it, not just the deleted_at half of it.
insert into public.organizations (id, name) values
  ('99999999-0000-0000-0000-000000000020', 'Archived Prize Test Org');
insert into public.companies (id, organization_id, name) values
  ('99999999-0000-0000-0000-000000000021', '99999999-0000-0000-0000-000000000020', 'Archived Prize Test Station');
insert into public.roles (id, organization_id, name) values
  ('99999999-0000-0000-0000-000000000022', '99999999-0000-0000-0000-000000000020', 'Inventory Viewer');
insert into public.role_permissions (role_id, permission_code) values
  ('99999999-0000-0000-0000-000000000022', 'inventory.view');
insert into auth.users (id, email) values
  ('99999999-0000-0000-0000-000000000023', 'archived-prize-probe@example.test');
insert into public.company_memberships (user_id, company_id, organization_id, role_id) values
  ('99999999-0000-0000-0000-000000000023', '99999999-0000-0000-0000-000000000021',
   '99999999-0000-0000-0000-000000000020', '99999999-0000-0000-0000-000000000022');

insert into public.prizes (id, organization_id, company_id, name, deleted_at) values
  ('99999999-0000-0000-0000-000000000024', '99999999-0000-0000-0000-000000000020',
   '99999999-0000-0000-0000-000000000021', 'Live Catalogue Prize', null),
  ('99999999-0000-0000-0000-000000000025', '99999999-0000-0000-0000-000000000020',
   '99999999-0000-0000-0000-000000000021', 'Archived Catalogue Prize', now());

set local role authenticated;
set local request.jwt.claims = '{"sub": "99999999-0000-0000-0000-000000000023", "role": "authenticated"}';

create temporary table archived_prize_probe as
select * from public.prizes where company_id = '99999999-0000-0000-0000-000000000021';

reset role;

select is(
  (select count(*)::int from archived_prize_probe),
  1,
  'an ordinary inventory.view holder sees exactly one prize in this station'
);
select is(
  (select id from archived_prize_probe),
  '99999999-0000-0000-0000-000000000024'::uuid,
  'the visible prize is the live one, not the archived one'
);

-- Branch-level review, Important #2: the two ledger tables had the weakest
-- write-grant coverage of the four — inventory_movements had no INSERT
-- assertion for either role, and inventory_balances had only a single
-- service_role UPDATE assertion. prizes/prize_categories already covered all
-- six cells (three verbs x two roles) each; this completes the same grid for
-- the two tables the block exists to protect, so a future migration granting
-- so much as INSERT on inventory_movements to authenticated — the most
-- dangerous grant available, since it bypasses every permission check, every
-- transition and every lock — cannot pass this suite green.
select ok(not has_table_privilege('authenticated', 'public.inventory_movements', 'INSERT'),
          'authenticated may not insert into the ledger directly');
select ok(not has_table_privilege('service_role', 'public.inventory_movements', 'INSERT'),
          'service_role may not insert into the ledger directly either');
select ok(not has_table_privilege('authenticated', 'public.inventory_balances', 'INSERT'),
          'authenticated may not insert the projection directly');
select ok(not has_table_privilege('authenticated', 'public.inventory_balances', 'UPDATE'),
          'authenticated may not update the projection directly');
select ok(not has_table_privilege('authenticated', 'public.inventory_balances', 'DELETE'),
          'authenticated may not delete the projection directly');
select ok(not has_table_privilege('service_role', 'public.inventory_balances', 'INSERT'),
          'service_role may not insert the projection directly either');
select ok(not has_table_privilege('service_role', 'public.inventory_balances', 'DELETE'),
          'service_role may not delete the projection directly either');

-- Important #3: apply_inventory_movement's protective properties — SECURITY
-- INVOKER and EXECUTE granted to nobody — are what make a stray future GRANT
-- or a stray future SECURITY DEFINER harmless, respectively. Neither was
-- asserted anywhere before this; flipping either in a future migration would
-- have left this suite green while an unchecked write path opened.
select is(
  (select prosecdef from pg_proc
     where oid = 'public.apply_inventory_movement(uuid, uuid, public.inventory_movement_type, integer, public.inventory_bucket, public.inventory_bucket, text, text)'::regprocedure),
  false,
  'apply_inventory_movement is SECURITY INVOKER, not DEFINER'
);
select ok(
  not has_function_privilege('anon', 'public.apply_inventory_movement(uuid, uuid, public.inventory_movement_type, integer, public.inventory_bucket, public.inventory_bucket, text, text)', 'EXECUTE'),
  'anon may not call apply_inventory_movement'
);
select ok(
  not has_function_privilege('authenticated', 'public.apply_inventory_movement(uuid, uuid, public.inventory_movement_type, integer, public.inventory_bucket, public.inventory_bucket, text, text)', 'EXECUTE'),
  'authenticated may not call apply_inventory_movement'
);
select ok(
  not has_function_privilege('service_role', 'public.apply_inventory_movement(uuid, uuid, public.inventory_movement_type, integer, public.inventory_bucket, public.inventory_bucket, text, text)', 'EXECUTE'),
  'service_role may not call apply_inventory_movement'
);

-- The shared bootstrap helper (0030) carries the identical shape and the
-- identical reasoning: SECURITY INVOKER, EXECUTE granted to nobody, reachable
-- only from inside a SECURITY DEFINER body.
select is(
  (select prosecdef from pg_proc
     where oid = 'public.ensure_inventory_balance_row(uuid, uuid, uuid)'::regprocedure),
  false,
  'ensure_inventory_balance_row is SECURITY INVOKER, not DEFINER'
);
select ok(
  not has_function_privilege('anon', 'public.ensure_inventory_balance_row(uuid, uuid, uuid)', 'EXECUTE'),
  'anon may not call ensure_inventory_balance_row'
);
select ok(
  not has_function_privilege('authenticated', 'public.ensure_inventory_balance_row(uuid, uuid, uuid)', 'EXECUTE'),
  'authenticated may not call ensure_inventory_balance_row'
);
select ok(
  not has_function_privilege('service_role', 'public.ensure_inventory_balance_row(uuid, uuid, uuid)', 'EXECUTE'),
  'service_role may not call ensure_inventory_balance_row'
);

-- Important #6: service_role retained the default ACL's TRUNCATE grant on
-- all four tables until 0029's fix round 2 — TRUNCATE is neither INSERT,
-- UPDATE nor DELETE, so none of the assertions above would ever have caught
-- it, and a single TRUNCATE inventory_movements from service_role could
-- otherwise have wiped the ledger in one statement. Checked for authenticated
-- too, alongside service_role, so the grid is complete rather than pinned
-- only on the role the finding named.
select ok(not has_table_privilege('authenticated', 'public.prize_categories', 'TRUNCATE'),
          'authenticated may not truncate prize_categories');
select ok(not has_table_privilege('authenticated', 'public.prizes', 'TRUNCATE'),
          'authenticated may not truncate prizes');
select ok(not has_table_privilege('authenticated', 'public.inventory_movements', 'TRUNCATE'),
          'authenticated may not truncate the ledger');
select ok(not has_table_privilege('authenticated', 'public.inventory_balances', 'TRUNCATE'),
          'authenticated may not truncate the projection');
select ok(not has_table_privilege('service_role', 'public.prize_categories', 'TRUNCATE'),
          'service_role may not truncate prize_categories');
select ok(not has_table_privilege('service_role', 'public.prizes', 'TRUNCATE'),
          'service_role may not truncate prizes');
select ok(not has_table_privilege('service_role', 'public.inventory_movements', 'TRUNCATE'),
          'service_role may not truncate the ledger');
select ok(not has_table_privilege('service_role', 'public.inventory_balances', 'TRUNCATE'),
          'service_role may not truncate the projection');

select * from finish();
rollback;
