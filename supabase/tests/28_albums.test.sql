begin;
select plan(31);

-- Block 13a: albums, the Deezer columns on songs, and the doors that write
-- them.
--
-- Fixtures live in the ...00e6xx range. 14_music_catalogue owns ...00e0xx,
-- 15_music_rpcs ...00e1xx, and e2-e5 are taken by later files; a collision
-- would fail in whichever file ran second.
--
-- WHAT THIS FILE CANNOT SEE, stated here so nobody reads its passing as more
-- than it is: pgTAP runs as superuser with a null auth.uid(), so
-- has_permission() is false for every Station and the three public doors
-- answer 42501 before reaching their bodies. Every happy path through
-- create_song_from_deezer and link_song_to_deezer therefore lives in
-- tests/isolation/deezer.test.ts, which has real sessions. What is provable
-- here is shape, constraints, grants, and the two private resolvers -- which
-- check no permission precisely because their caller already did.

insert into public.organizations (id, name) values
  ('00000000-0000-0000-0000-00000000e6f1', 'Org 13a albums');
insert into public.companies (id, organization_id, name, timezone) values
  ('00000000-0000-0000-0000-00000000e6c1', '00000000-0000-0000-0000-00000000e6f1',
   'Station 13a A', 'America/Sao_Paulo'),
  ('00000000-0000-0000-0000-00000000e6c2', '00000000-0000-0000-0000-00000000e6f1',
   'Station 13a B', 'America/Sao_Paulo');

-- ---------------------------------------------------------------------------
-- 1-8: the shape.
-- ---------------------------------------------------------------------------

select has_table('public', 'albums', 'albums exists');
select col_not_null('public', 'albums', 'title', 'an album needs a title');
select has_column('public', 'albums', 'upc', 'albums carry the UPC of the release');
select has_column('public', 'albums', 'cover_md5', 'albums carry the cover hash');

select has_column('public', 'songs', 'album_id', 'songs point at an album');
select has_column('public', 'songs', 'deezer_track_id', 'songs carry the Deezer id');
select has_column('public', 'songs', 'isrc', 'songs carry the ISRC');

-- The pair songs prove their Station with, in a constraint rather than a
-- trigger. Without it the composite foreign key cannot be declared at all.
select col_is_unique('public', 'albums', array['id', 'company_id'],
  'the (id, company_id) pair a child uses to prove its Station');

-- ---------------------------------------------------------------------------
-- 9-11: RLS. Read gated on music.view, and NO write policy -- writes go
-- through 0137's SECURITY DEFINER doors, which is where music.manage lives.
-- ---------------------------------------------------------------------------

select is(
  (select relrowsecurity from pg_class where oid = 'public.albums'::regclass),
  true, 'row level security is enabled on albums');

select policies_are('public', 'albums', array['albums_select_music_view'],
  'one read policy on albums, and no write policy at all');

select is(
  (select count(*)::int from information_schema.role_table_grants
    where table_schema = 'public' and table_name = 'albums'
      and grantee = 'authenticated' and privilege_type in ('INSERT','UPDATE','DELETE')),
  0, 'authenticated holds no direct write grant on albums');

-- ---------------------------------------------------------------------------
-- 12-16: the format checks. Each is here because the column feeds something
-- that fails badly on a bad value -- the cover hash lands in an <img src>, and
-- the UPC and ISRC are matched against outside systems.
-- ---------------------------------------------------------------------------

select throws_ok(
  $$insert into public.albums (organization_id, company_id, title, upc)
    values ('00000000-0000-0000-0000-00000000e6f1',
            '00000000-0000-0000-0000-00000000e6c1', 'Bad UPC', 'not-a-upc')$$,
  '23514', null, 'a UPC that is not 12-14 digits is refused');

select lives_ok(
  $$insert into public.albums (id, organization_id, company_id, title, upc, deezer_album_id, cover_md5)
    values ('00000000-0000-0000-0000-00000000e6a1',
            '00000000-0000-0000-0000-00000000e6f1',
            '00000000-0000-0000-0000-00000000e6c1',
            'Prenda Minha', '731453833227', 103763,
            '2a0f6ac6bc05458fb072275653f01dd2')$$,
  'a real album from Deezer is accepted whole');

