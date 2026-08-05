begin;
select plan(5);

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

select * from finish();
rollback;
