-- supabase/migrations/0063_whatsapp_worker_queue.sql
--
-- The two selection routines the worker (Block 5a Task 12) drains its inbound
-- queue with. Neither holds any rule about promotions, listeners or entries --
-- those are ingest_whatsapp_event's (0062), one transaction per event. These
-- answer only "which events are due" and "which claimed events were
-- abandoned", which is the whole of what a queue drainer is allowed to know.
--
-- WHY THIS IS SQL AND NOT A POSTGREST QUERY IN THE WORKER, since the rest of
-- this application reads through PostgREST and a reader is entitled to ask.
-- webhook_events_pending (0058) is an index on the EXPRESSION
-- coalesce(next_attempt_at, received_at), and PostgREST's `order` takes column
-- names only -- an expression cannot be written there at all. The nearest
-- thing it can express is `order by received_at`, and that is not merely a
-- slower spelling of the same answer: it is a DIFFERENT ORDER. A row that has
-- failed and been pushed a minute into the future keeps the received_at it was
-- born with, so under a backlog larger than one batch it goes on being
-- selected ahead of messages that arrived after it and have never been tried.
-- The freshest traffic starves behind the oldest failures, which is the one
-- shape of queue misbehaviour nobody notices until a promotion is over.

-- ---------------------------------------------------------------------------
-- 1. What is due.
--
-- The ORDER BY is the same expression webhook_events_pending is built on, and
-- the WHERE repeats that index's partial predicate, so the index serves both
-- the filter and the sort and no Sort node is needed. Changing either half
-- without the other silently drops back to a sequential scan plus a sort.
--
-- p_max_attempts is the worker's number, passed in rather than written here,
-- for the same reason the batch size is: the retry ladder is a property of the
-- drainer and swapping this loop for pgmq must not have to edit SQL. What this
-- function owns is the QUERY; what the caller owns is the POLICY.
--
-- AND THE ATTEMPTS FILTER IS NOT OPTIONAL. Parking an inbound event is not
-- like parking an outbound one: outbox_messages_sendable (0059) excludes
-- FAILED, so a spent outbox row leaves the sendable set by itself, but
-- webhook_events_pending deliberately INCLUDES FAILED -- inbound FAILED means
-- "try again" (0058). A spent event therefore stays in the pending set for
-- ever, and with next_attempt_at back to null its coalesce falls to
-- received_at, which is in the past, so it is due on every single tick from
-- now until somebody deletes it. That is precisely the "permanently unroutable
-- message gets retried forever" that 0058's own type comment warns about. The
-- filter here and the null written by the worker only work as a pair.
-- ---------------------------------------------------------------------------
create or replace function public.due_whatsapp_events(
  p_limit        integer,
  p_max_attempts integer
)
returns table (id uuid, attempts integer)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select e.id, e.attempts
  from public.webhook_events e
  where e.status in ('RECEIVED', 'FAILED')
    and e.attempts < p_max_attempts
    and coalesce(e.next_attempt_at, e.received_at) <= now()
  order by coalesce(e.next_attempt_at, e.received_at)
  limit p_limit;
$$;

revoke execute on function public.due_whatsapp_events(integer, integer) from public;
grant execute on function public.due_whatsapp_events(integer, integer) to service_role;

comment on function public.due_whatsapp_events(integer, integer) is
  'The next events to ingest, oldest scheduled first. Ordered by coalesce(next_attempt_at, received_at) -- the expression webhook_events_pending (0058) is built on, and the reason this is a function rather than a PostgREST call: `order` there takes column names, and ordering by received_at instead is a different order, under which a row pushed into the future by a backoff keeps outranking messages that arrived after it and starves fresh traffic behind old failures. Excludes rows whose attempts have reached the caller''s cap, without which a spent event never leaves the pending set: inbound FAILED means "try again" (0058) and a parked row carries next_attempt_at null, so its coalesce falls back to a received_at in the past and it is due on every tick for ever. The cap and the batch size are both the worker''s numbers, passed in, because the retry policy belongs to the drainer and not to this query. Reads a table with RLS on and no policy, so EXECUTE is service_role''s alone.';

