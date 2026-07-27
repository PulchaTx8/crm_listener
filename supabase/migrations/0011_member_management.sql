-- An Organization that loses its last owner cannot be repaired by anyone inside
-- it: the recovery is a support call only the product owner can answer. The rule
-- therefore lives in a trigger, not in the RPCs below. Membership writes pass
-- only through SECURITY DEFINER functions *today*, so an in-RPC check would be
-- enough right now — and would silently stop being enough the first time someone
-- adds an RPC and forgets. Same reasoning that put the 1a password gate in the
-- column GRANT rather than in the policy.
-- SECURITY DEFINER is load-bearing, not decoration. This trigger is DEFERRED, so
-- it fires at COMMIT — after change_member_role's own SECURITY DEFINER context
-- has been popped and the session is back to `authenticated`. Without it the
-- count runs under the caller's RLS, which shows only the rows they may read:
-- an owner demoting themselves can no longer see the other owners, counts zero,
-- and is refused an operation that is perfectly legal.
create or replace function public.enforce_last_owner()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_org    uuid := coalesce(new.organization_id, old.organization_id);
  v_owners integer;
begin
  select count(*) into v_owners
  from public.organization_memberships
  where organization_id = v_org
    and role = 'owner'
    and deleted_at is null;

  if v_owners = 0 then
    raise exception 'an organization must keep at least one owner'
      using errcode = '23514';
  end if;

  return null;
end;
$$;

-- DEFERRABLE INITIALLY DEFERRED so the check runs at commit, not per row. That
-- lets one transaction promote a new owner and demote the old one in either
-- order; only the end state has to be legal.
create constraint trigger organization_memberships_keep_owner
after update or delete on public.organization_memberships
deferrable initially deferred
for each row execute function public.enforce_last_owner();

create or replace function public.change_member_role(
  p_membership_id uuid,
  p_new_role      public.member_role
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
  v_old_role public.member_role;
begin
  select om.organization_id, om.user_id, om.role
    into v_org, v_user, v_old_role
  from public.organization_memberships om
  where om.id = p_membership_id
    and om.deleted_at is null;

  if not found then
    raise exception 'membership not found: %', p_membership_id using errcode = 'P0002';
  end if;

  if not public.has_org_permission('users.manage', v_org) then
    raise log 'change_member_role denied: actor=% membership=%', v_actor, p_membership_id;
    raise exception 'permission denied: users.manage required' using errcode = '42501';
  end if;

  update public.organization_memberships
     set role = p_new_role, updated_at = now()
   where id = p_membership_id;

  -- Company roles follow the Organization role. Per-Company roles arrive in
  -- Block 1c; until then the two levels must not drift apart, or has_permission
  -- and has_org_permission would disagree about the same person.
  update public.company_memberships cm
     set role = p_new_role, updated_at = now()
   from public.companies c
   where c.id = cm.company_id
     and c.organization_id = v_org
     and cm.user_id = v_user
     and cm.deleted_at is null;

  insert into public.audit_logs
    (actor_id, action, target_table, target_id, organization_id, detail)
  values
    (v_actor, 'change_member_role', 'organization_memberships', p_membership_id, v_org,
     jsonb_build_object('user_id', v_user, 'from', v_old_role, 'to', p_new_role));
end;
$$;

create or replace function public.remove_member(p_membership_id uuid)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor uuid := auth.uid();
  v_org   uuid;
  v_user  uuid;
begin
  select om.organization_id, om.user_id
    into v_org, v_user
  from public.organization_memberships om
  where om.id = p_membership_id
    and om.deleted_at is null;

  if not found then
    raise exception 'membership not found: %', p_membership_id using errcode = 'P0002';
  end if;

  if not public.has_org_permission('users.manage', v_org) then
    raise log 'remove_member denied: actor=% membership=%', v_actor, p_membership_id;
    raise exception 'permission denied: users.manage required' using errcode = '42501';
  end if;

  -- Soft delete, and it cuts immediately: the RLS helpers query these tables on
  -- every check (1a §4), so the next request from an open session already fails.
  update public.organization_memberships
     set deleted_at = now(), updated_at = now()
   where id = p_membership_id;

  update public.company_memberships cm
     set deleted_at = now(), updated_at = now()
   from public.companies c
   where c.id = cm.company_id
     and c.organization_id = v_org
     and cm.user_id = v_user
     and cm.deleted_at is null;

  insert into public.audit_logs
    (actor_id, action, target_table, target_id, organization_id, detail)
  values
    (v_actor, 'remove_member', 'organization_memberships', p_membership_id, v_org,
     jsonb_build_object('user_id', v_user));
end;
$$;

revoke execute on function public.change_member_role(uuid, public.member_role) from public;
revoke execute on function public.remove_member(uuid) from public;
grant execute on function public.change_member_role(uuid, public.member_role) to authenticated;
grant execute on function public.remove_member(uuid) to authenticated;
