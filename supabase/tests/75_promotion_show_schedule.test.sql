begin;
select plan(11);

-- Block 30e, item 18 (D7). The door that lets the Participations screen read the
-- schedule of the Programme a promotion belongs to.
--
-- THE POINT OF THE FIXTURE is a member who holds participations.view and NO
-- music.view anywhere. That is the operator this door exists for: `shows` and
-- `show_schedules` carry one select policy each and both are gated on music.view
-- (0099, 0175), so under RLS this caller reads NOTHING from either table -- and
-- an empty band combo does not say "you may not see this", it says "this
-- Programme never airs". A test that granted both permissions would pass against
-- a door that did not exist.
--
-- NO SECTION BELOW NAMES AN ASSERTION NUMBER: this file will grow, every growth
-- inserts cases in the middle, and a header claiming "cases 4-6" is a claim about
-- position that nothing checks and no test breaks.

-- ---------------------------------------------------------------------------
-- Fixtures. Two Stations of one Organization; a Programme at A with two bands,
-- one of them overnight; an archived Programme at A; four promotions -- one with
-- a Programme, one without, one pointing at the archived Programme, one at B.
-- ---------------------------------------------------------------------------
insert into public.organizations (id, name) values
  ('00000000-0000-0000-0000-00000000e0c1', 'Org 30e');

insert into public.companies (id, organization_id, name, timezone) values
  ('00000000-0000-0000-0000-00000000e0a1', '00000000-0000-0000-0000-00000000e0c1', 'Station A 30e', 'America/Sao_Paulo'),
  ('00000000-0000-0000-0000-00000000e0b1', '00000000-0000-0000-0000-00000000e0c1', 'Station B 30e', 'America/Sao_Paulo');

insert into public.shows (id, organization_id, company_id, name, deleted_at) values
  ('00000000-0000-0000-0000-00000000e0f1', '00000000-0000-0000-0000-00000000e0c1',
   '00000000-0000-0000-0000-00000000e0a1', 'Manha Total 30e', null),
  ('00000000-0000-0000-0000-00000000e0f2', '00000000-0000-0000-0000-00000000e0c1',
   '00000000-0000-0000-0000-00000000e0a1', 'Programa Arquivado 30e', now());

-- Band 1: Monday and Tuesday, 10:00-12:30. Band 2: Friday night into Saturday,
-- stored the way save_show stores it -- a head ending at 24:00 and a tail
-- starting at 00:00 under the SAME marker.
insert into public.show_schedules (show_id, organization_id, company_id, band, weekday, starts_at, ends_at) values
  ('00000000-0000-0000-0000-00000000e0f1', '00000000-0000-0000-0000-00000000e0c1',
   '00000000-0000-0000-0000-00000000e0a1', 1, 1, '10:00', '12:30'),
  ('00000000-0000-0000-0000-00000000e0f1', '00000000-0000-0000-0000-00000000e0c1',
   '00000000-0000-0000-0000-00000000e0a1', 1, 2, '10:00', '12:30'),
  ('00000000-0000-0000-0000-00000000e0f1', '00000000-0000-0000-0000-00000000e0c1',
   '00000000-0000-0000-0000-00000000e0a1', 2, 5, '23:00', '24:00'),
  ('00000000-0000-0000-0000-00000000e0f1', '00000000-0000-0000-0000-00000000e0c1',
   '00000000-0000-0000-0000-00000000e0a1', 2, 6, '00:00', '02:00');

insert into public.show_schedules (show_id, organization_id, company_id, band, weekday, starts_at, ends_at) values
  ('00000000-0000-0000-0000-00000000e0f2', '00000000-0000-0000-0000-00000000e0c1',
   '00000000-0000-0000-0000-00000000e0a1', 1, 3, '08:00', '09:00'),
  ('00000000-0000-0000-0000-00000000e0f2', '00000000-0000-0000-0000-00000000e0c1',
   '00000000-0000-0000-0000-00000000e0a1', 1, 4, '08:00', '09:00');

insert into public.promotions
  (id, organization_id, company_id, name, starts_at, ends_at, show_id)
