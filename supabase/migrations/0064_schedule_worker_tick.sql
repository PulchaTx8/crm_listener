-- supabase/migrations/0064_schedule_worker_tick.sql
--
-- The trigger, and deliberately the only thing in this repository that knows
-- the worker exists. Everything else -- what a tick does, how an event is
-- decided, how a reply is sent -- lives in 0062/0063 and in
-- src/app/api/worker/tick/route.ts. This file's entire job is to call that
-- route on a schedule.
--
-- Second-level schedules need pg_cron >= 1.5. Verify on the target with
--   select extversion from pg_extension where extname = 'pg_cron';
-- and fall back to '* * * * *' (one minute) if it is older -- nothing breaks,
-- the backlog just drains more slowly, since due_whatsapp_events (0063) reads
-- the queue by what is due rather than by what a fixed-size tick was handed.
-- docs/block-5a-runbook.md carries this as an operational check, not merely a
-- comment here: the owner is expected to run that query before trusting a
-- ten-second schedule on a database this migration has not itself verified.
--
-- The URL and the shared secret are per-environment and are NOT in this file:
-- committing them would put a secret in the repository and pin the
-- deployment to whichever host happened to be current the day this migration
-- was written. They are read back with current_setting(..., true) -- the
-- `true` is missing_ok, which is what lets this migration apply cleanly to a
-- database where neither has been set yet, rather than raising. The runbook
-- sets both as DATABASE SETTINGS, which is where a value a SQL function needs
-- to read belongs (this project deploys through EasyPanel, and an EasyPanel
-- environment variable is not visible inside Postgres -- no more than a Vercel
-- one would be, and this project has never deployed to Vercel):
--   alter database postgres set app.worker_tick_url = 'https://<host>/api/worker/tick';
--   alter database postgres set app.worker_tick_secret = '<the same value as WORKER_TICK_SECRET>';
-- Until both are set, the job exists and fires every ten seconds, and the
-- WHERE clause below makes each firing a no-op rather than a call to a null
-- URL -- schedule-then-configure is safe in either order.
--
-- NULLIF ON THE GUARD, AND IT IS NOT DECORATION. current_setting(name, true)
-- returns NULL for a setting that has never been set and the EMPTY STRING for
-- one that exists and is blank -- which is what
-- `alter database postgres set app.worker_tick_url = ''` leaves behind, and
-- what a half-finished configuration step looks like. An `is not null` guard
-- alone passes on the empty string, and the job then POSTs to an empty URL
-- every ten seconds for ever, filling net._http_response with failures that
-- describe the configuration rather than the worker.

create extension if not exists pg_cron with schema cron;
create extension if not exists pg_net with schema extensions;

-- Idempotent: re-running this migration against a database that already has
-- the job replaces it rather than raising cron's own "job ... already
-- exists". db:reset runs every migration from empty every time locally, and a
-- hosted redeploy must be able to re-run this file without manual cleanup.
select cron.unschedule('whatsapp-worker-tick')
where exists (select 1 from cron.job where jobname = 'whatsapp-worker-tick');

-- timeout_milliseconds is SET EXPLICITLY, and 90 seconds is not a guess about
-- how long the app may take -- nothing here waits for the answer. pg_net is
-- fire-and-forget: this statement returns a request id, the tick runs to
-- completion on the server whatever happens to the connection, and no code
-- anywhere reads the response. What the timeout decides is the ROW pg_net
-- leaves behind in net._http_response, which is the only trace of a tick an
-- operator has from the database side and which docs/block-5a-runbook.md sends
-- them to.
--
-- At pg_net's default of 5 seconds that row is a TIMEOUT on every busy tick: a
-- full batch is up to fifty ingest transactions plus fifty sequential HTTPS
-- calls to Meta, which routinely outlasts five seconds and is the case the
-- batch caps in src/services/whatsapp.ts are sized for. A table of timeouts
-- recording ticks that in fact succeeded is worse than no record: it trains
-- whoever reads it to ignore the one place a real failure would appear.
--
-- 90 seconds is comfortably past a full batch and still bounded, so a genuinely
-- hung request is released rather than held open by a pg_net worker. Ticks
-- overlapping is normal and by design (0063), so a long-running one does not
-- delay the next.
select cron.schedule(
  'whatsapp-worker-tick',
  '10 seconds',
  $$
  select net.http_post(
    url     := current_setting('app.worker_tick_url', true),
    headers := jsonb_build_object(
      'content-type', 'application/json',
      'x-worker-secret', current_setting('app.worker_tick_secret', true)),
    body    := '{}'::jsonb,
    timeout_milliseconds := 90000
  )
  where nullif(current_setting('app.worker_tick_url', true), '') is not null;
  $$
);

comment on extension pg_net is
  'Lets pg_cron reach the worker tick over HTTP. The database calling the app is the one direction this block needs; nothing calls back the other way except the app''s own service-role client (createServiceClient(), src/lib/supabase/service-client.ts).';
