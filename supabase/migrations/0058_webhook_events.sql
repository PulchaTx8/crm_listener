-- Every inbound event, stored before anything is decided about it. The unique
-- index on (provider, external_id) is what makes the master spec's own "a
-- repeated event does not duplicate a participation" true by structure rather
-- than by the worker checking: Meta re-delivers anything it does not see a 200
-- for, so a duplicate is normal traffic and not an attack.

create type public.webhook_event_status as enum
  ('RECEIVED', 'PROCESSING', 'DONE', 'FAILED');

comment on type public.webhook_event_status is
  'DONE means "finished deciding about this", NOT "a participation happened" — it covers a recorded entry, an unknown number, and a hashtag matching nothing, with the reason in outcome. FAILED means try again. Conflating the two is how a permanently unroutable message gets retried forever.';

create table public.webhook_events (
  id       uuid primary key default gen_random_uuid(),
  provider public.integration_provider not null,

  -- The SHA-256 of the WhatsApp MESSAGE id (wamid...), never the request id:
  -- Meta packs several messages into one POST, so one HTTP request becomes N
  -- rows here and idempotency is per message.
  --
  -- HASHED, AND THE RAW ID IS NOT STORED HERE. A wamid decodes to bytes that
  -- contain the counterparty's phone number, so it is not the anonymous token
  -- this column was first written as. Left raw it would carry a recoverable
  -- phone into audit_logs -- which design spec D2 forbids in capitals -- and
  -- into a column that deliberately OUTLIVES the payload, since
  -- prune_webhook_payloads (design spec D9) clears the payload at thirty days
  -- precisely because this value was believed not to be personal.
  --
  -- Idempotency is untouched: it is equality, and a hash preserves equality
  -- exactly. What is lost is the ability to read a row against Meta's dashboard
  -- after the payload is pruned, which now means hashing the id first.
  --
  -- Hashed in NODE, before it reaches the database, for the reason
  -- 0031_members.sql already gives for cpf_hash: an argument passed to an RPC
  -- lands in query logs and in backups, so hashing here would leave the raw
  -- value in exactly the places this is meant to keep it out of.
  --
  -- A raw wamid begins 'wamid.' and is base64; a SHA-256 hex digest is
  -- sixty-four hex characters. The two shapes cannot be confused, so the format
  -- check refuses a raw id outright -- the guarantee that this column never
  -- holds one does not rest solely on the route (Block 5a Task 11) remembering
  -- to hash it first. Exactly the reasoning, and exactly the pattern, of
  -- members.cpf_hash.
  external_id text not null check (external_id ~ '^[0-9a-f]{64}$'),

  integration_id  uuid references public.integrations (id),
  -- Null until the number resolves: a message sent to a number this
  -- installation does not serve belongs to no Station, and saying so with
  -- null is honester than inventing one. When the pair IS populated it is
  -- checked: webhook_events_company_org_fk below pins (company_id,
  -- organization_id) to companies (id, organization_id), the same tenancy
  -- guard integrations (0057) uses. A composite foreign key defaults to
  -- MATCH SIMPLE, under which the constraint is satisfied whenever any
  -- referencing column is null — so (null, null) passes untouched here,
  -- while a populated pair must name a real Station/Organization
  -- combination.
  organization_id uuid references public.organizations (id),
  company_id      uuid,

  payload jsonb,
  status  public.webhook_event_status not null default 'RECEIVED',
  outcome text,
  attempts        integer not null default 0 check (attempts >= 0),
  last_error      text,
  received_at     timestamptz not null default now(),
  next_attempt_at timestamptz,
  processed_at    timestamptz,

  -- When this event was last CLAIMED, which is not when it arrived and not
  -- when it is next due. The worker's reclaim (0063) needs the age of the
  -- CLAIM, and every other timestamp on this row answers a different question:
  -- an event received an hour ago and claimed one second ago is a healthy tick
  -- in flight, and a reclaim predicated on received_at cannot tell it from an
  -- abandoned one. Without this column that distinction is unavailable, so the
  -- reclaim would take work away from a live worker the moment a backlog
  -- appeared -- exactly when a backlog is least affordable.
  claimed_at      timestamptz,

  constraint webhook_events_external_id_unique unique (provider, external_id),

  constraint webhook_events_company_org_fk
    foreign key (company_id, organization_id)
    references public.companies (id, organization_id),

  -- DONE is a claim about two other columns, the same pattern
  -- outbox_messages_sent_shape (0059) states for SENT: finishing a decision
  -- means recording why (outcome) and when (processed_at), held structurally
  -- rather than trusted. Every other status has decided nothing yet, so both
  -- stay null -- RECEIVED and PROCESSING because they have not reached a
  -- decision, and FAILED for the same reason: the type comment above says
  -- FAILED means try again, and webhook_events_pending below scans FAILED
  -- rows back in for exactly that reason. A FAILED row that carried an
  -- outcome or a processed_at would look finished while still being retried.
  constraint webhook_events_done_shape check (
    (status = 'DONE' and outcome is not null and processed_at is not null)
    or (status <> 'DONE' and outcome is null and processed_at is null)
  ),

  -- PROCESSING is a claim, and a claim that cannot say when it was made is not
  -- one. Held structurally so the reclaim (0063) may predicate on claimed_at
  -- with no fallback: a coalesce to received_at would quietly restore the very
  -- bug this column exists to remove, and an `is not null` guard would instead
  -- make a hand-written PROCESSING row unreclaimable -- the one case the
  -- reclaim is reachable for today. One direction only: the column stays
  -- populated after the claim ends, where it reads as "when this was last
  -- claimed" and costs nothing.
  constraint webhook_events_claim_shape check (
    status <> 'PROCESSING' or claimed_at is not null
  )
);

