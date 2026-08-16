begin;
select plan(12);

-- Block 28. A rename is only finished when the old name is gone, so half of
-- this file asserts absences. A rename applied to nine places out of ten
-- satisfies every positive assertion in 57_songwriters.test.sql: that file asks
-- "does songwriters exist?", which is true the moment the table is created and
-- says nothing about whether music_categories was left behind beside it.

select has_table('public', 'songwriters', 'the table has the new name');
select hasnt_table('public', 'music_categories', 'and not the old one');

select has_column('public', 'songs', 'songwriter_id', 'the column has the new name');
select hasnt_column('public', 'songs', 'category_id', 'and not the old one');

select ok(
  'SONGWRITER' = any (enum_range(null::public.music_reference_kind)::text[]),
  'the kind vocabulary carries SONGWRITER');
select ok(
  not ('CATEGORY' = any (enum_range(null::public.music_reference_kind)::text[])),
  'and no longer carries CATEGORY');

-- The four doors whose PARAMETER changed, and NOT via hasnt_function on the old
-- signature — which is what this file was first drafted with and is the wrong
-- tool by construction. pgTAP resolves a function by name and argument TYPES,
-- and renaming p_category_id to p_songwriter_id changes no type at all: the old
-- and new signatures are the same thirteen types in the same order, so
-- hasnt_function('create_song', <those types>) fails on a rename that WORKED.
--
-- What actually has to be proved is two things a type list cannot see: that
-- 0211's drop+create left ONE function rather than two, and that no surviving
-- body still declares the old parameter name. Both matter because supabase-js
-- calls every RPC with NAMED arguments — a leftover overload would be resolved
-- by argument name, silently, and the caller would not know which one it got.
select is(
  (select count(*)::int
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'create_song'),
  1,
  'create_song has exactly one overload, not the old one beside the new');
select ok(
  not exists (
    select 1
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname in ('create_song', 'update_song', 'create_song_from_deezer',
                         'assert_song_references_live')
       and 'p_category_id' = any (p.proargnames)),
  'and no song door still declares a p_category_id');

-- INVENTORY IS UNTOUCHED. These four are the guard against a find-and-replace
-- that went one directory too far, and they are the reason this file exists in
-- a block that renames nothing of theirs. prize_categories is governed by
-- inventory.catalogue and shares nothing with the music domain but a word.
select has_table('public', 'prize_categories', 'inventory keeps its categories');
select has_column('public', 'prizes', 'category_id', 'and its column');
select has_function('public', 'save_prize_category', array['uuid','text','uuid'],
                    'and its register door');
select has_function('public', 'archive_prize_category', array['uuid'],
                    'and its archive door');

select * from finish();
rollback;
