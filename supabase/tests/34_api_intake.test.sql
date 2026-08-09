begin;
select plan(25);

-- Block 15. What the two API endpoints write, and the two facts that make a
-- retry harmless.

select has_column('public', 'songs', 'external_id',
  'a song can carry the calling system''s own key');
select has_column('public', 'music_requests', 'external_id',
  'and so can a request, so a retry is not a second request');

-- Design D5: this is NOT legacy_id. Block 9's ETL owns that column, and two
-- sources sharing one unique index would collide on values that mean different
-- things -- surfacing to an integrator as "this song already exists" about a
-- record that has nothing to do with theirs.
select is(
  (select count(*) from information_schema.columns
    where table_schema = 'public' and table_name = 'songs'
      and column_name in ('legacy_id', 'external_id')),
  2::bigint, 'external_id lives beside legacy_id, not instead of it');

-- 0098 predicted this value and reserved WHATSAPP for a different caller.
select is(
  (select count(*) from pg_enum e
     join pg_type t on t.oid = e.enumtypid
    where t.typname = 'music_request_channel' and e.enumlabel = 'API'),
  1::bigint, 'a request can say it arrived over the API');

-- The intake core (0152) ---------------------------------------------------

insert into public.organizations (id, name) values
  ('00000000-0000-0000-0000-0000000000a2', 'Org intake');
insert into public.companies (id, organization_id, name, timezone) values
  ('00000000-0000-0000-0000-0000000000b2', '00000000-0000-0000-0000-0000000000a2',
   'Station intake', 'America/Sao_Paulo');

-- The core writes without checking a permission, because its callers have
-- already checked a credential scope. Reachable from no role at all is the
-- whole of its protection -- the shape 0139's two resolvers use.
select is(
  (select count(*) from information_schema.role_routine_grants
    where routine_schema = 'public' and routine_name = 'apply_song_intake'
      and grantee in ('anon', 'authenticated', 'service_role')),
  0::bigint, 'the intake core is reachable from no role at all');

select is(
  (public.apply_song_intake(
     '00000000-0000-0000-0000-0000000000b2', '00000000-0000-0000-0000-0000000000a2',
     null, 'EXT-1', 'Discovery Song', 'Daft Punk', 'Virgin', 'Electronic',
     'Discovery', null, null, 224, null, null, 3135556, 302127, null, null, null
   ) ->> 'created')::boolean,
  true, 'a song nobody had is created');

select is(
  (select count(*) from public.artists
    where company_id = '00000000-0000-0000-0000-0000000000b2' and name = 'Daft Punk'),
  1::bigint, 'and its artist was created with it');

-- D4, rung one: the calling system's own key.
select is(
  (public.apply_song_intake(
     '00000000-0000-0000-0000-0000000000b2', '00000000-0000-0000-0000-0000000000a2',
     null, 'EXT-1', 'Discovery Song', 'Daft Punk', null, null, null,
     null, null, null, null, null, null, null, null, null, null
   ) ->> 'created')::boolean,
  false, 'the same external id resolves to the song already there');

select is(
  (select count(*) from public.songs
    where company_id = '00000000-0000-0000-0000-0000000000b2'),
  1::bigint, 'and no second song was written');

-- D4, rung two: the recording, through 0138's songs_deezer_live.
select is(
  (public.apply_song_intake(
     '00000000-0000-0000-0000-0000000000b2', '00000000-0000-0000-0000-0000000000a2',
     null, null, 'Discovery Song', 'Daft Punk', null, null, null,
     null, null, null, null, null, 3135556, null, null, null, null
   ) ->> 'created')::boolean,
  false, 'a known deezer track id resolves to the song already there');

-- D3, first half: an empty column is filled. Sent in lower case, because a
-- calling system will not shift-lock either and songs_isrc_shape (0138) accepts
-- upper case only.
do $$ begin perform public.apply_song_intake(
  '00000000-0000-0000-0000-0000000000b2', '00000000-0000-0000-0000-0000000000a2',
  null, 'EXT-1', 'Discovery Song', 'Daft Punk', null, null, null,
  null, null, null, 'gbduw0000059', null, null, null, null, null, null); end $$;

select is(
  (select isrc from public.songs where company_id = '00000000-0000-0000-0000-0000000000b2'),
  'GBDUW0000059', 'an empty column is filled by a later call, folded to upper case');

-- D3, second half: a column that HAS a value is not touched, even when the
-- payload disagrees. The rule link_song_to_deezer already applies: somebody who
-- has curated a record for a year is not corrected by a catalogue.
do $$ begin perform public.apply_song_intake(
  '00000000-0000-0000-0000-0000000000b2', '00000000-0000-0000-0000-0000000000a2',
  null, 'EXT-1', 'A Different Title', 'Somebody Else', null, null, null,
  null, null, null, null, null, null, null, null, null, null); end $$;

select is(
  (select title from public.songs where company_id = '00000000-0000-0000-0000-0000000000b2'),
  'Discovery Song', 'the title is never rewritten by a later call');

select is(
  (select isrc from public.songs where company_id = '00000000-0000-0000-0000-0000000000b2'),
  'GBDUW0000059', 'and neither is an ISRC that is already set');

-- The artist named by that disagreeing call must not have been created either:
-- on a hit the artist is read off the row, never resolved.
select is(
  (select count(*) from public.artists
    where company_id = '00000000-0000-0000-0000-0000000000b2' and name = 'Somebody Else'),
  0::bigint, 'and a hit creates no reference for the names it ignored');

