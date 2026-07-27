alter table public.permissions      enable row level security;
alter table public.role_permissions enable row level security;
alter table public.invitations      enable row level security;

revoke all on public.permissions      from anon, authenticated;
revoke all on public.role_permissions from anon, authenticated;
revoke all on public.invitations      from anon, authenticated;

-- The catalogue is reference data with no tenant column, and the UI needs it to
-- render what a role may do. `using (auth.uid() is not null)` rather than
-- `using (true)`: the ban on USING (true) exists to stop tenant tables leaking
-- across tenants, and stating the condition keeps the audit of policies uniform
-- — a reader never has to decide whether a bare `true` was reasoned about.
grant select on public.permissions      to authenticated;
grant select on public.role_permissions to authenticated;

create policy permissions_select_authenticated on public.permissions
  for select to authenticated
  using (auth.uid() is not null);

create policy role_permissions_select_authenticated on public.role_permissions
  for select to authenticated
  using (auth.uid() is not null);

-- invitations: this is where has_org_permission is exercised inside a real RLS
-- policy rather than only in RPC bodies. Without it, Block 2 would be the first
-- to discover whether the helper works in a policy, which is where it matters.
-- The table holds third parties' e-mail addresses, so the read is narrow.
grant select on public.invitations to authenticated;

create policy invitations_select_inviter on public.invitations
  for select to authenticated
  using (public.has_org_permission('users.invite', organization_id));

-- audit_logs stops being platform-admin-only. Policies OR together, so the 1a
-- admin policy still applies; this adds the Owner's view of their own trail and
-- gives audit.view something real to guard.
create policy audit_logs_select_org on public.audit_logs
  for select to authenticated
  using (
    organization_id is not null
    and public.has_org_permission('audit.view', organization_id)
  );

-- service_role needs explicit grants: the default ACL gives it only Dxtm and
-- BYPASSRLS does not substitute for a GRANT (Block 1a §3.9). It reads the
-- catalogue and nothing else here — invitations are reached only through the
-- SECURITY DEFINER RPCs, which run as the table owner.
grant select on public.permissions      to service_role;
grant select on public.role_permissions to service_role;
