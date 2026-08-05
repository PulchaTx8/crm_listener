begin;
select plan(87);

-- THE COMMENTS BELOW NO LONGER NUMBER THE ASSERTIONS, and that is the fix
-- rather than an omission (whole-branch review, Minor C7). Every comment here
-- used to open with "-- 43:" or "-- 59-60:", and an assertion's ordinal is a
-- fact that goes stale the moment anything is inserted above it: two rounds of
-- fixes had already left this file with a "-- 20-21" three lines under a
-- "-- 19-21", a "-- 51-53" immediately followed by a "-- 51", and the pair the
-- review flagged as off by two. The numbers are gone; what each block is FOR
-- is what the comment says, and cross-references name the assertion rather
-- than count to it.

-- the code exists, or has_permission returns false for every caller and
-- every consolidated call in this block refuses everybody (0010's first line).
select is(
  (select count(*)::int from public.permissions where code = 'reports.consolidated'),
  1,
  'reports.consolidated is in the catalogue');

-- it is Company-scoped, because D3 checks it per Station and an
-- organization-scoped code would be satisfied by holding it anywhere.
select is(
  (select scope::text from public.permissions where code = 'reports.consolidated'),
  'company',
  'reports.consolidated is company-scoped');

-- the three indexes the aggregates need. Each source table is filtered by
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

-- a custom period is converted at the Station's timezone, not the
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

-- the same period read at a different timezone yields different
-- instants. If this ever passes with equal values, the conversion was dropped.
select isnt(
  (select from_at from public.resolve_dashboard_period('custom', '2026-08-01', '2026-09-01', 'America/Sao_Paulo')),
  (select from_at from public.resolve_dashboard_period('custom', '2026-08-01', '2026-09-01', 'UTC')),
  'two Stations in different zones do not share the same instant');
select is(
  (select from_at from public.resolve_dashboard_period('custom', '2026-08-01', '2026-09-01', 'UTC')),
  '2026-08-01 00:00:00+00'::timestamptz,
  'a UTC Station starts at midnight UTC');

-- the presets. Their absolute values depend on when the suite runs, so
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

-- the preset is resolved at the STATION's clock. Kiritimati is UTC+14 and
-- Niue is UTC-11, twenty-five hours apart, so for part of every day the two
-- are in different months -- and on those days this assertion is the only
-- thing that would catch a resolver that used the server's date.
select ok(
  (select from_date from public.resolve_dashboard_period('current_month', null, null, 'Pacific/Kiritimati'))
  >=
  (select from_date from public.resolve_dashboard_period('current_month', null, null, 'Pacific/Niue')),
  'the month is the Station''s own, so a zone ahead is never behind');

-- the refusals. Each is a caller error, not a wrong number.
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

-- the refusals, asserted as a signed-in user who simply is not a member
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

-- August at the Sao Paulo Station. Ana (23:30 local on the 31st) and
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

-- the same window at a UTC Station puts Ana in September. Proved against
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

-- MONTHLY, which nothing in this file exercised until the whole-branch review
-- asked for it (Important B8). `date_trunc(... at time zone ...)` is the only
-- timezone-sensitive arithmetic in this block after the period resolver, it is
-- written out three times (0118, 0119, 0120), and it had never once run
-- against data. The window is widened to October here so Ana's 2026-09-01
-- 02:30Z link falls inside it at EITHER clock: at Sao Paulo that instant is
-- 23:30 on 31 August and belongs to the August bucket, at UTC it is 02:30 on
-- 1 September and belongs to September. One row, two buckets, decided entirely
-- by the Station's own clock -- the same single difference the new_listeners
-- pair above makes for a card, made here for the chart.
select is(
  (select (elem ->> 'count')::int
     from jsonb_array_elements(
       public.get_audience_dashboard(array['00000000-0000-0000-0000-0000d8020001']::uuid[],
         'custom', '2026-08-01', '2026-10-01') #> '{monthly}') elem
    where elem ->> 'month' = '2026-08'),
  2,
  'monthly buckets the 23:30-local link into August at the Sao Paulo Station');
select is(
  (select count(*)::int
     from jsonb_array_elements(
       public.get_audience_dashboard(array['00000000-0000-0000-0000-0000d8020001']::uuid[],
         'custom', '2026-08-01', '2026-10-01') #> '{monthly}') elem
    where elem ->> 'month' = '2026-09'),
  0,
  'and Sao Paulo has no September bucket at all, because nothing arrived there in September');
select is(
  (select (elem ->> 'count')::int
     from jsonb_array_elements(
       public.get_audience_dashboard(array['00000000-0000-0000-0000-0000d8020002']::uuid[],
         'custom', '2026-08-01', '2026-10-01') #> '{monthly}') elem
    where elem ->> 'month' = '2026-09'),
  1,
  'the same row buckets into September at the UTC Station');

-- D5 as amended (whole-branch review, Important A1): a preset resolves from
-- now() at EACH Station's clock, so the payload has to carry each Station's
-- own resolved dates rather than let the screen assume one calendar. This is
-- that contract, asserted against resolve_dashboard_period itself: every
-- station entry's from/to must equal what the resolver returns for that
-- Station's own timezone, for a PRESET (the case where they can genuinely
-- differ), not merely for a custom range where they cannot.
select is(
  (select count(*)::int
     from jsonb_array_elements(
            public.get_audience_dashboard(
              array['00000000-0000-0000-0000-0000d8020001','00000000-0000-0000-0000-0000d8020002']::uuid[],
              'current_month', null, null) #> '{stations}') s
     join public.companies c on c.id = (s ->> 'id')::uuid
     cross join lateral public.resolve_dashboard_period('current_month', null, null, c.timezone) p
    where (s ->> 'from')::date = p.from_date
      and (s ->> 'to')::date   = p.to_date),
  2,
  'every station entry carries its OWN resolved dates, not one calendar imposed on all of them');
select is(
  (public.get_audience_dashboard(array['00000000-0000-0000-0000-0000d8020001']::uuid[],
     'custom', '2026-08-01', '2026-09-01') #>> '{stations,0,from}'),
  '2026-08-01',
  'and a custom range is reported on the station entry too, where every Station does agree');

-- the stock figure is measured as of the window's end (D6), so a
-- historical period reports what was true then.
select is(
  (public.get_audience_dashboard(array['00000000-0000-0000-0000-0000d8020001']::uuid[],
     'custom', '2026-08-01', '2026-09-01') #>> '{cards,listeners,current}')::int,
  3,
  'the listener total is measured at the end of the window');

-- an anonymised member is not audience any more. The write is done as the
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

-- the discovery breakdown names the unfilled rather than dropping it, so
-- its buckets sum to the total beside them (D8's rule, applied here).
select is(
  (select sum((value ->> 'count')::int)::int
     from jsonb_array_elements(
       public.get_audience_dashboard(array['00000000-0000-0000-0000-0000d8020001']::uuid[],
         'custom', '2026-08-01', '2026-09-01') #> '{top,discovery_source}')),
  3,
  'the discovery buckets, including "not stated", sum to the audience');

-- top.first_contact_origin had no assertion anywhere (whole-branch review,
-- Important B8) -- the sibling of discovery_source, written from the same
-- shape, and so the one most likely to be edited by someone who only ran the
-- discovery assertion. Nobody's first_contact_origin is filled in, so the
-- whole audience lands in the single "Not stated" bucket: the case that
-- proves the coalesce is doing its job rather than the column happening to be
-- populated.
select is(
  (public.get_audience_dashboard(array['00000000-0000-0000-0000-0000d8020001']::uuid[],
     'custom', '2026-08-01', '2026-09-01') #> '{top,first_contact_origin}'),
  '[{"id": "", "label": "Not stated", "count": 3}]'::jsonb,
  'first_contact_origin names the unfilled rather than dropping it');

-- Whole-branch review, Minor C1: these two grouped by the RAW column and
-- labelled by the trimmed one, so ' Instagram ' was a second bucket printed
-- with the same word as 'Instagram' -- on a chart whose axis is keyed on the
-- label. Bruno's source is padded here and must merge with Ana's, not sit
-- beside it. Fixture surgery as the migration role, restored straight after.
reset role;
update public.members set discovery_source = '  Instagram  '
 where id = '00000000-0000-0000-0000-0000d8030002';
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-0000d8050001", "role": "authenticated"}';
select is(
  (public.get_audience_dashboard(array['00000000-0000-0000-0000-0000d8020001']::uuid[],
     'custom', '2026-08-01', '2026-09-01') #> '{top,discovery_source}'),
  '[{"id": "Instagram", "label": "Instagram", "count": 2}, {"id": "", "label": "Not stated", "count": 1}]'::jsonb,
  'a padded discovery source is the same bucket as the unpadded one, not a second bar with the same name');
reset role;
update public.members set discovery_source = 'Instagram'
 where id = '00000000-0000-0000-0000-0000d8030002';
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-0000d8050001", "role": "authenticated"}';

-- two Stations at once needs reports.consolidated in both, and the
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

-- the withheld contract (D13). With participations.view the figure is a
-- card; without it, it is named in withheld and absent from cards -- never a
-- zero, which would read as "nobody took part".
select is(
  (public.get_audience_dashboard(array['00000000-0000-0000-0000-0000d8020001']::uuid[],
     'custom', '2026-08-01', '2026-09-01') #> '{withheld}'),
  '[]'::jsonb,
  'nothing is withheld from a caller holding participations.view');

-- took_part had no assertion that it ever counts anything -- only that it
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

-- D12b -- every figure on this panel counts the same population. Ana's
-- participation happened, but she has since been erased, and took_part must
-- not count her any more than listeners does -- the two cards must never
-- disagree about who counts. Bracketed as migration-role fixture surgery, the
-- same rule the anonymised-listener assertion above already follows.
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

-- Whole-branch review, Important B1: this expected value used to be the
-- single draw_ban bucket, because blocks_by_kind was a plain `group by kind`
-- and a kind nobody used simply vanished from the chart -- the exact failure
-- 0119's own header argues at length against, in the one breakdown of the
-- five that was not written to avoid it. Both keys are now always present;
-- `suspension` reports the 0 it is.
select is(
  (public.get_audience_dashboard(array['00000000-0000-0000-0000-0000d8020001']::uuid[],
     'custom', '2026-08-01', '2026-09-01') #> '{breakdowns,blocks_by_kind}'),
  '[{"key": "draw_ban", "label": "draw_ban", "count": 2}, {"key": "suspension", "label": "suspension", "count": 0}]'::jsonb,
  'blocks_by_kind carries every kind of block, including the one nobody used');

-- Whole-branch review, Minor C9: `barred` filtered lifted_at alone, so a
-- DATED block that ran out on its own still counted as in force -- and a
-- dated block is exactly the one that nobody ever lifts, because 0032 says it
-- ends because the date passed. is_member_blocked (0032/0036) has always
-- derived in force from lifted_at AND ends_at together; this figure now does
-- too. Diana's block is re-dated to a window that opened inside August and
-- closed before today, so nothing about WHERE it sits in the period changes --
-- only whether it is still in force.
reset role;
update public.member_blocks set starts_at = '2026-08-02 12:00:00+00', ends_at = '2026-08-03 12:00:00+00'
 where id = '00000000-0000-0000-0000-0000d8110001';
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-0000d8050001", "role": "authenticated"}';
select is(
  (public.get_audience_dashboard(array['00000000-0000-0000-0000-0000d8020001']::uuid[],
     'custom', '2026-08-01', '2026-09-01') #>> '{cards,barred,current}')::int,
  1,
  'a dated block that expired on its own is no longer in force, so it is not barred');
reset role;
update public.member_blocks set starts_at = '2026-08-10 12:00:00+00', ends_at = null
 where id = '00000000-0000-0000-0000-0000d8110001';
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-0000d8050001", "role": "authenticated"}';

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
--
-- created_at is a FIXED August literal on every one, not the column default
-- (whole-branch review, Important B8). cards.new_songs counts songs
-- catalogued INSIDE the window, so with `now()` as the creation instant the
-- figure would have been whatever the real wall clock made it -- 4 during
-- August 2026 and 0 in every month after, a fixture that passes by
-- coincidence and then starts failing on a date nobody chose. The same
-- reasoning the winners fixture below already states for its own created_at.
insert into public.songs (id, organization_id, company_id, title, artist_id, genre_id, nationality, vocal, created_at) values
  ('00000000-0000-0000-0000-0000d8080001', '00000000-0000-0000-0000-0000d8010001',
   '00000000-0000-0000-0000-0000d8020001', 'One',   '00000000-0000-0000-0000-0000d8060001',
   '00000000-0000-0000-0000-0000d8070001', 'DOMESTIC', 'MALE', '2026-08-05 12:00:00+00'),
  ('00000000-0000-0000-0000-0000d8080002', '00000000-0000-0000-0000-0000d8010001',
   '00000000-0000-0000-0000-0000d8020001', 'Two',   '00000000-0000-0000-0000-0000d8060001',
   '00000000-0000-0000-0000-0000d8070001', 'INTERNATIONAL', 'INSTRUMENTAL', '2026-08-05 12:00:00+00'),
  ('00000000-0000-0000-0000-0000d8080003', '00000000-0000-0000-0000-0000d8010001',
   '00000000-0000-0000-0000-0000d8020001', 'Three', '00000000-0000-0000-0000-0000d8060001',
   '00000000-0000-0000-0000-0000d8070001', null, null, '2026-08-05 12:00:00+00'),
  -- The one song catalogued BEFORE the window: it is in the catalogue total
  -- (a stock figure measured as of the window's end) and not in new_songs (a
  -- flow figure counted inside the window), which is the whole distinction
  -- 0119's header says §4.2 never made.
  ('00000000-0000-0000-0000-0000d8080004', '00000000-0000-0000-0000-0000d8010001',
   '00000000-0000-0000-0000-0000d8020001', 'Four',  '00000000-0000-0000-0000-0000d8060001',
   '00000000-0000-0000-0000-0000d8070001', 'DOMESTIC', 'DUO', '2026-07-05 12:00:00+00');

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

-- requests in the window.
select is(
  (public.get_music_dashboard(array['00000000-0000-0000-0000-0000d8020001']::uuid[],
     'custom', '2026-08-01', '2026-09-01') #>> '{cards,requests,current}')::int,
  5, 'the request count is the requests in the window');

-- the catalogue and the requests are separate numbers, because §4.2 does
-- not say which "total" it meant and the two answer different questions.
select is(
  (public.get_music_dashboard(array['00000000-0000-0000-0000-0000d8020001']::uuid[],
     'custom', '2026-08-01', '2026-09-01') #>> '{cards,catalogue,current}')::int,
  4, 'the catalogue total counts songs, not requests');

-- most requested.
select is(
  (public.get_music_dashboard(array['00000000-0000-0000-0000-0000d8020001']::uuid[],
     'custom', '2026-08-01', '2026-09-01') #>> '{top,songs,0,label}'),
  'One', 'the most requested song leads the list');

-- cards.new_songs, top.genres and monthly all had no assertion anywhere
-- (whole-branch review, Important B8) -- three of the eight payload keys the
-- coverage sweep found unproven, all on this panel.
--
-- new_songs is the flow half of the pair 0119's header exists to keep apart:
-- four songs in the catalogue as of the window's end, three of them
-- catalogued inside it. A figure that answered "the catalogue" here would
-- read 4 and look entirely reasonable.
select is(
  (public.get_music_dashboard(array['00000000-0000-0000-0000-0000d8020001']::uuid[],
     'custom', '2026-08-01', '2026-09-01') #>> '{cards,new_songs,current}')::int,
  3, 'new_songs counts what was catalogued in the window, not the whole catalogue');

-- top.genres joins through songs.genre_id, which top.songs never touches: all
-- five requests are for songs of the one genre, so a broken join shows an
-- empty list rather than a wrong number.
select is(
  (public.get_music_dashboard(array['00000000-0000-0000-0000-0000d8020001']::uuid[],
     'custom', '2026-08-01', '2026-09-01') #> '{top,genres}'),
  jsonb_build_array(jsonb_build_object(
    'id', '00000000-0000-0000-0000-0000d8070001', 'label', 'Samba', 'count', 5)),
  'the genre list reaches through songs.genre_id and counts every request behind it');

-- monthly on this panel, over the same requested_at rows: all five sit in
-- August at either clock, so what this pins is that the chart is populated at
-- all and buckets on the request instant rather than the song's.
select is(
  (select (elem ->> 'count')::int
     from jsonb_array_elements(
       public.get_music_dashboard(array['00000000-0000-0000-0000-0000d8020001']::uuid[],
         'custom', '2026-08-01', '2026-09-01') #> '{monthly}') elem
    where elem ->> 'month' = '2026-08'),
  5, 'the monthly request chart buckets on requested_at, and is not empty');

-- D5 as amended: this payload names each Station's own resolved dates too --
-- one shape across all three functions, one Zod schema (whole-branch review,
-- Important A1).
select is(
  (public.get_music_dashboard(array['00000000-0000-0000-0000-0000d8020001']::uuid[],
     'custom', '2026-08-01', '2026-09-01') #>> '{stations,0,to}'),
  '2026-09-01', 'the music payload names each station''s own resolved dates too');

-- THE BREAKDOWN THAT §4.2 WOULD HAVE GOT WRONG. Five requests: three
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

-- a soft-deleted request leaves every figure (0098's partial indexes and
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

-- nothing is ever withheld here -- every figure reads a table gated by
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

-- and the gate is still a gate -- the outsider built for the audience
-- refusals above, who is a signed-in user of no Station at all.
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-0000d8050003", "role": "authenticated"}';
select throws_ok(
  $$ select public.get_music_dashboard(array['00000000-0000-0000-0000-0000d8020001']::uuid[], 'custom', '2026-08-01', '2026-09-01') $$,
  '42501', null, 'a caller without music.view is refused');
reset role;

-- the consolidated path, closed here rather than left for review --
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

-- a consolidated payload names every Station it summed.
select is(
  jsonb_array_length(
    public.get_music_dashboard(
      array['00000000-0000-0000-0000-0000d8020001','00000000-0000-0000-0000-0000d8020002']::uuid[],
      'custom', '2026-08-01', '2026-09-01') #> '{stations}'),
  2,
  'a consolidated music payload names both stations it summed');

-- and a figure genuinely sums across them: SP has 4 (after the
-- soft-delete just above), UTC has 2, consolidated must show 6 -- not 4,
-- which is what a query that silently ignored the second Station would still
-- show.
select is(
  (public.get_music_dashboard(
      array['00000000-0000-0000-0000-0000d8020001','00000000-0000-0000-0000-0000d8020002']::uuid[],
      'custom', '2026-08-01', '2026-09-01') #>> '{cards,requests,current}')::int,
  6,
  'a consolidated requests figure sums both stations, not just one');

-- D3's refusal, exercised on THIS function specifically. d8050004
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

-- ---------------------------------------------------------------------------
-- get_promotions_dashboard (Task 5). The situation rule, at the three
-- instants that matter, needs no fixture at all: it reads no table. The
-- window is half-open, so a promotion is live AT its start and over AT its
-- end.
select is(public.promotion_is_live('2026-08-10 00:00:00+00'::timestamptz,
                                   '2026-08-20 00:00:00+00'::timestamptz,
                                   null,
                                   '2026-08-10 00:00:00+00'::timestamptz),
          true,  'a promotion is live at the instant it starts');
select is(public.promotion_is_live('2026-08-10 00:00:00+00'::timestamptz,
                                   '2026-08-20 00:00:00+00'::timestamptz,
                                   null,
                                   '2026-08-20 00:00:00+00'::timestamptz),
          false, 'a promotion is over at the instant it ends');
-- D11 names THREE instants -- the start, the end, and the instant AFTER --
-- and both copies tested only the first two (whole-branch review, Minor C5;
-- the pair to this one is in tests/unit/promotion-situation-boundary.test.ts).
-- The instant after is what distinguishes a half-open window from a rule that
-- merely happens to exclude its own endpoint: `p_at <= p_ends_at` would pass
-- the assertion above and fail this one.
select is(public.promotion_is_live('2026-08-10 00:00:00+00'::timestamptz,
                                   '2026-08-20 00:00:00+00'::timestamptz,
                                   null,
                                   '2026-08-20 00:00:00.000001+00'::timestamptz),
          false, 'and still over the instant after it ends');
select is(public.promotion_is_live('2026-08-10 00:00:00+00'::timestamptz,
                                   '2026-08-20 00:00:00+00'::timestamptz,
                                   '2026-08-15 00:00:00+00'::timestamptz,
                                   '2026-08-16 00:00:00+00'::timestamptz),
          false, 'a cancelled promotion is never live');

-- FIXTURES, adapted from supabase/tests/13_pickup_reads.test.sql:42-130's own
-- promotion / prize / promotion_prizes / participations / draws / winners
-- chain -- retagged to the d8 range, moved inside the test window (10-20
-- August 2026), with a participation per participation_status value and a
-- SECOND draw marked CANCELLED whose winner is left at AWAITING_PICKUP. All
-- fixture writes run as the migration role (RLS revokes them from
-- authenticated outright).
reset role;

insert into public.prizes (id, organization_id, company_id, name, allows_return_to_stock)
values
  ('00000000-0000-0000-0000-0000d80a0001', '00000000-0000-0000-0000-0000d8010001',
   '00000000-0000-0000-0000-0000d8020001', 'Dashboard prize', true);

insert into public.promotions (id, organization_id, company_id, name, starts_at, ends_at) values
  ('00000000-0000-0000-0000-0000d8090002', '00000000-0000-0000-0000-0000d8010001',
   '00000000-0000-0000-0000-0000d8020001', 'August Draw',
   '2026-08-10 00:00:00+00', '2026-08-20 00:00:00+00');

insert into public.promotion_prizes (id, promotion_id, prize_id, organization_id, company_id) values
  ('00000000-0000-0000-0000-0000d80a0002', '00000000-0000-0000-0000-0000d8090002',
   '00000000-0000-0000-0000-0000d80a0001', '00000000-0000-0000-0000-0000d8010001',
   '00000000-0000-0000-0000-0000d8020001');

-- Four listeners, one per participation_status value below (VALID reuses Ana,
-- 030001, already linked at this Station from Task 3 -- this fixture adds no
-- member solely to hold a VALID row), plus a fifth for the cancelled draw's
-- own winner.
insert into public.members (id, organization_id, full_name) values
  ('00000000-0000-0000-0000-0000d8030006', '00000000-0000-0000-0000-0000d8010001', 'Fabio'),
  ('00000000-0000-0000-0000-0000d8030007', '00000000-0000-0000-0000-0000d8010001', 'Gustavo'),
  ('00000000-0000-0000-0000-0000d8030008', '00000000-0000-0000-0000-0000d8010001', 'Helena'),
  ('00000000-0000-0000-0000-0000d8030009', '00000000-0000-0000-0000-0000d8010001', 'Ivo');
insert into public.member_company_links (member_id, company_id, organization_id) values
  ('00000000-0000-0000-0000-0000d8030006', '00000000-0000-0000-0000-0000d8020001',
   '00000000-0000-0000-0000-0000d8010001'),
  ('00000000-0000-0000-0000-0000d8030007', '00000000-0000-0000-0000-0000d8020001',
   '00000000-0000-0000-0000-0000d8010001'),
  ('00000000-0000-0000-0000-0000d8030008', '00000000-0000-0000-0000-0000d8020001',
   '00000000-0000-0000-0000-0000d8010001'),
  ('00000000-0000-0000-0000-0000d8030009', '00000000-0000-0000-0000-0000d8020001',
   '00000000-0000-0000-0000-0000d8010001');

insert into public.participations
  (id, promotion_id, member_id, organization_id, company_id, allows_multiple, status, source, participated_at)
values
  ('00000000-0000-0000-0000-0000d80d0002', '00000000-0000-0000-0000-0000d8090002',
   '00000000-0000-0000-0000-0000d8030001', '00000000-0000-0000-0000-0000d8010001',
   '00000000-0000-0000-0000-0000d8020001', false, 'VALID', 'MANUAL', '2026-08-12 12:00:00+00'),
  ('00000000-0000-0000-0000-0000d80d0003', '00000000-0000-0000-0000-0000d8090002',
   '00000000-0000-0000-0000-0000d8030006', '00000000-0000-0000-0000-0000d8010001',
   '00000000-0000-0000-0000-0000d8020001', false, 'DUPLICATE', 'MANUAL', '2026-08-12 13:00:00+00'),
  ('00000000-0000-0000-0000-0000d80d0004', '00000000-0000-0000-0000-0000d8090002',
   '00000000-0000-0000-0000-0000d8030007', '00000000-0000-0000-0000-0000d8010001',
   '00000000-0000-0000-0000-0000d8020001', false, 'TOO_SOON', 'MANUAL', '2026-08-12 14:00:00+00'),
  ('00000000-0000-0000-0000-0000d80d0005', '00000000-0000-0000-0000-0000d8090002',
   '00000000-0000-0000-0000-0000d8030008', '00000000-0000-0000-0000-0000d8010001',
   '00000000-0000-0000-0000-0000d8020001', false, 'OVER_LIMIT', 'MANUAL', '2026-08-12 15:00:00+00'),
  -- The cancelled draw's own winner needs its own participation.
  ('00000000-0000-0000-0000-0000d80d0006', '00000000-0000-0000-0000-0000d8090002',
   '00000000-0000-0000-0000-0000d8030009', '00000000-0000-0000-0000-0000d8010001',
   '00000000-0000-0000-0000-0000d8020001', false, 'VALID', 'MANUAL', '2026-08-13 12:00:00+00');

-- Two draws: one COMPLETED, whose winner counts as awarded, and one
-- CANCELLED, built by hand into the shape cancel_draw (0079) actually leaves
-- (draws_cancellation_shape's three facts, winners.status left untouched at
-- AWAITING_PICKUP) -- the same reasoning 13_pickup_reads.test.sql gives for
-- not driving cancel_draw itself: what is under test is the READ.
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000d8050005', 'dashboards-canceller@example.test');

insert into public.draws
  (id, promotion_id, organization_id, company_id, seed, algorithm_version, entry_count, offered_count)
values
  ('00000000-0000-0000-0000-0000d80b0001', '00000000-0000-0000-0000-0000d8090002',
   '00000000-0000-0000-0000-0000d8010001', '00000000-0000-0000-0000-0000d8020001',
   repeat('4', 64), 1, 1, 1);

insert into public.draws
  (id, promotion_id, organization_id, company_id, seed, algorithm_version, entry_count,
   offered_count, status, cancelled_at, cancelled_by, cancellation_reason)
values
  ('00000000-0000-0000-0000-0000d80b0002', '00000000-0000-0000-0000-0000d8090002',
   '00000000-0000-0000-0000-0000d8010001', '00000000-0000-0000-0000-0000d8020001',
   repeat('5', 64), 1, 1, 1, 'CANCELLED', '2026-08-14 00:00:00+00',
   '00000000-0000-0000-0000-0000d8050005',
   'fixture: proves a cancelled draw''s winner is not counted as awarded');

-- Both winners' created_at is set explicitly rather than left to default now()
-- (0075): the awarded/overdue cards filter on a FIXED August-2026 window, and
-- a fixture that floated on the real wall clock would only pass by
-- coincidence.
--
-- deadline_at is deliberately a PAST literal on BOTH rows, not the earlier
-- draft's future '2026-08-25' (fix round 1, Finding 1): overdue reads
-- deadline_at < now(), one of the few figures in this block that compares
-- against the real clock rather than the chosen window, so a future literal
-- made the cancelled-draw exclusion untestable on this figure -- overdue_current
-- was 0 whether or not the exclusion applied, and the assertion would have
-- passed vacuously either way. '2026-08-01' is a FIXED literal, not now() minus
-- an interval: once a date is in the past it stays in the past as the real
-- clock only moves forward, so this does not drift the way anchoring to now()
-- would.
insert into public.winners
  (id, draw_id, company_id, promotion_prize_id, member_id, participation_id,
   awarded_rank, status, deadline_at, created_at)
values
  ('00000000-0000-0000-0000-0000d80c0001', '00000000-0000-0000-0000-0000d80b0001',
   '00000000-0000-0000-0000-0000d8020001', '00000000-0000-0000-0000-0000d80a0002',
   '00000000-0000-0000-0000-0000d8030001', '00000000-0000-0000-0000-0000d80d0002',
   1, 'AWAITING_PICKUP', '2026-08-01 00:00:00+00', '2026-08-14 00:00:00+00'),
  -- The cancelled draw's winner: left at AWAITING_PICKUP by cancel_draw's own
  -- design (6a has no vocabulary for "un-awarded") -- what the awarded
  -- assertion below proves is counted nowhere in `awarded`, and what the overdue/prize_cycle
  -- assertions below prove is counted nowhere there either. Its deadline is
  -- ALSO past, on purpose: without a second overdue candidate, dropping the
  -- cancelled-draw exclusion would still show overdue_current = 1 by luck
  -- rather than by having nothing left to exclude.
  ('00000000-0000-0000-0000-0000d80c0002', '00000000-0000-0000-0000-0000d80b0002',
   '00000000-0000-0000-0000-0000d8020001', '00000000-0000-0000-0000-0000d80a0002',
   '00000000-0000-0000-0000-0000d8030009', '00000000-0000-0000-0000-0000d80d0006',
   1, 'AWAITING_PICKUP', '2026-08-01 00:00:00+00', '2026-08-14 00:00:00+00');

-- cards.live_now had no assertion anywhere (whole-branch review, Important
-- B8), which mattered more than the other seven gaps: live_now is the
-- aggregate's ONLY consumer of promotion_is_live, so nothing proved the
-- aggregate calls it at all -- the three assertions above test the helper in
-- isolation, and a `count(*)` that had quietly stopped applying it would have
-- passed every one of them.
--
-- It cannot be pinned on Station SP: live_now reads now(), and both
-- promotions there sit on fixed August-2026 literals, so the answer would be
-- 2, 1 or 0 depending on the day the suite runs. Station UTC has no promotion
-- of its own, so three are built here RELATIVE TO now() -- one genuinely on
-- air, one cancelled over the identical window, one that has already closed.
-- Exactly one is live, on any day, forever: a count that dropped the window
-- test reads 3, one that dropped the cancellation test reads 2. (0040's only
-- exclusion constraint is on hashtag overlap, and none of these carries a
-- hashtag, so two promotions may share a window here.)
reset role;
insert into public.promotions (id, organization_id, company_id, name, starts_at, ends_at,
                               cancelled_at, cancelled_by, cancellation_reason) values
  ('00000000-0000-0000-0000-0000d8090003', '00000000-0000-0000-0000-0000d8010001',
   '00000000-0000-0000-0000-0000d8020002', 'On air now',
   now() - interval '1 day', now() + interval '1 day', null, null, null),
  -- promotions_cancellation_shape (0040) makes cancelled_at, cancelled_by and
  -- cancellation_reason an all-or-nothing trio; d8050005 is the canceller this
  -- file already created for the cancelled DRAW above.
  ('00000000-0000-0000-0000-0000d8090004', '00000000-0000-0000-0000-0000d8010001',
   '00000000-0000-0000-0000-0000d8020002', 'On air but cancelled',
   now() - interval '1 day', now() + interval '1 day', now() - interval '2 hours',
   '00000000-0000-0000-0000-0000d8050005',
   'fixture: proves live_now honours cancellation, not merely the window'),
  ('00000000-0000-0000-0000-0000d8090005', '00000000-0000-0000-0000-0000d8010001',
   '00000000-0000-0000-0000-0000d8020002', 'Already closed',
   now() - interval '10 days', now() - interval '5 days', null, null, null);

-- One more at Station SP, sitting exactly ON the window's exclusive end, so
-- the `ended` assertion below counts something rather than merely reporting
-- how many promotions exist. The window asked for is 2026-08-01..2026-09-01
-- and Sao Paulo is UTC-3, so its exclusive end is the INSTANT
-- 2026-09-01 03:00:00+00 -- which is also why 'August Quiz', ending at
-- 2026-09-01 00:00:00+00, is genuinely inside the window and counted: the
-- bound is the Station's instant, never the bare date. This one ends at the
-- edge instant itself and must not count; a closed `<=` bound would read 3.
insert into public.promotions (id, organization_id, company_id, name, starts_at, ends_at) values
  ('00000000-0000-0000-0000-0000d8090006', '00000000-0000-0000-0000-0000d8010001',
   '00000000-0000-0000-0000-0000d8020001', 'Ends exactly at the window edge',
   '2026-08-25 00:00:00+00', '2026-09-01 03:00:00+00');
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-0000d8050001", "role": "authenticated"}';
select is(
  (public.get_promotions_dashboard(array['00000000-0000-0000-0000-0000d8020002']::uuid[],
     'custom', '2026-08-01', '2026-09-01') #>> '{cards,live_now,current}')::int,
  1, 'live_now counts the one promotion actually on air, not the three that exist');
select is(
  (public.get_promotions_dashboard(array['00000000-0000-0000-0000-0000d8020002']::uuid[],
     'custom', '2026-08-01', '2026-09-01') #> '{cards,live_now,previous}'),
  null, 'and live_now carries no previous key at all -- a fact about this instant has no "before"');

set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-0000d8050001", "role": "authenticated"}';

-- cards.ended, cards.distinct_participants, top.promotions and monthly were
-- the remaining four unproven payload keys (whole-branch review, Important
-- B8). All four are asserted at Station SP, whose window is a fixed literal
-- pair, so none of them depends on the day the suite runs.
--
-- `ended` is also where the half-open window shows. Three promotions at this
-- Station finish in or around August: 'August Draw' (2026-08-20) and 'August
-- Quiz' (2026-09-01 00:00Z, which is 21:00 on 31 August in Sao Paulo and so
-- genuinely INSIDE a window whose exclusive end is 2026-09-01 03:00Z) both
-- count; 'Ends exactly at the window edge' finishes at that 03:00Z instant
-- itself and must not. A closed `<=` bound reads 3.
select is(
  (public.get_promotions_dashboard(array['00000000-0000-0000-0000-0000d8020001']::uuid[],
     'custom', '2026-08-01', '2026-09-01') #>> '{cards,ended,current}')::int,
  2, 'ended counts what finished inside the window, and not what ends AT its exclusive edge');

-- Six participations by five distinct listeners (Ana entered both
-- promotions). The two cards must not agree: a distinct_participants written
-- as a plain count(*) reads 6 and is indistinguishable from the card beside
-- it.
select is(
  (public.get_promotions_dashboard(array['00000000-0000-0000-0000-0000d8020001']::uuid[],
     'custom', '2026-08-01', '2026-09-01') #>> '{cards,participations,current}')::int,
  6, 'participations counts entries');
select is(
  (public.get_promotions_dashboard(array['00000000-0000-0000-0000-0000d8020001']::uuid[],
     'custom', '2026-08-01', '2026-09-01') #>> '{cards,distinct_participants,current}')::int,
  5, 'distinct_participants counts people, and the repeat entrant proves the two differ');

select is(
  (public.get_promotions_dashboard(array['00000000-0000-0000-0000-0000d8020001']::uuid[],
     'custom', '2026-08-01', '2026-09-01') #> '{top,promotions,0}') - 'id',
  '{"label": "August Draw", "count": 5}'::jsonb,
  'the busiest promotion leads the list, counted by its own entries');

select is(
  (select (elem ->> 'count')::int
     from jsonb_array_elements(
       public.get_promotions_dashboard(array['00000000-0000-0000-0000-0000d8020001']::uuid[],
         'custom', '2026-08-01', '2026-09-01') #> '{monthly}') elem
    where elem ->> 'month' = '2026-08'),
  6, 'the monthly participation chart buckets every entry into the Station''s own August');

select is(
  (public.get_promotions_dashboard(array['00000000-0000-0000-0000-0000d8020001']::uuid[],
     'custom', '2026-08-01', '2026-09-01') #>> '{stations,0,from}'),
  '2026-08-01', 'the promotions payload names each station''s own resolved dates too');

-- A cancelled draw awards nothing (D12), the same exclusion 0094 and 0095
-- both carry and for the same reason: cancel_draw reverses the unit but leaves
-- winners.status at AWAITING_PICKUP, so this -- the third reader to treat that
-- status as live -- must say so itself. Two winners exist in the window; only
-- the completed draw's counts.
select is(
  (public.get_promotions_dashboard(array['00000000-0000-0000-0000-0000d8020001']::uuid[],
     'custom', '2026-08-01', '2026-09-01') #>> '{cards,awarded,current}')::int,
  1, 'a winner of a cancelled draw is not counted as awarded');

-- Fix round 1, Finding 1: D12 is proven for `awarded` above but `overdue` and
-- `prize_cycle` share the same exclusion and had nothing pinning it -- both
-- winners are AWAITING_PICKUP with a deadline now in the past, one on the
-- live draw and one on the cancelled one, so a dropped exclusion would show 2
-- here, not 1.
select is(
  (public.get_promotions_dashboard(array['00000000-0000-0000-0000-0000d8020001']::uuid[],
     'custom', '2026-08-01', '2026-09-01') #>> '{cards,overdue,current}')::int,
  1, 'overdue counts only the live draw''s winner, not the cancelled draw''s');
select is(
  (select (elem ->> 'count')::int
     from jsonb_array_elements(
       public.get_promotions_dashboard(array['00000000-0000-0000-0000-0000d8020001']::uuid[],
         'custom', '2026-08-01', '2026-09-01') #> '{breakdowns,prize_cycle}') elem
    where elem ->> 'key' = 'AWAITING_PICKUP'),
  1, 'the prize_cycle AWAITING_PICKUP bucket excludes the cancelled draw''s winner too');

-- The refusal breakdown, which is why this panel covers the entry side at
-- all: it is the number that shows a per-person rule turning real people away.
select is(
  (select sum((value ->> 'count')::int)::int
     from jsonb_array_elements(
       public.get_promotions_dashboard(array['00000000-0000-0000-0000-0000d8020001']::uuid[],
         'custom', '2026-08-01', '2026-09-01') #> '{breakdowns,participation_status}')),
  (public.get_promotions_dashboard(array['00000000-0000-0000-0000-0000d8020001']::uuid[],
     'custom', '2026-08-01', '2026-09-01') #>> '{cards,participations,current}')::int,
  'the four refusal buckets sum to the participation total');

-- D13 again, on the panel where it bites hardest: no participations.view
-- means the entry side is withheld and the PRIZE CYCLE SURVIVES, because
-- winners is gated by promotions.view -- this panel's own gate. d8u02 is
-- exactly that caller, and this pair of assertions is the whole reason the
-- distinction exists: one number goes away, the other must not.
reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-0000d8050002", "role": "authenticated"}';
select is(
  (public.get_promotions_dashboard(array['00000000-0000-0000-0000-0000d8020001']::uuid[],
     'custom', '2026-08-01', '2026-09-01') #> '{cards,participations}'),
  null, 'the entry figures are withheld without participations.view');
select isnt(
  (public.get_promotions_dashboard(array['00000000-0000-0000-0000-0000d8020001']::uuid[],
     'custom', '2026-08-01', '2026-09-01') #> '{cards,awarded}'),
  null, 'the prize cycle survives, because winners is gated by promotions.view');

-- monthly is entry-side too (D13) -- an empty chart reads as "nobody
-- took part in twelve months", the same false claim a zero card would make,
-- only in a different shape. Both halves are asserted, exactly as the brief's
-- own reasoning demands for the daggered cards: an empty array would satisfy
-- neither "absent" nor "named", and that is the whole point.
select is(
  (public.get_promotions_dashboard(array['00000000-0000-0000-0000-0000d8020001']::uuid[],
     'custom', '2026-08-01', '2026-09-01') #> '{monthly}'),
  null, 'monthly is withheld, not an empty chart, without participations.view');
select ok(
  exists (
    select 1
      from jsonb_array_elements(
        public.get_promotions_dashboard(array['00000000-0000-0000-0000-0000d8020001']::uuid[],
          'custom', '2026-08-01', '2026-09-01') #> '{withheld}') w
     where w ->> 'figure' = 'monthly' and w ->> 'needs' = 'participations.view'),
  'and withheld names monthly, needing participations.view, alongside the others');
reset role;

-- Fix round 1, Finding 2: every assertion above calls get_promotions_dashboard
-- with a single Station and a caller who already holds promotions.view --
-- Task 4 added exactly this pair (the plain refusal and D3's) for the music panel,
-- and Task 5 had no analogue. The outsider above (no membership in
-- this Organization at all) proves the plain refusal; d8050004 (built in
-- Task 3, reaching both Stations, deliberately never granted
-- reports.consolidated) proves D3.
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-0000d8050003", "role": "authenticated"}';
select throws_ok(
  $$ select public.get_promotions_dashboard(array['00000000-0000-0000-0000-0000d8020001']::uuid[], 'custom', '2026-08-01', '2026-09-01') $$,
  '42501', null, 'a caller without promotions.view is refused, not given zeros');
reset role;

-- d8050004 was granted members.view (Task 3) and music.view (Task 4's own
-- review round) but never promotions.view -- checked, not assumed, by
-- grep before writing this. Without it, a two-Station call would refuse on
-- the wrong branch (promotions.view missing) rather than the one under test
-- here (reports.consolidated missing), the exact trap Task 4's own header
-- names for this same caller. Granted here as fixture surgery, migration role.
insert into public.role_permissions (role_id, permission_code) values
  ('00000000-0000-0000-0000-0000d8040003', 'promotions.view');
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-0000d8050004", "role": "authenticated"}';
select throws_ok($$
  select public.get_promotions_dashboard(
    array['00000000-0000-0000-0000-0000d8020001','00000000-0000-0000-0000-0000d8020002']::uuid[],
    'custom', '2026-08-01', '2026-09-01')
$$, '42501', null, 'a two-Station call is refused without reports.consolidated in both, for promotions too (D3)');
reset role;

select * from finish();
rollback;
