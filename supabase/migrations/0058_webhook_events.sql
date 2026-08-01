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
  )
);

create index webhook_events_pending
  on public.webhook_events (coalesce(next_attempt_at, received_at))
  where status in ('RECEIVED', 'FAILED');

alter table public.webhook_events enable row level security;
-- No policy. See integrations (0057) for why that is the deny and not an
-- oversight.

-- Design spec D9. The payload holds a phone number, a WhatsApp profile name and
-- the raw provider message id — personal data at rest in a table Block 3's
-- anonymize_member does not reach. Nulling it keeps the row, so a replayed
-- message is still refused a year later while the content that made it personal
-- is gone. That guarantee is why external_id above is a HASH: the idempotency
-- key has to survive this function, and a raw wamid would have been personal
-- data surviving it. This block ships the function; Block 11 schedules it
-- alongside the rest of N7.
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
     and received_at < now() - p_older_than;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke execute on function public.prune_webhook_payloads(interval) from public;
grant execute on function public.prune_webhook_payloads(interval) to service_role;

comment on table public.webhook_events is
  'One row per inbound message, written before anything is decided about it. (provider, external_id) unique is the idempotency guarantee the master spec asks for, held structurally — over the HASH of the provider message id, since idempotency is equality and a hash preserves equality exactly. payload is nullable because prune_webhook_payloads (design spec D9) clears it after 30 days while keeping the row, which is the whole reason external_id may not hold anything personal.';
comment on column public.webhook_events.external_id is
  'SHA-256 of the WhatsApp message id (wamid...), hex, hashed in Node before it reaches the database — NOT the id itself, and never the HTTP request id: Meta packs several messages into one POST and idempotency is per message. Hashed because a wamid decodes to bytes containing the counterparty phone number, so the raw value is not anonymous: it would put a recoverable phone into audit_logs, which design spec D2 forbids, and into a column that deliberately outlives the payload prune_webhook_payloads clears at thirty days. Hashed in Node rather than here for the reason members.cpf_hash gives (0031) — an argument passed to an RPC lands in query logs and in backups. The format CHECK refuses a raw id outright, so the guarantee does not rest on the route remembering. The raw id lives in payload, and expires with it.';
comment on column public.webhook_events.outcome is
  'Why this event finished. With status DONE it distinguishes recorded from no_integration, no_hashtag, no_promotion, promotion_cancelled and outside_window — all of which are silent to the listener (design spec D4) and all of which somebody will eventually have to explain.';
