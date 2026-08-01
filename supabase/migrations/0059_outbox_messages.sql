-- Outbound traffic as rows, drained by the worker. The point of the table is
-- that a reply is enqueued in the SAME transaction as the participation it
-- announces, so there is no state in which a listener is entered and never told
-- or told and not entered.

create type public.outbox_status as enum ('PENDING', 'SENDING', 'SENT', 'FAILED');

create table public.outbox_messages (
  id              uuid primary key default gen_random_uuid(),
  provider        public.integration_provider not null,
  integration_id  uuid not null references public.integrations (id),
  organization_id uuid not null references public.organizations (id),
  company_id      uuid not null,

  -- NULLABLE, and only because prune_outbox_messages below empties it. This is
  -- a listener's phone number in the clear, in a table Block 3's
  -- anonymize_member cannot reach -- there is no member_id here to join on --
  -- so retention is the only thing that can make an erasure true here, and
  -- retention needs somewhere to put the absence.
  --
  -- The guarantee that a LIVE row still names somebody to send to is not lost
  -- with the NOT NULL: outbox_messages_retention_shape below states it against
  -- pruned_at instead, so "nullable" means "pruned", never "enqueued without a
  -- recipient".
  to_phone text check (to_phone is null or length(btrim(to_phone)) > 0),
  -- NOT pruned, and deliberately: the body names a promotion and says what
  -- happened, which is a fact about a draw rather than about a person. It is
  -- also what an operator asked "what were they actually told?" has left once
  -- the number is gone.
  body     text not null check (length(btrim(body)) > 0),

  -- Unique, and that is the whole mechanism. Reprocessing a parked event by
  -- hand must not send its confirmation a second time, and this holds it rather
  -- than the worker being careful. Shape: '<sha256 of the wamid>:confirmation'.
  --
  -- KEYED ON THE MESSAGE, NOT ON THE PARTICIPATION, and the distinction is the
  -- whole promise. An earlier draft of this comment said
  -- '<participation_id>:confirmation' and the sentence above it was then false:
  -- reprocessing an event writes a NEW participation, therefore a new key,
  -- therefore a second reply, and the unique constraint never fires. What
  -- protected us was ingest_whatsapp_event declining to take a DONE event --
  -- real, but a different mechanism from the one this comment advertises, and
  -- one an operator resetting a row by hand walks straight past.
  --
  -- The message id is also the coherent choice: idempotency on the INBOUND
  -- side is already (provider, external_id) on webhook_events (0058), so the
  -- reply to a message keys exactly the way the message does. One message, one
  -- reply, whatever happens downstream.
  --
  -- It follows webhook_events.external_id, which holds the SHA-256 of the wamid
  -- and not the wamid itself (0058): the raw id decodes to bytes containing the
  -- counterparty phone, and THIS column is never pruned -- it cannot be, since
  -- refusing a duplicate reply is the one job it has and a prune would return
  -- the row to sendable. (outbox_messages.external_id below is a different
  -- column with the opposite property: raw, and pruned for exactly that
  -- reason.) So the value here is the hash, the same string webhook_events
  -- carries.
  dedupe_key text not null check (length(btrim(dedupe_key)) > 0),

  status          public.outbox_status not null default 'PENDING',
  attempts        integer not null default 0 check (attempts >= 0),
  last_error      text,
  next_attempt_at timestamptz not null default now(),
  external_id     text,
  created_at      timestamptz not null default now(),
  sent_at         timestamptz,

  -- When a worker took this row to send it. See webhook_events.claimed_at
  -- (0058) for the reasoning; it matters more here, because on this side the
  -- claim is real. next_attempt_at is when the row became SENDABLE and says
  -- nothing about how long the send has been running, so a reclaim measured
  -- against it would return a row to PENDING while its HTTP call to Meta was
  -- still open -- and the listener would get the message twice.
  claimed_at      timestamptz,

  -- When this row's personal data was erased, null on every row that still
  -- carries it. It is not bookkeeping: both shape constraints below are written
  -- against it, so a row with no recipient, and a SENT row with no provider id,
  -- are legal exactly when they have been pruned and at no other time. Without
  -- this column, nulling those two would mean weakening both constraints for
  -- every row for ever -- and the weakening would be invisible, because the
  -- assertions that exist insert rows carrying NEITHER of the pair and would go
  -- on passing against a constraint that had stopped requiring EITHER.
  pruned_at       timestamptz,

  constraint outbox_messages_company_org_fk
    foreign key (company_id, organization_id)
    references public.companies (id, organization_id),
  constraint outbox_messages_dedupe_unique unique (provider, dedupe_key),

  -- SENT is a claim about two other columns, so it states them structurally
  -- rather than trusting whoever wrote the row. The transport never reports a
  -- send as accepted without a wamid -- it returns a retryable failure instead
  -- -- so this is satisfiable by every path that reaches it.
  --
  -- The one exemption is RETENTION, and it is written as an exemption rather
  -- than as a hole: a pruned row may lack the provider id because
  -- prune_outbox_messages took it, and only then. Dropping `or pruned_at is not
  -- null` in favour of simply not requiring external_id would let a settle
  -- write that recorded the status alone pass -- the 23514 this constraint
  -- exists to raise.
  constraint outbox_messages_sent_shape check (
    (status = 'SENT' and sent_at is not null
       and (external_id is not null or pruned_at is not null))
    or (status <> 'SENT' and sent_at is null and external_id is null)
  ),

  -- The other half of the same exemption, for the column that used to be NOT
  -- NULL. A row nobody has pruned must still say who it is for; a pruned one
  -- must be allowed not to.
  constraint outbox_messages_retention_shape check (
    to_phone is not null or pruned_at is not null
  ),

  -- SENDING is a claim, and the same structural rule webhook_events_claim_shape
  -- (0058) states for PROCESSING. Note it does NOT conflict with the shape
  -- above: a SENDING row leaves sent_at and external_id null, which is exactly
  -- what a non-SENT row is required to do, so claiming a row writes one column
  -- and violates nothing.
  constraint outbox_messages_claim_shape check (
    status <> 'SENDING' or claimed_at is not null
  )
);

