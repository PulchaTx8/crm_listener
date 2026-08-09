begin;
select plan(9);

-- Block 17a, design D4. The public key is NOT a secret: it sits in the src of
-- an iframe on a public web page. Everything that actually defends this door is
-- elsewhere -- the origin allowlist, the rate limits, and the code of spec §6.

select has_table('public', 'widget_installations', 'the installation table exists');

select is(
  (select relrowsecurity from pg_class where oid = 'public.widget_installations'::regclass),
  true, 'row level security is enabled');

select is(
  (select count(*) from pg_policies
    where schemaname = 'public' and tablename = 'widget_installations'),
  0::bigint, 'and there is no policy, so nothing reaches it directly');

select col_has_default('public', 'widget_installations', 'enabled',
  'enabled has a default');

insert into public.organizations (id, name) values
  ('00000000-0000-0000-0000-0000000000e1', 'Org widget');
insert into public.companies (id, organization_id, name, timezone) values
  ('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000e1',
   'Station widget', 'America/Sao_Paulo');

insert into public.widget_installations
  (id, organization_id, company_id, public_key)
values
  ('00000000-0000-0000-0000-000000000101',
   '00000000-0000-0000-0000-0000000000e1',
   '00000000-0000-0000-0000-0000000000f1', 'pw_aaaabbbbccccddddeeeeff');

-- A Station that has just been given an installation is not yet serving a
-- widget to the public. Somebody has to say so.
select is(
  (select enabled from public.widget_installations
    where id = '00000000-0000-0000-0000-000000000101'),
  false, 'a new installation is disabled until somebody enables it');

select is(
  (select allowed_origins from public.widget_installations
    where id = '00000000-0000-0000-0000-000000000101'),
  '{}'::text[], 'and it frames nowhere, which is what an empty allowlist means');

-- An origin is a scheme and a host. A path or a trailing slash would never
-- match what a browser sends in frame-ancestors, and would fail as "the widget
-- does not load" rather than as a refused write.
select throws_ok($$
  update public.widget_installations
     set allowed_origins = array['https://radio.com.br/']
   where id = '00000000-0000-0000-0000-000000000101'$$,
  '23514', null, 'a trailing slash is refused');

select throws_ok($$
  update public.widget_installations
     set allowed_origins = array['radio.com.br']
   where id = '00000000-0000-0000-0000-000000000101'$$,
  '23514', null, 'and so is a bare host with no scheme');

select lives_ok($$
  update public.widget_installations
     set allowed_origins = array['https://radio.com.br', 'https://www.radio.com.br']
   where id = '00000000-0000-0000-0000-000000000101'$$,
  'two well-formed origins are accepted');

select * from finish();
rollback;
