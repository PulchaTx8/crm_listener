begin;
select plan(4);

-- ---------------------------------------------------------------------------
-- P5b. A STATION'S OWNER STAFFS THEIR OWN STATION.
--
-- assign_company_role and remove_company_access already take a company; they
-- simply asked has_org_permission about it, so the answer was "does this person
-- administer the GROUP" to a question about one Station. A Station's owner --
-- the concept 0278 built and 0280 gave to every existing Organization owner --
-- could not staff the Station they own, while somebody holding users.manage at
-- a sister Station could.
-- ---------------------------------------------------------------------------
insert into public.organizations (id, name) values
  ('00000000-0000-0000-0000-0000000078f1', 'Org P5b');

insert into public.companies (id, organization_id, name, timezone, status) values
  ('00000000-0000-0000-0000-0000000078c1', '00000000-0000-0000-0000-0000000078f1',
   'Station P5b one', 'America/Sao_Paulo', 'active'),
  ('00000000-0000-0000-0000-0000000078c2', '00000000-0000-0000-0000-0000000078f1',
   'Station P5b two', 'America/Sao_Paulo', 'active');

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000078a1', 'station-owner-p5b@example.test'),
  ('00000000-0000-0000-0000-0000000078a2', 'newcomer-p5b@example.test');

-- The newcomer is a MEMBER of the Organization already. assign_company_role
-- refuses 23503 for somebody who is not -- correctly: a Station role is what a
-- person of this group may do here, not a way into the group. Joining is
-- create_invitation's job, which Task 2 covers.
insert into public.organization_memberships (user_id, organization_id, role) values
  ('00000000-0000-0000-0000-0000000078a2', '00000000-0000-0000-0000-0000000078f1', 'member');

-- Owner of Station one only. Never of Station two -- which is what makes the
-- third assertion mean something.
insert into public.company_memberships (user_id, company_id, organization_id, is_owner) values
  ('00000000-0000-0000-0000-0000000078a1', '00000000-0000-0000-0000-0000000078c1',
   '00000000-0000-0000-0000-0000000078f1', true);

insert into public.roles (id, organization_id, name) values
  ('00000000-0000-0000-0000-0000000078e1', '00000000-0000-0000-0000-0000000078f1',
   'Station P5b Viewer');
insert into public.role_permissions (role_id, permission_code) values
  ('00000000-0000-0000-0000-0000000078e1', 'members.view');

set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-0000000078a1", "role": "authenticated"}';

select lives_ok($$
  -- (p_company_id, p_user_id, p_role_id) -- the STATION comes first. pg_proc is
  -- the authority on that, and reading it the other way round is not a type
  -- error: it is two valid uuids in the wrong holes, deciding about a Station
  -- nobody meant.
  select public.assign_company_role(
    '00000000-0000-0000-0000-0000000078c1',
    '00000000-0000-0000-0000-0000000078a2',
    '00000000-0000-0000-0000-0000000078e1')
$$, 'a Station''s owner gives somebody a role at the Station they own');

select is(
  (select count(*)::int from public.company_memberships
    where user_id = '00000000-0000-0000-0000-0000000078a2'
      and company_id = '00000000-0000-0000-0000-0000000078c1'
      and deleted_at is null),
  1,
  'and the membership is really there');

-- The whole point of a Station owner: it does not travel sideways.
select throws_ok($$
  select public.assign_company_role(
    '00000000-0000-0000-0000-0000000078c2',
    '00000000-0000-0000-0000-0000000078a2',
    '00000000-0000-0000-0000-0000000078e1')
$$, '42501', null,
   'and cannot staff the sister Station they do not own');

select lives_ok($$
  select public.remove_company_access(
    '00000000-0000-0000-0000-0000000078c1',
    '00000000-0000-0000-0000-0000000078a2')
$$, 'and can take that access away again');

reset request.jwt.claims;

select * from finish();
rollback;
