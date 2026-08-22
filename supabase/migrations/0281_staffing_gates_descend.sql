-- supabase/migrations/0281_staffing_gates_descend.sql

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

  -- P5b. THE QUESTION IS ABOUT ONE STATION AND THE GATE ASKED ABOUT THE GROUP.
  -- This door already takes a company; has_org_permission answered "does this
  -- person administer the Organization", so a Station's OWNER -- 0278's concept,
  -- held by every Organization owner since 0280 -- could not staff the Station
  -- they own, while somebody holding users.manage at a SISTER Station could.
  --
  -- has_permission carries the Station-owner branch 0279 added, so an owner
  -- passes without holding any role, which is what ownership means here. It also
  -- carries D19's narrowing, so a group's user who is not an owner and holds no
  -- role gets nothing: users.manage is a WRITE.
  if not public.has_permission('users.manage', p_company_id) then
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

  -- The composite foreign key proves the role belongs to this Organization; it
  -- says nothing about deleted_at, because roles_id_org_unique is non-partial —
  -- it has to be, since a foreign key cannot reference a partial index. So an
  -- archived role would still satisfy the FK, and assigning one would resurrect
  -- permissions the owner believed retired. FOR SHARE holds the row against a
  -- concurrent delete_role, which takes FOR UPDATE on it.
  perform 1 from public.roles
   where id = p_role_id and organization_id = v_org and deleted_at is null
     for share;

  if not found then
    raise exception 'role not found in this organization: %', p_role_id using errcode = 'P0002';
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
  v_id    uuid;
begin
  select organization_id into v_org
  from public.companies
  where id = p_company_id and deleted_at is null;

  if not found then
    raise exception 'company not found: %', p_company_id using errcode = 'P0002';
  end if;

  -- P5b. THE QUESTION IS ABOUT ONE STATION AND THE GATE ASKED ABOUT THE GROUP.
  -- This door already takes a company; has_org_permission answered "does this
  -- person administer the Organization", so a Station's OWNER -- 0278's concept,
  -- held by every Organization owner since 0280 -- could not staff the Station
  -- they own, while somebody holding users.manage at a SISTER Station could.
  --
  -- has_permission carries the Station-owner branch 0279 added, so an owner
  -- passes without holding any role, which is what ownership means here. It also
  -- carries D19's narrowing, so a group's user who is not an owner and holds no
  -- role gets nothing: users.manage is a WRITE.
  if not public.has_permission('users.manage', p_company_id) then
    raise log 'remove_company_access denied: actor=% company=%', v_actor, p_company_id;
    raise exception 'permission denied: users.manage required' using errcode = '42501';
  end if;

  -- Soft delete, and it cuts immediately: the helpers query this table on every
  -- check, so the next request from an open session already fails.
  update public.company_memberships
     set deleted_at = now(), updated_at = now()
   where user_id = p_user_id and company_id = p_company_id and deleted_at is null
  returning id into v_id;

  -- Without this, a call that matched nothing still writes a success row, and
  -- the audit trail claims access was removed from someone who never had it.
  -- The caller gets no error either. Same shape as revoke_invitation in 0013.
  if not found then
    raise exception 'that user has no access to this company' using errcode = 'P0002';
  end if;

  insert into public.audit_logs
    (actor_id, action, target_table, target_id, organization_id, detail)
  values
    (v_actor, 'remove_company_access', 'company_memberships', v_id, v_org,
     jsonb_build_object('user_id', p_user_id, 'company_id', p_company_id));
end;
$$;

comment on function public.assign_company_role(uuid, uuid, uuid) is
  'Gives one user one role at one Station, or moves them to another. Gated on users.manage AT THAT STATION since 0281, not across the Organization: this door always took a company, and asking has_org_permission answered a question about the group. A Station''s owner (0278) therefore staffs the Station they own without holding a role there, and a delegate holding users.manage at a sister Station no longer reaches this one.';

comment on function public.remove_company_access(uuid, uuid) is
  'Takes away one user''s access to one Station. Gated the same way assign_company_role is, and for the same reason: granting and revoking are one authority seen from two sides, so they must ask the same question of the same Station (0281).';
