begin;
select plan(16);

-- Block 27. What the structure has to say about itself.
--
-- The cross-Station claims are NOT here and cannot be: this session runs as
-- superuser with a null auth.uid(), where RLS never applies and has_permission
-- has no actor to resolve. tests/isolation/music-categories.test.ts carries
-- those, through a real JWT — the standing split this directory records in every
-- file.

-- Structure -------------------------------------------------------------------

select has_table('public', 'music_categories', 'the category table exists');
select has_column('public', 'music_categories', 'company_id', 'it is per Station');
select has_column('public', 'music_categories', 'deleted_at', 'it soft-deletes');
select col_is_unique('public', 'music_categories', array['id', 'company_id'],
                     'a child can prove its Station in a constraint');

select has_column('public', 'songs', 'category_id', 'a song carries a category');
select col_is_fk('public', 'songs', array['category_id', 'company_id'],
                 'and cannot borrow one from another Station');

-- Present, not exhaustive: 15_music_rpcs.test.sql owns the PIN on this enum's
-- exact contents and order, and it is the assertion that failed the moment 0204
-- landed. This one says only what this block needs — that the kind the screen
-- and the doors below use actually exists — so a future sixth value breaks one
-- test, in the file that exists to be broken by it.
select ok(
  'CATEGORY' = any (enum_range(null::public.music_reference_kind)::text[]),
  'the kind vocabulary carries CATEGORY');

-- 0100's doors serve it with no new function, which is the whole argument for
-- the fifth enum value. Asserting the ABSENCE of bespoke doors is the point: if
-- somebody later adds them, the reuse has silently stopped happening and one
-- fix will need applying in two places.
select hasnt_function('public', 'create_music_category',
                      'no bespoke create door was invented');
select hasnt_function('public', 'archive_music_category',
                      'no bespoke archive door was invented');

-- The live-reference check ------------------------------------------------------
--
-- The category is the one reference a foreign key cannot judge on its own:
-- songs_category_company_fk references a NON-PARTIAL unique constraint, so it
-- proves the Station and cannot see deleted_at.

select has_function('public', 'assert_song_references_live',
                    array['uuid', 'uuid', 'uuid', 'uuid', 'uuid'],
                    'the live-reference check takes a category');
select hasnt_function('public', 'assert_song_references_live',
                      array['uuid', 'uuid', 'uuid', 'uuid'],
                      'and the four-argument version it replaces is gone');
-- DROP RESETS AN ACL. Without 0205's restated revoke, the default ACL would
-- leave every role — anon included — holding EXECUTE on a helper that takes row
-- locks.
select ok(
  not has_function_privilege('authenticated',
    'public.assert_song_references_live(uuid,uuid,uuid,uuid,uuid)', 'execute'),
  'and it is callable by nobody but a SECURITY DEFINER body');

-- RLS -------------------------------------------------------------------------

select ok(
  (select relrowsecurity from pg_class where oid = 'public.music_categories'::regclass),
  'row level security is on');
select ok(
  has_table_privilege('authenticated', 'public.music_categories', 'select'),
  'a member may read categories');
select ok(
  not has_table_privilege('authenticated', 'public.music_categories', 'insert'),
  'and may not insert one directly — 0100''s door is the only way in');
select ok(
  not has_table_privilege('anon', 'public.music_categories', 'select'),
  'and anon may read nothing');

select * from finish();
rollback;
