-- Three values, not four. There is no `expired`, because expiry is derived from
-- expires_at at read time. An `expired` status would only be true if a cron
-- maintained it — and Block 1a shipped exactly that defect: provisional_expires_at
-- was written and read by nothing. State nobody maintains lies.
create type public.invitation_status as enum ('pending', 'accepted', 'revoked');

create table public.invitations (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations (id),
  email            text not null,
  role             public.member_role not null,
  token_hash       text not null,
  status           public.invitation_status not null default 'pending',
  expires_at       timestamptz not null,
  invited_by       uuid references auth.users (id),
  accepted_at      timestamptz,
  accepted_by      uuid references auth.users (id),
  revoked_at       timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

comment on table public.invitations is 'Pending access grants. The plaintext token is never stored.';
comment on column public.invitations.token_hash is 'SHA-256 of the token. A database dump yields no working link.';

-- One live invitation per address per Organization: re-inviting someone who
-- already has a pending link should be an explicit revoke-and-resend, not two
-- valid links in circulation.
create unique index invitations_pending_unique
  on public.invitations (organization_id, lower(email))
  where status = 'pending';

-- The acceptance lookup is by hash; it must be indexed and unique.
create unique index invitations_token_hash_unique on public.invitations (token_hash);

create index invitations_org_idx on public.invitations (organization_id, created_at desc);
