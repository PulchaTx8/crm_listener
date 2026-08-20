begin;
select plan(7);

-- Block 30b. A birthday is a day of the year, so the screen needs a day of the
-- year to compare against. This file proves the derivation and the index, not
-- the filter -- the filter is a PostgREST predicate and belongs to
-- tests/isolation/members.test.ts, which can run it as a real caller.

insert into public.organizations (id, name) values
  ('00000000-0000-0000-0000-00000000b0f1', 'Org 30b');

insert into public.members (id, organization_id, full_name, birth_date) values
  ('00000000-0000-0000-0000-00000000b0d1', '00000000-0000-0000-0000-00000000b0f1', 'Fim de ano',    '1990-12-31'),
  ('00000000-0000-0000-0000-00000000b0d2', '00000000-0000-0000-0000-00000000b0f1', 'Comeco de ano', '1988-01-05'),
  ('00000000-0000-0000-0000-00000000b0d3', '00000000-0000-0000-0000-00000000b0f1', 'Bissexto',      '2000-02-29'),
  ('00000000-0000-0000-0000-00000000b0d4', '00000000-0000-0000-0000-00000000b0f1', 'Sem data',      null);

-- 1-4: the derivation, including the two cases that are easy to get wrong.
select is((select birth_md from public.members where id = '00000000-0000-0000-0000-00000000b0d1'),
  1231::smallint, '31 December is 1231');
select is((select birth_md from public.members where id = '00000000-0000-0000-0000-00000000b0d2'),
  105::smallint, '5 January is 105, not 501 -- month first, and no zero padding to worry about');
-- 29 FEBRUARY NEEDS NO SPECIAL CASE, and this assertion is what says so: it is
-- 229, and any window spanning 28 February to 1 March contains it.
select is((select birth_md from public.members where id = '00000000-0000-0000-0000-00000000b0d3'),
  229::smallint, '29 February is 229 like any other day');
select is((select birth_md from public.members where id = '00000000-0000-0000-0000-00000000b0d4'),
  null, 'no birth date derives no day -- this listener is invisible to the filter, by construction');

-- 5: it is GENERATED, so it cannot be written by hand and cannot drift from
-- birth_date. A plain column maintained by whoever remembers is the failure
-- 0031 already argues about phone_normalized.
select throws_ok($$
  update public.members set birth_md = 101
   where id = '00000000-0000-0000-0000-00000000b0d1'
$$, '428C9', null, 'birth_md cannot be written directly');

-- 6: and it follows birth_date when that changes.
update public.members set birth_date = '1975-07-04'
 where id = '00000000-0000-0000-0000-00000000b0d1';
select is((select birth_md from public.members where id = '00000000-0000-0000-0000-00000000b0d1'),
  704::smallint, 'the derivation follows its source');

-- 7: the index the filter leans on. Asserted by name because a query plan is
-- not stable enough to assert and the absence of the index would show up as a
-- whole-Organization scan nobody notices until the audience is large.
select is(
  (select count(*)::int from pg_indexes
    where schemaname = 'public' and indexname = 'members_birth_md_idx'),
  1, 'members_birth_md_idx exists');

select * from finish();
rollback;
