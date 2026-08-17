begin;
select plan(32);

-- Block 7a, Tasks 3 and 4: the doors.
--
-- Fixtures live in the ...00e1xx range; 14_music_catalogue owns ...00e0xx.
--
-- What pgTAP can prove here is the mechanics: the shape of the write, the
-- refusals that need no second identity, and the audit row. Everything that
-- needs a REAL user with a REAL, narrower grant — the permission gate, and
-- the cross-Station refusal as a caller actually experiences it — is in
-- tests/isolation/music.test.ts, written in the same block, because that is
-- what the boundary means and pgTAP cannot cheaply set up two authenticated
-- identities.

insert into public.organizations (id, name) values
  ('00000000-0000-0000-0000-00000000e1f1', 'Org 7a rpcs');
insert into public.companies (id, organization_id, name, timezone) values
  ('00000000-0000-0000-0000-00000000e1c1', '00000000-0000-0000-0000-00000000e1f1',
   'Station 7a rpcs', 'America/Sao_Paulo'),
  ('00000000-0000-0000-0000-00000000e1c2', '00000000-0000-0000-0000-00000000e1f1',
   'Station 7a rpcs two', 'America/Sao_Paulo');

-- A real actor, not a superuser bypass. has_permission reads auth.uid(),
-- which is null under plain pgTAP, so calling these RPCs as postgres would
-- prove nothing about the permission gate — worse, postgres also bypasses
-- every EXECUTE grant, so a call made as postgres would still succeed even if
-- `grant execute ... to authenticated` had been left off the migration
-- entirely (08_conversation.test.sql:124-131 makes the same point about
-- has_function_privilege). The house pattern (02_permissions.test.sql,
-- 11_filtered_hat.test.sql) is a real role, a real role_permissions grant, a
-- real auth.users row and a real company_membership, entered with
-- `set local role authenticated` + `set local request.jwt.claims` immediately
-- around each RPC call and left with `reset role` immediately after. Every
-- fixture insert below runs as the superuser pgTAP connects as — authenticated
-- holds no write grant on any of these four tables. Granted BOTH music.view
-- and music.manage: music.manage alone passes the RPC gates but leaves the
-- actor unable to read a row back, since 0099's select policies gate on
-- music.view.
insert into public.roles (id, organization_id, name) values
  ('00000000-0000-0000-0000-00000000e1a1', '00000000-0000-0000-0000-00000000e1f1',
   'Music manager 7a');
insert into public.role_permissions (role_id, permission_code) values
  ('00000000-0000-0000-0000-00000000e1a1', 'music.view'),
  ('00000000-0000-0000-0000-00000000e1a1', 'music.manage');
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-00000000e1a2', 'music-manager-7a@example.test');
insert into public.company_memberships (user_id, company_id, organization_id, role_id) values
  ('00000000-0000-0000-0000-00000000e1a2', '00000000-0000-0000-0000-00000000e1c1',
   '00000000-0000-0000-0000-00000000e1f1', '00000000-0000-0000-0000-00000000e1a1');

-- 1: the kinds, exactly, and in declaration order. Pinned because 7b's merge
-- kinds are a DIFFERENT set (songs in, categories out) and reusing this enum
-- there would be a silent mistake.
--
-- Block 27 appended CATEGORY, and this assertion is the reason that append was
-- noticed rather than assumed: it failed the moment 0204 landed, which is what
-- a pinned set is for. APPENDED, not inserted — `alter type ... add value`
-- without BEFORE/AFTER puts it last, and enum_range answers in declaration
-- order, so inserting instead would have moved every other value's position for
-- no reason.
--
-- Block 28 renamed that value to SONGWRITER, and the POSITION IS UNCHANGED:
-- `alter type ... rename value` (0209) relabels in place and does not move
-- anything, so this array's first four entries needed no edit. That is the
-- second thing this pinned set is for — a rename that had quietly reordered the
-- enum would fail here rather than somewhere that reads it by index.
select is(
  enum_range(null::public.music_reference_kind)::text[],
  array['GENRE', 'LABEL', 'ARTIST', 'SHOW', 'SONGWRITER'],
  'music_reference_kind is the five short lists — songs is not one of them');

-- 2-5: one door writes four tables. Called as the actor fixture above, under
-- its own grant of music.manage. The RPC's internal writes still run as the
-- table owner (SECURITY DEFINER); what the role switch proves is who is
-- allowed to ASK for that write — the gate itself is proved more fully in the
-- isolation suite, which can compare a caller who holds the grant against one
-- who does not.
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000e1a2", "role": "authenticated"}';