-- What claim_outbox_batch (0063) scans, and it holds ONE status because that
-- function asks for one. Two are excluded, for different reasons.
--
-- FAILED is excluded here but not from webhook_events_pending (0058), and that
-- asymmetry is deliberate rather than an oversight. On the outbound side a
-- retryable failure is written back as PENDING with a future next_attempt_at,
-- so FAILED here means permanent or the retry ladder is spent -- terminal, and
-- rightly outside the sendable scan. On the inbound side FAILED is transient:
-- it means "try again", and webhook_events_pending scans it back in for exactly
-- that reason.
--
-- SENDING is excluded because NOTHING SCANS IT BY next_attempt_at. It was in
-- this predicate when the design had the worker walk claimed rows; it does not
-- any more. The only reader of SENDING is the reclaim, which asks
-- "claimed_at < now() - interval" and is served by outbox_messages_sending
-- (0063), an index on the column it actually compares.
--
-- Leaving it here would not be harmless breadth. With two statuses in the
-- predicate, claim_outbox_batch's `status = 'PENDING'` stops being part of the
-- index condition and becomes a FILTER applied to rows the scan has already
-- fetched -- the precise cost 0063 refuses `attempts < p_max_attempts` for. And
-- it degrades exactly in the failure the reclaim exists to answer: an abandoned
-- SENDING row keeps the old next_attempt_at it was claimed with, so it sits at
-- the HEAD of this index, and every claim walks past every one of them for up
-- to the stale threshold before reaching a row it may actually send.
create index outbox_messages_sendable
  on public.outbox_messages (next_attempt_at)
  where status = 'PENDING';

alter table public.outbox_messages enable row level security;
-- No policy. See integrations (0057).

-- And the explicit grant RLS-with-no-policy does not imply. See the same block
-- in 0058 for what its absence cost there; here it would have made every
-- settle write from the worker fail with 42501 after the message had already
-- reached Meta -- the one failure that is worse than not sending, because the
-- row stays sendable and the listener is told twice.
--
-- SELECT accompanies UPDATE because PostgreSQL requires it for the WHERE
-- clause. No INSERT: the only writer of a new row is ingest_whatsapp_event
-- (0062), which is SECURITY DEFINER and runs as the owner. No DELETE: an
-- outbox row is the record that a reply was owed, and it outlives the reply.
revoke all      on public.outbox_messages from anon, authenticated;
grant select, update on public.outbox_messages to service_role;
-- And TRUNCATE, which the default ACL hands out and which none of the grants
-- above mention -- it is neither INSERT, UPDATE nor DELETE, so no assertion
-- about those would ever catch it. The same hole 0029 found in review and
-- 0035, 0046 and 0050 have closed since; this block simply had not been asked
-- yet. Immutability is a grant, not a comment.
revoke truncate on public.outbox_messages from service_role;

