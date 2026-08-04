begin;
select plan(30);

-- Block 7b, Task 1: the history table, and the kind that drives all five
-- doors. The doors themselves are Task 2; this file grows to cover them.

insert into public.organizations (id, name) values
  ('00000000-0000-0000-0000-00000000e2f1', 'Org 7b merge');
insert into public.companies (id, organization_id, name, timezone) values
  ('00000000-0000-0000-0000-00000000e2c1', '00000000-0000-0000-0000-00000000e2f1',
   'Station 7b merge', 'America/Sao_Paulo');

-- 1: five kinds, and the order is pinned. SHOW is present because the owner
-- ruled for merge_shows on 2026-08-04, against D3's original four — the two
-- comments 0098 and 0100 carry to the contrary are re-issued below.
select is(
  enum_range(null::public.music_merge_kind)::text[],
  array['SONG', 'ARTIST', 'LABEL', 'GENRE', 'SHOW'],
  'music_merge_kind is the five mergeable entities — shows included');

-- 2-6: the kind resolves to a table, totally. A kind added to the enum without
-- a branch here returns null, and every caller formats that into public."" and
-- fails loudly rather than writing somewhere unintended.
select is(public.music_merge_table('SONG'),   'songs',         'SONG maps to songs');
select is(public.music_merge_table('ARTIST'), 'artists',       'ARTIST maps to artists');
select is(public.music_merge_table('LABEL'),  'record_labels', 'LABEL maps to record_labels');
select is(public.music_merge_table('GENRE'),  'music_genres',  'GENRE maps to music_genres');
select is(public.music_merge_table('SHOW'),   'shows',         'SHOW maps to shows');

-- 7: a merge without a reason is not a merge. The column refuses blank as well
-- as null, because '   ' would satisfy NOT NULL and answer nothing in six
-- months' time.
select throws_ok($$
  insert into public.music_merges
    (organization_id, company_id, kind, winner_id, loser_id, reason, children_moved)
  values ('00000000-0000-0000-0000-00000000e2f1', '00000000-0000-0000-0000-00000000e2c1',
          'SONG', gen_random_uuid(), gen_random_uuid(), '   ', 0)
$$, '23514', null, 'a blank reason is refused by the check constraint');

-- 8: the winner cannot be the loser, at the column level as well as in the
-- core — a history row saying a record absorbed itself would be unreadable.
select throws_ok($$
  insert into public.music_merges
    (organization_id, company_id, kind, winner_id, loser_id, reason, children_moved)
  select '00000000-0000-0000-0000-00000000e2f1', '00000000-0000-0000-0000-00000000e2c1',
         'SONG', id, id, 'same', 0
    from (select gen_random_uuid() as id) s
$$, '23514', null, 'a row where the winner is also the loser is refused');

-- 9: authenticated may read the history and may not write it. The only writer
-- is the SECURITY DEFINER core.
select ok(
  not has_table_privilege('authenticated', 'public.music_merges', 'INSERT'),
  'authenticated cannot insert a merge history row directly');

-- ---------------------------------------------------------------------------
-- The doors. An actor fixture, because has_permission reads auth.uid() and
-- pgTAP's superuser connection has none — calling these as postgres would
-- prove nothing about the gate and would also bypass every EXECUTE grant, so
-- a missing `grant execute … to authenticated` would still pass.
--
-- BOTH music.view and music.merge: merge alone passes the doors but leaves
-- the actor unable to read a single row back, since 0099's select policies
-- gate on music.view.
-- ---------------------------------------------------------------------------

insert into public.roles (id, organization_id, name) values
  ('00000000-0000-0000-0000-00000000e2a1', '00000000-0000-0000-0000-00000000e2f1',
   'Music merger 7b');
insert into public.role_permissions (role_id, permission_code) values
  ('00000000-0000-0000-0000-00000000e2a1', 'music.view'),
  ('00000000-0000-0000-0000-00000000e2a1', 'music.merge');
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-00000000e2a2', 'music-merger-7b@example.test');
insert into public.company_memberships (user_id, company_id, organization_id, role_id) values
  ('00000000-0000-0000-0000-00000000e2a2', '00000000-0000-0000-0000-00000000e2c1',
   '00000000-0000-0000-0000-00000000e2f1', '00000000-0000-0000-0000-00000000e2a1');

