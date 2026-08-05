-- supabase/migrations/0112_sweep_pickup_reminders.sql

-- Block Templates, Task 4: the sweep that finally speaks.
--
-- Block 6d's own report, §5.1, says it plainly: "Nothing notifies anybody."
-- sweep_pickup_deadlines (0094) moves a winner's prize back to stock in
-- silence -- a winner is never told the clock is running, because a message
-- sent days after a draw falls outside WhatsApp's 24-hour session window and
-- Meta accepts it only as an approved template. Tasks 1-3 built that path
-- (the registry, the outbox columns, the resolving enqueue). This is the
-- first caller that ever walks it.
--
-- Two routines. enqueue_pickup_reminder resolves ONE winner and enqueues ONE
-- template send; sweep_pickup_reminders finds every winner due for one and
-- calls it in a loop that commits per winner. The second is 0094's sibling
-- and MUST MATCH ITS SHAPE: a procedure, because only a procedure may commit,
-- and it must commit per winner for the identical reason 0094 gives -- the
-- sweep is global, every Station in the installation, and one winner whose
-- enqueue is refused (a Station with no registered template, say) must not
-- roll back every other Station's reminders, every hour, for ever.

-- ---------------------------------------------------------------------------
-- 1. enqueue_pickup_reminder(p_winner_id). SECURITY DEFINER, unlike 0094's
-- apply_winner_transition/sweep_pickup_deadlines pair (both SECURITY
-- INVOKER): this function's whole job is to call enqueue_whatsapp_outbound,
-- which is granted to service_role and nobody else (0111). Declaring this
-- function SECURITY DEFINER means it runs as ITS OWN OWNER for the duration
-- of the call -- the same role that owns enqueue_whatsapp_outbound, because
-- one migration role creates both -- so the nested call resolves on
-- ownership rather than on a grant that would otherwise have to be reissued
-- to whatever role ends up invoking the sweep. `set search_path` is safe and
-- required here for the reason 0094's header gives for withholding it from
-- the PROCEDURE: a function (unlike a procedure that commits) carries no
-- restriction against it, and this one runs SECURITY DEFINER, where an
-- unpinned search_path is exactly the redirection hazard pinning exists to
-- close.
-- ---------------------------------------------------------------------------

create function public.enqueue_pickup_reminder(p_winner_id uuid)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_company     uuid;
  v_timezone    text;
  v_deadline    timestamptz;
  v_prize_name  text;
  v_full_name   text;
  v_phone       text;
  v_integration uuid;
  v_first_name  text;
  v_deadline_local text;
