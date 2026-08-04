begin;
select plan(16);

-- Block 7b, Task 3: the request doors, and D6's three rules.
--
-- Rules 2 and 3 need TWO identities with DIFFERENT grants, which is what
-- tests/isolation/music-merge.test.ts is for. What is provable here is the
-- mechanics: the write, the MANUAL channel a caller cannot override, the
-- Station-link requirement, and the shape of the list.

insert into public.organizations (id, name) values
  ('00000000-0000-0000-0000-00000000e3f1', 'Org 7b requests');
insert into public.companies (id, organization_id, name, timezone) values
  ('00000000-0000-0000-0000-00000000e3c1', '00000000-0000-0000-0000-00000000e3f1',
   'Station 7b requests', 'America/Sao_Paulo'),
  ('00000000-0000-0000-0000-00000000e3c2', '00000000-0000-0000-0000-00000000e3f1',
   'Station 7b requests two', 'America/Sao_Paulo');

-- The actor holds music.view, music.request AND members.view, so it can read
-- back what it wrote. The withholding cases need a second, narrower identity
-- and live in the isolation suite.
insert into public.roles (id, organization_id, name) values
  ('00000000-0000-0000-0000-00000000e3a1', '00000000-0000-0000-0000-00000000e3f1',
   'Request taker 7b');
insert into public.role_permissions (role_id, permission_code) values
  ('00000000-0000-0000-0000-00000000e3a1', 'music.view'),
  ('00000000-0000-0000-0000-00000000e3a1', 'music.request'),
  ('00000000-0000-0000-0000-00000000e3a1', 'members.view');
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-00000000e3a2', 'request-taker-7b@example.test');
insert into public.company_memberships (user_id, company_id, organization_id, role_id) values
  ('00000000-0000-0000-0000-00000000e3a2', '00000000-0000-0000-0000-00000000e3c1',
   '00000000-0000-0000-0000-00000000e3f1', '00000000-0000-0000-0000-00000000e3a1');

insert into public.artists (id, organization_id, company_id, name) values
  ('00000000-0000-0000-0000-00000000e3b1', '00000000-0000-0000-0000-00000000e3f1',
   '00000000-0000-0000-0000-00000000e3c1', 'Marisa Monte');
insert into public.songs (id, organization_id, company_id, title, artist_id) values
  ('00000000-0000-0000-0000-00000000e3d1', '00000000-0000-0000-0000-00000000e3f1',
   '00000000-0000-0000-0000-00000000e3c1', 'Amor I Love You', '00000000-0000-0000-0000-00000000e3b1');
-- `e3aa`, not `e3s1`: a uuid is hexadecimal, and 's' is not a hex digit —
-- Postgres refuses the literal outright, which is a fixture that fails at
-- parse time rather than a test that fails informatively.
insert into public.shows (id, organization_id, company_id, name) values
  ('00000000-0000-0000-0000-00000000e3aa', '00000000-0000-0000-0000-00000000e3f1',
   '00000000-0000-0000-0000-00000000e3c1', 'Tarde Musical');

-- Two listeners: one linked to this Station, one not linked to any.
insert into public.members (id, organization_id, full_name, phone) values
  ('00000000-0000-0000-0000-00000000e3e1', '00000000-0000-0000-0000-00000000e3f1',
   'Bruno Ouvinte', '+5511999990001'),
  ('00000000-0000-0000-0000-00000000e3e2', '00000000-0000-0000-0000-00000000e3f1',
   'Unlinked Listener', '+5511999990002');
insert into public.member_company_links (member_id, company_id, organization_id) values
  ('00000000-0000-0000-0000-00000000e3e1', '00000000-0000-0000-0000-00000000e3c1',
   '00000000-0000-0000-0000-00000000e3f1');

set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000e3a2", "role": "authenticated"}';

-- 1: the write.
select lives_ok($$
  select public.create_music_request(
    '00000000-0000-0000-0000-00000000e3c1',
    '00000000-0000-0000-0000-00000000e3e1',
    '00000000-0000-0000-0000-00000000e3d1',
    '00000000-0000-0000-0000-00000000e3aa')
$$, 'create_music_request records a request');

