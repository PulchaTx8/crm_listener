begin;
select plan(18);

-- Block 8b, Task 2. The wrapper-equivalence suite.
--
-- 0121 splits four functions that every RLS policy in the installation depends
-- on. The split is safe only while the two entry points CANNOT disagree, and
-- there are two independent guarantees of that here:
--
--   1. STRUCTURAL. The old signatures keep no body of their own. A future
--      editor who "optimises" a wrapper by inlining it reintroduces exactly the
--      drift this design rejected, and these assertions are what stops them --
--      no behavioural test can, because an inlined copy passes every one of
--      them on the day it is written.
--
--   2. BEHAVIOURAL. The whole permission catalogue, crossed with the fixture's
--      Stations, compared through both doors in one authenticated session. That
--      is the assertion that would catch a substitution error inside a body.
--
-- Fixtures use the 8b tag.

-- ---------------------------------------------------------------------------
-- Structure.
-- ---------------------------------------------------------------------------

select has_function('public', 'is_platform_admin_for', array['uuid'],
  'is_platform_admin_for(uuid) exists');
select has_function('public', 'is_owner_for', array['uuid', 'uuid'],
  'is_owner_for(uuid, uuid) exists');
select has_function('public', 'has_company_access_for', array['uuid', 'uuid'],
  'has_company_access_for(uuid, uuid) exists');
select has_function('public', 'has_permission_for', array['uuid', 'text', 'uuid'],
  'has_permission_for(uuid, text, uuid) exists');

select ok(
  (select prosrc from pg_proc where proname = 'has_permission' and pronargs = 2)
    like '%has_permission_for%',
  'has_permission delegates to has_permission_for');

-- The negative half is the one that matters. `like '%has_permission_for%'`
-- would still pass for a function that called the sibling AND kept a copy of
-- the old body beside it.
select ok(
  (select prosrc from pg_proc where proname = 'has_permission' and pronargs = 2)
    not like '%company_memberships%',
  'has_permission keeps no body of its own');

select ok(
  (select prosrc from pg_proc where proname = 'has_company_access' and pronargs = 1)
    not like '%company_memberships%',
  'has_company_access keeps no body of its own');

select ok(
  (select prosrc from pg_proc where proname = 'is_owner' and pronargs = 1)
    not like '%organization_memberships%',
  'is_owner keeps no body of its own');

select ok(
  (select prosrc from pg_proc where proname = 'is_platform_admin' and pronargs = 0)
    not like '%platform_admins%',
  'is_platform_admin keeps no body of its own');

-- service_role must be able to ask the explicit-identity questions -- that is
-- the whole point -- and must NOT be handed the caller-shaped doors, which
-- would answer it with a confident false about auth.uid().
select ok(
  has_function_privilege('service_role', 'public.has_permission_for(uuid, text, uuid)', 'EXECUTE'),
  'service_role may ask about a named user');
select ok(
  not has_function_privilege('anon', 'public.has_permission_for(uuid, text, uuid)', 'EXECUTE'),
  'anon may not ask about a named user');

-- ---------------------------------------------------------------------------
-- Behaviour, with no session in play.
-- ---------------------------------------------------------------------------

-- A null user id is not "everybody". It is the worker before it has been told
-- whose report it is generating, and it must hold nothing.
select is(
  public.has_permission_for(null, 'members.view', gen_random_uuid()),
  false,
  'a null user id holds nothing');

select is(
  public.has_permission_for(gen_random_uuid(), 'members.view', gen_random_uuid()),
  false,
  'an unknown user id holds nothing');

-- ---------------------------------------------------------------------------
-- Fixtures. Two Stations, three callers with different reach.
-- ---------------------------------------------------------------------------

insert into public.organizations (id, name) values
  ('00000000-0000-0000-0000-00008b010001', 'Org 8b');

insert into public.companies (id, organization_id, name, timezone) values
  ('00000000-0000-0000-0000-00008b020001', '00000000-0000-0000-0000-00008b010001',
   'Station One', 'America/Sao_Paulo'),
  ('00000000-0000-0000-0000-00008b020002', '00000000-0000-0000-0000-00008b010001',
   'Station Two', 'UTC');

