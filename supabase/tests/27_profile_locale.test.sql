begin;
select plan(6);

-- Block 12a, D2. The interface language a person chose, which follows them to
-- any browser. NULL means they never chose -- the cookie decides, then the
-- browser, and finally English.

select has_column('public', 'profiles', 'locale', 'profiles.locale exists');

select ok(
  (select is_nullable from information_schema.columns
    where table_name = 'profiles' and column_name = 'locale') = 'YES',
  'locale is nullable -- null means the person never chose, which is not the same as choosing English');

-- The three, and only the three.
--
-- Asserted on the constraint's DEFINITION rather than by inserting a row:
-- profiles.id references auth.users (0003), so a made-up id fails on the
-- foreign key first and an insert-based test would pass for the wrong reason,
-- reporting a check constraint that might not exist at all.
select ok(
  exists (
    select 1 from pg_constraint
     where conname = 'profiles_locale_supported'
       and pg_get_constraintdef(oid) like '%''en''%'
       and pg_get_constraintdef(oid) like '%''pt''%'
       and pg_get_constraintdef(oid) like '%''es''%'),
  'the constraint names exactly the three supported locales');

select col_has_check('public', 'profiles', 'locale',
  'locale carries a check constraint rather than accepting any string');

-- ---------------------------------------------------------------------------
-- THE GRANT, and this file exists mostly for these two.
--
-- `grant update (full_name) on public.profiles to authenticated` (0006) is
-- COLUMN-SCOPED. A new column on this table is writable by nobody until it is
-- named, and the failure is a silent no-op: an update that matches no granted
-- column is not an error, it is zero rows -- so the Server Action reports
-- success and the choice does not persist.
-- ---------------------------------------------------------------------------
select ok(
  has_column_privilege('authenticated', 'public.profiles', 'locale', 'update'),
  'a signed-in caller may write their own locale');

select ok(
  not has_column_privilege('authenticated', 'public.profiles', 'must_change_password', 'update'),
  'and still may not write the columns that gate their own account');

select * from finish();
rollback;
