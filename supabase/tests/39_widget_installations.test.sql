begin;
select plan(20);

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

-- 0110's own comment asked for this: "a later block adds a second rather than
-- renaming this one, because Task 4 references it by name." This is that block.
select ok(
  'WEB_VERIFICATION' = any(enum_range(null::public.template_purpose)::text[]),
  'the outbox can carry a verification template');

-- 0032 has three values and none of them is this one: `rules` is agreement to a
-- PROMOTION's rules, which is 17c's business, not identification's.
select ok(
  'identification' = any(enum_range(null::public.member_consent_type)::text[]),
  'and a listener can consent to being identified at all');

-- ---------------------------------------------------------------------------
-- Task 6. The console doors: upsert_widget_installation and
-- widget_installation_for, both gated on is_platform_admin().
-- ---------------------------------------------------------------------------

-- No session yet, so is_platform_admin() is false and both doors refuse
-- before doing any work -- the same shape 33_api_credentials.test.sql proves
-- for issue_api_credential.
select throws_ok(
  $$select public.upsert_widget_installation(
      '00000000-0000-0000-0000-0000000000f1', 'pw_11112222333344445555ff', true,
      array['https://radio.com.br'])$$,
  '42501', null, 'configuring an installation requires the platform admin');

select throws_ok(
  $$select public.widget_installation_for('00000000-0000-0000-0000-0000000000f1')$$,
  '42501', null, 'and so does reading one back');

-- A second Station, with no installation yet -- f1 already has one from the
-- fixtures above, and starting there would test an update on the first call
-- rather than a create.
insert into public.organizations (id, name) values
  ('00000000-0000-0000-0000-0000000000e2', 'Org widget console');
insert into public.companies (id, organization_id, name, timezone) values
  ('00000000-0000-0000-0000-0000000000f2', '00000000-0000-0000-0000-0000000000e2',
   'Station widget console', 'America/Sao_Paulo');

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000f6', 'widget-console-admin@example.test');
insert into public.platform_admins (user_id) values
  ('00000000-0000-0000-0000-0000000000f6');

set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-0000000000f6", "role": "authenticated"}';

create temporary table widget_first as
select public.upsert_widget_installation(
  '00000000-0000-0000-0000-0000000000f2', 'pw_11112222333344445555ff', true,
  array['https://radio.com.br']) as id;

create temporary table widget_read_first as
select public.widget_installation_for('00000000-0000-0000-0000-0000000000f2') as data;

reset role;

select is(
  (select count(*)::int from public.widget_installations
    where company_id = '00000000-0000-0000-0000-0000000000f2'),
  1, 'the first call creates exactly one installation for the Station');

select is(
  (select (data ->> 'has_template')::boolean from widget_read_first),
  false, 'and the console is warned: no WEB_VERIFICATION template registered yet');

-- A second call, with every field different -- if the function merged
-- instead of overwriting, at least one of these would still read as the
-- first call's value.
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-0000000000f6", "role": "authenticated"}';

create temporary table widget_second as
select public.upsert_widget_installation(
  '00000000-0000-0000-0000-0000000000f2', 'pw_66667777888899990000ff', false,
  array['https://outra.com.br', 'https://www.outra.com.br']) as id;

create temporary table widget_read_second as
select public.widget_installation_for('00000000-0000-0000-0000-0000000000f2') as data;

reset role;

select is(
  (select count(*)::int from public.widget_installations
    where company_id = '00000000-0000-0000-0000-0000000000f2'),
  1, 'a second call for the same Station updates rather than duplicating');

select is(
  (select id from widget_first), (select id from widget_second),
  'the same installation, in place -- not a new row with a new id');

select is(
  (select (data ->> 'enabled')::boolean from widget_read_second),
  false, 'every field lands as the second call sent it, not merged with the first');

select is(
  (select data -> 'allowed_origins' from widget_read_second),
  to_jsonb(array['https://outra.com.br', 'https://www.outra.com.br']),
  'including the origin list, replaced wholesale');

-- The template that makes the warning line go away.
insert into public.message_templates
  (organization_id, company_id, purpose, name, language, body)
values
  ('00000000-0000-0000-0000-0000000000e2', '00000000-0000-0000-0000-0000000000f2',
   'WEB_VERIFICATION', 'web_verification_code', 'pt_BR', 'Seu codigo e {{1}}');

set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-0000000000f6", "role": "authenticated"}';

create temporary table widget_read_third as
select public.widget_installation_for('00000000-0000-0000-0000-0000000000f2') as data;

reset role;

select is(
  (select (data ->> 'has_template')::boolean from widget_read_third),
  true, 'until a WEB_VERIFICATION template is registered, in the same query');

select * from finish();
rollback;
