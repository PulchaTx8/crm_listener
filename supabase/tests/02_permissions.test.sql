begin;
select plan(208);

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

-- This documents Postgres's own NULLS DISTINCT behaviour, not a guarantee of
-- members_email_unique: two Members with no e-mail were always going to
-- coexist, with or without the `and email_normalized is not null` term on the
-- index. It is not evidence that the term does anything for correctness.
insert into public.organizations (id, name) values ('eeeeeeee-0000-0000-0000-000000000001', 'Org M');
insert into public.members (organization_id, full_name) values
  ('eeeeeeee-0000-0000-0000-000000000001', 'No Contact One'),
  ('eeeeeeee-0000-0000-0000-000000000001', 'No Contact Two');
select pass('two Members without an e-mail can both exist (Postgres NULLS DISTINCT, not our constraint)');

-- The assertion that actually bites: a genuine duplicate e-mail (any case,
-- proving email_normalized's lower() is doing the collapsing) in one
-- Organization is refused. The constraint name is pinned in the expected
-- message, not just the SQLSTATE — Block 1c shipped a throws_ok that matched
-- only the code and passed on an unrelated foreign key.
insert into public.members (organization_id, full_name, email) values
  ('eeeeeeee-0000-0000-0000-000000000001', 'First Email', 'same@example.com');
select throws_ok(
  $$insert into public.members (organization_id, full_name, email) values
      ('eeeeeeee-0000-0000-0000-000000000001', 'Second Email', 'SAME@Example.com')$$,
  '23505',
  'duplicate key value violates unique constraint "members_email_unique"',
  'a second Member with the same e-mail (any case) in one Organization is refused'
);

-- The same guarantee for phone: two spellings of one number collide because
-- phone_normalized strips everything but digits, not because the literal
-- strings match. Constraint name pinned for the same reason as above.
insert into public.members (organization_id, full_name, phone) values
  ('eeeeeeee-0000-0000-0000-000000000001', 'First Phone', '+55 (11) 98765-4321');
select throws_ok(
  $$insert into public.members (organization_id, full_name, phone) values
      ('eeeeeeee-0000-0000-0000-000000000001', 'Second Phone', '5511987654321')$$,
  '23505',
  'duplicate key value violates unique constraint "members_phone_unique"',
  'two spellings of the same phone number collide after normalisation'
);

-- The guarantee that cpf_hash never holds a raw CPF must not rest solely on the
-- Node code (Task 6) remembering to hash it: an eleven-digit value is exactly
-- the shape a raw CPF has, and the format check refuses it outright.
select throws_ok(
  $$insert into public.members (organization_id, full_name, cpf_hash) values
      ('eeeeeeee-0000-0000-0000-000000000001', 'Raw Cpf', '12345678901')$$,
  '23514',
  'new row for relation "members" violates check constraint "members_cpf_hash_check"',
  'an eleven-digit raw CPF is refused by the cpf_hash format check'
);

select is(
  (select count(*)::int from public.permissions where module = 'members' and scope = 'company'),
  6,
  'six Member permissions, all Company-scoped'
);

-- Block 3, Task 5: the five Member tables, built in Tasks 1 and 2, are secured only
-- now. A table this migration misses looks exactly like one that never needed
-- securing (this project has shipped that mistake once already — rate_limit_counters,
-- Block 0) — so the grid is asserted here rather than left to whoever reads the
-- migration list. RLS enabled, select granted to authenticated and service_role, anon
-- holding none of it, exactly one policy, and no write grant to any role (including
-- TRUNCATE, which is neither INSERT, UPDATE nor DELETE and so nothing else below
-- closes it) — the same shape 0029's final review established for the four inventory
-- tables, required here with more force: these five hold personal data.
select is(relrowsecurity, true, 'RLS enabled on members')
  from pg_class where oid = 'public.members'::regclass;
select is(relrowsecurity, true, 'RLS enabled on member_company_links')
  from pg_class where oid = 'public.member_company_links'::regclass;
select is(relrowsecurity, true, 'RLS enabled on member_consents')
  from pg_class where oid = 'public.member_consents'::regclass;
select is(relrowsecurity, true, 'RLS enabled on member_notes')
  from pg_class where oid = 'public.member_notes'::regclass;
select is(relrowsecurity, true, 'RLS enabled on member_blocks')
  from pg_class where oid = 'public.member_blocks'::regclass;

select ok(has_table_privilege('authenticated', 'public.members', 'SELECT'),
          'authenticated may read members');
select ok(has_table_privilege('authenticated', 'public.member_company_links', 'SELECT'),
          'authenticated may read member_company_links');
select ok(has_table_privilege('authenticated', 'public.member_consents', 'SELECT'),
          'authenticated may read member_consents');
select ok(has_table_privilege('authenticated', 'public.member_notes', 'SELECT'),
          'authenticated may read member_notes');
select ok(has_table_privilege('authenticated', 'public.member_blocks', 'SELECT'),
          'authenticated may read member_blocks');

select ok(has_table_privilege('service_role', 'public.members', 'SELECT'),
          'service_role may read members');
select ok(has_table_privilege('service_role', 'public.member_company_links', 'SELECT'),
          'service_role may read member_company_links');
select ok(has_table_privilege('service_role', 'public.member_consents', 'SELECT'),
          'service_role may read member_consents');
select ok(has_table_privilege('service_role', 'public.member_notes', 'SELECT'),
          'service_role may read member_notes');
select ok(has_table_privilege('service_role', 'public.member_blocks', 'SELECT'),
          'service_role may read member_blocks');

select ok(not has_table_privilege('anon', 'public.members', 'SELECT'),
          'anon may not read members');
select ok(not has_table_privilege('anon', 'public.member_company_links', 'SELECT'),
          'anon may not read member_company_links');
select ok(not has_table_privilege('anon', 'public.member_consents', 'SELECT'),
          'anon may not read member_consents');
select ok(not has_table_privilege('anon', 'public.member_notes', 'SELECT'),
          'anon may not read member_notes');
select ok(not has_table_privilege('anon', 'public.member_blocks', 'SELECT'),
          'anon may not read member_blocks');

select is(
  (select count(*)::int from pg_policies where schemaname = 'public' and tablename = 'members'),
  1, 'members carries exactly one policy');
select is(
  (select count(*)::int from pg_policies where schemaname = 'public' and tablename = 'member_company_links'),
  1, 'member_company_links carries exactly one policy');
select is(
  (select count(*)::int from pg_policies where schemaname = 'public' and tablename = 'member_consents'),
  1, 'member_consents carries exactly one policy');
select is(
  (select count(*)::int from pg_policies where schemaname = 'public' and tablename = 'member_notes'),
  1, 'member_notes carries exactly one policy');
select is(
  (select count(*)::int from pg_policies where schemaname = 'public' and tablename = 'member_blocks'),
  1, 'member_blocks carries exactly one policy');

select ok(not has_table_privilege('authenticated', 'public.members', 'INSERT'), 'authenticated may not insert members directly');
select ok(not has_table_privilege('authenticated', 'public.members', 'UPDATE'), 'authenticated may not update members directly');
select ok(not has_table_privilege('authenticated', 'public.members', 'DELETE'), 'authenticated may not delete members directly');
select ok(not has_table_privilege('service_role', 'public.members', 'INSERT'), 'service_role may not insert members directly either');
select ok(not has_table_privilege('service_role', 'public.members', 'UPDATE'), 'service_role may not update members directly either');
select ok(not has_table_privilege('service_role', 'public.members', 'DELETE'), 'service_role may not delete members directly either');

select ok(not has_table_privilege('authenticated', 'public.member_company_links', 'INSERT'), 'authenticated may not insert member_company_links directly');
select ok(not has_table_privilege('authenticated', 'public.member_company_links', 'UPDATE'), 'authenticated may not update member_company_links directly');
select ok(not has_table_privilege('authenticated', 'public.member_company_links', 'DELETE'), 'authenticated may not delete member_company_links directly');
select ok(not has_table_privilege('service_role', 'public.member_company_links', 'INSERT'), 'service_role may not insert member_company_links directly either');
select ok(not has_table_privilege('service_role', 'public.member_company_links', 'UPDATE'), 'service_role may not update member_company_links directly either');
select ok(not has_table_privilege('service_role', 'public.member_company_links', 'DELETE'), 'service_role may not delete member_company_links directly either');

select ok(not has_table_privilege('authenticated', 'public.member_consents', 'INSERT'), 'authenticated may not insert member_consents directly');
select ok(not has_table_privilege('authenticated', 'public.member_consents', 'UPDATE'), 'authenticated may not update member_consents directly');
select ok(not has_table_privilege('authenticated', 'public.member_consents', 'DELETE'), 'authenticated may not delete member_consents directly');
select ok(not has_table_privilege('service_role', 'public.member_consents', 'INSERT'), 'service_role may not insert member_consents directly either');
select ok(not has_table_privilege('service_role', 'public.member_consents', 'UPDATE'), 'service_role may not update member_consents directly either');
select ok(not has_table_privilege('service_role', 'public.member_consents', 'DELETE'), 'service_role may not delete member_consents directly either');

select ok(not has_table_privilege('authenticated', 'public.member_notes', 'INSERT'), 'authenticated may not insert member_notes directly');
select ok(not has_table_privilege('authenticated', 'public.member_notes', 'UPDATE'), 'authenticated may not update member_notes directly');
select ok(not has_table_privilege('authenticated', 'public.member_notes', 'DELETE'), 'authenticated may not delete member_notes directly');
select ok(not has_table_privilege('service_role', 'public.member_notes', 'INSERT'), 'service_role may not insert member_notes directly either');
select ok(not has_table_privilege('service_role', 'public.member_notes', 'UPDATE'), 'service_role may not update member_notes directly either');
select ok(not has_table_privilege('service_role', 'public.member_notes', 'DELETE'), 'service_role may not delete member_notes directly either');

select ok(not has_table_privilege('authenticated', 'public.member_blocks', 'INSERT'), 'authenticated may not insert member_blocks directly');
select ok(not has_table_privilege('authenticated', 'public.member_blocks', 'UPDATE'), 'authenticated may not update member_blocks directly');
select ok(not has_table_privilege('authenticated', 'public.member_blocks', 'DELETE'), 'authenticated may not delete member_blocks directly');
select ok(not has_table_privilege('service_role', 'public.member_blocks', 'INSERT'), 'service_role may not insert member_blocks directly either');
select ok(not has_table_privilege('service_role', 'public.member_blocks', 'UPDATE'), 'service_role may not update member_blocks directly either');
select ok(not has_table_privilege('service_role', 'public.member_blocks', 'DELETE'), 'service_role may not delete member_blocks directly either');

-- anon held no SELECT either (asserted above) and never held INSERT/UPDATE/DELETE by
-- default, but the explicit `revoke insert, update, delete ... from anon,
-- authenticated, service_role` this migration now carries (whole-branch review,
-- minor) covers all three roles for all five tables — asserted for anon here to match,
-- closing the one role this grid left unchecked for these three privileges.
select ok(not has_table_privilege('anon', 'public.members', 'INSERT'), 'anon may not insert members directly');
select ok(not has_table_privilege('anon', 'public.members', 'UPDATE'), 'anon may not update members directly');
select ok(not has_table_privilege('anon', 'public.members', 'DELETE'), 'anon may not delete members directly');
select ok(not has_table_privilege('anon', 'public.member_company_links', 'INSERT'), 'anon may not insert member_company_links directly');
select ok(not has_table_privilege('anon', 'public.member_company_links', 'UPDATE'), 'anon may not update member_company_links directly');
select ok(not has_table_privilege('anon', 'public.member_company_links', 'DELETE'), 'anon may not delete member_company_links directly');
select ok(not has_table_privilege('anon', 'public.member_consents', 'INSERT'), 'anon may not insert member_consents directly');
select ok(not has_table_privilege('anon', 'public.member_consents', 'UPDATE'), 'anon may not update member_consents directly');
select ok(not has_table_privilege('anon', 'public.member_consents', 'DELETE'), 'anon may not delete member_consents directly');
select ok(not has_table_privilege('anon', 'public.member_notes', 'INSERT'), 'anon may not insert member_notes directly');
select ok(not has_table_privilege('anon', 'public.member_notes', 'UPDATE'), 'anon may not update member_notes directly');
select ok(not has_table_privilege('anon', 'public.member_notes', 'DELETE'), 'anon may not delete member_notes directly');
select ok(not has_table_privilege('anon', 'public.member_blocks', 'INSERT'), 'anon may not insert member_blocks directly');
select ok(not has_table_privilege('anon', 'public.member_blocks', 'UPDATE'), 'anon may not update member_blocks directly');
select ok(not has_table_privilege('anon', 'public.member_blocks', 'DELETE'), 'anon may not delete member_blocks directly');

select ok(not has_table_privilege('authenticated', 'public.members', 'TRUNCATE'), 'authenticated may not truncate members');
select ok(not has_table_privilege('service_role', 'public.members', 'TRUNCATE'), 'service_role may not truncate members');
select ok(not has_table_privilege('authenticated', 'public.member_company_links', 'TRUNCATE'), 'authenticated may not truncate member_company_links');
select ok(not has_table_privilege('service_role', 'public.member_company_links', 'TRUNCATE'), 'service_role may not truncate member_company_links');
select ok(not has_table_privilege('authenticated', 'public.member_consents', 'TRUNCATE'), 'authenticated may not truncate member_consents');
select ok(not has_table_privilege('service_role', 'public.member_consents', 'TRUNCATE'), 'service_role may not truncate member_consents');
select ok(not has_table_privilege('authenticated', 'public.member_notes', 'TRUNCATE'), 'authenticated may not truncate member_notes');
select ok(not has_table_privilege('service_role', 'public.member_notes', 'TRUNCATE'), 'service_role may not truncate member_notes');
select ok(not has_table_privilege('authenticated', 'public.member_blocks', 'TRUNCATE'), 'authenticated may not truncate member_blocks');
select ok(not has_table_privilege('service_role', 'public.member_blocks', 'TRUNCATE'), 'service_role may not truncate member_blocks');

-- Behavioural proof the policies actually decide something, not just that they exist.
-- Station A and B stay active; Station C starts active (a delegate is given
-- members.view there) and is archived (deleted_at set) partway through — proving the
-- is_platform_admin()/is_owner() bypass member_reachable (0033) carries actually does
-- something: an ordinary members.view holder loses access the moment their Station
-- archives (has_company_access, 0016/0024, applies the active-Station gate to
-- everyone), while the Organization owner still sees the same Member through the
-- is_owner bypass — the same fix Task 3's review made to member_reachable for the
-- write path. A fifth Member is archived outright (deleted_at set), to prove that
-- term of members_select_reachable actually filters for BOTH the delegate and the
-- owner, not only the has_permission/member_reachable half. A second Organization-wide
-- block, on a Member the delegate cannot otherwise reach, proves member_blocks'
-- has_org_permission branch is actually conjoined with reachability (Task 5 review,
-- Important 2) rather than standing alone.
insert into public.organizations (id, name) values
  ('dddddddd-0000-0000-0000-000000000001', 'Members RLS Test Org');
insert into public.companies (id, organization_id, name) values
  ('dddddddd-0000-0000-0000-000000000002', 'dddddddd-0000-0000-0000-000000000001', 'Station A'),
  ('dddddddd-0000-0000-0000-000000000003', 'dddddddd-0000-0000-0000-000000000001', 'Station B'),
  ('dddddddd-0000-0000-0000-000000000004', 'dddddddd-0000-0000-0000-000000000001', 'Station C');

insert into public.roles (id, organization_id, name) values
  ('dddddddd-0000-0000-0000-000000000005', 'dddddddd-0000-0000-0000-000000000001', 'Station A Viewer'),
  ('dddddddd-0000-0000-0000-000000000006', 'dddddddd-0000-0000-0000-000000000001', 'Station C Viewer');
insert into public.role_permissions (role_id, permission_code) values
  ('dddddddd-0000-0000-0000-000000000005', 'members.view'),
  ('dddddddd-0000-0000-0000-000000000006', 'members.view');

insert into auth.users (id, email) values
  ('dddddddd-0000-0000-0000-000000000007', 'members-rls-delegate@example.test'),
  ('dddddddd-0000-0000-0000-000000000008', 'members-rls-owner@example.test');

insert into public.company_memberships (user_id, company_id, organization_id, role_id) values
  ('dddddddd-0000-0000-0000-000000000007', 'dddddddd-0000-0000-0000-000000000002',
   'dddddddd-0000-0000-0000-000000000001', 'dddddddd-0000-0000-0000-000000000005'),
  ('dddddddd-0000-0000-0000-000000000007', 'dddddddd-0000-0000-0000-000000000004',
   'dddddddd-0000-0000-0000-000000000001', 'dddddddd-0000-0000-0000-000000000006');
insert into public.organization_memberships (user_id, organization_id, role) values
  ('dddddddd-0000-0000-0000-000000000008', 'dddddddd-0000-0000-0000-000000000001', 'owner');

-- The fifth Member is archived (deleted_at set) but linked to Station A, the one
-- Station the delegate CAN otherwise reach — proof that "deleted_at is null" in
-- members_select_reachable actually does something (Task 5 review: this term had
-- zero coverage before, since no archived Member was seeded). Archived deliberately
-- via the INSERT rather than a later UPDATE (unlike Station C below): the point is
-- the Member was never visible in the first place, not that visibility was
-- withdrawn mid-script.
insert into public.members (id, organization_id, full_name, deleted_at) values
  ('dddddddd-0000-0000-0000-000000000009', 'dddddddd-0000-0000-0000-000000000001', 'Only Station A', null),
  ('dddddddd-0000-0000-0000-00000000000a', 'dddddddd-0000-0000-0000-000000000001', 'Only Station B', null),
  ('dddddddd-0000-0000-0000-00000000000b', 'dddddddd-0000-0000-0000-000000000001', 'Only Station C (soon archived)', null),
  ('dddddddd-0000-0000-0000-00000000000c', 'dddddddd-0000-0000-0000-000000000001', 'Both A and B', null),
  ('dddddddd-0000-0000-0000-000000000010', 'dddddddd-0000-0000-0000-000000000001', 'Archived, linked to Station A', now());

insert into public.member_company_links (member_id, company_id, organization_id) values
  ('dddddddd-0000-0000-0000-000000000009', 'dddddddd-0000-0000-0000-000000000002', 'dddddddd-0000-0000-0000-000000000001'),
  ('dddddddd-0000-0000-0000-00000000000a', 'dddddddd-0000-0000-0000-000000000003', 'dddddddd-0000-0000-0000-000000000001'),
  ('dddddddd-0000-0000-0000-00000000000b', 'dddddddd-0000-0000-0000-000000000004', 'dddddddd-0000-0000-0000-000000000001'),
  ('dddddddd-0000-0000-0000-00000000000c', 'dddddddd-0000-0000-0000-000000000002', 'dddddddd-0000-0000-0000-000000000001'),
  ('dddddddd-0000-0000-0000-00000000000c', 'dddddddd-0000-0000-0000-000000000003', 'dddddddd-0000-0000-0000-000000000001'),
  ('dddddddd-0000-0000-0000-000000000010', 'dddddddd-0000-0000-0000-000000000002', 'dddddddd-0000-0000-0000-000000000001');

-- The critical proof for member_notes: the SAME Member (the "Both A and B" row) has a
-- note written at Station A and a note written at Station B. A caller with
-- members.view at A only must see the first and NOT the second, even though the
-- Member itself is visible (reachable via the Station A link) — proving the notes
-- policy tests the NOTE's own company_id, not "any Station the Member is linked to".
insert into public.member_notes (id, organization_id, member_id, company_id, body) values
  ('dddddddd-0000-0000-0000-00000000000d', 'dddddddd-0000-0000-0000-000000000001',
   'dddddddd-0000-0000-0000-00000000000c', 'dddddddd-0000-0000-0000-000000000002', 'VISIBLE-NOTE-STATION-A'),
  ('dddddddd-0000-0000-0000-00000000000e', 'dddddddd-0000-0000-0000-000000000001',
   'dddddddd-0000-0000-0000-00000000000c', 'dddddddd-0000-0000-0000-000000000003', 'HIDDEN-NOTE-STATION-B');

-- An Organization-wide block (company_id null) on the Station-A Member, to prove the
-- has_org_permission branch of the member_blocks policy.
insert into public.member_blocks (id, organization_id, member_id, company_id, kind, reason) values
  ('dddddddd-0000-0000-0000-00000000000f', 'dddddddd-0000-0000-0000-000000000001',
   'dddddddd-0000-0000-0000-000000000009', null, 'draw_ban', 'org-wide test block');

-- The negative case Task 5 review's Important 2 asked for: an Organization-wide
-- block on the Station-B-only Member, who the delegate cannot reach at all. Before
-- the fix, has_org_permission('members.view', org) alone was enough to see this row
-- — true for the delegate via their role at Station A — even though member_id names
-- a Member members_select_reachable itself hides from them. The seeded block above
-- (on the Station-A Member) cannot catch this: the delegate already sees that Member
-- through Station A, so it passes whether the leak exists or not.
insert into public.member_blocks (id, organization_id, member_id, company_id, kind, reason) values
  ('dddddddd-0000-0000-0000-000000000012', 'dddddddd-0000-0000-0000-000000000001',
   'dddddddd-0000-0000-0000-00000000000a', null, 'suspension', 'org-wide block on an unreachable Member');

-- Archive Station C now that the fixtures above are in place. The "Only Station C"
-- Member's one link is here.
update public.companies set deleted_at = now()
 where id = 'dddddddd-0000-0000-0000-000000000004';

set local role authenticated;
set local request.jwt.claims = '{"sub": "dddddddd-0000-0000-0000-000000000007", "role": "authenticated"}';

create temporary table delegate_members_probe as
select id from public.members where organization_id = 'dddddddd-0000-0000-0000-000000000001' order by id;

create temporary table delegate_notes_probe as
select body from public.member_notes where member_id = 'dddddddd-0000-0000-0000-00000000000c' order by body;

create temporary table delegate_blocks_probe as
select id from public.member_blocks where member_id = 'dddddddd-0000-0000-0000-000000000009';

create temporary table delegate_blocks_probe_negative as
select id from public.member_blocks where member_id = 'dddddddd-0000-0000-0000-00000000000a';

reset role;

set local role authenticated;
set local request.jwt.claims = '{"sub": "dddddddd-0000-0000-0000-000000000008", "role": "authenticated"}';

create temporary table owner_members_probe as
select id from public.members where organization_id = 'dddddddd-0000-0000-0000-000000000001' order by id;

reset role;

select is(
  (select array_agg(id order by id) from delegate_members_probe),
  array['dddddddd-0000-0000-0000-000000000009'::uuid, 'dddddddd-0000-0000-0000-00000000000c'::uuid],
  'a delegate with members.view at Station A only sees the Member linked there and the Member linked to A and B, and nothing else'
);
select is(
  (select count(*)::int from delegate_members_probe where id = 'dddddddd-0000-0000-0000-00000000000a'),
  0,
  'the delegate does not see the Member reachable only at Station B, where they hold no permission'
);
select is(
  (select count(*)::int from delegate_members_probe where id = 'dddddddd-0000-0000-0000-00000000000b'),
  0,
  'the delegate does not see the Member reachable only at Station C, now archived, even though they held members.view there before the archival'
);
select is(
  (select count(*)::int from delegate_members_probe where id = 'dddddddd-0000-0000-0000-000000000010'),
  0,
  'the delegate does not see the archived Member, even though it is linked to Station A where the delegate holds members.view — deleted_at is null actually filters'
);
select is(
  (select array_agg(body order by body) from delegate_notes_probe),
  array['VISIBLE-NOTE-STATION-A'],
  'the delegate sees only the note written at Station A, not the note written at Station B about the same Member'
);
select is(
  (select count(*)::int from delegate_blocks_probe),
  1,
  'the delegate sees the Organization-wide block through has_org_permission, granted by their role at Station A'
);
select is(
  (select count(*)::int from delegate_blocks_probe_negative),
  0,
  'the delegate does NOT see the Organization-wide block on the Station-B-only Member: has_org_permission alone is not enough, Task 5 review Important 2'
);
select is(
  (select array_agg(id order by id) from owner_members_probe),
  array['dddddddd-0000-0000-0000-000000000009'::uuid, 'dddddddd-0000-0000-0000-00000000000a'::uuid,
        'dddddddd-0000-0000-0000-00000000000b'::uuid, 'dddddddd-0000-0000-0000-00000000000c'::uuid],
  'the Organization owner sees all four live Members, including the one reachable only through the now-archived Station C'
);
select is(
  (select count(*)::int from owner_members_probe where id = 'dddddddd-0000-0000-0000-000000000010'),
  0,
  'the Organization owner does not see the archived Member either — deleted_at is null sits outside member_reachable''s own bypass, by design'
);

-- Block 3b, Task 3: members_blocked_bulk (0036), the set-at-a-time form of
-- is_member_blocked (0032). Grant grid first, then behavioural proof: batch
-- semantics (duplicates, an empty batch, a null batch) and the guard,
-- including the cross-Organization case Task 3's review found was NOT safe
-- in the brief's first draft (see 0036's own header comment) — an
-- Organization-wide block (member_blocks.company_id is null) carries
-- nothing tying it to p_company_id, so matching on member_id and company_id
-- alone let a caller entitled to their own Station learn whether an
-- arbitrary member_id in ANY Organization holds an active Organization-wide
-- block. 0036 closes it by also requiring the candidate block's own
-- organization_id to match p_company_id's Organization.
--
-- Fix round (owner's ruling, 2026-07-29): the identical gap was live in
-- is_member_blocked (0032) itself — 0036 supersedes that function's body too
-- (see 0036's "is_member_blocked (0032) superseded" section). single_block_probe,
-- below, mirrors bulk_block_probe's two Organization-boundary assertions for
-- the single-row function. Its own grant grid (two lines) sits beside
-- members_blocked_bulk's below, restated in 0036 per 0030's precedent rather
-- than left to CREATE OR REPLACE's silent ACL preservation.
--
-- Second fix round (owner's ruling, 2026-07-29): even Organization-scoped, a
-- caller holding members.view at one Station could still learn the block
-- status of any Member in their OWN Organization, including one linked only
-- to a Station they cannot reach — closed in both functions by requiring
-- public.member_reachable (0033). "Blocked At Station F2 Only" and
-- "Org-Wide Blocked But Unreachable" (Station F2, below) exercise this and
-- the review's separate coverage-gap finding: no existing fixture had a
-- Station-scoped block at a DIFFERENT Station in the same Organization, so
-- dropping the (b.company_id is null or b.company_id = p_company_id) term
-- entirely would have passed every assertion that existed before this round.
select is(
  (select count(*)::int from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'members_blocked_bulk'),
  1,
  'members_blocked_bulk exists'
);
select is(
  (select p.prosecdef from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'members_blocked_bulk'),
  true,
  'members_blocked_bulk is security definer, so its own caller guard is what protects it'
);
select ok(
  has_function_privilege('authenticated', 'public.members_blocked_bulk(uuid[], uuid)', 'execute'),
  'authenticated may execute members_blocked_bulk'
);
select ok(
  not has_function_privilege('anon', 'public.members_blocked_bulk(uuid[], uuid)', 'execute'),
  'anon may not execute members_blocked_bulk'
);

-- is_member_blocked's own grant grid, mirroring the two lines above: 0036
-- restates 0032's revoke/grant (Important 1, review round 2) rather than
-- relying on CREATE OR REPLACE's silent ACL preservation with nothing behind
-- it in the suite -- before this, no grant assertion for is_member_blocked
-- existed anywhere, before or after 0036.
select ok(
  has_function_privilege('authenticated', 'public.is_member_blocked(uuid, uuid)', 'execute'),
  'authenticated may execute is_member_blocked'
);
select ok(
  not has_function_privilege('anon', 'public.is_member_blocked(uuid, uuid)', 'execute'),
  'anon may not execute is_member_blocked'
);

select has_index('public', 'members', 'members_created_at_idx',
  'the audience list can sort by registration date without a full scan');
select has_index('public', 'members', 'members_birth_date_idx',
  'the age filter can use a birth_date range without a full scan');

-- Fixtures. Org F is the caller's own Organization; Org G exists only to hold
-- a Member the caller has no relationship to at all, for the cross-Organization
-- probe below.
insert into public.organizations (id, name) values
  ('ffffffff-0000-0000-0000-000000000001', 'Bulk Block Test Org F'),
  ('beefbeef-0000-0000-0000-000000000001', 'Bulk Block Test Org G');
insert into public.companies (id, organization_id, name) values
  ('ffffffff-0000-0000-0000-000000000002', 'ffffffff-0000-0000-0000-000000000001', 'Station F1');
insert into public.roles (id, organization_id, name) values
  ('ffffffff-0000-0000-0000-000000000003', 'ffffffff-0000-0000-0000-000000000001', 'F Viewer');
insert into public.role_permissions (role_id, permission_code) values
  ('ffffffff-0000-0000-0000-000000000003', 'members.view');
insert into auth.users (id, email) values
  ('ffffffff-0000-0000-0000-000000000004', 'bulk-block-delegate@example.test'),
  ('ffffffff-0000-0000-0000-000000000005', 'bulk-block-no-access@example.test');
insert into public.company_memberships (user_id, company_id, organization_id, role_id) values
  ('ffffffff-0000-0000-0000-000000000004', 'ffffffff-0000-0000-0000-000000000002',
   'ffffffff-0000-0000-0000-000000000001', 'ffffffff-0000-0000-0000-000000000003');

insert into public.members (id, organization_id, full_name) values
  ('ffffffff-0000-0000-0000-000000000006', 'ffffffff-0000-0000-0000-000000000001', 'Blocked At Station F1'),
  ('ffffffff-0000-0000-0000-000000000007', 'ffffffff-0000-0000-0000-000000000001', 'Org-Wide Blocked In F'),
  ('ffffffff-0000-0000-0000-000000000008', 'ffffffff-0000-0000-0000-000000000001', 'Never Blocked In F');
insert into public.members (id, organization_id, full_name) values
  ('beefbeef-0000-0000-0000-000000000002', 'beefbeef-0000-0000-0000-000000000001', 'Org-Wide Blocked In G');

-- Linked to Station F1, so member_reachable (Important 2) actually admits
-- them for the delegate below -- without this, every "reads true" assertion
-- for these three would read false regardless of the block logic being
-- tested, for a reason that has nothing to do with what the assertion names
-- (review round 2's own fix surfaced this: these three had never been
-- linked to any Station at all before member_reachable started being
-- checked).
insert into public.member_company_links (member_id, company_id, organization_id) values
  ('ffffffff-0000-0000-0000-000000000006', 'ffffffff-0000-0000-0000-000000000002', 'ffffffff-0000-0000-0000-000000000001'),
  ('ffffffff-0000-0000-0000-000000000007', 'ffffffff-0000-0000-0000-000000000002', 'ffffffff-0000-0000-0000-000000000001'),
  ('ffffffff-0000-0000-0000-000000000008', 'ffffffff-0000-0000-0000-000000000002', 'ffffffff-0000-0000-0000-000000000001');

insert into public.member_blocks (id, organization_id, member_id, company_id, kind, reason) values
  ('ffffffff-0000-0000-0000-000000000009', 'ffffffff-0000-0000-0000-000000000001',
   'ffffffff-0000-0000-0000-000000000006', 'ffffffff-0000-0000-0000-000000000002', 'draw_ban', 'blocked at F1 specifically'),
  ('ffffffff-0000-0000-0000-00000000000a', 'ffffffff-0000-0000-0000-000000000001',
   'ffffffff-0000-0000-0000-000000000007', null, 'suspension', 'org-wide block, Org F');
-- The cross-Organization probe: an Organization-wide block that is real,
-- active, and entirely inside Org G — nothing about it names Org F or
-- Station F1.
insert into public.member_blocks (id, organization_id, member_id, company_id, kind, reason) values
  ('beefbeef-0000-0000-0000-000000000003', 'beefbeef-0000-0000-0000-000000000001',
   'beefbeef-0000-0000-0000-000000000002', null, 'suspension', 'org-wide block, Org G');

-- Station F2: a second Station in Org F the delegate (ffffffff-...0004) has
-- NO membership or role at -- unreachable to them, unlike Station F1.
insert into public.companies (id, organization_id, name) values
  ('ffffffff-0000-0000-0000-00000000000b', 'ffffffff-0000-0000-0000-000000000001', 'Station F2 (delegate cannot reach)');

-- Coverage-gap probe (review round 2): linked to F1, so reachable, but
-- blocked at F2 specifically -- a Station-scoped block at a DIFFERENT
-- Station in the SAME Organization. Isolates the (b.company_id is null or
-- b.company_id = p_company_id) term from the reachability term below: this
-- Member IS reachable, so a false result here can only come from the
-- company match, not from member_reachable.
--
-- Residual-oracle probe (review round 2, Important 2): linked ONLY to F2,
-- with an Organization-wide block -- before member_reachable was added, this
-- would have read true (same Organization, company_id is null bypasses the
-- Station check entirely). Linked to F2 rather than to nothing at all,
-- deliberately: the fix must refuse a Member reachable through NO permitted
-- link, not merely a Member with zero links.
insert into public.members (id, organization_id, full_name) values
  ('ffffffff-0000-0000-0000-00000000000c', 'ffffffff-0000-0000-0000-000000000001', 'Blocked At Station F2 Only'),
  ('ffffffff-0000-0000-0000-00000000000d', 'ffffffff-0000-0000-0000-000000000001', 'Org-Wide Blocked But Unreachable');

insert into public.member_company_links (member_id, company_id, organization_id) values
  ('ffffffff-0000-0000-0000-00000000000c', 'ffffffff-0000-0000-0000-000000000002', 'ffffffff-0000-0000-0000-000000000001'),
  ('ffffffff-0000-0000-0000-00000000000d', 'ffffffff-0000-0000-0000-00000000000b', 'ffffffff-0000-0000-0000-000000000001');

insert into public.member_blocks (id, organization_id, member_id, company_id, kind, reason) values
  ('ffffffff-0000-0000-0000-00000000000e', 'ffffffff-0000-0000-0000-000000000001',
   'ffffffff-0000-0000-0000-00000000000c', 'ffffffff-0000-0000-0000-00000000000b', 'draw_ban', 'blocked at F2, a different Station in the same Organization'),
  ('ffffffff-0000-0000-0000-00000000000f', 'ffffffff-0000-0000-0000-000000000001',
   'ffffffff-0000-0000-0000-00000000000d', null, 'suspension', 'org-wide block on a Member linked only to a Station the caller cannot reach');

set local role authenticated;
set local request.jwt.claims = '{"sub": "ffffffff-0000-0000-0000-000000000004", "role": "authenticated"}';

create temporary table bulk_block_probe as
select * from public.members_blocked_bulk(
  array['ffffffff-0000-0000-0000-000000000006'::uuid,  -- Station-scoped block, real, at the queried Station
        'ffffffff-0000-0000-0000-000000000007'::uuid,  -- Org-wide block, real (same Org), reachable
        'ffffffff-0000-0000-0000-000000000008'::uuid,  -- never blocked
        'beefbeef-0000-0000-0000-000000000002'::uuid,  -- Org-wide block, but a DIFFERENT Organization
        'ffffffff-0000-0000-0000-00000000000c'::uuid,  -- Station-scoped block at a DIFFERENT Station, same Organization
        'ffffffff-0000-0000-0000-00000000000d'::uuid], -- Org-wide block, same Organization, but unreachable
  'ffffffff-0000-0000-0000-000000000002'
);

create temporary table bulk_block_duplicate_probe as
select * from public.members_blocked_bulk(
  array['ffffffff-0000-0000-0000-000000000006'::uuid, 'ffffffff-0000-0000-0000-000000000006'::uuid],
  'ffffffff-0000-0000-0000-000000000002'
);

create temporary table bulk_block_empty_probe as
select * from public.members_blocked_bulk(
  '{}'::uuid[],
  'ffffffff-0000-0000-0000-000000000002'
);

create temporary table bulk_block_null_probe as
select * from public.members_blocked_bulk(
  null::uuid[],
  'ffffffff-0000-0000-0000-000000000002'
);

-- Fix round (owner's ruling, 2026-07-29): is_member_blocked (0032) carried
-- the identical cross-Organization gap, now closed in 0036 alongside its
-- bulk twin. Same two fixtures as bulk_block_probe above -- an Organization-
-- wide block inside the caller's own Organization, and one entirely inside
-- a DIFFERENT Organization -- reused rather than re-inserted.
create temporary table single_block_probe as
select
  public.is_member_blocked('ffffffff-0000-0000-0000-000000000007', 'ffffffff-0000-0000-0000-000000000002') as own_org_block,
  public.is_member_blocked('beefbeef-0000-0000-0000-000000000002', 'ffffffff-0000-0000-0000-000000000002') as cross_org_block,
  public.is_member_blocked('ffffffff-0000-0000-0000-00000000000c', 'ffffffff-0000-0000-0000-000000000002') as wrong_station_block,
  public.is_member_blocked('ffffffff-0000-0000-0000-00000000000d', 'ffffffff-0000-0000-0000-000000000002') as unreachable_block;

reset role;

select is(
  (select blocked from bulk_block_probe where member_id = 'ffffffff-0000-0000-0000-000000000006'),
  true,
  'a Station-scoped block at the queried Station reports blocked = true'
);
select is(
  (select blocked from bulk_block_probe where member_id = 'ffffffff-0000-0000-0000-000000000007'),
  true,
  'an Organization-wide block on a Member of the CALLER''s own Organization still reports blocked = true'
);
select is(
  (select blocked from bulk_block_probe where member_id = 'ffffffff-0000-0000-0000-000000000008'),
  false,
  'a Member with no block at all reports blocked = false'
);
select is(
  (select blocked from bulk_block_probe where member_id = 'beefbeef-0000-0000-0000-000000000002'),
  false,
  'an Organization-wide block belonging to a DIFFERENT Organization does not leak as blocked = true — Task 3 review, the defect closed by 0036''s organization_id filter'
);
select is(
  (select blocked from bulk_block_probe where member_id = 'ffffffff-0000-0000-0000-00000000000c'),
  false,
  'a Station-scoped block at a DIFFERENT Station in the same Organization does not leak as blocked = true at the queried Station -- review round 2''s coverage-gap finding: no prior fixture exercised this, so dropping the company_id match term entirely would have passed every earlier assertion'
);
select is(
  (select blocked from bulk_block_probe where member_id = 'ffffffff-0000-0000-0000-00000000000d'),
  false,
  'an Organization-wide block on a Member the caller cannot reach (linked only to a Station they hold no permission at) reads false -- Important 2, the residual intra-Organization oracle closed by member_reachable'
);
select is(
  (select count(*)::int from bulk_block_probe),
  6,
  'one row per input id, six ids in, six rows out'
);

select is(
  (select count(*)::int from bulk_block_duplicate_probe),
  2,
  'unnest preserves duplicates: the same id passed twice yields two rows, not one'
);
select is(
  (select count(*)::int from bulk_block_duplicate_probe where blocked = true),
  2,
  'both duplicate rows agree on the same, correct blocked value'
);

select is(
  (select count(*)::int from bulk_block_empty_probe),
  0,
  'an empty array yields zero rows rather than an error, for a caller who does hold members.view at the Station'
);
select is(
  (select count(*)::int from bulk_block_null_probe),
  0,
  'a null array yields zero rows the same as an empty array, rather than an error'
);

select is(
  (select own_org_block from single_block_probe),
  true,
  'is_member_blocked: an Organization-wide block on a Member of the caller''s own Organization reads true (0036 supersedes 0032)'
);
select is(
  (select cross_org_block from single_block_probe),
  false,
  'is_member_blocked: an Organization-wide block belonging to a DIFFERENT Organization does not leak as true -- the same fix as members_blocked_bulk, now applied to the single-row function (0036 supersedes 0032)'
);
select is(
  (select wrong_station_block from single_block_probe),
  false,
  'is_member_blocked: a Station-scoped block at a DIFFERENT Station in the same Organization does not leak as true -- same coverage-gap fix as members_blocked_bulk'
);
select is(
  (select unreachable_block from single_block_probe),
  false,
  'is_member_blocked: an Organization-wide block on a Member the caller cannot reach reads false -- Important 2, applied to the single-row function too'
);

set local role authenticated;
set local request.jwt.claims = '{"sub": "ffffffff-0000-0000-0000-000000000005", "role": "authenticated"}';

select throws_ok(
  $$select * from public.members_blocked_bulk(
      array['ffffffff-0000-0000-0000-000000000006'::uuid], 'ffffffff-0000-0000-0000-000000000002')$$,
  '42501',
  'permission denied: members.view required',
  'a caller holding no permission at all at the queried Station is refused, even for a batch of one'
);

reset role;

select * from finish();
rollback;
