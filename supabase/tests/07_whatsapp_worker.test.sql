begin;
select plan(49);

-- The worker's queue routines (0063), the claim columns they measure (0058,
-- 0059) and the grants without which none of it can be reached over HTTP.
-- Everything here is about WHICH rows come back, in WHAT ORDER, and WHO may
-- ask -- there is no promotion, no listener and no entry in this file, which is
-- the point: the drainer knows nothing about them, and 06_whatsapp is where the
-- deciding is tested.

create or replace function pg_temp.hash64(p_text text)
returns text language sql immutable as $$
  select encode(sha256(convert_to(p_text, 'UTF8')), 'hex');
$$;

-- Existence and reach ---------------------------------------------------------

select has_function('public', 'due_whatsapp_events', array['integer'],
                    'the due-events query exists');
select has_function('public', 'claim_outbox_batch', array['integer'],
                    'the outbound claim exists');
select has_function('public', 'reclaim_stale_whatsapp_claims', array['interval'],
                    'the reclaim exists');

select ok(not has_function_privilege('authenticated',
            'public.due_whatsapp_events(integer)', 'EXECUTE'),
          'authenticated may not ask what is due');
select ok(not has_function_privilege('authenticated',
            'public.claim_outbox_batch(integer)', 'EXECUTE'),
          'authenticated may not claim outbound messages');
select ok(not has_function_privilege('authenticated',
            'public.reclaim_stale_whatsapp_claims(interval)', 'EXECUTE'),
          'authenticated may not reclaim');
select ok(has_function_privilege('service_role',
            'public.due_whatsapp_events(integer)', 'EXECUTE'),
          'the worker may ask what is due');
select ok(has_function_privilege('service_role',
            'public.claim_outbox_batch(integer)', 'EXECUTE'),
          'the worker may claim outbound messages');
select ok(has_function_privilege('service_role',
            'public.reclaim_stale_whatsapp_claims(interval)', 'EXECUTE'),
          'the worker may reclaim');

-- THE GRANTS, and these are not bookkeeping. "RLS enabled, no policy,
-- service_role only" does NOT give service_role anything: this schema's default
-- ACL hands it Dxtm alone, so bypassing RLS reaches a table it holds no
-- privilege on. Their absence is why Task 11's webhook route answered 42501 to
-- every inbound message while every test in this repository passed -- pgTAP
-- runs as postgres and the vitest suite mocks the client, so nothing below the
-- HTTP boundary was ever exercised. These are that boundary, stated where a
-- migration can be held to it.
select ok(has_table_privilege('service_role', 'public.webhook_events', 'INSERT'),
          'the webhook route may store an inbound message');
select ok(has_table_privilege('service_role', 'public.webhook_events', 'SELECT'),
          'and may name a row in a WHERE clause, which UPDATE requires');
select ok(has_table_privilege('service_role', 'public.webhook_events', 'UPDATE'),
          'and the worker may defer a failed event');
select ok(has_table_privilege('service_role', 'public.outbox_messages', 'SELECT'),
          'the worker may name an outbox row');
select ok(has_table_privilege('service_role', 'public.outbox_messages', 'UPDATE'),
          'and may settle it once Meta has answered');
select ok(not has_table_privilege('authenticated', 'public.webhook_events', 'SELECT'),
          'while authenticated still reaches neither table');

-- integrations has NO table grant, and that is the design rather than the same
-- omission left unfixed: every reader of it is inside a SECURITY DEFINER body
-- (0057). This asserts the absence, so that adding a PostgREST read of the
-- table is a decision somebody has to make here rather than a 42501 they meet
-- in production.
select ok(not has_table_privilege('service_role', 'public.integrations', 'SELECT'),
          'integrations is reachable only from inside SECURITY DEFINER bodies');

