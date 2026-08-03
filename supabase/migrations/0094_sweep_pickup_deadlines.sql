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
-- Dropping search_path pinning is safe here NOT because every reference below
-- is schema-qualified -- it is not: now(), array_agg(), and the <=, = and +
-- operator resolutions are all unqualified, and pinning exists precisely to
-- stop a hostile search_path redirecting lookups like those. What actually
-- makes it safe is that this routine is SECURITY INVOKER: it always runs with
-- the CALLER's own privileges, so a caller who redirects their own unqualified
-- lookups is only attacking themselves -- there is no elevated privilege for
-- the redirection to steal, which is the entire reason pinning matters on a
-- SECURITY DEFINER routine and does not matter on this one. (pg_catalog is
-- also searched ahead of an unqualified search_path by default, which narrows
-- the exposure further, but the INVOKER argument is the one that holds
-- regardless, and is the one to restate if this shape is ever copied into a
-- routine that IS SECURITY DEFINER.)
--
-- Dropping SECURITY DEFINER, separately, is safe for the reason 0064's
-- cron.schedule needs no such wrapper either: pg_cron runs a scheduled job as
-- the role that called cron.schedule() -- the migration-running role, owner
-- of apply_winner_transition and everything beneath it -- so SECURITY INVOKER
-- already carries the privilege the loop body needs, because that owning role
-- is the one actually calling it in production.
--
-- EXECUTE below is owner-only: revoked from public and granted to nobody
-- else, the convention this schema uses for every other SECURITY INVOKER
-- writer (apply_inventory_movement, apply_winner_transition, apply_draw). An
-- earlier draft granted EXECUTE to service_role, reasoning that the SECURITY
-- DEFINER shape it started as would need it the way other RPCs need it --
-- measured and wrong once that attribute was dropped: service_role holds no
-- EXECUTE on apply_winner_transition or apply_inventory_movement and no
-- UPDATE on winners, so a service_role CALL would collect its candidates
-- fine, then fail EVERY winner with "permission denied for function
-- apply_winner_transition", caught by the handler below, reported as
-- "0 expired, N failed" -- and still return success to the caller. A silent
-- no-op, worse than no grant at all. The fix is owner-only EXECUTE, not a
-- matching grant three functions deep.
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
  -- `deadline_at is not null` does not earn its place by enforcing 0075's
  -- rule -- SQL's own null semantics already do that with or without it:
  -- `null <= now()` is NULL, not true, so a null deadline is excluded from
  -- this WHERE clause regardless. What the predicate actually does is make
  -- this WHERE clause match the partial index winners_deadline_idx (0075)
  -- exactly, which is what lets the planner use that index at all; without
  -- it, the same correct rows come back off a full scan instead. And even
  -- with the index used, this is an ORDINARY index scan with a heap fetch per
  -- row, not an index-only one -- id is not a column the index carries.
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
      -- cannot stop. The failure is NAMED -- winner and SQLERRM -- in a
      -- WARNING, and a WARNING lands in the Postgres server log, NOT in
      -- cron.job_run_details: that table's return_message is the CALL's own
      -- completion status, and anything merely RAISEd during the call (NOTICE
      -- or WARNING) does not reach it. Measured: a disposable job that only
      -- raises a WARNING and a NOTICE still records status=succeeded,
      -- return_message='CALL'. So cron.job_run_details alone cannot tell a
      -- clean run from one where every winner failed -- which is exactly why
      -- this procedure raises an exception below when v_failed > 0, after
      -- every succeeded winner is already committed. That raise IS what
      -- cron.job_run_details can see. Block 11's §31 alert (alongside the
      -- retention cron's, N7) has to read the run-failed-or-not fact from
      -- job_run_details and the per-winner detail -- which winner, which
      -- error -- from the server log; job_run_details alone carries neither
      -- on its own.
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

  -- Raised AFTER every winner has already been committed above, so this
  -- destroys no work -- it only marks the run failed where cron.job_run_details
  -- can see it, which nothing before this line could (see the exception
  -- handler's own comment). Verified empirically against this project's own
  -- pg_cron: a disposable job with one poisoned winner records status=failed
  -- and this message in return_message; the same shape with nothing due, or
  -- with every winner succeeding, records status=succeeded.
  if v_failed > 0 then
    raise exception
      'pickup deadline sweep: % of % due winner(s) failed -- see the server log for which',
      v_failed, v_expired + v_failed;
  end if;
end;
$$;

comment on procedure public.sweep_pickup_deadlines() is
  'Moves every winner whose frozen pickup deadline has passed to RETURN_PENDING, and its unit from awaiting_pickup to pending_return, where it rests until an operator returns it or writes it off. Scheduled hourly; deadlines are day-grained so an hour of latency is the whole cost. Skips a null deadline_at, which means this winner has no deadline at all rather than one of zero days (0075). Re-running is safe and not because this is careful: apply_winner_transition refuses any source that is not AWAITING_PICKUP, so twice in an hour and once after a week of downtime give the same result. Commits after each winner so that one whose movement is refused cannot roll back every other Station''s expirations, then raises if any winner failed -- after every succeeded winner is already committed, so this destroys no work, and it exists only so cron.job_run_details can distinguish a clean run from one with real failures, which the per-winner WARNING alone cannot: that lands in the server log, not in job_run_details. Records no actor -- auth.uid() is null under pg_cron and all three actor columns are nullable -- which is honest: nobody did this, the deadline did.';

-- Owner-only: EXECUTE is revoked from public and granted to nobody else, the
-- convention this schema uses for every other SECURITY INVOKER writer. See
-- the header comment for why an earlier draft's grant to service_role was
-- wrong.
revoke execute on procedure public.sweep_pickup_deadlines() from public;

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
