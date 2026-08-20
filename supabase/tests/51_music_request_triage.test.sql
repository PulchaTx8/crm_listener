begin;
select plan(39);

-- Block 22, Task 1. The stamps are the truth and the two statuses are derived
-- from them by Postgres (D1), so this file proves the derivation rather than
-- trusting a door to keep two columns in step.

insert into public.organizations (id, name) values
  ('00000000-0000-0000-0000-0000000022f1', 'Org 22 triage');
insert into public.companies (id, organization_id, name, timezone) values
  ('00000000-0000-0000-0000-0000000022c1', '00000000-0000-0000-0000-0000000022f1',
   'Station 22 triage', 'America/Sao_Paulo');
insert into public.artists (id, organization_id, company_id, name) values
  ('00000000-0000-0000-0000-0000000022b1', '00000000-0000-0000-0000-0000000022f1',
   '00000000-0000-0000-0000-0000000022c1', 'Elis Regina');
insert into public.songs (id, organization_id, company_id, title, artist_id) values
  ('00000000-0000-0000-0000-0000000022d1', '00000000-0000-0000-0000-0000000022f1',
   '00000000-0000-0000-0000-0000000022c1', 'Aguas de Marco',
   '00000000-0000-0000-0000-0000000022b1');
insert into public.members (id, organization_id, full_name, phone) values
  ('00000000-0000-0000-0000-0000000022e1', '00000000-0000-0000-0000-0000000022f1',
   'Carla Ouvinte', '+5511988887777');
insert into public.member_company_links (member_id, company_id, organization_id) values
  ('00000000-0000-0000-0000-0000000022e1', '00000000-0000-0000-0000-0000000022c1',
   '00000000-0000-0000-0000-0000000022f1');
-- Stamped three hours behind: Task 3 below adds three more requests (-1h,
-- -2h and -4h, fix round 1), and this one has to be NOT THE NEWEST of the
-- four even though its song's title ('Aguas de Marco') sorts first
-- alphabetically. Without that gap, the default (newest-first) ordering and
-- the song-title ordering agree on this row for free, and the song-sort
-- assertion below would pass whether or not p_sort is honoured (Block 22
-- Task 9 review, finding 1).
insert into public.music_requests
  (id, organization_id, company_id, member_id, song_id, channel, requested_at)
values
  ('00000000-0000-0000-0000-00000000221a', '00000000-0000-0000-0000-0000000022f1',
   '00000000-0000-0000-0000-0000000022c1', '00000000-0000-0000-0000-0000000022e1',
   '00000000-0000-0000-0000-0000000022d1', 'MANUAL', now() - interval '3 hours');

-- 1-2: a request that nobody has touched.
select is(
  (select read_status::text from public.music_requests
    where id = '00000000-0000-0000-0000-00000000221a'),
  'UNREAD', 'a fresh request is UNREAD');
select is(
  (select play_status::text from public.music_requests
    where id = '00000000-0000-0000-0000-00000000221a'),
  'NOT_PLAYED', 'a fresh request is NOT_PLAYED');

-- 3: the stamps decide, and nothing else can be written -- the columns are
-- GENERATED, so there is no second value for a door to forget.
update public.music_requests
   set read_at = now(), played_at = now()
 where id = '00000000-0000-0000-0000-00000000221a';
select is(
  (select read_status::text || '/' || play_status::text from public.music_requests
    where id = '00000000-0000-0000-0000-00000000221a'),
  'READ/PLAYED', 'the two statuses follow their own stamps');

-- 4: refused, not merely unnecessary. A BEFORE UPDATE trigger keeping a
-- hand-written status column in step could never offer this -- it is the one
-- behaviour that tells GENERATED ALWAYS apart from that alternative, the one
-- D1 rejected, and every assertion above would still pass against it.
-- 428C9 is Postgres' own SQLSTATE for generated_always, confirmed by running
-- the statement rather than assumed from memory.
select throws_ok($$
  update public.music_requests set read_status = 'READ'
    where id = '00000000-0000-0000-0000-00000000221a'
$$, '428C9', null, 'a direct write to a generated column is refused outright');

