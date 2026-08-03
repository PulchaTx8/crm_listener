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
-- STANDING HAZARD, not a defect today: every table this routine touches --
-- winners included -- has relforcerowsecurity = false, so as SECURITY INVOKER
-- it already sees every row regardless of what RLS policies exist, because
-- FORCE ROW LEVEL SECURITY is what would make RLS apply even to a table's own
-- owner and nothing here has that set. If `alter table public.winners force
-- row level security` is ever added in a later block, this sweep would start
-- seeing ZERO candidate rows -- no error, no warning, anywhere. Deadlines
-- would simply stop expiring. Nothing today does this; anyone adding FORCE
-- ROW LEVEL SECURITY to winners needs to know this routine depends on its
-- absence. (docs/block-6d-report.md's deferred list carries this too.)
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
  -- `deadline_at is not null` buys no PLAN -- MEASURED IN TASK 4, AGAINST THE
  -- QUERY AS IT STOOD THEN: `winners` alone, before the join to `draws` below
  -- existed. That join was added afterwards, in the review for Task 5 (see the
  -- paragraph below on the join), so what follows describes the winners side
  -- of what is now a join, not a plan for the joined query as it runs today --
  -- it has not been re-measured since the join was added, and no plan for the
  -- joined form is asserted here.
  --
  -- As measured then (a 250k-row replica, winners_deadline_idx's exact
  -- definition): the plan was IDENTICAL with and without this predicate --
  -- Index Scan using winners_deadline_idx, Index Cond: (deadline_at <= now())
  -- -- because Postgres proves the strict `<=` already implies `IS NOT NULL`
  -- on its own. (Control: dropping the STATUS predicate instead, which
  -- nothing implies, did fall back to a Seq Scan -- confirming this was real
  -- implication analysis and not the planner merely being indifferent to what
  -- a comment claims.) So the predicate was redundant to the planner and not
  -- load-bearing for anything about that plan -- a second performance claim
  -- in this comment turned out to be false the first time it was measured, so
  -- this one is stated only as far as it was actually checked, for the query
  -- shape it was checked against.
  --
  -- What it IS for, regardless of the join: it is harmless, it mirrors the
  -- partial index's own definition (0075) exactly, and it states 0075's rule
  -- in the query for a reader -- null means this winner has NO deadline at
  -- all, not a deadline of zero days.
  --
  -- Separately, and as measured in that same Task 4 run against the
  -- winners-only form: it was an ORDINARY index scan with a heap fetch per
  -- row, not an index-only one -- id, which the select list needs, is not a
  -- column the index carries. (The plan above, quoted from that measurement,
  -- said "Index Scan," not "Index Only Scan," which was the same fact
  -- independently.) Not re-checked against the joined query below.
  --
  -- THE JOIN TO draws AND `d.status <> 'CANCELLED'` ARE NOT OPTIONAL, and were
  -- added after this sweep shipped once already, in review. cancel_draw
  -- (0079) reverses a cancelled draw's winners from awaiting_pickup back to
  -- linked, but -- 6a had no vocabulary for "un-awarded" -- it leaves
  -- winners.status at AWAITING_PICKUP on purpose. Before this block existed
  -- that was inert: nothing read those rows as live. This sweep does, and
  -- without this join a cancelled draw's winner matches every clause above
  -- (AWAITING_PICKUP, a real deadline, overdue) while its actual unit already
  -- sits in linked, not awaiting_pickup. Both ways that goes are bad and NEITHER
  -- announces itself as this predicate's absence:
  --   * if nothing else holds a live unit of that prize, awaiting_pickup is 0
  --     and apply_inventory_movement's own balance CHECK refuses the move --
  --     caught by the handler below, counted as a failure, and this
  --     procedure's own end-of-loop raise (added for the cron.job_run_details
  --     finding) marks the hourly run failed. The winner never leaves
  --     AWAITING_PICKUP, so it is due again on every future run: not a
  --     one-off failure but a job that reports failed EVERY HOUR, FOREVER;
  --   * if some OTHER, genuinely live winner holds a real unit of the same
  --     prize, awaiting_pickup is positive and the move SUCCEEDS -- silently
  --     spending that live winner's unit against the cancelled draw's phantom
  --     row. winners.status transitions for the phantom (which owns no real
  --     unit); the balance is debited for a unit that, per the ledger, belongs
  --     to somebody else entirely. No exception, no WARNING, nothing in
  --     job_run_details -- the run reports success. The live winner's own row
  --     is untouched and still says AWAITING_PICKUP, but the aggregate balance
  --     no longer agrees, and the desync surfaces later, at delivery, looking
  --     like an unrelated failure with no link back to this sweep.
  -- Demonstrated by mutation while fixing this (temporarily dropping the join,
  -- reproducing each branch, restoring it) -- the report for the task that
  -- added this join has the reproduction and its output.
  select array_agg(w.id order by w.deadline_at)
    into v_ids
    from public.winners w
    join public.draws d on d.id = w.draw_id
   where w.status = 'AWAITING_PICKUP'
     and w.deadline_at is not null
     and w.deadline_at <= now()
     and d.status <> 'CANCELLED';

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
  'Moves every winner whose frozen pickup deadline has passed to RETURN_PENDING, and its unit from awaiting_pickup to pending_return, where it rests until an operator returns it or writes it off. Scheduled hourly; deadlines are day-grained so an hour of latency is the whole cost. Skips a null deadline_at, which means this winner has no deadline at all rather than one of zero days (0075). Skips a winner whose DRAW was cancelled too: cancel_draw (0079) reverses the unit back to linked but deliberately leaves winners.status at AWAITING_PICKUP, and without this exclusion such a winner either fails this sweep every hour forever (no live unit left to move) or, worse, silently spends a genuinely live winner''s unit on the same prize with no error at all -- both reproduced and recorded against the task that added this line. Re-running is safe and not because this is careful: apply_winner_transition refuses any source that is not AWAITING_PICKUP, so twice in an hour and once after a week of downtime give the same result. Commits after each winner so that one whose movement is refused cannot roll back every other Station''s expirations, then raises if any winner failed -- after every succeeded winner is already committed, so this destroys no work, and it exists only so cron.job_run_details can distinguish a clean run from one with real failures, which the per-winner WARNING alone cannot: that lands in the server log, not in job_run_details. Records no actor -- auth.uid() is null under pg_cron and all three actor columns are nullable -- which is honest: nobody did this, the deadline did.';

-- Owner-only: EXECUTE is revoked from public and granted to nobody else, the
-- convention this schema uses for every other SECURITY INVOKER writer. See
-- the header comment for why an earlier draft's grant to service_role was
-- wrong.
revoke execute on procedure public.sweep_pickup_deadlines() from public;

-- Only THIS PAIR is idempotent, not the whole file. Re-running the file
-- against a database where it has already applied fails first, at the
-- `create procedure` statement above --
--   ERROR: function "sweep_pickup_deadlines" already exists with same
--   argument types
-- -- measured directly against this project's own local container, twice
-- during review (report §5.9, runbook §2). `create procedure`, unlike
-- `create or replace procedure`, cannot be re-run once the procedure exists.
-- That failure does not corrupt anything and does not stop what follows: the
-- unschedule/schedule pair below, alone, IS written to be safely re-run --
-- unschedule-if-exists, then schedule, exactly as 0064 does -- so db:reset
-- (which only ever runs this file once, from empty) and a hosted redeploy
-- re-running it both leave the schedule correctly configured regardless of
-- the earlier error. What re-running this file can NOT do is change the
-- procedure's own body: that needs a NEW migration written as `create or
-- replace procedure`.
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
