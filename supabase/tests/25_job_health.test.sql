begin;
select plan(17);

-- Block 11b, D5. One row per scheduled routine, and failure detected by
-- silence. This file asserts the shape and the arithmetic; the routines are
-- actually CALLED in tests/isolation/job-health.test.ts, because a procedure
-- that commits cannot run inside the transaction pgTAP wraps this file in.

select has_table('public', 'job_health', 'job_health exists');

select ok(
  (select relrowsecurity from pg_class where relname = 'job_health'),
  'job_health has row level security enabled');

select is(
  (select count(*)::int from pg_policies where tablename = 'job_health'),
  0,
  'job_health has no policies -- it is operations data and nothing in the product reads it');

select is(
  (select count(*)::int from public.job_health),
  5,
  'the five routines that exist today are seeded');

-- Seeded HEALTHY. With a null last_success_at every row would be past its
-- max_silence the moment the migration landed, and the first health check would
-- send five e-mails about routines that never had a chance to run.
select ok(
  not exists (select 1 from public.job_health where last_success_at is null),
  'every seeded row starts with a last_success_at');

select ok(
  exists (select 1 from public.job_health
           where job_name = 'whatsapp-worker-tick' and max_silence = interval '15 minutes'),
  'the tick tolerates fifteen minutes of silence');

select ok(
  not exists (select 1 from public.job_health where job_name = 'job-health-check'),
  'the checker has no row of its own -- it cannot report its own silence');

select has_function('public', 'job_started', array['text'],
  'job_started exists');

select has_function('public', 'job_succeeded', array['text', 'jsonb'],
  'job_succeeded exists');

-- Nothing is unhealthy on a freshly seeded database...
select is(
  (select count(*)::int from public.check_job_health()),
  0,
  'nothing is unhealthy on a freshly seeded database');

-- ...and exactly the routine that went quiet is reported. Both halves, because
-- a check that returned everything would satisfy the first assertion alone.
update public.job_health
   set last_success_at = now() - interval '48 hours'
 where job_name = 'retention-sweep';

select is(
  (select string_agg(job_name, ',') from public.check_job_health()),
  'retention-sweep',
  'a routine past its max_silence is reported, and only that one');

-- ---------------------------------------------------------------------------
-- 0133: the wrappers, and where the schedules now point.
-- ---------------------------------------------------------------------------

-- Procedures, not functions, and that is load-bearing: a function is an atomic
-- context, so the inner `call` to a sweep that commits would raise `invalid
-- transaction termination`. Nor may any of them ever gain `security definer` or
-- a `set` clause, for the same reason 0094, 0128 and 0131 all assert.
select is(
  (select count(*)::int from pg_proc
    where proname in ('run_pickup_deadline_sweep', 'run_pickup_reminder_sweep',
                      'run_expire_report_runs')
      and prokind = 'p'
      and not prosecdef
      and proconfig is null),
  3,
  'the three tracking wrappers exist, are procedures, and carry no definer or set clause');

select is(
  (select count(*)::int from cron.job
    where command like '%run_pickup_deadline_sweep%'
       or command like '%run_pickup_reminder_sweep%'
       or command like '%run_expire_report_runs%'),
  3,
  'the three schedules call the wrappers, not the bare sweeps');

select ok(
  exists (select 1 from cron.job where jobname = 'job-health-check'),
  'the hourly health check is scheduled');

-- ---------------------------------------------------------------------------
-- The grants, and this file exists partly for these three.
--
-- service_role bypasses RLS but still needs ORDINARY TABLE PRIVILEGES, and a
-- table created by a migration does not inherit them here. Without them every
-- read answers 42501 and the alert route reports a healthy installation
-- because it cannot see the rows that say otherwise -- a monitor failing in
-- exactly the silent way this block exists to abolish. Found by running it.
-- ---------------------------------------------------------------------------
select ok(
  has_table_privilege('service_role', 'public.job_health', 'select'),
  'service_role may read job_health -- without this the alert route sees a healthy installation');

select ok(
  has_table_privilege('service_role', 'public.job_health', 'update'),
  'service_role may update job_health -- the tick stamps itself and the route stamps alerted_at');

select ok(
  not has_table_privilege('authenticated', 'public.job_health', 'select'),
  'authenticated may not read it -- this is operations data, not product data');

select * from finish();
rollback;
