alter table public.profiles                  enable row level security;
alter table public.organizations             enable row level security;
alter table public.companies                 enable row level security;
alter table public.organization_memberships  enable row level security;
alter table public.company_memberships       enable row level security;
alter table public.platform_admins           enable row level security;
alter table public.audit_logs                enable row level security;
alter table public.contact_requests          enable row level security;

-- Default deny everywhere. Grants are added back per role, per table.
revoke all on public.profiles                 from anon, authenticated;
revoke all on public.organizations            from anon, authenticated;
revoke all on public.companies                from anon, authenticated;
revoke all on public.organization_memberships from anon, authenticated;
revoke all on public.company_memberships      from anon, authenticated;
revoke all on public.platform_admins          from anon, authenticated;
revoke all on public.audit_logs               from anon, authenticated;
revoke all on public.contact_requests         from anon, authenticated;

-- profiles: you see and edit your own row, and nothing else.
--
-- The UPDATE grant is deliberately COLUMN-level. must_change_password and
-- provisional_expires_at are the password gate, and a table-level UPDATE grant
-- would let any user clear their own gate with a single PostgREST PATCH — the
-- RLS policy below permits writing your own row, and it is the grant, not the
-- policy, that decides which columns. Nor can this be walked back later: once a
-- table-level privilege is held, revoking the same privilege on individual
-- columns has no effect (PostgreSQL REVOKE semantics). Those two columns are
-- written only by SECURITY DEFINER functions.
grant select on public.profiles to authenticated;
grant update (full_name) on public.profiles to authenticated;

create policy profiles_select_self on public.profiles
  for select to authenticated
  using (id = auth.uid() or public.is_platform_admin());

create policy profiles_update_self on public.profiles
  for update to authenticated
  using (id = auth.uid())
  with check (id = auth.uid());

-- organizations: visible to members. No client-side writes at all — creation
-- happens inside provision_customer.
grant select on public.organizations to authenticated;

create policy organizations_select_member on public.organizations
  for select to authenticated
  using (deleted_at is null and public.is_org_member(id));

-- companies: metadata is visible to any member of the owning organization,
-- INCLUDING while suspended, so the UI can show why access stopped. Business
-- data lives in other tables and is gated by has_company_access instead.
grant select on public.companies to authenticated;

create policy companies_select_org_member on public.companies
  for select to authenticated
  using (deleted_at is null and public.is_org_member(organization_id));

-- memberships: you see your own links; an Owner sees everyone in their org.
grant select on public.organization_memberships to authenticated;
grant select on public.company_memberships to authenticated;

create policy organization_memberships_select on public.organization_memberships
  for select to authenticated
  using (
    deleted_at is null
    and (user_id = auth.uid() or public.is_owner(organization_id) or public.is_platform_admin())
  );

create policy company_memberships_select on public.company_memberships
  for select to authenticated
  using (
    deleted_at is null
    and (
      user_id = auth.uid()
      or public.is_platform_admin()
      or exists (
        select 1 from public.companies c
        where c.id = company_id and public.is_owner(c.organization_id)
      )
    )
  );

-- platform_admins: only a platform admin may read the list. No client writes.
grant select on public.platform_admins to authenticated;

create policy platform_admins_select on public.platform_admins
  for select to authenticated
  using (public.is_platform_admin());

-- audit_logs: readable by platform admins only in this block. Org-scoped
-- audit viewing arrives with the admin console in a later block. Writes come
-- exclusively from SECURITY DEFINER functions and the service role.
grant select on public.audit_logs to authenticated;

create policy audit_logs_select_admin on public.audit_logs
  for select to authenticated
  using (public.is_platform_admin());

-- contact_requests: anon may INSERT and nothing else. Only platform admins
-- read or update. This is the single public write in the system.
grant insert on public.contact_requests to anon;
grant select, update on public.contact_requests to authenticated;

-- The one `with check (true)` in the schema, and it is deliberate: a stranger
-- must be able to submit the form. It is not the forbidden `USING (true)` —
-- anon holds no SELECT grant, so a submitter cannot read the table back, and
-- the service layer rate-limits the endpoint by hashed IP.
create policy contact_requests_insert_anon on public.contact_requests
  for insert to anon
  with check (true);

create policy contact_requests_select_admin on public.contact_requests
  for select to authenticated
  using (public.is_platform_admin());

create policy contact_requests_update_admin on public.contact_requests
  for update to authenticated
  using (public.is_platform_admin())
  with check (public.is_platform_admin());
