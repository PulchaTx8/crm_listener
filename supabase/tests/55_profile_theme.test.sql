begin;
select plan(7);

-- Block 25, D6. The interface theme a person chose, which follows them to any
-- browser. NULL is System -- both "I chose to follow my machine" and "I never
-- chose", which resolve identically and are deliberately not told apart.
--
-- The shape of this file is 27_profile_locale.test.sql's, deliberately: the two
-- columns sit on the same table, are written by the same shape of Server Action,
-- and share the one trap that matters (the grant below).

select has_column('public', 'profiles', 'theme', 'profiles.theme exists');

select ok(
  (select is_nullable from information_schema.columns
    where table_name = 'profiles' and column_name = 'theme') = 'YES',
  'theme is nullable -- null is System, which is not the same as choosing Light');

-- The two, and ONLY the two. 'system' must not be storable: it would be a value
-- meaning exactly what its own absence already means, and two ways to say one
-- thing is one way too many.
--
-- Asserted on the constraint's DEFINITION rather than by inserting a row, for
-- the reason the locale file states: profiles.id references auth.users (0003),
-- so a made-up id fails on the foreign key first and an insert-based test would
-- pass for the wrong reason, reporting a check constraint that might not exist
-- at all.
select ok(
  exists (
    select 1 from pg_constraint
     where conname = 'profiles_theme_supported'
       and pg_get_constraintdef(oid) like '%''light''%'
       and pg_get_constraintdef(oid) like '%''dark''%'),
  'the constraint names both storable themes');

select ok(
  not exists (
    select 1 from pg_constraint
     where conname = 'profiles_theme_supported'
       and pg_get_constraintdef(oid) like '%''system''%'),
  'and does NOT name system, which is what NULL already says');

select col_has_check('public', 'profiles', 'theme',
  'theme carries a check constraint rather than accepting any string');

-- ---------------------------------------------------------------------------
-- THE GRANT, and this file exists mostly for these two.
--
-- `grant update (full_name) on public.profiles to authenticated` (0006:33) is
-- COLUMN-SCOPED, and 0135 had to add `update (locale)` for the same reason. A
-- new column on this table is writable by nobody until it is named, and every
-- theme choice would come back 42501.
--
-- The negative half is not symmetry for its own sake: it is what makes a
-- blanket `grant update on public.profiles` FAIL this suite instead of passing
-- it. A grant that fixed the feature by widening far too much would otherwise
-- look identical from the positive assertion alone.
-- ---------------------------------------------------------------------------
select ok(
  has_column_privilege('authenticated', 'public.profiles', 'theme', 'update'),
  'a signed-in caller may write their own theme');

select ok(
  not has_column_privilege('authenticated', 'public.profiles', 'must_change_password', 'update'),
  'and still may not write the columns that gate their own account');

select * from finish();
rollback;