-- Design spec D9, and the half of it this table falsified until now.
--
-- THE DEFECT THIS CLOSES, stated plainly because it was a regression of a
-- guarantee Block 3 already gave. to_phone holds a listener's phone number in
-- the clear, and external_id holds the RAW wamid Meta returns for the reply --
-- which decodes to bytes containing that same number (0058's own reasoning for
-- hashing the inbound one). Neither was pruned by anything, and
-- anonymize_member (0034) cannot reach this table at all: it erases a person by
-- member_id and there is no member_id here to join on. So a listener who
-- exercised erasure had their number nulled on members and left intact, for
-- ever, in a table this block created. D9's "the raw provider message id lives
-- in payload and expires with it" was written before this table existed and was
-- true of the inbound half only; that sentence is corrected in the spec, in the
-- report and in 0058's own column comment, because an invariant that is ninety
-- per cent true is exactly how it went wrong the first time.
--
-- MIRRORS prune_webhook_payloads (0058) deliberately, down to the shape of the
-- predicate: terminal status AND age, the row kept, the identifying columns
-- nulled. Terminal here is SENT or FAILED. PENDING is waiting to be sent and
-- SENDING is a claim in flight -- which reclaim_stale_whatsapp_claims (0063)
-- returns to PENDING rather than abandoning -- so both are rows this system
-- still intends to act on, and a row whose recipient had been erased could not
-- be acted on at all.
--
-- THE ROW SURVIVES, and that is the point rather than a side effect:
-- outbox_messages_dedupe_unique is what stops a reprocessed event sending a
-- second confirmation, and it is keyed on dedupe_key, which is
-- '<sha256 of the wamid>:confirmation' and carries nothing personal. A prune
-- that deleted rows would hand every listener a duplicate reply the first time
-- an old event was re-run. body stays for the same reason it is not personal
-- data: it names a promotion, not a person.
--
-- Not scheduled here. Block 11 owns schedules and turns both prunes on together
-- with the rest of N7, exactly as prune_webhook_payloads is handled.
create or replace function public.prune_outbox_messages(
  p_older_than interval default '30 days')
returns integer
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_count integer;
begin
  -- Aged on created_at, which is when the row came into being -- the mirror of
  -- received_at on the inbound side. sent_at would be the wrong column: it is
  -- null on every FAILED row, so half the terminal rows would never age at all.
  update public.outbox_messages
     set to_phone = null, external_id = null, pruned_at = now()
   where pruned_at is null
     and status in ('SENT', 'FAILED')
     and created_at < now() - p_older_than;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke execute on function public.prune_outbox_messages(interval) from public;
grant execute on function public.prune_outbox_messages(interval) to service_role;

comment on table public.outbox_messages is
  'Outbound messages as rows, so a reply commits in the same transaction as the participation it announces. dedupe_key is unique and is keyed on the MESSAGE (''<sha256 of the wamid>:confirmation''), not on the participation: reprocessing an event by hand writes a new participation, so a participation-keyed value would have produced a second reply and never fired the constraint at all. Keyed on the message the promise is real and matches the inbound side, whose idempotency is already (provider, external_id) on webhook_events; the value is the HASH of the wamid, following external_id, because the raw id is not anonymous and dedupe_key is not pruned. RLS enabled with no policy — service_role only. prune_outbox_messages nulls to_phone and external_id — the two columns that carry a listener''s number, one of them in the clear — on rows that are terminal (SENT or FAILED) and older than the cut, keeping the row so dedupe_key goes on refusing a second confirmation. That prune is this table''s only erasure mechanism: anonymize_member (0034) erases by member_id and there is no member_id here to join on, so without it a listener''s number outlived their own erasure request.';
comment on column public.outbox_messages.external_id is
  'The wamid Meta returns once it accepts the send. Null until then, and null forever on a row that never succeeded. RAW, not hashed — unlike webhook_events.external_id (0058), because nothing keys on this one and nothing needs it to survive; it is here for an operator tracing a reply against Meta''s dashboard. It is personal data all the same (a wamid decodes to bytes containing the counterparty''s number), so prune_outbox_messages nulls it with to_phone once the row is terminal and past the cut, and pruned_at is what lets outbox_messages_sent_shape go on demanding it everywhere else.';
comment on column public.outbox_messages.pruned_at is
  'When prune_outbox_messages erased this row''s to_phone and external_id, null while it still carries them. Load-bearing rather than informational: outbox_messages_sent_shape and outbox_messages_retention_shape are both written against it, so a SENT row with no provider id, and any row with no recipient, are legal exactly when they have been pruned and at no other time.';