-- 5: cancellation outranks both (D2), which is why cancel_music_request
-- refuses a played request -- see Task 2.
update public.music_requests
   set cancelled_at = now()
 where id = '00000000-0000-0000-0000-00000000221a';
select is(
  (select read_status::text || '/' || play_status::text from public.music_requests
    where id = '00000000-0000-0000-0000-00000000221a'),
  'CANCELLED/CANCELLED', 'a cancelled request reads CANCELLED on both sides');

-- ---------------------------------------------------------------------------
-- Block 22, Task 2. The doors.
-- ---------------------------------------------------------------------------

-- Undo Task 1's direct stamps so the doors act on a fresh request.
update public.music_requests
   set read_at = null, played_at = null, cancelled_at = null
 where id = '00000000-0000-0000-0000-00000000221a';

insert into public.companies (id, organization_id, name, timezone) values
  ('00000000-0000-0000-0000-0000000022c2', '00000000-0000-0000-0000-0000000022f1',
   'Station 22 elsewhere', 'America/Sao_Paulo');

-- The attendant: participations.view (the code D5 gates the three writers on)
-- and music.view, plus members.view so the reveal door can be proved here.
insert into public.roles (id, organization_id, name) values
  ('00000000-0000-0000-0000-0000000022a1', '00000000-0000-0000-0000-0000000022f1',
   'Attendant 22');
insert into public.role_permissions (role_id, permission_code) values
  ('00000000-0000-0000-0000-0000000022a1', 'music.view'),
  ('00000000-0000-0000-0000-0000000022a1', 'participations.view'),
  ('00000000-0000-0000-0000-0000000022a1', 'members.view');
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000022a2', 'attendant-22@example.test');
insert into public.company_memberships (user_id, company_id, organization_id, role_id) values
  ('00000000-0000-0000-0000-0000000022a2', '00000000-0000-0000-0000-0000000022c1',
   '00000000-0000-0000-0000-0000000022f1', '00000000-0000-0000-0000-0000000022a1');

-- The onlooker: music.view alone. Sees the list, attends nothing, and must not
-- learn a telephone number.
insert into public.roles (id, organization_id, name) values
  ('00000000-0000-0000-0000-0000000022a3', '00000000-0000-0000-0000-0000000022f1',
   'Onlooker 22');
insert into public.role_permissions (role_id, permission_code) values
  ('00000000-0000-0000-0000-0000000022a3', 'music.view');
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000022a4', 'onlooker-22@example.test');
insert into public.company_memberships (user_id, company_id, organization_id, role_id) values
  ('00000000-0000-0000-0000-0000000022a4', '00000000-0000-0000-0000-0000000022c1',
   '00000000-0000-0000-0000-0000000022f1', '00000000-0000-0000-0000-0000000022a3');

set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-0000000022a2", "role": "authenticated"}';

-- 6: the read mark lands.
select lives_ok($$
  select public.mark_music_request_read('00000000-0000-0000-0000-00000000221a')
$$, 'mark_music_request_read stamps a request');
-- 7: and the derived status followed it.
select is(
  (select read_status::text from public.music_requests
    where id = '00000000-0000-0000-0000-00000000221a'),
  'READ', 'the read mark shows in read_status');

-- 8: marking twice keeps the FIRST stamp (D4) and writes no second audit row.
-- Read as the superuser pgTAP connects as, deliberately (precedent:
-- 15_music_rpcs.test.sql:109-115) -- audit_logs' own select policies
-- (0006_rls_policies.sql, 0014_rls_1b.sql) admit only a platform admin or a
-- caller holding audit.view, and this attendant holds neither, so under
-- `authenticated` this count would read 0 regardless of whether the door
-- wrote the row -- the write happens either way, through the door's own
-- SECURITY DEFINER body.
select public.mark_music_request_read('00000000-0000-0000-0000-00000000221a');
reset role;
select is(
  (select count(*)::int from public.audit_logs
    where target_id = '00000000-0000-0000-0000-00000000221a'
      and action = 'mark_music_request_read'),
  1, 'a second read mark is a no-op that writes no second audit row');