create index webhook_events_pending
  on public.webhook_events (coalesce(next_attempt_at, received_at))
  where status in ('RECEIVED', 'FAILED');

alter table public.webhook_events enable row level security;
-- No policy. See integrations (0057) for why that is the deny and not an
-- oversight.

-- AND service_role STILL NEEDS AN EXPLICIT GRANT, which "RLS on, no policy,
-- service_role only" above does NOT provide on its own. This schema's default
-- ACL hands service_role only Dxtm (TRUNCATE, REFERENCES, TRIGGER, MAINTAIN) --
-- 0006, 0014, 0019 and 0029 all say so and all grant accordingly -- so
-- bypassing RLS gets a role exactly nowhere without table privileges to bypass
-- it with. Omitted when this file was written, and the omission was invisible:
-- every test that exercises this table either runs as postgres (pgTAP) or
-- mocks the Supabase client (vitest), and neither touches a privilege check.
--
-- What it cost: Block 5a Task 11's webhook route is the only writer here, it
-- writes through PostgREST as service_role, and it was answering
--   {"code":"42501","message":"permission denied for table webhook_events"}
-- to every inbound message -- so the route returned 500, Meta re-delivered for
-- ever, and not one WhatsApp message could ever have been stored.
--
-- SELECT is required and not decoration: PostgreSQL demands SELECT on every
-- column named in an UPDATE's WHERE clause, so `update ... where id = $1`
-- fails with UPDATE alone. INSERT is the route's; UPDATE is the worker's
-- (0063), which defers a failed event. No DELETE: nothing in this system
-- deletes an event, and prune_webhook_payloads below nulls the payload
-- precisely so it does not have to.
revoke all on public.webhook_events from anon, authenticated;
grant select, insert, update on public.webhook_events to service_role;
-- And TRUNCATE, which the default ACL hands out and which none of the grants
-- above mention -- it is neither INSERT, UPDATE nor DELETE, so no assertion
-- about those would catch it. It matters more here than almost anywhere: this
-- table's whole job is to be the ledger that makes a replayed delivery
-- harmless, and one TRUNCATE would make every message Meta ever sent
-- deliverable again, each producing a fresh participation. The same hole 0029
-- found in review and 0035, 0046 and 0050 have closed since. Immutability is a
-- grant, not a comment.
revoke truncate on public.webhook_events from service_role;