begin
  -- Re-validated here, not merely trusted from the sweep's own candidate
  -- list: the list is collected once and walked afterwards (0094's own
  -- rule, restated in sweep_pickup_reminders below), so a winner delivered,
  -- or a listener anonymised, in the gap between collection and this call
  -- must be caught HERE rather than mailed anyway. `m.anonymized_at is null`
  -- is the same exclusion searchStationListeners and create_music_request
  -- (0107) both carry: anonymize_member (0034) nulls full_name, and a
  -- reminder addressed to nobody is not a lesser reminder, it is the exact
  -- thing erasure exists to prevent.
  select w.company_id, c.timezone, w.deadline_at, pz.name, m.full_name, m.phone_normalized
    into v_company, v_timezone, v_deadline, v_prize_name, v_full_name, v_phone
    from public.winners w
    join public.companies c on c.id = w.company_id
    join public.promotion_prizes pp on pp.id = w.promotion_prize_id
    join public.prizes pz on pz.id = pp.prize_id
    join public.members m on m.id = w.member_id
   where w.id = p_winner_id
     and w.status = 'AWAITING_PICKUP'
     and m.deleted_at is null
     and m.anonymized_at is null;

  if not found then
    raise exception 'winner not found, not awaiting pickup, or listener anonymised: %', p_winner_id
      using errcode = 'P0002';
  end if;

  -- The Station's own enabled WhatsApp number. Not passed in: a caller could
  -- otherwise name an integration belonging to a different Station than the
  -- winner's own, which enqueue_whatsapp_outbound has no way to catch since
  -- it trusts the integration id it is given.
  select id into v_integration
    from public.integrations
   where company_id = v_company
     and provider = 'WHATSAPP'
     and enabled
     and deleted_at is null;

  if not found then
    raise exception 'no enabled whatsapp integration for station %', v_company
      using errcode = 'P0002';
  end if;

  -- members.phone is nullable (0031) -- a listener entered by hand, with no
  -- WhatsApp session ever opened, can hold none. Raising here turns that
  -- into a per-winner skip inside the sweep's own exception block rather
  -- than a NOT NULL violation on outbox_messages surfacing three calls deep.
  if v_phone is null then
    raise exception 'listener has no phone on file: winner %', p_winner_id
      using errcode = 'P0002';
  end if;

  -- First name, not the full one, because this is a message a person reads
  -- and not a record (0110's own comment on the template makes the same
  -- choice for {{1}}). btrim before split_part so a name entered with
  -- leading whitespace still splits on its own first word rather than an
  -- empty one.
  v_first_name := split_part(btrim(v_full_name), ' ', 1);

  -- THE TIMEZONE, load-bearing rather than a detail (spec L2): the deadline
  -- is read and formatted in the STATION'S OWN zone, the identical
  -- `at time zone` idiom whatsapp_reply_body (0062) already uses to render a
  -- Station's local clock rather than the server's. DD/MM/YYYY: the body is
  -- Portuguese, like every other string a listener reads (0110), and this is
  -- the ordinary written date order in pt_BR.
  v_deadline_local := to_char(v_deadline at time zone v_timezone, 'DD/MM/YYYY');

  -- THE CONTRACT (task brief table): {{1}} first name, {{2}} prize name,
  -- {{3}} the deadline in the Station's zone -- the order an operator's
  -- registered template must match. p_body and p_interactive are both null:
  -- this is a template send, and enqueue_whatsapp_outbound renders the body
  -- itself from the registry (D6, 0111). The dedupe key needs no hashing,
  -- unlike the confirmation keys 0059 describes at length -- a winner id is
  -- not a phone number, and dedupe_key is never pruned -- so the winner id
  -- is used bare.
  return public.enqueue_whatsapp_outbound(
    v_integration, v_phone, null, null,
    'pickup-reminder:' || p_winner_id,
    'PICKUP_REMINDER'::public.template_purpose,
    jsonb_build_array(v_first_name, v_prize_name, v_deadline_local));
end;
$$;

comment on function public.enqueue_pickup_reminder(uuid) is
  'Resolves one AWAITING_PICKUP winner -- Station, enabled WhatsApp integration, listener''s first name and phone, prize name and the deadline -- and enqueues a PICKUP_REMINDER template send through enqueue_whatsapp_outbound (0111), which resolves the Station''s own registered template, validates the variable count and renders the audit body. The three variables are positional and load-bearing: {{1}} first name, {{2}} prize name, {{3}} the deadline as a date in the STATION''S OWN timezone (companies.timezone, spec L2) -- the same `at time zone` idiom whatsapp_reply_body (0062) already uses, because a reminder naming tomorrow when the Station means the day after is the one error this message cannot survive. Re-validates AWAITING_PICKUP and the listener''s anonymisation state itself rather than trusting sweep_pickup_reminders'' own candidate list, which is collected once and walked afterwards. Raises P0002 for a winner that is no longer eligible, for a Station with no enabled WhatsApp integration, or for a listener with no phone on file -- all three are caught by the sweep''s own per-winner exception block and never abort a batch. SECURITY DEFINER so its call into enqueue_whatsapp_outbound resolves on ownership rather than a grant; owner-only, called only from sweep_pickup_reminders below.';

revoke execute on function public.enqueue_pickup_reminder(uuid) from public;

