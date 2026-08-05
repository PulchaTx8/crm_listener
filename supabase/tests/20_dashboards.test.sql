begin;
select plan(53);

-- 1: the code exists, or has_permission returns false for every caller and
-- every consolidated call in this block refuses everybody (0010's first line).
select is(
  (select count(*)::int from public.permissions where code = 'reports.consolidated'),
  1,
  'reports.consolidated is in the catalogue');

-- 2: it is Company-scoped, because D3 checks it per Station and an
-- organization-scoped code would be satisfied by holding it anywhere.
select is(
  (select scope::text from public.permissions where code = 'reports.consolidated'),
  'company',
  'reports.consolidated is company-scoped');

-- 3-5: the three indexes the aggregates need. Each source table is filtered by
-- Station AND a date range; without these the aggregate scans.
select has_index('public', 'participations', 'participations_company_period_idx',
  'participations is indexed by station and date');
select has_index('public', 'member_company_links', 'member_links_company_linked_idx',
  'member_company_links is indexed by station and linked_at');
select has_index('public', 'winners', 'winners_company_created_idx',
  'winners is indexed by station and created_at');

-- ---------------------------------------------------------------------------
-- The period resolver (Task 2). Every assertion below uses America/Sao_Paulo,
-- which has been UTC-3 with no DST since 2019, so an expected instant written
-- here stays correct.
-- ---------------------------------------------------------------------------

-- 6-9: a custom period is converted at the Station's timezone, not the
-- server's. This is requirement L2 in one assertion: midnight local on the 1st
-- of August in Sao Paulo is 03:00Z, and a server running UTC that skipped the
-- conversion would place three hours of that day in July.
select is(from_at, '2026-08-01 03:00:00+00'::timestamptz,
          'a custom start is midnight at the Station, not at the server')
  from public.resolve_dashboard_period('custom', '2026-08-01', '2026-09-01', 'America/Sao_Paulo');
select is(to_at, '2026-09-01 03:00:00+00'::timestamptz,
          'a custom end is midnight at the Station too, exclusive')
  from public.resolve_dashboard_period('custom', '2026-08-01', '2026-09-01', 'America/Sao_Paulo');

-- The comparison is the immediately preceding window of the same length (D6).
-- August 2026 is 31 days, so the previous window opens on 1 July.
select is(previous_from_date, '2026-07-01'::date,
          'the comparison window is the preceding window of equal length')
  from public.resolve_dashboard_period('custom', '2026-08-01', '2026-09-01', 'America/Sao_Paulo');
select is(previous_to_date, '2026-08-01'::date,
          'the comparison window ends where the chosen one begins')
  from public.resolve_dashboard_period('custom', '2026-08-01', '2026-09-01', 'America/Sao_Paulo');

-- 10-11: the same period read at a different timezone yields different
-- instants. If this ever passes with equal values, the conversion was dropped.
select isnt(
  (select from_at from public.resolve_dashboard_period('custom', '2026-08-01', '2026-09-01', 'America/Sao_Paulo')),
  (select from_at from public.resolve_dashboard_period('custom', '2026-08-01', '2026-09-01', 'UTC')),
  'two Stations in different zones do not share the same instant');
select is(
  (select from_at from public.resolve_dashboard_period('custom', '2026-08-01', '2026-09-01', 'UTC')),
  '2026-08-01 00:00:00+00'::timestamptz,
  'a UTC Station starts at midnight UTC');

-- 12-15: the presets. Their absolute values depend on when the suite runs, so
-- what is asserted is the SHAPE, which does not.
select is(
  (select to_date from public.resolve_dashboard_period('current_month', null, null, 'America/Sao_Paulo')),
  (select (from_date + interval '1 month')::date from public.resolve_dashboard_period('current_month', null, null, 'America/Sao_Paulo')),
  'current_month spans exactly one month');
select is(
  (select extract(day from from_date)::int from public.resolve_dashboard_period('current_month', null, null, 'America/Sao_Paulo')),
  1,
  'current_month starts on the first of the month');

-- The comparison window of a calendar preset must be the previous CALENDAR
-- unit, and this is the assertion that says so without depending on the month
-- the suite happens to run in: stepping the comparison window forward by one
-- month must land exactly on the chosen window's start. Subtracting a day-count
-- instead -- 31 days off a 31-day May, landing on 31 March -- fails this for
-- every pair of adjacent months with different lengths, and passes only when
-- the value is genuinely right.
select is(
  (select (previous_from_date + interval '1 month')::date from public.resolve_dashboard_period('previous_month', null, null, 'America/Sao_Paulo')),
  (select previous_to_date from public.resolve_dashboard_period('previous_month', null, null, 'America/Sao_Paulo')),
  'previous_month compares against exactly the calendar month before it');
select is(
  (select (previous_from_date + interval '1 month')::date from public.resolve_dashboard_period('current_month', null, null, 'America/Sao_Paulo')),
  (select from_date from public.resolve_dashboard_period('current_month', null, null, 'America/Sao_Paulo')),
  'current_month compares against exactly the calendar month before it');
select is(
  (select (previous_from_date + interval '1 year')::date from public.resolve_dashboard_period('current_year', null, null, 'America/Sao_Paulo')),
  (select from_date from public.resolve_dashboard_period('current_year', null, null, 'America/Sao_Paulo')),
  'current_year compares against exactly the calendar year before it — which a day-count subtraction gets wrong after every leap year');
select is(
  (select to_date from public.resolve_dashboard_period('current_year', null, null, 'America/Sao_Paulo')),
  (select (from_date + interval '1 year')::date from public.resolve_dashboard_period('current_year', null, null, 'America/Sao_Paulo')),
  'current_year spans exactly one year');

-- 18: the preset is resolved at the STATION's clock. Kiritimati is UTC+14 and
-- Niue is UTC-11, twenty-five hours apart, so for part of every day the two
-- are in different months -- and on those days this assertion is the only
-- thing that would catch a resolver that used the server's date.
select ok(
  (select from_date from public.resolve_dashboard_period('current_month', null, null, 'Pacific/Kiritimati'))
  >=
  (select from_date from public.resolve_dashboard_period('current_month', null, null, 'Pacific/Niue')),
  'the month is the Station''s own, so a zone ahead is never behind');

-- 19-21: the refusals. Each is a caller error, not a wrong number.
select throws_ok(
  $$ select * from public.resolve_dashboard_period('custom', null, null, 'America/Sao_Paulo') $$,
  '22023', null, 'a custom period without bounds is refused');
select throws_ok(
  $$ select * from public.resolve_dashboard_period('custom', '2026-09-01', '2026-08-01', 'America/Sao_Paulo') $$,
  '22023', null, 'a period that ends before it starts is refused');
select throws_ok(
  $$ select * from public.resolve_dashboard_period('last_tuesday', null, null, 'America/Sao_Paulo') $$,
  '22023', null, 'an unknown preset is refused rather than defaulted');

-- ---------------------------------------------------------------------------
-- get_audience_dashboard (Task 3). Fixtures use the d8 tag.
-- ---------------------------------------------------------------------------
insert into public.organizations (id, name) values
  ('00000000-0000-0000-0000-0000d8010001', 'Org dashboards');
insert into public.companies (id, organization_id, name, timezone) values
  ('00000000-0000-0000-0000-0000d8020001', '00000000-0000-0000-0000-0000d8010001',
   'Station SP', 'America/Sao_Paulo'),
  ('00000000-0000-0000-0000-0000d8020002', '00000000-0000-0000-0000-0000d8010001',
   'Station UTC', 'UTC');

insert into public.members (id, organization_id, full_name, discovery_source) values
  ('00000000-0000-0000-0000-0000d8030001', '00000000-0000-0000-0000-0000d8010001', 'Ana',  'Instagram'),
  ('00000000-0000-0000-0000-0000d8030002', '00000000-0000-0000-0000-0000d8010001', 'Bruno','Instagram'),
  ('00000000-0000-0000-0000-0000d8030003', '00000000-0000-0000-0000-0000d8010001', 'Célia', null);

-- THE ASSERTION THIS WHOLE BLOCK EXISTS TO GET RIGHT. Ana is linked at 23:30
-- on 31 August, Sao Paulo time -- which is 02:30Z on 1 September. Counted at
-- the Station's clock she belongs to August; counted at the server's she
-- belongs to September.
insert into public.member_company_links (member_id, company_id, organization_id, linked_at) values
  ('00000000-0000-0000-0000-0000d8030001', '00000000-0000-0000-0000-0000d8020001',
   '00000000-0000-0000-0000-0000d8010001', '2026-09-01 02:30:00+00'),
  -- Bruno lands squarely inside August at either clock.
  ('00000000-0000-0000-0000-0000d8030002', '00000000-0000-0000-0000-0000d8020001',
   '00000000-0000-0000-0000-0000d8010001', '2026-08-15 12:00:00+00'),
  -- Célia arrives in July: she counts toward the comparison window, not August.
  ('00000000-0000-0000-0000-0000d8030003', '00000000-0000-0000-0000-0000d8020001',
   '00000000-0000-0000-0000-0000d8010001', '2026-07-20 12:00:00+00');

-- TWO CALLERS, built once here and reused by Tasks 4 and 5. Both are ordinary
-- role holders -- roles, role_permissions, auth.users, company_memberships --
-- exactly as 02_permissions.test.sql:295-336 builds them, because these
-- functions are SECURITY INVOKER and a caller that bypasses RLS would prove
-- nothing about the property D4 buys.
--
--   d8050001  everything: members.view, music.view, promotions.view,
--             participations.view, reports.consolidated, in BOTH Stations.
--   d8050002  members.view, music.view and promotions.view in Station SP, and
--             deliberately NOT participations.view -- the withheld case (D13).
insert into public.roles (id, organization_id, name) values
  ('00000000-0000-0000-0000-0000d8040001', '00000000-0000-0000-0000-0000d8010001', 'Everything'),
  ('00000000-0000-0000-0000-0000d8040002', '00000000-0000-0000-0000-0000d8010001', 'No entries');
insert into public.role_permissions (role_id, permission_code) values
  ('00000000-0000-0000-0000-0000d8040001', 'members.view'),
  ('00000000-0000-0000-0000-0000d8040001', 'music.view'),
  ('00000000-0000-0000-0000-0000d8040001', 'promotions.view'),
  ('00000000-0000-0000-0000-0000d8040001', 'participations.view'),
  ('00000000-0000-0000-0000-0000d8040001', 'reports.consolidated'),
  ('00000000-0000-0000-0000-0000d8040002', 'members.view'),
  ('00000000-0000-0000-0000-0000d8040002', 'music.view'),
  ('00000000-0000-0000-0000-0000d8040002', 'promotions.view');
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000d8050001', 'dash-all@example.test'),
  ('00000000-0000-0000-0000-0000d8050002', 'dash-no-entries@example.test');
insert into public.company_memberships (user_id, company_id, organization_id, role_id) values
  ('00000000-0000-0000-0000-0000d8050001', '00000000-0000-0000-0000-0000d8020001',
   '00000000-0000-0000-0000-0000d8010001', '00000000-0000-0000-0000-0000d8040001'),
  ('00000000-0000-0000-0000-0000d8050001', '00000000-0000-0000-0000-0000d8020002',
   '00000000-0000-0000-0000-0000d8010001', '00000000-0000-0000-0000-0000d8040001'),
  ('00000000-0000-0000-0000-0000d8050002', '00000000-0000-0000-0000-0000d8020001',
   '00000000-0000-0000-0000-0000d8010001', '00000000-0000-0000-0000-0000d8040002');

-- A THIRD CALLER (review fix round 1, Finding 2): d8050001 holds
-- reports.consolidated everywhere it can reach, and d8050002 can only reach
-- one Station at all, so neither shape can exercise D3's refusal -- a
-- consolidated call without reports.consolidated in EVERY named Station. This
-- caller reaches both Stations and holds members.view in both, but
-- reports.consolidated in neither.
insert into public.roles (id, organization_id, name) values
  ('00000000-0000-0000-0000-0000d8040003', '00000000-0000-0000-0000-0000d8010001', 'Two stations, no consolidation');
insert into public.role_permissions (role_id, permission_code) values
  ('00000000-0000-0000-0000-0000d8040003', 'members.view');
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000d8050004', 'dash-two-stations@example.test');
insert into public.company_memberships (user_id, company_id, organization_id, role_id) values
  ('00000000-0000-0000-0000-0000d8050004', '00000000-0000-0000-0000-0000d8020001',
   '00000000-0000-0000-0000-0000d8010001', '00000000-0000-0000-0000-0000d8040003'),
  ('00000000-0000-0000-0000-0000d8050004', '00000000-0000-0000-0000-0000d8020002',
   '00000000-0000-0000-0000-0000d8010001', '00000000-0000-0000-0000-0000d8040003');

-- 20-21: the refusals, asserted as a signed-in user who simply is not a member
-- of this Organization at all. 42501, never an empty payload -- zero and "you
-- may not see this" must not render alike.
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000d8050003', 'dash-outsider@example.test');
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-0000d8050003", "role": "authenticated"}';
select throws_ok(
  $$ select public.get_audience_dashboard(array['00000000-0000-0000-0000-0000d8020001']::uuid[], 'current_month', null, null) $$,
  '42501', null, 'a caller without members.view is refused, not given zeros');
select throws_ok(
  $$ select public.get_audience_dashboard(array[]::uuid[], 'current_month', null, null) $$,
  '22023', null, 'a call naming no station is refused');
reset role;

-- Everything below runs as d8050001 unless a block says otherwise.
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-0000d8050001", "role": "authenticated"}';

-- 22-23: August at the Sao Paulo Station. Ana (23:30 local on the 31st) and
-- Bruno are in; Célia is not. Counted in UTC this would be 1, and that single
-- difference is requirement L2.
select is(
  (public.get_audience_dashboard(array['00000000-0000-0000-0000-0000d8020001']::uuid[],
     'custom', '2026-08-01', '2026-09-01') #>> '{cards,new_listeners,current}')::int,
  2,
  'a link at 23:30 local on the last day counts in that month');
select is(
  (public.get_audience_dashboard(array['00000000-0000-0000-0000-0000d8020001']::uuid[],
     'custom', '2026-08-01', '2026-09-01') #>> '{cards,new_listeners,previous}')::int,
  1,
  'July''s arrival is the comparison figure, not August''s');

-- 24: the same window at a UTC Station puts Ana in September. Proved against
-- the same rows by moving the links, so the only variable is the timezone.
-- The write is fixture surgery and runs as the migration role: 0035 revokes
-- insert on member_company_links from authenticated, because every real write
-- to it goes through a SECURITY DEFINER RPC in 0034.
reset role;
insert into public.member_company_links (member_id, company_id, organization_id, linked_at)
select member_id, '00000000-0000-0000-0000-0000d8020002', organization_id, linked_at
  from public.member_company_links
 where company_id = '00000000-0000-0000-0000-0000d8020001';
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-0000d8050001", "role": "authenticated"}';
select is(
  (public.get_audience_dashboard(array['00000000-0000-0000-0000-0000d8020002']::uuid[],
     'custom', '2026-08-01', '2026-09-01') #>> '{cards,new_listeners,current}')::int,
  1,
  'the same rows counted at a UTC Station exclude the 02:30Z link');

-- 25: the stock figure is measured as of the window's end (D6), so a
-- historical period reports what was true then.
select is(
  (public.get_audience_dashboard(array['00000000-0000-0000-0000-0000d8020001']::uuid[],
     'custom', '2026-08-01', '2026-09-01') #>> '{cards,listeners,current}')::int,
  3,
  'the listener total is measured at the end of the window');

-- 26: an anonymised member is not audience any more. The write is done as the
-- migration role -- an authenticated caller has no grant to update members
-- directly, and this is fixture surgery, not the behaviour under test.
reset role;
update public.members set anonymized_at = now()
 where id = '00000000-0000-0000-0000-0000d8030002';
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-0000d8050001", "role": "authenticated"}';
select is(
  (public.get_audience_dashboard(array['00000000-0000-0000-0000-0000d8020001']::uuid[],
     'custom', '2026-08-01', '2026-09-01') #>> '{cards,listeners,current}')::int,
  2,
  'an anonymised member leaves the audience total');
reset role;
update public.members set anonymized_at = null
 where id = '00000000-0000-0000-0000-0000d8030002';
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-0000d8050001", "role": "authenticated"}';

-- 27: the discovery breakdown names the unfilled rather than dropping it, so
-- its buckets sum to the total beside them (D8's rule, applied here).
select is(
  (select sum((value ->> 'count')::int)::int
     from jsonb_array_elements(
       public.get_audience_dashboard(array['00000000-0000-0000-0000-0000d8020001']::uuid[],
         'custom', '2026-08-01', '2026-09-01') #> '{top,discovery_source}')),
  3,
  'the discovery buckets, including "not stated", sum to the audience');

-- 28-29: two Stations at once needs reports.consolidated in both, and the
-- payload names both Stations with their own timezones.
select is(
  jsonb_array_length(
    public.get_audience_dashboard(
      array['00000000-0000-0000-0000-0000d8020001','00000000-0000-0000-0000-0000d8020002']::uuid[],
      'custom', '2026-08-01', '2026-09-01') #> '{stations}'),
  2,
  'a consolidated payload names every Station it summed');
select is(
  (public.get_audience_dashboard(
      array['00000000-0000-0000-0000-0000d8020001','00000000-0000-0000-0000-0000d8020001']::uuid[],
      'custom', '2026-08-01', '2026-09-01') #>> '{cards,new_listeners,current}')::int,
  2,
  'a repeated Station id is deduplicated, not double-counted');

-- Review fix round 1, Finding 2: D3's refusal (0118:62-64) had no test proving
-- it fires. Switch to the caller who reaches both Stations but holds
-- reports.consolidated in neither -- the shape neither existing caller has.
reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-0000d8050004", "role": "authenticated"}';
select lives_ok($$
  select public.get_audience_dashboard(array['00000000-0000-0000-0000-0000d8020001']::uuid[],
    'custom', '2026-08-01', '2026-09-01')
$$, 'a single-Station call succeeds without reports.consolidated -- the refusal is about consolidating, not the caller');
select throws_ok($$
  select public.get_audience_dashboard(
    array['00000000-0000-0000-0000-0000d8020001','00000000-0000-0000-0000-0000d8020002']::uuid[],
    'custom', '2026-08-01', '2026-09-01')
$$, '42501', null, 'a two-Station call is refused without reports.consolidated in both (D3)');
reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-0000d8050001", "role": "authenticated"}';

-- 30-31: the withheld contract (D13). With participations.view the figure is a
-- card; without it, it is named in withheld and absent from cards -- never a
-- zero, which would read as "nobody took part".
select is(
  (public.get_audience_dashboard(array['00000000-0000-0000-0000-0000d8020001']::uuid[],
     'custom', '2026-08-01', '2026-09-01') #> '{withheld}'),
  '[]'::jsonb,
  'nothing is withheld from a caller holding participations.view');

-- 32: took_part had no assertion that it ever counts anything -- only that it
-- is present or absent. One promotion at Station SP, one VALID participation
-- by Ana inside August, gives it teeth. Fixture surgery as the migration role:
-- 0044/0053 grant no role insert on promotions or participations, since every
-- real write goes through a SECURITY DEFINER RPC.
reset role;
insert into public.promotions (id, organization_id, company_id, name, starts_at, ends_at) values
  ('00000000-0000-0000-0000-0000d8090001', '00000000-0000-0000-0000-0000d8010001',
   '00000000-0000-0000-0000-0000d8020001', 'August Quiz',
   '2026-08-01 00:00:00+00', '2026-09-01 00:00:00+00');
insert into public.participations
  (id, promotion_id, member_id, organization_id, company_id, allows_multiple, status, source, participated_at)
values
  ('00000000-0000-0000-0000-0000d80d0001', '00000000-0000-0000-0000-0000d8090001',
   '00000000-0000-0000-0000-0000d8030001', '00000000-0000-0000-0000-0000d8010001',
   '00000000-0000-0000-0000-0000d8020001', false, 'VALID', 'MANUAL', '2026-08-15 12:00:00+00');
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-0000d8050001", "role": "authenticated"}';
select is(
  (public.get_audience_dashboard(array['00000000-0000-0000-0000-0000d8020001']::uuid[],
     'custom', '2026-08-01', '2026-09-01') #>> '{cards,took_part,current}')::int,
  1,
  'took_part actually counts a valid participation inside the window');

-- 33: D12b -- every figure on this panel counts the same population. Ana's
-- participation happened, but she has since been erased, and took_part must
-- not count her any more than listeners does -- the two cards must never
-- disagree about who counts. Bracketed as migration-role fixture surgery, the
-- same rule assertion 26 above already follows.
reset role;
update public.members set anonymized_at = now()
 where id = '00000000-0000-0000-0000-0000d8030001';
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-0000d8050001", "role": "authenticated"}';
select is(
  (public.get_audience_dashboard(array['00000000-0000-0000-0000-0000d8020001']::uuid[],
     'custom', '2026-08-01', '2026-09-01') #>> '{cards,took_part,current}')::int,
  0,
  'an anonymised participant is excluded from took_part too (D12b)');
reset role;
update public.members set anonymized_at = null
 where id = '00000000-0000-0000-0000-0000d8030001';
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-0000d8050001", "role": "authenticated"}';

-- Review fix round 1, Finding 1: cards.barred and breakdowns.blocks_by_kind
-- were entirely untested -- no member_blocks fixture existed anywhere in this
-- file, so neither the D12b join on these two CTEs, nor the distinct-member
-- counting, nor the Organization-wide branch (0032: a null
-- member_blocks.company_id means the whole Organization) had ever run
-- against non-empty data. Two blocks prove all three: one Station-scoped, one
-- Organization-wide, on two members not otherwise used in this file. Fixture
-- surgery as the migration role, same rule as every other write in this file.
reset role;
insert into public.members (id, organization_id, full_name) values
  ('00000000-0000-0000-0000-0000d8030004', '00000000-0000-0000-0000-0000d8010001', 'Diana'),
  ('00000000-0000-0000-0000-0000d8030005', '00000000-0000-0000-0000-0000d8010001', 'Elisa');
-- Both need a member_company_links row somewhere the caller can see, or
-- members_select_reachable (0035) hides the row outright: member_reachable
-- requires a link at a Station the caller holds members.view in, and the
-- D12b join to members added above runs under that same RLS, since this
-- function is SECURITY INVOKER. Elisa's link additionally satisfies
-- member_blocks_select_reachable's own Organization-wide arm, which repeats
-- exactly this requirement for the block row itself.
insert into public.member_company_links (member_id, company_id, organization_id, linked_at) values
  ('00000000-0000-0000-0000-0000d8030004', '00000000-0000-0000-0000-0000d8020001',
   '00000000-0000-0000-0000-0000d8010001', now()),
  ('00000000-0000-0000-0000-0000d8030005', '00000000-0000-0000-0000-0000d8020001',
   '00000000-0000-0000-0000-0000d8010001', now());
insert into public.member_blocks (id, organization_id, member_id, company_id, kind, reason, starts_at) values
  ('00000000-0000-0000-0000-0000d8110001', '00000000-0000-0000-0000-0000d8010001',
   '00000000-0000-0000-0000-0000d8030004', '00000000-0000-0000-0000-0000d8020001',
   'draw_ban', 'Station-scoped test block', '2026-08-10 12:00:00+00'),
  ('00000000-0000-0000-0000-0000d8110002', '00000000-0000-0000-0000-0000d8010001',
   '00000000-0000-0000-0000-0000d8030005', null,
   'draw_ban', 'Organization-wide test block', '2026-08-10 12:00:00+00');
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-0000d8050001", "role": "authenticated"}';

select is(
  (public.get_audience_dashboard(array['00000000-0000-0000-0000-0000d8020001']::uuid[],
     'custom', '2026-08-01', '2026-09-01') #>> '{cards,barred,current}')::int,
  2,
  'barred counts both the Station-scoped and the Organization-wide block');

-- The assertion the function's own comment writes a cheque for: a
-- consolidated call over both Stations sees the Organization-wide block via
-- BOTH Stations' rows, but must still count the one member once, not once per
-- Station reached.
select is(
  (public.get_audience_dashboard(
      array['00000000-0000-0000-0000-0000d8020001','00000000-0000-0000-0000-0000d8020002']::uuid[],
      'custom', '2026-08-01', '2026-09-01') #>> '{cards,barred,current}')::int,
  2,
  'a consolidated panel counts an Organization-wide block once, not once per Station');

select is(
  (public.get_audience_dashboard(array['00000000-0000-0000-0000-0000d8020001']::uuid[],
     'custom', '2026-08-01', '2026-09-01') #> '{breakdowns,blocks_by_kind}'),
  '[{"key": "draw_ban", "label": "draw_ban", "count": 2}]'::jsonb,
  'blocks_by_kind names the kind used, with the count both blocks contribute to it');

-- D12b on barred: the same population rule proved for took_part, proved here
-- the same way -- anonymise the Station-scoped block's member and watch the
-- count drop.
reset role;
update public.members set anonymized_at = now()
 where id = '00000000-0000-0000-0000-0000d8030004';
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-0000d8050001", "role": "authenticated"}';
select is(
  (public.get_audience_dashboard(array['00000000-0000-0000-0000-0000d8020001']::uuid[],
     'custom', '2026-08-01', '2026-09-01') #>> '{cards,barred,current}')::int,
  1,
  'an anonymised barred member is excluded from barred too (D12b)');
reset role;
update public.members set anonymized_at = null
 where id = '00000000-0000-0000-0000-0000d8030004';
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-0000d8050001", "role": "authenticated"}';

-- Switch to the caller who lacks participations.view. Same rows, same window,
-- different permissions: the figure must be ABSENT, not zero. A zero would say
-- "nobody took part", which is a claim about the audience rather than about
-- this caller.
reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-0000d8050002", "role": "authenticated"}';
select is(
  (public.get_audience_dashboard(array['00000000-0000-0000-0000-0000d8020001']::uuid[],
     'custom', '2026-08-01', '2026-09-01') #> '{cards,took_part}'),
  null,
  'without participations.view the figure is absent, not zero');
select is(
  (public.get_audience_dashboard(array['00000000-0000-0000-0000-0000d8020001']::uuid[],
     'custom', '2026-08-01', '2026-09-01') #>> '{withheld,0,needs}'),
  'participations.view',
  'and the payload names the permission that would fill it');
reset role;

-- ---------------------------------------------------------------------------
-- get_music_dashboard (Task 4). Fixtures first, as the migration role.
-- ---------------------------------------------------------------------------
insert into public.artists (id, organization_id, company_id, name) values
  ('00000000-0000-0000-0000-0000d8060001', '00000000-0000-0000-0000-0000d8010001',
   '00000000-0000-0000-0000-0000d8020001', 'Artist One');
insert into public.music_genres (id, organization_id, company_id, name) values
  ('00000000-0000-0000-0000-0000d8070001', '00000000-0000-0000-0000-0000d8010001',
   '00000000-0000-0000-0000-0000d8020001', 'Samba');

-- Four songs covering the two nullable attributes and three of the five vocal
-- values, so the breakdowns below have something to drop if they are written
-- as a two-slice chart.
insert into public.songs (id, organization_id, company_id, title, artist_id, genre_id, nationality, vocal) values
  ('00000000-0000-0000-0000-0000d8080001', '00000000-0000-0000-0000-0000d8010001',
   '00000000-0000-0000-0000-0000d8020001', 'One',   '00000000-0000-0000-0000-0000d8060001',
   '00000000-0000-0000-0000-0000d8070001', 'DOMESTIC', 'MALE'),
  ('00000000-0000-0000-0000-0000d8080002', '00000000-0000-0000-0000-0000d8010001',
   '00000000-0000-0000-0000-0000d8020001', 'Two',   '00000000-0000-0000-0000-0000d8060001',
   '00000000-0000-0000-0000-0000d8070001', 'INTERNATIONAL', 'INSTRUMENTAL'),
  ('00000000-0000-0000-0000-0000d8080003', '00000000-0000-0000-0000-0000d8010001',
   '00000000-0000-0000-0000-0000d8020001', 'Three', '00000000-0000-0000-0000-0000d8060001',
   '00000000-0000-0000-0000-0000d8070001', null, null),
  ('00000000-0000-0000-0000-0000d8080004', '00000000-0000-0000-0000-0000d8010001',
   '00000000-0000-0000-0000-0000d8020001', 'Four',  '00000000-0000-0000-0000-0000d8060001',
   '00000000-0000-0000-0000-0000d8070001', 'DOMESTIC', 'DUO');

-- Five requests in August: song One three times, the rest once each.
insert into public.music_requests (organization_id, company_id, member_id, song_id, requested_at)
values
  ('00000000-0000-0000-0000-0000d8010001','00000000-0000-0000-0000-0000d8020001',
   '00000000-0000-0000-0000-0000d8030001','00000000-0000-0000-0000-0000d8080001','2026-08-10 12:00:00+00'),
  ('00000000-0000-0000-0000-0000d8010001','00000000-0000-0000-0000-0000d8020001',
   '00000000-0000-0000-0000-0000d8030001','00000000-0000-0000-0000-0000d8080001','2026-08-11 12:00:00+00'),
  ('00000000-0000-0000-0000-0000d8010001','00000000-0000-0000-0000-0000d8020001',
   '00000000-0000-0000-0000-0000d8030001','00000000-0000-0000-0000-0000d8080001','2026-08-12 12:00:00+00'),
  ('00000000-0000-0000-0000-0000d8010001','00000000-0000-0000-0000-0000d8020001',
   '00000000-0000-0000-0000-0000d8030001','00000000-0000-0000-0000-0000d8080002','2026-08-13 12:00:00+00'),
  ('00000000-0000-0000-0000-0000d8010001','00000000-0000-0000-0000-0000d8020001',
   '00000000-0000-0000-0000-0000d8030001','00000000-0000-0000-0000-0000d8080003','2026-08-14 12:00:00+00');

set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-0000d8050001", "role": "authenticated"}';

-- 43: requests in the window.
select is(
  (public.get_music_dashboard(array['00000000-0000-0000-0000-0000d8020001']::uuid[],
     'custom', '2026-08-01', '2026-09-01') #>> '{cards,requests,current}')::int,
  5, 'the request count is the requests in the window');

-- 44: the catalogue and the requests are separate numbers, because §4.2 does
-- not say which "total" it meant and the two answer different questions.
select is(
  (public.get_music_dashboard(array['00000000-0000-0000-0000-0000d8020001']::uuid[],
     'custom', '2026-08-01', '2026-09-01') #>> '{cards,catalogue,current}')::int,
  4, 'the catalogue total counts songs, not requests');

-- 45: most requested.
select is(
  (public.get_music_dashboard(array['00000000-0000-0000-0000-0000d8020001']::uuid[],
     'custom', '2026-08-01', '2026-09-01') #>> '{top,songs,0,label}'),
  'One', 'the most requested song leads the list');

-- 46-47: THE BREAKDOWN THAT §4.2 WOULD HAVE GOT WRONG. Five requests: three
-- domestic (One x3), one international (Two), one not stated (Three). Four is
-- never requested and so contributes nothing to either breakdown, even though
-- it has both attributes filled in -- these are breakdowns of REQUESTS, not of
-- the catalogue. Whatever the split, the buckets must sum to the request
-- total -- a two-slice chart would sum to 4 and still show "5 requests" beside
-- it.
select is(
  (select sum((value ->> 'count')::int)::int
     from jsonb_array_elements(
       public.get_music_dashboard(array['00000000-0000-0000-0000-0000d8020001']::uuid[],
         'custom', '2026-08-01', '2026-09-01') #> '{breakdowns,nationality}')),
  5, 'the nationality buckets sum to the requests, including "not stated"');
select is(
  (select sum((value ->> 'count')::int)::int
     from jsonb_array_elements(
       public.get_music_dashboard(array['00000000-0000-0000-0000-0000d8020001']::uuid[],
         'custom', '2026-08-01', '2026-09-01') #> '{breakdowns,vocal}')),
  5, 'the vocal buckets sum to the requests, all five values plus "not stated"');

-- 48: a soft-deleted request leaves every figure (0098's partial indexes and
-- policies treat deleted_at as gone, and so must this).
reset role;
update public.music_requests set deleted_at = now()
 where song_id = '00000000-0000-0000-0000-0000d8080003';
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-0000d8050001", "role": "authenticated"}';
select is(
  (public.get_music_dashboard(array['00000000-0000-0000-0000-0000d8020001']::uuid[],
     'custom', '2026-08-01', '2026-09-01') #>> '{cards,requests,current}')::int,
  4, 'a soft-deleted request is not counted');

-- 49: nothing is ever withheld here -- every figure reads a table gated by
-- music.view, which is this panel's own gate (D13). d8u02 lacks
-- participations.view and is used deliberately: even the caller who loses
-- figures on the other two panels loses none here.
reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-0000d8050002", "role": "authenticated"}';
select is(
  (public.get_music_dashboard(array['00000000-0000-0000-0000-0000d8020001']::uuid[],
     'custom', '2026-08-01', '2026-09-01') #> '{withheld}'),
  '[]'::jsonb, 'the music panel withholds nothing');
reset role;

-- 50: and the gate is still a gate -- the outsider from assertion 20, who is
-- a signed-in user of no Station at all.
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-0000d8050003", "role": "authenticated"}';
select throws_ok(
  $$ select public.get_music_dashboard(array['00000000-0000-0000-0000-0000d8020001']::uuid[], 'custom', '2026-08-01', '2026-09-01') $$,
  '42501', null, 'a caller without music.view is refused');
reset role;

-- 51-53: the consolidated path, closed here rather than left for review --
-- the same class of gap Task 3's review caught on get_audience_dashboard: a
-- correct-but-unexercised branch in a function whose defects are silent.
--
-- Station UTC gets its own artist, song and two requests inside the window,
-- as migration-role fixture surgery, so a consolidated call over both
-- Stations produces a number strictly larger than either Station alone --
-- asserting a sum against an empty second Station would prove nothing.
insert into public.artists (id, organization_id, company_id, name) values
  ('00000000-0000-0000-0000-0000d8060002', '00000000-0000-0000-0000-0000d8010001',
   '00000000-0000-0000-0000-0000d8020002', 'Artist UTC');
insert into public.songs (id, organization_id, company_id, title, artist_id) values
  ('00000000-0000-0000-0000-0000d8080005', '00000000-0000-0000-0000-0000d8010001',
   '00000000-0000-0000-0000-0000d8020002', 'Five', '00000000-0000-0000-0000-0000d8060002');
insert into public.music_requests (organization_id, company_id, member_id, song_id, requested_at)
values
  ('00000000-0000-0000-0000-0000d8010001','00000000-0000-0000-0000-0000d8020002',
   '00000000-0000-0000-0000-0000d8030001','00000000-0000-0000-0000-0000d8080005','2026-08-16 12:00:00+00'),
  ('00000000-0000-0000-0000-0000d8010001','00000000-0000-0000-0000-0000d8020002',
   '00000000-0000-0000-0000-0000d8030001','00000000-0000-0000-0000-0000d8080005','2026-08-17 12:00:00+00');
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-0000d8050001", "role": "authenticated"}';

-- 51: a consolidated payload names every Station it summed.
select is(
  jsonb_array_length(
    public.get_music_dashboard(
      array['00000000-0000-0000-0000-0000d8020001','00000000-0000-0000-0000-0000d8020002']::uuid[],
      'custom', '2026-08-01', '2026-09-01') #> '{stations}'),
  2,
  'a consolidated music payload names both stations it summed');

-- 52: and a figure genuinely sums across them: SP has 4 (after the
-- soft-delete at assertion 48), UTC has 2, consolidated must show 6 -- not 4,
-- which is what a query that silently ignored the second Station would still
-- show.
select is(
  (public.get_music_dashboard(
      array['00000000-0000-0000-0000-0000d8020001','00000000-0000-0000-0000-0000d8020002']::uuid[],
      'custom', '2026-08-01', '2026-09-01') #>> '{cards,requests,current}')::int,
  6,
  'a consolidated requests figure sums both stations, not just one');

-- 53: D3's refusal, exercised on THIS function specifically. d8050004
-- (Task 3) reaches both Stations and was built to hold no
-- reports.consolidated -- but its role only ever granted members.view, so as
-- built it would refuse a music-dashboard call on the music.view check
-- first, proving nothing about the consolidated gate. Extended here (not
-- rebuilt) with music.view, so this assertion actually exercises D3's branch
-- rather than short-circuiting on an earlier one.
reset role;
insert into public.role_permissions (role_id, permission_code) values
  ('00000000-0000-0000-0000-0000d8040003', 'music.view');
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-0000d8050004", "role": "authenticated"}';
select throws_ok($$
  select public.get_music_dashboard(
    array['00000000-0000-0000-0000-0000d8020001','00000000-0000-0000-0000-0000d8020002']::uuid[],
    'custom', '2026-08-01', '2026-09-01')
$$, '42501', null, 'a two-Station call is refused without reports.consolidated in both, for music too (D3)');
reset role;

select * from finish();
rollback;
