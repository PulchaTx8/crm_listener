begin;
select plan(16);

-- Block 15, design D1. The API key is the SUBJECT rather than a borrowed
-- identity, so the thing that proves "may this caller write here?" is a row in
-- this table plus its scopes -- not a session, and not a membership.

select has_table('public', 'api_credentials', 'the credential table exists');
select has_table('public', 'api_credential_scopes', 'and its scopes are a child table');

-- The scope is a real foreign key, not a string somebody typed. THIS is the
-- whole reason the scopes are a child table rather than a text[] column: a
-- text[] would need a trigger to say the same thing, and a trigger is a thing
-- somebody can forget to write.
select col_is_fk('public', 'api_credential_scopes', 'permission_code',
  'a scope must name a permission that exists');

-- RLS on, no policy: reachable only from inside SECURITY DEFINER bodies, the
-- shape 0057 uses for integrations. Bypassing RLS is not a table privilege, and
-- this schema revokes the default ACL, so there is no way in from a client.
select is(
  (select relrowsecurity from pg_class where oid = 'public.api_credentials'::regclass),
  true, 'row level security is enabled on the credentials');

select is(
  (select count(*) from pg_policies
    where schemaname = 'public' and tablename = 'api_credentials'),
  0::bigint, 'and there is no policy, so nothing reaches it directly');

-- Fixtures -------------------------------------------------------------------

insert into public.organizations (id, name) values
  ('00000000-0000-0000-0000-0000000000a1', 'Org api credentials');
insert into public.companies (id, organization_id, name, timezone) values
  ('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000a1',
   'Station api credentials', 'America/Sao_Paulo');
insert into public.api_credentials
  (id, organization_id, company_id, name, token_prefix, token_hash)
values
  ('00000000-0000-0000-0000-0000000000c1',
   '00000000-0000-0000-0000-0000000000a1',
   '00000000-0000-0000-0000-0000000000b1',
   'Fixture key', 'ptx_aaaabbbb', repeat('a', 64));

-- The CHECK that refuses a RAW secret written where a digest belongs -- the
-- same shape rule webhook_events.external_id (0058) carries. A backstop, not a
-- licence to skip hashing in the caller.
select throws_ok(
  $$insert into public.api_credentials
      (organization_id, company_id, name, token_prefix, token_hash)
    values ('00000000-0000-0000-0000-0000000000a1',
            '00000000-0000-0000-0000-0000000000b1',
            'Bad hash', 'ptx_abcd1234', 'not-a-sha-256')$$,
  '23514', null,
  'a token hash that is not lowercase hex of the right length is refused');

-- A REAL credential id, so the only constraint this statement can violate is
-- the one under test. With a random id it would violate two at once and pass
-- while proving the wrong thing.
select throws_ok(
  $$insert into public.api_credential_scopes (credential_id, permission_code)
    values ('00000000-0000-0000-0000-0000000000c1', 'music.invented')$$,
  '23503', null,
  'an invented scope is refused by the foreign key');

-- The doors (0149) --------------------------------------------------------

select has_function('public', 'authenticate_api_credential',
  array['text', 'text'], 'the authenticator exists');

-- service_role ONLY. A browser role holding this could grind hashes against
-- the table at will.
select is(
  (select count(*) from information_schema.role_routine_grants
    where routine_schema = 'public' and routine_name = 'authenticate_api_credential'
      and grantee in ('anon', 'authenticated')),
  0::bigint, 'no browser role may call the authenticator');

insert into public.api_credential_scopes (credential_id, permission_code)
values ('00000000-0000-0000-0000-0000000000c1', 'music.manage');

select is(
  (select company_id from public.authenticate_api_credential(repeat('a', 64), 'music.manage')),
  '00000000-0000-0000-0000-0000000000b1'::uuid,
  'a live key with the scope resolves to its Station');

-- ONE ROW WITH scope_ok = false, not zero rows. This is what lets the route
-- answer 403 rather than 401: the caller has already proved it holds a valid
-- key, so naming the missing scope gives away nothing it did not know -- and an
-- integrator cannot debug without it.
select is(
  (select scope_ok from public.authenticate_api_credential(repeat('a', 64), 'music.request')),
  false,
  'and the same key reports a scope it does not hold, separately from being unknown');

select is(
  (select count(*) from public.authenticate_api_credential(repeat('b', 64), 'music.manage')),
  0::bigint, 'an unknown hash resolves to nothing');

-- Revoked, expired and suspended are all ZERO ROWS, indistinguishable from
-- unknown outside. One 401 for four causes, so probing with a stolen hash
-- learns nothing about which it was.
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000d1', 'revoker@example.test');
update public.api_credentials
   set revoked_at = now(), revoked_by = '00000000-0000-0000-0000-0000000000d1'
 where id = '00000000-0000-0000-0000-0000000000c1';
select is(
  (select count(*) from public.authenticate_api_credential(repeat('a', 64), 'music.manage')),
  0::bigint, 'a revoked key resolves to nothing');
update public.api_credentials set revoked_at = null, revoked_by = null
 where id = '00000000-0000-0000-0000-0000000000c1';

update public.api_credentials set expires_at = now() - interval '1 second'
 where id = '00000000-0000-0000-0000-0000000000c1';
select is(
  (select count(*) from public.authenticate_api_credential(repeat('a', 64), 'music.manage')),
  0::bigint, 'an expired key resolves to nothing');
update public.api_credentials set expires_at = null
 where id = '00000000-0000-0000-0000-0000000000c1';

-- Without this a lapsed subscription would go on accepting machine writes for
-- as long as nobody remembered to revoke the key.
update public.companies set status = 'suspended'
 where id = '00000000-0000-0000-0000-0000000000b1';
select is(
  (select count(*) from public.authenticate_api_credential(repeat('a', 64), 'music.manage')),
  0::bigint, 'a suspended Station stops its keys');
update public.companies set status = 'active'
 where id = '00000000-0000-0000-0000-0000000000b1';

-- No session, so auth.uid() is null and is_platform_admin() is false: the
-- console doors refuse. 0121's own comment on is_platform_admin_for says a null
-- argument matches nothing, which is exactly the behaviour wanted here.
select throws_ok(
  $$select public.issue_api_credential(
      '00000000-0000-0000-0000-0000000000b1', 'Nope', 'ptx_ccccdddd',
      repeat('c', 64), array['music.manage'])$$,
  '42501', null, 'issuing a key requires the platform admin');

select * from finish();
rollback;
