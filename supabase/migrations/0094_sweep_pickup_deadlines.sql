-- Block 6d, Task 4: the clock. What finally reads the column 6a froze.
--
-- A PROCEDURE and not a function, because only a procedure may commit, and it
-- must commit per winner. The sweep is global -- every Station in the
-- installation -- and in one transaction a single winner whose movement is
-- refused (an inconsistent awaiting_pickup balance for its prize, say) would
-- roll back every other Station's expirations, every hour, for ever.
--
-- No HTTP and no application code in the path. 0064 reaches the app over
-- pg_net because the WhatsApp worker must talk to Meta and therefore lives in
-- TypeScript; nothing here does. Going through HTTP would add a URL and a
-- secret to configure, and docs/block-5a-runbook.md has a section on what
-- happens when they are wrong.
--
-- Not folded into that worker's ten-second tick either, the way 0072's
-- conversation sweep was: that would make prize deadlines in a Station with no
-- WhatsApp integration depend on the WhatsApp worker running.
--
-- SECURITY INVOKER, and carrying NEITHER `security definer` NOR a function-
-- level `set search_path` -- both dropped from the shape every other routine
-- in this schema uses, and not as a style choice. Postgres refuses
-- transaction control inside EITHER: a procedure declared with
-- `security definer`, or one declared with a `set` clause at all, raises on
-- its first COMMIT --
--   ERROR: invalid transaction termination
--   CONTEXT: PL/pgSQL function sweep_pickup_deadlines() line N at COMMIT
-- -- independent of anything the loop body does. Proved by bisecting the two
-- attributes in isolated single-purpose probe procedures (a bare `commit;`
-- with only `security definer` fails the same way; a bare `commit;` with only
-- `set search_path` fails the same way; a bare `commit;` with neither
-- succeeds) before touching this file. Both attributes make Postgres wrap the
-- call in a save/restore guard around the role or the GUC, and that guard is
-- incompatible with the callee also being "the sole top-level statement" a
-- procedure's own COMMIT/ROLLBACK requires. There is no workaround: a
-- procedure that must commit per iteration can carry neither, full stop.
--
-- Dropping search_path pinning is safe here because every object this body
-- touches is already schema-qualified -- public.winners, public.winner_status,
-- public.apply_winner_transition -- and the PL/pgSQL keywords around them
-- (declare, foreach, exception, commit...) are not schema lookups a hostile
-- search_path could redirect. Dropping SECURITY DEFINER is safe for the same
-- reason 0064's cron.schedule needs no such wrapper either: pg_cron runs a
-- scheduled job as the role that called cron.schedule() -- the migration-
-- running role, owner of apply_winner_transition and everything beneath it --
-- so SECURITY INVOKER carries exactly the privilege the loop body needs. The
-- EXECUTE grant to service_role below still gates who may issue the bare CALL
-- at all; it does not need to also carry the privileges apply_winner_transition
-- itself checks, because the role actually calling this in production is the
-- owner.
create procedure public.sweep_pickup_deadlines()
language plpgsql
as $$
declare
  v_ids     uuid[];
  v_id      uuid;
  v_expired integer := 0;
  v_failed  integer := 0;
begin
  -- Collected FIRST, then acted on, so that no cursor is held across a commit.
  -- The list is microseconds stale by the time it is walked and that is safe by
  -- construction rather than by care: apply_winner_transition re-reads and
  -- locks each row and refuses any source that is not AWAITING_PICKUP, so a
  -- prize delivered in between raises and is counted, not silently skipped.
  --
  -- `deadline_at is not null` is not defensive typing. 0075 wrote the rule
  -- down: null means this winner has NO deadline, because neither the
  -- promotion nor the prize set one, and inventing thirty days would start a
  -- clock the Station never agreed to. This predicate and the partial index
  -- winners_deadline_idx (0075) are the same three conditions, which is what
  -- makes the scan an index-only seek.
  select array_agg(id order by deadline_at)
    into v_ids
    from public.winners
   where status = 'AWAITING_PICKUP'
     and deadline_at is not null
     and deadline_at <= now();

  if v_ids is null then
    raise notice 'pickup deadline sweep: nothing due';
    return;
  end if;

  foreach v_id in array v_ids loop
    begin
      perform public.apply_winner_transition(
        v_id, 'RETURN_PENDING'::public.winner_status, 'pickup deadline expired');
      v_expired := v_expired + 1;
    exception
      -- Catching everything is a smell and it is the price of a sweep that
      -- cannot stop. What makes it acceptable is that the failure is NAMED --
      -- winner and SQLERRM -- rather than swallowed, and that pg_cron keeps
      -- the output in cron.job_run_details, which is where Block 11's §31
      -- alert will read from alongside the retention cron's (N7).
      when others then
        v_failed := v_failed + 1;
        raise warning 'pickup deadline sweep failed for winner %: %', v_id, sqlerrm;
    end;
    -- Outside the exception block on purpose: plpgsql refuses COMMIT inside a
    -- block that has an exception handler.
    commit;
  end loop;

  -- A procedure cannot return a row, so the totals are raised. Nothing calls
  -- this but the scheduler, and the scheduler stores output, not result sets.
  raise notice 'pickup deadline sweep: % expired, % failed', v_expired, v_failed;
end;
$$;

comment on procedure public.sweep_pickup_deadlines() is
  'Moves every winner whose frozen pickup deadline has passed to RETURN_PENDING, and its unit from awaiting_pickup to pending_return, where it rests until an operator returns it or writes it off. Scheduled hourly; deadlines are day-grained so an hour of latency is the whole cost. Skips a null deadline_at, which means this winner has no deadline at all rather than one of zero days (0075). Re-running is safe and not because this is careful: apply_winner_transition refuses any source that is not AWAITING_PICKUP, so twice in an hour and once after a week of downtime give the same result. Commits after each winner so that one whose movement is refused cannot roll back every other Station''s expirations. Records no actor -- auth.uid() is null under pg_cron and all three actor columns are nullable -- which is honest: nobody did this, the deadline did.';

revoke execute on procedure public.sweep_pickup_deadlines() from public;
grant execute on procedure public.sweep_pickup_deadlines() to service_role;

-- Idempotent, exactly as 0064: db:reset runs every migration from empty
-- locally, and a hosted redeploy must re-run this file without cron raising
-- "job already exists".
select cron.unschedule('pickup-deadline-sweep')
where exists (select 1 from cron.job where jobname = 'pickup-deadline-sweep');

-- Standard five-field cron, NOT the '1 hour' interval form. 0064 uses an
-- interval and had to document that second-level schedules need pg_cron >= 1.5
-- with a fallback for older installs. Hourly work needs no such note: every
-- version understands '0 * * * *'.
select cron.schedule(
  'pickup-deadline-sweep',
  '0 * * * *',
  $$ call public.sweep_pickup_deadlines(); $$
);