-- ---------------------------------------------------------------------------
-- 2. sweep_pickup_reminders(). 0094's sibling, matched to its shape exactly:
-- a PROCEDURE, and NEITHER `security definer` NOR a function-level
-- `set search_path` -- 0094's header proves, by isolated bisection against
-- this project's own Postgres, that either attribute makes a procedure's own
-- COMMIT raise "invalid transaction termination", independent of the loop
-- body. The candidate list is collected FIRST, into an array, and only then
-- walked -- 0094's own rule, and the reason is the same: no cursor is held
-- across a commit, and the list being microseconds stale by the time it is
-- walked is safe because enqueue_pickup_reminder re-reads and re-validates,
-- and the dedupe key refuses a repeat.
--
-- SECURITY INVOKER carries the same standing hazard 0094's header records
-- for winners: every table this candidate query touches has
-- relforcerowsecurity = false, so it already sees every row regardless of
-- RLS policy. Owner-only EXECUTE, for the identical reason 0094 gives: pg_cron
-- runs a scheduled job as the role that called cron.schedule() -- the
-- migration-running role, owner of enqueue_pickup_reminder and everything
-- beneath it -- so SECURITY INVOKER already carries the privilege the loop
-- body needs, and a grant to service_role would fail every winner
-- (service_role holds nothing on enqueue_pickup_reminder) while still
-- reporting a clean run.
--
-- NOT SCHEDULED THROUGH src/app/api/worker/tick/route.ts, and not folded
-- into runTick's ten-second loop either -- 0094's own reasoning for
-- sweep_pickup_deadlines applies here without needing to be re-argued:
-- no HTTP and no application code in the path, so a Station's reminders do
-- not depend on the Next.js worker process being reachable, only on
-- Postgres itself. What this sweep enqueues is picked up and actually SENT
-- by the ordinary outbox drain that already runs every ten seconds
-- (claim_outbox_batch, 0063/0111) -- that half of the pipeline needs no new
-- wiring, because a template row is, to that drain, an outbox row like any
-- other. See the comment this task adds beside runTick's own doc block in
-- route.ts for where a future reader will look for this and the pointer
-- back here.
create procedure public.sweep_pickup_reminders()
language plpgsql
as $$
declare
  v_ids     uuid[];
  v_id      uuid;
  v_failed  integer := 0;
