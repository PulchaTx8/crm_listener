-- supabase/migrations/0063_whatsapp_worker_queue.sql
--
-- The queue routines the worker (Block 5a Task 12) drains both sides with.
-- None of them holds a rule about promotions, listeners or entries -- those are
-- ingest_whatsapp_event's (0062), one transaction per event. These answer only
-- "what is due", "give me the next batch and mark it mine", and "what was
-- claimed and abandoned", which is the whole of what a queue drainer is
-- allowed to know.
--
-- WHY THESE ARE FUNCTIONS AND NOT POSTGREST QUERIES IN THE WORKER, since the
-- rest of this application reads through PostgREST and a reader is entitled to
-- ask. Two reasons, and neither is style.
--
-- 1. webhook_events_pending (0058) is an index on the EXPRESSION
--    coalesce(next_attempt_at, received_at), and PostgREST's `order` takes
--    column names only -- an expression cannot be written there at all. The
--    nearest thing it can express is `order by received_at`, and that is not a
--    slower spelling of the same answer: it is a DIFFERENT ORDER. A row that
--    failed and was pushed a minute into the future keeps the received_at it
--    was born with, so under a backlog larger than one batch it goes on being
--    selected ahead of messages that arrived after it and have never been
--    tried. The freshest traffic starves behind the oldest failures, which is
--    the one shape of queue misbehaviour nobody notices until a promotion is
--    over.
--
-- 2. Claiming a batch has to be ONE statement. Selecting rows and then marking
--    them in a second round trip leaves a window in which another tick selects
--    the same rows -- and pg_cron fires on schedule whether or not the previous
--    tick has returned, while a full batch is fifty ingest calls plus fifty
--    HTTPS calls to Meta and is comfortably longer than ten seconds. Two ticks
--    overlapping is the NORMAL case under load, not an exotic one.

-- ---------------------------------------------------------------------------
-- 1. What is due, inbound.
--
-- The ORDER BY is the same expression webhook_events_pending is built on and
-- the WHERE repeats that index's partial predicate, so the index serves the
-- filter and the sort together and no Sort node is needed. Changing either half
-- without the other silently drops back to a sequential scan plus a sort.
--
-- There is no attempts cap here, and that is deliberate. A parked event is
-- parked by its next_attempt_at being INFINITY (the worker writes it), which
-- puts it beyond this function's index condition for ever and at the far end of
-- the index rather than the near one. A cap expressed as `attempts <
-- p_max_attempts` would have been a FILTER rather than an index condition, so
-- every tick would walk past every parked row -- which sorts FIRST under a null
-- next_attempt_at -- before reaching any due work, and that cost would grow
-- with the number of rows the system had given up on. Infinity costs nothing
-- and needs no constant repeated on both sides of the boundary.
--
-- This function does NOT claim. Inbound claiming belongs to
-- ingest_whatsapp_event, which takes the row FOR UPDATE SKIP LOCKED inside the
-- transaction that decides it (0062) -- so two ticks selecting the same event
-- is harmless, the loser simply gets outcome "skipped". The outbound side has
-- no such protection and gets its own claim below.
-- ---------------------------------------------------------------------------
create or replace function public.due_whatsapp_events(p_limit integer)
returns table (id uuid, attempts integer)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select e.id, e.attempts
  from public.webhook_events e
  where e.status in ('RECEIVED', 'FAILED')
    and coalesce(e.next_attempt_at, e.received_at) <= now()
  order by coalesce(e.next_attempt_at, e.received_at)
  limit p_limit;
$$;

revoke execute on function public.due_whatsapp_events(integer) from public;
grant execute on function public.due_whatsapp_events(integer) to service_role;

comment on function public.due_whatsapp_events(integer) is
  'The next events to ingest, oldest scheduled first. Ordered by coalesce(next_attempt_at, received_at) -- the expression webhook_events_pending (0058) is built on, and the reason this is a function rather than a PostgREST call: `order` there takes column names, and ordering by received_at instead is a different order, under which a row pushed into the future by a backoff outranks messages that arrived after it and starves fresh traffic behind old failures. Carries no attempts cap: a parked event is one whose next_attempt_at is infinity, which is beyond this index condition for ever and sits at the far end of the index, whereas a cap would be a filter every tick had to walk past every abandoned row to apply. Does not claim -- ingest_whatsapp_event takes the row FOR UPDATE SKIP LOCKED itself (0062), so two ticks selecting the same event costs the loser one "skipped". Reads a table with RLS on and no policy, so EXECUTE is service_role''s alone.';

