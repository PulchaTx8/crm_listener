begin;
select plan(31);

-- Block 24, items 7 and 8. The vendors table, its two doors, and the column
-- that puts a supplier on a stock entry.

-- Structure ------------------------------------------------------------------

select has_table('public', 'vendors', 'vendors exists');
select has_column('public', 'inventory_movements', 'vendor_id',
                  'a movement can name the supplier it came from');

select is(relrowsecurity, true, 'RLS enabled on vendors')
  from pg_class where oid = 'public.vendors'::regclass;

-- Every write goes through a SECURITY DEFINER RPC. A grant here would be a
-- second, unaudited way to rewrite a Station's supplier list.
select ok(not has_table_privilege('authenticated', 'public.vendors', 'INSERT'),
          'authenticated may not insert a vendor directly');
select ok(not has_table_privilege('authenticated', 'public.vendors', 'UPDATE'),
          'authenticated may not update a vendor directly');
select ok(not has_table_privilege('service_role', 'public.vendors', 'DELETE'),
          'service_role may not delete a vendor directly');
-- 0029 and 0099 each had to close this after the fact. Asserted here so it
-- cannot be reopened quietly: `revoke all` never runs against service_role, so
-- the default ACL's TRUNCATE survives unless a migration says otherwise.
select ok(not has_table_privilege('service_role', 'public.vendors', 'TRUNCATE'),
          'service_role may not truncate the supplier list');

-- NO NEW PERMISSION (design D6). A vendors.* pair would be a permissions
-- migration plus every role a customer has already configured, none of which
-- would grant it — so the screen would be hidden from everybody.
select is(
  (select count(*)::int from public.permissions where code like 'vendors.%'),
  0, 'no vendor permission was invented');
select is(
  (select count(*)::int from public.permissions where module = 'inventory'),
  6, 'the six inventory permissions are unchanged');
-- The catalogue permission now covers one more kind of record, and the roles
-- screen reads this column directly.
select ok(
  (select description like '%vendors%' from public.permissions
    where code = 'inventory.catalogue'),
  'inventory.catalogue says it covers vendors');

-- Fixtures -------------------------------------------------------------------

insert into public.organizations (id, name) values
  ('00000000-0000-0000-0000-0000000024f9', 'Org 24 vendors');
insert into public.companies (id, organization_id, name, timezone) values
  ('00000000-0000-0000-0000-0000000024ca', '00000000-0000-0000-0000-0000000024f9',
   'Station 24 A', 'America/Sao_Paulo'),
  ('00000000-0000-0000-0000-0000000024cb', '00000000-0000-0000-0000-0000000024f9',
   'Station 24 B', 'America/Sao_Paulo');
insert into public.prizes (id, organization_id, company_id, name) values
  ('00000000-0000-0000-0000-0000000024da', '00000000-0000-0000-0000-0000000024f9',
   '00000000-0000-0000-0000-0000000024ca', 'Camiseta 24');

-- A vendor of the OTHER Station, for the cross-Station refusals below.
insert into public.vendors (id, organization_id, company_id, name) values
  ('00000000-0000-0000-0000-0000000024b2', '00000000-0000-0000-0000-0000000024f9',
   '00000000-0000-0000-0000-0000000024cb', 'Fornecedor da Station B');

-- Table rules ------------------------------------------------------------------

select throws_ok(
  $$insert into public.vendors (organization_id, company_id, name)
    values ('00000000-0000-0000-0000-0000000024f9','00000000-0000-0000-0000-0000000024ca','   ')$$,
  '23514', null, 'a blank name is refused');

prepare vendor_one as
  insert into public.vendors (id, organization_id, company_id, name) values
    ('00000000-0000-0000-0000-0000000024b1', '00000000-0000-0000-0000-0000000024f9',
     '00000000-0000-0000-0000-0000000024ca', 'Camisetas do Sul');
select lives_ok('vendor_one', 'a vendor with only a name is legal');

-- Case-insensitive, because "camisetas do sul" and "Camisetas do Sul" are one
-- supplier and the operator about to create the second is best placed to notice.
select throws_ok(
  $$insert into public.vendors (organization_id, company_id, name)
    values ('00000000-0000-0000-0000-0000000024f9','00000000-0000-0000-0000-0000000024ca',
            'camisetas do sul')$$,
  '23505', null, 'a second live vendor of the same name in one Station is refused');

-- The same name in ANOTHER Station is a different supplier relationship.
prepare same_name_other_station as
  insert into public.vendors (organization_id, company_id, name) values
    ('00000000-0000-0000-0000-0000000024f9', '00000000-0000-0000-0000-0000000024cb',
     'Camisetas do Sul');
