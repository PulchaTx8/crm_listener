begin;
select plan(9);

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

select * from finish();
rollback;
