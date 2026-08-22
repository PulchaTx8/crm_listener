-- supabase/migrations/0280_station_owner_backfill.sql

-- NOBODY WAKES UP UNABLE TO WORK.
--
-- 0277 narrowed the group's blanket to reads and 0279 gave a Station owners of
-- its own; between them they describe the model correctly and, applied to a
-- database that has never heard of a Station owner, would stop every customer
-- from operating on the morning of the deploy. So every Organization owner
-- becomes an owner of every Station of their group.
--
-- WHAT ACTUALLY CHANGES, since day-one behaviour is deliberately identical: the
-- power stops being a branch inside a function and becomes a row. It shows on
-- the users screen, it can be taken away from one Station without touching the
-- others, and a group user added tomorrow does not inherit it. None of those
-- three was possible before -- the old clause could not be revoked at all.
--
-- TWO STATEMENTS BECAUSE OF ONE INDEX. company_memberships_unique is
-- (user_id, company_id) WHERE deleted_at is null, so an owner who ALREADY works
-- at one of their Stations under a role must be updated rather than inserted --
-- a second row would be refused, and refusing here would abort the migration
-- over the most ordinary case there is.
-- A FUNCTION, for the reason 0274 records about the person backfill: on a
-- database where no Organization owner exists yet this does nothing, so a test
-- re-typing its statements would pass whether or not this file existed. It is
-- also idempotent by its own predicates -- it only touches memberships that are
-- not already owners -- so a run stopped part way is resumed by calling it
-- again rather than by editing an applied migration.
create or replace function public.backfill_station_owners()
returns integer
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_updated integer;
  v_inserted integer;
begin
  update public.company_memberships cm
     set is_owner = true,
         updated_at = now()
    from public.organization_memberships om
    join public.companies c on c.organization_id = om.organization_id
   where cm.user_id = om.user_id
     and cm.company_id = c.id
     and cm.deleted_at is null
     and om.role = 'owner'
     and om.deleted_at is null
     and c.deleted_at is null
     and not cm.is_owner;

  get diagnostics v_updated = row_count;

  insert into public.company_memberships (user_id, company_id, organization_id, is_owner)
  select om.user_id, c.id, c.organization_id, true
    from public.organization_memberships om
    join public.companies c on c.organization_id = om.organization_id
   where om.role = 'owner'
     and om.deleted_at is null
     and c.deleted_at is null
     and not exists (
       select 1 from public.company_memberships cm
        where cm.user_id = om.user_id
          and cm.company_id = c.id
          and cm.deleted_at is null
     );

  get diagnostics v_inserted = row_count;

  return v_updated + v_inserted;
end;
$$;

revoke execute on function public.backfill_station_owners() from public;

comment on function public.backfill_station_owners() is
  'Makes every Organization owner an owner of every Station of their group, and returns how many memberships it touched. Two statements because company_memberships_unique is (user_id, company_id) WHERE deleted_at is null: an owner who already works at one of their Stations under a role is UPDATED, and a second row for them would be refused. Idempotent by its own predicates, so a run stopped part way resumes by calling it again. Exists so 0277 changes nobody''s day: the group''s blanket write became a row per Station, which shows on a screen, can be revoked one Station at a time, and is not inherited by a group user added tomorrow -- none of which the old clause allowed.';

select public.backfill_station_owners();

-- ---------------------------------------------------------------------------
-- AND FORWARD. add_company created the Station and an audit row and nothing
-- else, which was survivable only while the group's owner could write
-- everywhere. A Station provisioned after 0277 with no owner is a Station
-- nobody can operate, and the failure would arrive as a permission error on a
-- screen rather than as anything naming its cause.
--
-- Copied forward from 0017_role_rpcs.sql:367, which pg_proc confirms is the live
-- definition -- the only change is the insert at the end.
-- ---------------------------------------------------------------------------
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

  -- The Station's first owners: whoever owns the Organization it was created in.
  -- D18 gives Station creation to the platform admin, and this is the default it
  -- applies -- the customer who asked for the radio gets to run it. A later
  -- block may let the admin name somebody else at creation; nothing here
  -- prevents that, and nothing here leaves a Station with no owner at all.
  insert into public.company_memberships (user_id, company_id, organization_id, is_owner)
  select om.user_id, v_id, p_organization_id, true
    from public.organization_memberships om
   where om.organization_id = p_organization_id
     and om.role = 'owner'
     and om.deleted_at is null;

  return v_id;
end;
$$;