-- Two artists, a song under each, a listener, and a request against each song.
-- Written as the superuser: authenticated holds no INSERT on any of these.
insert into public.artists (id, organization_id, company_id, name) values
  ('00000000-0000-0000-0000-00000000e2b1', '00000000-0000-0000-0000-00000000e2f1',
   '00000000-0000-0000-0000-00000000e2c1', 'Caetano Veloso'),
  ('00000000-0000-0000-0000-00000000e2b2', '00000000-0000-0000-0000-00000000e2f1',
   '00000000-0000-0000-0000-00000000e2c1', 'Caetano Velloso');

insert into public.songs (id, organization_id, company_id, title, artist_id) values
  ('00000000-0000-0000-0000-00000000e2d1', '00000000-0000-0000-0000-00000000e2f1',
   '00000000-0000-0000-0000-00000000e2c1', 'Sozinho', '00000000-0000-0000-0000-00000000e2b1'),
  ('00000000-0000-0000-0000-00000000e2d2', '00000000-0000-0000-0000-00000000e2f1',
   '00000000-0000-0000-0000-00000000e2c1', 'Sozinho', '00000000-0000-0000-0000-00000000e2b2');

insert into public.members (id, organization_id, full_name) values
  ('00000000-0000-0000-0000-00000000e2e1', '00000000-0000-0000-0000-00000000e2f1', 'Ana Listener');

insert into public.music_requests (id, organization_id, company_id, member_id, song_id) values
  ('00000000-0000-0000-0000-00000000e2e2', '00000000-0000-0000-0000-00000000e2f1',
   '00000000-0000-0000-0000-00000000e2c1', '00000000-0000-0000-0000-00000000e2e1',
   '00000000-0000-0000-0000-00000000e2d2'),
  -- A WITHDRAWN request against the same loser. It must move too: leaving it
  -- pointing at a row the merge just archived would make one uuid mean two
  -- different things depending on which side of deleted_at you read.
  ('00000000-0000-0000-0000-00000000e2e3', '00000000-0000-0000-0000-00000000e2f1',
   '00000000-0000-0000-0000-00000000e2c1', '00000000-0000-0000-0000-00000000e2e1',
   '00000000-0000-0000-0000-00000000e2d2');
update public.music_requests set deleted_at = now()
 where id = '00000000-0000-0000-0000-00000000e2e3';

set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000e2a2", "role": "authenticated"}';

-- 10: the private core is not reachable from outside, whatever else is true.
-- All three roles, because the message says "nobody" and the expression
-- should mean the same thing — anon and service_role were untested here
-- before this fix round, same gap 02_permissions.test.sql closes for
-- apply_inventory_movement.
select ok(
  not has_function_privilege('anon',
    'public.apply_music_merge(public.music_merge_kind, uuid, uuid, uuid[], text)', 'EXECUTE')
  and not has_function_privilege('authenticated',
    'public.apply_music_merge(public.music_merge_kind, uuid, uuid, uuid[], text)', 'EXECUTE')
  and not has_function_privilege('service_role',
    'public.apply_music_merge(public.music_merge_kind, uuid, uuid, uuid[], text)', 'EXECUTE'),
  'apply_music_merge is granted to nobody');

-- 11: a merge needs a reason.
select throws_ok($$
  select public.merge_songs('00000000-0000-0000-0000-00000000e2d1',
    array['00000000-0000-0000-0000-00000000e2d2']::uuid[], '  ')
$$, '22023', null, 'a merge without a reason is refused');

-- 12: a merge needs somebody to absorb.
select throws_ok($$
  select public.merge_songs('00000000-0000-0000-0000-00000000e2d1',
    array[]::uuid[], 'nothing to do')
$$, '22023', null, 'a merge naming no losers is refused');

-- 13: the survivor cannot also be absorbed.
select throws_ok($$
  select public.merge_songs('00000000-0000-0000-0000-00000000e2d1',
    array['00000000-0000-0000-0000-00000000e2d1']::uuid[], 'itself')
$$, '22023', null, 'a merge that names the winner among the losers is refused');

