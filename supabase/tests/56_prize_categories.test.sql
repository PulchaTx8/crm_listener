begin;
select plan(27);

-- Block 26. Prize categories get a screen, and with it the two doors every other
-- record on this product has. 0025 built the table and 0029 secured it; what is
-- new here is 0202's save/archive pair and the insert-only door it replaces.

-- Structure -------------------------------------------------------------------

select has_function('public', 'save_prize_category', array['uuid', 'text', 'uuid'],
                    'the register-or-rename door exists');
select has_function('public', 'archive_prize_category', array['uuid'],
                    'the archive door exists');

-- ONE DOOR WHERE THERE WAS ONE. 0027's insert-only create_prize_category was
-- replaced rather than left beside its replacement: two doors onto the same
-- write is how two callers drift into disagreeing about what a name may be.
select hasnt_function('public', 'create_prize_category', array['uuid', 'text'],
                      'the insert-only door it replaces is gone');

select ok(
  has_function_privilege('authenticated', 'public.save_prize_category(uuid,text,uuid)', 'execute'),
  'authenticated may register a category');
select ok(
  has_function_privilege('authenticated', 'public.archive_prize_category(uuid)', 'execute'),
  'authenticated may archive a category');
-- `revoke ... from public` is what makes these two false; without it the default
-- ACL would leave every role holding execute, anon included.
select ok(
  not has_function_privilege('anon', 'public.save_prize_category(uuid,text,uuid)', 'execute'),
  'anon may not register a category');
select ok(
  not has_function_privilege('anon', 'public.archive_prize_category(uuid)', 'execute'),
  'anon may not archive a category');

-- No new permission was invented (0199 already widened this description to name
-- categories, and the roles screen reads the column directly).
select ok(
  (select description like '%categories%' from public.permissions
    where code = 'inventory.catalogue'),
  'inventory.catalogue says it covers categories');

-- Fixtures ---------------------------------------------------------------------

insert into public.organizations (id, name) values
  ('00000000-0000-0000-0000-0000000026f9', 'Org 26 categories');
insert into public.companies (id, organization_id, name, timezone) values
  ('00000000-0000-0000-0000-0000000026ca', '00000000-0000-0000-0000-0000000026f9',
   'Station 26 A', 'America/Sao_Paulo'),
  ('00000000-0000-0000-0000-0000000026cb', '00000000-0000-0000-0000-0000000026f9',
   'Station 26 B', 'America/Sao_Paulo');

insert into public.prize_categories (id, organization_id, company_id, name) values
  ('00000000-0000-0000-0000-0000000026b1', '00000000-0000-0000-0000-0000000026f9',
   '00000000-0000-0000-0000-0000000026ca', 'Camisetas'),
  -- A category of the OTHER Station, for the cross-Station refusal below.
  ('00000000-0000-0000-0000-0000000026b2', '00000000-0000-0000-0000-0000000026f9',
   '00000000-0000-0000-0000-0000000026cb', 'Canecas da B');

-- Two live prizes wearing the label, and one archived one. The archived prize is
-- the whole point of the last assertion in this file.
insert into public.prizes (id, organization_id, company_id, category_id, name) values
  ('00000000-0000-0000-0000-0000000026da', '00000000-0000-0000-0000-0000000026f9',
   '00000000-0000-0000-0000-0000000026ca', '00000000-0000-0000-0000-0000000026b1', 'Camiseta P'),
  ('00000000-0000-0000-0000-0000000026db', '00000000-0000-0000-0000-0000000026f9',
   '00000000-0000-0000-0000-0000000026ca', '00000000-0000-0000-0000-0000000026b1', 'Camiseta M');
insert into public.prizes (id, organization_id, company_id, category_id, name, deleted_at) values
  ('00000000-0000-0000-0000-0000000026dc', '00000000-0000-0000-0000-0000000026f9',
   '00000000-0000-0000-0000-0000000026ca', '00000000-0000-0000-0000-0000000026b1',
   'Camiseta G', now());

-- Table rules ------------------------------------------------------------------

-- Case-insensitive, because "camisetas" and "Camisetas" are one grouping and the
-- operator about to create the second is best placed to notice.
select throws_ok(
  $$insert into public.prize_categories (organization_id, company_id, name)
    values ('00000000-0000-0000-0000-0000000026f9','00000000-0000-0000-0000-0000000026ca',
            'camisetas')$$,
  '23505', null, 'a second live category of the same name in one Station is refused');

-- The same name in ANOTHER Station is a different grouping.
prepare same_name_other_station as
  insert into public.prize_categories (organization_id, company_id, name) values
    ('00000000-0000-0000-0000-0000000026f9', '00000000-0000-0000-0000-0000000026cb', 'Camisetas');
select lives_ok('same_name_other_station', 'the same name in another Station is legal');

-- The callers ------------------------------------------------------------------

insert into public.roles (id, organization_id, name) values
  ('00000000-0000-0000-0000-000000002651', '00000000-0000-0000-0000-0000000026f9', 'Cataloguer 26');
insert into public.role_permissions (role_id, permission_code) values
  ('00000000-0000-0000-0000-000000002651', 'inventory.catalogue'),
  -- inventory.view too: without it, 0029's select policies would cut every read
  -- below through this role's own connection, and this suite would report a
  -- correct row as absent.
  ('00000000-0000-0000-0000-000000002651', 'inventory.view');
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-000000002652', 'categories-26@example.test');
insert into public.company_memberships (user_id, company_id, organization_id, role_id) values
  ('00000000-0000-0000-0000-000000002652', '00000000-0000-0000-0000-0000000026ca',
   '00000000-0000-0000-0000-0000000026f9', '00000000-0000-0000-0000-000000002651');