select lives_ok($$
  select public.create_music_reference(
    '00000000-0000-0000-0000-00000000e1c1', 'GENRE', 'Samba')
$$, 'create_music_reference writes a genre');

reset role;

select is(
  (select count(*)::int from public.music_genres
    where company_id = '00000000-0000-0000-0000-00000000e1c1' and name = 'Samba'),
  1, 'the genre is in music_genres and nowhere else');

select is(
  (select count(*)::int from public.artists
    where company_id = '00000000-0000-0000-0000-00000000e1c1' and name = 'Samba'),
  0, 'GENRE did not land in artists');

set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000e1a2", "role": "authenticated"}';

select lives_ok($$
  select public.create_music_reference(
    '00000000-0000-0000-0000-00000000e1c1', 'SHOW', 'Morning Show', 'LEG-SHOW-1')
$$, 'create_music_reference writes a show, with its legacy handle');

-- 6: a blank name is not a name, in any kind.
select throws_ok($$
  select public.create_music_reference(
    '00000000-0000-0000-0000-00000000e1c1', 'ARTIST', '   ')
$$, '22023', null, 'a blank name is refused');

-- 7: D7 through the door, not only through the index — the RPC turns 23505
-- into a message naming the handle rather than a bare constraint name.
select throws_ok($$
  select public.create_music_reference(
    '00000000-0000-0000-0000-00000000e1c1', 'SHOW', 'Second import', 'LEG-SHOW-1')
$$, '23505', null, 'a legacy handle imports once per Station');

reset role;

-- 8: the audit row. Six months later this is what says who added it. Read as
-- the superuser pgTAP connects as, deliberately: audit_logs' only select
-- policy (0006_rls_policies.sql) is platform-admin-only, and this actor is
-- not one, so under `authenticated` this count would read 0 regardless of
-- whether the RPC wrote the row — the write happened through the RPC's
-- SECURITY DEFINER body either way, but only a superuser (or a real platform
-- admin) can read it back here.
select is(
  (select count(*)::int from public.audit_logs
    where action = 'create_music_reference'
      and company_id = '00000000-0000-0000-0000-00000000e1c1'),
  2, 'every create writes an audit row');

-- 9-10: update replaces the name, and refuses a blank one.
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000e1a2", "role": "authenticated"}';

select lives_ok($$
  select public.update_music_reference(
    'GENRE',
    (select id from public.music_genres where name = 'Samba'),
    'Samba de raiz')
$$, 'update_music_reference renames a genre');

reset role;

select is(
  (select name from public.music_genres
    where company_id = '00000000-0000-0000-0000-00000000e1c1' and deleted_at is null),
  'Samba de raiz', 'the new name is stored');

-- 11-13: 0102's fix round — update_music_reference no longer takes a
-- p_legacy_id parameter at all. Before 0102, the parameter defaulted to null
-- and was applied unconditionally, and a form that never carried the current
-- value forward (legacy_id renders read-only in every screen) silently
-- erased it on the first rename. Proved with its own ARTIST fixture, kept
-- apart from Samba/Morning Show above, so this does not depend on — or
-- interact with — a legacy handle used elsewhere in this file.
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000e1a2", "role": "authenticated"}';

select lives_ok($$
  select public.create_music_reference(
    '00000000-0000-0000-0000-00000000e1c1', 'ARTIST', 'Cartola', 'LEG-ARTIST-1')
$$, 'create_music_reference writes an artist with a legacy handle');

select lives_ok($$
  select public.update_music_reference(
    'ARTIST',
    (select id from public.artists where name = 'Cartola'),
    'Cartola Renamed')
$$, 'update_music_reference renames the artist, with no legacy_id argument to give it');

reset role;

-- 13: the assertion 0102 exists for. Before the fix this would have read
-- null — the parameter's own SQL default, applied unconditionally by the
-- pre-0102 UPDATE — proving exactly the erasure the review found.
select is(
  (select legacy_id from public.artists where name = 'Cartola Renamed'),
  'LEG-ARTIST-1',
  'update_music_reference leaves legacy_id untouched — the parameter that could overwrite it is gone (0102)');

-- 14: archive is a soft delete. This project deletes nothing — 7b's merge
-- history needs something to keep pointing at.
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000e1a2", "role": "authenticated"}';

select lives_ok($$
  select public.archive_music_reference(
    'SHOW', (select id from public.shows where name = 'Morning Show'))
$$, 'archive_music_reference soft-deletes a show');

reset role;