set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-0000000022a2", "role": "authenticated"}';

-- 9: played is independent of read -- no ordering is imposed (D3).
select lives_ok($$
  select public.mark_music_request_played('00000000-0000-0000-0000-00000000221a')
$$, 'mark_music_request_played stamps a request that was already read');

-- 10: cancelling a played request is refused (D2), because the derivation would
-- erase a play that really happened.
select throws_ok($$
  select public.cancel_music_request('00000000-0000-0000-0000-00000000221a')
$$, '22023', null, 'a request that has played cannot be cancelled');

-- 11: the reveal door returns the whole number to members.view.
select is(
  public.reveal_request_phone('00000000-0000-0000-0000-00000000221a'),
  '+5511988887777', 'reveal_request_phone returns the number to a caller holding members.view');

-- 12: and writes the audit row that is its entire reason to exist. Read as
-- the superuser for the same reason as assertion 8.
reset role;
select is(
  (select count(*)::int from public.audit_logs
    where target_id = '00000000-0000-0000-0000-00000000221a'
      and action = 'reveal_request_phone'),
  1, 'a revealed telephone number leaves a trace');

-- 12a-12b: an archived listener discloses nothing through this door either --
-- members_select_reachable (0035_rls_members.sql:95-100) keeps deleted_at is
-- null OUTSIDE its own bypass, and archive_member (0034_member_rpcs.sql:376)
-- sets it, so an archived row is unselectable to everyone, owner included;
-- this door refuses to disclose what the row-level policy itself would
-- already hide. This is the identical gap Block 30a's Task 2 found and closed
-- in reveal_member_field (0253) -- the sibling door, proved here for THIS
-- door rather than assumed to transfer. AND THE AUDIT ROW IS STILL WRITTEN,
-- because somebody asked and that is the fact being recorded -- the same rule
-- assertion 12 above applies, for the same reason.
--
-- A member of its own, kept apart from 22e1, so archiving it cannot affect
-- any of this file's other assertions -- 22e1 is still in use below (the
-- list-ordering fixtures start at line 236). The request row itself is
-- soft-deleted immediately after use, below, for the same reason: Task 3's
-- list assertions count and order every UNDELETED request at Station 22c1,
-- and this one -- stamped now(), the newest possible -- would otherwise be
-- counted and sorted among them.
insert into public.members (id, organization_id, full_name, phone) values
  ('00000000-0000-0000-0000-0000000022e2', '00000000-0000-0000-0000-0000000022f1',
   'Ouvinte Arquivada 22', '+5511977776666');
insert into public.member_company_links (member_id, company_id, organization_id) values
  ('00000000-0000-0000-0000-0000000022e2', '00000000-0000-0000-0000-0000000022c1',
   '00000000-0000-0000-0000-0000000022f1');
insert into public.music_requests
  (id, organization_id, company_id, member_id, song_id, channel, requested_at)
values
  ('00000000-0000-0000-0000-00000000221f', '00000000-0000-0000-0000-0000000022f1',
   '00000000-0000-0000-0000-0000000022c1', '00000000-0000-0000-0000-0000000022e2',
   '00000000-0000-0000-0000-0000000022d1', 'MANUAL', now());
update public.members set deleted_at = now()
 where id = '00000000-0000-0000-0000-0000000022e2';

set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-0000000022a2", "role": "authenticated"}';
select is(public.reveal_request_phone('00000000-0000-0000-0000-00000000221f'),
  null, 'reveal_request_phone discloses nothing for an archived listener');
reset role;
select is(
  (select count(*)::int from public.audit_logs
    where target_id = '00000000-0000-0000-0000-00000000221f'
      and action = 'reveal_request_phone'),
  1, 'the archived listener''s reveal still leaves a trace');

