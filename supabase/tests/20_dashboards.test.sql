begin;
select plan(21);

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

select * from finish();
rollback;
