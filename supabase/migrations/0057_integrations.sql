-- One WhatsApp number per Station (design spec D3). The number that received a
-- message is the only thing in an inbound payload that says which Station it
-- belongs to, so this table is the whole of "whose message is this?".
--
-- No secret lives here (D6). Under one Meta App the access token belongs to the
-- WABA and serves every number under it, so the three secrets are environment
-- variables validated at boot. When a customer brings their own WABA — Block
-- 10, which owns the configuration screen — the token moves onto this row and
-- is encrypted there.

create type public.integration_provider as enum ('WHATSAPP');

create table public.integrations (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id),
  company_id      uuid not null,
  provider        public.integration_provider not null,

  -- Meta's id for the number, at
  -- entry[].changes[].value.metadata.phone_number_id in every inbound payload.
  -- Text and not a number: Meta's ids exceed bigint range in practice and are
  -- opaque identifiers rather than quantities.
  phone_number_id      text not null check (length(btrim(phone_number_id)) > 0),
  display_phone_number text,
  waba_id              text,

  -- Defaults to false so a half-configured row cannot start taking traffic
  -- between the insert and the rest of the runbook.
  enabled boolean not null default false,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users (id),
  deleted_at timestamptz,
  deleted_by uuid references auth.users (id),

  constraint integrations_company_org_fk
    foreign key (company_id, organization_id)
    references public.companies (id, organization_id),

  constraint integrations_archival_shape check (
    (deleted_at is null and deleted_by is null)
    or (deleted_at is not null and deleted_by is not null)
  )
);

-- Both partial, and for the same reason: moving a number from Station A to
-- Station B means soft-deleting A's row and inserting B's. A total unique
-- constraint would refuse that second insert forever, which is the shape of
-- rule this project prefers to state once rather than discover in support.
create unique index integrations_number_live
  on public.integrations (provider, phone_number_id) where deleted_at is null;
create unique index integrations_one_per_company
  on public.integrations (company_id, provider) where deleted_at is null;

alter table public.integrations enable row level security;

-- No policy follows, and that is the deny. This is a system table: service_role
-- bypasses RLS and is its only reader and writer in this block. The operator's
-- view of it is Block 10's and will arrive with the policy that admits it.

comment on table public.integrations is
  'Maps a WhatsApp number to the Station it serves. RLS is enabled with NO policy: nothing reaches this table through a user-scoped client, by design. Holds no secret (design spec D6) — the WABA access token is an environment variable until Block 10 lets a customer bring their own WABA. Both unique indexes are partial on deleted_at so a number can be moved between Stations.';
comment on column public.integrations.phone_number_id is
  'Meta''s id for the number, not the dialable number. This is what arrives in every inbound payload and the only field that resolves a message to a Station.';
comment on column public.integrations.enabled is
  'False by default so a row inserted halfway through the runbook does not start taking traffic before its environment variables exist.';
