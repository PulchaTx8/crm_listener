-- The plaintext token is generated in Node and never sent here: these functions
-- take its SHA-256. The token therefore appears in no query log and no backup.
create or replace function public.create_invitation(
  p_organization_id uuid,
  p_email           text,
  p_role            public.member_role,
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
begin
  if not public.has_org_permission('users.invite', p_organization_id) then
    raise log 'create_invitation denied: actor=% org=%', v_actor, p_organization_id;
    raise exception 'permission denied: users.invite required' using errcode = '42501';
  end if;

  if coalesce(v_email, '') = '' then
    raise exception 'email is required' using errcode = '22023';
  end if;

  -- A person belongs to one Organization (spec §4.3). Refusing here keeps the
  -- acceptance page single-path: it always creates an account. Offering to set a
  -- password for an existing account from an emailed link is account takeover.
  if exists (select 1 from auth.users u where lower(u.email) = v_email) then
    raise exception 'this e-mail already has an account on the platform'
      using errcode = '23505';
  end if;

  insert into public.invitations
    (organization_id, email, role, token_hash, expires_at, invited_by)
  values
    (p_organization_id, v_email, p_role, p_token_hash,
     now() + make_interval(days => p_ttl_days), v_actor)
  returning id into v_id;

  insert into public.audit_logs
    (actor_id, action, target_table, target_id, organization_id, detail)
  values
    (v_actor, 'create_invitation', 'invitations', v_id, p_organization_id,
     jsonb_build_object('email', v_email, 'role', p_role));

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

  if not public.has_org_permission('users.invite', v_org) then
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

-- Called by the server with the service client, because the visitor has no
-- session. Returns only what the acceptance page must render. Every failure —
-- unknown, revoked, accepted, expired — raises the SAME message: three distinct
-- ones would tell an attacker which guess landed close.
create or replace function public.validate_invitation(p_token_hash text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_inv  public.invitations;
  v_name text;
begin
  select * into v_inv
  from public.invitations
  where token_hash = p_token_hash
    and status = 'pending'
    and expires_at > now();

  if not found then
    raise exception 'invalid or expired invitation' using errcode = '42501';
  end if;

  select name into v_name from public.organizations where id = v_inv.organization_id;

  return jsonb_build_object(
    'invitation_id',     v_inv.id,
    'organization_id',   v_inv.organization_id,
    'organization_name', v_name,
    'email',             v_inv.email,
    'role',              v_inv.role
  );
end;
$$;

-- Creating the auth user is the Admin API; everything below is SQL, and there is
-- no transaction spanning the two. The caller creates the user first and deletes
-- it if this fails (services/invitations.ts) — the same compensating action as
-- provisioning.
--
-- This RE-VALIDATES rather than trusting whatever validate_invitation returned
-- earlier, and takes a row lock, so two simultaneous accepts of one link
-- serialize and only the first wins. Single-use is the database's guarantee, not
-- the click order's.
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
  select * into v_inv
  from public.invitations
  where token_hash = p_token_hash
    and status = 'pending'
    and expires_at > now()
  for update;

  if not found then
    raise exception 'invalid or expired invitation' using errcode = '42501';
  end if;

  insert into public.profiles (id, email, full_name)
  values (p_user_id, v_inv.email, nullif(trim(coalesce(p_full_name, '')), ''))
  on conflict (id) do nothing;

  insert into public.organization_memberships (user_id, organization_id, role)
  values (p_user_id, v_inv.organization_id, v_inv.role);

  -- Every Company in the Organization, at the invited role. Per-Company
  -- selection is Block 1c; with one Company per Organization this is exact.
  insert into public.company_memberships (user_id, company_id, role)
  select p_user_id, c.id, v_inv.role
  from public.companies c
  where c.organization_id = v_inv.organization_id
    and c.deleted_at is null;

  update public.invitations
     set status      = 'accepted',
         accepted_at = now(),
         accepted_by = p_user_id,
         updated_at  = now()
   where id = v_inv.id
     and status = 'pending';

  if not found then
    raise exception 'invitation was already accepted' using errcode = '23505';
  end if;

  insert into public.audit_logs
    (actor_id, action, target_table, target_id, organization_id, detail)
  values
    (p_user_id, 'accept_invitation', 'invitations', v_inv.id, v_inv.organization_id,
     jsonb_build_object('role', v_inv.role));

  return jsonb_build_object('organization_id', v_inv.organization_id);
end;
$$;

revoke execute on function public.create_invitation(uuid, text, public.member_role, text, integer) from public;
revoke execute on function public.revoke_invitation(uuid) from public;
revoke execute on function public.validate_invitation(text) from public;
revoke execute on function public.accept_invitation(text, uuid, text) from public;

-- Creating and revoking run as the calling Owner, because the RPCs re-check
-- has_org_permission against auth.uid().
grant execute on function public.create_invitation(uuid, text, public.member_role, text, integer) to authenticated;
grant execute on function public.revoke_invitation(uuid) to authenticated;

-- Validation and acceptance run server-side with the service client: the visitor
-- has no session. anon is granted nothing, so the only public write in the system
-- remains the contact form.
grant execute on function public.validate_invitation(text) to service_role;
grant execute on function public.accept_invitation(text, uuid, text) to service_role;
