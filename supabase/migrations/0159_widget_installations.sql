-- supabase/migrations/0159_widget_installations.sql

-- Block 17a, design D4. One installation per Station, and a key that is
-- deliberately NOT a credential.
--
-- THE NAME IS THE WARNING. This value travels in the `src` of an <iframe> on a
-- Station's public website, so it is readable by anybody who views source. A
-- reader who mistakes it for a secret will build the wrong defence: they will
-- reach for hashing and rotation, and leave the origin allowlist and the rate
-- limits -- which are what actually hold this door -- as an afterthought.
-- It identifies a Station. It authenticates nobody. The visitor is
-- authenticated by the code in 0161, and by nothing else.

-- A CHECK may not contain a subquery, and asking "does every element of this
-- array match" needs one. `has_no_duplicates` (0040) is the precedent and its
-- comment is the reasoning: an immutable function is the only way to state the
-- rule in the schema rather than in prose.
create or replace function public.are_origins(p_values text[])
returns boolean
language sql
immutable
parallel safe
set search_path = pg_catalog
as $$
  select p_values is null
      or not exists (
        select 1 from unnest(p_values) as v
         where v !~ '^https?://[A-Za-z0-9.-]+(:[0-9]{1,5})?$');
$$;

comment on function public.are_origins(text[]) is
  'True when every entry is a scheme and a host, with an optional port, and nothing else -- the grammar a browser matches frame-ancestors against. Exists because a CHECK cannot contain a subquery.';

create table public.widget_installations (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id),
  company_id      uuid not null,
  public_key      text not null,
  -- FALSE by default, and that is a decision rather than a convention. Creating
  -- an installation is the console admin describing an intention; serving a
  -- widget to the public is a second, separate act.
  enabled         boolean not null default false,
  -- Empty means "frames nowhere". It is NOT a synonym for "any" -- an allowlist
  -- that falls open when unconfigured is how a widget ends up embeddable from
  -- anywhere with nothing on any screen to say so.
  allowed_origins text[] not null default '{}',
  created_by      uuid references auth.users (id),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  deleted_at      timestamptz,

  constraint widget_installations_company_org_fk
    foreign key (company_id, organization_id)
    references public.companies (id, organization_id),

  constraint widget_installations_key_shape
    check (public_key ~ '^pw_[A-Za-z0-9_-]{22}$'),

  -- Scheme and host, nothing else: no path, no trailing slash, no query. This
  -- is the exact grammar a browser matches frame-ancestors against, so anything
  -- looser here fails later as "the widget will not load", which is a much
  -- worse failure than a refused write -- nothing logs it and nobody can see it
  -- from a screen.
  --
  -- Through a function because A CHECK MAY NOT CONTAIN A SUBQUERY and testing
  -- every element of an array needs one. 0040 hit this exact wall and its
  -- comment states the cure: wrapping it in an immutable function is the only
  -- way to state the rule in the schema rather than in prose.
  constraint widget_installations_origins_shape
    check (public.are_origins(allowed_origins))
);

-- Partial on deleted_at, the shape message_templates (0110) uses and for the
-- reason its comment gives: without it, archiving a stale installation would
-- leave the console unable to create its replacement.
create unique index widget_installations_company_unique
  on public.widget_installations (company_id)
  where deleted_at is null;

create unique index widget_installations_key_unique
  on public.widget_installations (public_key)
  where deleted_at is null;

comment on table public.widget_installations is
  'One embeddable widget per Station. RLS on and NO POLICY, the shape integrations (0057) and api_credentials (0148) use: this schema revokes the default ACL, so createServiceClient().from(''widget_installations'') fails with 42501 and every reader is inside a SECURITY DEFINER body.';

comment on column public.widget_installations.public_key is
  'NOT A SECRET, and named so nobody has to guess. It travels in the src of an iframe on a public page. It names a Station; it proves nothing about who is asking. What defends this door is allowed_origins, the rate limits in 0161, and the verification code -- not this column.';

comment on column public.widget_installations.allowed_origins is
  'Full origins, scheme and host only, matched by the browser against frame-ancestors. EMPTY MEANS NOWHERE, deliberately: an allowlist that means "any" when unconfigured is a hole that no screen would show.';

alter table public.widget_installations enable row level security;
revoke all on public.widget_installations from anon, authenticated;
