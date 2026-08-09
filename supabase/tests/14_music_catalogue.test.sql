begin;
select plan(40);

-- Block 7a, Task 1: the acervo's shape.
--
-- Fixtures live in the ...00e0xx range. 12_deadline_clock owns ...00d0xx,
-- 12b ...00d1xx and 13_pickup_reads ...00d2xx; a collision would fail in
-- whichever file ran second. 15_music_rpcs owns ...00e1xx.

insert into public.organizations (id, name) values
  ('00000000-0000-0000-0000-00000000e0f1', 'Org 7a catalogue'),
  ('00000000-0000-0000-0000-00000000e0f2', 'Org 7a other');
insert into public.companies (id, organization_id, name, timezone) values
  ('00000000-0000-0000-0000-00000000e0c1', '00000000-0000-0000-0000-00000000e0f1',
   'Station 7a A', 'America/Sao_Paulo'),
  ('00000000-0000-0000-0000-00000000e0c2', '00000000-0000-0000-0000-00000000e0f1',
   'Station 7a B', 'America/Sao_Paulo'),
  ('00000000-0000-0000-0000-00000000e0c3', '00000000-0000-0000-0000-00000000e0f2',
   'Station 7a elsewhere', 'America/Sao_Paulo');

-- 1-6: the six tables §4.2 names.
select has_table('public', 'music_genres',   'music_genres exists');
select has_table('public', 'record_labels',  'record_labels exists');
select has_table('public', 'artists',        'artists exists');
select has_table('public', 'shows',          'shows exists');
select has_table('public', 'songs',          'songs exists');
select has_table('public', 'music_requests', 'music_requests exists');

-- 7-9: the three enums, whole. Equality against the full array rather than
-- a per-label check: vocal has FIVE values and not the two §4.2 named (D-§3.2),
-- and an assertion that only proves MALE and FEMALE exist would pass over
-- exactly the mistake this is here to prevent.
select is(
  enum_range(null::public.music_nationality)::text[],
  array['DOMESTIC', 'INTERNATIONAL'],
  'music_nationality is DOMESTIC | INTERNATIONAL');
select is(
  enum_range(null::public.music_vocal)::text[],
  array['MALE', 'FEMALE', 'DUO', 'GROUP', 'INSTRUMENTAL'],
  'music_vocal carries all five, not the two §4.2 named');
-- Block 15 added API, in a migration of its own (0151) because ALTER TYPE ...
-- ADD VALUE cannot share a transaction with a statement that uses the value.
-- WHATSAPP is still absent, and its absence is still the point 0098 made: that
-- value is reserved for this product's OWN bot, reading inbound messages
-- through the Meta webhook. API means a third-party application posted over
-- HTTP -- which is a different path even when that application happens to be
-- attending the listener on WhatsApp.
select is(
  enum_range(null::public.music_request_channel)::text[],
  array['MANUAL', 'IMPORT', 'API'],
  'music_request_channel gained API in Block 15; WHATSAPP is still reserved for our own bot');

-- 10-13: what may not be null. A song without an artist is a draft (§3.2);
-- a request always names a listener and a catalogued song (D5).
select col_not_null('public', 'songs', 'title', 'songs.title is not null');
select col_not_null('public', 'songs', 'artist_id', 'songs.artist_id is not null');
select col_not_null('public', 'music_requests', 'member_id', 'music_requests.member_id is not null');
select col_not_null('public', 'music_requests', 'song_id', 'music_requests.song_id is not null');

-- 14: no status column on songs. Deliberately absent (§3.2) — nobody here
-- knows what catalog_medias.status means, and Block 9 is to check it against
-- the real source. Pinned so it is not added absent-mindedly.
select hasnt_column('public', 'songs', 'status', 'songs carries no status column');

-- Fixtures for the constraint cases.
insert into public.artists (id, organization_id, company_id, name) values
  ('00000000-0000-0000-0000-00000000e0a1', '00000000-0000-0000-0000-00000000e0f1',
   '00000000-0000-0000-0000-00000000e0c1', 'Caetano Veloso'),
  ('00000000-0000-0000-0000-00000000e0a2', '00000000-0000-0000-0000-00000000e0f1',
   '00000000-0000-0000-0000-00000000e0c2', 'Caetano Veloso');

