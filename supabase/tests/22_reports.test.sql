begin;
select plan(39);

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

-- ---------------------------------------------------------------------------
-- The page functions (0124). Two callers, deliberately different:
--
--   8c050002  everything the two reports need, including members.view.
--   8c050003  participations.view and promotions.view, and NOT members.view --
--             the withheld case, which is the one the design spends the most
--             words on and the one a rewrite loses first.
-- ---------------------------------------------------------------------------

insert into public.roles (id, organization_id, name) values
  ('00000000-0000-0000-0000-00008c040001', '00000000-0000-0000-0000-00008c010001', 'All'),
  ('00000000-0000-0000-0000-00008c040002', '00000000-0000-0000-0000-00008c010001', 'No names');
insert into public.role_permissions (role_id, permission_code) values
  ('00000000-0000-0000-0000-00008c040001', 'members.view'),
  ('00000000-0000-0000-0000-00008c040001', 'participations.view'),
  ('00000000-0000-0000-0000-00008c040001', 'promotions.view'),
  ('00000000-0000-0000-0000-00008c040002', 'participations.view'),
  ('00000000-0000-0000-0000-00008c040002', 'promotions.view');
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-00008c050002', '8c-all@example.test'),
  ('00000000-0000-0000-0000-00008c050003', '8c-no-names@example.test');
insert into public.company_memberships (user_id, company_id, organization_id, role_id) values
  ('00000000-0000-0000-0000-00008c050002', '00000000-0000-0000-0000-00008c020001',
   '00000000-0000-0000-0000-00008c010001', '00000000-0000-0000-0000-00008c040001'),
  ('00000000-0000-0000-0000-00008c050003', '00000000-0000-0000-0000-00008c020001',
   '00000000-0000-0000-0000-00008c010001', '00000000-0000-0000-0000-00008c040002');

insert into public.members (id, organization_id, full_name, phone, cpf_last_digits) values
  ('00000000-0000-0000-0000-00008c030001', '00000000-0000-0000-0000-00008c010001',
   'Ana', '+5511900000001', '123'),
  ('00000000-0000-0000-0000-00008c030002', '00000000-0000-0000-0000-00008c010001',
   'Bruno', '+5511900000002', '456');
insert into public.member_company_links (member_id, company_id, organization_id, linked_at) values
  ('00000000-0000-0000-0000-00008c030001', '00000000-0000-0000-0000-00008c020001',
   '00000000-0000-0000-0000-00008c010001', '2026-08-01 12:00:00+00'),
  ('00000000-0000-0000-0000-00008c030002', '00000000-0000-0000-0000-00008c020001',
   '00000000-0000-0000-0000-00008c010001', '2026-08-02 12:00:00+00');

insert into public.promotions
  (id, organization_id, company_id, name, starts_at, ends_at) values
  ('00000000-0000-0000-0000-00008c060001', '00000000-0000-0000-0000-00008c010001',
   '00000000-0000-0000-0000-00008c020001', 'Anniversary',
   '2026-08-01 00:00:00+00', '2026-08-31 00:00:00+00');
insert into public.participations
  (id, promotion_id, member_id, organization_id, company_id,
   allows_multiple, status, source, participated_at) values
  ('00000000-0000-0000-0000-00008c070001', '00000000-0000-0000-0000-00008c060001',
   '00000000-0000-0000-0000-00008c030001', '00000000-0000-0000-0000-00008c010001',
   '00000000-0000-0000-0000-00008c020001', false, 'VALID', 'MANUAL',
   '2026-08-10 12:00:00+00'),
  ('00000000-0000-0000-0000-00008c070002', '00000000-0000-0000-0000-00008c060001',
   '00000000-0000-0000-0000-00008c030002', '00000000-0000-0000-0000-00008c010001',
   '00000000-0000-0000-0000-00008c020001', false, 'VALID', 'MANUAL',
   '2026-08-11 12:00:00+00');

