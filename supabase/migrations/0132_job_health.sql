-- Block 11b, D5. The health of the scheduled routines.
--
-- Five routines run in this installation and none of them tells anybody
-- anything. The retention sweep of Block 11a spent its whole first version
-- deleting zero rows every night at 04:11 while its counters went to a Postgres
-- log no human has ever read -- so a sweep failing for a month looked exactly
-- like one that worked.
--
-- ONE ROW PER ROUTINE, NOT ONE PER RUN. The worker tick fires every ten
-- seconds; an append-only history would add some 8,600 rows a day and would
-- itself have to be swept by the sweep it monitors.
--
-- NO `exception` HANDLER ANYWHERE IN THIS BLOCK, and that is the lesson 11a
-- paid for: a begin/exception block opens a subtransaction, and `commit` inside
-- one raises `cannot commit while a subtransaction is active`. Failure is not
-- caught here -- it is detected by SILENCE, which needs no handler at all.
create table public.job_health (
  job_name             text primary key,
  last_started_at      timestamptz,
  last_success_at      timestamptz,
  last_counters        jsonb,
  -- Counted by the health check when it observes a routine still quiet, not by
  -- the routine itself: nothing in a failed run gets to write anything.
  consecutive_failures integer not null default 0,
  -- When the operator was told. Cleared by the next success, which is what
  -- makes this one e-mail per incident rather than one per hour.
  alerted_at           timestamptz,
  max_silence          interval not null
);

comment on table public.job_health is
  'Block 11b. One row per pg_cron routine: when it last started, when it last succeeded, what it counted, and how long it may stay quiet before somebody is e-mailed. Read hourly by check_job_health() through /api/worker/health-alert. There is no row for job-health-check itself -- a checker cannot report its own silence.';

-- Operations data: nothing in the product reads it. RLS on and NO policies, so
-- authenticated sees nothing, while the routines run as the owner and the
-- application reaches it with the service key.
alter table public.job_health enable row level security;

-- Seeded HEALTHY, deliberately. With a null last_success_at every row would be
-- past its window the moment this migration lands, and the first health check
-- an hour later would mail five failures about routines that had not yet had a
-- chance to run.
insert into public.job_health (job_name, max_silence, last_success_at) values
  -- Every ten seconds. Fifteen minutes of silence is three orders of magnitude
  -- past normal and still short enough to catch a queue stopping overnight.
  ('whatsapp-worker-tick',  interval '15 minutes', now()),
  ('pickup-deadline-sweep', interval '3 hours',    now()),
  ('pickup-reminder-sweep', interval '3 hours',    now()),
  ('expire-report-runs',    interval '26 hours',   now()),
  ('retention-sweep',       interval '26 hours',   now())
on conflict (job_name) do nothing;

-- Functions rather than inline updates, so a routine's own body carries one
-- readable line and the shape can change without editing four migrations.
create or replace function public.job_started(p_job text)
returns void
language sql
as $$
  update public.job_health set last_started_at = now() where job_name = p_job;
$$;

comment on function public.job_started(text) is
  'Block 11b. Stamps the attempt. A last_started_at later than last_success_at, past the deadline, is what a failure looks like from the outside.';

create or replace function public.job_succeeded(p_job text, p_counters jsonb default null)
returns void
language sql
as $$
  update public.job_health
     set last_success_at      = now(),
         last_counters        = coalesce(p_counters, last_counters),
         consecutive_failures = 0,
         -- Clearing this is what re-arms the alert: recovery, not a timer, is
         -- what makes the next incident reportable.
         alerted_at           = null
   where job_name = p_job;
$$;

comment on function public.job_succeeded(text, jsonb) is
  'Block 11b. Stamps the success and what it counted, and re-arms the alert by clearing alerted_at.';

-- SECURITY INVOKER (the default) on all three, and it costs nothing: pg_cron
-- runs each routine as the role that scheduled it -- the owner -- and the
-- application reaches these with the service key. An authenticated caller who
-- found them would update zero rows, because the RLS above grants nobody
-- anything.
create or replace function public.check_job_health()
returns table (
  job_name        text,
  last_success_at timestamptz,
  last_started_at timestamptz,
  last_counters   jsonb,
  alerted_at      timestamptz
)
language sql
stable
as $$
  select h.job_name, h.last_success_at, h.last_started_at, h.last_counters, h.alerted_at
    from public.job_health h
   where coalesce(h.last_success_at, '-infinity'::timestamptz) < now() - h.max_silence
   order by h.job_name;
$$;

comment on function public.check_job_health() is
  'Block 11b. The routines that have gone quiet for longer than they are allowed to. Detection is by silence rather than by a caught exception, because a routine that commits cannot carry an exception handler -- which is how the 11a sweep shipped deleting nothing with a green suite.';

revoke execute on function public.job_started(text) from public;
revoke execute on function public.job_succeeded(text, jsonb) from public;
revoke execute on function public.check_job_health() from public;

-- The application needs exactly two of them: the worker tick stamps itself
-- (pg_cron cannot -- its statement only enqueues an HTTP request), and the
-- health-alert route reads the check.
grant execute on function public.job_succeeded(text, jsonb) to service_role;
grant execute on function public.check_job_health() to service_role;

-- AND THE TABLE ITSELF, which is not automatic and is the trap Block 7b already
-- paid for once. `service_role` bypasses RLS but still needs ordinary table
-- privileges, and a table created by a migration does not inherit them here:
-- without these two lines every read answers 42501, "permission denied for
-- table job_health", and the alert route reports a healthy installation because
-- it cannot see the rows saying otherwise.
--
-- Both verbs, and no more: SELECT for check_job_health() (SECURITY INVOKER, so
-- it runs as the caller) and UPDATE for job_succeeded and the alerted_at stamp.
-- No INSERT and no DELETE -- the five rows are seeded here and the set of
-- scheduled routines changes by migration, not by the application.
grant select, update on public.job_health to service_role;