select throws_ok(
  $$insert into public.albums (organization_id, company_id, title, cover_md5)
    values ('00000000-0000-0000-0000-00000000e6f1',
            '00000000-0000-0000-0000-00000000e6c1', 'Bad cover', '../../etc/passwd')$$,
  '23514', null, 'a cover hash that is not 32 hex characters is refused');

-- Upper-case hex is refused too: Deezer emits lower case, cover.ts matches
-- lower case, and accepting both here would let a row exist that the URL
-- builder then declines to render.
select throws_ok(
  $$insert into public.albums (organization_id, company_id, title, cover_md5)
    values ('00000000-0000-0000-0000-00000000e6f1',
            '00000000-0000-0000-0000-00000000e6c1', 'Upper', '2A0F6AC6BC05458FB072275653F01DD2')$$,
  '23514', null, 'an upper-case cover hash is refused, because cover.ts would decline it');

select throws_ok(
  $$insert into public.albums (organization_id, company_id, title, upc)
    values ('00000000-0000-0000-0000-00000000e6f1',
            '00000000-0000-0000-0000-00000000e6c1', '   ', null)$$,
  '23514', null, 'a blank title is refused');

-- ---------------------------------------------------------------------------
-- 17-19: the partial unique on the album's Deezer id (design D9).
-- ---------------------------------------------------------------------------

select throws_ok(
  $$insert into public.albums (organization_id, company_id, title, deezer_album_id)
    values ('00000000-0000-0000-0000-00000000e6f1',
            '00000000-0000-0000-0000-00000000e6c1', 'Same record again', 103763)$$,
  '23505', null, 'two live albums in one Station may not share a Deezer id');

-- Another Station keeps its own catalogue, which is the whole of D1.
select lives_ok(
  $$insert into public.albums (organization_id, company_id, title, deezer_album_id)
    values ('00000000-0000-0000-0000-00000000e6f1',
            '00000000-0000-0000-0000-00000000e6c2', 'Prenda Minha', 103763)$$,
  'a second Station registers the same Deezer album independently');

-- Partial, so archiving and re-registering stays possible. A total unique
-- would refuse this second insert forever -- 0057's reasoning.
select is(
  (select indpred is not null from pg_index
    where indexrelid = 'public.albums_deezer_live'::regclass),
  true, 'the album Deezer unique is partial, so an archived album blocks nothing');

-- ---------------------------------------------------------------------------
-- 20-24: the song columns and their guards.
-- ---------------------------------------------------------------------------

insert into public.artists (id, organization_id, company_id, name) values
  ('00000000-0000-0000-0000-00000000e6b1', '00000000-0000-0000-0000-00000000e6f1',
   '00000000-0000-0000-0000-00000000e6c1', 'Caetano Veloso');

select lives_ok(
  $$insert into public.songs (id, organization_id, company_id, title, artist_id,
                              album_id, deezer_track_id, isrc)
    values ('00000000-0000-0000-0000-00000000e6d1',
            '00000000-0000-0000-0000-00000000e6f1',
            '00000000-0000-0000-0000-00000000e6c1',
            'Sozinho', '00000000-0000-0000-0000-00000000e6b1',
            '00000000-0000-0000-0000-00000000e6a1', 921568, 'BRPGD9800678')$$,
  'a song registered from Deezer carries album, code and ISRC');

select throws_ok(
  $$insert into public.songs (organization_id, company_id, title, artist_id, isrc)
    values ('00000000-0000-0000-0000-00000000e6f1',
            '00000000-0000-0000-0000-00000000e6c1',
            'Bad ISRC', '00000000-0000-0000-0000-00000000e6b1', 'nope')$$,
  '23514', null, 'an ISRC that is not two letters, three alphanumerics and seven digits is refused');

select throws_ok(
  $$insert into public.songs (organization_id, company_id, title, artist_id, deezer_track_id)
    values ('00000000-0000-0000-0000-00000000e6f1',
            '00000000-0000-0000-0000-00000000e6c1',
            'Same recording', '00000000-0000-0000-0000-00000000e6b1', 921568)$$,
  '23505', null, 'two live songs in one Station may not share a Deezer track id');