-- 15: read as the superuser pgTAP connects as, deliberately: every 0099
-- select policy carries `deleted_at is null`, so an archived row is not
-- merely hidden from a list, it is UNREADABLE through RLS for this actor —
-- under `authenticated` the subquery below would return no row at all, and an
-- absent row is indistinguishable from a genuinely null deleted_at to isnt().
select isnt(
  (select deleted_at from public.shows where name = 'Morning Show'),
  null, 'the show is soft-deleted, and the row is still there');

-- 16-17: both refusals proved under the real actor, not the superuser pgTAP
-- connects as — the whole point of the permission-before-existence idiom
-- (0093) is that an unauthorised caller cannot tell an archived row from an
-- unknown id from a Station it cannot reach, and that only means something
-- when the caller genuinely is the narrower identity.
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000e1a2", "role": "authenticated"}';

-- 16: an archived row cannot be renamed. The composite foreign key cannot see
-- deleted_at (it references a non-partial constraint), so this check is the
-- only thing standing between an archived genre and an edit that resurrects
-- it in every screen's reference list.
select throws_ok($$
  select public.update_music_reference(
    'SHOW', (select id from public.shows where name = 'Morning Show'), 'Back again')
$$, '42501', null, 'an archived record answers 42501, not a silent success');

-- 17: an unknown id answers 42501 too, never P0002. An id that does not exist
-- and a Station the caller holds nothing in are indistinguishable from out
-- here — the rule 0093 settled, and the one this block does not break.
select throws_ok($$
  select public.archive_music_reference(
    'ARTIST', '00000000-0000-0000-0000-00000000e199')
$$, '42501', null, 'an unknown id answers permission denied, not "not found"');

reset role;

-- Block 7a, Task 4: the song's own three doors.
--
-- Fixtures for the song doors: an artist in each of the two Stations, and a
-- label in the second, so "belongs to this Station" is never accidentally
-- true because there was only one of everything. Ids e1b1/e1b2 rather than
-- e1a1/e1a2 — those two are already the role id and the actor's auth.users
-- id above, in different tables so there is no primary-key collision, but
-- reusing them here would be a copy-paste trap for the next reader. Fixture
-- inserts stay superuser, outside any role bracket: authenticated holds no
-- write grant on artists or record_labels either.
insert into public.artists (id, organization_id, company_id, name) values
  ('00000000-0000-0000-0000-00000000e1b1', '00000000-0000-0000-0000-00000000e1f1',
   '00000000-0000-0000-0000-00000000e1c1', 'Elis Regina'),
  ('00000000-0000-0000-0000-00000000e1b2', '00000000-0000-0000-0000-00000000e1f1',
   '00000000-0000-0000-0000-00000000e1c2', 'Elis Regina');
insert into public.record_labels (id, organization_id, company_id, name) values
  ('00000000-0000-0000-0000-00000000e1d2', '00000000-0000-0000-0000-00000000e1f1',
   '00000000-0000-0000-0000-00000000e1c2', 'Label of the other Station');

-- 18: the ordinary case, with every optional field filled. Called as the
-- actor fixture above, under its own grant of music.manage — has_permission
-- reads auth.uid(), which is null under plain pgTAP, so this call must run
-- under the real role for the gate to answer anything but 42501.
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000e1a2", "role": "authenticated"}';

select lives_ok($$
  select public.create_song(
    '00000000-0000-0000-0000-00000000e1c1', 'Águas de Março',
    '00000000-0000-0000-0000-00000000e1b1', null, null,
    'DOMESTIC', 'FEMALE', 213, 'INT-1', 'LEG-SONG-1')
$$, 'create_song registers a song with its whole record');

reset role;

-- 19: read as the superuser pgTAP connects as, deliberately: the row is
-- live, so the actor's music.view grant would also see it, but every other
-- verification read in this file follows the same superuser convention and
-- there is no reason for this one to be the exception.
select is(
  (select vocal::text from public.songs where title = 'Águas de Março'),
  'FEMALE', 'the vocal is stored as given');

-- 20-23: four more calls against create_song, none needing a read in
-- between, so one bracket covers all four — the same grouping the fixtures
-- above use for create_music_reference's SHOW/blank-name/legacy-handle trio.
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000e1a2", "role": "authenticated"}';

-- 20: a song without an artist is a draft, not a record (§3.2). Must get
-- past the permission gate (the actor holds music.manage in this Station) to
-- reach assert_song_references_live's own check.
select throws_ok($$
  select public.create_song(
    '00000000-0000-0000-0000-00000000e1c1', 'No artist', null)
$$, '22023', null, 'a song must name an artist');

