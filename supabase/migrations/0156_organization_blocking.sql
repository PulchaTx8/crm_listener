-- supabase/migrations/0156_organization_blocking.sql

-- Block 16, design D5. Blocking a whole customer.
--
-- THE AUDIT THIS MIGRATION IS BUILT ON, run before a line of it was written,
-- because "we think we got them all" is not a proof:
--
--   grep -rn "is_owner_for(\|is_owner_of_company\|public.is_owner(" supabase/migrations
--
-- It turned up three shapes, and the third is the one that decided the design.
--
--   1. has_company_access_for (0121) -- the door EVERY permission check passes
--      through. has_permission_for ANDs it, so patching it covers the whole
--      catalogue in one place.
--
--   2. is_owner_of_company_for (0121) -- the door 0044's policies admit the
--      owner through to rows everyone else is denied (an archived promotion,
--      for one), and 0051, 0090, 0095, 0096, 0120, 0124 and 0125 all read
--      through it. It checks no status of any kind.
--
--   3. public.is_owner(organization_id), CALLED DIRECTLY BY MORE THAN TWENTY
--      POLICIES -- 0006, 0015, 0016, 0021, 0024, 0032, 0033, 0035 (four times,
--      on `members`), 0036, 0044 and onward. `members` is Organization-scoped,
--      so those four never touch has_company_access at all, and a block written
--      only into (1) and (2) would leave a blocked group's owner reading and
--      writing its entire audience.
--
-- So the condition goes into is_owner_for, and all twenty obey without being
-- edited. That is the only version of this change that is not a list somebody
-- has to keep complete by hand.
--
-- WHAT THAT COSTS, stated rather than discovered: is_owner_for stops being a
-- pure predicate. It used to mean "does this person own this Organization" and
-- now means "…and is the Organization usable". has_company_access_for has had
-- exactly that shape since 0121 -- it folds `status = 'active'` into a question
-- about access -- so this is the house's existing trade rather than a new one.
-- The one caller that needs the pure question keeps it, by name, below.

-- ---------------------------------------------------------------------------
-- 1. The named exception.
--
-- ONE CALLER, FOR EVER: companies_select_org_member. A blocked group's owner
-- must still SEE their Stations and the reason the door shut -- spec §4's rule,
-- which 0006's own comment states for a suspended Station: the customer sees
-- why access stopped instead of an empty screen. A screen that says "no station
-- is linked to your account" to somebody who has three is a screen that lies,
-- and it turns a billing conversation into a support incident.
--
-- Seeing the row is all it buys. Every other policy, every permission and every
-- RPC still refuses, because they all go through is_owner_for below.
-- ---------------------------------------------------------------------------

