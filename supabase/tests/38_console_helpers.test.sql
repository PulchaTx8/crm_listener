begin;
select plan(11);

-- Block 16, Task 5. The two reads the Stations screen needs.
--
-- Both exist for one reason: the Station record's dialog opens from what
-- page.tsx already read, never from a fetch of its own, so the page reads the
-- integration and the keys of EVERY Station it lists before knowing which one
-- will be opened. That is affordable only because the screen is filtered to one
-- Organization (D3).

select has_function('public', 'get_integration', array['uuid'],
  'one Station''s integration can be read on its own');
select has_function('public', 'list_api_credentials_for', array['uuid[]'],
  'and every listed Station''s keys in one call');

-- No session, so is_platform_admin() is false. The gate is before the work in
-- both, as it is in the two functions these are siblings of.
select throws_ok(
  $$select * from public.get_integration('00000000-0000-0000-0000-0000000000c1')$$,
  '42501', null, 'reading an integration requires the platform admin');
select throws_ok(
  $$select * from public.list_api_credentials_for(array['00000000-0000-0000-0000-0000000000c1']::uuid[])$$,
  '42501', null, 'and so does reading keys in bulk');

-- 0149's rule does not weaken because the read got wider. A hash that reaches a
-- screen is a hash somebody can take away from it.
select is(
  (select count(*) from information_schema.parameters
    where specific_schema = 'public'
      and parameter_name = 'token_hash'
      and specific_name like 'list_api_credentials_for%'),
  0::bigint,
  'the bulk read cannot return a token hash');

insert into public.organizations (id, name) values
  ('00000000-0000-0000-0000-0000000000c0', 'Console helpers');
insert into public.companies (id, organization_id, name, timezone) values
  ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000c0',
   'Station one', 'America/Sao_Paulo'),
  ('00000000-0000-0000-0000-0000000000c2', '00000000-0000-0000-0000-0000000000c0',
   'Station two', 'America/Sao_Paulo');

-- Station one is connected; station two is not, which is the case the screen
-- exists to show.
insert into public.integrations
  (company_id, organization_id, provider, phone_number_id, enabled)
values
  ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000c0',
   'WHATSAPP', '551199990000', true);

insert into public.api_credentials
  (id, organization_id, company_id, name, token_prefix, token_hash)
values
  ('00000000-0000-0000-0000-0000000000c3', '00000000-0000-0000-0000-0000000000c0',
   '00000000-0000-0000-0000-0000000000c1', 'Automation one', 'ptx_aaaaaaaa',
   encode(sha256('one'::bytea), 'hex')),
  ('00000000-0000-0000-0000-0000000000c4', '00000000-0000-0000-0000-0000000000c0',
   '00000000-0000-0000-0000-0000000000c2', 'Automation two', 'ptx_bbbbbbbb',
   encode(sha256('two'::bytea), 'hex'));

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000c5', 'helpers-admin@example.test');
insert into public.platform_admins (user_id) values
  ('00000000-0000-0000-0000-0000000000c5');

set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-0000000000c5", "role": "authenticated"}';

create temporary table connected as
select * from public.get_integration('00000000-0000-0000-0000-0000000000c1');
create temporary table unconnected as
select * from public.get_integration('00000000-0000-0000-0000-0000000000c2');
create temporary table keys as
select * from public.list_api_credentials_for(array[
  '00000000-0000-0000-0000-0000000000c1',
  '00000000-0000-0000-0000-0000000000c2']::uuid[]);
create temporary table no_keys as
select * from public.list_api_credentials_for('{}'::uuid[]);

reset role;

select is(
  (select phone_number_id from connected),
  '551199990000', 'a connected Station reports its number');

-- ONE ROW OF NULLS, NOT NO ROWS. The screen's question is "is this Station
-- connected", and the two answers differ only if the caller remembers to tell
-- them apart -- so the function does not make it remember.
select is(
  (select count(*)::int from unconnected), 1,
  'a Station with no integration is one row, not an absence');
select is(
  (select phone_number_id from unconnected), null,
  'with the integration''s columns null beside its own');

-- The point of the bulk read: two Stations, one call. Called per row this would
-- be the N+1 Block 3b measured at 102 queries.
select is(
  (select count(*)::int from keys), 2,
  'both Stations'' keys arrive in one call');
select is(
  (select company_id from keys where id = '00000000-0000-0000-0000-0000000000c4'),
  '00000000-0000-0000-0000-0000000000c2'::uuid,
  'each key naming the Station it belongs to, so the caller can group them');

-- An empty selection is what the screen holds before an Organization is chosen.
-- No rows is the answer; an error would be a screen that cannot render itself.
select is(
  (select count(*)::int from no_keys), 0,
  'and an empty selection is no rows rather than an error');

select * from finish();
rollback;
