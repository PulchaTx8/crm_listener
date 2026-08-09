-- supabase/migrations/0148_api_credentials.sql

-- Block 15, design D1. The API key is the SUBJECT, not a borrowed identity.
--
-- Every write door in this product is SECURITY DEFINER and asks
-- has_permission(code, company), which since 0121 is
-- has_permission_for(auth.uid(), ...). A machine has no auth.uid(), so the whole
-- write surface of this application is, today, reachable only from a browser
-- holding a session cookie.
--
-- THE REJECTED ALTERNATIVE, recorded because it is the one a reader will think
-- of first: bind each key to a robot row in auth.users and gate on
-- has_permission_for. It reuses everything and needs no new vocabulary -- and it
-- needs a company_membership and a role, so the robot APPEARS ON THE TEAM
-- SCREEN AS IF IT WERE A PERSON. The day somebody tidies that user away, the
-- automation stops with a 403 nobody will connect to the cause.
--
-- So the credential carries its own scopes, and they are permission CODES
-- rather than a private vocabulary, so the API and the screens cannot come to
-- mean different things by the same word.
--
-- The actor recorded in audit_logs for these callers is NULL. That column has
-- been nullable since 0004 for exactly this class of caller, and 0129 states in
-- writing that a null there does not mean "the system did it" -- which is why
-- the detail names the credential.

create table public.api_credentials (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id),
  company_id      uuid not null,

  -- What the operator calls it in the console. Not an identifier.
  name            text not null,

  -- The first twelve characters of the secret, in the clear, so a list of keys
  -- can be told apart. Twelve is `ptx_` plus eight: enough to distinguish two
  -- rows on a screen, nowhere near enough to narrow a 256-bit secret.
  token_prefix    text not null,

  -- The WHOLE secret, SHA-256, lowercase hex. The secret itself is shown once
  -- at issue and never stored, so "show it to me again" is not a feature that
  -- was withheld -- there is nothing here to show.
  token_hash      text not null,

  expires_at      timestamptz,
  last_used_at    timestamptz,
  revoked_at      timestamptz,
  revoked_by      uuid references auth.users (id),
  created_by      uuid references auth.users (id),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  -- The Station, proved in a constraint rather than in a trigger -- the shape
  -- 0025 established for prizes and 0040 for promotions.
  constraint api_credentials_company_org_fk
    foreign key (company_id, organization_id)
    references public.companies (id, organization_id),

  constraint api_credentials_name_not_blank check (btrim(name) <> ''),

  -- The same shape rule webhook_events.external_id (0058) carries, and for the
  -- same reason: it refuses a RAW secret written into a column meant for a
  -- digest. A backstop, never a reason to relax the hashing in the caller.
  constraint api_credentials_hash_shape check (token_hash ~ '^[0-9a-f]{64}$'),
  constraint api_credentials_prefix_shape check (token_prefix ~ '^ptx_[A-Za-z0-9_-]{8}$'),

  -- The pair shape every archival column in this schema uses: a revocation is
  -- a time AND a person, or it is neither.
  constraint api_credentials_revocation_shape check (
    (revoked_at is null and revoked_by is null)
    or (revoked_at is not null and revoked_by is not null))
);

comment on table public.api_credentials is
  'Block 15, D1. One machine key for one Station. Holds the SHA-256 of the secret and never the secret. Revocable one at a time, which is the whole argument against a shared secret in the environment: revoking that one means a redeploy, and it means revoking it for everybody.';

comment on column public.api_credentials.token_prefix is
  'The first twelve characters of the secret, in the clear, so two keys can be told apart in a list. Never enough to reconstruct one.';
comment on column public.api_credentials.last_used_at is
  'Stamped by authenticate_api_credential (0149), and deliberately only when the stored value is over a minute old. Without that condition it is an UPDATE on one hot row for every request the automation ever makes.';

-- TOTAL, not partial, and the difference matters: a revoked key must stay
-- unusable rather than becoming reissuable. A partial index on live rows would
-- let the same secret be minted again, silently resurrecting a credential
-- somebody revoked on purpose.
create unique index api_credentials_hash_unique on public.api_credentials (token_hash);

create index api_credentials_company_idx
  on public.api_credentials (company_id, created_at desc);

-- ---------------------------------------------------------------------------
-- The scopes. A CHILD TABLE rather than a text[] column, and that IS the
-- decision: permission_code is a real foreign key, so a scope nobody defined is
-- refused by Postgres. A text[] would need a trigger to say the same thing, and
-- a trigger is a thing somebody can forget to write -- or to update when a
-- permission is renamed.
-- ---------------------------------------------------------------------------

create table public.api_credential_scopes (
  credential_id   uuid not null references public.api_credentials (id) on delete cascade,
  permission_code text not null references public.permissions (code),
  primary key (credential_id, permission_code)
);

comment on table public.api_credential_scopes is
  'Block 15. What one key may do, in permission codes. A foreign key against public.permissions, so the API and the screens share one vocabulary rather than two that drift.';

-- No policy follows either table, and that is the deny.
--
-- 0057's comment on integrations is worth restating here because it is the
-- sentence most likely to cost somebody a day: BYPASSING RLS IS NOT A TABLE
-- PRIVILEGE. This schema revokes the Supabase default ACL, so a role reaches a
-- table only through an explicit grant, and there is deliberately none here.
-- `createServiceClient().from('api_credentials')` WILL FAIL with 42501, and
-- that is the design rather than a bug to work around. Every reader of these
-- two tables is inside a SECURITY DEFINER body, and 0149 holds the whole list.
alter table public.api_credentials       enable row level security;
alter table public.api_credential_scopes enable row level security;