-- Removed from the list Task 3 below builds and counts -- see the comment
-- above. A direct UPDATE, not a door: no RPC soft-deletes a request in this
-- codebase, cancel_music_request (0190) stamps cancelled_at and leaves the
-- row selectable.
update public.music_requests set deleted_at = now()
 where id = '00000000-0000-0000-0000-00000000221f';

set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-0000000022a4", "role": "authenticated"}';

-- 13-14: music.view alone attends nothing and reveals nothing.
select throws_ok($$
  select public.mark_music_request_read('00000000-0000-0000-0000-00000000221a')
$$, '42501', null, 'music.view alone cannot mark a request read');
select throws_ok($$
  select public.reveal_request_phone('00000000-0000-0000-0000-00000000221a')
$$, '42501', null, 'music.view alone cannot reveal a telephone number');

reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-0000000022a2", "role": "authenticated"}';

-- 15: an id that names nothing answers exactly what an unreachable Station
-- answers -- permission before existence (0093's idiom).
select throws_ok($$
  select public.mark_music_request_read('00000000-0000-0000-0000-0000000000ff')
$$, '42501', null, 'an unknown request id is refused the way an unreachable one is');

reset role;

-- ---------------------------------------------------------------------------
-- Block 22, Task 3. The list.
-- ---------------------------------------------------------------------------

-- Three more requests, so ordering and limits have something to order and
-- cut -- four in all with 221a. 221d is the one fix round 1 added, and this
-- is why: 221b and 221c share an artist, and 221b is ALSO the newest row of
-- the fixture (-1h). So the correct artist-sort answer was 'Adoniran
-- Barbosa' and a fallback-to-newest bug's answer was 221b, whose artist is
-- 'Adoniran Barbosa' as well -- the same string either way, once 221a stopped
-- being the newest (finding 1's fix). Same mechanism broke the show-sort
-- assertion: 221b was the only row that carried a show at all, so it was both
-- the correct answer and the fallback's.
-- 221d gets its OWN artist and its OWN show, each named to sort first
-- alphabetically among this fixture's artists/shows, and a timestamp that is
-- NOT the newest -- so the correct artist/show answer and the
-- fallback-to-newest answer are two different rows again.
insert into public.artists (id, organization_id, company_id, name) values
  ('00000000-0000-0000-0000-0000000022b2', '00000000-0000-0000-0000-0000000022f1',
   '00000000-0000-0000-0000-0000000022c1', 'Adoniran Barbosa'),
  ('00000000-0000-0000-0000-0000000022b3', '00000000-0000-0000-0000-0000000022f1',
   '00000000-0000-0000-0000-0000000022c1', 'Ademar Duarte');
insert into public.songs (id, organization_id, company_id, title, artist_id) values
  ('00000000-0000-0000-0000-0000000022d2', '00000000-0000-0000-0000-0000000022f1',
   '00000000-0000-0000-0000-0000000022c1', 'Trem das Onze',
   '00000000-0000-0000-0000-0000000022b2'),
  ('00000000-0000-0000-0000-0000000022d3', '00000000-0000-0000-0000-0000000022f1',
   '00000000-0000-0000-0000-0000000022c1', 'Nova Trilha',
   '00000000-0000-0000-0000-0000000022b3');
insert into public.shows (id, organization_id, company_id, name) values
  ('00000000-0000-0000-0000-0000000022aa', '00000000-0000-0000-0000-0000000022f1',
   '00000000-0000-0000-0000-0000000022c1', 'Manha Musical'),
  ('00000000-0000-0000-0000-0000000022ab', '00000000-0000-0000-0000-0000000022f1',
   '00000000-0000-0000-0000-0000000022c1', 'Bom Dia');
insert into public.music_requests
  (id, organization_id, company_id, member_id, song_id, show_id, channel, requested_at)
values
  ('00000000-0000-0000-0000-00000000221b', '00000000-0000-0000-0000-0000000022f1',
   '00000000-0000-0000-0000-0000000022c1', '00000000-0000-0000-0000-0000000022e1',
   '00000000-0000-0000-0000-0000000022d2', '00000000-0000-0000-0000-0000000022aa',
   'MANUAL', now() - interval '1 hour'),
  ('00000000-0000-0000-0000-00000000221c', '00000000-0000-0000-0000-0000000022f1',
   '00000000-0000-0000-0000-0000000022c1', '00000000-0000-0000-0000-0000000022e1',
   '00000000-0000-0000-0000-0000000022d2', null,
   'MANUAL', now() - interval '2 hours'),
  ('00000000-0000-0000-0000-00000000221d', '00000000-0000-0000-0000-0000000022f1',
   '00000000-0000-0000-0000-0000000022c1', '00000000-0000-0000-0000-0000000022e1',
   '00000000-0000-0000-0000-0000000022d3', '00000000-0000-0000-0000-0000000022ab',
   'MANUAL', now() - interval '4 hours');

set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-0000000022a2", "role": "authenticated"}';

-- 16: four digits, never the number. This is D8's whole point: the browser is
-- not sent something it has to be trusted to hide.
select is(
  (select member_phone_last4 from public.list_music_requests('00000000-0000-0000-0000-0000000022c1')
    where request_id = '00000000-0000-0000-0000-00000000221a'),
  '7777', 'the list returns four digits of the telephone number');

-- 17: and the OTHER half of D8 -- withheld outright, not merely masked, for a
-- caller who does not hold members.view. Assertion 16 above runs as the
-- attendant, who HOLDS members.view, so it proves only that the column is
-- populated; only the onlooker (music.view alone) proves the `else null` half
-- of the projection actually withholds it (Block 22 Task 9 review, finding 3).
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-0000000022a4", "role": "authenticated"}';
select is(
  (select member_phone_last4 from public.list_music_requests('00000000-0000-0000-0000-0000000022c1')
    where request_id = '00000000-0000-0000-0000-00000000221a'),
  null, 'member_phone_last4 is withheld from a caller without members.view');
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-0000000022a2", "role": "authenticated"}';

-- 18: and there is no column carrying the whole one. Asked of the function's
-- RESULT shape rather than of a row, because a column that was removed cannot
-- be selected to prove its own absence -- the query would fail to parse rather
-- than fail an assertion, and a parse error is not a test result.
select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'list_music_requests'
      and pg_get_function_result(p.oid) like '%member_phone_last4%'
      and pg_get_function_result(p.oid) not like '%member_phone text%'),
  1, 'the list offers four digits and no whole-number column at all');

