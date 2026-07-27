-- supabase/migrations/0017_role_rpcs.sql

-- Shared shape: re-check the caller here, because SECURITY DEFINER bypasses RLS;
-- RAISE LOG on denial, because an audit INSERT followed by RAISE never commits.
--
-- roles.manage and users.manage are Organization-scoped. The two functions that
-- take a company_id resolve ITS Organization first and check against that —
-- never against an Organization id the caller supplied.

create or replace function public.create_role(
  p_organization_id uuid,
  p_name            text,
  p_description     text default null,
  p_permission_codes text[] default '{}'
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor   uuid := auth.uid();
  v_name    text := nullif(trim(p_name), '');
  v_id      uuid;
  v_unknown text;
begin
  if not public.has_org_permission('roles.manage', p_organization_id) then
    raise log 'create_role denied: actor=% org=%', v_actor, p_organization_id;
    raise exception 'permission denied: roles.manage required' using errcode = '42501';
  end if;

  if v_name is null then
    raise exception 'role name is required' using errcode = '22023';
  end if;

  -- Refusing an unknown code rather than skipping it: silently dropping one
  -- yields a role weaker than the screen showed, and nobody finds out until
  -- someone cannot do their job.
  select code into v_unknown
  from unnest(coalesce(p_permission_codes, '{}')) as code
  where not exists (select 1 from public.permissions p where p.code = code)
  limit 1;

  if v_unknown is not null then
    raise exception 'unknown permission code: %', v_unknown using errcode = '22023';
  end if;

  insert into public.roles (organization_id, name, description, created_by)
  values (p_organization_id, v_name, nullif(trim(coalesce(p_description, '')), ''), v_actor)
  returning id into v_id;

  insert into public.role_permissions (role_id, permission_code)
  select v_id, code from unnest(coalesce(p_permission_codes, '{}')) as code;

  insert into public.audit_logs
    (actor_id, action, target_table, target_id, organization_id, detail)
  values
    (v_actor, 'create_role', 'roles', v_id, p_organization_id,
     jsonb_build_object('name', v_name, 'permissions', to_jsonb(coalesce(p_permission_codes, '{}'))));

  return v_id;
end;
$$;

create or replace function public.update_role(
  p_role_id          uuid,
  p_name             text,
  p_description      text default null,
  p_permission_codes text[] default '{}'
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor   uuid := auth.uid();
  v_org     uuid;
  v_name    text := nullif(trim(p_name), '');
  v_before  jsonb;
  v_unknown text;
begin
  select organization_id into v_org
  from public.roles
  where id = p_role_id and deleted_at is null;

  if not found then
    raise exception 'role not found: %', p_role_id using errcode = 'P0002';
  end if;

  if not public.has_org_permission('roles.manage', v_org) then
    raise log 'update_role denied: actor=% role=%', v_actor, p_role_id;
    raise exception 'permission denied: roles.manage required' using errcode = '42501';
  end if;

  if v_name is null then
    raise exception 'role name is required' using errcode = '22023';
  end if;

  select code into v_unknown
  from unnest(coalesce(p_permission_codes, '{}')) as code
  where not exists (select 1 from public.permissions p where p.code = code)
  limit 1;

  if v_unknown is not null then
    raise exception 'unknown permission code: %', v_unknown using errcode = '22023';
  end if;

  select coalesce(jsonb_agg(permission_code order by permission_code), '[]'::jsonb)
    into v_before
  from public.role_permissions where role_id = p_role_id;

  update public.roles
     set name        = v_name,
         description = nullif(trim(coalesce(p_description, '')), ''),
         updated_at  = now()
   where id = p_role_id;

  -- Replace the set wholesale. A diff would be the same result with more ways
  -- to be wrong, and this runs inside one transaction.
  delete from public.role_permissions where role_id = p_role_id;
  insert into public.role_permissions (role_id, permission_code)
  select p_role_id, code from unnest(coalesce(p_permission_codes, '{}')) as code;

  insert into public.audit_logs
    (actor_id, action, target_table, target_id, organization_id, detail)
  values
    (v_actor, 'update_role', 'roles', p_role_id, v_org,
     jsonb_build_object('name', v_name, 'before', v_before,
                        'after', to_jsonb(coalesce(p_permission_codes, '{}'))));
end;
$$;

create or replace function public.delete_role(p_role_id uuid)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor  uuid := auth.uid();
  v_org    uuid;
  v_in_use integer;
begin
  select organization_id into v_org
  from public.roles
  where id = p_role_id and deleted_at is null;

  if not found then
    raise exception 'role not found: %', p_role_id using errcode = 'P0002';
  end if;

  if not public.has_org_permission('roles.manage', v_org) then
    raise log 'delete_role denied: actor=% role=%', v_actor, p_role_id;
    raise exception 'permission denied: roles.manage required' using errcode = '42501';
  end if;

  select count(*) into v_in_use
  from public.company_memberships
  where role_id = p_role_id and deleted_at is null;

  -- Reassign first. Archiving a role in use would leave people with no powers
  -- and nothing on screen to explain why.
  if v_in_use > 0 then
    raise exception 'role is assigned to % user(s); reassign them first', v_in_use
      using errcode = '23503';
  end if;

  update public.roles set deleted_at = now(), updated_at = now() where id = p_role_id;

  insert into public.audit_logs
    (actor_id, action, target_table, target_id, organization_id)
  values (v_actor, 'delete_role', 'roles', p_role_id, v_org);
end;
$$;

-- Creates the membership or moves it to another role. The composite foreign
-- keys reject a role from another Organization even if this body were wrong.
create or replace function public.assign_company_role(
  p_company_id uuid,
  p_user_id    uuid,
  p_role_id    uuid
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor uuid := auth.uid();
  v_org   uuid;
  v_id    uuid;
begin
  select organization_id into v_org
  from public.companies
  where id = p_company_id and deleted_at is null;

  if not found then
    raise exception 'company not found: %', p_company_id using errcode = 'P0002';
  end if;

  if not public.has_org_permission('users.manage', v_org) then
    raise log 'assign_company_role denied: actor=% company=%', v_actor, p_company_id;
    raise exception 'permission denied: users.manage required' using errcode = '42501';
  end if;

  if not exists (
    select 1 from public.organization_memberships
    where user_id = p_user_id and organization_id = v_org and deleted_at is null
  ) then
    raise exception 'that user does not belong to this organization' using errcode = '23503';
  end if;

  -- The owner is recognised by ownership and holds no membership row. Creating
  -- one would put them under a role, which is exactly what §4.6 removed.
  if exists (
    select 1 from public.organization_memberships
    where user_id = p_user_id and organization_id = v_org
      and role = 'owner' and deleted_at is null
  ) then
    raise exception 'the owner already has full access and takes no role' using errcode = '22023';
  end if;

  update public.company_memberships
     set role_id = p_role_id, updated_at = now()
   where user_id = p_user_id and company_id = p_company_id and deleted_at is null
  returning id into v_id;

  if v_id is null then
    insert into public.company_memberships (user_id, company_id, organization_id, role_id)
    values (p_user_id, p_company_id, v_org, p_role_id)
    returning id into v_id;
  end if;

  insert into public.audit_logs
    (actor_id, action, target_table, target_id, organization_id, detail)
  values
    (v_actor, 'assign_company_role', 'company_memberships', v_id, v_org,
     jsonb_build_object('user_id', p_user_id, 'company_id', p_company_id, 'role_id', p_role_id));

  return v_id;
end;
$$;

create or replace function public.remove_company_access(p_company_id uuid, p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor uuid := auth.uid();
  v_org   uuid;
begin
  select organization_id into v_org
  from public.companies
  where id = p_company_id and deleted_at is null;

  if not found then
    raise exception 'company not found: %', p_company_id using errcode = 'P0002';
  end if;

  if not public.has_org_permission('users.manage', v_org) then
    raise log 'remove_company_access denied: actor=% company=%', v_actor, p_company_id;
    raise exception 'permission denied: users.manage required' using errcode = '42501';
  end if;

  -- Soft delete, and it cuts immediately: the helpers query this table on every
  -- check, so the next request from an open session already fails.
  update public.company_memberships
     set deleted_at = now(), updated_at = now()
   where user_id = p_user_id and company_id = p_company_id and deleted_at is null;

  insert into public.audit_logs
    (actor_id, action, target_table, target_id, organization_id, detail)
  values
    (v_actor, 'remove_company_access', 'company_memberships', null, v_org,
     jsonb_build_object('user_id', p_user_id, 'company_id', p_company_id));
end;
$$;

-- Replaces change_member_role. It no longer propagates anything to
-- company_memberships: Company powers are the role's business now.
drop function if exists public.change_member_role(uuid, public.member_role);

create or replace function public.change_org_role(
  p_membership_id uuid,
  p_new_role      public.org_role
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor    uuid := auth.uid();
  v_org      uuid;
  v_user     uuid;
  v_old_role public.org_role;
begin
  select om.organization_id, om.user_id, om.role
    into v_org, v_user, v_old_role
  from public.organization_memberships om
  where om.id = p_membership_id and om.deleted_at is null;

  if not found then
    raise exception 'membership not found: %', p_membership_id using errcode = 'P0002';
  end if;

  if not public.has_org_permission('users.manage', v_org) then
    raise log 'change_org_role denied: actor=% membership=%', v_actor, p_membership_id;
    raise exception 'permission denied: users.manage required' using errcode = '42501';
  end if;

  update public.organization_memberships
     set role = p_new_role, updated_at = now()
   where id = p_membership_id;

  -- Promoting to owner removes the Company memberships: an owner reaches every
  -- Company by ownership and must not also sit under a role.
  if p_new_role = 'owner' then
    update public.company_memberships
       set deleted_at = now(), updated_at = now()
     where user_id = v_user and organization_id = v_org and deleted_at is null;
  end if;

  insert into public.audit_logs
    (actor_id, action, target_table, target_id, organization_id, detail)
  values
    (v_actor, 'change_org_role', 'organization_memberships', p_membership_id, v_org,
     jsonb_build_object('user_id', v_user, 'from', v_old_role, 'to', p_new_role));
end;
$$;

-- Per-Company roles cannot be exercised against an Organization that can only
-- ever hold one Company. The self-service lifecycle stays in Block 10.
create or replace function public.add_company(
  p_organization_id uuid,
  p_name            text,
  p_timezone        text default 'America/Sao_Paulo'
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor uuid := auth.uid();
  v_id    uuid;
begin
  if not public.is_platform_admin() then
    raise log 'add_company denied: actor=% org=%', v_actor, p_organization_id;
    raise exception 'permission denied: platform admin required' using errcode = '42501';
  end if;

  if coalesce(trim(p_name), '') = '' then
    raise exception 'company name is required' using errcode = '22023';
  end if;

  if not exists (select 1 from public.organizations where id = p_organization_id and deleted_at is null) then
    raise exception 'organization not found: %', p_organization_id using errcode = 'P0002';
  end if;

  insert into public.companies (organization_id, name, timezone, provisioned_by)
  values (p_organization_id, trim(p_name), p_timezone, v_actor)
  returning id into v_id;

  insert into public.audit_logs
    (actor_id, action, target_table, target_id, organization_id, detail)
  values
    (v_actor, 'add_company', 'companies', v_id, p_organization_id,
     jsonb_build_object('name', trim(p_name)));

  return v_id;
end;
$$;

revoke execute on function public.create_role(uuid, text, text, text[])          from public;
revoke execute on function public.update_role(uuid, text, text, text[])          from public;
revoke execute on function public.delete_role(uuid)                              from public;
revoke execute on function public.assign_company_role(uuid, uuid, uuid)          from public;
revoke execute on function public.remove_company_access(uuid, uuid)              from public;
revoke execute on function public.change_org_role(uuid, public.org_role)         from public;
revoke execute on function public.add_company(uuid, text, text)                  from public;

grant execute on function public.create_role(uuid, text, text, text[])           to authenticated;
grant execute on function public.update_role(uuid, text, text, text[])           to authenticated;
grant execute on function public.delete_role(uuid)                               to authenticated;
grant execute on function public.assign_company_role(uuid, uuid, uuid)           to authenticated;
grant execute on function public.remove_company_access(uuid, uuid)               to authenticated;
grant execute on function public.change_org_role(uuid, public.org_role)          to authenticated;
grant execute on function public.add_company(uuid, text, text)                   to authenticated;
