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
  -- than the worker being careful. Shape: '<participation_id>:confirmation'.
  dedupe_key text not null check (length(btrim(dedupe_key)) > 0),

  status          public.outbox_status not null default 'PENDING',
  attempts        integer not null default 0 check (attempts >= 0),
  last_error      text,
  next_attempt_at timestamptz not null default now(),
  external_id     text,
  created_at      timestamptz not null default now(),
  sent_at         timestamptz,

  constraint outbox_messages_company_org_fk
    foreign key (company_id, organization_id)
    references public.companies (id, organization_id),
  constraint outbox_messages_dedupe_unique unique (provider, dedupe_key)
);

create index outbox_messages_sendable
  on public.outbox_messages (next_attempt_at)
  where status in ('PENDING', 'SENDING');

alter table public.outbox_messages enable row level security;
-- No policy. See integrations (0057).

comment on table public.outbox_messages is
  'Outbound messages as rows, so a reply commits in the same transaction as the participation it announces. dedupe_key is unique: reprocessing an event by hand cannot send its confirmation twice, and that is held by the schema rather than by the worker remembering. RLS enabled with no policy — service_role only.';
comment on column public.outbox_messages.external_id is
  'The wamid Meta returns once it accepts the send. Null until then, and null forever on a row that never succeeded.';
