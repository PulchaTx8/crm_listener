begin;
select plan(11);

-- Block 19b, Task 1. The door the application presentation reads to draw its
-- header. Fixtures follow 39_widget_installations: one Organization, one
-- Station, one installation -- plus a second Organization/Station pair, because
-- four of the five refusals are produced by SWITCHING SOMETHING OFF, and doing
-- that to the live fixture would poison every assertion after it.

select has_function('public', 'widget_station_identity', array['text'],
  'the identity door exists');

insert into public.organizations (id, name) values
  ('00000000-0000-0000-0000-0000000001e1', 'Org identity');
insert into public.companies (id, organization_id, name, timezone, thumb_url) values
  ('00000000-0000-0000-0000-0000000001f1', '00000000-0000-0000-0000-0000000001e1',
   'Radio Identity', 'America/Sao_Paulo', 'https://example.test/thumb.png');
insert into public.widget_installations
  (id, organization_id, company_id, public_key, enabled)
values
  ('00000000-0000-0000-0000-000000001101',
   '00000000-0000-0000-0000-0000000001e1',
   '00000000-0000-0000-0000-0000000001f1', 'pw_identityaaaabbbbccccdd', true);
insert into public.integrations
  (id, organization_id, company_id, provider, phone_number_id, display_phone_number, enabled)
values
  ('00000000-0000-0000-0000-000000001201',
   '00000000-0000-0000-0000-0000000001e1',
   '00000000-0000-0000-0000-0000000001f1', 'WHATSAPP', '111222333', '+55 11 98888-7777', true);

select is(
  public.widget_station_identity('pw_identityaaaabbbbccccdd') ->> 'name',
  'Radio Identity', 'a live installation answers with the Station name');

select is(
  public.widget_station_identity('pw_identityaaaabbbbccccdd') ->> 'thumb_url',
  'https://example.test/thumb.png', 'and with the picture the console wrote');

select is(
  public.widget_station_identity('pw_identityaaaabbbbccccdd') ->> 'whatsapp_number',
  '+55 11 98888-7777', 'and with the number a listener wrote to');

-- REFUSAL 1 of 5. Each one is its own assertion on purpose: a single
-- "an unknown key is refused" test passes against a function that forgot all
-- four joins, which is exactly the defect 0164 was written to repair.
select is(
  public.widget_station_identity('pw_nosuchkeyaaaabbbbccccx') ->> 'found',
  'false', 'an unknown key is not found');

-- REFUSAL 2: the installation switched off.
update public.widget_installations set enabled = false
 where id = '00000000-0000-0000-0000-000000001101';
select is(
  public.widget_station_identity('pw_identityaaaabbbbccccdd') ->> 'found',
  'false', 'a disabled installation is not found');
update public.widget_installations set enabled = true
 where id = '00000000-0000-0000-0000-000000001101';

-- REFUSAL 3: the installation archived.
update public.widget_installations set deleted_at = now()
 where id = '00000000-0000-0000-0000-000000001101';
select is(
  public.widget_station_identity('pw_identityaaaabbbbccccdd') ->> 'found',
  'false', 'an archived installation is not found');
update public.widget_installations set deleted_at = null
 where id = '00000000-0000-0000-0000-000000001101';

-- REFUSAL 4: the Station suspended. This is 0164's whole reason for existing --
-- a Station suspended for non-payment went on being framed until somebody
-- disabled the installation by hand.
update public.companies set status = 'suspended'
 where id = '00000000-0000-0000-0000-0000000001f1';
select is(
  public.widget_station_identity('pw_identityaaaabbbbccccdd') ->> 'found',
  'false', 'a suspended Station is not found');
update public.companies set status = 'active'
 where id = '00000000-0000-0000-0000-0000000001f1';

-- REFUSAL 5: the Organization blocked. suspended_by travels with
-- suspended_at because organizations_block_shape (0154) requires the pair --
-- see 40_widget_verification's comment on this same constraint.
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-000000001301', 'identity-blocker@example.test');
update public.organizations
   set suspended_at      = now(),
       suspended_by      = '00000000-0000-0000-0000-000000001301',
       suspension_reason = 'blocked while the identity door was live'
 where id = '00000000-0000-0000-0000-0000000001e1';
select is(
  public.widget_station_identity('pw_identityaaaabbbbccccdd') ->> 'found',
  'false', 'a blocked Organization is not found');
update public.organizations
   set suspended_at = null, suspended_by = null, suspension_reason = null
 where id = '00000000-0000-0000-0000-0000000001e1';

-- A switched-off integration leaves the header intact and the farewell without
-- its button: found, named, pictured, and no number.
update public.integrations set enabled = false
 where id = '00000000-0000-0000-0000-000000001201';
select is(
  public.widget_station_identity('pw_identityaaaabbbbccccdd') -> 'whatsapp_number',
  'null'::jsonb, 'a switched-off integration yields no number, and the rest still answers');

-- The grant is exactly anon and service_role. `authenticated` is not on the
-- list and must not drift onto it: a door this wide open needs its audience
-- pinned by a test, not by the migration that happens to be read last.
select is(
  (select array_agg(g order by g) from (
     select unnest(array['anon', 'authenticated', 'service_role']) as g) roles
    where has_function_privilege(g, 'public.widget_station_identity(text)', 'execute')),
  array['anon', 'service_role'],
  'anon and service_role may execute it, and authenticated may not');

select * from finish();
rollback;
