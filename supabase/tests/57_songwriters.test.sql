begin;
select plan(16);

-- Block 27, under Block 28's word. What the structure has to say about itself.
--
-- The cross-Station claims are NOT here and cannot be: this session runs as
-- superuser with a null auth.uid(), where RLS never applies and has_permission
-- has no actor to resolve. tests/isolation/songwriters.test.ts carries
-- those, through a real JWT — the standing split this directory records in every
-- file.

-- Structure -------------------------------------------------------------------

select has_table('public', 'songwriters', 'the songwriter table exists');
select has_column('public', 'songwriters', 'company_id', 'it is per Station');
select has_column('public', 'songwriters', 'deleted_at', 'it soft-deletes');
select col_is_unique('public', 'songwriters', array['id', 'company_id'],
                     'a child can prove its Station in a constraint');

select has_column('public', 'songs', 'songwriter_id', 'a song carries a songwriter');
select col_is_fk('public', 'songs', array['songwriter_id', 'company_id'],
                 'and cannot borrow one from another Station');

-- Present, not exhaustive: 15_music_rpcs.test.sql owns the PIN on this enum's
-- exact contents and order, and it is the assertion that failed the moment 0204
-- landed and again when 0209 renamed the value. This one says only what this
-- block needs — that the kind the screen and the doors below use actually
-- exists — so a future sixth value breaks one test, in the file that exists to
-- be broken by it. 59_songwriters.test.sql owns the matching ABSENCE.
select ok(
  'SONGWRITER' = any (enum_range(null::public.music_reference_kind)::text[]),
  'the kind vocabulary carries SONGWRITER');

-- 0100's doors serve it with no new function, which is the whole argument for
-- the fifth enum value. Asserting the ABSENCE of bespoke doors is the point: if
-- somebody later adds them, the reuse has silently stopped happening and one
-- fix will need applying in two places.
select hasnt_function('public', 'create_songwriter',
                      'no bespoke create door was invented');
select hasnt_function('public', 'archive_songwriter',
                      'no bespoke archive door was invented');

-- The live-reference check ------------------------------------------------------
--
-- The songwriter is the one reference a foreign key cannot judge on its own:
-- songs_songwriter_company_fk references a NON-PARTIAL unique constraint, so it
-- proves the Station and cannot see deleted_at.

select has_function('public', 'assert_song_references_live',
                    array['uuid', 'uuid', 'uuid', 'uuid', 'uuid'],
                    'the live-reference check takes a songwriter');
select hasnt_function('public', 'assert_song_references_live',
                      array['uuid', 'uuid', 'uuid', 'uuid'],
                      'and the four-argument version it replaces is gone');
-- DROP RESETS AN ACL. Without the restated revoke in 0205 and again in 0211,
-- which drops this function a second time to rename its fifth parameter, the
-- default ACL would
-- leave every role — anon included — holding EXECUTE on a helper that takes row
-- locks.
select ok(
  not has_function_privilege('authenticated',
    'public.assert_song_references_live(uuid,uuid,uuid,uuid,uuid)', 'execute'),
  'and it is callable by nobody but a SECURITY DEFINER body');

-- RLS -------------------------------------------------------------------------

select ok(
  (select relrowsecurity from pg_class where oid = 'public.songwriters'::regclass),
  'row level security is on');
select ok(
  has_table_privilege('authenticated', 'public.songwriters', 'select'),
  'a member may read songwriters');
select ok(
  not has_table_privilege('authenticated', 'public.songwriters', 'insert'),
  'and may not insert one directly — 0100''s door is the only way in');
select ok(
  not has_table_privilege('anon', 'public.songwriters', 'select'),
  'and anon may read nothing');

select * from finish();
rollback;