-- TRUNCATE, which the default ACL grants and which no assertion about INSERT,
-- UPDATE or DELETE would ever catch. 0029 found this class of hole in review
-- and 02_permissions pins it for the inventory tables; this block had not been
-- asked yet. It matters most on webhook_events: that table's whole job is to
-- make a replayed delivery harmless, and one TRUNCATE would make every message
-- Meta ever sent deliverable again, each producing a fresh participation.
select ok(not has_table_privilege('service_role', 'public.webhook_events', 'TRUNCATE'),
          'service_role may not truncate the idempotency ledger');
select ok(not has_table_privilege('service_role', 'public.outbox_messages', 'TRUNCATE'),
          'service_role may not truncate the outbox');
select ok(not has_table_privilege('service_role', 'public.integrations', 'TRUNCATE'),
          'service_role may not truncate the number-to-Station map');
select ok(not has_table_privilege('authenticated', 'public.webhook_events', 'TRUNCATE'),
          'authenticated may not truncate the idempotency ledger');
select ok(not has_table_privilege('authenticated', 'public.outbox_messages', 'TRUNCATE'),
          'authenticated may not truncate the outbox');
select ok(not has_table_privilege('authenticated', 'public.integrations', 'TRUNCATE'),
          'authenticated may not truncate the number-to-Station map');
select ok(not has_table_privilege('anon', 'public.webhook_events', 'TRUNCATE'),
          'and neither may anon, on the table an unauthenticated caller is nearest to');

select has_index('public', 'webhook_events', 'webhook_events_processing',
                 'PROCESSING has an index of its own to be found through');
select has_index('public', 'outbox_messages', 'outbox_messages_sending',
                 'and so does SENDING, which is the arm that really fires');

-- A claim that cannot say when it was made ------------------------------------

select throws_ok($$
  insert into public.webhook_events (provider, external_id, status)
  values ('WHATSAPP', repeat('a', 64), 'PROCESSING')
$$, '23514', null, 'PROCESSING without a claimed_at is refused outright');

-- Fixtures --------------------------------------------------------------------

insert into public.organizations (id, name) values
  ('00000000-0000-0000-0000-0000000007f1', 'Org 5a worker');
insert into public.companies (id, organization_id, name, timezone) values
  ('00000000-0000-0000-0000-0000000007c1', '00000000-0000-0000-0000-0000000007f1',
   'Station 5a worker', 'America/Sao_Paulo');
insert into public.integrations
  (id, organization_id, company_id, provider, phone_number_id, enabled)
values
  ('00000000-0000-0000-0000-0000000007a1', '00000000-0000-0000-0000-0000000007f1',
   '00000000-0000-0000-0000-0000000007c1', 'WHATSAPP', '777777777777777', true);

select throws_ok($$
  insert into public.outbox_messages
    (provider, integration_id, organization_id, company_id, to_phone, body,
     dedupe_key, status)
  values
    ('WHATSAPP', '00000000-0000-0000-0000-0000000007a1',
     '00000000-0000-0000-0000-0000000007f1', '00000000-0000-0000-0000-0000000007c1',
     '5511900000000', 'hi', 'no-claim:confirmation', 'SENDING')
$$, '23514', null, 'and so is SENDING without one');

-- Inbound ordering ------------------------------------------------------------
--
-- THE FIXTURE IS THE ASSERTION. These three rows are laid out so that ordering
-- by received_at -- which is what a PostgREST query can express, and what this
-- task's brief actually wrote -- produces a DIFFERENT sequence from ordering by
-- coalesce(next_attempt_at, received_at), the expression webhook_events_pending
-- is built on. Rows whose two columns agree cannot tell the two apart, so a
-- test built from them would pass either way.
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
  ('00000000-0000-0000-0000-0000000007e1', 'WHATSAPP', pg_temp.hash64('e1'),
   'FAILED', 1, now() - interval '3 hours', now() - interval '1 minute'),
  ('00000000-0000-0000-0000-0000000007e2', 'WHATSAPP', pg_temp.hash64('e2'),
   'RECEIVED', 0, now() - interval '1 hour', null),
  ('00000000-0000-0000-0000-0000000007e3', 'WHATSAPP', pg_temp.hash64('e3'),
   'RECEIVED', 0, now() - interval '2 minutes', null);