select has_function('public', 'report_page_listeners',
  array['uuid', 'uuid[]', 'jsonb', 'timestamptz', 'uuid', 'integer'],
  'report_page_listeners exists');
select has_function('public', 'report_page_participations',
  array['uuid', 'uuid[]', 'jsonb', 'timestamptz', 'uuid', 'integer'],
  'report_page_participations exists');

-- A null identity is an error, never an unrestricted query. This is the
-- worker's own failure mode: a run row whose requested_by did not load must
-- produce an error, never a file containing everything.
select throws_ok(
  $$select * from public.report_page_listeners(
      null, array['00000000-0000-0000-0000-00008c020001']::uuid[],
      '{}'::jsonb, null, null, 10)$$,
  '42501', null, 'listeners refuses a null identity');
select throws_ok(
  $$select * from public.report_page_participations(
      null, array['00000000-0000-0000-0000-00008c020001']::uuid[],
      '{}'::jsonb, null, null, 10)$$,
  '42501', null, 'participations refuses a null identity');

select throws_ok(
  $$select * from public.report_page_listeners(
      '00000000-0000-0000-0000-00008c050002', array[]::uuid[],
      '{}'::jsonb, null, null, 10)$$,
  '22023', null, 'an empty Station list is refused');

-- total_count comes from the same CTE as the rows, so a page and its count
-- cannot narrow differently (0090's rule, and the reason the row ceiling has no
-- second implementation).
select is(
  (select distinct p.total_count from public.report_page_listeners(
     '00000000-0000-0000-0000-00008c050002',
     array['00000000-0000-0000-0000-00008c020001']::uuid[],
     '{}'::jsonb, null, null, 1000) p),
  2::bigint,
  'total_count counts the rows the page draws from');

select is(
  (select distinct p.withheld from public.report_page_listeners(
     '00000000-0000-0000-0000-00008c050002',
     array['00000000-0000-0000-0000-00008c020001']::uuid[],
     '{}'::jsonb, null, null, 10) p),
  '{}'::text[],
  'the listeners export withholds nothing from an entitled caller');

-- No full CPF anywhere, ever. 0031 does not store one.
select ok(
  not exists (
    select 1 from public.report_page_listeners(
      '00000000-0000-0000-0000-00008c050002',
      array['00000000-0000-0000-0000-00008c020001']::uuid[],
      '{}'::jsonb, null, null, 100) p
    where p.row_data ? 'cpf' or p.row_data ? 'cpf_hash'),
  'no listeners row carries a full CPF or its hash');

-- The keyset walks strictly backwards in (sort_at, sort_id) and never repeats a
-- row. A cursor comparing the columns separately instead of as a tuple strands
-- rows silently -- the pages still load and the total still looks right.
select is(
  (select p2.sort_id from public.report_page_listeners(
     '00000000-0000-0000-0000-00008c050002',
     array['00000000-0000-0000-0000-00008c020001']::uuid[],
     '{}'::jsonb,
     (select p1.sort_at from public.report_page_listeners(
        '00000000-0000-0000-0000-00008c050002',
        array['00000000-0000-0000-0000-00008c020001']::uuid[],
        '{}'::jsonb, null, null, 1) p1),
     (select p1.sort_id from public.report_page_listeners(
        '00000000-0000-0000-0000-00008c050002',
        array['00000000-0000-0000-0000-00008c020001']::uuid[],
        '{}'::jsonb, null, null, 1) p1),
     1) p2),
  '00000000-0000-0000-0000-00008c030001'::uuid,
  'the second page resumes after the first and does not repeat it');

-- THE WITHHELD CASE. A caller with participations.view and promotions.view but
-- not members.view gets every row, no identity keys AT ALL, and the withheld
-- array naming the three. Absent -- not null, not empty string.
select is(
  (select distinct p.withheld from public.report_page_participations(
     '00000000-0000-0000-0000-00008c050003',
     array['00000000-0000-0000-0000-00008c020001']::uuid[],
     '{}'::jsonb, null, null, 10) p),
  array['name', 'phone', 'cpf_last_digits'],
  'the identity columns are named as withheld');

