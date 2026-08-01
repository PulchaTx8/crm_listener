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

  to_phone text not null check (length(btrim(to_phone)) > 0),
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
  -- It follows external_id, which holds the SHA-256 of the wamid and not the
  -- wamid itself (0058): the raw id decodes to bytes containing the
  -- counterparty phone, and this column is not pruned either. So the value
  -- here is the hash, the same string webhook_events carries.
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

  constraint outbox_messages_company_org_fk
    foreign key (company_id, organization_id)
    references public.companies (id, organization_id),
  constraint outbox_messages_dedupe_unique unique (provider, dedupe_key),

  -- SENT is a claim about two other columns, so it states them structurally
  -- rather than trusting whoever wrote the row. The transport never reports a
  -- send as accepted without a wamid -- it returns a retryable failure instead
  -- -- so this is satisfiable by every path that reaches it.
  constraint outbox_messages_sent_shape check (
    (status = 'SENT' and sent_at is not null and external_id is not null)
    or (status <> 'SENT' and sent_at is null and external_id is null)
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

-- FAILED is excluded here but not from webhook_events_pending (0058), and
-- that asymmetry is deliberate rather than an oversight. On the outbound
-- side a retryable failure is written back as PENDING with a future
-- next_attempt_at, so FAILED here means permanent or the retry ladder is
-- spent -- terminal, and rightly excluded from the sendable scan. On the
-- inbound side FAILED is transient: it means "try again", and
-- webhook_events_pending scans it back in for exactly that reason.
create index outbox_messages_sendable
  on public.outbox_messages (next_attempt_at)
  where status in ('PENDING', 'SENDING');

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
grant select, update on public.outbox_messages to service_role;

comment on table public.outbox_messages is
  'Outbound messages as rows, so a reply commits in the same transaction as the participation it announces. dedupe_key is unique and is keyed on the MESSAGE (''<sha256 of the wamid>:confirmation''), not on the participation: reprocessing an event by hand writes a new participation, so a participation-keyed value would have produced a second reply and never fired the constraint at all. Keyed on the message the promise is real and matches the inbound side, whose idempotency is already (provider, external_id) on webhook_events; the value is the HASH of the wamid, following external_id, because the raw id is not anonymous and this column is not pruned either. RLS enabled with no policy — service_role only.';
comment on column public.outbox_messages.external_id is
  'The wamid Meta returns once it accepts the send. Null until then, and null forever on a row that never succeeded.';
