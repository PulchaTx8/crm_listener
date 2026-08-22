begin;
select plan(15);

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


-- ---------------------------------------------------------------------------
-- RESOLUTION. The four doors that register a listener -- console, WhatsApp, the
-- Block 15 API and the widget -- all pass through apply_member_creation, which
-- is why attaching a person lands in one place and cannot drift.
--
-- TWENTY ARGUMENTS. 0213_country dropped the nineteen-parameter version 0061
-- wrote and created one taking p_country as well; pg_proc is the authority on
-- that, not the migration that first introduced the function.
-- ---------------------------------------------------------------------------

select isnt(
  public.resolve_or_attach_person('5511900000010', null, null, null),
  null,
  'a telephone nobody claims mints a person');

select is(
  (select count(*)::int from public.person_identifiers
    where kind = 'PHONE' and value = '5511900000010' and valid_to is null),
  1,
  'and records the claim, once');

select is(
  public.resolve_or_attach_person('5511900000010', null, null, null),
  public.resolve_or_attach_person('5511900000010', null, null, null),
  'the same telephone twice is the same person');

-- NORMALISED through the same two functions members.phone_normalized delegates
-- to: a number typed with punctuation must not mint a second person for one
-- human. 0031's comment on those functions is a standing warning about exactly
-- this -- these values ARE identity, and one that drifts stops deduplicating
-- while the duplicates look legitimate.
select is(
  public.resolve_or_attach_person('+55 11 90000-0010', null, null, null),
  public.resolve_or_attach_person('5511900000010', null, null, null),
  'and a number typed differently resolves to the same person');

-- THE BRIDGE, and the case that would be a contradiction if people held
-- attributes. One caller names person A by telephone and person B by e-mail.
-- Exactly two columns reference people, so merging them is two updates and
-- nobody is retired -- which is why D20's fallback is never reached.
select public.resolve_or_attach_person('5511900000020', null, null, null);
select public.resolve_or_attach_person(null, 'bridge@example.com', null, null);
select public.resolve_or_attach_person('5511900000020', 'bridge@example.com', null, null);
select is(
  (select count(distinct person_id)::int from public.person_identifiers
    where value in ('5511900000020', 'bridge@example.com') and valid_to is null),
  1,
  'a caller naming two people merges them rather than refusing or retiring one');

-- CALLED ONCE, into a table. apply_member_creation WRITES, and a writing
-- function placed in a where clause is evaluated per row of the table being
-- scanned -- it registered a listener for every member in the database and
-- compared none of them successfully. The failure read "have: NULL", which says
-- nothing about the cause.
create table pg_temp.p2_created as
  select public.apply_member_creation(
    '00000000-0000-0000-0000-0000000076c1', 'Pessoa P2', '5511900000030',
    null, null, null, null, null, null, null, null, null, null, null,
    null, null, null, null, null, null) as id;

select is(
  (select m.person_id is not null
     from public.members m
     join pg_temp.p2_created c on c.id = m.id),
  true,
  'and a listener registered through the shared core comes out with a person attached');

select * from finish();
rollback;