select ok(
  not exists (
    select 1 from public.report_page_participations(
      '00000000-0000-0000-0000-00008c050003',
      array['00000000-0000-0000-0000-00008c020001']::uuid[],
      '{}'::jsonb, null, null, 10) p
    where p.row_data ? 'name' or p.row_data ? 'phone' or p.row_data ? 'cpf_last_digits'),
  'a withheld column is absent from the row, not blank');

-- And the caller who DOES hold members.view gets them, so the assertion above
-- is proving absence rather than a key that never existed.
select ok(
  (select bool_and(p.row_data ? 'name') from public.report_page_participations(
     '00000000-0000-0000-0000-00008c050002',
     array['00000000-0000-0000-0000-00008c020001']::uuid[],
     '{}'::jsonb, null, null, 10) p),
  'an entitled caller gets the identity columns');

-- ---------------------------------------------------------------------------
-- The remaining three page functions (0125) and the dispatcher (0126).
-- ---------------------------------------------------------------------------

select has_function('public', 'report_page_winners',
  array['uuid', 'uuid[]', 'jsonb', 'timestamptz', 'uuid', 'integer'],
  'report_page_winners exists');
select has_function('public', 'report_page_music_requests',
  array['uuid', 'uuid[]', 'jsonb', 'timestamptz', 'uuid', 'integer'],
  'report_page_music_requests exists');
select has_function('public', 'report_page_movements',
  array['uuid', 'uuid[]', 'jsonb', 'timestamptz', 'uuid', 'integer'],
  'report_page_movements exists');

select throws_ok(
  $$select * from public.report_page_winners(
      null, array['00000000-0000-0000-0000-00008c020001']::uuid[],
      '{}'::jsonb, null, null, 10)$$,
  '42501', null, 'winners refuses a null identity');

-- 8c050003 holds participations.view and promotions.view but NOT music.view or
-- inventory.view: the two reports it cannot reach must refuse it outright
-- rather than hand back an empty page. An empty export and a refused one look
-- identical in a file and must not look identical here.
select throws_ok(
  $$select * from public.report_page_music_requests(
      '00000000-0000-0000-0000-00008c050003',
      array['00000000-0000-0000-0000-00008c020001']::uuid[],
      '{}'::jsonb, null, null, 10)$$,
  '42501', null, 'music requests refuses a caller without music.view');
select throws_ok(
  $$select * from public.report_page_movements(
      '00000000-0000-0000-0000-00008c050003',
      array['00000000-0000-0000-0000-00008c020001']::uuid[],
      '{}'::jsonb, null, null, 10)$$,
  '42501', null, 'movements refuses a caller without inventory.view');

select has_function('public', 'report_page',
  array['uuid', 'report_type', 'uuid[]', 'jsonb', 'timestamptz', 'uuid', 'integer'],
  'the dispatcher exists');

-- A panel type has no page function. Asking for one is a programming error,
-- because a panel's numbers are captured at request time and never re-queried.
select throws_ok(
  $$select * from public.report_page(
      '00000000-0000-0000-0000-00008c050002',
      'AUDIENCE_PANEL'::public.report_type,
      array['00000000-0000-0000-0000-00008c020001']::uuid[],
      '{}'::jsonb, null, null, 10)$$,
  '22023', null, 'the dispatcher refuses a panel type');

-- The dispatcher reaches the same rows the page function does. If a branch were
-- wired to the wrong function, or an enum value fell through the CASE, this is
-- what would catch it: a fall-through returns nothing, and nothing is not 2.
select is(
  (select distinct p.total_count from public.report_page(
     '00000000-0000-0000-0000-00008c050002',
     'PARTICIPATIONS'::public.report_type,
     array['00000000-0000-0000-0000-00008c020001']::uuid[],
     '{}'::jsonb, null, null, 100) p),
  2::bigint,
  'the dispatcher reaches the participations page function');

select * from finish();
rollback;
