begin;
select plan(16);

-- Block 20c. The album record gets a picture, and update_album learns two
-- fields it never had.
--
-- Fixtures live in the ...00e7xx range. 14_music_catalogue owns ...00e0xx,
-- 15_music_rpcs ...00e1xx, 17_music_requests ...00e3xx and 28_albums ...00e6xx;
-- a collision would fail in whichever file ran second.
--
-- UNLIKE 28_albums, THIS FILE STANDS UP A REAL CALLER. That file states its own
-- limit -- pgTAP runs with a null auth.uid(), so has_permission answers false
-- for every Station and every door refuses before reaching its body. Half of
-- what is asserted here is what the doors DO when the permission is held, so
-- the fixture below is 43_shows' one: a role carrying music.manage and
-- music.view, a user, a membership, and request.jwt.claims naming that user.

-- ---------------------------------------------------------------------------
-- 1-2. THE ASSERTIONS THIS FILE EXISTS FOR: the old update_album is GONE, not
--      shadowed.
--
-- `create or replace` does not change an argument list -- it adds an overload,
-- and every existing caller goes on resolving to the old one in silence.
-- ::regprocedure cannot see that: it resolves the signature written and ignores
-- the twins. Only a count over pg_proc can. Block 4b paid for this once, and
-- 0141 had to make the same drop for the same reason one block earlier.
-- ---------------------------------------------------------------------------

select is(
  (select count(*) from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'update_album'),
  1::bigint, 'exactly one update_album exists, not two');

-- THE NAMES ARE PART OF THE CONTRACT, not decoration. pg_get_function_identity_-
-- arguments carries them (it drops the DEFAULT clauses, not the names), and
-- that is the right thing to pin here: PostgREST resolves an RPC by named
-- argument, so `.rpc('update_album', { p_album_id, p_title, ... })` breaks on a
-- renamed parameter exactly as it breaks on a missing one.
select is(
  (select pg_get_function_identity_arguments(p.oid) from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'update_album'),
  'p_album_id uuid, p_title text, p_upc text, p_release_date date',
  'and it is the widened one');

-- ---------------------------------------------------------------------------
-- 3-5. The column, and who cannot reach its writer.
-- ---------------------------------------------------------------------------

select has_column('public', 'albums', 'thumb_url', 'albums carries a cover URL');
select col_is_null('public', 'albums', 'thumb_url',
  'and an album without one is ordinary');

select is(
  (select count(*) from information_schema.role_routine_grants
    where routine_schema = 'public'
      and routine_name = 'set_album_cover'
      and grantee = 'anon'),
  0::bigint, 'anon may not call set_album_cover');

-- Fixtures -------------------------------------------------------------------
--
-- TWO STATIONS IN ONE ORGANIZATION, and the caller belongs to the first only.
-- That is what makes assertion 7 mean anything: a permission held somewhere is
-- not a permission held here, and a slot that read the path without asking
-- has_permission would still pass a one-Station fixture.

insert into public.organizations (id, name) values
  ('00000000-0000-0000-0000-00000000e7f1', 'Org 20c covers');

insert into public.companies (id, organization_id, name, timezone) values
  ('00000000-0000-0000-0000-00000000e7c1', '00000000-0000-0000-0000-00000000e7f1',
   'Station 20c A', 'America/Sao_Paulo'),
  ('00000000-0000-0000-0000-00000000e7c2', '00000000-0000-0000-0000-00000000e7f1',
   'Station 20c B', 'America/Sao_Paulo');

insert into public.roles (id, organization_id, name) values
  ('00000000-0000-0000-0000-00000000e7a1', '00000000-0000-0000-0000-00000000e7f1',
   'Catalogue Manager 20c');
insert into public.role_permissions (role_id, permission_code) values
  ('00000000-0000-0000-0000-00000000e7a1', 'music.manage'),
  -- music.view as well, and not for decoration: albums_select_music_view is the
  -- only read policy on the table, so without it every read-back below would be
  -- an empty row rather than a wrong one.
  ('00000000-0000-0000-0000-00000000e7a1', 'music.view');

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-00000000e7a2', 'covers-probe@example.test');

insert into public.company_memberships (user_id, company_id, organization_id, role_id) values
  ('00000000-0000-0000-0000-00000000e7a2', '00000000-0000-0000-0000-00000000e7c1',
   '00000000-0000-0000-0000-00000000e7f1', '00000000-0000-0000-0000-00000000e7a1');

-- No UPC and no release date: both are what assertion 10 watches arrive.
insert into public.albums (id, organization_id, company_id, title) values
  ('00000000-0000-0000-0000-00000000e7b1', '00000000-0000-0000-0000-00000000e7f1',
   '00000000-0000-0000-0000-00000000e7c1', 'Album without a date'),
  ('00000000-0000-0000-0000-00000000e7b2', '00000000-0000-0000-0000-00000000e7f1',
   '00000000-0000-0000-0000-00000000e7c2', 'Album in the other Station');