-- Design spec D9. The payload holds a phone number, a WhatsApp profile name and
-- the raw provider message id — personal data at rest in a table Block 3's
-- anonymize_member does not reach. Nulling it keeps the row, so a replayed
-- message is still refused a year later while the content that made it personal
-- is gone. That guarantee is why external_id above is a HASH: the idempotency
-- key has to survive this function, and a raw wamid would have been personal
-- data surviving it. This block ships the function; Block 11 schedules it
-- alongside the rest of N7.
--
-- WHICH ROWS, AND WHY AGE ALONE IS NOT THE ANSWER. Two properties have to hold
-- together, and neither may be bought with the other:
--
--   1. AN EVENT STILL AWAITING PROCESSING OR RETRY KEEPS ITS PAYLOAD. A row
--      sitting RECEIVED for thirty-one days because the tick was down, or
--      FAILED and waiting on its next rung, is work this system still intends
--      to do, and ingest_whatsapp_event (0062) reads five paths out of the
--      payload to do it. Emptied, that event finds no
--      metadata->>phone_number_id, misses the integration lookup and finishes
--      DONE with outcome no_integration -- a plausible-looking reason recorded
--      against a row that was destroyed rather than routed, filed in the one
--      pile nobody searches. That is precisely the failure the missing-
--      timestamp RAISE further down 0062 exists to prevent, and a prune that
--      could reach such a row would make design spec §6.3's "reprocessing a
--      parked event is safe by structure" false.
--
--   2. PERSONAL DATA DOES NOT SURVIVE INDEFINITELY ON A ROW THAT IS FINISHED,
--      whichever way it finished. DONE is the ordinary case. A PARKED row is
--      the one a narrower `status = 'DONE'` predicate would keep for ever, and
--      it holds a phone number and a WhatsApp profile name exactly as a DONE
--      row does: retention is not conditional on the outcome having been a
--      happy one, and the listener whose number it is did not consent to it
--      being kept longer because the bot failed to answer them.
--
-- So: DONE, or FAILED and PARKED. Parked means next_attempt_at = infinity,
-- which is what the worker writes when the ladder is spent
-- (src/services/whatsapp.ts, PARKED_AT) and what puts a row beyond
-- due_whatsapp_events' index condition permanently (0063). The definition is
-- READ FROM THE QUEUE'S OWN COLUMN rather than re-invented here, so the two
-- cannot drift into disagreeing about which rows are still live.
--
-- Everything else is excluded on the same test. PROCESSING is a claim in
-- flight, and a claim that dies is returned to RECEIVED by
-- reclaim_stale_whatsapp_claims (0063), so it is still awaiting processing.
-- FAILED with any other next_attempt_at is awaiting retry -- including NULL,
-- which coalesces to received_at and is therefore due right now.
--
-- THE COST, stated rather than discovered: MANUAL REPROCESSING HAS A BOUNDED
-- WINDOW. An operator un-parking a row older than the cut finds its payload
-- already gone, and ingest_whatsapp_event RAISES on an empty payload rather
-- than reporting a routing outcome it cannot have decided. That is the loud
-- half of property 1, and docs/block-5a-runbook.md §6 states both the window
-- and how to un-park.
create or replace function public.prune_webhook_payloads(
  p_older_than interval default '30 days')
returns integer
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_count integer;
begin
  update public.webhook_events
     set payload = null
   where payload is not null
     and received_at < now() - p_older_than
     and (status = 'DONE'
          or (status = 'FAILED' and next_attempt_at = 'infinity'));
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke execute on function public.prune_webhook_payloads(interval) from public;
grant execute on function public.prune_webhook_payloads(interval) to service_role;

comment on table public.webhook_events is
  'One row per inbound message, written before anything is decided about it. (provider, external_id) unique is the idempotency guarantee the master spec asks for, held structurally — over the HASH of the provider message id, since idempotency is equality and a hash preserves equality exactly. payload is nullable because prune_webhook_payloads (design spec D9) clears it after 30 days while keeping the row, which is the whole reason external_id may not hold anything personal. The prune reaches only rows nothing will look at again automatically — DONE, or FAILED and parked at next_attempt_at = infinity — because an event still awaiting processing or retry needs its payload to be decided at all, and because a parked row holds a phone number exactly as a DONE one does.';
comment on column public.webhook_events.external_id is
  'SHA-256 of the WhatsApp message id (wamid...), hex, hashed in Node before it reaches the database — NOT the id itself, and never the HTTP request id: Meta packs several messages into one POST and idempotency is per message. Hashed because a wamid decodes to bytes containing the counterparty phone number, so the raw value is not anonymous: it would put a recoverable phone into audit_logs, which design spec D2 forbids, and into a column that deliberately outlives the payload prune_webhook_payloads clears at thirty days. Hashed in Node rather than here for the reason members.cpf_hash gives (0031) — an argument passed to an RPC lands in query logs and in backups. The format CHECK refuses a raw id outright, so the guarantee does not rest on the route remembering. The raw id of the INBOUND message lives in payload and expires with it; the raw id Meta returns for the reply we send back lives in outbox_messages.external_id (0059) and expires with prune_outbox_messages. Design spec D9 originally said the raw provider id lived in one column and expired with it, which was true of the inbound half and false of the outbox this block also created — both halves now expire, and the statement is corrected in the spec, in the report and here.';
comment on column public.webhook_events.outcome is
  'Why this event finished. With status DONE it distinguishes recorded from no_integration, no_hashtag, no_promotion, promotion_cancelled and outside_window — all of which are silent to the listener (design spec D4) and all of which somebody will eventually have to explain.';