-- D4 states what is NOT on the ladder. 0098's D2 allows this duplicate on
-- purpose -- a re-recording, a live version and a remix are the same artist and
-- the same title -- and the cure is 7b's merge, not a wall here.
select is(
  (public.apply_song_intake(
     '00000000-0000-0000-0000-0000000000b2', '00000000-0000-0000-0000-0000000000a2',
     null, null, 'Discovery Song', 'Daft Punk', null, null, null,
     null, null, null, null, null, null, null, null, null, null
   ) ->> 'created')::boolean,
  true, 'the same title and artist with no code at all is a second song, by D2');

select throws_ok(
  $$select public.apply_song_intake(
      '00000000-0000-0000-0000-0000000000b2', '00000000-0000-0000-0000-0000000000a2',
      null, null, '   ', 'Daft Punk', null, null, null,
      null, null, null, null, null, null, null, null, null, null)$$,
  '22023', null, 'a blank title is refused');

-- The song door (0152) -----------------------------------------------------

select has_function('public', 'api_register_song', 'the song door exists');

select is(
  (select count(*) from information_schema.role_routine_grants
    where routine_schema = 'public' and routine_name = 'api_register_song'
      and grantee in ('anon', 'authenticated')),
  0::bigint, 'and no browser role may call it');

-- The scope is checked against the CREDENTIAL, never against auth.uid(). There
-- is no session on this path at all -- pgTAP has none, and neither does the
-- route, which calls with the service key -- so this is the call that proves
-- the API does not depend on one.
insert into public.api_credentials
  (id, organization_id, company_id, name, token_prefix, token_hash)
values
  ('00000000-0000-0000-0000-0000000000c2',
   '00000000-0000-0000-0000-0000000000a2',
   '00000000-0000-0000-0000-0000000000b2',
   'Intake key', 'ptx_eeeeffff', repeat('e', 64));

select throws_ok(
  $$select public.api_register_song(
      '00000000-0000-0000-0000-0000000000c2',
      '00000000-0000-0000-0000-0000000000b2',
      '00000000-0000-0000-0000-0000000000a2',
      'Scopeless', 'Nobody', 'EXT-9', null, null, null,
      null, null, null, null, null, null, null, null, null, null)$$,
  '42501', null, 'a credential without music.manage is refused');

-- The request door (0152) --------------------------------------------------

-- Least privilege across three scopes, so this key can do all three things.
insert into public.api_credential_scopes (credential_id, permission_code) values
  ('00000000-0000-0000-0000-0000000000c2', 'music.manage'),
  ('00000000-0000-0000-0000-0000000000c2', 'music.request'),
  ('00000000-0000-0000-0000-0000000000c2', 'members.create');

-- A listener nobody has ever seen, arriving with a name: registered, linked,
-- the song registered and the request recorded -- all in one call and one
-- transaction.
select is(
  (public.api_record_music_request(
     '00000000-0000-0000-0000-0000000000c2',
     '00000000-0000-0000-0000-0000000000b2',
     '00000000-0000-0000-0000-0000000000a2',
     '+5511999990001', 'REQ-1', 'Maria Silva', null, null,
     null, 'Around the World', 'Daft Punk', null, null, null,
     null, null, null, null, null, 1234567, null, null, null, null
   ) -> 'listener' ->> 'created')::boolean,
  true, 'a listener the Station has never seen is registered');

select is(
  (select count(*) from public.music_requests
    where company_id = '00000000-0000-0000-0000-0000000000b2'),
  1::bigint, 'and the request is recorded');

-- 0098 reserved WHATSAPP for this product's own bot. What arrived here came
-- over HTTP from a third party, and the column answers how it reached us.
select is(
  (select channel::text from public.music_requests
    where company_id = '00000000-0000-0000-0000-0000000000b2'),
  'API', 'saying it arrived over the API');

-- Design D6. The external application attends on WhatsApp and therefore holds
-- the profile name; arriving without one is its bug, refused here rather than
-- turned into a nameless row in somebody's audience.
select throws_ok(
  $$select public.api_record_music_request(
      '00000000-0000-0000-0000-0000000000c2',
      '00000000-0000-0000-0000-0000000000b2',
      '00000000-0000-0000-0000-0000000000a2',
      '+5511999990002', 'REQ-2', null, null, null,
      null, 'One More Time', 'Daft Punk', null, null, null,
      null, null, null, null, null, 2345678, null, null, null, null)$$,
  '22023', null, 'a new listener with no name is refused');

-- The retry. An automation repeats itself, and Block 8 counts requests -- so a
-- second row here would be a number that looks right and is not.
select is(
  (public.api_record_music_request(
     '00000000-0000-0000-0000-0000000000c2',
     '00000000-0000-0000-0000-0000000000b2',
     '00000000-0000-0000-0000-0000000000a2',
     '+5511999990001', 'REQ-1', 'Maria Silva', null, null,
     null, 'Around the World', 'Daft Punk', null, null, null,
     null, null, null, null, null, 1234567, null, null, null, null
   ) ->> 'created')::boolean,
  false, 'the same request external id is not a second request');

-- `shows` is the one catalogue entity with no merge door (0098's own table
-- comment), so an API creating one from a typed name would breed duplicates
-- with no cure. Refused loudly rather than dropped in silence.
select throws_ok(
  $$select public.api_record_music_request(
      '00000000-0000-0000-0000-0000000000c2',
      '00000000-0000-0000-0000-0000000000b2',
      '00000000-0000-0000-0000-0000000000a2',
      '+5511999990001', 'REQ-3', 'Maria Silva', 'No Such Programme', null,
      null, 'Aerodynamic', 'Daft Punk', null, null, null,
      null, null, null, null, null, 3456789, null, null, null, null)$$,
  'P0002', null, 'an unknown programme is refused, never created');

select * from finish();
rollback;
