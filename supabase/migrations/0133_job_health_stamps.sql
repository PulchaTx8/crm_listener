-- Block 11b, D5. The routines stamp job_health.
--
-- TWO SHAPES, AND THE ASYMMETRY IS DELIBERATE.
--
-- `sweep_retention` is RESTATED IN FULL, because its counters are the point:
-- the complaint that opened this block is that they went to the Postgres log
-- and nowhere else, so a sweep failing for a month looked exactly like one that
-- worked. Only its own body can report them.
--
-- The other three get a thin wrapper that stamps around an untouched call. They
-- have no counters worth surfacing -- what is wanted from them is "did it run"
-- -- and restating three long, working procedures to add two lines each would
-- be three chances to introduce a defect in code nobody asked to change.
--
-- Nothing here carries an `exception` handler, for the reason 0132 gives at
-- length.

-- ---------------------------------------------------------------------------
-- 1. The three wrappers.
--
-- A PROCEDURE may call another procedure that commits, because pg_cron invokes
-- the outer one with CALL and no atomic context encloses it. A FUNCTION could
-- not: it would BE an atomic context, and the inner commit would raise
-- `invalid transaction termination`. That is also why none of these may ever
-- gain `security definer` or a `set` clause -- 0094 proved it and 0128 and 0131
-- both assert it.
-- ---------------------------------------------------------------------------
create or replace procedure public.run_pickup_deadline_sweep()
language plpgsql
as $$
begin
  perform public.job_started('pickup-deadline-sweep');
  commit;
  call public.sweep_pickup_deadlines();
  perform public.job_succeeded('pickup-deadline-sweep');
  commit;
end;
$$;

comment on procedure public.run_pickup_deadline_sweep() is
  'Block 11b. sweep_pickup_deadlines (0094) with a health stamp on either side. The sweep itself is untouched.';

create or replace procedure public.run_pickup_reminder_sweep()
language plpgsql
as $$
begin
  perform public.job_started('pickup-reminder-sweep');
  commit;
  call public.sweep_pickup_reminders();
  perform public.job_succeeded('pickup-reminder-sweep');
  commit;
end;
$$;

comment on procedure public.run_pickup_reminder_sweep() is
  'Block 11b. sweep_pickup_reminders (0112) with a health stamp on either side. The sweep itself is untouched.';

create or replace procedure public.run_expire_report_runs()
language plpgsql
as $$
begin
  perform public.job_started('expire-report-runs');
  commit;
  call public.expire_report_runs();
  perform public.job_succeeded('expire-report-runs');
  commit;
end;
$$;

comment on procedure public.run_expire_report_runs() is
  'Block 11b. expire_report_runs (0128) with a health stamp on either side. The expiry itself is untouched.';

-- The schedules call the wrappers now. Unscheduled by name first: cron.schedule
-- would replace them anyway, but naming the removal is what makes the change
-- legible to whoever reads cron.job afterwards looking for why a sweep moved.
select cron.unschedule('pickup-deadline-sweep');
select cron.schedule(
  'pickup-deadline-sweep',
  '0 * * * *',
  $$ call public.run_pickup_deadline_sweep(); $$
);

select cron.unschedule('pickup-reminder-sweep');
select cron.schedule(
  'pickup-reminder-sweep',
  '0 * * * *',
  $$ call public.run_pickup_reminder_sweep(); $$
);

select cron.unschedule('expire-report-runs');
select cron.schedule(
  'expire-report-runs',
  '17 3 * * *',
  $$ call public.run_expire_report_runs(); $$
);

-- ---------------------------------------------------------------------------
-- 2. sweep_retention, restated with its counters.
--
-- Every delete, every period and every table below is 0131's, unchanged -- read
-- that file for why each one is on the list, why FAILED rows are included, why
-- an unprocessed storage_erasure_queue row is not, and why audit_logs is never
-- named. What is new here is v_counters and the two stamps.
-- ---------------------------------------------------------------------------
create or replace procedure public.sweep_retention()
language plpgsql
as $$
declare
  v_deleted  integer;
  v_total    integer := 0;
  v_counters jsonb   := '{}'::jsonb;
