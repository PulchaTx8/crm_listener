begin;
select plan(10);

select has_type('public', 'integration_provider', 'the provider enum exists');
select has_table('public', 'integrations', 'integrations exists');
select has_column('public', 'integrations', 'phone_number_id',
                  'integrations carries Meta''s id for the number');

select is(relrowsecurity, true, 'RLS enabled on integrations')
  from pg_class where oid = 'public.integrations'::regclass;

select is(
  (select count(*)::int from pg_policies
    where schemaname = 'public' and tablename = 'integrations'),
  0, 'no policy admits authenticated to integrations');

select ok(not has_table_privilege('authenticated', 'public.integrations', 'SELECT'),
          'authenticated may not read integrations');

-- Fixtures -------------------------------------------------------------------

insert into public.organizations (id, name) values
  ('00000000-0000-0000-0000-0000000005f1', 'Org 5a');
insert into public.companies (id, organization_id, name, timezone) values
  ('00000000-0000-0000-0000-0000000005c1', '00000000-0000-0000-0000-0000000005f1',
   'Station 5a', 'America/Sao_Paulo'),
  ('00000000-0000-0000-0000-0000000005c2', '00000000-0000-0000-0000-0000000005f1',
   'Station 5a Two', 'America/Sao_Paulo');

insert into public.integrations
  (id, organization_id, company_id, provider, phone_number_id, enabled)
values
  ('00000000-0000-0000-0000-0000000005a1', '00000000-0000-0000-0000-0000000005f1',
   '00000000-0000-0000-0000-0000000005c1', 'WHATSAPP', '111111111111111', true);

select throws_ok($$
  insert into public.integrations
    (organization_id, company_id, provider, phone_number_id, enabled)
  values
    ('00000000-0000-0000-0000-0000000005f1', '00000000-0000-0000-0000-0000000005c2',
     'WHATSAPP', '111111111111111', true)
$$, '23505', null, 'one number cannot serve two Stations');

select throws_ok($$
  insert into public.integrations
    (organization_id, company_id, provider, phone_number_id, enabled)
  values
    ('00000000-0000-0000-0000-0000000005f1', '00000000-0000-0000-0000-0000000005c1',
     'WHATSAPP', '222222222222222', true)
$$, '23505', null, 'a Station cannot hold two WhatsApp numbers');

-- The reason the two indexes above are PARTIAL. Without this pair, replacing
-- them with total unique constraints would leave every assertion in this file
-- passing while the comment on them became false.
--
-- integrations_archival_shape demands deleted_by be set together with
-- deleted_at, not left null, so the archiving actor needs a real auth.users
-- row to reference.
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000005b1', 'archivist-5a@example.test');

update public.integrations
   set deleted_at = now(), deleted_by = '00000000-0000-0000-0000-0000000005b1'
 where phone_number_id = '111111111111111';

select lives_ok($$
  insert into public.integrations
    (organization_id, company_id, provider, phone_number_id, enabled)
  values
    ('00000000-0000-0000-0000-0000000005f1', '00000000-0000-0000-0000-0000000005c2',
     'WHATSAPP', '111111111111111', true)
$$, 'a number can be moved to another Station once the old row is archived');

select lives_ok($$
  insert into public.integrations
    (organization_id, company_id, provider, phone_number_id, enabled)
  values
    ('00000000-0000-0000-0000-0000000005f1', '00000000-0000-0000-0000-0000000005c1',
     'WHATSAPP', '222222222222222', true)
$$, 'a Station can take a new number once its old one is archived');

select * from finish();
rollback;
