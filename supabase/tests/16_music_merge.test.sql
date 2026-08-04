begin;
select plan(40);

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

-- 14: THE PRE-FLIGHT REFUSAL. Two losers, one of which does not exist. The
-- whole call is refused before either could move — proved by counting the
-- requests on the winner afterwards, not by reading the function. 0106 raises
-- P0002 from the pre-flight lock-and-count check, before the repoint loop
-- ever runs, so this does NOT exercise a rollback of a partially-applied
-- repoint — a genuine atomicity proof would need a failure injected AFTER the
-- loop starts, which no kind currently offers cheaply. What this proves is
-- narrower and still real: a bad call is refused whole, before anything is
-- touched. Atomicity itself holds structurally regardless — a plpgsql
-- function body is one transaction.
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

-- ---------------------------------------------------------------------------
-- Task 4: the Maintenance screen's one read. The merge above archived e2d2 and
-- e2b2, so only the survivors remain as candidates.
-- ---------------------------------------------------------------------------

set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000e2a2", "role": "authenticated"}';

-- 31: only the live song is offered as a candidate — e2d2 was absorbed.
select is(
  (select count(*)::int from public.list_merge_candidates(
     '00000000-0000-0000-0000-00000000e2c1', 'SONG')),
  1, 'only live records are offered as merge candidates');

-- 32: a song candidate is labelled by its title.
select is(
  (select label from public.list_merge_candidates(
     '00000000-0000-0000-0000-00000000e2c1', 'SONG')),
  'Sozinho', 'a song candidate is labelled by its title');

-- 33: the number the operator needs to choose a survivor: the surviving song
-- absorbed two requests in assertion 17.
select is(
  (select child_count from public.list_merge_candidates(
     '00000000-0000-0000-0000-00000000e2c1', 'SONG')),
  2, 'a candidate carries the number of children a merge would move');

reset role;