-- ---------------------------------------------------------------------------
-- 2. The outbound batch, claimed in the act of being selected.
--
-- THE WHOLE POINT IS THAT THIS IS ONE STATEMENT. pg_net is fire-and-forget and
-- pg_cron fires on schedule regardless of whether the last tick returned, so
-- two ticks overlap whenever a batch takes longer than the interval -- which a
-- batch of fifty sequential HTTPS calls to Meta routinely does. With a plain
-- select, both ticks see the same PENDING rows with the same past
-- next_attempt_at in the same order, and both send. The listener receives the
-- reply twice, and dedupe_key cannot help: it stops a second ROW being
-- enqueued, not one row being SENT twice.
--
-- FOR UPDATE SKIP LOCKED inside the sub-select, so a second tick arriving mid
-- statement takes the NEXT rows rather than blocking on these. The UPDATE then
-- flips exactly the rows this statement locked and returns them: nothing
-- between the choosing and the marking, because there is no between.
--
-- attempts comes back UNCHANGED -- the count before this attempt, which is what
-- the worker's ladder needs. Claiming is not attempting.
--
-- LEFT JOIN, not an inner one, and the difference matters. integration_id is
-- NOT NULL with a foreign key so the join always finds its row, but an inner
-- join expresses "silently do not claim rows whose integration went missing",
-- which would strand them invisibly. Left-joined, a null phone_number_id comes
-- back to the worker, which parks the row with a reason somebody can read.
--
-- The final ORDER BY is not cosmetic: UPDATE ... RETURNING has no defined row
-- order, so without it "oldest first" becomes a claim nothing supports.
-- ---------------------------------------------------------------------------
create or replace function public.claim_outbox_batch(p_limit integer)
returns table (
  id              uuid,
  to_phone        text,
  body            text,
  attempts        integer,
  phone_number_id text
)
language sql
security definer
set search_path = pg_catalog, public
as $$
  with due as (
    select c.id
    from public.outbox_messages c
    where c.status = 'PENDING'
      and c.next_attempt_at <= now()
    order by c.next_attempt_at
    limit p_limit
    for update skip locked
  ),
  claimed as (
    update public.outbox_messages o
       set status = 'SENDING', claimed_at = now()
      from due
     where o.id = due.id
    returning o.id, o.to_phone, o.body, o.attempts, o.integration_id,
              o.next_attempt_at
  )
  select cl.id, cl.to_phone, cl.body, cl.attempts, i.phone_number_id
  from claimed cl
  left join public.integrations i on i.id = cl.integration_id
  order by cl.next_attempt_at;
$$;

revoke execute on function public.claim_outbox_batch(integer) from public;
grant execute on function public.claim_outbox_batch(integer) to service_role;

comment on function public.claim_outbox_batch(integer) is
  'The next messages to send, marked SENDING in the same statement that chooses them. One statement is the entire point: pg_cron fires on schedule whether or not the previous tick returned, and a batch of fifty sequential calls to Meta outlasts the interval, so two ticks overlap under ordinary load -- with a plain select both would see the same PENDING rows and the listener would be answered twice. dedupe_key does not cover this: it stops a second row being enqueued, not one row being sent twice. FOR UPDATE SKIP LOCKED so an overlapping tick takes the next batch instead of blocking on this one. Returns attempts UNCHANGED, because claiming is not attempting and the ladder counts sends. LEFT JOIN on integrations so a row whose number cannot be resolved comes back and is parked with a reason, rather than being silently never claimed. outbox_messages_claim_shape (0059) requires claimed_at with SENDING, and outbox_messages_sent_shape is untouched, because a SENDING row leaves sent_at and external_id null exactly as a non-SENT row must.';

-- ---------------------------------------------------------------------------
-- 3. What was claimed and abandoned, on both sides.
--
-- The two arms are NOT equally load-bearing, and saying so is the only way the
-- next reader can judge them.
--
-- OUTBOUND is real. A tick that dies between claim_outbox_batch above and the
-- settle write leaves a row committed in SENDING -- the claim is its own
-- statement and commits by itself -- and SENDING is outside that function's
-- predicate. Nothing else in this system would ever look at that row again.
-- This is the ordinary consequence of a serverless timeout, not a hypothetical.
--
-- INBOUND is insurance. Nothing in this repository commits a row in PROCESSING:
-- ingest_whatsapp_event (0062) sets it and then, in the SAME transaction,
-- either finishes the event as DONE or raises -- and a raise rolls the
-- PROCESSING write back with everything else, since that function contains no
-- EXCEPTION block and so no subtransaction that could survive one. A tick that
-- dies mid-batch strands nothing inbound; its transaction aborts and the event
-- is RECEIVED or FAILED again. What this arm covers is an operator moving a row
-- by hand -- 06_whatsapp's closing block does exactly that to re-run a finished
-- event, though it writes FAILED and not PROCESSING, so it is the shape of the
-- case rather than an instance of it -- and any later design that commits the
-- claim in one transaction and does the work in another, which is what a second
-- worker or a pgmq migration would be.
--
-- MEASURED AGAINST claimed_at, NEVER AGAINST received_at OR next_attempt_at,
-- and those columns (0058, 0059) exist for this line alone. The other two say
-- when the message ARRIVED and when the row became SENDABLE; neither says
-- anything about how long a claim has been open. Predicated on them, a
-- backlogged row would be eligible for reclaim the instant it was claimed, and
-- this function would take work away from a live worker exactly when a backlog
-- made that least affordable. claim_shape on both tables makes claimed_at
-- non-null wherever a claim exists, so there is no coalesce here and no
-- fallback that could quietly restore the bug.
--
-- FOR UPDATE SKIP LOCKED on both arms, and it is not decoration. It stops a
-- reclaim stealing a row a live worker holds -- and, at least as important,
-- stops it BLOCKING on one. A plain UPDATE queues behind the lock, so the exact
-- failure this function exists to survive (a worker wedged mid-row) would hang
-- every following tick on its first statement, turning a stalled message into a
-- stalled queue.
--
-- A reclaim is not a failure: attempts, last_error and next_attempt_at are left
-- exactly as they were on both sides, so it neither burns a retry nor writes
-- our own bookkeeping over a real error message.
--
-- THE RESIDUAL, STATED RATHER THAN DISCOVERED. Returning an abandoned SENDING
-- row to PENDING can re-send a message Meta already accepted, if the tick died
-- between Meta's 200 and the settle write. That is at-least-once and cannot be
-- closed from here -- only a provider-side idempotency key would close it, and
-- the Cloud API offers none for text sends. The alternative, parking such a row
-- instead, trades a listener occasionally told twice for a listener sometimes
-- entered and never told, which design spec D7 exists to prevent. Told twice is
-- the better failure, and this is a deliberate choice of it.
-- ---------------------------------------------------------------------------
create or replace function public.reclaim_stale_whatsapp_claims(
  p_stale_after interval default '5 minutes')