-- 15: D1 in one row. The same artist registered twice, once per Station,
-- is two rows and no complaint.
select is(
  (select count(*)::int from public.artists
    where name = 'Caetano Veloso'
      and company_id in ('00000000-0000-0000-0000-00000000e0c1',
                         '00000000-0000-0000-0000-00000000e0c2')),
  2,
  'a group with two Stations registers the same artist twice (D1)');

insert into public.songs (id, organization_id, company_id, title, artist_id) values
  ('00000000-0000-0000-0000-00000000e0b1', '00000000-0000-0000-0000-00000000e0f1',
   '00000000-0000-0000-0000-00000000e0c1', 'Sozinho', '00000000-0000-0000-0000-00000000e0a1');

-- 16: D2. The same title by the same artist, twice, is allowed — a
-- re-recording, a live version and a remix are all of them that, and the
-- maintenance screen is the cure.
select lives_ok($$
  insert into public.songs (organization_id, company_id, title, artist_id)
  values ('00000000-0000-0000-0000-00000000e0f1', '00000000-0000-0000-0000-00000000e0c1',
          'Sozinho', '00000000-0000-0000-0000-00000000e0a1')
$$, 'a duplicate song is allowed and fixed afterwards (D2)');

-- 17: the composite foreign key, which is the whole reason songs carries
-- company_id as well as organization_id. Station B's artist on Station A's
-- song is refused by a constraint, not by a screen.
select throws_ok($$
  insert into public.songs (organization_id, company_id, title, artist_id)
  values ('00000000-0000-0000-0000-00000000e0f1', '00000000-0000-0000-0000-00000000e0c1',
          'Borrowed', '00000000-0000-0000-0000-00000000e0a2')
$$, '23503', null, 'a song cannot name an artist from another Station');

-- 18: a duration is whole seconds and a positive number of them (§3.2).
select throws_ok($$
  insert into public.songs (organization_id, company_id, title, artist_id, duration_seconds)
  values ('00000000-0000-0000-0000-00000000e0f1', '00000000-0000-0000-0000-00000000e0c1',
          'Zero length', '00000000-0000-0000-0000-00000000e0a1', 0)
$$, '23514', null, 'duration_seconds must be greater than zero');

-- 19: a blank title is not a title.
select throws_ok($$
  insert into public.songs (organization_id, company_id, title, artist_id)
  values ('00000000-0000-0000-0000-00000000e0f1', '00000000-0000-0000-0000-00000000e0c1',
          '   ', '00000000-0000-0000-0000-00000000e0a1')
$$, '23514', null, 'a blank title is refused');

-- 20-21: D7. legacy_id is unique per Station when present, and NOT unique
-- across them — the acervo replicates once per Station (D1), so the same
-- legacy row lands in every Station with the same handle.
update public.songs set legacy_id = 'LEG-1'
 where id = '00000000-0000-0000-0000-00000000e0b1';

select throws_ok($$
  insert into public.songs (organization_id, company_id, title, artist_id, legacy_id)
  values ('00000000-0000-0000-0000-00000000e0f1', '00000000-0000-0000-0000-00000000e0c1',
          'Second import', '00000000-0000-0000-0000-00000000e0a1', 'LEG-1')
$$, '23505', null, 'one legacy row imports once per Station (D7)');

select lives_ok($$
  insert into public.songs (organization_id, company_id, title, artist_id, legacy_id)
  values ('00000000-0000-0000-0000-00000000e0f1', '00000000-0000-0000-0000-00000000e0c2',
          'Sozinho', '00000000-0000-0000-0000-00000000e0a2', 'LEG-1')
$$, 'the same legacy_id may appear once in each Station (D1 + D7)');

