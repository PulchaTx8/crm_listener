-- supabase/migrations/0127_report_run_rpcs.sql

-- Block 8b, Task 8: the run's whole life.
--
-- FIVE FUNCTIONS AND ONE ASYMMETRY IN THE GRANTS: request_report is the
-- client's only door and goes to authenticated; the other four go to
-- service_role alone. A client that could call finish_report_run could set
-- status = READY and point storage_path at another Station's object, which the
-- bucket policy (0123) would then match and sign.

-- ---------------------------------------------------------------------------
-- 1. request_report. The only write door a client has.
--
-- THE PREFLIGHT IS THE INTERESTING PART. It calls report_page with p_limit => 1
-- and reads total_count off the result, which does three jobs in one call: it
-- runs the page function's own permission guard AS THE CALLER, so an
-- unauthorised request is refused in the dialog the operator is looking at
-- rather than ten seconds later in a queue; it produces the row count for the
-- ceiling without a second implementation of the filter predicates; and it
-- proves the filters parse before a run row exists to carry a malformed one.
--
-- The ceiling REFUSES rather than truncating. A silently truncated export is
-- the worst available outcome: it looks complete, it is used as if it were
-- complete, and nothing in the file says otherwise.
-- ---------------------------------------------------------------------------

create function public.request_report(
  p_organization_id uuid,
  p_company_ids     uuid[],
  p_report_type     public.report_type,
  p_format          public.report_format,
  p_filters         jsonb default '{}'::jsonb,
  p_payload         jsonb default null
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor   uuid := auth.uid();
  v_company uuid;
  v_count   bigint := 0;
  v_id      uuid;
  v_ceiling constant integer := 50000;
  v_is_panel boolean := p_report_type in
    ('AUDIENCE_PANEL', 'MUSIC_PANEL', 'PROMOTIONS_PANEL');
begin
  if v_actor is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;

  if p_company_ids is null or cardinality(p_company_ids) = 0 then
    raise exception 'at least one station is required' using errcode = '22023';
  end if;

  -- Every named Station must belong to the named Organization. The permission
  -- check below would refuse a foreign Station anyway, but it would refuse it
  -- with a permission error for what is really a malformed request -- and the
  -- run row would otherwise record an organization_id its company_ids
  -- contradict, which no later reader could make sense of.
  foreach v_company in array p_company_ids loop
    if not exists (
      select 1 from public.companies c
      where c.id = v_company and c.organization_id = p_organization_id
    ) then
      raise exception 'station does not belong to this organization'
        using errcode = '22023';
    end if;
  end loop;

  -- 8a's D3, checked HERE and not in the page functions: those are also the
  -- single-Station preflight, and checking it there would refuse an ordinary
  -- request for a reason the operator has not reached.
  if cardinality(p_company_ids) > 1 then
    foreach v_company in array p_company_ids loop
      if not public.has_permission_for(v_actor, 'reports.consolidated', v_company) then
        raise log 'consolidated report denied: user=% company=%', v_actor, v_company;
        raise exception 'permission denied: reports.consolidated required in every station'
          using errcode = '42501';
      end if;
    end loop;
  end if;

  if v_is_panel then
    -- The CHECK would catch this, but with a constraint name for a message.
    -- The worker cannot recompute a panel: the aggregates are SECURITY INVOKER
    -- and granted to authenticated only.
    if p_payload is null then
      raise exception 'a panel report must carry its captured payload'
        using errcode = '22023';
    end if;
  else
    if p_payload is not null then
      raise exception 'a listing report carries no payload' using errcode = '22023';
    end if;

    -- One call: the permission guard, the filter parse, and the count.
    select coalesce(max(rp.total_count), 0) into v_count
    from public.report_page(
      v_actor, p_report_type, p_company_ids, p_filters, null, null, 1) rp;

    if v_count > v_ceiling then
      raise exception
        'this report would have % rows, above the limit of % -- narrow the filter',
        v_count, v_ceiling
        using errcode = '22023';
    end if;
  end if;

  insert into public.report_runs
    (organization_id, company_ids, requested_by, report_type, format, filters, payload)
  values
    (p_organization_id, p_company_ids, v_actor, p_report_type, p_format,
     coalesce(p_filters, '{}'::jsonb), p_payload)
  returning id into v_id;

  -- THE BLOCK'S REAL CONTROL OVER EXPORTING PERSONAL DATA (design D8). There is
  -- no reports.export permission, deliberately: somebody who can page through
  -- forty thousand listeners on screen can already extract them, so the
  -- permission would add role-management burden without adding a boundary. What
  -- does work is the trail. Block 3 took the same stance with
  -- document_access_logs -- the access is not forbidden, it is recorded.
  insert into public.audit_logs
    (actor_id, action, target_table, target_id, organization_id, company_id, detail)
  values
    (v_actor, 'request_report', 'report_runs', v_id, p_organization_id,
     p_company_ids[1],
     jsonb_build_object(
       'report_type', p_report_type,
       'format',      p_format,
       'company_ids', to_jsonb(p_company_ids),
       'filters',     coalesce(p_filters, '{}'::jsonb),
       'row_count_estimate', v_count));

  return v_id;
end;
$$;

comment on function public.request_report(uuid, uuid[], public.report_type, public.report_format, jsonb, jsonb) is
  'The client''s only write door onto the report engine. Preflights through report_page with p_limit => 1, which in ONE call runs the page function''s permission guard as the caller (so an unauthorised or oversized request is refused in the dialog rather than ten seconds later), parses the filters, and produces the row count for the 50 000 ceiling without a second implementation of the predicates. The ceiling refuses rather than truncating, because a silently truncated export looks complete and is used as if it were. Writes an audit_logs row on every request: with no reports.export permission by design, the trail is what makes an export accountable.';

-- ---------------------------------------------------------------------------
-- 2. claim_report_run. claim_outbox_batch's shape (0111), for its reasons.
--
-- `for update skip locked` is the whole of the concurrency argument: two ticks
-- overlapping -- a slow generation and the next cron firing ten seconds later
-- -- take different rows, or one takes nothing. Never the same row twice, which
-- would write the file twice and let the second finish overwrite the first.
--
-- ATTEMPTS INCREMENTS ON CLAIM, NOT ON FAILURE. A run whose process dies
-- without reporting anything still counts its try; otherwise a container that
-- crashes mid-file would be retried for ever, which is the failure mode D10
-- exists to prevent.
--
-- ONE ROW PER TICK. The tick's first duty is the WhatsApp outbox, and a
-- forty-thousand-row workbook must not hold it.
-- ---------------------------------------------------------------------------

create function public.claim_report_run()
returns setof public.report_runs
language sql
security definer
set search_path = pg_catalog, public
as $$
  update public.report_runs r
     set status     = 'RUNNING',
         started_at = now(),
         attempts   = r.attempts + 1
   where r.id = (
     select c.id from public.report_runs c
      where c.status = 'QUEUED'
      order by c.requested_at
      for update skip locked
      limit 1
   )
  returning r.*;
$$;

comment on function public.claim_report_run() is
  'One QUEUED run, oldest first, moved to RUNNING and returned. claim_outbox_batch''s shape (0111): `for update skip locked` means two overlapping ticks take different rows or one takes nothing -- never the same row twice, which would write the file twice and let the second finish overwrite the first. attempts increments HERE rather than on failure, so a run whose process dies without reporting anything still counts its try.';

-- ---------------------------------------------------------------------------
-- 3. finish_report_run.
--
-- expires_at is seven days from NOW, which is finished_at: the clock starts
-- when the file exists, not when it was asked for, so a run that sat in the
-- queue does not arrive already half-expired.
-- ---------------------------------------------------------------------------

create function public.finish_report_run(
  p_run_id       uuid,
  p_storage_path text,
  p_row_count    integer,
  p_byte_size    integer,
  p_withheld     text[] default '{}'
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  update public.report_runs
     set status       = 'READY',
         storage_path = p_storage_path,
         row_count    = p_row_count,
         byte_size    = p_byte_size,
         withheld     = coalesce(p_withheld, '{}'),
         last_error   = null,
         finished_at  = now(),
         expires_at   = now() + interval '7 days'
   where id = p_run_id
     and status = 'RUNNING';

  if not found then
    -- Not a no-op to swallow. A finish for a run that is not RUNNING means the
    -- claim was lost -- a stall requeue overtook this process, or the row was
    -- claimed twice -- and the file just uploaded is now unreferenced. Failing
    -- loudly is what gets that into the tick's counters.
    raise exception 'report run % is not RUNNING and cannot be finished', p_run_id
      using errcode = '22023';
  end if;
end;
$$;

comment on function public.finish_report_run(uuid, text, integer, integer, text[]) is
  'Marks a RUNNING run READY with its file. expires_at is seven days from finished_at -- the clock starts when the file EXISTS, not when it was asked for, so a run that sat in the queue does not arrive half-expired. Raises rather than no-opping when the run is not RUNNING: that means the claim was lost, and the file just uploaded is unreferenced.';

-- ---------------------------------------------------------------------------
-- 4. fail_report_run.
--
-- THREE ATTEMPTS AND THEN IT STOPS, deliberately unlike storage_erasure_queue
-- (0087), which has no give-up threshold at all because a silently abandoned
-- erasure is a legal obligation dropped. A report is the opposite: after three
-- attempts the run is FAILED with the error on the operator's own screen, and
-- they ask again. A queue that retries for ever hides the defect causing the
-- failure behind a row that is always about to succeed.
-- ---------------------------------------------------------------------------

create function public.fail_report_run(p_run_id uuid, p_error text)
returns void
language sql
security definer
set search_path = pg_catalog, public
as $$
  -- The casts are load-bearing: a bare CASE over string literals is text, and
  -- assigning text to a report_status column is a 42804 at creation time.
  update public.report_runs
     set status      = (case when attempts >= 3 then 'FAILED' else 'QUEUED' end)::public.report_status,
         last_error  = coalesce(nullif(btrim(p_error), ''), 'unknown error'),
         started_at  = case when attempts >= 3 then started_at else null end,
         finished_at = case when attempts >= 3 then now() else null end
   where id = p_run_id;
$$;

comment on function public.fail_report_run(uuid, text) is
  'Records why a run failed and either returns it to the queue or gives up. Three attempts and no more -- deliberately UNLIKE storage_erasure_queue (0087), which never gives up because a silently abandoned erasure is a legal obligation dropped. A report is the opposite: a failed one only needs asking for again, and a queue that retries for ever hides the defect behind a row that is always about to succeed.';

-- ---------------------------------------------------------------------------
-- 5. requeue_stalled_report_runs. Called from the tick, not from cron, so it
-- needs no schedule of its own.
--
-- A run left RUNNING for more than fifteen minutes is a container that died
-- mid-file. It returns to the queue -- or gives up, if its attempts are already
-- spent -- because otherwise it is a row that is RUNNING for ever and a file
-- that never arrives, with nothing on the operator's screen saying so.
-- ---------------------------------------------------------------------------

create function public.requeue_stalled_report_runs()
returns integer
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_count integer;
begin
  with stalled as (
    update public.report_runs
       set status      = (case when attempts >= 3 then 'FAILED' else 'QUEUED' end)::public.report_status,
           last_error  = 'generation stalled: no progress for 15 minutes',
           started_at  = case when attempts >= 3 then started_at else null end,
           finished_at = case when attempts >= 3 then now() else null end
     where status = 'RUNNING'
       and started_at < now() - interval '15 minutes'
    returning 1
  )
  select count(*)::integer into v_count from stalled;

  return v_count;
end;
$$;

comment on function public.requeue_stalled_report_runs() is
  'Returns runs left RUNNING for over fifteen minutes -- a container that died mid-file -- to the queue, or fails them if their three attempts are spent. Called from the worker tick rather than scheduled separately: it is cheap, and a stall matters exactly when the next generation is about to start.';

-- ---------------------------------------------------------------------------
-- Grants. request_report to the client; the lifecycle to the worker alone.
-- ---------------------------------------------------------------------------

revoke execute on function public.request_report(uuid, uuid[], public.report_type, public.report_format, jsonb, jsonb) from public;
revoke execute on function public.claim_report_run() from public;
revoke execute on function public.finish_report_run(uuid, text, integer, integer, text[]) from public;
revoke execute on function public.fail_report_run(uuid, text) from public;
revoke execute on function public.requeue_stalled_report_runs() from public;

grant execute on function public.request_report(uuid, uuid[], public.report_type, public.report_format, jsonb, jsonb) to authenticated;
grant execute on function public.claim_report_run() to service_role;
grant execute on function public.finish_report_run(uuid, text, integer, integer, text[]) to service_role;
grant execute on function public.fail_report_run(uuid, text) to service_role;
grant execute on function public.requeue_stalled_report_runs() to service_role;
