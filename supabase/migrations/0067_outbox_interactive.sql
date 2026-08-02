-- Block 5b. The outbound queue could carry text and nothing else, so every
-- message the conversation is actually made of -- the consent buttons, a
-- question's list -- had no way out of the building. sendInteractive exists on
-- the transport since Task 3; this is the column between it and the worker.

alter table public.outbox_messages
  add column interactive jsonb
    check (interactive is null or jsonb_typeof(interactive) = 'object');

comment on column public.outbox_messages.interactive is
  'The interactive message to send, in the application''s own shape (the `Interactive` union in src/lib/integrations/whatsapp/interactive.ts), NOT the Cloud API wire format -- the worker builds that at send time, so Meta''s payload shape stays in one file. Null means a plain text send, which is every reply Block 5a writes. `body` is NOT NULL either way and carries the same words the interactive message shows: an operator asking "what were they actually told?" gets an answer without rendering anything, and outbox_messages_body_shape stays the single rule about a message having words. NOT pruned, for the reason body is not: this is what the Station said, never anything about the person -- the phone number is in to_phone and that is the column the prune empties.';

-- The claim has to hand it over, or the column is a place to put something
-- nobody reads. DROP and CREATE rather than CREATE OR REPLACE: the returned
-- table gains a column, and Postgres refuses to replace a function whose OUT
-- parameters change. The grant goes with it -- a dropped function takes its ACL
-- with it, and losing this one would answer 42501 to every send.
drop function if exists public.claim_outbox_batch(integer);

create function public.claim_outbox_batch(p_limit integer)
returns table (
  id              uuid,
  to_phone        text,
  body            text,
  interactive     jsonb,
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
    returning o.id, o.to_phone, o.body, o.interactive, o.attempts,
              o.integration_id, o.next_attempt_at
  )
  select cl.id, cl.to_phone, cl.body, cl.interactive, cl.attempts, i.phone_number_id
  from claimed cl
  left join public.integrations i on i.id = cl.integration_id
  order by cl.next_attempt_at;
$$;

revoke execute on function public.claim_outbox_batch(integer) from public;
grant execute on function public.claim_outbox_batch(integer) to service_role;

comment on function public.claim_outbox_batch(integer) is
  'The next messages to send, marked SENDING in the same statement that chooses them. One statement is the entire point: pg_cron fires on schedule whether or not the previous tick returned, and a batch of fifty sequential calls to Meta outlasts the interval, so two ticks overlap under ordinary load -- with a plain select both would see the same PENDING rows and the listener would be answered twice. dedupe_key does not cover this: it stops a second row being enqueued, not one row being sent twice. FOR UPDATE SKIP LOCKED so an overlapping tick takes the next batch instead of blocking on this one. Returns attempts UNCHANGED, because claiming is not attempting and the ladder counts sends. LEFT JOIN on integrations so a row whose number cannot be resolved comes back and is parked with a reason, rather than being silently never claimed. outbox_messages_claim_shape (0059) requires claimed_at with SENDING, and outbox_messages_sent_shape is untouched, because a SENDING row leaves sent_at and external_id null exactly as a non-SENT row must. Returns `interactive` since 0067 (Block 5b): null on every text reply, and the conversation''s own messages otherwise -- a claim that returned only the body would send a listener the words of a question with none of its buttons.';
