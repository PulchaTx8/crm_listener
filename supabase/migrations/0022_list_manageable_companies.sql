-- supabase/migrations/0022_list_manageable_companies.sql

-- 0021 correctly narrowed WHO can see a Company's metadata to those who
-- actually belong to it (owner, platform admin, or a live company_membership).
-- But assign_company_role authorises users.manage — and create_role/
-- update_role/delete_role authorise roles.manage — through has_org_permission,
-- which is Organization-wide by design: a role granting either permission in
-- ANY Company authorises writing in ALL of them (0016's has_org_permission
-- comment: "held through a role in ANY Company, it applies to the whole
-- Organization"). team/page.tsx fed both the per-Station assignment rows and
-- the invite form's Station checklist from one `companies` read, which 0021
-- now scopes to the viewer's own memberships — so a non-owner holding
-- users.manage in Station A alone lost the ability to even SEE Station B,
-- though they remained authorised to write there.
--
-- `/app` answers "which Stations can I reach" and must keep reading
-- `companies` directly (0021) — a Station someone administers but does not
-- work in does not belong in that list. The Team screen asks a different
-- question, "which Stations can I administer", so it gets its own source:
-- every live Company in the Organization, gated on the same permission
-- assign_company_role itself checks, re-verified inside the function rather
-- than trusted from the caller. SECURITY DEFINER, same shape as the helpers in
-- 0005_rls_helpers.sql, so it runs as the function owner and is not itself
-- subject to companies_select_org_member.
create or replace function public.list_manageable_companies(p_organization_id uuid)
returns table (id uuid, name text, status public.company_status)
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
begin
  if not public.has_org_permission('users.manage', p_organization_id) then
    raise exception 'permission denied: users.manage required' using errcode = '42501';
  end if;

  return query
    select c.id, c.name, c.status
    from public.companies c
    where c.organization_id = p_organization_id
      and c.deleted_at is null
    order by c.name;
end;
$$;

comment on function public.list_manageable_companies(uuid) is
  'Every live Company in the Organization, for a caller authorised by users.manage — Organization-wide, exactly like assign_company_role''s own check, and NOT filtered to the caller''s own company_memberships the way companies_select_org_member (0021) is. The Team screen''s Station-assignment rows and invite-form checklist use this instead of reading companies directly, since both need to reach every Station the caller may administer, not only the ones they personally belong to. `/app` must not use this — it answers a different question and keeps reading companies directly.';

revoke execute on function public.list_manageable_companies(uuid) from public;
grant execute on function public.list_manageable_companies(uuid) to authenticated;
