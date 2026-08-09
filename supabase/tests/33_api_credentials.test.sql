begin;
select plan(7);

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

select * from finish();
rollback;
