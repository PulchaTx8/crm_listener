-- supabase/migrations/0282_invitation_gates_descend.sql

create or replace function public.create_invitation(
  p_organization_id uuid,
  p_email           text,
  p_is_owner        boolean,
  p_role_id         uuid,
  p_company_ids     uuid[],
  p_token_hash      text,
  p_ttl_days        integer default 7
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor uuid := auth.uid();
  v_email text := lower(trim(p_email));
  v_id    uuid;
  v_count integer;
begin
  -- P5b. AN INVITATION IS TO STATIONS, so the gate asks about those. An OWNER
  -- invitation names none -- 0018's own branch below -- and stays an
  -- Organization-level act, which D19 leaves with the group.
  --
  -- has_permission carries P5a's Station-owner branch (0279), so a Station's
  -- owner invites into the Station they own without holding a role, and cannot
  -- reach a sister Station. It also carries D19's narrowing (0277): users.invite
  -- is a WRITE, so a group user who is neither owner nor role-holder gets
  -- nothing.
  if p_is_owner then
    if not public.has_org_permission('users.invite', p_organization_id) then
      raise log 'create_invitation denied: actor=% org=%', v_actor, p_organization_id;
      raise exception 'permission denied: users.invite required' using errcode = '42501';
    end if;
  elsif coalesce(array_length(p_company_ids, 1), 0) = 0
     or exists (
          select 1 from unnest(p_company_ids) as cid
           where not public.has_permission('users.invite', cid)
        ) then
    raise log 'create_invitation denied: actor=% org=%', v_actor, p_organization_id;
    raise exception 'permission denied: users.invite required' using errcode = '42501';
  end if;

  if coalesce(v_email, '') = '' then
    raise exception 'email is required' using errcode = '22023';
  end if;

  -- A person belongs to one Organization. Refusing here keeps the acceptance
  -- page single-path: it always creates an account. Offering to set a password
  -- for an existing account from an emailed link is account takeover.
  -- 0282 LEFT THIS STANDING, DELIBERATELY, and the reason deserves the space
  -- because the obvious reading of D17 says to delete it. That decision -- a
  -- Station learns nothing about where else its people work -- is ABOUT this
  -- raise: it announces, in these words, that an address exists somewhere on
  -- the platform, to anybody who may invite. It is the leak D17 names.
  --
  -- It is also the guard the comment above describes, and deleting it without
  -- rebuilding acceptance would trade a disclosure for something worse.
  -- src/services/invitations.ts creates the account and sets the password in one
  -- step, so closing this honestly means acceptance branching -- create an
  -- account when there is none, require SIGNING IN when there is -- and no
  -- emailed link ever setting a password on an account that already exists.
  -- That is an application change with a security property, and its own block.
  --
  -- Masking the message was considered and rejected: the differential is success
  -- versus failure, so a quieter refusal leaks exactly as much while looking as
  -- though it does not.
  if exists (select 1 from auth.users u where lower(u.email) = v_email) then
    raise exception 'this e-mail already has an account on the platform' using errcode = '23505';
  end if;

  if not p_is_owner then
    if p_role_id is null then
      raise exception 'a member invitation must name a role' using errcode = '22023';
    end if;

    if not exists (
      select 1 from public.roles
      where id = p_role_id and organization_id = p_organization_id and deleted_at is null
    ) then
      raise exception 'that role does not belong to this organization' using errcode = '23503';
    end if;

    select count(distinct cid) into v_count
    from unnest(coalesce(p_company_ids, '{}')) as cid
    join public.companies c on c.id = cid
    where c.organization_id = p_organization_id and c.deleted_at is null;

    if v_count = 0
       or v_count <> (select count(distinct x) from unnest(coalesce(p_company_ids, '{}')) as x)
    then
      raise exception 'name at least one Station, all of them in this organization'
        using errcode = '22023';
    end if;
  end if;

  insert into public.invitations
    (organization_id, email, is_owner, role_id, token_hash, expires_at, invited_by)
  values
    (p_organization_id, v_email, p_is_owner,
     case when p_is_owner then null else p_role_id end,
     p_token_hash, now() + make_interval(days => p_ttl_days), v_actor)
  returning id into v_id;

  if not p_is_owner then
    insert into public.invitation_companies (invitation_id, company_id)
    select distinct v_id, cid from unnest(p_company_ids) as cid;
  end if;

  insert into public.audit_logs
    (actor_id, action, target_table, target_id, organization_id, detail)
  values
    (v_actor, 'create_invitation', 'invitations', v_id, p_organization_id,
     jsonb_build_object('email', v_email, 'is_owner', p_is_owner, 'role_id', p_role_id));

  return v_id;
end;
$$;

create or replace function public.revoke_invitation(p_invitation_id uuid)
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
  from public.invitations
  where id = p_invitation_id;

  if not found then
    raise exception 'invitation not found: %', p_invitation_id using errcode = 'P0002';
  end if;

  -- P5b. Revoking is the same authority as issuing seen from the other side, so
  -- it asks the same question of the same Stations -- read off the invitation,
  -- since this door takes only an id.
  if exists (select 1 from public.invitations i
              where i.id = p_invitation_id and i.is_owner) then
    if not public.has_org_permission('users.invite', v_org) then
      raise log 'revoke_invitation denied: actor=% invitation=%', v_actor, p_invitation_id;
      raise exception 'permission denied: users.invite required' using errcode = '42501';
    end if;
  elsif exists (
    select 1 from public.invitation_companies ic
     where ic.invitation_id = p_invitation_id
       and not public.has_permission('users.invite', ic.company_id)
  ) then
    raise log 'revoke_invitation denied: actor=% invitation=%', v_actor, p_invitation_id;
    raise exception 'permission denied: users.invite required' using errcode = '42501';
  end if;

  update public.invitations
     set status = 'revoked', revoked_at = now(), updated_at = now()
   where id = p_invitation_id
     and status = 'pending';

  if not found then
    raise exception 'invitation is not pending' using errcode = '22023';
  end if;

  insert into public.audit_logs
    (actor_id, action, target_table, target_id, organization_id)
  values
    (v_actor, 'revoke_invitation', 'invitations', p_invitation_id, v_org);
end;
$$;