-- 19-20: the two status columns arrive with the row.
select is(
  (select read_status::text from public.list_music_requests('00000000-0000-0000-0000-0000000022c1')
    where request_id = '00000000-0000-0000-0000-00000000221a'),
  'READ', 'read_status comes with the row');
select is(
  (select play_status::text from public.list_music_requests('00000000-0000-0000-0000-0000000022c1')
    where request_id = '00000000-0000-0000-0000-00000000221a'),
  'PLAYED', 'play_status comes with the row');

-- 21-22: the two status filters narrow. Three untouched requests now
-- (221b, 221c, 221d) since fix round 1 added 221d as UNREAD/NOT_PLAYED;
-- the PLAYED count is unaffected -- 221a is still the only one that went
-- to air.
select is(
  (select count(*)::int from public.list_music_requests(
     '00000000-0000-0000-0000-0000000022c1', null, null, null, null, 'UNREAD')),
  3, 'the read-status filter narrows to the untouched requests');
select is(
  (select count(*)::int from public.list_music_requests(
     '00000000-0000-0000-0000-0000000022c1', null, null, null, null, null, 'PLAYED')),
  1, 'the play-status filter narrows to the one that went to air');

-- 23: ordering by song title, A to Z. The cut is made by the function's OWN
-- p_limit, not by a `limit 1` outside it: a set-returning function in a FROM
-- clause carries no ordering guarantee to the query above it, so an outer LIMIT
-- would be asserting on whichever row the planner happened to hand over first.
-- Discriminates from the default ordering only because the fixture above puts
-- 'Aguas de Marco' at -3h, NOT the newest of the four -- were it the newest
-- (as it was before that re-timing), this would pass under plain
-- requested_at ordering too (Block 22 Task 9 review, finding 1).
select is(
  (select song_title from public.list_music_requests(
     '00000000-0000-0000-0000-0000000022c1', null, null, null, null, null, null,
     'song', null, null, false, 1)),
  'Aguas de Marco', 'ordering by song puts the first title first');