select lives_ok('same_name_other_station', 'the same name in another Station is legal');

-- The movement column's shape ---------------------------------------------------

select throws_ok(
  $$insert into public.inventory_movements
      (organization_id, company_id, prize_id, movement_type, quantity,
       from_bucket, to_bucket, vendor_id)
    values ('00000000-0000-0000-0000-0000000024f9','00000000-0000-0000-0000-0000000024ca',
            '00000000-0000-0000-0000-0000000024da','MANUAL_EXIT', 1, 'available', null,
            '00000000-0000-0000-0000-0000000024b1')$$,
  '23514', null, 'an exit may not name a supplier');

prepare entry_with_vendor as
  insert into public.inventory_movements
    (organization_id, company_id, prize_id, movement_type, quantity,
     from_bucket, to_bucket, vendor_id)
  values ('00000000-0000-0000-0000-0000000024f9','00000000-0000-0000-0000-0000000024ca',
          '00000000-0000-0000-0000-0000000024da','PURCHASE_ENTRY', 3, null, 'available',
          '00000000-0000-0000-0000-0000000024b1');
select lives_ok('entry_with_vendor', 'a purchase entry may name a supplier');

-- The composite key, which is what makes a cross-Station pointer impossible
-- rather than merely unlikely.
select throws_ok(
  $$insert into public.inventory_movements
      (organization_id, company_id, prize_id, movement_type, quantity,
       from_bucket, to_bucket, vendor_id)
    values ('00000000-0000-0000-0000-0000000024f9','00000000-0000-0000-0000-0000000024ca',
            '00000000-0000-0000-0000-0000000024da','PURCHASE_ENTRY', 1, null, 'available',
            '00000000-0000-0000-0000-0000000024b2')$$,
  '23503', null, 'a movement cannot name another Station''s supplier');

-- The caller ------------------------------------------------------------------

insert into public.roles (id, organization_id, name) values
  ('00000000-0000-0000-0000-000000002451', '00000000-0000-0000-0000-0000000024f9', 'Buyer 24');
insert into public.role_permissions (role_id, permission_code) values
  ('00000000-0000-0000-0000-000000002451', 'inventory.catalogue'),
  ('00000000-0000-0000-0000-000000002451', 'inventory.entry'),
  -- inventory.view too: without it, 0198's select policy and 0029's would cut
  -- every read below through this role's own connection, and this suite would
  -- report a correct row as absent.
  ('00000000-0000-0000-0000-000000002451', 'inventory.view');
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-000000002452', 'vendors-24@example.test');
insert into public.company_memberships (user_id, company_id, organization_id, role_id) values
  ('00000000-0000-0000-0000-000000002452', '00000000-0000-0000-0000-0000000024ca',
   '00000000-0000-0000-0000-0000000024f9', '00000000-0000-0000-0000-000000002451');

-- A reader of the same Station, for the two 42501s.
insert into public.roles (id, organization_id, name) values
  ('00000000-0000-0000-0000-000000002453', '00000000-0000-0000-0000-0000000024f9', 'Looker 24');
insert into public.role_permissions (role_id, permission_code) values
  ('00000000-0000-0000-0000-000000002453', 'inventory.view');
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-000000002454', 'vendors-reader-24@example.test');
insert into public.company_memberships (user_id, company_id, organization_id, role_id) values
  ('00000000-0000-0000-0000-000000002454', '00000000-0000-0000-0000-0000000024ca',
   '00000000-0000-0000-0000-0000000024f9', '00000000-0000-0000-0000-000000002453');

set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-000000002454", "role": "authenticated"}';

-- The read gate, and the two write gates ---------------------------------------

select is(
  (select count(*)::int from public.vendors
    where company_id = '00000000-0000-0000-0000-0000000024ca'),
  1, 'inventory.view reads this Station''s suppliers');

-- The policy is company-scoped, so the other Station's supplier is invisible
-- even though it belongs to the same Organization.
select is(
  (select count(*)::int from public.vendors
    where company_id = '00000000-0000-0000-0000-0000000024cb'),
  0, 'and none of another Station''s, even inside one Organization');

select throws_ok(
  $$select public.save_vendor('00000000-0000-0000-0000-0000000024ca', 'Novo Fornecedor')$$,
  '42501', null, 'inventory.view alone cannot register a supplier');

select throws_ok(
  $$select public.archive_vendor('00000000-0000-0000-0000-0000000024b1')$$,
  '42501', null, 'inventory.view alone cannot archive a supplier');

set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-000000002452", "role": "authenticated"}';

select throws_ok(
  $$select public.save_vendor('00000000-0000-0000-0000-0000000024ca', '   ')$$,
  '22023', null, 'a blank name is refused by the door as a sentence');

