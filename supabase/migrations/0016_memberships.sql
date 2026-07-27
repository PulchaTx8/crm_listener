-- supabase/migrations/0016_memberships.sql

-- operator and viewer were shorthands for permission sets that are now roles.
-- Only owner still carries meaning at Organization level.
create type public.org_role as enum ('owner', 'member');

alter table public.organization_memberships add column role_new public.org_role;

update public.organization_memberships
   set role_new = case when role = 'owner' then 'owner'::public.org_role
                       else 'member'::public.org_role end;

alter table public.organization_memberships alter column role_new set not null;

-- The last-owner trigger is dropped and recreated around the swap. Its body
-- reads `role`, and leaving it attached through a drop-and-rename is asking for
-- a fire against a column that momentarily does not exist.
drop trigger organization_memberships_keep_owner on public.organization_memberships;
alter table public.organization_memberships drop column role;
alter table public.organization_memberships rename column role_new to role;

create constraint trigger organization_memberships_keep_owner
after update or delete on public.organization_memberships
deferrable initially deferred
for each row execute function public.enforce_last_owner();

-- The owner holds Company powers by ownership. Keeping their membership row
-- would make them the only user in the system obliged to carry a role in order
-- to exercise powers they already have.
delete from public.company_memberships cm
 using public.companies c, public.organization_memberships om
 where c.id = cm.company_id
   and om.organization_id = c.organization_id
   and om.user_id = cm.user_id
   and om.role = 'owner';

alter table public.company_memberships add column organization_id uuid;

update public.company_memberships cm
   set organization_id = c.organization_id
  from public.companies c
 where c.id = cm.company_id;

alter table public.company_memberships alter column organization_id set not null;

-- Every surviving row is a non-owner membership, and Block 1b granted operator
-- and viewer no permissions at all. Recreating that as an empty role is not a
-- downgrade: it is the same power, now a row the owner can see and edit.
-- Soft-deleted rows are included, because the column below is NOT NULL and a
-- historical row still has to point somewhere.
insert into public.roles (organization_id, name, description)
select distinct cm.organization_id,
       initcap(cm.role::text),
       'Created when Block 1c replaced fixed roles. Holds no permissions, exactly as this role did before.'
  from public.company_memberships cm
on conflict do nothing;

alter table public.company_memberships add column role_id uuid;

update public.company_memberships cm
   set role_id = r.id
  from public.roles r
 where r.organization_id = cm.organization_id
   and lower(r.name) = lower(cm.role::text)
   and r.deleted_at is null;

alter table public.company_memberships alter column role_id set not null;
alter table public.company_memberships drop column role;

-- One role per user per Company needs no rule of its own: it is one column, so
-- a second value cannot exist. What does need stating is that the Company and
-- the role belong to the SAME Organization — two composite foreign keys sharing
-- organization_id say it declaratively.
alter table public.company_memberships
  add constraint company_memberships_company_org_fk
    foreign key (company_id, organization_id)
    references public.companies (id, organization_id),
  add constraint company_memberships_role_org_fk
    foreign key (role_id, organization_id)
    references public.roles (id, organization_id);

create index company_memberships_role_idx
  on public.company_memberships (role_id)
  where deleted_at is null;

create index company_memberships_org_idx
  on public.company_memberships (organization_id)
  where deleted_at is null;

-- ---------------------------------------------------------------------------
-- The three helpers. They move in this migration and not a later one because
-- has_permission's body reads the column just dropped; splitting them would
-- leave the database inconsistent between two migrations.
-- ---------------------------------------------------------------------------