-- 14: THE ATOMICITY PROOF. Two losers, one of which does not exist. NEITHER
-- may move — proved by counting the requests on the winner afterwards, not by
-- reading the function.
select throws_ok($$
  select public.merge_songs('00000000-0000-0000-0000-00000000e2d1',
    array['00000000-0000-0000-0000-00000000e2d2',
          '00000000-0000-0000-0000-0000000000ff']::uuid[], 'one is bogus')
$$, 'P0002', null, 'a merge naming a record that is not there is refused whole');

reset role;

-- 15: and the good loser really did not move.
select is(
  (select count(*)::int from public.music_requests
    where song_id = '00000000-0000-0000-0000-00000000e2d1'),
  0, 'the refused merge moved nothing at all');

-- 16: the loser is still alive after the refusal.
select is(
  (select deleted_at from public.songs where id = '00000000-0000-0000-0000-00000000e2d2'),
  null, 'the refused merge archived nothing');

set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000e2a2", "role": "authenticated"}';

-- 17: the real merge, and it reports what it moved. TWO, not one: the
-- withdrawn request moves with the live one.
select is(
  public.merge_songs('00000000-0000-0000-0000-00000000e2d1',
    array['00000000-0000-0000-0000-00000000e2d2']::uuid[], 'same recording, typed twice'),
  2, 'merge_songs repoints both requests and says so');

reset role;

-- 18: THE PROOF THAT MATTERS — the children actually moved. A test asserting
-- only the loser's deleted_at passes over a function that forgot its update,
-- and the operator finds out from Block 8's dashboard.
select is(
  (select count(*)::int from public.music_requests
    where song_id = '00000000-0000-0000-0000-00000000e2d1'),
  2, 'both requests now point at the surviving song');

-- 19: nothing still points at the loser.
select is(
  (select count(*)::int from public.music_requests
    where song_id = '00000000-0000-0000-0000-00000000e2d2'),
  0, 'nothing is left pointing at the absorbed song');

-- 20-21: the loser left the lists, and its history survived. Two assertions,
-- not one — §6 asks for both.
select isnt(
  (select deleted_at from public.songs where id = '00000000-0000-0000-0000-00000000e2d2'),
  null, 'the absorbed song is archived');
select ok(
  exists(select 1 from public.songs where id = '00000000-0000-0000-0000-00000000e2d2'),
  'the absorbed song is still a row — this project deletes nothing');

-- 22-24: the history row says who, why and how many.
select is(
  (select count(*)::int from public.music_merges
    where loser_id = '00000000-0000-0000-0000-00000000e2d2'),
  1, 'one history row per absorbed record');
select is(
  (select reason from public.music_merges
    where loser_id = '00000000-0000-0000-0000-00000000e2d2'),
  'same recording, typed twice', 'the reason is kept verbatim');
select is(
  (select children_moved from public.music_merges
    where loser_id = '00000000-0000-0000-0000-00000000e2d2'),
  2, 'the history row records how many children moved');

-- 25: the audit log has the merge, once for the operation.
select is(
  (select count(*)::int from public.audit_logs
    where action = 'merge_music' and target_id = '00000000-0000-0000-0000-00000000e2d1'),
  1, 'one audit row for the whole merge');

set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000e2a2", "role": "authenticated"}';

-- 26: artists merge, and the songs follow — INCLUDING the archived one.
--
-- e2d2 was absorbed in assertion 17 and is now soft-deleted, but it still
-- names artist e2b2, so this moves exactly one song: the archived one. That is
-- D-c stated as a test rather than as a comment — a repoint that filtered
-- `deleted_at is null` would answer 0 here and leave an archived song pointing
-- at an archived artist, which is how one uuid comes to mean two things.
select is(
  public.merge_artists('00000000-0000-0000-0000-00000000e2b1',
    array['00000000-0000-0000-0000-00000000e2b2']::uuid[], 'one spelling'),
  1, 'merge_artists moves the archived song too — withdrawn children are not orphans');