-- ---------------------------------------------------------------------------
-- 2. What was claimed and abandoned.
--
-- READ THIS BEFORE BELIEVING THE FUNCTION IS LOAD-BEARING TODAY. Nothing in
-- this repository commits a row in PROCESSING. ingest_whatsapp_event (0062)
-- sets PROCESSING and then, in the SAME transaction, either finishes the event
-- as DONE or raises -- and a raise rolls the PROCESSING write back with
-- everything else, which 0062's own comment says in as many words. A tick that
-- dies mid-batch does not strand anything: its transaction aborts and the
-- event is RECEIVED or FAILED again, exactly as it was. Until that changes,
-- PROCESSING is a status no other session can ever observe, and this function
-- finds nothing.
--
-- What it is for is the two cases that ARE reachable. An operator who moves a
-- row by hand -- 06_whatsapp's last block does exactly that to re-run an event
-- -- can leave one here. And any future change that commits a claim in one
-- transaction and does the work in another (a second worker, a pgmq migration,
-- a claim endpoint) makes it the normal failure mode rather than an accident.
-- A row left in PROCESSING is outside webhook_events_pending's predicate and
-- outside due_whatsapp_events above: NO other query in this system looks for
-- it, so without this it is a message silently lost, which is the one outcome
-- this whole block exists to prevent. Cheap insurance against a state we can
-- reach today only by hand and will reach by design later.
--
-- FOR UPDATE SKIP LOCKED, and it is not decoration. Under the future shape
-- above it is what stops a reclaim from stealing a row a live worker is
-- holding -- and, at least as important, from BLOCKING on one. A plain UPDATE
-- queues behind the lock, so the exact failure this function exists to survive
-- (a worker wedged mid-event) would hang every following tick on its first
-- statement, turning a stalled message into a stalled queue.
--
-- Returns to RECEIVED and not to FAILED: both are in webhook_events_pending,
-- so either would be picked up, and RECEIVED is the honest one -- nothing has
-- failed, we simply never heard back. attempts, last_error and next_attempt_at
-- are left exactly as they were, so a reclaim neither burns a retry nor
-- overwrites a real error message with a description of our own bookkeeping;
-- the count comes back to the caller and is logged here.
-- ---------------------------------------------------------------------------
create or replace function public.reclaim_stale_whatsapp_events(
  p_stale_after interval default '5 minutes')
returns integer
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_count integer;
begin
  with stale as (
    select e.id
    from public.webhook_events e
    where e.status = 'PROCESSING'
      and coalesce(e.next_attempt_at, e.received_at) < now() - p_stale_after
    for update skip locked
  )
  update public.webhook_events t
     set status = 'RECEIVED'
    from stale
   where t.id = stale.id;

  get diagnostics v_count = row_count;

  if v_count > 0 then
    -- Ids only, never a payload field: this table holds a phone number and a
    -- profile name (0058) and a log line is not a place either belongs.
    raise log 'reclaim_stale_whatsapp_events: returned % abandoned event(s) to RECEIVED', v_count;
  end if;

  return v_count;
end;
$$;

revoke execute on function public.reclaim_stale_whatsapp_events(interval) from public;
grant execute on function public.reclaim_stale_whatsapp_events(interval) to service_role;

comment on function public.reclaim_stale_whatsapp_events(interval) is
  'Returns events abandoned in PROCESSING to RECEIVED so they are picked up again. Nothing in this repository commits a row in PROCESSING today -- ingest_whatsapp_event (0062) sets it and finishes or raises inside the same transaction, and a raise rolls it back -- so a tick that dies mid-batch strands nothing and this normally finds none. It exists for the two reachable cases: an operator moving a row by hand, and any later design that commits the claim and does the work in different transactions, which is what a second worker or a pgmq migration would be. A row left in PROCESSING falls outside webhook_events_pending (0058) and outside due_whatsapp_events, so no other query in this system would ever look at it again. FOR UPDATE SKIP LOCKED so a reclaim can neither steal a row a live worker holds nor block behind its lock -- a plain UPDATE would make one wedged event wedge every subsequent tick. Leaves attempts, last_error and next_attempt_at untouched: a reclaim is not a failure and must not burn a retry or overwrite a real error.';

-- The reclaim runs on every tick, which is every ten seconds, for ever. Without
-- an index that is a sequential scan of a table that only grows, spent on a
-- question whose answer is almost always "none". Partial on the status the
-- reclaim asks about, so the index is normally EMPTY: it costs nothing to keep
-- and nothing to maintain, since a row enters and leaves it inside one
-- transaction. Indexed on the same expression as webhook_events_pending so the
-- age comparison is served by it too and not just the status test.
create index webhook_events_processing
  on public.webhook_events (coalesce(next_attempt_at, received_at))
  where status = 'PROCESSING';