begin
  -- Candidate set (task brief, D8's own window shape): AWAITING_PICKUP, the
  -- draw not CANCELLED -- Blocks 6c and 6d each lost this exclusion once
  -- (0075, 0094's own headers) -- a deadline still in the future, no more
  -- than two days out, and the listener neither soft-deleted nor anonymised.
  -- The anonymisation predicate is enforced HERE, at collection, rather than
  -- left solely to enqueue_pickup_reminder's own re-check: an anonymised
  -- listener is never even handed to the loop below, which is what keeps it
  -- out of the exception-handler path a missing template takes instead.
  --
  -- ORDER BY w.id (fix round 1): array_agg with no ORDER BY has no defined
  -- walk order, which made the sweep's own non-abort behaviour depend on
  -- which candidate the planner happened to visit first -- a test asserting
  -- "Station A's winner survives Station B's failure" is only proving that
  -- if the failing candidate is actually walked before the surviving one.
  -- Costs nothing and makes the walk order reproducible run to run.
  select coalesce(array_agg(w.id order by w.id), '{}') into v_ids
    from public.winners w
    join public.draws d on d.id = w.draw_id
    join public.members m on m.id = w.member_id
   where w.status = 'AWAITING_PICKUP'
     and d.status <> 'CANCELLED'
     and w.deadline_at > now()
     and w.deadline_at <= now() + interval '2 days'
     and m.deleted_at is null
     and m.anonymized_at is null;

  foreach v_id in array v_ids loop
    begin
      perform public.enqueue_pickup_reminder(v_id);
    exception when others then
      -- Per winner, on purpose -- the opposite of Block 7b's atomic merge,
      -- for the opposite reason: an unattended sweep must not let one bad
      -- row (a Station with no registered template, say) stop every other
      -- Station's reminders, where one operator pressing one button must not
      -- get half a merge. A Station with no registered template lands here
      -- and the sweep continues.
      --
      -- v_failed AND raise warning ... sqlerrm (fix round 1): 0094's own
      -- header explains why a WARNING is the only place this can be seen at
      -- all -- cron.job_run_details records status=succeeded for a CALL in
      -- which every single winner failed, because RAISE WARNING lands in the
      -- Postgres server log and never reaches that table. A bare `null`
      -- here, this migration's own first draft, meant a Station that
      -- registers its template with the wrong placeholder count fails
      -- 22023 every hour, forever, with no line anywhere -- exactly the
      -- silent failure Block 6d's report called out and this block exists
      -- to end. Deliberately NOT followed by 0094's own terminal
      -- `raise exception when v_failed > 0`: that raise is what makes 0094's
      -- own per-winner durability provable under pgTAP (12b's poison
      -- fixture), but this procedure's test fixture deliberately contains a
      -- failing candidate (the no-template Station) on every run, and a
      -- terminal raise would abort the bare top-level CALL pgTAP issues,
      -- taking every assertion after it down too. The per-winner WARNING is
      -- the whole of the fix this round asked for; the terminal raise is
      -- explicitly out of scope.
      v_failed := v_failed + 1;
      raise warning 'pickup reminder sweep failed for winner %: %', v_id, sqlerrm;
    end;
    -- OUTSIDE the exception block on purpose -- 0094's own rule, restated
    -- because this migration hit its exact failure mode while being
    -- written: a COMMIT placed INSIDE a begin/exception/end block raises
    -- "cannot commit while a subtransaction is active" (2D000), because the
    -- presence of an EXCEPTION clause makes the block itself a
    -- subtransaction. Placed there once, by mistake, while drafting this
    -- file: the raised 2D000 was caught by the very block it occurred in,
    -- and an earlier draft's explicit ROLLBACK in the handler undid the
    -- winner's already-successful enqueue along with it -- a caught error
    -- silently erasing a real success. Moving COMMIT here, matching 0094
    -- exactly, is what fixed it; no explicit ROLLBACK belongs in the handler
    -- either way, because the EXCEPTION clause already rolls the block back
    -- to its own implicit savepoint on the way in.
    commit;
  end loop;

  -- Informational only -- NOTICE, never EXCEPTION, for the reason directly
  -- above. Nothing but pg_cron calls this, and cron.job_run_details stores
  -- only the CALL's own completion status; this line exists for whoever
  -- reads the server log directly, the same audience the per-winner WARNING
  -- above is for.
  raise notice 'pickup reminder sweep: % of % candidate(s) failed', v_failed, coalesce(array_length(v_ids, 1), 0);
end;
$$;

comment on procedure public.sweep_pickup_reminders() is
  'Enqueues a PICKUP_REMINDER template send for every winner whose frozen deadline is due within the next two days and not yet passed. Candidate set: AWAITING_PICKUP, the draw not CANCELLED, deadline_at strictly between now() and now() + 2 days, and the listener neither soft-deleted nor anonymised -- collected in id order so the walk is reproducible. Scheduled directly through pg_cron, the same shape as its sibling sweep_pickup_deadlines (0094) and for the identical reasons stated there: no HTTP, no application code in the path, and not folded into the WhatsApp worker''s ten-second tick. Commits after each winner, inside a per-winner exception block, so a Station with no registered template -- or any other single failure -- cannot abort reminders for every other Station in the installation. Every per-winner failure is named in a WARNING (winner id and SQLERRM), because cron.job_run_details records only the CALL''s own completion status and cannot otherwise tell a clean run from one where every winner failed (0094''s own finding); deliberately carries NO terminal raise-if-any-failed the way 0094 does, because that raise is 0094''s only route to marking a run failed in job_run_details and this procedure accepts a coarser signal (the server log alone) in exchange for never aborting mid-batch on a candidate set that, unlike expired deadlines, is expected to contain unregistered Stations routinely. Re-running is safe: enqueue_pickup_reminder re-validates AWAITING_PICKUP before enqueuing, and enqueue_whatsapp_outbound''s own dedupe_key refuses a repeat for a winner already reminded. Records no actor -- auth.uid() is null under pg_cron -- which is honest: nobody did this, the clock did.';

revoke execute on procedure public.sweep_pickup_reminders() from public;

-- Standard five-field cron, matching 0094's own choice over the '1 hour'
-- interval form pg_cron's newer versions accept: hourly work needs no note
-- about which pg_cron version understands the schedule.
select cron.unschedule('pickup-reminder-sweep')
where exists (select 1 from cron.job where jobname = 'pickup-reminder-sweep');

select cron.schedule(
  'pickup-reminder-sweep',
  '0 * * * *',
  $$ call public.sweep_pickup_reminders(); $$
);
