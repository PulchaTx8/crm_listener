begin;
select plan(9);

-- ---------------------------------------------------------------------------
-- Fixtures. This file owns them: it needs TWO Organizations with a Station each,
-- which is a shape no other suite has a reason to build, and the
-- cross-Organization collision this block exists for is the whole subject here.
-- ---------------------------------------------------------------------------
insert into public.organizations (id, name) values
  ('00000000-0000-0000-0000-0000000076f1', 'Org P2 one'),
  ('00000000-0000-0000-0000-0000000076f2', 'Org P2 two');

insert into public.companies (id, organization_id, name, timezone, country, status) values
  ('00000000-0000-0000-0000-0000000076c1', '00000000-0000-0000-0000-0000000076f1',
   'Station P2 one', 'America/Sao_Paulo', 'BR', 'active'),
  ('00000000-0000-0000-0000-0000000076c2', '00000000-0000-0000-0000-0000000076f2',
   'Station P2 two', 'America/Sao_Paulo', 'BR', 'active');

-- ---------------------------------------------------------------------------
-- P2. THE PLATFORM PERSON.
--
-- people holds identity and NOTHING ELSE. The name a Station knows, the birthday
-- it confirmed and the consent it collected stay on that Station's profile
-- (design D2), which is what keeps this table from becoming a golden record two
-- Stations can disagree about.
-- ---------------------------------------------------------------------------

select has_table('public', 'people', 'the platform person exists');
select has_table('public', 'person_identifiers', 'and its identifiers are rows, not columns');

-- D2, held structurally. A future block that wants a name here has to add the
-- column and break this, which is the point.
select is(
  (select count(*)::int from information_schema.columns
    where table_schema = 'public' and table_name = 'people'
      and column_name not in ('id', 'created_at', 'updated_at')),
  0,
  'and people carries no attribute at all: no name, no birthday, no address');

-- The rule 0178 states for every listener-bearing table here.
select is(
  (select relrowsecurity from pg_class where oid = 'public.people'::regclass),
  true, 'people has RLS on');
select is(
  (select count(*)::int from pg_policies
    where schemaname = 'public' and tablename in ('people', 'person_identifiers')),
  0, 'and neither table has a policy: reachable only from a SECURITY DEFINER body');
select is(
  (select count(*)::int from information_schema.role_table_grants
    where table_schema = 'public' and table_name in ('people', 'person_identifiers')
      and grantee in ('anon', 'authenticated')),
  0, 'and neither is granted to anon or authenticated');

-- The index that makes deduplication exact, and the only real contradiction.
insert into public.people (id) values
  ('00000000-0000-0000-0000-0000000076a1'),
  ('00000000-0000-0000-0000-0000000076a2');

insert into public.person_identifiers (person_id, kind, value) values
  ('00000000-0000-0000-0000-0000000076a1', 'PHONE', '5511900000001');

select throws_ok($$
  insert into public.person_identifiers (person_id, kind, value)
  values ('00000000-0000-0000-0000-0000000076a2', 'PHONE', '5511900000001')
$$, '23505', null, 'two people cannot hold one live telephone');

select lives_ok($$
  insert into public.person_identifiers (person_id, kind, value, valid_to)
  values ('00000000-0000-0000-0000-0000000076a2', 'PHONE', '5511900000001', now())
$$, 'but a CLOSED claim on the same number is fine: that is what a number changing hands looks like');

-- D13 and D20 together: a person may hold two live telephones, and -- in bad
-- data -- two live CPFs. Permitted rather than refused, because refusing means
-- retiring a profile and D20 says keep both wherever possible.
select lives_ok($$
  insert into public.person_identifiers (person_id, kind, value) values
    ('00000000-0000-0000-0000-0000000076a1', 'PHONE', '5511900000002'),
    ('00000000-0000-0000-0000-0000000076a1', 'CPF',
     '1111111111111111111111111111111111111111111111111111111111111111')
$$, 'and one person may hold several live claims, including a second of one kind');

select * from finish();
rollback;