-- A reader of the same Station, for the two 42501s.
insert into public.roles (id, organization_id, name) values
  ('00000000-0000-0000-0000-000000002653', '00000000-0000-0000-0000-0000000026f9', 'Looker 26');
insert into public.role_permissions (role_id, permission_code) values
  ('00000000-0000-0000-0000-000000002653', 'inventory.view');
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-000000002654', 'categories-reader-26@example.test');
insert into public.company_memberships (user_id, company_id, organization_id, role_id) values
  ('00000000-0000-0000-0000-000000002654', '00000000-0000-0000-0000-0000000026ca',
   '00000000-0000-0000-0000-0000000026f9', '00000000-0000-0000-0000-000000002653');

set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-000000002654", "role": "authenticated"}';

-- The read gate, and the two write gates ---------------------------------------

select is(
  (select count(*)::int from public.prize_categories
    where company_id = '00000000-0000-0000-0000-0000000026ca'),
  1, 'inventory.view reads this Station''s categories');

-- The policy is company-scoped, so the other Station's categories are invisible
-- even though they belong to the same Organization.
select is(
  (select count(*)::int from public.prize_categories
    where company_id = '00000000-0000-0000-0000-0000000026cb'),
  0, 'and none of another Station''s, even inside one Organization');

select throws_ok(
  $$select public.save_prize_category('00000000-0000-0000-0000-0000000026ca', 'Nova')$$,
  '42501', null, 'inventory.view alone cannot register a category');

select throws_ok(
  $$select public.archive_prize_category('00000000-0000-0000-0000-0000000026b1')$$,
  '42501', null, 'inventory.view alone cannot archive a category');

set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-000000002652", "role": "authenticated"}';

-- The door's own rules -----------------------------------------------------------

select throws_ok(
  $$select public.save_prize_category('00000000-0000-0000-0000-0000000026ca', '   ')$$,
  '22023', null, 'a blank name is refused by the door as a sentence');

-- The column is unbounded `text`, so the bound is the door's rather than the
-- schema's: a caller posting straight at the RPC never sees the form's maxLength.
select throws_ok(
  $$select public.save_prize_category('00000000-0000-0000-0000-0000000026ca', repeat('a', 121))$$,
  '22023', null, 'a name over 120 characters is refused');

create temporary table t26_cat as
select public.save_prize_category(
  '00000000-0000-0000-0000-0000000026ca', 'Brindes Norte') as category_id;

select ok(
  (select name = 'Brindes Norte' from public.prize_categories
    where id = (select category_id from t26_cat)),
  'save_prize_category registers a category under the name it was given');

-- The index's message names an index; the door's names a category.
select throws_ok(
  $$select public.save_prize_category('00000000-0000-0000-0000-0000000026ca', 'camisetas')$$,
  '23505', null, 'a name another live category already has is refused as a sentence');

select public.save_prize_category(
  '00000000-0000-0000-0000-0000000026ca', 'Brindes do Norte',
  p_category_id => (select category_id from t26_cat));
select is(
  (select name from public.prize_categories where id = (select category_id from t26_cat)),
  'Brindes do Norte',
  'naming the id renames that category rather than registering a second one');

select throws_ok(
  $$select public.save_prize_category('00000000-0000-0000-0000-0000000026ca', 'Camisetas',
      p_category_id => (select category_id from t26_cat))$$,
  '23505', null, 'a rename onto another live category''s name is refused');

-- Tenancy on the edit path: a caller-supplied uuid naming another Station's
-- category must not match, even though this caller holds the permission in their
-- own Station.
select throws_ok(
  $$select public.save_prize_category('00000000-0000-0000-0000-0000000026ca', 'Sequestrada',
      p_category_id => '00000000-0000-0000-0000-0000000026b2')$$,
  'P0002', null, 'an edit cannot reach another Station''s category');

-- Archiving --------------------------------------------------------------------

-- THE PRIZES ARE DETACHED, unlike archive_vendor's entries: a movement's
-- supplier is history, a category is a label the screens resolve from the live
-- list. The return value is the number the confirmation dialog warned about.
select is(
  public.archive_prize_category('00000000-0000-0000-0000-0000000026b1'),
  2, 'archiving reports how many live prizes it took the label off');

select is(
  (select count(*)::int from public.prizes
    where category_id = '00000000-0000-0000-0000-0000000026b1'),
  0, 'and the live prizes are uncategorised afterwards');

select throws_ok(
  $$select public.archive_prize_category('00000000-0000-0000-0000-0000000026b1')$$,
  'P0002', null, 'archiving an already-archived category is P0002');

select throws_ok(
  $$select public.save_prize_category('00000000-0000-0000-0000-0000000026ca', 'Camisetas de Novo',
      p_category_id => '00000000-0000-0000-0000-0000000026b1')$$,
  'P0002', null, 'an archived category cannot be renamed');

-- And the name is free again, which is what the partial index buys.
select lives_ok(
  $$select public.save_prize_category('00000000-0000-0000-0000-0000000026ca', 'Camisetas')$$,
  'archiving frees the name for a new category');

reset role;

-- Asserted as the owner because the caller above cannot see it: 0029's policy
-- filters `deleted_at`, so an archived prize is unreadable through RLS for
-- everyone. Its label is deliberately left alone — rewriting a row nobody can
-- observe buys nothing, and the count the operator was warned about counts what
-- the list shows.
select is(
  (select category_id from public.prizes
    where id = '00000000-0000-0000-0000-0000000026dc'),
  '00000000-0000-0000-0000-0000000026b1'::uuid,
  'an archived prize keeps the label, which no ordinary read can reach anyway');

select * from finish();
rollback;
