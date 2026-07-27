-- supabase/migrations/0019_rls_1c.sql

alter table public.roles                enable row level security;
alter table public.role_permissions     enable row level security;
alter table public.invitation_companies enable row level security;

revoke all on public.roles                from anon, authenticated;
revoke all on public.role_permissions     from anon, authenticated;
revoke all on public.invitation_companies from anon, authenticated;

-- A user must be able to see the name of the role they hold, and whoever holds
-- roles.manage needs the whole list. Neither table takes a write grant: every
-- write goes through the RPCs in 0017, which carry the audit entry with them.
grant select on public.roles            to authenticated;
grant select on public.role_permissions to authenticated;

create policy roles_select_org_member on public.roles
  for select to authenticated
  using (deleted_at is null and public.is_org_member(organization_id));

create policy role_permissions_select_org on public.role_permissions
  for select to authenticated
  using (
    exists (
      select 1 from public.roles r
      where r.id = role_id
        and r.deleted_at is null
        and public.is_org_member(r.organization_id)
    )
  );

-- Same narrowness as the invitations policy it accompanies: this table names
-- which Stations a third party was offered.
grant select on public.invitation_companies to authenticated;

create policy invitation_companies_select_inviter on public.invitation_companies
  for select to authenticated
  using (
    exists (
      select 1 from public.invitations i
      where i.id = invitation_id
        and public.has_org_permission('users.invite', i.organization_id)
    )
  );

-- service_role needs explicit grants: the default ACL gives it only Dxtm and
-- BYPASSRLS does not substitute for a GRANT (Block 1a §3.9). Read-only, because
-- every write to these tables belongs to a SECURITY DEFINER function.
grant select on public.roles                to service_role;
grant select on public.role_permissions     to service_role;
grant select on public.invitation_companies to service_role;
