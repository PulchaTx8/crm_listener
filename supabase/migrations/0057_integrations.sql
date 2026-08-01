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

-- No policy follows, and that is the deny. This is a system table, and the
-- operator's view of it is Block 10's, arriving with the policy that admits it.
--
-- BUT NOT "service_role reads it", WHICH IS WHAT THIS COMMENT USED TO SAY AND
-- IS THE SENTENCE MOST LIKELY TO BREAK THIS BLOCK AGAIN. Bypassing RLS is not
-- a table privilege: this schema revokes the Supabase default ACL, so a role
-- reaches a table only through an explicit grant, and there is deliberately no
-- table grant here. Every reader of this table is INSIDE a SECURITY DEFINER
-- body that runs as the owner -- ingest_whatsapp_event (0062) resolves the
-- Station from the inbound number, claim_outbox_batch (0063) joins it for the
-- number to send FROM -- and that is the whole list.
--
-- So `createServiceClient().from('integrations')` WILL FAIL with 42501, and
-- that is the intended answer rather than a gap to be patched when somebody
-- meets it. It is not hypothetical: at 24b32d2 the worker read this table
-- through a PostgREST resource embed, `integrations(phone_number_id)`, which
-- needs exactly the grant this comment refuses; the embed was replaced by
-- claim_outbox_batch in review, and the grant became unnecessary rather than
-- ever having been present. The identical omission on webhook_events and
-- outbox_messages had already made Task 11's webhook route answer 42501 to
-- every inbound message while every test in the repository passed. If a future
-- caller needs this table from PostgREST, add the grant DELIBERATELY, with the
-- assertion that pins it -- do not conclude from this comment that it is
-- already there.
revoke all      on public.integrations from anon, authenticated;
-- TRUNCATE comes from the default ACL and is mentioned by no grant, being
-- neither INSERT, UPDATE nor DELETE. 0029 found this class of hole in review
-- and 0035, 0046 and 0050 have closed it since; immutability is a grant, not a
-- comment.
revoke truncate on public.integrations from service_role;

comment on table public.integrations is
  'Maps a WhatsApp number to the Station it serves. RLS is enabled with NO policy: nothing reaches this table through a user-scoped client, by design. Holds no secret (design spec D6) — the WABA access token is an environment variable until Block 10 lets a customer bring their own WABA. Both unique indexes are partial on deleted_at so a number can be moved between Stations.';
comment on column public.integrations.phone_number_id is
  'Meta''s id for the number, not the dialable number. This is what arrives in every inbound payload and the only field that resolves a message to a Station.';
comment on column public.integrations.enabled is
  'False by default so a row inserted halfway through the runbook does not start taking traffic before its environment variables exist.';