-- ---------------------------------------------------------------------------
-- Fix round 1, Critical 1: 0108's gate moved from music.merge to music.view
-- (D8 — a candidate list is seeing the catalogue, not destroying anything;
-- 0108's own comment carries the full reasoning). page.tsx reads this list
-- and getMusicPermissions in one Promise.all, so gating the READ itself on
-- music.merge made `permissions.merge = false` and "the read already threw"
-- the same event — the Maintenance screen's required read-only mode for a
-- caller without music.merge could never actually render; page.tsx returned
-- LoadError before MergePanel ever saw canMerge=false. The two assertions
-- below prove the corrected contract directly, in the SAME Station as 31-33,
-- rather than leaning on 36's cross-station refusal (below) to stand in for
-- it — that one is a real proof of tenant isolation, but it does not by
-- itself show which single permission code the same-Station gate now checks.
-- ---------------------------------------------------------------------------

-- A third actor: neither music.view nor music.merge, in the FIRST Station —
-- role e2a5 is granted no permission at all. Fixture rows written as the
-- superuser, the same reset-role-first shape every other actor fixture in
-- this file uses: `authenticated` (the role assertions 31-33 are still
-- running as, from e2a2's session) holds no INSERT on public.roles.
insert into public.roles (id, organization_id, name) values
  ('00000000-0000-0000-0000-00000000e2a5', '00000000-0000-0000-0000-00000000e2f1',
   'Music nobody 7b — no permissions');
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-00000000e2a6', 'music-nobody-7b@example.test');
insert into public.company_memberships (user_id, company_id, organization_id, role_id) values
  ('00000000-0000-0000-0000-00000000e2a6', '00000000-0000-0000-0000-00000000e2c1',
   '00000000-0000-0000-0000-00000000e2f1', '00000000-0000-0000-0000-00000000e2a5');

set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000e2a6", "role": "authenticated"}';

-- 34: an actor holding neither permission is still refused — the read stays
-- gated, only on a different code than the doors.
select throws_ok($$
  select * from public.list_merge_candidates(
    '00000000-0000-0000-0000-00000000e2c1', 'SONG')
$$, '42501', null, 'an actor holding neither music.view nor music.merge cannot read the candidate list');

reset role;

set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000e2a4", "role": "authenticated"}';

-- 35: music.view ALONE now reaches the read — the corrected contract, and
-- the one fact that actually makes the Maintenance screen's read-only mode
-- reachable. e2a4 ("Music viewer 7b — no merge", from assertion 30) holds
-- music.view but not music.merge, in this same Station.
select is(
  (select count(*)::int from public.list_merge_candidates(
     '00000000-0000-0000-0000-00000000e2c1', 'SONG')),
  1, 'an actor holding music.view alone can read the candidate list');

reset role;

set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000e2a2", "role": "authenticated"}';

-- 36: the candidate list refuses a Station the caller cannot reach at all.
-- e2c2 is a real second Station (added in fix round 1), not a nonexistent
-- uuid — this proves the refusal comes from the permission, not merely from
-- the Station being absent. e2a2 holds music.view and music.merge in e2c1
-- only, so this is the identical "neither permission, in this OTHER
-- Station" shape as 34 above, proved across a tenant boundary instead of
-- within one Station.
select throws_ok($$
  select * from public.list_merge_candidates(
    '00000000-0000-0000-0000-00000000e2c2', 'SONG')
$$, '42501', null, 'the candidate list refuses a Station the caller cannot reach at all');

reset role;

-- ---------------------------------------------------------------------------
-- Fix round (final whole-branch review), Important #1: every pgTAP assertion
-- and every isolation case above calls merge_songs only. Deleting the
-- has_permission clause from merge_artists, merge_record_labels,
-- merge_music_genres or merge_shows today would leave every gate in this
-- repository green — on the one operation in this domain that destroys data.
--
-- Same actor as assertion 30 (e2a4: music.view, not music.merge), same
-- Station. e2b1 is the artist assertion 26 left alive; record_labels,
-- music_genres and shows have no live fixture anywhere above this point, so
-- one winner each is added here. The loser array in each call below is never
-- read: a door's has_permission check runs before apply_music_merge ever
-- looks at p_loser_ids, so a placeholder id needs no fixture of its own.
-- ---------------------------------------------------------------------------

insert into public.record_labels (id, organization_id, company_id, name) values
  ('00000000-0000-0000-0000-00000000e2f2', '00000000-0000-0000-0000-00000000e2f1',
   '00000000-0000-0000-0000-00000000e2c1', 'Label 7b merge');
insert into public.music_genres (id, organization_id, company_id, name) values
  ('00000000-0000-0000-0000-00000000e2f3', '00000000-0000-0000-0000-00000000e2f1',
   '00000000-0000-0000-0000-00000000e2c1', 'Genre 7b merge');
insert into public.shows (id, organization_id, company_id, name) values
  ('00000000-0000-0000-0000-00000000e2f4', '00000000-0000-0000-0000-00000000e2f1',
   '00000000-0000-0000-0000-00000000e2c1', 'Show 7b merge');

set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000e2a4", "role": "authenticated"}';

-- 37: merge_artists refuses music.view without music.merge — the load-bearing
-- clause assertion 30 already proves for merge_songs, here for the door a
-- careless edit could silently strip and still pass every other test.
select throws_ok($$
  select public.merge_artists('00000000-0000-0000-0000-00000000e2b1',
    array['00000000-0000-0000-0000-0000000000ff']::uuid[], 'viewer cannot merge')
$$, '42501', null, 'merge_artists refuses an actor holding music.view but not music.merge');

-- 38: merge_record_labels refuses music.view without music.merge.
select throws_ok($$
  select public.merge_record_labels('00000000-0000-0000-0000-00000000e2f2',
    array['00000000-0000-0000-0000-0000000000ff']::uuid[], 'viewer cannot merge')
$$, '42501', null, 'merge_record_labels refuses an actor holding music.view but not music.merge');

-- 39: merge_music_genres refuses music.view without music.merge.
select throws_ok($$
  select public.merge_music_genres('00000000-0000-0000-0000-00000000e2f3',
    array['00000000-0000-0000-0000-0000000000ff']::uuid[], 'viewer cannot merge')
$$, '42501', null, 'merge_music_genres refuses an actor holding music.view but not music.merge');

-- 40: merge_shows refuses music.view without music.merge — the fifth door,
-- and the one the owner's 2026-08-04 ruling added after D3's original four.
select throws_ok($$
  select public.merge_shows('00000000-0000-0000-0000-00000000e2f4',
    array['00000000-0000-0000-0000-0000000000ff']::uuid[], 'viewer cannot merge')
$$, '42501', null, 'merge_shows refuses an actor holding music.view but not music.merge');

reset role;

select * from finish();
rollback;
