begin;
select plan(20);

-- The worker's two selection routines (0063). Everything here is about WHICH
-- rows come back and in WHAT ORDER -- there is no promotion, no listener and
-- no entry in this file, which is the point: the drainer knows nothing about
-- them, and 06_whatsapp is where the deciding is tested.

create or replace function pg_temp.hash64(p_text text)
returns text language sql immutable as $$
  select encode(sha256(convert_to(p_text, 'UTF8')), 'hex');
$$;

select has_function('public', 'due_whatsapp_events',
                    array['integer', 'integer'], 'the due-events query exists');
select has_function('public', 'reclaim_stale_whatsapp_events',
                    array['interval'], 'the reclaim exists');

-- Both read and write a table with RLS on and no policy. EXECUTE is
-- service_role's alone, the shape 0058's prune_webhook_payloads already takes.
select ok(not has_function_privilege('authenticated',
            'public.due_whatsapp_events(integer, integer)', 'EXECUTE'),
          'authenticated may not ask what is due');
select ok(not has_function_privilege('authenticated',
            'public.reclaim_stale_whatsapp_events(interval)', 'EXECUTE'),
          'authenticated may not reclaim');
select ok(has_function_privilege('service_role',
            'public.due_whatsapp_events(integer, integer)', 'EXECUTE'),
          'the worker may ask what is due');
select ok(has_function_privilege('service_role',
            'public.reclaim_stale_whatsapp_events(interval)', 'EXECUTE'),
          'the worker may reclaim');

-- The reclaim scans on status, which webhook_events_pending (0058) does not
-- cover, and it runs every ten seconds for ever. Without this index that is a
-- sequential scan of a growing table on every tick.
select has_index('public', 'webhook_events', 'webhook_events_processing',
                 'PROCESSING has an index of its own to be found through');

-- Ordering ------------------------------------------------------------------
--
-- THE FIXTURE IS THE ASSERTION. These three rows are laid out so that ordering
-- by received_at -- which is what a PostgREST query can express, and what the
-- brief this task started from actually wrote -- produces a DIFFERENT sequence
-- from ordering by coalesce(next_attempt_at, received_at), the expression
-- webhook_events_pending is built on. Rows whose two columns agree cannot tell
-- the two apart, so a test built from them would pass either way.
--
--   E1  received 3h ago, retried at 1 minute ago   -> due -1m   (received FIRST)
--   E2  received 1h ago, never retried             -> due -1h
--   E3  received 2m ago, never retried             -> due -2m
--
-- by received_at:  E1, E2, E3
-- by coalesce:     E2, E3, E1
insert into public.webhook_events
  (id, provider, external_id, status, attempts, received_at, next_attempt_at)
values
  ('00000000-0000-0000-0000-0000000006e1', 'WHATSAPP', pg_temp.hash64('e1'),
   'FAILED', 1, now() - interval '3 hours', now() - interval '1 minute'),
  ('00000000-0000-0000-0000-0000000006e2', 'WHATSAPP', pg_temp.hash64('e2'),
   'RECEIVED', 0, now() - interval '1 hour', null),
  ('00000000-0000-0000-0000-0000000006e3', 'WHATSAPP', pg_temp.hash64('e3'),
   'RECEIVED', 0, now() - interval '2 minutes', null);

select is(
  (select array_agg(d.id) from public.due_whatsapp_events(10, 6) d),
  array['00000000-0000-0000-0000-0000000006e2',
        '00000000-0000-0000-0000-0000000006e3',
        '00000000-0000-0000-0000-0000000006e1']::uuid[],
  'due events come back in coalesce(next_attempt_at, received_at) order, which is not received_at order');

select is(
  (select d.attempts from public.due_whatsapp_events(10, 6) d
    where d.id = '00000000-0000-0000-0000-0000000006e1'),
  1,
  'and carry their attempts, so a failure can be scheduled without a second read');

-- Eligibility ---------------------------------------------------------------

insert into public.webhook_events
  (id, provider, external_id, status, attempts, received_at, next_attempt_at)
values
  -- Backed off into the future: eligible later, not now.
  ('00000000-0000-0000-0000-0000000006e4', 'WHATSAPP', pg_temp.hash64('e4'),
   'FAILED', 2, now() - interval '1 day', now() + interval '1 minute'),
  -- Claimed. Not due, whatever its age.
  ('00000000-0000-0000-0000-0000000006e5', 'WHATSAPP', pg_temp.hash64('e5'),
   'PROCESSING', 1, now() - interval '1 day', null);

insert into public.webhook_events
  (id, provider, external_id, status, attempts, received_at, outcome, processed_at)