select is(
  (select array_agg(d.id) from public.due_whatsapp_events(10) d),
  array['00000000-0000-0000-0000-0000000007e2',
        '00000000-0000-0000-0000-0000000007e3',
        '00000000-0000-0000-0000-0000000007e1']::uuid[],
  'due events come back in coalesce(next_attempt_at, received_at) order, which is not received_at order');

select is(
  (select d.attempts from public.due_whatsapp_events(10) d
    where d.id = '00000000-0000-0000-0000-0000000007e1'),
  1,
  'and carry their attempts, so a failure can be scheduled without a second read');

-- Inbound eligibility ---------------------------------------------------------

insert into public.webhook_events
  (id, provider, external_id, status, attempts, received_at, next_attempt_at, claimed_at)
values
  -- Backed off into the future: eligible later, not now.
  ('00000000-0000-0000-0000-0000000007e4', 'WHATSAPP', pg_temp.hash64('e4'),
   'FAILED', 2, now() - interval '1 day', now() + interval '1 minute', null),
  -- Claimed a day ago and never finished. Abandoned, and reclaimed below.
  ('00000000-0000-0000-0000-0000000007e5', 'WHATSAPP', pg_temp.hash64('e5'),
   'PROCESSING', 1, now() - interval '1 day', null, now() - interval '1 day'),
  -- THE INBOUND MIRROR OF b1, AND THE FIXTURE THAT MAKES claimed_at
  -- LOAD-BEARING ON THIS SIDE. Received a day ago, claimed ten seconds ago: a
  -- healthy tick working through a backlog, which is when every row is old and
  -- reclaiming the wrong one costs the most. Under the predicate this replaced
  -- -- coalesce(next_attempt_at, received_at) -- it is stale on sight, because
  -- its next_attempt_at is null and its received_at is a day back. e5 above
  -- cannot show that: it is old by BOTH measures, so it is reclaimed either
  -- way and every other assertion in this section passes against the old rule.
  ('00000000-0000-0000-0000-0000000007e8', 'WHATSAPP', pg_temp.hash64('e8'),
   'PROCESSING', 0, now() - interval '1 day', null, now() - interval '10 seconds'),
  -- PARKED. next_attempt_at is infinity, which is how a spent ladder leaves the
  -- queue: beyond the index condition for ever, and at the far end of the index
  -- rather than sorting first the way a null would.
  ('00000000-0000-0000-0000-0000000007e7', 'WHATSAPP', pg_temp.hash64('e7'),
   'FAILED', 6, now() - interval '1 day', 'infinity', null);

insert into public.webhook_events
  (id, provider, external_id, status, attempts, received_at, outcome, processed_at)
values
  ('00000000-0000-0000-0000-0000000007e6', 'WHATSAPP', pg_temp.hash64('e6'),
   'DONE', 1, now() - interval '1 day', 'recorded', now() - interval '1 day');

select is(
  (select count(*)::int from public.due_whatsapp_events(10) d
    where d.id in ('00000000-0000-0000-0000-0000000007e4',
                   '00000000-0000-0000-0000-0000000007e5',
                   '00000000-0000-0000-0000-0000000007e6')),
  0,
  'a future next_attempt_at, a claimed row and a decided row are all not due');

select is(
  (select count(*)::int from public.due_whatsapp_events(10) d
    where d.id = '00000000-0000-0000-0000-0000000007e7'),
  0, 'and a parked event is never due again, however old it is');

select is((select count(*)::int from public.due_whatsapp_events(2) d), 2,
          'the batch cap is the caller''s and is honoured');

-- Outbound claiming -----------------------------------------------------------
--
-- The fix for the defect that matters most in this file: two overlapping ticks
-- sending the same message twice. pg_cron fires every ten seconds whether or
-- not the last tick returned, and a full batch outlasts that, so overlap is
-- ordinary rather than exotic. The claim is what makes the second tick find
-- nothing.