returns table (events integer, messages integer)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_events   integer;
  v_messages integer;
begin
  with stale as (
    select e.id
    from public.webhook_events e
    where e.status = 'PROCESSING'
      and e.claimed_at < now() - p_stale_after
    for update skip locked
  )
  update public.webhook_events t
     set status = 'RECEIVED'
    from stale
   where t.id = stale.id;
  get diagnostics v_events = row_count;

  with stale as (
    select o.id
    from public.outbox_messages o
    where o.status = 'SENDING'
      and o.claimed_at < now() - p_stale_after
    for update skip locked
  )
  update public.outbox_messages t
     set status = 'PENDING'
    from stale
   where t.id = stale.id;
  get diagnostics v_messages = row_count;

  if v_events > 0 or v_messages > 0 then
    -- Counts only, never a payload field: webhook_events holds a phone number
    -- and a WhatsApp profile name (0058), outbox_messages holds the recipient,
    -- and a log line is not a place any of them belongs.
    raise log 'reclaim_stale_whatsapp_claims: % event(s) and % message(s) returned to the queue',
      v_events, v_messages;
  end if;

  return query select v_events, v_messages;
end;
$$;

revoke execute on function public.reclaim_stale_whatsapp_claims(interval) from public;
grant execute on function public.reclaim_stale_whatsapp_claims(interval) to service_role;

comment on function public.reclaim_stale_whatsapp_claims(interval) is
  'Returns abandoned claims to their queues, on both sides. The outbound arm is load-bearing: a tick that dies between claim_outbox_batch and the settle write leaves a row committed in SENDING, outside that function''s predicate, so nothing else would ever look at it again -- an ordinary serverless timeout, not a hypothetical. The inbound arm is insurance: nothing here commits a row in PROCESSING, because ingest_whatsapp_event (0062) sets it and finishes or raises in the same transaction and holds no EXCEPTION block, so a dying tick strands nothing; it covers an operator moving a row by hand and any later design that commits a claim separately. Measured against claimed_at and never against received_at or next_attempt_at -- those say when the message arrived and when the row became sendable, neither of which is the age of a CLAIM, and predicated on them a backlogged row would be reclaimable the instant it was claimed. FOR UPDATE SKIP LOCKED so a reclaim can neither steal a row a live worker holds nor block behind its lock, which would turn one wedged row into a wedged queue. Leaves attempts, last_error and next_attempt_at untouched, because a reclaim is not a failure. RESIDUAL, deliberate: returning a SENDING row can re-send a message Meta already accepted, if the tick died between Meta''s 200 and the settle write -- at-least-once, closable only by a provider idempotency key the Cloud API does not offer for text. Parking instead would trade a listener told twice for a listener entered and never told, which design spec D7 exists to prevent.';

-- Both reclaim arms scan on a status their table's main index does not cover,
-- every ten seconds, for ever. Without these that is two sequential scans of
-- growing tables per tick, spent on a question whose answer is almost always
-- "none". Partial on the claimed status and keyed on the column the age
-- comparison actually uses, so each is normally EMPTY -- nothing to keep and
-- nothing to maintain, since a row enters and leaves inside one claim.
create index webhook_events_processing
  on public.webhook_events (claimed_at) where status = 'PROCESSING';
create index outbox_messages_sending
  on public.outbox_messages (claimed_at) where status = 'SENDING';
