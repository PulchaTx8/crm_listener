begin;
select plan(15);

-- The ordinary Brazilian mobile, typed as an operator types it.
select is(public.international_phone('(11) 99999-8888', 'BR'), '+5511999998888',
  'a national number gains its country code');

-- Already international: unchanged, not double-prefixed.
select is(public.international_phone('+55 11 99999-8888', 'BR'), '+5511999998888',
  'an international number is left alone');

-- IDEMPOTENT, asserted rather than assumed: 0262 re-runs this over stored
-- values, and a function that grew a second '+55' on the second pass would
-- corrupt every row it had already repaired.
select is(public.international_phone(public.international_phone('11999998888', 'BR'), 'BR'),
  '+5511999998888',
  'running it over its own output changes nothing');

-- THE COLLISION THIS FUNCTION EXISTS FOR. 55 is Santa Maria's area code as well
-- as Brazil's country code, so a prefix test would call this international and
-- leave a ten-digit number that can never be dialled.
select is(public.international_phone('(55) 9999-8888', 'BR'), '+555599998888',
  'an area code that equals the country code is still a national number');

select is(public.international_phone('99999-8888', 'BR'), '999998888',
  'a length no rule explains is returned unchanged, and WITHOUT a plus');

select is(public.international_phone('912 345 678', 'PT'), '+351912345678',
  'Portugal is a second country with a verified rule');

select is(public.international_phone('11999998888', 'ZZ'), '11999998888',
  'a country with no rule leaves the digits alone');

select is(public.international_phone('11999998888', null), '11999998888',
  'no country at all leaves the digits alone');

select is(public.international_phone(null, 'BR'), null,
  'no phone is no phone');

select is(public.international_phone('não é telefone', 'BR'), null,
  'text with no digits is null, exactly as normalize_phone answers');

-- 0261/0262 fixture. An organization-scoped Station whose country predates
-- the column (0213), and a listener under it stored in the local form --
-- 0262's own comment names the WhatsApp door as the one path that converts an
-- inbound number to that form before resolving the listener. Seeded here,
-- inside this test's own transaction, rather than read off the shared
-- companies/members tables: this project's local test database carries no
-- global seed (no supabase/seed.sql), so a count taken over those tables
-- holds vacuously over zero rows -- true with the repair applied and equally
-- true without it, which asserts nothing. These four assertions instead seed
-- a row known to need the repair and check what the repair actually did to it.
insert into public.organizations (id, name) values
  ('00000000-0000-0000-0000-000000000721', 'Org 72');
insert into public.companies (id, organization_id, name, country) values
  ('00000000-0000-0000-0000-000000000722', '00000000-0000-0000-0000-000000000721', 'Station 72', null);
insert into public.members (id, organization_id, phone) values
  ('00000000-0000-0000-0000-000000000723', '00000000-0000-0000-0000-000000000721', '11999998888');
insert into public.member_company_links (member_id, company_id, organization_id) values
  ('00000000-0000-0000-0000-000000000723', '00000000-0000-0000-0000-000000000722', '00000000-0000-0000-0000-000000000721');

-- 0261, applied verbatim.
update public.companies
   set country = 'BR'
 where country is null;

select is(
  (select country from public.companies where id = '00000000-0000-0000-0000-000000000722'),
  'BR', 'the repair backfills the missing country to BR');

-- 0262, applied verbatim.
--
-- COMPARED AGAINST `m.phone`, NOT `m.phone_normalized`. The function answers
-- the display form (with its leading plus) and phone_normalized is digits
-- only, so comparing against the generated column would report an already-
-- repaired row as still needing repair -- a predicate that never settles.
update public.members m
   set phone = public.international_phone(m.phone, c.country)
  from public.member_company_links l
  join public.companies c on c.id = l.company_id
 where l.member_id = m.id
   and m.phone is not null
   and public.international_phone(m.phone, c.country) is distinct from m.phone;

select is(
  (select phone from public.members where id = '00000000-0000-0000-0000-000000000723'),
  '+5511999998888', 'the repair rewrites the local form to the international one');

-- phone_normalized is GENERATED from phone (0031) and is what
-- members_phone_unique actually dedupes on -- asserted on its own because a
-- repair that wrote the right display form but left this column stale would
-- still misfile the listener, and the assertion above would not catch it.
select is(
  (select phone_normalized from public.members where id = '00000000-0000-0000-0000-000000000723'),
  '5511999998888', 'phone_normalized regenerates from the repaired phone, plus stripped');

-- Re-running the repair over an already-repaired row changes nothing, which
-- is what makes it safe to ship twice (a migration re-applied by hand after a
-- failed deploy is ordinary here).
--
-- ROW COUNT, CAPTURED VIA GET DIAGNOSTICS, ALONGSIDE THE VALUE CHECK BELOW.
-- international_phone is idempotent (asserted above), so a predicate that
-- wrongly re-matched an already-repaired row (comparing against
-- phone_normalized rather than phone -- the mistake this file's own comment
-- warns about) would still write back the SAME value, and a check on phone
-- alone would not see the difference. What changes is whether the row was
-- matched at all: the correct predicate excludes it, so the second UPDATE
-- touches zero rows. xmin was tried first and rejected for this same reason
-- 12b_deadline_sweep.test.sql gives it up for -- it does not reliably tell
-- "untouched" apart from "touched with the same value" either.
do $$
declare
  v_row_count integer;
begin
  update public.members m
     set phone = public.international_phone(m.phone, c.country)
    from public.member_company_links l
    join public.companies c on c.id = l.company_id
   where l.member_id = m.id
     and m.phone is not null
     and public.international_phone(m.phone, c.country) is distinct from m.phone;
  get diagnostics v_row_count = row_count;
  create temporary table t72_second_run as select v_row_count as row_count;
end $$;

select is((select row_count from t72_second_run), 0,
  'the second application matches zero rows -- the predicate excludes an already-repaired one rather than merely rewriting it');

select is(
  (select phone from public.members where id = '00000000-0000-0000-0000-000000000723'),
  '+5511999998888', 'the second application leaves the already-repaired phone unchanged');

select * from finish();
rollback;