insert into public.outbox_messages
  (id, provider, integration_id, organization_id, company_id, to_phone, body,
   dedupe_key, status, attempts, next_attempt_at)
values
  ('00000000-0000-0000-0000-0000000007b1', 'WHATSAPP',
   '00000000-0000-0000-0000-0000000007a1', '00000000-0000-0000-0000-0000000007f1',
   '00000000-0000-0000-0000-0000000007c1', '5511900000001', 'first',
   'b1:confirmation', 'PENDING', 2, now() - interval '10 minutes'),
  ('00000000-0000-0000-0000-0000000007b2', 'WHATSAPP',
   '00000000-0000-0000-0000-0000000007a1', '00000000-0000-0000-0000-0000000007f1',
   '00000000-0000-0000-0000-0000000007c1', '5511900000002', 'second',
   'b2:confirmation', 'PENDING', 0, now() - interval '5 minutes'),
  -- Not yet sendable.
  ('00000000-0000-0000-0000-0000000007b3', 'WHATSAPP',
   '00000000-0000-0000-0000-0000000007a1', '00000000-0000-0000-0000-0000000007f1',
   '00000000-0000-0000-0000-0000000007c1', '5511900000003', 'later',
   'b3:confirmation', 'PENDING', 0, now() + interval '1 hour'),
  -- Terminal. outbox_messages_sendable excludes FAILED on purpose (0059).
  ('00000000-0000-0000-0000-0000000007b4', 'WHATSAPP',
   '00000000-0000-0000-0000-0000000007a1', '00000000-0000-0000-0000-0000000007f1',
   '00000000-0000-0000-0000-0000000007c1', '5511900000004', 'dead',
   'b4:confirmation', 'FAILED', 6, now() - interval '1 day');

create temporary table claimed_first as
  select * from public.claim_outbox_batch(10);

select is((select array_agg(c.id) from claimed_first c),
          array['00000000-0000-0000-0000-0000000007b1',
                '00000000-0000-0000-0000-0000000007b2']::uuid[],
          'the claim takes the sendable rows, oldest first, and leaves the rest');

select is((select c.attempts from claimed_first c
            where c.id = '00000000-0000-0000-0000-0000000007b1'),
          2, 'attempts come back unchanged, because claiming is not attempting');

select is((select c.phone_number_id from claimed_first c
            where c.id = '00000000-0000-0000-0000-0000000007b1'),
          '777777777777777',
          'and the number to send FROM is resolved in the same statement');

select is(
  (select count(*)::int from public.outbox_messages
    where id in ('00000000-0000-0000-0000-0000000007b1',
                 '00000000-0000-0000-0000-0000000007b2')
      and status = 'SENDING' and claimed_at is not null),
  2, 'the claimed rows are marked SENDING with the moment they were taken');

-- THE ASSERTION THIS SECTION EXISTS FOR. A second tick, arriving while the
-- first still has the batch in flight, must find nothing to send. Without the
-- claim both ticks see the same PENDING rows in the same order and the listener
-- is answered twice -- and dedupe_key cannot stop it, because it prevents a
-- second ROW, not a second SEND of one row.
select is((select count(*)::int from public.claim_outbox_batch(10)), 0,
          'and an overlapping tick claims nothing, because the batch is no longer PENDING');

select is(
  (select count(*)::int from public.outbox_messages
    where id in ('00000000-0000-0000-0000-0000000007b3',
                 '00000000-0000-0000-0000-0000000007b4')
      and status in ('PENDING', 'FAILED')),
  2, 'a row not yet due and a parked row are neither of them touched');

-- Reclaiming ------------------------------------------------------------------
--
-- b1 and b2 were claimed a moment ago: healthy work in flight. The rest of this
-- section is what separates "old row" from "old claim", which is the whole
-- reason claimed_at exists.

insert into public.outbox_messages
  (id, provider, integration_id, organization_id, company_id, to_phone, body,
   dedupe_key, status, attempts, next_attempt_at, claimed_at)
