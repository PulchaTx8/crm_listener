begin;
select plan(9);

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


-- ---------------------------------------------------------------------------
-- THE LEAK, and it is the reason this block exists. create_invitation raises,
-- in these words, "this e-mail already has an account on the platform" -- to
-- anybody who may invite. That is the existence D17 says a Station must never
-- learn about its people, and it is live today, across the whole platform
-- rather than merely across this group.
--
-- The fix is not a quieter message. Under D17 a user belongs to the platform and
-- may be staff at any number of Stations, in any number of Organizations, so
-- inviting an address that already has an account is an ORDINARY operation.
-- Making it succeed leaves nothing to tell the two cases apart.
-- ---------------------------------------------------------------------------
select lives_ok($$
  select public.create_invitation(
    '00000000-0000-0000-0000-0000000078f1',
    'brand-new-p5b@example.test',
    false,
    '00000000-0000-0000-0000-0000000078e1',
    array['00000000-0000-0000-0000-0000000078c1']::uuid[],
    repeat('a', 64),
    7)
$$, 'a Station owner invites into the Station they own');

select is(
  (select count(*)::int from public.invitations
    where email = 'brand-new-p5b@example.test' and status = 'pending'),
  1,
  'and the invitation is really there');

-- And the gate descended with it: an invitation is TO Stations, so those are the
-- ones the caller must be able to invite to.
select throws_ok($$
  select public.create_invitation(
    '00000000-0000-0000-0000-0000000078f1',
    'somebody-else-p5b@example.test',
    false,
    '00000000-0000-0000-0000-0000000078e1',
    array['00000000-0000-0000-0000-0000000078c2']::uuid[],
    repeat('b', 64),
    7)
$$, '42501', null,
   'and a Station''s owner cannot invite into the sister Station they do not own');

select is(
  (select count(*)::int from public.invitations
    where email = 'somebody-else-p5b@example.test'),
  0,
  'and that refusal wrote nothing');


-- THE LEAK IS STILL HERE, pinned rather than pretended away. create_invitation
-- announces that an address exists on the platform -- the existence D17 forbids
-- -- and is simultaneously the guard that stops an emailed link from setting a
-- password on an account that already exists. Closing it means teaching
-- acceptance to require signing in, which is an application change with a
-- security property and its own block. Asserted here so that whoever does that
-- work sees this line go red and knows exactly where to look.
select throws_ok($$
  select public.create_invitation(
    '00000000-0000-0000-0000-0000000078f1',
    'newcomer-p5b@example.test',
    false,
    '00000000-0000-0000-0000-0000000078e1',
    array['00000000-0000-0000-0000-0000000078c1']::uuid[],
    repeat('c', 64),
    7)
$$, '23505', null,
   'and an address that already has an account is STILL refused: leak and guard in one');

reset request.jwt.claims;

select * from finish();
rollback;
