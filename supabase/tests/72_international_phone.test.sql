begin;
select plan(18);

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

-- phone_normalized is GENERATED from phone (0031: generated always as
-- normalize_phone(phone) stored) -- Postgres recomputes it atomically on
-- every write and refuses a direct one, so this assertion cannot fail
-- independently of the phone assertion above; it is not a guard against a
-- stale column. Asserted anyway because phone and phone_normalized are the
-- two halves that must agree: phone is the form a person reads, and
-- phone_normalized is what members_phone_unique (0031) actually dedupes on
-- and so decides identity. This pins the exact digit string the repair
-- produces rather than leaving it implicit.
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
-- touches zero rows. xmin was tried first and rejected: this whole file runs
-- inside one transaction that never commits (begin; ... rollback;), so every
-- row version any statement here writes carries that same transaction's
-- xmin no matter how many times the row is rewritten -- a before/after
-- comparison would read "unchanged" whether the second UPDATE touched the
-- row or not. Not the same mechanism 12b_deadline_sweep.test.sql documents:
-- that file's xmin drift comes from per-iteration savepoints inside a loop's
-- begin...exception...end, which this block has none of.
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

-- 0263. THE DOORS. Three assertions on the one the owner reported through --
-- resolve_or_create_member, the manual entry door behind the Participations
-- screen and the per-row door import_participations calls -- driven as a real
-- operator rather than as the superuser pgTAP runs as, because create_member
-- is gated on members.create and find_member_by_identifier on members.view,
-- and a call with no auth.uid() fails both. The role/grant idiom is
-- 71_promotion_rules_gate.test.sql's.
--
-- THE SAME NUMBER IS ENTERED TWICE, IN ITS TWO SPELLINGS, and that is the
-- whole test: the first call is a listener this Station has never seen, typed
-- the way an operator types one; the second is the same human, typed the way
-- the bot and the spreadsheet spell them. Before 0263 the first call stored
-- 11988887777 and the second found nothing to resolve, so the Organization
-- ended the file holding TWO listeners for one person -- which is the defect
-- item 1b exists to close, and what assertion 17 counts.
insert into public.organizations (id, name) values
  ('00000000-0000-0000-0000-0000000030e1', 'Org 30d');
-- country 'BR' EXPLICITLY, not left to 0261's backfill: 0261 has already run
-- against this database by the time a test does, so a row inserted now with a
-- null country would stay null and international_phone would answer the bare
-- digits -- the assertions below would then be measuring a Station with no
-- country rather than a door with no sanitation.
insert into public.companies (id, organization_id, name, country) values
  ('00000000-0000-0000-0000-0000000030e2', '00000000-0000-0000-0000-0000000030e1', 'Station 30d', 'BR');
insert into public.roles (id, organization_id, name) values
  ('00000000-0000-0000-0000-0000000030e3', '00000000-0000-0000-0000-0000000030e1', 'Listener Registrar 30d');
insert into public.role_permissions (role_id, permission_code) values
  -- find_member_by_identifier's own gate, checked Organization-wide: without
  -- it the resolve half raises 42501 before the sanitation is reached at all.
  ('00000000-0000-0000-0000-0000000030e3', 'members.view'),
  ('00000000-0000-0000-0000-0000000030e3', 'members.create');
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000030e4', 'phone-doors-30d@example.test');
insert into public.company_memberships (user_id, company_id, organization_id, role_id) values
  ('00000000-0000-0000-0000-0000000030e4', '00000000-0000-0000-0000-0000000030e2',
   '00000000-0000-0000-0000-0000000030e1', '00000000-0000-0000-0000-0000000030e3');

set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-0000000030e4", "role": "authenticated"}';

-- Both calls are made here, under the operator's own role, and the answers are
-- parked in temporary tables: the assertions below read public.members, which
-- this operator's RLS would filter, and reset role is what lets them see the
-- Organization whole rather than the slice one membership admits.
create temporary table t30d_local as
select public.resolve_or_create_member(
  '00000000-0000-0000-0000-0000000030e2'::uuid,   -- company, country 'BR'
  'Ouvinte Local',
  '11 98888-7777') as answer;

create temporary table t30d_international as
select public.resolve_or_create_member(
  '00000000-0000-0000-0000-0000000030e2'::uuid,
  'Ouvinte Internacional',
  '+55 11 98888-7777') as answer;

reset role;

-- 16: phone_normalized, not phone, because that is the column
-- members_phone_unique (0031) dedupes on and therefore the one that decides
-- whether these two calls describe one person. It drops the plus the door
-- stores, which is why the expected value carries no plus while
-- international_phone's own assertions above all do.
select is(
  (select m.phone_normalized
     from public.members m
    where m.id = ((select answer from t30d_local) ->> 'member_id')::uuid),
  '5511988887777',
  'the manual entry door stores the international form');

-- 17: counted over the ORGANIZATION rather than over the phone. A count
-- filtered to phone_normalized = '5511988887777' would answer 1 whether or not
-- the second call created a second listener, because the second row would
-- carry the OTHER spelling and fall outside the filter -- an assertion that
-- holds with the repair and equally without it. Counting the Organization is
-- what makes the duplicate visible: 2 before 0263, 1 after.
select is(
  (select count(*) from public.members
    where organization_id = '00000000-0000-0000-0000-0000000030e1'),
  1::bigint,
  'the local and international spellings resolve to ONE listener');

-- 18: and it is the SAME listener, not merely the same number of them. The id
-- is compared rather than the outcome string, because an outcome of 'resolved'
-- naming a different row would be a worse failure than 'created' and the two
-- deserve to be told apart by what the assertion prints.
select is(
  (select (answer ->> 'member_id')::uuid from t30d_international),
  (select (answer ->> 'member_id')::uuid from t30d_local),
  'and the international spelling of the same number agrees');

select * from finish();
rollback;
