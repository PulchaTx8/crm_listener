-- Scope decides which helper resolves a code, and it is what lets the role
-- editor warn that a permission reaches past the Company it is granted in.
create type public.permission_scope as enum ('organization', 'company');

alter table public.permissions
  add column module        text,
  add column label         text,
  add column scope         public.permission_scope,
  add column display_order integer not null default 0;

-- Block 1b's three codes are all Organization-scoped identity operations.
update public.permissions
   set module = 'organization',
       scope  = 'organization',
       label  = case code
                  when 'users.invite' then 'Invite people to the Organization'
                  when 'users.manage' then 'Assign roles and remove people'
                  when 'audit.view'   then 'Read the Organization''s audit trail'
                  else description
                end,
       display_order = case code
                  when 'users.invite' then 10
                  when 'users.manage' then 20
                  when 'audit.view'   then 30
                  else 0
                end;

alter table public.permissions
  alter column module set not null,
  alter column label  set not null,
  alter column scope  set not null;

comment on column public.permissions.module is 'Groups the checkbox in the role editor. The UI carries no copy of the catalogue.';
comment on column public.permissions.label is 'Human sentence shown beside the checkbox.';
comment on column public.permissions.scope is
  'organization: held through a role in ANY Company, it applies to the whole Organization. company: it applies only where the role is assigned.';

-- The job title the owner composes. It belongs to the Organization and is
-- reusable across its Companies; the assignment is per Company.
create table public.roles (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id),
  name            text not null,
  description     text,
  created_by      uuid references auth.users (id),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  deleted_at      timestamptz
);

comment on table public.roles is 'Roles the owner creates (Manager, Director). Organization-scoped, assigned per Company, exactly one per user per Company.';

create unique index roles_name_unique
  on public.roles (organization_id, lower(name))
  where deleted_at is null;

create index roles_organization_idx
  on public.roles (organization_id)
  where deleted_at is null;

-- These two composite keys exist only so 0016 can hang composite foreign keys
-- off them. That is what makes a role from another Organization structurally
-- unassignable: no trigger to forget, no RPC to bypass.
alter table public.roles     add constraint roles_id_org_unique     unique (id, organization_id);
alter table public.companies add constraint companies_id_org_unique unique (id, organization_id);

-- The old table is keyed by the member_role enum and holds three seeded rows,
-- all of them granting the owner — who now bypasses the lookup entirely. There
-- is nothing to migrate.
drop table public.role_permissions;

create table public.role_permissions (
  role_id         uuid not null references public.roles (id) on delete cascade,
  permission_code text not null references public.permissions (code) on delete cascade,
  primary key (role_id, permission_code)
);

comment on table public.role_permissions is 'What a role may do. Written only by the role RPCs in 0017.';

create index role_permissions_code_idx on public.role_permissions (permission_code);

-- A permission is born beside the feature it guards. This block guards role
-- administration; Block 2 inserts its inventory.* codes in its own migration
-- and they appear in the editor without it being touched.
insert into public.permissions (code, description, introduced_by_block, module, label, scope, display_order)
values ('roles.manage', 'Create, edit and delete the Organization''s roles', '1c',
        'organization', 'Administer roles', 'organization', 40);

-- The old role_permissions keyed by member_role is gone. This block's owner
-- bypasses the lookup; operator and viewer hold no permissions. The function
-- stays stable until 0016 wires up dynamic roles.
create or replace function public.has_permission(p_permission text, p_company_id uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select exists (select 1 from public.permissions p where p.code = p_permission)
     and public.has_company_access(p_company_id)
     and (
       public.is_platform_admin()
       or (
         select cm.role = 'owner'
         from public.company_memberships cm
         where cm.user_id = auth.uid()
           and cm.company_id = p_company_id
           and cm.deleted_at is null
       )
     );
$$;

comment on function public.has_permission(text, uuid) is
  'Valid permission code AND active subscription AND the role is owner (who bypasses the lookup).';