-- 24: ordering by artist, A to Z, cut the same way. 221d's artist ('Ademar
-- Duarte') is the correct answer -- it sorts before 'Adoniran Barbosa'
-- (221b/221c's shared artist) and before 'Elis Regina' (221a's). NOT
-- 'Adoniran Barbosa': that was 221b's answer while 221b was ALSO the newest
-- row, so a fallback-to-requested-at-desc bug scored an accidental pass
-- (fix round 1, Important finding). 221d is stamped -4h, the OLDEST of the
-- four, so the fallback's answer (221b, newest) and the correct answer
-- (221d) are now different rows.
select is(
  (select artist_name from public.list_music_requests(
     '00000000-0000-0000-0000-0000000022c1', null, null, null, null, null, null,
     'artist', null, null, false, 1)),
  'Ademar Duarte', 'ordering by artist puts the first name first');

-- 25: ordering by show, nulls last. 221d's show ('Bom Dia') is the correct
-- answer -- it sorts before 'Manha Musical' (221b's) and every other row is
-- null. NOT 'Manha Musical': that was 221b's answer while 221b was ALSO the
-- newest row, so a fallback-to-requested-at-desc bug -- the exact defect
-- class finding 1 exists to catch -- scored an accidental pass here too
-- (fix round 1, Important finding). 221d's -4h stamp is the oldest of the
-- four, so the fallback's answer (221b) and the correct answer (221d)
-- disagree, the same fix applied to the artist case just above.
select is(
  (select show_name from public.list_music_requests(
     '00000000-0000-0000-0000-0000000022c1', null, null, null, null, null, null,
     'show', null, null, false, 1)),
  'Bom Dia', 'ordering by show puts the first show first, nulls last');

-- 26: the limit cuts.
select is(
  (select count(*)::int from public.list_music_requests(
     '00000000-0000-0000-0000-0000000022c1', null, null, null, null, null, null,
     'song', null, null, false, 1)),
  1, 'the limit returns exactly as many rows as it asks for');

-- 27: an unrecognised sort key falls back to the requested_at ordering
-- (newest first) rather than raising. Asserted on the actual FIRST ROW under
-- p_limit 1 rather than on a row count: a count of 4 is what ANY non-raising
-- fallback would also produce (arbitrary order, no order at all, or a crash
-- swallowed somewhere upstream), so it never actually pinned "falls back to
-- newest-first" (Block 22 Task 9 review, finding 2). 221b is the newest of
-- the four (-1h, against 221c's -2h, 221a's -3h and 221d's -4h).
select is(
  (select request_id from public.list_music_requests(
     '00000000-0000-0000-0000-0000000022c1', null, null, null, null, null, null,
     'nonsense', null, null, false, 1)),
  '00000000-0000-0000-0000-00000000221b',
  'an unknown sort key falls back to newest-first rather than raising');

-- 28: the cursor is ignored under a text ordering -- the guard 0191's own
-- comment names ("to make impossible rather than merely unlikely"), pinned
-- here rather than left to the comment alone (Block 22 Task 9 review, finding
-- 4). p_cursor_at sits strictly between 221b's -1h and 221c's -2h, so a cursor
-- WRONGLY applied under a text sort (p_walking_back false: keep only
-- requested_at < p_cursor_at) would exclude 221b alone -- 221a (-3h), 221c
-- (-2h) and 221d (-4h) all satisfy "< 90 minutes ago" and would still be kept
-- -- and return 3 rows; the guard means it is never applied at all, and the
-- whole batch of 4 comes back.
select is(
  (select count(*)::int from public.list_music_requests(
     '00000000-0000-0000-0000-0000000022c1', null, null, null, null, null, null,
     'song', now() - interval '90 minutes', '00000000-0000-0000-0000-00000000221b',
     false, 51)),
  4, 'a cursor passed alongside a text ordering is ignored, returning the whole batch');

reset role;

-- ---------------------------------------------------------------------------
-- Fix round 2, Important 2. cancel_music_request's SUCCESS path.
--
-- Everything above touches that door exactly once, at assertion 10, and that
-- is a throws_ok: nothing in this repository had ever cancelled a request and
-- looked at the result. So its UPDATE, its audit row, its second-call no-op
-- (D4) and the CANCELLED/CANCELLED derivation THROUGH THE DOOR were all
-- unproven -- assertion 5 above derives the same pair from a hand-written
-- `update`, which is a different statement in a different file. plpgsql
-- resolves identifiers at run time, so a column renamed out from under that
-- branch raises nothing until somebody presses the button in production.
--
-- A SECOND request, inserted HERE rather than beside the other four: every
-- assertion above has already run by this point. Several of them count rows,
-- name the newest row or read the whole batch, and fix round 1 already had to
-- add a fourth row and re-time a third to decouple two orderings from each
-- other -- a fifth row placed up there would have to be decoupled against all
-- of them again, for no gain.
-- ---------------------------------------------------------------------------

insert into public.music_requests
  (id, organization_id, company_id, member_id, song_id, channel, requested_at)
values
  ('00000000-0000-0000-0000-00000000221e', '00000000-0000-0000-0000-0000000022f1',
   '00000000-0000-0000-0000-0000000022c1', '00000000-0000-0000-0000-0000000022e1',
   '00000000-0000-0000-0000-0000000022d1', 'MANUAL', now() - interval '5 hours');

set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-0000000022a2", "role": "authenticated"}';

-- 29: the door calls a request off without raising.
select lives_ok($$
  select public.cancel_music_request('00000000-0000-0000-0000-00000000221e')
$$, 'cancel_music_request calls off a request that has not played');

-- 30: and BOTH derived statuses follow the stamp the DOOR wrote (D2). This is
-- assertion 5's pair reached through the function rather than through a
-- hand-written update -- the two prove different things, and only this one
-- proves the door writes cancelled_at at all.
select is(
  (select read_status::text || '/' || play_status::text from public.music_requests
    where id = '00000000-0000-0000-0000-00000000221e'),
  'CANCELLED/CANCELLED', 'a request called off through the door reads CANCELLED on both sides');

-- 31: one audit row for the one call-off. Read as the superuser pgTAP
-- connects as, for assertion 8's reason: audit_logs' select policies admit a
-- platform admin or a caller holding audit.view, and this attendant is
-- neither, so under `authenticated` the count reads 0 whatever the door did.
reset role;
select is(
  (select count(*)::int from public.audit_logs
    where target_id = '00000000-0000-0000-0000-00000000221e'
      and action = 'cancel_music_request'),
  1, 'calling a request off leaves exactly one audit row');

set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-0000000022a2", "role": "authenticated"}';

-- 32-33: a second call-off is a no-op, not an error and not a second row (D4).
select lives_ok($$
  select public.cancel_music_request('00000000-0000-0000-0000-00000000221e')
$$, 'a second call-off is accepted rather than raising');
reset role;
select is(
  (select count(*)::int from public.audit_logs
    where target_id = '00000000-0000-0000-0000-00000000221e'
      and action = 'cancel_music_request'),
  1, 'a second call-off writes no second audit row');

set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-0000000022a2", "role": "authenticated"}';

-- 34: and the mirror of assertion 10 -- a cancelled request cannot then be
-- marked read. This is the refusal the attend window now keeps off the screen
-- (fix round 2, Important 1): the button used to be offered on a cancelled
-- request, so a raw English 22023 was three clicks away in any locale rather
-- than reachable only by a race, which is the whole argument section 5 of the
-- design rests on.
select throws_ok($$
  select public.mark_music_request_read('00000000-0000-0000-0000-00000000221e')
$$, '22023', null, 'a request that has been called off cannot be marked read');

reset role;

-- ---------------------------------------------------------------------------
-- Fix round 2, Important 3. D7's second clamp, at the function.
--
-- The clamp needs MORE ROWS THAN THE CAP to prove anything at all: against
-- this file's five requests, "p_limit 2000000000 returns 5 rows" is true of
-- the clamped function and of the unclamped one alike, and an assertion that
-- passes either way is decoration. So a Station of its own, with 201 rows in
-- it -- one past the cap, which is the smallest fixture that can tell 200
-- from "all of them".
--
-- ITS OWN STATION, and inserted here, for the reason the block above gives:
-- 201 extra rows in Station 22c1 would break the four ordering assertions,
-- both status counts and the cursor assertion, all of which count or name
-- rows in that Station's whole batch.
-- ---------------------------------------------------------------------------

insert into public.companies (id, organization_id, name, timezone) values
  ('00000000-0000-0000-0000-0000000022c3', '00000000-0000-0000-0000-0000000022f1',
   'Station 22 bulk', 'America/Sao_Paulo');
insert into public.artists (id, organization_id, company_id, name) values
  ('00000000-0000-0000-0000-0000000022b4', '00000000-0000-0000-0000-0000000022f1',
   '00000000-0000-0000-0000-0000000022c3', 'Zulmira Volume');
insert into public.songs (id, organization_id, company_id, title, artist_id) values
  ('00000000-0000-0000-0000-0000000022d4', '00000000-0000-0000-0000-0000000022f1',
   '00000000-0000-0000-0000-0000000022c3', 'Uma So Cancao',
   '00000000-0000-0000-0000-0000000022b4');
-- The same attendant, so the assertion below reads through the same grant a
-- real caller holds: authenticated, music.view, nothing special.
insert into public.company_memberships (user_id, company_id, organization_id, role_id) values
  ('00000000-0000-0000-0000-0000000022a2', '00000000-0000-0000-0000-0000000022c3',
   '00000000-0000-0000-0000-0000000022f1', '00000000-0000-0000-0000-0000000022a1');
insert into public.music_requests
  (organization_id, company_id, member_id, song_id, channel, requested_at)
select '00000000-0000-0000-0000-0000000022f1',
       '00000000-0000-0000-0000-0000000022c3',
       '00000000-0000-0000-0000-0000000022e1',
       '00000000-0000-0000-0000-0000000022d4',
       'MANUAL',
       now() - (n || ' minutes')::interval
  from generate_series(1, 201) as n;

set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-0000000022a2", "role": "authenticated"}';

-- 35: an absurd p_limit is cut to the cap. Two thousand million is what a
-- caller types into a POST body against PostgREST; before the clamp it read
-- all 201 rows, and would have read a Station's whole request table.
select is(
  (select count(*)::int from public.list_music_requests(
     '00000000-0000-0000-0000-0000000022c3', null, null, null, null, null, null,
     null, null, null, false, 2000000000)),
  200, 'an absurd p_limit is clamped to 200 rows at the function');

-- 36-37: and the other end of the same clamp. A negative p_limit used to be a
-- 2201W raised by LIMIT itself -- an error page rather than a page of rows --
-- and 0 used to be a legitimately empty list from a list that is never
-- legitimately empty. Both now read as the minimum.
select is(
  (select count(*)::int from public.list_music_requests(
     '00000000-0000-0000-0000-0000000022c3', null, null, null, null, null, null,
     null, null, null, false, -1)),
  1, 'a negative p_limit is clamped up to one row rather than raising');
select is(
  (select count(*)::int from public.list_music_requests(
     '00000000-0000-0000-0000-0000000022c3', null, null, null, null, null, null,
     null, null, null, false, 0)),
  1, 'a zero p_limit is clamped up to one row rather than returning nothing');

reset role;

select * from finish();
rollback;