-- 27: an already-absorbed record cannot be merged again — it is archived, and
-- the core's scoped lock never finds it.
select throws_ok($$
  select public.merge_songs('00000000-0000-0000-0000-00000000e2d1',
    array['00000000-0000-0000-0000-00000000e2d2']::uuid[], 'again')
$$, 'P0002', null, 'a record already absorbed cannot be absorbed twice');

reset role;

-- 28: all five doors exist and are callable by authenticated.
select is(
  (select count(*)::int from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('merge_songs', 'merge_artists', 'merge_record_labels',
                        'merge_music_genres', 'merge_shows')
      and has_function_privilege('authenticated', p.oid, 'EXECUTE')),
  5, 'five doors, all granted to authenticated');

-- ---------------------------------------------------------------------------
-- Fix round 1, Important #1: the property this whole design exists to
-- protect — a caller cannot use the winner's Station to learn anything about
-- a record in a DIFFERENT Station — was untested. Every prior assertion ran
-- in one Station with one authorised actor; #27 exercises only the
-- already-archived arm of P0002, never the other-Station arm. The scoped
-- lock's `company_id = $2` clause is what makes that arm true by
-- construction, and a "tidy-up" that swaps it for an explicit
-- `if v_row.company_id <> p_company_id then raise 'belongs to another
-- station'` reintroduces a cross-tenant existence oracle while still passing
-- every assertion above.
-- ---------------------------------------------------------------------------

-- A second Station in the same Organization, with its own artist and song —
-- the shape of a real cross-Station attempt, not a random uuid.
insert into public.companies (id, organization_id, name, timezone) values
  ('00000000-0000-0000-0000-00000000e2c2', '00000000-0000-0000-0000-00000000e2f1',
   'Station 7b merge — second', 'America/Sao_Paulo');
insert into public.artists (id, organization_id, company_id, name) values
  ('00000000-0000-0000-0000-00000000e2b3', '00000000-0000-0000-0000-00000000e2f1',
   '00000000-0000-0000-0000-00000000e2c2', 'Caetano Veloso (other station)');
insert into public.songs (id, organization_id, company_id, title, artist_id) values
  ('00000000-0000-0000-0000-00000000e2d3', '00000000-0000-0000-0000-00000000e2f1',
   '00000000-0000-0000-0000-00000000e2c2', 'Sozinho', '00000000-0000-0000-0000-00000000e2b3');

set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000e2a2", "role": "authenticated"}';

-- 29: a loser that lives in ANOTHER Station answers the identical P0002 a
-- uuid naming nothing gets — proved by the actor who holds music.merge only
-- in the FIRST Station, exactly as production would call it.
select throws_ok($$
  select public.merge_songs('00000000-0000-0000-0000-00000000e2d1',
    array['00000000-0000-0000-0000-00000000e2d3']::uuid[], 'reaches past the station')
$$, 'P0002', null, 'a loser belonging to another station is refused, same code as a missing one');

reset role;

-- A second actor: music.view but NOT music.merge, in the FIRST Station. The
-- door must refuse before it ever reveals whether the winner id names
-- anything, so this has to fail exactly like an unknown id does — 42501.
insert into public.roles (id, organization_id, name) values
  ('00000000-0000-0000-0000-00000000e2a3', '00000000-0000-0000-0000-00000000e2f1',
   'Music viewer 7b — no merge');
insert into public.role_permissions (role_id, permission_code) values
  ('00000000-0000-0000-0000-00000000e2a3', 'music.view');
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-00000000e2a4', 'music-viewer-7b@example.test');
insert into public.company_memberships (user_id, company_id, organization_id, role_id) values
  ('00000000-0000-0000-0000-00000000e2a4', '00000000-0000-0000-0000-00000000e2c1',
   '00000000-0000-0000-0000-00000000e2f1', '00000000-0000-0000-0000-00000000e2a3');

set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000e2a4", "role": "authenticated"}';

-- 30: music.view alone does not reach a door that needs music.merge.
select throws_ok($$
  select public.merge_songs('00000000-0000-0000-0000-00000000e2d1',
    array['00000000-0000-0000-0000-00000000e2d3']::uuid[], 'viewer cannot merge')
$$, '42501', null, 'an actor holding music.view but not music.merge is refused');

reset role;

select * from finish();
rollback;