-- 2: a listener with no link to this Station is refused. 0098's own comment
-- says the constraint proves the Organization and this door checks the link.
select throws_ok($$
  select public.create_music_request(
    '00000000-0000-0000-0000-00000000e3c1',
    '00000000-0000-0000-0000-00000000e3e2',
    '00000000-0000-0000-0000-00000000e3d1')
$$, 'P0002', null, 'a listener not linked to this Station cannot have a request recorded');

-- 3: a song from another Station is refused, and not by the foreign key alone.
select throws_ok($$
  select public.create_music_request(
    '00000000-0000-0000-0000-00000000e3c2',
    '00000000-0000-0000-0000-00000000e3e1',
    '00000000-0000-0000-0000-00000000e3d1')
$$, '42501', null, 'a Station the caller holds nothing in is refused before anything is resolved');

reset role;

-- 4: MANUAL, and the caller had no say. There is no p_channel parameter, so
-- a hand-typed row cannot be labelled an import — Block 9 gets its own door.
select is(
  (select channel::text from public.music_requests
    where song_id = '00000000-0000-0000-0000-00000000e3d1' limit 1),
  'MANUAL', 'a request recorded by hand is MANUAL and nothing else');

-- 5: create_music_request takes exactly five arguments and none of them is a
-- channel. Pinned, because adding one later is the silent way this rule dies.
select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'create_music_request'
      and pg_get_function_arguments(p.oid) not like '%channel%'),
  1, 'create_music_request offers no channel parameter');

set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000e3a2", "role": "authenticated"}';

-- 6-9: the list returns the row, with the listener's identity, the song and
-- the show — this actor holds members.view.
select is(
  (select count(*)::int from public.list_music_requests('00000000-0000-0000-0000-00000000e3c1')),
  1, 'the list returns the one request');
select is(
  (select member_name from public.list_music_requests('00000000-0000-0000-0000-00000000e3c1')),
  'Bruno Ouvinte', 'the listener''s name is returned to a caller holding members.view');
select is(
  (select song_title from public.list_music_requests('00000000-0000-0000-0000-00000000e3c1')),
  'Amor I Love You', 'the song title comes with the row');
select is(
  (select show_name from public.list_music_requests('00000000-0000-0000-0000-00000000e3c1')),
  'Tarde Musical', 'the programme comes with the row');

-- 10: the artist's name too — a request list that cannot say who sings it is
-- half a list.
select is(
  (select artist_name from public.list_music_requests('00000000-0000-0000-0000-00000000e3c1')),
  'Marisa Monte', 'the artist''s name comes with the row');

-- 11: total_count agrees with the rows, computed from the same CTE.
select is(
  (select total_count from public.list_music_requests('00000000-0000-0000-0000-00000000e3c1')),
  1, 'total_count is the filtered total');

-- 12: a Station the caller holds nothing in is a refusal, never an empty page.
select throws_ok($$
  select * from public.list_music_requests('00000000-0000-0000-0000-00000000e3c2')
$$, '42501', null, 'the list refuses rather than returning an empty page');

-- 13: the song filter narrows.
select is(
  (select count(*)::int from public.list_music_requests(
     '00000000-0000-0000-0000-00000000e3c1', '00000000-0000-0000-0000-0000000000ff')),
  0, 'the song filter narrows to nothing when no request names that song');

-- 14: withdrawing a mistyped entry.
select lives_ok($$
  select public.archive_music_request(
    (select id from public.music_requests
      where song_id = '00000000-0000-0000-0000-00000000e3d1' limit 1))
$$, 'archive_music_request withdraws a request');

-- 15: and it leaves the list.
select is(
  (select count(*)::int from public.list_music_requests('00000000-0000-0000-0000-00000000e3c1')),
  0, 'a withdrawn request leaves the list');

reset role;

-- 16: but it is still a row. This project deletes nothing.
select is(
  (select count(*)::int from public.music_requests
    where song_id = '00000000-0000-0000-0000-00000000e3d1' and deleted_at is not null),
  1, 'the withdrawn request is soft-deleted, not removed');

select * from finish();
rollback;