begin
  perform public.job_started('retention-sweep');
  commit;

  -- 1. webhook_events, 90 days. Meta's raw payload, whole: the most sensitive
  -- and the highest volume. Every terminal state INCLUDING FAILED -- a webhook
  -- that could not be processed in ninety days will not be processed, and
  -- keeping a listener's message text for ever because the code that should
  -- have read it had a bug is not a retention policy, it is an accident.
  delete from public.webhook_events
   where received_at < now() - interval '90 days'
     and status in ('DONE', 'FAILED');
  get diagnostics v_deleted = row_count;
  commit;
  v_total := v_total + v_deleted;
  v_counters := v_counters || jsonb_build_object('webhook_events', v_deleted);

  -- 2. outbox_messages, 180 days. Terminal states only: a PENDING row is work
  -- not yet done, however old, and deleting it would silently drop a message
  -- somebody is waiting for.
  delete from public.outbox_messages
   where created_at < now() - interval '180 days'
     and status in ('SENT', 'FAILED');
  get diagnostics v_deleted = row_count;
  commit;
  v_total := v_total + v_deleted;
  v_counters := v_counters || jsonb_build_object('outbox_messages', v_deleted);

  -- 3. whatsapp_conversations, 180 days after they EXPIRED, not after they
  -- began.
  delete from public.whatsapp_conversations
   where expires_at < now() - interval '180 days';
  get diagnostics v_deleted = row_count;
  commit;
  v_total := v_total + v_deleted;
  v_counters := v_counters || jsonb_build_object('whatsapp_conversations', v_deleted);

  -- 4. contact_requests, 365 days. Personal data belonging to somebody who is
  -- not a customer and never became one.
  delete from public.contact_requests
   where created_at < now() - interval '365 days';
  get diagnostics v_deleted = row_count;
  commit;
  v_total := v_total + v_deleted;
  v_counters := v_counters || jsonb_build_object('contact_requests', v_deleted);

  -- 5-7. Operational leftovers, 30 days. No personal data in any of them; swept
  -- for size rather than for law, and listed so nobody has to wonder later
  -- whether their absence was deliberate.
  delete from public.rate_limit_counters
   where reset_at < now() - interval '30 days';
  get diagnostics v_deleted = row_count;
  commit;
  v_total := v_total + v_deleted;
  v_counters := v_counters || jsonb_build_object('rate_limit_counters', v_deleted);

  delete from public.whatsapp_conversation_leases
   where claimed_at < now() - interval '30 days';
  get diagnostics v_deleted = row_count;
  commit;
  v_total := v_total + v_deleted;
  v_counters := v_counters || jsonb_build_object('whatsapp_conversation_leases', v_deleted);

  -- processed_at NOT NULL only: an unprocessed row is an erasure this
  -- installation still owes somebody, and 0087 is explicit that it has NO
  -- give-up threshold for exactly that reason.
  delete from public.storage_erasure_queue
   where processed_at is not null
     and processed_at < now() - interval '30 days';
  get diagnostics v_deleted = row_count;
  commit;
  v_total := v_total + v_deleted;
  v_counters := v_counters || jsonb_build_object('storage_erasure_queue', v_deleted);

  -- Where the counters go now. 0131's `raise notice` lines are GONE rather than
  -- duplicated: a number reported in two places is a number that will
  -- eventually disagree with itself, and the log was never read anyway.
  --
  -- Still NO audit row per deleted record, deliberately: one per deleted
  -- webhook_events row would write more rows than the sweep removed, into the
  -- one table this procedure promises never to sweep.
  perform public.job_succeeded(
    'retention-sweep',
    v_counters || jsonb_build_object('total', v_total));
  commit;
end;
$$;

comment on procedure public.sweep_retention() is
  'Requirement N7. Deletes data whose retention period has expired: webhook_events at 90 days (Meta''s raw payload, the most sensitive thing this installation stores), outbox_messages and whatsapp_conversations at 180, contact_requests at 365, and three operational tables at 30. Commits per table so one failure does not roll back the rest, every night, for ever. DOES NOT TOUCH audit_logs -- kept for ever, because it is the proof that erasures happened -- nor any business record: those are what a radio must prove afterwards, and personal data inside them is removed by anonymize_member (0034), which is subject-driven rather than age-driven. Block 11b: reports what it deleted into job_health instead of into a Postgres log nobody reads.';

-- ---------------------------------------------------------------------------
-- 3. The check itself, hourly, over the road 0064 built.
--
-- The database cannot send e-mail: the mailer is nodemailer over SMTP, in the
-- application. So pg_net knocks on the app's door and the app decides who to
-- tell. The consequence, stated rather than discovered: IF THE APP IS DOWN, NO
-- ALERT LEAVES. That case belongs to external uptime monitoring against
-- /api/health, and no amount of SQL here would change it.
--
-- Silent while `app.health_alert_url` is unset, exactly as the worker tick is
-- while `app.worker_tick_url` is -- so a local stack and a fresh CI database
-- schedule the job and post nowhere.
--
-- :23, off the hour, so it does not compete with the two sweeps at :00.
-- ---------------------------------------------------------------------------
select cron.schedule(
  'job-health-check',
  '23 * * * *',
  $$
  select net.http_post(
    url     := current_setting('app.health_alert_url', true),
    headers := jsonb_build_object(
      'content-type', 'application/json',
      'x-worker-secret', current_setting('app.worker_tick_secret', true)),
    body    := '{}'::jsonb,
    timeout_milliseconds := 30000
  )
  where nullif(current_setting('app.health_alert_url', true), '') is not null;
  $$
);
