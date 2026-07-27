-- Roles held on a membership. Granular permissions arrive in Block 1b as
-- tables that read this column; the column is not discarded then.
create type public.member_role as enum ('owner', 'operator', 'viewer');

-- Subscription state of a Company. A Company is created active (the contract
-- was signed before provisioning) and is suspended for non-payment.
create type public.company_status as enum ('active', 'suspended');

-- Application-level user data. auth.users is owned by Supabase; this mirrors
-- the subset the app needs and adds the provisional-password flags.
create table public.profiles (
  id                       uuid primary key references auth.users (id) on delete cascade,
  email                    text not null,
  full_name                text,
  must_change_password     boolean not null default false,
  provisional_expires_at   timestamptz,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  deleted_at               timestamptz
);

comment on table public.profiles is 'Application-level user data mirroring auth.users.';
comment on column public.profiles.must_change_password is 'While true, every route redirects to the change-password screen.';
comment on column public.profiles.provisional_expires_at is 'Sign-in is refused after this instant while must_change_password is true.';

create table public.organizations (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz
);

comment on table public.organizations is 'Top tenant level. Created at provisioning time and always active.';

create table public.companies (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid not null references public.organizations (id),
  name              text not null,
  status            public.company_status not null default 'active',
  timezone          text not null default 'America/Sao_Paulo',
  provisioned_by    uuid references auth.users (id),
  provisioned_at    timestamptz not null default now(),
  suspended_at      timestamptz,
  suspension_reason text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  deleted_at        timestamptz
);

comment on table public.companies is 'The business tenant (prose: Station). Suspended when the subscription lapses.';

create table public.organization_memberships (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references auth.users (id) on delete cascade,
  organization_id  uuid not null references public.organizations (id),
  role             public.member_role not null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  deleted_at       timestamptz
);

create table public.company_memberships (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users (id) on delete cascade,
  company_id  uuid not null references public.companies (id),
  role        public.member_role not null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz
);

comment on table public.company_memberships is 'Internal panel users linked to a Company. NOT the audience — that is public.members, in a later block.';

-- Who may provision and suspend. The app owner, cross-tenant.
create table public.platform_admins (
  user_id     uuid primary key references auth.users (id) on delete cascade,
  created_at  timestamptz not null default now()
);

comment on table public.platform_admins is 'Cross-tenant super-admins. The controlled bypass required by the spec, never an exposed service_role.';

-- Partial unique indexes: a membership can be archived and recreated without
-- colliding with the logically deleted row (spec N5).
create unique index organization_memberships_unique
  on public.organization_memberships (user_id, organization_id)
  where deleted_at is null;

create unique index company_memberships_unique
  on public.company_memberships (user_id, company_id)
  where deleted_at is null;

-- These two indexes carry every RLS helper. They are the reason a
-- membership subquery per policy check stays cheap.
create index organization_memberships_lookup
  on public.organization_memberships (user_id, organization_id)
  where deleted_at is null;

create index company_memberships_lookup
  on public.company_memberships (user_id, company_id)
  where deleted_at is null;

create index companies_organization_idx
  on public.companies (organization_id)
  where deleted_at is null;