create or replace function public.has_company_access(p_company_id uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select exists (
    select 1
    from public.companies c
    where c.id = p_company_id
      and c.status = 'active'
      and c.deleted_at is null
      and (
        public.is_platform_admin()
        or public.is_owner(c.organization_id)
        or exists (
          select 1 from public.company_memberships cm
          where cm.user_id = auth.uid()
            and cm.company_id = c.id
            and cm.deleted_at is null
        )
      )
  );
$$;

comment on function public.has_company_access(uuid) is
  'Active subscription AND (platform admin OR owner of the Organization OR a live membership). The owner holds no membership row by design.';

-- The existence check stays OUTSIDE every bypass. Written the obvious way,
-- `is_platform_admin() or exists(...)` short-circuits before permission_code is
-- ever compared, and a typo would return true for an admin on any Company
-- (Block 1b §3).
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
       or exists (
         select 1 from public.companies c
         where c.id = p_company_id and public.is_owner(c.organization_id)
       )
       or exists (
         select 1
         from public.company_memberships cm
         join public.role_permissions rp on rp.role_id = cm.role_id
         where cm.user_id = auth.uid()
           and cm.company_id = p_company_id
           and cm.deleted_at is null
           and rp.permission_code = p_permission
       )
     );
$$;

comment on function public.has_permission(text, uuid) is
  'Valid code AND active subscription AND (admin OR owner OR the role assigned in THAT Company grants it).';

-- Organization-scoped codes are held through a role in any Company, so this
-- searches every Company of the Organization. The active-subscription term is
-- what stops a lapsed customer from still inviting users and reading the audit
-- trail through a role in a suspended Station.
create or replace function public.has_org_permission(p_permission text, p_organization_id uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select exists (select 1 from public.permissions p where p.code = p_permission)
     and (
       public.is_platform_admin()
       or public.is_owner(p_organization_id)
       or exists (
         select 1
         from public.company_memberships cm
         join public.companies c          on c.id = cm.company_id
         join public.role_permissions rp  on rp.role_id = cm.role_id
         where cm.user_id = auth.uid()
           and cm.organization_id = p_organization_id
           and cm.deleted_at is null
           and c.status = 'active'
           and c.deleted_at is null
           and rp.permission_code = p_permission
       )
     );
$$;

comment on function public.has_org_permission(text, uuid) is
  'Valid code AND (admin OR owner OR a role in any ACTIVE Company of the Organization grants it).';

-- provision_customer stops writing the owner's Company membership. Everything
-- else in it is unchanged; it is repeated in full because CREATE OR REPLACE
-- takes the whole body.
create or replace function public.provision_customer(
  p_user_id           uuid,
  p_organization_name text,
  p_company_name      text,
  p_timezone          text default 'America/Sao_Paulo'
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor uuid := auth.uid();
  v_org   uuid;
  v_comp  uuid;
begin
  if not public.is_platform_admin() then
    raise log 'provision_customer denied: actor=% target_user=%', v_actor, p_user_id;
    raise exception 'permission denied: platform admin required' using errcode = '42501';
  end if;

  if coalesce(trim(p_organization_name), '') = '' then
    raise exception 'organization name is required' using errcode = '22023';
  end if;
  if coalesce(trim(p_company_name), '') = '' then
    raise exception 'company name is required' using errcode = '22023';
  end if;

  insert into public.organizations (name)
  values (trim(p_organization_name))
  returning id into v_org;

  insert into public.companies (organization_id, name, timezone, provisioned_by)
  values (v_org, trim(p_company_name), p_timezone, v_actor)
  returning id into v_comp;

  insert into public.organization_memberships (user_id, organization_id, role)
  values (p_user_id, v_org, 'owner');

  update public.profiles
     set must_change_password   = true,
         provisional_expires_at = now() + interval '7 days',
         updated_at             = now()
   where id = p_user_id;

  insert into public.audit_logs
    (actor_id, action, target_table, target_id, organization_id, detail)
  values
    (v_actor, 'provision_customer', 'organizations', v_org, v_org,
     jsonb_build_object('company_id', v_comp, 'owner_user_id', p_user_id));

  return jsonb_build_object('organization_id', v_org, 'company_id', v_comp);
end;
$$;