-- 21-22: the Station boundary, checked IN THE DATABASE and not on the
-- screen. The composite foreign key would also refuse this, but with a
-- constraint name; the RPC refuses it first, with a message an operator can
-- act on. Both calls name Station e1c1, where this actor holds music.manage,
-- so both must pass the permission gate and be refused by
-- assert_song_references_live specifically — a 42501 here would mean the
-- refusal came from the wrong place and would prove nothing about the
-- Station boundary.
select throws_ok($$
  select public.create_song(
    '00000000-0000-0000-0000-00000000e1c1', 'Borrowed artist',
    '00000000-0000-0000-0000-00000000e1b2')
$$, 'P0002', null, 'an artist from another Station is refused');

select throws_ok($$
  select public.create_song(
    '00000000-0000-0000-0000-00000000e1c1', 'Borrowed label',
    '00000000-0000-0000-0000-00000000e1b1',
    '00000000-0000-0000-0000-00000000e1d2')
$$, 'P0002', null, 'a label from another Station is refused');

-- 23: D2 through the door. Two identical songs, no complaint — the cure is
-- 7b's merge, not a wall here.
select lives_ok($$
  select public.create_song(
    '00000000-0000-0000-0000-00000000e1c1', 'Águas de Março',
    '00000000-0000-0000-0000-00000000e1b1')
$$, 'the same title by the same artist may be registered twice (D2)');

reset role;

-- 24: update replaces the whole record, and resolves the Station from the
-- song rather than a parameter. No trailing legacy_id argument any more
-- (0102), and no internal_code argument either (0208) — update_song's
-- signature has neither parameter to pass one to. The eight arguments below are
-- everything it still takes positionally before its defaults.
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000e1a2", "role": "authenticated"}';

select lives_ok($$
  select public.update_song(
    (select id from public.songs where legacy_id = 'LEG-SONG-1'),
    'Aguas de Marco', '00000000-0000-0000-0000-00000000e1b1',
    null, null, 'DOMESTIC', 'DUO', 214)
$$, 'update_song replaces the record wholesale, with neither a legacy_id nor an internal_code argument to give it');

reset role;

-- 25: read as the superuser pgTAP connects as, deliberately, same reasoning
-- as 19. This also relies on legacy_id still being 'LEG-SONG-1' to find the
-- row at all — a preview of 26, made explicit there.
select is(
  (select vocal::text from public.songs where legacy_id = 'LEG-SONG-1'),
  'DUO', 'the updated vocal is stored');

-- 26: the direct assertion 0102 exists for. Found by internal_code rather
-- than legacy_id, so this does not lean on the very column it is proving —
-- 'INT-1' is unique to this song among this file's fixtures (the D2
-- duplicate in test 23 carries no internal_code at all). Before 0102,
-- update_song took p_legacy_id defaulting to null and applied it
-- unconditionally; the Songs screen's own form never carried the current
-- value forward (song-fields.tsx's legacy-id input has no `name`
-- attribute), so this is exactly the value an ordinary edit-and-save would
-- have silently nulled.
select is(
  (select legacy_id from public.songs where internal_code = 'INT-1'),
  'LEG-SONG-1',
  'update_song leaves legacy_id untouched — the parameter that could overwrite it is gone (0102)');

-- 26b: 0208's own version of exactly that, and the lookup above already leans on
-- it — if the code had been cleared, test 26 would have found no row and failed
-- for the wrong reason. Made explicit here because the defect is worth naming:
-- Block 27 moved this field to the Integration tab, so the Song data form
-- stopped carrying it, and an update_song that still TOOK it would have read
-- "not carried" and "cleared" as one payload and erased the code on every
-- ordinary save. The value below was written by create_song in test 18 and
-- survived the wholesale update in test 24.
select is(
  (select internal_code from public.songs where legacy_id = 'LEG-SONG-1'),
  'INT-1',
  'update_song leaves internal_code untouched — the parameter that could overwrite it is gone (0208)');

-- 27: an unknown song answers 42501, never P0002 — 0093's rule again. Run
-- under the actor: as the superuser pgTAP connects as, has_permission would
-- read a null auth.uid() and every call would answer 42501 regardless of
-- which id was named, proving nothing about the unknown-id case specifically.
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000e1a2", "role": "authenticated"}';

select throws_ok($$
  select public.archive_song('00000000-0000-0000-0000-00000000e199')
$$, '42501', null, 'an unknown song answers permission denied');

reset role;