values
  -- Decided. webhook_events_done_shape (0058) makes DONE carry both of these.
  ('00000000-0000-0000-0000-0000000006e6', 'WHATSAPP', pg_temp.hash64('e6'),
   'DONE', 1, now() - interval '1 day', 'recorded', now() - interval '1 day');

select is(
  (select count(*)::int from public.due_whatsapp_events(10, 6) d
    where d.id in ('00000000-0000-0000-0000-0000000006e4',
                   '00000000-0000-0000-0000-0000000006e5',
                   '00000000-0000-0000-0000-0000000006e6')),
  0,
  'a future next_attempt_at, a claimed row and a decided row are all not due');

select is(
  (select count(*)::int from public.due_whatsapp_events(2, 6) d),
  2, 'the batch cap is the caller''s and is honoured');

-- Parking -------------------------------------------------------------------
--
-- The half of parking that lives here. The worker writes next_attempt_at null
-- when the ladder is spent, and on the INBOUND side that is not enough on its
-- own: FAILED stays in webhook_events_pending on purpose (0058 -- inbound
-- FAILED means "try again"), and a null next_attempt_at makes coalesce fall
-- back to a received_at that is always in the past. Without the attempts cap
-- the row below is due on every tick from now until somebody deletes it.
insert into public.webhook_events
  (id, provider, external_id, status, attempts, last_error, received_at, next_attempt_at)
values
  ('00000000-0000-0000-0000-0000000006e7', 'WHATSAPP', pg_temp.hash64('e7'),
   'FAILED', 6, 'ladder spent', now() - interval '1 day', null),
  ('00000000-0000-0000-0000-0000000006e8', 'WHATSAPP', pg_temp.hash64('e8'),
   'FAILED', 5, 'one rung left', now() - interval '1 day', null);

select is(
  (select count(*)::int from public.due_whatsapp_events(20, 6) d
    where d.id = '00000000-0000-0000-0000-0000000006e7'),
  0, 'an event whose attempts have reached the cap is parked and never due again');

select is(
  (select count(*)::int from public.due_whatsapp_events(20, 6) d
    where d.id = '00000000-0000-0000-0000-0000000006e8'),
  1, 'and one attempt short of the cap is still due, so the cap parks rather than truncating the ladder');

-- Reclaiming ----------------------------------------------------------------
--
-- E5 above has been PROCESSING since yesterday. Nothing in this repository
-- COMMITS a row in that status -- ingest_whatsapp_event sets it and then
-- finishes or raises inside the same transaction (0062) -- so reaching this
-- state takes a hand, or a later design that claims in one transaction and
-- works in another. Either way no other query in the system looks for it.

insert into public.webhook_events
  (id, provider, external_id, status, attempts, received_at, next_attempt_at)
values
  -- Claimed a moment ago: a healthy tick in flight, and not to be touched.
  ('00000000-0000-0000-0000-0000000006e9', 'WHATSAPP', pg_temp.hash64('e9'),
   'PROCESSING', 0, now() - interval '10 seconds', null);

select is(public.reclaim_stale_whatsapp_events('5 minutes'), 1,
          'exactly one abandoned event is reclaimed');

select is(
  (select status::text from public.webhook_events
    where id = '00000000-0000-0000-0000-0000000006e5'),
  'RECEIVED', 'the abandoned one is RECEIVED again, so something will look at it');

select is(
  (select status::text from public.webhook_events
    where id = '00000000-0000-0000-0000-0000000006e9'),
  'PROCESSING', 'and a claim made ten seconds ago is left exactly where it is');

-- A reclaim is not a failure. Burning a retry on it, or writing our own
-- bookkeeping over a real error message, would make an abandoned event
-- indistinguishable from a failing one.
select is(
  (select attempts from public.webhook_events
    where id = '00000000-0000-0000-0000-0000000006e5'),
  1, 'reclaiming does not burn an attempt');

-- The point of all of it: a reclaimed row is picked up again. Without the
-- reclaim it is in no query's answer at all, which is a message silently lost.
select is(
  (select count(*)::int from public.due_whatsapp_events(20, 6) d
    where d.id = '00000000-0000-0000-0000-0000000006e5'),
  1, 'and the reclaimed event is due on the next pass');

-- Nothing else moved. Without this the reclaim could be a bare
-- `update webhook_events set status = RECEIVED` and every assertion above
-- would still pass.
select is(
  (select count(*)::int from public.webhook_events
    where status::text = 'RECEIVED'
      and id in ('00000000-0000-0000-0000-0000000006e1',
                 '00000000-0000-0000-0000-0000000006e6',
                 '00000000-0000-0000-0000-0000000006e7')),
  0, 'a FAILED, a DONE and a parked row are none of them reclaimed');

select is(public.reclaim_stale_whatsapp_events('5 minutes'), 0,
          'and a second reclaim finds nothing, because the first one finished the job');

select * from finish();
rollback;