-- Design D8: hand-editable, so format-checked and NOT unique. A unique index
-- here would turn one operator's typo into a door nobody can open.
select is(
  (select count(*)::int from pg_indexes
    where schemaname = 'public' and tablename = 'songs' and indexdef ilike '%unique%isrc%'),
  0, 'the ISRC carries no unique index, because it is typed by hand');

-- An album from ANOTHER Station is refused by Postgres, before any screen or
-- RPC gets a say -- the composite foreign key doing the job 0098 gives the
-- other three references.
select throws_ok(
  $$insert into public.songs (organization_id, company_id, title, artist_id, album_id)
    values ('00000000-0000-0000-0000-00000000e6f1',
            '00000000-0000-0000-0000-00000000e6c1',
            'Wrong station album', '00000000-0000-0000-0000-00000000e6b1',
            (select id from public.albums where company_id = '00000000-0000-0000-0000-00000000e6c2' limit 1))$$,
  '23503', null, 'an album from another Station is refused by the composite foreign key');

-- ---------------------------------------------------------------------------
-- 25-28: the doors exist, and update_song still cannot write the Deezer id.
-- ---------------------------------------------------------------------------

select has_function('public', 'create_song_from_deezer', 'the register door exists');
select has_function('public', 'link_song_to_deezer', 'the link door exists');
select has_function('public', 'unlink_song_from_deezer', 'the unlink door exists');

-- DESIGN D6, PINNED. 0102 removed legacy_id from update_song because a form
-- that does not send a field is indistinguishable, to the function, from an
-- operator who cleared it. The Deezer id must never be added back the same
-- way. This also catches the subtler failure the migration header warns
-- about: had update_song been replaced rather than dropped and recreated,
-- BOTH overloads would exist and this count would still be zero for one of
-- them -- so the assertion counts across every overload of the name.
select is(
  (select count(*)::int
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'update_song'
      and pg_get_function_arguments(p.oid) like '%deezer%'),
  0, 'no overload of update_song has a parameter that could write the Deezer id');

-- ---------------------------------------------------------------------------
-- 29-30: the two private resolvers are reachable by nobody. This is their
-- whole protection: they write without checking a permission, because their
-- only caller has already checked one.
-- ---------------------------------------------------------------------------

select is(
  has_function_privilege('authenticated',
    'public.resolve_or_create_album(uuid,text,bigint,text,text,date)', 'execute'),
  false, 'resolve_or_create_album is not executable by authenticated');

select is(
  has_function_privilege('authenticated',
    'public.resolve_or_create_reference(uuid,public.music_reference_kind,text)', 'execute'),
  false, 'resolve_or_create_reference is not executable by authenticated');

-- ---------------------------------------------------------------------------
-- 31: the resolver fills in what an album lacked and overwrites nothing.
--
-- Provable here precisely because it checks no permission. An album first
-- typed by hand and later met on Deezer gains the code and the cover; a title
-- an operator corrected is NOT reverted to Deezer's.
-- ---------------------------------------------------------------------------

insert into public.albums (id, organization_id, company_id, title)
values ('00000000-0000-0000-0000-00000000e6a2',
        '00000000-0000-0000-0000-00000000e6f1',
        '00000000-0000-0000-0000-00000000e6c1', 'Transa');

-- The call is its OWN statement, and it has to be. Calling the resolver inside
-- the WHERE of the query that then reads the row returns the pre-call value:
-- the SELECT's snapshot is taken before the function's UPDATE runs inside it,
-- so the assertion reads a NULL that the table no longer holds. That cost a
-- red test here rather than a wrong belief about the function.
create temporary table resolved_album as
select public.resolve_or_create_album(
  '00000000-0000-0000-0000-00000000e6c1', 'transa', 55555,
  '731453833228', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', '1972-01-01') as id;

select is(
  (select a.cover_md5 || '|' || a.title
     from public.albums a join resolved_album r on r.id = a.id),
  'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb|Transa',
  'the resolver matches a hand-typed album by folded title, fills in the cover it lacked, and leaves the operator''s spelling alone');

select * from finish();
rollback;
