begin;
select plan(26);

-- Block 16. The Organization stops being a name nobody can see or edit.

select has_column('public', 'organizations', 'tax_id', 'an organization can carry a CNPJ');
select has_column('public', 'organizations', 'billing_entity', 'and say who issues the invoice');
select has_column('public', 'organizations', 'suspended_at', 'and be blocked');

insert into public.organizations (id, name) values
  ('00000000-0000-0000-0000-0000000000f1', 'Org profile');

-- Design D7. The default is what is true today: nothing has ever been recorded
-- at the group level, so the group cannot be the emitter until somebody says so.
select is(
  (select billing_entity::text from public.organizations
    where id = '00000000-0000-0000-0000-0000000000f1'),
  'STATIONS', 'a new organization invoices per station until told otherwise');

-- Fourteen digits and nothing else. Punctuation is stripped before it arrives,
-- the way normalize_phone (0031) treats a telephone, so two people typing the
-- same company two different ways produce one value.
select throws_ok(
  $$update public.organizations set tax_id = '12.345.678/0001-99'
     where id = '00000000-0000-0000-0000-0000000000f1'$$,
  '23514', null, 'a CNPJ with punctuation is refused; the caller normalises it');

select lives_ok(
  $$update public.organizations set tax_id = '12345678000199'
     where id = '00000000-0000-0000-0000-0000000000f1'$$,
  'and fourteen bare digits are accepted');

-- The pair shape every archival column in this schema uses: a time AND a
-- person, or neither. A block with no author is a block nobody can be asked
-- about.
select throws_ok(
  $$update public.organizations set suspended_at = now()
     where id = '00000000-0000-0000-0000-0000000000f1'$$,
  '23514', null, 'a block with no author is refused');

-- ---------------------------------------------------------------------------
-- Block 16, Task 4. The Organization's own doors.
-- ---------------------------------------------------------------------------

select has_function('public', 'provision_organization', array['uuid', 'text'],
  'a group can be provisioned without a Station being invented for it');
select has_function('public', 'list_organizations',
  'and the console has one call that lists them');

-- Design D1. The old door created an Organization AND a Company in one breath,
-- so every group ever provisioned arrived with exactly one radio whether or not
-- that was true. Two provisioning doors, one of which creates a Station and one
-- of which does not, is a coin-flip waiting to be got wrong -- so the old one
-- goes rather than sitting beside its replacement.
select is(
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'provision_customer'),
  0::bigint,
  'the old two-in-one provisioning door is gone, not left beside its replacement');

-- No session yet, so is_platform_admin() is false and the gate is before the
-- work in all three.
select throws_ok(
  $$select public.provision_organization(
      '00000000-0000-0000-0000-0000000000f4', 'Nope')$$,
  '42501', null, 'provisioning a group requires the platform admin');
select throws_ok(
  $$select public.update_organization(
      '00000000-0000-0000-0000-0000000000f1', 'Nope')$$,
  '42501', null, 'editing one requires the platform admin');
select throws_ok(
  $$select * from public.list_organizations()$$,
  '42501', null, 'and so does listing them');

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000f3', 'console-admin@example.test'),
  ('00000000-0000-0000-0000-0000000000f4', 'console-owner@example.test');
insert into public.platform_admins (user_id) values
  ('00000000-0000-0000-0000-0000000000f3');
-- The auth user and its profile are created by services/provisioning.ts before
-- the RPC is reached; the RPC only flips the flags on a profile that is already
-- there, which is why it raises P0002 when one is not.
insert into public.profiles (id, email) values
  ('00000000-0000-0000-0000-0000000000f4', 'console-owner@example.test');

set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-0000000000f3", "role": "authenticated"}';

create temporary table provisioned as
select public.provision_organization(
  '00000000-0000-0000-0000-0000000000f4', '  Console Group  ') as id;

-- Captured BEFORE the edit below, and through the listing rather than the table:
-- this session is `authenticated`, so a direct read would go through RLS, and
-- list_organizations is the SECURITY DEFINER door the console reads by anyway.
create temporary table listed_as_provisioned as
select * from public.list_organizations();

-- Written wholesale, then written again with the trailing fields omitted, so
-- the second call proves the convention rather than the first one merely
-- appearing to work.
select public.update_organization(
  p_organization_id       => (select id from provisioned),
  p_name                  => 'Console Group Renamed',
  p_legal_name            => 'Console Group Ltda',
  p_tax_id                => '12345678000199',
  p_municipal_registration=> '11.222.333',
  p_fiscal_email          => 'fiscal@example.test',
  p_billing_entity        => 'ORGANIZATION',
  p_city                  => 'Sao Paulo',
  p_state                 => 'SP');

create temporary table listed as
select * from public.list_organizations();

reset role;

select is(
  (select count(*)::int from public.organizations where id = (select id from provisioned)),
  1, 'provisioning a group creates the group');

-- Design D1, and the whole reason this door replaced provision_customer.
select is(
  (select count(*)::int from public.companies
    where organization_id = (select id from provisioned)),
  0, 'and no Station, because how many radios a customer has is not known yet');

select is(
  (select name from listed_as_provisioned where id = (select id from provisioned)),
  'Console Group', 'the name arrives trimmed, not with the spaces somebody pasted');

select is(
  (select role::text from public.organization_memberships
    where organization_id = (select id from provisioned)),
  'owner', 'the person named becomes its owner');

-- The seven-day provisional window, carried over from provision_customer
-- unchanged: a password read over the telephone must expire.
select ok(
  (select must_change_password from public.profiles
    where id = '00000000-0000-0000-0000-0000000000f4'),
  'and must change the password they were read over the telephone');
select ok(
  (select provisional_expires_at > now() + interval '6 days' from public.profiles
    where id = '00000000-0000-0000-0000-0000000000f4'),
  'within a window that expires');

select is(
  (select legal_name from public.organizations where id = (select id from provisioned)),
  'Console Group Ltda', 'editing writes the invoicing identity');
select is(
  (select billing_entity::text from public.organizations
    where id = (select id from provisioned)),
  'ORGANIZATION', 'and the emitter selector');

select is(
  (select count(*)::int from listed where id = (select id from provisioned)),
  1, 'the listing carries the new group');
select is(
  (select station_count from listed where id = (select id from provisioned)),
  0::bigint, 'with no Stations counted under it');
select is(
  (select owner_email from listed where id = (select id from provisioned)),
  'console-owner@example.test', 'and the owner named, so a password can be reissued');

-- EVERY FIELD ON EVERY CALL, NEVER MERGED -- the convention update_prize,
-- update_song and update_company_profile all follow. A second save that omits
-- what the first one wrote must blank it, because the alternative is a per-field
-- guess about whether null means "unchanged" or "cleared".
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-0000000000f3", "role": "authenticated"}';
select public.update_organization((select id from provisioned), 'Console Group Renamed');
reset role;

select is(
  (select tax_id from public.organizations where id = (select id from provisioned)),
  null, 'a save that omits a field clears it, rather than merging silently');
select is(
  (select billing_entity::text from public.organizations
    where id = (select id from provisioned)),
  'STATIONS', 'and the selector returns to its default the same way');

select * from finish();
rollback;