values
  ('00000000-0000-0000-0000-00000000e0d1', '00000000-0000-0000-0000-00000000e0c1',
   '00000000-0000-0000-0000-00000000e0a1', 'Promo com programa', now(), now() + interval '30 days',
   '00000000-0000-0000-0000-00000000e0f1'),
  ('00000000-0000-0000-0000-00000000e0d2', '00000000-0000-0000-0000-00000000e0c1',
   '00000000-0000-0000-0000-00000000e0a1', 'Promo sem programa', now(), now() + interval '30 days',
   null),
  ('00000000-0000-0000-0000-00000000e0d3', '00000000-0000-0000-0000-00000000e0c1',
   '00000000-0000-0000-0000-00000000e0a1', 'Promo de programa arquivado', now(), now() + interval '30 days',
   '00000000-0000-0000-0000-00000000e0f2'),
  ('00000000-0000-0000-0000-00000000e0d4', '00000000-0000-0000-0000-00000000e0c1',
   '00000000-0000-0000-0000-00000000e0b1', 'Promo da estacao B', now(), now() + interval '30 days',
   null);

-- The operator this door exists for: participations.view at Station A, and
-- nothing in music anywhere.
insert into public.roles (id, organization_id, name) values
  ('00000000-0000-0000-0000-00000000e0e1', '00000000-0000-0000-0000-00000000e0c1', 'Entries 30e');
insert into public.role_permissions (role_id, permission_code) values
  ('00000000-0000-0000-0000-00000000e0e1', 'participations.view');

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-00000000e0e2', 'entries-30e@example.test'),
  ('00000000-0000-0000-0000-00000000e0e3', 'outsider-30e@example.test');

insert into public.company_memberships (user_id, company_id, organization_id, role_id) values
  ('00000000-0000-0000-0000-00000000e0e2', '00000000-0000-0000-0000-00000000e0a1',
   '00000000-0000-0000-0000-00000000e0c1', '00000000-0000-0000-0000-00000000e0e1');

-- ---------------------------------------------------------------------------
-- The shape of the door itself.
-- ---------------------------------------------------------------------------
select has_function('public', 'promotion_show_schedule', array['uuid'],
  'the door exists');

select is(
  (select prosecdef from pg_proc where proname = 'promotion_show_schedule'),
  true,
  'it is SECURITY DEFINER, which is why it re-checks the permission by hand');

-- The ACL, restated in full by the migration. A function that loses its grants
-- is the Block 24 defect this project has now met twice.
select is(
  (select proacl::text from pg_proc where proname = 'promotion_show_schedule'),
  '{postgres=X/postgres,authenticated=X/postgres}',
  'authenticated may execute it and public may not');

set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000e0e2", "role": "authenticated"}';

-- ---------------------------------------------------------------------------
-- What the operator the door exists for reads.
-- ---------------------------------------------------------------------------
select is(
  (select count(*)::int from public.promotion_show_schedule('00000000-0000-0000-0000-00000000e0d1')),
  4,
  'the Programme''s four schedule rows come back for a caller with participations.view and no music.view');

select is(
  (select show_name from public.promotion_show_schedule('00000000-0000-0000-0000-00000000e0d1') limit 1),
  'Manha Total 30e',
  'and it names the Programme, so the screen can say whose schedule it is');

-- The overnight pair arrives INTACT -- head and tail under one marker -- because
-- rejoining them is the caller's job (toBands), not this door's.
select is(
  (select count(*)::int from public.promotion_show_schedule('00000000-0000-0000-0000-00000000e0d1')
    where band = 2),
  2,
  'an overnight band arrives as the two rows save_show wrote, for toBands to rejoin');

-- ---------------------------------------------------------------------------
-- The two ordinary empty answers, which are NOT the refusal below.
-- ---------------------------------------------------------------------------
select is(
  (select count(*)::int from public.promotion_show_schedule('00000000-0000-0000-0000-00000000e0d2')),
  0,
  'a promotion with no Programme answers with no rows rather than an error');

select is(
  (select count(*)::int from public.promotion_show_schedule('00000000-0000-0000-0000-000000000000')),
  0,
  'a promotion that does not exist answers the same way, saying nothing about whether it exists elsewhere');

-- ---------------------------------------------------------------------------
-- 0258's promise: the link outlives the archive, so the schedule must too.
-- ---------------------------------------------------------------------------
select is(
  (select count(*)::int from public.promotion_show_schedule('00000000-0000-0000-0000-00000000e0d3')),
  2,
  'an archived Programme still answers, because promotions.show_id outlives the archive');

-- ---------------------------------------------------------------------------
-- The refusals, and the section this door did NOT widen.
-- ---------------------------------------------------------------------------
select throws_ok(
  $$select * from public.promotion_show_schedule('00000000-0000-0000-0000-00000000e0d4')$$,
  '42501',
  'participations.view is required to read this promotion''s programme',
  'a Station where this caller holds no participations.view is refused, not answered emptily');

-- The same caller still cannot read `shows` directly: the door widened one read,
-- not the Music section.
select is(
  (select count(*)::int from public.shows),
  0,
  'the door grants nothing in the Music section it reads through');

select finish();
rollback;
