-- Creating the auth user is the Supabase Admin API; creating the tenant is
-- SQL. There is no transaction spanning the two, so the caller creates the
-- user first and deletes it if this function fails (see services/provisioning.ts).
-- Everything below IS atomic: organization, company, both memberships, the
-- profile flags and the audit entry either all land or none do.
--
-- On the denied paths these functions RAISE LOG rather than writing to
-- audit_logs. An INSERT followed by RAISE EXCEPTION in the same transaction is
-- discarded when that transaction aborts, so an audit row written there could
-- never commit. The server log survives the rollback; the application also
-- records a denial row from outside the failed transaction when the call came
-- through the app (services/provisioning.ts).
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
  -- SECURITY DEFINER bypasses RLS, so the permission check must live here.
  if not public.is_platform_admin() then
    raise log 'provision_customer denied: actor=% target_user=%', v_actor, p_user_id;
    raise exception 'permission denied: platform admin required'
      using errcode = '42501';
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

  insert into public.company_memberships (user_id, company_id, role)
  values (p_user_id, v_comp, 'owner');

  update public.profiles
     set must_change_password   = true,
         provisional_expires_at = now() + interval '7 days',
         updated_at             = now()
   where id = p_user_id;

  if not found then
    raise exception 'profile not found for user %', p_user_id using errcode = 'P0002';
  end if;

  insert into public.audit_logs
    (actor_id, action, target_table, target_id, organization_id, company_id, detail)
  values
    (v_actor, 'provision_customer', 'companies', v_comp, v_org, v_comp,
     jsonb_build_object('owner_user_id', p_user_id, 'organization_name', trim(p_organization_name)));

  return jsonb_build_object('organization_id', v_org, 'company_id', v_comp);
end;
$$;

create or replace function public.suspend_company(
  p_company_id uuid,
  p_reason     text
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor uuid := auth.uid();
  v_org   uuid;
begin
  if not public.is_platform_admin() then
    raise log 'suspend_company denied: actor=% company=%', v_actor, p_company_id;
    raise exception 'permission denied: platform admin required'
      using errcode = '42501';
  end if;

  update public.companies
     set status            = 'suspended',
         suspended_at      = now(),
         suspension_reason = p_reason,
         updated_at        = now()
   where id = p_company_id and deleted_at is null
   returning organization_id into v_org;

  if not found then
    raise exception 'company not found: %', p_company_id using errcode = 'P0002';
  end if;

  insert into public.audit_logs
    (actor_id, action, target_table, target_id, organization_id, company_id, detail)
  values
    (v_actor, 'suspend_company', 'companies', p_company_id, v_org, p_company_id,
     jsonb_build_object('reason', p_reason));
end;
$$;

create or replace function public.reactivate_company(p_company_id uuid)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor uuid := auth.uid();
  v_org   uuid;
begin
  if not public.is_platform_admin() then
    raise log 'reactivate_company denied: actor=% company=%', v_actor, p_company_id;
    raise exception 'permission denied: platform admin required'
      using errcode = '42501';
  end if;

  update public.companies
     set status            = 'active',
         suspended_at      = null,
         suspension_reason = null,
         updated_at        = now()
   where id = p_company_id and deleted_at is null
   returning organization_id into v_org;

  if not found then
    raise exception 'company not found: %', p_company_id using errcode = 'P0002';
  end if;

  insert into public.audit_logs
    (actor_id, action, target_table, target_id, organization_id, company_id)
  values
    (v_actor, 'reactivate_company', 'companies', p_company_id, v_org, p_company_id);
end;
$$;

revoke execute on function public.provision_customer(uuid, text, text, text) from public;
revoke execute on function public.suspend_company(uuid, text) from public;
revoke execute on function public.reactivate_company(uuid) from public;

grant execute on function public.provision_customer(uuid, text, text, text) to authenticated;
grant execute on function public.suspend_company(uuid, text) to authenticated;
grant execute on function public.reactivate_company(uuid) to authenticated;