create temporary table t24_vendor as
select public.save_vendor(
  '00000000-0000-0000-0000-0000000024ca', 'Brindes Norte', 'Brindes Norte LTDA',
  '12.345.678/0001-90', 'Marina', '+55 11 90000-0000', 'compras@brindesnorte.test',
  'Rua das Flores, 100', 'São Paulo', 'SP', '01000-000', 'https://brindesnorte.test',
  'Prazo de 30 dias.') as vendor_id;

select ok(
  (select legal_name = 'Brindes Norte LTDA'
      and document = '12.345.678/0001-90'
      and contact_name = 'Marina'
      and city = 'São Paulo'
      and website = 'https://brindesnorte.test'
     from public.vendors where id = (select vendor_id from t24_vendor)),
  'save_vendor stores every field it was given');

-- The wholesale replace: a box the operator cleared is cleared, not kept. A
-- door that merged instead would leave a supplier carrying a phone number
-- nobody can reach.
select public.save_vendor(
  '00000000-0000-0000-0000-0000000024ca', 'Brindes Norte',
  p_vendor_id => (select vendor_id from t24_vendor));
select ok(
  (select legal_name is null and document is null and phone is null and city is null
     from public.vendors where id = (select vendor_id from t24_vendor)),
  'an edit that omits a field clears it rather than keeping the old value');

-- Tenancy on the edit path: a caller-supplied uuid naming another Station's
-- vendor must not match, even though this caller holds the permission in their
-- own Station.
select throws_ok(
  $$select public.save_vendor('00000000-0000-0000-0000-0000000024ca', 'Sequestrado',
      p_vendor_id => '00000000-0000-0000-0000-0000000024b2')$$,
  'P0002', null, 'an edit cannot reach another Station''s supplier');

-- record_stock_entry ------------------------------------------------------------

create temporary table t24_entry as
select public.record_stock_entry(
  '00000000-0000-0000-0000-0000000024ca', '00000000-0000-0000-0000-0000000024da',
  'PURCHASE_ENTRY', 10, 'first purchase', null,
  'NF-2401', 5.00, 50.00,
  (select vendor_id from t24_vendor)) as movement_id;

select is(
  (select vendor_id from public.inventory_movements
    where id = (select movement_id from t24_entry)),
  (select vendor_id from t24_vendor),
  'record_stock_entry threads the supplier onto the movement');

-- The foreign key would give this a constraint name; the door gives it a
-- sentence.
select throws_ok(
  $$select public.record_stock_entry(
      '00000000-0000-0000-0000-0000000024ca', '00000000-0000-0000-0000-0000000024da',
      'PURCHASE_ENTRY', 1, null, null, null, null, null,
      '00000000-0000-0000-0000-0000000024b2')$$,
  '22023', null, 'an entry naming another Station''s supplier is refused as a sentence');

-- THE ONE THE FOREIGN KEY CANNOT CATCH. vendors_id_company_unique is
-- non-partial — a foreign key cannot reference a partial index — so it cannot
-- see deleted_at, and an archived supplier would be accepted silently.
select public.archive_vendor((select vendor_id from t24_vendor));
select throws_ok(
  $$select public.record_stock_entry(
      '00000000-0000-0000-0000-0000000024ca', '00000000-0000-0000-0000-0000000024da',
      'PURCHASE_ENTRY', 1, null, null, null, null, null,
      (select vendor_id from t24_vendor))$$,
  '22023', null, 'an entry naming an ARCHIVED supplier is refused');

-- Archiving twice: the second call cannot find the row, because 0198's policy
-- hides it from every ordinary read too.
select throws_ok(
  $$select public.archive_vendor((select vendor_id from t24_vendor))$$,
  'P0002', null, 'archiving an already-archived supplier is P0002');

-- ARCHIVING NEVER REWRITES HISTORY. The entry recorded above still names the
-- supplier, and list_movements still reports the name — the join is deliberately
-- unfiltered by deleted_at, because a purchase from a supplier the Station has
-- stopped using is a fact that outlives the relationship.
select is(
  (select vendor_name from public.list_movements(
     '00000000-0000-0000-0000-0000000024ca', p_prize_id => '00000000-0000-0000-0000-0000000024da')
    where movement_id = (select movement_id from t24_entry)),
  'Brindes Norte',
  'an archived supplier still names the entries it supplied');

-- And the name is free again, which is what the partial index buys.
select lives_ok(
  $$select public.save_vendor('00000000-0000-0000-0000-0000000024ca', 'Brindes Norte')$$,
  'archiving frees the name for a new supplier record');

reset role;

select * from finish();
rollback;
