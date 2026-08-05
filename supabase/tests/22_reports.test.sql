begin;
select plan(18);

-- Block 8b. The report engine, from the table outward. Tasks 4-9 append to this
-- file and raise the plan count as they go.

select has_type('public', 'report_type',   'report_type exists');
select has_type('public', 'report_format', 'report_format exists');
select has_type('public', 'report_status', 'report_status exists');

select is(
  (select count(*)::int from pg_enum e
     join pg_type t on t.oid = e.enumtypid
    where t.typname = 'report_type'),
  8,
  'report_type has the five listings and the three panels');

select has_table('public', 'report_runs', 'report_runs exists');

-- RLS on, and no policy that lets a client write anything. The engine's whole
-- integrity rests on only service_role moving a run through its lifecycle: a
-- client that could set status = READY could point storage_path at another
-- Station's object, which the bucket policy would then sign.
select ok(
  (select relrowsecurity from pg_class where oid = 'public.report_runs'::regclass),
  'report_runs has RLS enabled');

select ok(
  not exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'report_runs'
       and cmd in ('UPDATE', 'DELETE', 'INSERT')),
  'no write policy exists at all');

select ok(
  not has_table_privilege('authenticated', 'public.report_runs', 'INSERT'),
  'authenticated may not insert a run directly');
select ok(
  not has_table_privilege('authenticated', 'public.report_runs', 'UPDATE'),
  'authenticated may not update a run');
select ok(
  has_table_privilege('authenticated', 'public.report_runs', 'SELECT'),
  'authenticated may read runs, subject to RLS');

select has_index('public', 'report_runs', 'report_runs_claimable_idx',
  'the claim path is indexed');
select has_index('public', 'report_runs', 'report_runs_requester_idx',
  'the /reports screen is indexed');

-- ---------------------------------------------------------------------------
-- Fixtures for the constraint assertions. The 8c tag, so nothing here collides
-- with 21_permission_for's 8b rows if both files are ever loaded together.
-- ---------------------------------------------------------------------------

insert into public.organizations (id, name) values
  ('00000000-0000-0000-0000-00008c010001', 'Org reports');
insert into public.companies (id, organization_id, name, timezone) values
  ('00000000-0000-0000-0000-00008c020001', '00000000-0000-0000-0000-00008c010001',
   'Reports Station', 'America/Sao_Paulo');
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-00008c050001', '8c-requester@example.test');

-- A panel run with no payload is refused at the insert. The worker cannot
-- recompute it -- the aggregates are granted to authenticated only -- so a
-- payload-less panel would fail ten seconds later with a message about
-- rendering, which is not what went wrong.
select throws_ok(
  $$insert into public.report_runs
      (organization_id, company_ids, requested_by, report_type, format, filters)
    values ('00000000-0000-0000-0000-00008c010001',
            array['00000000-0000-0000-0000-00008c020001']::uuid[],
            '00000000-0000-0000-0000-00008c050001',
            'AUDIENCE_PANEL', 'PDF', '{}'::jsonb)$$,
  '23514',
  null,
  'a panel run without a payload is refused');

-- And the mirror: a listing run must NOT carry one. The equality in the CHECK
-- is deliberate -- a payload on a listing would be a captured answer nobody
-- reads, which is worse than an absent one because it looks authoritative.
select throws_ok(
  $$insert into public.report_runs
      (organization_id, company_ids, requested_by, report_type, format, filters, payload)
    values ('00000000-0000-0000-0000-00008c010001',
            array['00000000-0000-0000-0000-00008c020001']::uuid[],
            '00000000-0000-0000-0000-00008c050001',
            'LISTENERS', 'CSV', '{}'::jsonb, '{"cards":{}}'::jsonb)$$,
  '23514',
  null,
  'a listing run carrying a payload is refused');

-- ---------------------------------------------------------------------------
-- The bucket (0123).
-- ---------------------------------------------------------------------------

select is(
  (select count(*)::int from storage.buckets where id = 'reports'),
  1,
  'the reports bucket exists');

select ok(
  not (select public from storage.buckets where id = 'reports'),
  'the reports bucket is private');

select ok(
  exists (select 1 from pg_policies
           where schemaname = 'storage' and tablename = 'objects'
             and policyname = 'reports_read_own_run'),
  'the read policy exists');

-- No write policy naming this bucket. Only the worker writes here, through
-- service_role: a client that could upload into it could place a file at a path
-- a signed URL would later be minted for.
select ok(
  not exists (
    select 1 from pg_policies
     where schemaname = 'storage' and tablename = 'objects'
       and cmd in ('INSERT', 'UPDATE', 'DELETE')
       and coalesce(qual, '') || coalesce(with_check, '') like '%''reports''%'),
  'nothing may write into the reports bucket through RLS');

select * from finish();
rollback;
