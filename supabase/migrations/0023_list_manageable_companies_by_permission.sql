-- supabase/migrations/0023_list_manageable_companies_by_permission.sql

-- 0022 gated list_manageable_companies solely on users.manage, reasoning only
-- about ONE of its two callers: the Team screen's per-Station assignment
-- rows, which assign_company_role really does check users.manage for. But
-- the Team screen has a SECOND consumer of the same roster — the invite
-- form's Station checklist — and create_invitation authorises that one
-- through users.invite, a distinct, independently assignable permission that
-- has nothing to do with users.manage. A role holding users.invite alone
-- (exactly the shape roles-flow.spec.ts's own "Manager" role composes) got
-- refused by the function and handed an empty checklist, and so could not
-- invite anyone into any Station at all, including their own — worse than
-- the state after 0021 alone, where the unscoped direct `companies` read at
-- least showed such a person their own Station.
--
-- Fixed by parameterising WHICH permission the caller is exercising, instead
-- of hard-coding one. An open text parameter on a SECURITY DEFINER function
-- that returns rows is not left general, though: only the two codes the Team
-- screen legitimately asks for are accepted — anything else is refused
-- before has_org_permission is even consulted, rather than trusting the
-- caller to only ever pass a sane value. The Team screen now calls this once
-- per surface: 'users.manage' for the Station-assignment rows (what
-- assign_company_role checks), 'users.invite' for the invite form's Station
-- checklist (what create_invitation checks). Two consumers, two permissions,
-- two calls — each honest about what it actually authorises, rather than one
-- shared roster reasoned about from only one side.
drop function if exists public.list_manageable_companies(uuid);

create or replace function public.list_manageable_companies(
  p_organization_id uuid,
  p_permission      text
)
returns table (id uuid, name text, status public.company_status)
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
begin
  if p_permission not in ('users.manage', 'users.invite') then
    raise exception 'list_manageable_companies: unsupported permission %', p_permission
      using errcode = '22023';
  end if;

  if not public.has_org_permission(p_permission, p_organization_id) then
    raise exception 'permission denied: % required', p_permission using errcode = '42501';
  end if;

  return query
    select c.id, c.name, c.status
    from public.companies c
    where c.organization_id = p_organization_id
      and c.deleted_at is null
    order by c.name;
end;
$$;

comment on function public.list_manageable_companies(uuid, text) is
  'Every live Company in the Organization, for a caller authorised by the NAMED permission — Organization-wide (has_org_permission), exactly like assign_company_role and create_invitation themselves check, and NOT filtered to the caller''s own company_memberships the way companies_select_org_member (0021) is. Only ''users.manage'' and ''users.invite'' are accepted; anything else is refused. The Team screen calls this once per surface: ''users.manage'' for its Station-assignment rows, ''users.invite'' for the invite form''s Station checklist — two different consumers authorised by two different permissions, never one shared call. `/app` must not use this — it answers a different question ("which Stations can I reach", not "which Stations can I administer") and keeps reading companies directly.';

revoke execute on function public.list_manageable_companies(uuid, text) from public;
grant execute on function public.list_manageable_companies(uuid, text) to authenticated;
