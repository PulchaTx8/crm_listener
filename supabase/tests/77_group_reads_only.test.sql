begin;
select plan(15);

-- ---------------------------------------------------------------------------
-- P5a. THE GROUP READS AND DOES NOT WRITE (design D19).
--
-- The classification has to be DATA rather than a list inside a function. A list
-- drifts the first time a block adds a permission and nobody remembers to
-- exclude it, and the drift is silent in the worst direction: the new code
-- simply becomes writable by every group owner on the platform.
-- ---------------------------------------------------------------------------

select has_column('public', 'permissions', 'kind',
  'every permission says whether it is a read or a write');

select col_not_null('public', 'permissions', 'kind',
  'and none of them may decline to say');

-- The nine reads, NAMED rather than counted, so a tenth is a deliberate edit
-- here and not an off-by-one somebody accepts.
select set_eq(
  $$ select code from public.permissions where kind = 'READ' $$,
  $$ values ('audit.view'), ('inventory.view'), ('members.view'),
            ('messaging.view'), ('music.view'), ('participations.view'),
            ('promotions.view'), ('reports.consolidated'), ('templates.view') $$,
  'and exactly these nine are reads');

-- What makes a future permission safe by default: one added with no kind cannot
-- exist, and one added as WRITE is invisible to the group until somebody decides
-- otherwise in writing.
select is(
  (select count(*)::int from public.permissions where kind = 'WRITE'),
  34,
  'and the other thirty-four are writes');


-- ---------------------------------------------------------------------------
-- THE NARROWING, and it is a RESTRICTION rather than the addition D19 sounds
-- like. has_permission_for has one unconditional branch admitting a group's
-- owner to every permission at every Station of the group -- so until 0277 the
-- two false assertions below were true, and a group owner could create
-- promotions and erase listeners at a Station they had never staffed.
-- ---------------------------------------------------------------------------
insert into public.organizations (id, name) values
  ('00000000-0000-0000-0000-0000000077f1', 'Org P5a');

insert into public.companies (id, organization_id, name, timezone, status) values
  ('00000000-0000-0000-0000-0000000077c1', '00000000-0000-0000-0000-0000000077f1',
   'Station P5a one', 'America/Sao_Paulo', 'active');

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000077a1', 'owner-p5a@example.test');

insert into public.organization_memberships (user_id, organization_id, role) values
  ('00000000-0000-0000-0000-0000000077a1', '00000000-0000-0000-0000-0000000077f1', 'owner');

select is(
  public.has_permission_for('00000000-0000-0000-0000-0000000077a1',
                            'members.view', '00000000-0000-0000-0000-0000000077c1'),
  true,
  'the group''s owner reads a listener at a Station of the group');

select is(
  public.has_permission_for('00000000-0000-0000-0000-0000000077a1',
                            'reports.consolidated', '00000000-0000-0000-0000-0000000077c1'),
  true,
  'and consolidates its figures, which is what a group is for');

select is(
  public.has_permission_for('00000000-0000-0000-0000-0000000077a1',
                            'promotions.create', '00000000-0000-0000-0000-0000000077c1'),
  false,
  'and does NOT create a promotion there, which they could until 0277');

select is(
  public.has_permission_for('00000000-0000-0000-0000-0000000077a1',
                            'members.erase', '00000000-0000-0000-0000-0000000077c1'),
  false,
  'nor erase a listener');

-- The access gate is untouched on purpose. Narrowing it would take the reading
-- away along with the writing, which is the opposite of what D19 asks for.
select is(
  public.has_company_access_for('00000000-0000-0000-0000-0000000077a1',
                                '00000000-0000-0000-0000-0000000077c1'),
  true,
  'while still reaching the Station at all: D19 removes writing, not access');


-- ---------------------------------------------------------------------------
-- THE STATION OWNER (design D17), and why D19 needed one to be shippable.
--
-- 0277 took every write away from the group's owner, and a Station has no staff
-- of its own: add_company creates the company and an audit row and nothing else.
-- So on its own, 0277 leaves every Station in the platform operable by nobody
-- until somebody grants a role by hand -- possible, since the group's owner
-- still holds roles.manage at Organization level, but a manual step per customer
-- that no screen asks for.
--
-- The answer is the concept D17 already describes rather than a role granting
-- all thirty-four writes, which would rot the first time a block adds a
-- permission: a Station has owners, and its owner writes there.
-- ---------------------------------------------------------------------------
insert into public.companies (id, organization_id, name, timezone, status) values
  ('00000000-0000-0000-0000-0000000077c2', '00000000-0000-0000-0000-0000000077f1',
   'Station P5a two', 'America/Sao_Paulo', 'active');

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000077a2', 'station-owner-p5a@example.test');

insert into public.company_memberships (user_id, company_id, organization_id, is_owner) values
  ('00000000-0000-0000-0000-0000000077a2', '00000000-0000-0000-0000-0000000077c1',
   '00000000-0000-0000-0000-0000000077f1', true);

select is(
  public.has_permission_for('00000000-0000-0000-0000-0000000077a2',
                            'promotions.create', '00000000-0000-0000-0000-0000000077c1'),
  true,
  'a Station''s owner writes at their own Station');

select is(
  public.has_permission_for('00000000-0000-0000-0000-0000000077a2',
                            'members.view', '00000000-0000-0000-0000-0000000077c1'),
  true,
  'and reads there too, without holding a role');

-- The whole point of the concept being per Station: it does not travel sideways.
select is(
  public.has_permission_for('00000000-0000-0000-0000-0000000077a2',
                            'promotions.create', '00000000-0000-0000-0000-0000000077c2'),
  false,
  'and writes NOTHING at the sister Station, which is what makes it a Station''s owner and not a group''s');

-- THE GRANDFATHER. Nobody wakes up unable to work: every Organization owner is
-- made an owner of every Station of their group, so the day 0277 ships nothing
-- changes for anybody who has the product today. What changes is that the power
-- is now a row somebody can see on a screen and take away, instead of a branch
-- in a function that could not be revoked at all.
-- 0280's own function, called rather than copied. It ran before this file did
-- and had nothing to do -- the Organization above did not exist yet -- so a test
-- re-typing its statements would pass whether or not the migration existed,
-- which is the trap 0274's backfill already taught this project once.
select isnt(
  public.backfill_station_owners(),
  0,
  'the grandfather touches the memberships it finds');

select is(
  public.has_permission_for('00000000-0000-0000-0000-0000000077a1',
                            'promotions.create', '00000000-0000-0000-0000-0000000077c1'),
  true,
  'and afterwards the group''s owner writes at a Station of the group again: nobody wakes up unable to work');

-- And forward, for a Station created after it. add_company is gated on
-- is_platform_admin (0017), which reads auth.uid() -- so this needs a real
-- platform admin behind the claim, not the superuser the file otherwise runs as.
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000077a3', 'admin-p5a@example.test');
insert into public.platform_admins (user_id) values
  ('00000000-0000-0000-0000-0000000077a3');

set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-0000000077a3", "role": "authenticated"}';

create table pg_temp.p5a_station as
  select public.add_company(
    '00000000-0000-0000-0000-0000000077f1', 'Station P5a three', 'America/Sao_Paulo') as id;

reset request.jwt.claims;

select is(
  (select count(*)::int
     from public.company_memberships cm
     join pg_temp.p5a_station st on st.id = cm.company_id
    where cm.user_id = '00000000-0000-0000-0000-0000000077a1'
      and cm.is_owner
      and cm.deleted_at is null),
  1,
  'and a Station created afterwards names the group''s owner as its owner too');

select * from finish();
rollback;