values
  -- Claimed yesterday and never settled: a tick died mid-send.
  ('00000000-0000-0000-0000-0000000007b5', 'WHATSAPP',
   '00000000-0000-0000-0000-0000000007a1', '00000000-0000-0000-0000-0000000007f1',
   '00000000-0000-0000-0000-0000000007c1', '5511900000005', 'abandoned',
   'b5:confirmation', 'SENDING', 1, now() - interval '2 days',
   now() - interval '1 day');

select is((select events from public.reclaim_stale_whatsapp_claims('5 minutes')), 1,
          'exactly one abandoned event is reclaimed');

select is(
  (select status::text from public.webhook_events
    where id = '00000000-0000-0000-0000-0000000007e5'),
  'RECEIVED', 'the abandoned event is RECEIVED again, so something will look at it');

select is(
  (select status::text from public.outbox_messages
    where id = '00000000-0000-0000-0000-0000000007b5'),
  'PENDING', 'and the abandoned message is sendable again');

-- I3 on the INBOUND side, which the outbound fixtures cannot speak for. e8 was
-- received a day ago and claimed ten seconds ago; measured against the row it
-- is ancient, measured against the CLAIM it is a tick that started a moment
-- ago and is still running. Reclaiming it would take an event away from a live
-- worker and hand the same message to two of them.
select is(
  (select status::text from public.webhook_events
    where id = '00000000-0000-0000-0000-0000000007e8'),
  'PROCESSING', 'an event received long ago but claimed a moment ago is left exactly where it is');

-- I3, AND THE ASSERTION THE OLD PREDICATE COULD NOT HAVE PASSED. b1 and b2 were
-- enqueued ten and five minutes ago and claimed a moment ago. A reclaim
-- measured against next_attempt_at or received_at -- the only timestamps
-- available before claimed_at existed -- calls them stale on sight and hands a
-- live worker's batch to somebody else, precisely when a backlog has made every
-- row old. Measured against the CLAIM they are seconds old, and untouched.
select is(
  (select count(*)::int from public.outbox_messages
    where id in ('00000000-0000-0000-0000-0000000007b1',
                 '00000000-0000-0000-0000-0000000007b2')
      and status = 'SENDING'),
  2, 'a row enqueued long ago but claimed a moment ago is NOT stale: the claim is what ages');

select is(
  (select attempts from public.outbox_messages
    where id = '00000000-0000-0000-0000-0000000007b5'),
  1, 'reclaiming does not burn an attempt');

select is(
  (select last_error is null from public.outbox_messages
    where id = '00000000-0000-0000-0000-0000000007b5'),
  true, 'nor writes our own bookkeeping over an error message');

-- The point of all of it: a reclaimed row is looked at again. Without the
-- reclaim it is in no query's answer at all, which is a message silently lost.
select is(
  (select count(*)::int from public.due_whatsapp_events(20) d
    where d.id = '00000000-0000-0000-0000-0000000007e5'),
  1, 'the reclaimed event is due on the next pass');

select is(
  (select count(*)::int from public.claim_outbox_batch(20) c
    where c.id = '00000000-0000-0000-0000-0000000007b5'),
  1, 'and the reclaimed message is claimable on the next pass');

-- Nothing else moved. Without this the reclaim could be a bare
-- `update ... set status = RECEIVED` and every assertion above would pass.
select is(
  (select count(*)::int from public.webhook_events
    where status::text = 'RECEIVED'
      and id in ('00000000-0000-0000-0000-0000000007e1',
                 '00000000-0000-0000-0000-0000000007e6',
                 '00000000-0000-0000-0000-0000000007e7')),
  0, 'a FAILED, a DONE and a parked event are none of them reclaimed');

select is((select messages from public.reclaim_stale_whatsapp_claims('5 minutes')), 0,
          'and a second reclaim finds nothing, because the first one finished the job');

select * from finish();
rollback;
