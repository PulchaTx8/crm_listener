begin;
select plan(17);

-- Block 28. The country, at the structure.
--
-- The cross-Station claims are NOT here and cannot be: this session runs as
-- superuser with a null auth.uid(), where RLS never applies and has_permission
-- has no actor to resolve. The standing split this directory records in every
-- file.

-- Columns ---------------------------------------------------------------------

select has_column('public', 'companies', 'country', 'a Station carries a country');
select has_column('public', 'members',   'country', 'and so does a listener');

-- The shape, both directions ---------------------------------------------------
--
-- BOTH DIRECTIONS, because a CHECK that accepts everything passes any test that
-- only tries valid input. 'bra' is the exact mistake the constraint exists for:
-- three letters is ISO 3166-1 ALPHA-3, which is a real standard and the wrong
-- one, so it looks correct to whoever typed it.

select throws_ok(
  $$ insert into public.companies (id, organization_id, name, country)
     values (gen_random_uuid(), gen_random_uuid(), 'x', 'bra') $$,
  '23514',
  null,
  'a Station refuses alpha-3');

select throws_ok(
  $$ insert into public.members (id, organization_id, full_name, country)
     values (gen_random_uuid(), gen_random_uuid(), 'x', 'bra') $$,
  '23514',
  null,
  'and so does a listener');

-- Both inserts above name an organization_id that does not exist, and both
-- still prove what they claim: Postgres evaluates a row's CHECK constraints
-- before its foreign keys, so 23514 is what comes back rather than 23503. A
-- fixture organization would make the test read as though it were about
-- organizations.
select ok(
  public.country_alpha2('BR') = 'BR',
  'and a two-letter code is what the columns accept');

-- The resolver -----------------------------------------------------------------
--
-- It is the only writer of both columns, so its behaviour IS the columns'
-- behaviour. Each case below is a decision recorded in 0213's header.

select is(public.country_alpha2('Brasil'), 'BR', 'a name in Portuguese resolves');
select is(public.country_alpha2('Brazil'), 'BR', 'and in English');
select is(public.country_alpha2('  portugal  '), 'PT', 'case and surrounding space do not matter');
select is(public.country_alpha2('Moçambique'), 'MZ',
          'and neither do accents — unaccent is not installed, so the fold is explicit');
select is(public.country_alpha2('br'), 'BR', 'a lower-case code is upper-cased rather than refused');
select is(public.country_alpha2('Wakanda'), null,
          'an unknown country is null and NOT an exception — its caller coalesces');
select is(public.country_alpha2(''), null, 'and so is a blank answer');
select is(public.country_alpha2(null), null, 'and a missing one');

-- EXECUTE granted to nobody: it is only ever called from inside another
-- function's body, and a caller reaching it directly would be a second,
-- unreviewed place that decides what a country string means.
select ok(
  not has_function_privilege('authenticated', 'public.country_alpha2(text)', 'execute'),
  'the resolver is callable by nobody but another function');

-- The four doors ----------------------------------------------------------------
--
-- Asserted by their FULL argument list, so a door that gained the parameter in
-- the wrong position — or lost one of its existing ones in the drop+create —
-- fails here rather than at the first call site that passes arguments
-- positionally.
--
-- ONE `text` LONGER SINCE THE GENDER BLOCK (0220), which appended p_gender
-- after p_country on both doors. These two assertions are what CAUGHT that
-- change rather than merely tolerating it, which is the whole point of
-- pinning a full signature: the block had to come back here and say so.
-- 63_gender.test.sql holds the other half — that the drop and recreate did
-- not leave two overloads behind, and did not lose the grant.

select has_function('public', 'create_member',
  array['uuid','text','text','text','text','text','text','date','text','text',
        'text','text','text','text','text','text','timestamptz','text','text','text'],
  'create_member takes a country, then a gender');
select has_function('public', 'update_member',
  array['uuid','text','text','text','text','text','text','date','text','text',
        'text','text','text','text','text','text','text','text'],
  'so does update_member');
select has_function('public', 'apply_member_creation',
  array['uuid','text','text','text','text','text','text','date','text','text',
        'text','text','text','text','text','text','timestamptz','text','uuid','text'],
  'and apply_member_creation, after p_actor so its three positional callers still resolve');

select * from finish();
rollback;
