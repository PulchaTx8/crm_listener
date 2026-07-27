-- supabase/migrations/0020_profiles_visibility.sql

-- A Team screen that renders its own colleagues as uuids is not a screen. The
-- 1a policy allowed only your own row, which was enough while nothing displayed
-- anyone else; Block 1c's Team screen shows a row per member per Station.
--
-- Scoped by shared Organization membership, never by Company: a member of one
-- Station still belongs to the Organization and appears in its team list.
--
-- This has to be a SECURITY DEFINER helper, not a raw self-join inline in the
-- policy: organization_memberships carries its own RLS
-- (organization_memberships_select, 0006), which restricts an ordinary member
-- to rows where user_id = auth.uid() (or is_owner(), or a platform admin). A
-- plain `exists (select 1 from organization_memberships mine join
-- organization_memberships theirs ...)` inlined directly into this policy is
-- still evaluated as the calling role, so Postgres would apply THAT policy to
-- the subquery's own `theirs` read — an ordinary colleague could never see
-- another member's row through it, and the self-join would silently deny
-- same-Organization reads it was written to allow. (Confirmed empirically: the
-- inline version made the isolation test below fail with "no row", not with a
-- false grant.) Every other cross-table RLS check in this project
-- (is_org_member, is_owner, has_company_access, has_permission, all in
-- 0005/0010/0015/0016) is SECURITY DEFINER for exactly this reason — it lets
-- the helper read organization_memberships once, on the definer's privileges,
-- instead of through the caller's own restricted view of it.
create or replace function public.shares_organization_with(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select exists (
    select 1
    from public.organization_memberships mine
    join public.organization_memberships theirs
      on theirs.organization_id = mine.organization_id
    where mine.user_id = auth.uid()
      and mine.deleted_at is null
      and theirs.user_id = p_user_id
      and theirs.deleted_at is null
  );
$$;

revoke execute on function public.shares_organization_with(uuid) from public;
grant  execute on function public.shares_organization_with(uuid) to authenticated;

-- `using (public.shares_organization_with(id))`, not
-- `using (auth.uid() is not null)`: the latter would expose every profile on
-- the platform to every signed-in user.
create policy profiles_select_org_member on public.profiles
  for select to authenticated
  using (public.shares_organization_with(id));