insert into public.roles (id, organization_id, name) values
  ('00000000-0000-0000-0000-00008b040001', '00000000-0000-0000-0000-00008b010001', 'Reader'),
  -- Archived, to exercise 0024's Minor 2 through the new sibling: a membership
  -- attached to a dead role grants nothing.
  ('00000000-0000-0000-0000-00008b040002', '00000000-0000-0000-0000-00008b010001', 'Dead');
update public.roles set deleted_at = now()
  where id = '00000000-0000-0000-0000-00008b040002';

insert into public.role_permissions (role_id, permission_code) values
  ('00000000-0000-0000-0000-00008b040001', 'members.view'),
  ('00000000-0000-0000-0000-00008b040001', 'participations.view'),
  ('00000000-0000-0000-0000-00008b040002', 'members.view');

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-00008b050001', '8b-reader@example.test'),
  ('00000000-0000-0000-0000-00008b050002', '8b-dead-role@example.test'),
  ('00000000-0000-0000-0000-00008b050003', '8b-outsider@example.test');

insert into public.company_memberships (user_id, company_id, organization_id, role_id) values
  ('00000000-0000-0000-0000-00008b050001', '00000000-0000-0000-0000-00008b020001',
   '00000000-0000-0000-0000-00008b010001', '00000000-0000-0000-0000-00008b040001'),
  ('00000000-0000-0000-0000-00008b050002', '00000000-0000-0000-0000-00008b020001',
   '00000000-0000-0000-0000-00008b010001', '00000000-0000-0000-0000-00008b040002');

-- A membership through an ARCHIVED role grants nothing. Before 0024 this was
-- fail-closed only by construction; it must stay structural through the split.
select is(
  public.has_permission_for('00000000-0000-0000-0000-00008b050002',
    'members.view', '00000000-0000-0000-0000-00008b020001'),
  false,
  'an archived role grants nothing through the explicit-identity door');

-- A code that does not exist is refused for a caller who otherwise holds the
-- real one. 0010's rule: the existence check sits outside every bypass.
select is(
  public.has_permission_for('00000000-0000-0000-0000-00008b050001',
    'members.viwe', '00000000-0000-0000-0000-00008b020001'),
  false,
  'a typo''d code is refused even for an entitled caller');

-- ---------------------------------------------------------------------------
-- THE ASSERTION THIS FILE EXISTS FOR.
--
-- The whole permission catalogue crossed with both fixture Stations, asked
-- through BOTH doors in the same authenticated session, for each of three
-- callers with deliberately different reach: one role holder, one holding only
-- a dead role, one who is not a member of the Organization at all. Any
-- disagreement -- in either direction, for any code, in either Station -- is
-- one row, and one row fails the assertion.
--
-- `is distinct from` rather than `<>`, so a pair that somehow returned null
-- counts as a disagreement instead of vanishing from the count.
-- ---------------------------------------------------------------------------

set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00008b050001", "role": "authenticated"}';
select is(
  (select count(*)::int
     from public.permissions p
     cross join (values
       ('00000000-0000-0000-0000-00008b020001'::uuid),
       ('00000000-0000-0000-0000-00008b020002'::uuid)) as s(company_id)
    where public.has_permission(p.code, s.company_id)
      is distinct from
          public.has_permission_for('00000000-0000-0000-0000-00008b050001', p.code, s.company_id)),
  0,
  'wrapper and sibling agree for a role holder, every code and both Stations');
reset role;

set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00008b050002", "role": "authenticated"}';
select is(
  (select count(*)::int
     from public.permissions p
     cross join (values
       ('00000000-0000-0000-0000-00008b020001'::uuid),
       ('00000000-0000-0000-0000-00008b020002'::uuid)) as s(company_id)
    where public.has_permission(p.code, s.company_id)
      is distinct from
          public.has_permission_for('00000000-0000-0000-0000-00008b050002', p.code, s.company_id)),
  0,
  'wrapper and sibling agree for a holder of an archived role');
reset role;

set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00008b050003", "role": "authenticated"}';
select is(
  (select count(*)::int
     from public.permissions p
     cross join (values
       ('00000000-0000-0000-0000-00008b020001'::uuid),
       ('00000000-0000-0000-0000-00008b020002'::uuid)) as s(company_id)
    where public.has_permission(p.code, s.company_id)
      is distinct from
          public.has_permission_for('00000000-0000-0000-0000-00008b050003', p.code, s.company_id)),
  0,
  'wrapper and sibling agree for an outsider');
reset role;

select * from finish();
rollback;
