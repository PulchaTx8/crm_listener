-- supabase/migrations/0018_invitations_1c.sql

alter table public.invitations
  add column is_owner boolean not null default false,
  add column role_id  uuid references public.roles (id);

create table public.invitation_companies (
  invitation_id uuid not null references public.invitations (id) on delete cascade,
  company_id    uuid not null references public.companies (id),
  primary key (invitation_id, company_id)
);

comment on table public.invitation_companies is
  'Which Stations the invitee is attached to on acceptance. Empty for an owner invitation.';

-- EVERY row, not only the pending ones. The check constraint below applies to
-- the whole table, so an accepted or revoked invitation left with
-- is_owner = false and role_id = null fails it and takes the migration down —
-- on a live database, which is the only place such rows exist. Backfilling them
-- also keeps the record of what each historical invitation actually granted,
-- which the dropped `role` column was carrying.
insert into public.roles (organization_id, name, description)
select distinct i.organization_id, initcap(i.role::text),
       'Created when Block 1c replaced fixed roles. Holds no permissions, exactly as this role did before.'
  from public.invitations i
 where i.role <> 'owner'
on conflict do nothing;

update public.invitations i
   set is_owner = true
 where i.role = 'owner';

update public.invitations i
   set role_id = r.id
  from public.roles r
 where i.role <> 'owner'
   and r.organization_id = i.organization_id
   and lower(r.name) = lower(i.role::text)
   and r.deleted_at is null;

-- Pending only: this list drives what acceptance grants, and an invitation
-- already accepted or revoked will never be read for it again — the Stations
-- a past invitation actually granted live in company_memberships, not here.
insert into public.invitation_companies (invitation_id, company_id)
select i.id, c.id
  from public.invitations i
  join public.companies c on c.organization_id = i.organization_id and c.deleted_at is null
 where i.status = 'pending' and i.role <> 'owner'
on conflict do nothing;

alter table public.invitations drop column role;

-- An invitation is either for an owner, who takes no role, or for a member, who
-- must take one. Nothing in between is representable.
alter table public.invitations
  add constraint invitations_role_shape
  check ((is_owner and role_id is null) or (not is_owner and role_id is not null));

-- The old create_invitation signature is the last object still holding a
-- parameter of type member_role; it must go before the type does, or the DROP
-- TYPE below fails with exactly that dependency.
drop function if exists public.create_invitation(uuid, text, public.member_role, text, integer);

drop type public.member_role;

create index invitation_companies_company_idx on public.invitation_companies (company_id);

-- ---------------------------------------------------------------------------
-- The three invitation functions, rewritten. Their signatures change, so the
-- old ones are dropped rather than replaced.
-- ---------------------------------------------------------------------------

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
  if not public.has_org_permission('users.invite', p_organization_id) then
    raise log 'create_invitation denied: actor=% org=%', v_actor, p_organization_id;
    raise exception 'permission denied: users.invite required' using errcode = '42501';
  end if;

  if coalesce(v_email, '') = '' then
    raise exception 'email is required' using errcode = '22023';
  end if;

  -- A person belongs to one Organization. Refusing here keeps the acceptance
  -- page single-path: it always creates an account. Offering to set a password
  -- for an existing account from an emailed link is account takeover.
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

    select count(*) into v_count
    from unnest(coalesce(p_company_ids, '{}')) as cid
    join public.companies c on c.id = cid
    where c.organization_id = p_organization_id and c.deleted_at is null;

    if v_count = 0 or v_count <> coalesce(array_length(p_company_ids, 1), 0) then
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
    select v_id, cid from unnest(p_company_ids) as cid;
  end if;

  insert into public.audit_logs
    (actor_id, action, target_table, target_id, organization_id, detail)
  values
    (v_actor, 'create_invitation', 'invitations', v_id, p_organization_id,
     jsonb_build_object('email', v_email, 'is_owner', p_is_owner, 'role_id', p_role_id));

  return v_id;
end;
$$;

-- Returns only what the acceptance page renders. Every failure — unknown,
-- revoked, accepted, expired — raises the SAME message.
create or replace function public.validate_invitation(p_token_hash text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_inv  public.invitations;
  v_name text;
  v_role text;
begin
  select * into v_inv
  from public.invitations
  where token_hash = p_token_hash and status = 'pending' and expires_at > now();

  if not found then
    raise exception 'invalid or expired invitation' using errcode = '42501';
  end if;

  select name into v_name from public.organizations where id = v_inv.organization_id;
  select name into v_role from public.roles where id = v_inv.role_id;

  return jsonb_build_object(
    'invitation_id',     v_inv.id,
    'organization_id',   v_inv.organization_id,
    'organization_name', v_name,
    'email',             v_inv.email,
    'is_owner',          v_inv.is_owner,
    'role_name',         coalesce(v_role, 'Owner')
  );
end;
$$;

create or replace function public.accept_invitation(
  p_token_hash text,
  p_user_id    uuid,
  p_full_name  text default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_inv public.invitations;
begin
  -- Re-validates rather than trusting what validate_invitation returned
  -- earlier, and takes a row lock, so two simultaneous accepts serialize and
  -- only the first wins. Single use is the database's guarantee.
  select * into v_inv
  from public.invitations
  where token_hash = p_token_hash and status = 'pending' and expires_at > now()
  for update;

  if not found then
    raise exception 'invalid or expired invitation' using errcode = '42501';
  end if;

  insert into public.profiles (id, email, full_name)
  values (p_user_id, v_inv.email, nullif(trim(coalesce(p_full_name, '')), ''))
  on conflict (id) do nothing;

  insert into public.organization_memberships (user_id, organization_id, role)
  values (p_user_id, v_inv.organization_id,
          case when v_inv.is_owner then 'owner'::public.org_role else 'member'::public.org_role end);

  -- An owner takes no Company membership: they reach every Station by ownership.
  if not v_inv.is_owner then
    insert into public.company_memberships (user_id, company_id, organization_id, role_id)
    select p_user_id, ic.company_id, v_inv.organization_id, v_inv.role_id
    from public.invitation_companies ic
    join public.companies c on c.id = ic.company_id and c.deleted_at is null
    where ic.invitation_id = v_inv.id;
  end if;

  update public.invitations
     set status = 'accepted', accepted_at = now(), accepted_by = p_user_id, updated_at = now()
   where id = v_inv.id and status = 'pending';

  if not found then
    raise exception 'invitation was already accepted' using errcode = '23505';
  end if;

  insert into public.audit_logs
    (actor_id, action, target_table, target_id, organization_id, detail)
  values
    (p_user_id, 'accept_invitation', 'invitations', v_inv.id, v_inv.organization_id,
     jsonb_build_object('is_owner', v_inv.is_owner, 'role_id', v_inv.role_id));

  return jsonb_build_object('organization_id', v_inv.organization_id);
end;
$$;

revoke execute on function public.create_invitation(uuid, text, boolean, uuid, uuid[], text, integer) from public;
grant  execute on function public.create_invitation(uuid, text, boolean, uuid, uuid[], text, integer) to authenticated;
revoke execute on function public.validate_invitation(text) from public;
revoke execute on function public.accept_invitation(text, uuid, text) from public;
grant  execute on function public.validate_invitation(text) to service_role;
grant  execute on function public.accept_invitation(text, uuid, text) to service_role;