-- 28-31: 0103's fix round — assert_song_references_live locks the rows it
-- checks, so archive_music_reference's FOR UPDATE has something to conflict
-- with (the final review's finding I2).
--
-- WHAT THESE FOUR ASSERTIONS DO NOT PROVE, said first so it is not mistaken
-- for more than it is: they do NOT reproduce the race. The race needs two
-- concurrent transactions, and pgTAP runs one — this whole file is a single
-- transaction that ends in `rollback`, so a second session could not even see
-- these fixtures, let alone interleave with them. The two-session interleaving
-- was reproduced against the shipped 0101 body with two real connections
-- (the creator inserts, and a join of live songs against archived artists
-- returns 1) and re-run against 0103's body (the creator is refused with
-- P0002, and the join returns 0); that measurement lives in the block's fix
-- report, not here, because this harness cannot express it.
--
-- What IS expressible here, and is the load-bearing half: whether the function
-- actually takes a row lock. It is worth pinning precisely because the failure
-- mode of this fix is silent — a locking clause written in a shape that parses
-- but locks nothing leaves the race exactly where it was while every comment
-- reads as if it were closed.
--
-- xmax is how a row lock is visible from inside one session: Postgres records
-- a row-level lock in the tuple's xmax field, so after a locking read xmax
-- holds the locking transaction's id instead of 0. Any of the four row-lock
-- modes sets it, and every one of the four conflicts with FOR UPDATE — so
-- "xmax is set by this call" is exactly the property archive_music_reference
-- needs, and does not depend on which mode 0103 happened to choose. The plain
-- `exists (...)` this replaced sets nothing, so 28 would read 0 against the
-- pre-0103 body and fail — which is the point of writing it this way.
--
-- Fixture ids e1b3/e1b4/e1b5, kept apart from e1b1 above: e1b1 has already
-- been locked by create_song's own foreign-key check in tests 18 and 23, so
-- its xmax is set for a reason that has nothing to do with this function.
insert into public.artists (id, organization_id, company_id, name) values
  ('00000000-0000-0000-0000-00000000e1b3', '00000000-0000-0000-0000-00000000e1f1',
   '00000000-0000-0000-0000-00000000e1c1', 'Lock probe'),
  ('00000000-0000-0000-0000-00000000e1b4', '00000000-0000-0000-0000-00000000e1f1',
   '00000000-0000-0000-0000-00000000e1c1', 'Lock probe control'),
  ('00000000-0000-0000-0000-00000000e1b5', '00000000-0000-0000-0000-00000000e1f1',
   '00000000-0000-0000-0000-00000000e1c1', 'Archived before the call');

-- Called directly rather than through create_song, so the lock under test is
-- this function's own: create_song's INSERT would take a foreign-key lock on
-- the same row a moment later, and the assertion could then pass with the
-- function locking nothing at all. Superuser, deliberately — the function
-- holds EXECUTE for nobody, and who may call it is not the claim here. A DO
-- block rather than a bare `select f()` so nothing but TAP reaches pg_prove.
do $$
begin
  perform public.assert_song_references_live(
    '00000000-0000-0000-0000-00000000e1c1',
    '00000000-0000-0000-0000-00000000e1b3',
    null, null);
end $$;

-- 28: the row the call named carries a lock belonging to this transaction.
select isnt(
  (select xmax::text from public.artists
    where id = '00000000-0000-0000-0000-00000000e1b3'),
  '0',
  'assert_song_references_live really takes a row lock on the artist it checks (0103)');

-- 29: and the assertion above is not vacuous — an artist the call did not name
-- is untouched, so 28 is reading this function's lock and not some ambient
-- effect of the fixture inserts.
select is(
  (select xmax::text from public.artists
    where id = '00000000-0000-0000-0000-00000000e1b4'),
  '0',
  'an artist the call did not name carries no lock — 28 is not vacuous');

-- 30-31: the invariant the lock protects, in the form one session can state —
-- an artist archived BEFORE the call is refused. Note honestly that 31 would
-- also pass against the pre-0103 body: the `deleted_at is null` qual caught
-- the sequential case all along, and it is the concurrent case that escaped.
-- It is here so the invariant itself has a pin, not as evidence for the fix.
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000e1a2", "role": "authenticated"}';

select lives_ok($$
  select public.archive_music_reference(
    'ARTIST', '00000000-0000-0000-0000-00000000e1b5')
$$, 'an artist no live song names can be archived');

select throws_ok($$
  select public.create_song(
    '00000000-0000-0000-0000-00000000e1c1', 'Song for an archived artist',
    '00000000-0000-0000-0000-00000000e1b5')
$$, 'P0002', null, 'create_song refuses an artist archived before the call');

reset role;

select * from finish();
rollback;