set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000e7a2", "role": "authenticated"}';

-- ---------------------------------------------------------------------------
-- 6-8. may_write_artwork and the album-covers slot.
--
-- The slot takes music.manage, the same permission every other album door takes
-- (0137). Asserted in all three directions, because a branch that answered true
-- on the prefix alone would satisfy assertion 6 by itself.
-- ---------------------------------------------------------------------------

select is(
  public.may_write_artwork(
    'album-covers/00000000-0000-0000-0000-00000000e7c1/00000000-0000-0000-0000-00000000e7b1'),
  true, 'a caller holding music.manage may write an album cover in that Station');

select is(
  public.may_write_artwork(
    'album-covers/00000000-0000-0000-0000-00000000e7c2/00000000-0000-0000-0000-00000000e7b2'),
  false, 'and may not write one in a Station of the same Organization they do not belong to');

-- The rule 0143's closing comment states, re-proved with a session in hand:
-- holding a permission does not turn an unknown prefix into a permitted one.
select is(
  public.may_write_artwork(
    'album-cover/00000000-0000-0000-0000-00000000e7c1/00000000-0000-0000-0000-00000000e7b1'),
  false, 'a near-miss prefix is still refused, permission or not');

-- ---------------------------------------------------------------------------
-- 9-10. update_album writes the two fields it just learned.
--
-- Read back in one string rather than three assertions: what is being proved is
-- that ONE call carried all three values through, and three separate reads would
-- pass individually for a function that wrote them on three different calls.
-- ---------------------------------------------------------------------------

select lives_ok(
  $$select public.update_album(
      '00000000-0000-0000-0000-00000000e7b1', 'Album with a date',
      '731453833227', '1972-03-01'::date)$$,
  'the widened update_album takes a title, a UPC and a release date');

select is(
  (select title || '|' || coalesce(upc, '') || '|' || coalesce(release_date::text, '')
     from public.albums where id = '00000000-0000-0000-0000-00000000e7b1'),
  'Album with a date|731453833227|1972-03-01',
  'and all three arrive on the row');

-- ---------------------------------------------------------------------------
-- 11-14. set_album_cover sets, clears, and queues rather than deletes.
--
-- The address is a loopback one because that is what development's Storage
-- serves and what enqueue_artwork_erasure matches against: a URL that does not
-- contain our own object path is queued for nobody, deliberately (0087 has no
-- give-up threshold, so a key naming nothing would retry for ever).
-- ---------------------------------------------------------------------------

select lives_ok(
  $$select public.set_album_cover(
      '00000000-0000-0000-0000-00000000e7b1',
      'http://127.0.0.1:54321/storage/v1/object/public/artwork/album-covers/'
        || '00000000-0000-0000-0000-00000000e7c1/00000000-0000-0000-0000-00000000e7b1?v=1')$$,
  'an operator sets the album''s own picture');

select is(
  (select thumb_url from public.albums
    where id = '00000000-0000-0000-0000-00000000e7b1'),
  'http://127.0.0.1:54321/storage/v1/object/public/artwork/album-covers/'
    || '00000000-0000-0000-0000-00000000e7c1/00000000-0000-0000-0000-00000000e7b1?v=1',
  'and the address is what the row holds');

-- The parameter is OMITTED rather than passed null, which is the call the
-- service makes and the reason the parameter carries `default null`.
select lives_ok(
  $$select public.set_album_cover('00000000-0000-0000-0000-00000000e7b1')$$,
  'and clears it by leaving the argument off entirely');

select is(
  (select thumb_url from public.albums
    where id = '00000000-0000-0000-0000-00000000e7b1'),
  null::text,
  'the row goes back to holding no picture at all');

-- ---------------------------------------------------------------------------
-- 15. The Station the caller does not belong to is refused, before anything is
--     written and before anything is queued.
-- ---------------------------------------------------------------------------

select throws_ok(
  $$select public.set_album_cover(
      '00000000-0000-0000-0000-00000000e7b2', 'https://x/y')$$,
  '42501', null,
  'an album in a Station the caller cannot manage is refused');

reset role;

-- ---------------------------------------------------------------------------
-- 16. storage_erasure_queue carries RLS and no policy at all -- a system table,
--     like whatsapp_conversations -- so the role above cannot see it and this
--     read has to happen back as the owner.
--
-- Counted for THIS key rather than for the bucket: the queue is ordinary
-- committed data, the e2e suite runs against this same database and leaves rows
-- behind, and a count over `bucket = 'artwork'` would pass on a fresh reset and
-- fail on the second run of the day naming a defect that is not there.
-- ---------------------------------------------------------------------------

select is(
  (select count(*) from public.storage_erasure_queue
    where bucket = 'artwork'
      and path = 'album-covers/00000000-0000-0000-0000-00000000e7c1/'
              || '00000000-0000-0000-0000-00000000e7b1'),
  1::bigint,
  'clearing queued the object for the worker rather than deleting it, because the bucket gives authenticated no delete policy');

select * from finish();
rollback;
