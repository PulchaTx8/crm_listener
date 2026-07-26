-- Sensitive-operation trail. The spec requires this from every block onward.
-- actor_id is nullable: a failed privileged call by an unauthenticated caller
-- still deserves a record.
create table public.audit_logs (
  id               bigserial primary key,
  actor_id         uuid references auth.users (id),
  action           text not null,
  target_table     text,
  target_id        uuid,
  organization_id  uuid references public.organizations (id),
  company_id       uuid references public.companies (id),
  succeeded        boolean not null default true,
  detail           jsonb not null default '{}'::jsonb,
  created_at       timestamptz not null default now()
);

comment on table public.audit_logs is 'Trail of sensitive operations, successes and failures alike.';
comment on column public.audit_logs.detail is 'Never store credentials here. The provisional password is not recorded.';

create index audit_logs_created_idx on public.audit_logs (created_at desc);
create index audit_logs_actor_idx on public.audit_logs (actor_id, created_at desc);

create type public.contact_request_status as enum ('new', 'contacted', 'converted', 'discarded');

-- The only unauthenticated write in the system.
create table public.contact_requests (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  email         text not null,
  phone         text,
  company_name  text,
  message       text,
  status        public.contact_request_status not null default 'new',
  ip_hash       text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

comment on table public.contact_requests is 'Inbound interest from the public contact form.';
comment on column public.contact_requests.ip_hash is 'Hashed, never the raw address (data minimisation).';

create index contact_requests_status_idx on public.contact_requests (status, created_at desc);