create or replace function public.is_owner_including_blocked(p_organization_id uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select exists (
    select 1 from public.organization_memberships m
    where m.user_id = auth.uid()
      and m.organization_id = p_organization_id
      and m.role = 'owner'
      and m.deleted_at is null
  );
$$;

comment on function public.is_owner_including_blocked(uuid) is
  'Block 16, D5. Ownership WITHOUT the group''s lock -- what is_owner_for meant before this migration. Exactly one caller, and it must stay that way: companies_select_org_member, so a blocked group''s owner still sees their Stations and the reason rather than an empty account. Anything else wanting "is this person the owner" wants is_owner_for, which refuses while the group is blocked.';

revoke execute on function public.is_owner_including_blocked(uuid) from public;
grant  execute on function public.is_owner_including_blocked(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 2. The owner predicate, now gated on the group.
--
-- is_owner_of_company_for inherits this for free -- it calls is_owner_for -- so
-- it is deliberately NOT restated here. One condition, one place.
-- ---------------------------------------------------------------------------

create or replace function public.is_owner_for(p_user_id uuid, p_organization_id uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select exists (
    select 1
    from public.organization_memberships m
    join public.organizations o on o.id = m.organization_id
    where m.user_id = p_user_id
      and m.organization_id = p_organization_id
      and m.role = 'owner'
      and m.deleted_at is null
      -- Block 16, D5. The group's lock. See this file's header for why the
      -- condition lives here rather than in twenty policies.
      and o.suspended_at is null
  );
$$;

comment on function public.is_owner_for(uuid, uuid) is
  'Whether a NAMED user owns this Organization AND the Organization is not blocked (Block 16, D5). The second half is why more than twenty policies calling public.is_owner() needed no edit. is_owner_including_blocked is the pure question, and has exactly one caller.';

-- ---------------------------------------------------------------------------
-- 3. The membership path.
--
-- Staff reach a Station through company_memberships, which never touches
-- is_owner_for, so the condition has to be stated again here.
--
-- THE PLATFORM ADMIN IS DELIBERATELY OUTSIDE IT. Whoever blocked the group has
-- to be able to look at it and release it; a condition that caught the admin
-- too would lock the console out of the customer it just locked.
-- ---------------------------------------------------------------------------

create or replace function public.has_company_access_for(p_user_id uuid, p_company_id uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select exists (
    select 1
    from public.companies c
    join public.organizations o on o.id = c.organization_id
    where c.id = p_company_id
      and c.status = 'active'
      and c.deleted_at is null
      and (
        public.is_platform_admin_for(p_user_id)
        or (
          o.suspended_at is null
          and (
            public.is_owner_for(p_user_id, c.organization_id)
            or exists (
              select 1 from public.company_memberships cm
              where cm.user_id = p_user_id
                and cm.company_id = c.id
                and cm.deleted_at is null
            )
          )
        )
      )
  );
$$;

comment on function public.has_company_access_for(uuid, uuid) is
  'Active subscription AND an unblocked Organization AND (platform admin OR owner OR a live membership), for a NAMED user. The Organization''s lock (Block 16, D5) sits INSIDE the non-admin branch on purpose: whoever blocked a group must still be able to look at it and release it. The owner holds no membership row by design.';

-- ---------------------------------------------------------------------------
-- 4. The one policy that keeps the pure question.
--
-- 0021's body, unchanged except for that one predicate.
-- ---------------------------------------------------------------------------

drop policy companies_select_org_member on public.companies;

create policy companies_select_org_member on public.companies
  for select to authenticated
  using (
    deleted_at is null
    and (
      public.is_platform_admin()
      -- Block 16: is_owner_including_blocked, not is_owner. A blocked group's
      -- owner still sees the list and the reason; everything else refuses.
      or public.is_owner_including_blocked(organization_id)
      or public.is_company_member(id)
    )
  );

-- ---------------------------------------------------------------------------
-- 5. The two doors.
--
-- Separate from update_organization (0157) for the reason the picture is
-- separate from the profile (0153): a field-wholesale save must never be able
-- to block a customer by omitting a field.
-- ---------------------------------------------------------------------------

create function public.block_organization(p_organization_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor  uuid := auth.uid();
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
begin
  if not public.is_platform_admin() then
    raise log 'block_organization denied: actor=% organization=%', v_actor, p_organization_id;
    raise exception 'permission denied: platform admin required' using errcode = '42501';
  end if;

  -- A reason is required, and it is not ceremony: this is the heaviest control
  -- in the console -- it denies the owner and every member across every Station
  -- at once -- and somebody will be asked why, possibly months later.
  if v_reason is null then
    raise exception 'a block needs a reason' using errcode = '22023';
  end if;

  update public.organizations
     set suspended_at      = now(),
         suspended_by      = v_actor,
         suspension_reason = v_reason,
         updated_at        = now()
   where id = p_organization_id
     and suspended_at is null;

  -- Silent when it was already blocked, and silent when the id names nothing:
  -- a console that double-submits must not produce an error somebody
  -- investigates, and blocking twice is not a failure by any reading.
  if not found then
    return;
  end if;

  insert into public.audit_logs
    (actor_id, action, target_table, target_id, organization_id, company_id, detail)
  values
    (v_actor, 'block_organization', 'organizations', p_organization_id,
     p_organization_id, null,
     jsonb_build_object('reason', v_reason));
end;
$$;

comment on function public.block_organization(uuid, text) is
  'Block 16, D5. Denies the group and every Station under it, to the owner and all their staff at once. A reason is required. Silent if it was already blocked. Its own door rather than a field on update_organization, so a wholesale save can never block a customer by omission.';

create function public.unblock_organization(p_organization_id uuid)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor uuid := auth.uid();
begin
  if not public.is_platform_admin() then
    raise log 'unblock_organization denied: actor=% organization=%', v_actor, p_organization_id;
    raise exception 'permission denied: platform admin required' using errcode = '42501';
  end if;

  update public.organizations
     set suspended_at      = null,
         suspended_by      = null,
         suspension_reason = null,
         updated_at        = now()
   where id = p_organization_id
     and suspended_at is not null;

  if not found then
    return;
  end if;

  insert into public.audit_logs
    (actor_id, action, target_table, target_id, organization_id, company_id, detail)
  values
    (v_actor, 'unblock_organization', 'organizations', p_organization_id,
     p_organization_id, null, '{}'::jsonb);
end;
$$;

comment on function public.unblock_organization(uuid) is
  'Block 16, D5. Releases a blocked group. Clears the reason with the lock: a reason left behind would read as a live block on the next screen that showed it. Silent if it was not blocked.';

revoke execute on function public.block_organization(uuid, text) from public;
revoke execute on function public.unblock_organization(uuid)      from public;
grant  execute on function public.block_organization(uuid, text) to authenticated;
grant  execute on function public.unblock_organization(uuid)      to authenticated;