-- 22: two songs with no legacy_id at all must not collide — the partial
-- index is what makes the nullable handle usable, and prizes.internal_code
-- (0025) had this same trap.
select lives_ok($$
  insert into public.songs (organization_id, company_id, title, artist_id)
  values ('00000000-0000-0000-0000-00000000e0f1', '00000000-0000-0000-0000-00000000e0c1',
          'No handle A', '00000000-0000-0000-0000-00000000e0a1'),
         ('00000000-0000-0000-0000-00000000e0f1', '00000000-0000-0000-0000-00000000e0c1',
          'No handle B', '00000000-0000-0000-0000-00000000e0a1')
$$, 'two songs without a legacy_id do not collide');

-- 23: the four codes appear in the catalogue, so they appear in the role
-- editor without that screen being touched (the check 0025 makes for its own).
select is(
  (select count(*)::int from public.permissions
    where code in ('music.view', 'music.manage', 'music.request', 'music.merge')),
  4,
  'the four music permissions are in the catalogue');

-- 24: music.merge is its own code, not folded into manage (D8).
select isnt(
  (select code from public.permissions where code = 'music.merge'),
  null,
  'music.merge is a code of its own — the only one that destroys');

-- 25-30: RLS is on. A table this migration misses looks exactly like a table
-- that never needed securing — this project has shipped that mistake once
-- already (rate_limit_counters, Block 0) — so the state is asserted rather
-- than left to whoever reads the migration list.
select is(relrowsecurity, true, 'RLS enabled on music_genres')
  from pg_class where oid = 'public.music_genres'::regclass;
select is(relrowsecurity, true, 'RLS enabled on record_labels')
  from pg_class where oid = 'public.record_labels'::regclass;
select is(relrowsecurity, true, 'RLS enabled on artists')
  from pg_class where oid = 'public.artists'::regclass;
select is(relrowsecurity, true, 'RLS enabled on shows')
  from pg_class where oid = 'public.shows'::regclass;
select is(relrowsecurity, true, 'RLS enabled on songs')
  from pg_class where oid = 'public.songs'::regclass;
select is(relrowsecurity, true, 'RLS enabled on music_requests')
  from pg_class where oid = 'public.music_requests'::regclass;

-- 31-36: authenticated may read and may never write. Every write goes
-- through a SECURITY DEFINER RPC that runs as the table owner and needs no
-- grant of its own; a grant here would be a second, unaudited way in.
select ok(has_table_privilege('authenticated', 'public.songs', 'SELECT'),
  'authenticated may read songs — RLS decides which');
select ok(not has_table_privilege('authenticated', 'public.songs', 'INSERT'),
  'authenticated cannot insert songs directly');
select ok(not has_table_privilege('authenticated', 'public.songs', 'UPDATE'),
  'authenticated cannot update songs directly');
select ok(not has_table_privilege('authenticated', 'public.songs', 'DELETE'),
  'authenticated cannot delete songs directly');
select ok(not has_table_privilege('authenticated', 'public.artists', 'INSERT'),
  'authenticated cannot insert artists directly');
select ok(not has_table_privilege('authenticated', 'public.music_requests', 'INSERT'),
  'authenticated cannot insert requests directly — 7b brings the door');

-- 37-39: service_role likewise. BYPASSRLS does not substitute for a GRANT
-- (Block 1a §3.9), and the revoke below only ever ran against anon and
-- authenticated, so TRUNCATE has to be taken from service_role explicitly —
-- it is neither INSERT, UPDATE nor DELETE, and one statement would empty a
-- Station's whole acervo (0029 closed this same hole for the ledger).
select ok(not has_table_privilege('service_role', 'public.songs', 'INSERT'),
  'service_role cannot insert songs');
select ok(not has_table_privilege('service_role', 'public.songs', 'TRUNCATE'),
  'service_role cannot truncate songs');
select ok(not has_table_privilege('service_role', 'public.music_requests', 'TRUNCATE'),
  'service_role cannot truncate the request history');

-- 40: anon reaches none of it.
select ok(not has_table_privilege('anon', 'public.songs', 'SELECT'),
  'anon cannot read songs');

select * from finish();
rollback;
