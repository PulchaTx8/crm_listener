-- supabase/migrations/0024_delegated_admin_visibility.sql

-- Branch-level review of Block 1c (.superpowers/sdd/2026-07-27-block-1c-roles
-- -per-company/final-fix-report.md): the delegated administrator this whole
-- block exists to create — a non-owner holding users.manage or roles.manage —
-- could not actually drive the screens that serve them. Four RLS policies
-- were widened during this block (0019, 0021, 0022, 0023); two from Block 1a
-- were not, and they are exactly the ones /team and /roles read.

-- ---------------------------------------------------------------------------
-- I1 — the Team screen's member roster (organization_memberships,
-- company_memberships) was owner-only.
-- ---------------------------------------------------------------------------
-- 0006_rls_policies.sql (Block 1a) let a caller see only their own membership
-- row, plus the owner/platform-admin bypass. That was correct until this
-- block created a delegate who is meant to ADMINISTER the roster without
-- being the owner: a colleague holding users.manage opened /team and saw
-- exactly one row — themselves — because neither SELECT policy ever asked
-- has_org_permission anything, even though assign_company_role and
-- change_org_role (0011, 0017) have always authorised that same permission,
-- Organization-wide, to write the very rows these policies were hiding.
--
-- Not users.invite: holding the right to send an invitation does not confer
-- the right to see the whole roster (list_manageable_companies, 0022/0023,
-- already drew exactly this line for the Company list; these two policies now
-- agree with it for the member list).
--
-- Safe against the recursion the task brief warned about: has_org_permission
-- is SECURITY DEFINER (0016), owned by the same role that owns these tables.
-- A `grep -rn "force row level security" supabase/migrations` across every
-- migration in this project returns nothing, so the table-owner RLS exemption
-- is live — has_org_permission's internal reads of company_memberships,
-- companies and role_permissions run with RLS bypassed entirely rather than
-- re-entering the very policy being evaluated here. Confirmed empirically by
-- the isolation suite below passing with no "infinite recursion detected in
-- policy" error.
drop policy organization_memberships_select on public.organization_memberships;

create policy organization_memberships_select on public.organization_memberships
  for select to authenticated
  using (
    deleted_at is null
    and (
      user_id = auth.uid()
      or public.is_owner(organization_id)
      or public.is_platform_admin()
      or public.has_org_permission('users.manage', organization_id)
    )
  );

-- company_memberships gained its own organization_id column in 0016 for
-- exactly this purpose (see that column's comment) — read directly, not
-- joined back through companies the way the 1a policy's shape would require.
drop policy company_memberships_select on public.company_memberships;

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
      or public.has_org_permission('users.manage', organization_id)
      -- Also roles.manage. I1's own fix brief named only users.manage for
      -- "both policies" (organization_memberships and this one), scoped to the
      -- Team screen's member roster — but I2 needs company_memberships
      -- visibility too, and for a DIFFERENT permission: listRoles
      -- (src/services/roles.ts) counts a role's holders by reading this table
      -- alone, and that count is what drives the Delete button's disabled
      -- state, the "reassign N holders first" caption, and role-form.tsx's
      -- "N user(s) hold this role" instant-effect warning (spec §3's entire
      -- mitigation for editing a role in place). A roles.manage holder with
      -- no users.manage — the exact "Director" shape
      -- tests/isolation/roles.test.ts already uses elsewhere ("lets
      -- roles.manage administer roles, and refuses without it") — would be
      -- left with every one of those three surfaces silently wrong had this
      -- term been omitted. Scoped to company_memberships only, not
      -- organization_memberships above: listRoles never reads the latter, and
      -- a roles.manage holder has no product reason to see the Team screen's
      -- member list.
      or public.has_org_permission('roles.manage', organization_id)
    )
  );

-- ---------------------------------------------------------------------------
-- Minor 2 — has_permission / has_org_permission never joined roles.deleted_at.
-- ---------------------------------------------------------------------------
-- Archival is fail-closed today only because assign_company_role's FOR SHARE
-- check (0017) and accept_invitation's guard (0018) stop a live membership
-- from ever being written against an archived role. Both permission helpers
-- resolve a grant through role_permissions without ever checking the role
-- itself is live, so the fail-closed behaviour is contingent on that lock
-- pair holding everywhere a membership can be written, rather than structural
-- in the one place every permission check passes through. Recreated here with
-- the join added; every other clause is byte-for-byte the body 0016 shipped.
create or replace function public.has_permission(p_permission text, p_company_id uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select exists (select 1 from public.permissions p where p.code = p_permission)
     and public.has_company_access(p_company_id)
     and (
       public.is_platform_admin()
       or exists (
         select 1 from public.companies c
         where c.id = p_company_id and public.is_owner(c.organization_id)
       )
       or exists (
         select 1
         from public.company_memberships cm
         join public.roles r on r.id = cm.role_id and r.deleted_at is null
         join public.role_permissions rp on rp.role_id = cm.role_id
         where cm.user_id = auth.uid()
           and cm.company_id = p_company_id
           and cm.deleted_at is null
           and rp.permission_code = p_permission
       )
     );
$$;

comment on function public.has_permission(text, uuid) is
  'Valid code AND active subscription AND (admin OR owner OR the role assigned in THAT Company grants it). The role must be live (r.deleted_at is null, 0024 Minor 2) — previously fail-closed only by construction (assign_company_role/accept_invitation refusing to attach a live membership to an archived role), now structural here too.';

create or replace function public.has_org_permission(p_permission text, p_organization_id uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select exists (select 1 from public.permissions p where p.code = p_permission)
     and (
       public.is_platform_admin()
       or (
         -- The owner's bypass carries the same subscription gate as the role
         -- path, or the two helpers disagree about a suspended Station.
         public.is_owner(p_organization_id)
         and exists (
           select 1 from public.companies c
           where c.organization_id = p_organization_id
             and c.status = 'active'
             and c.deleted_at is null
         )
       )
       or exists (
         select 1
         from public.company_memberships cm
         join public.companies c          on c.id = cm.company_id
         join public.roles r              on r.id = cm.role_id and r.deleted_at is null
         join public.role_permissions rp  on rp.role_id = cm.role_id
         where cm.user_id = auth.uid()
           and cm.organization_id = p_organization_id
           and cm.deleted_at is null
           and c.status = 'active'
           and c.deleted_at is null
           and rp.permission_code = p_permission
       )
     );
$$;

comment on function public.has_org_permission(text, uuid) is
  'Valid code AND (admin OR owner OR a role in any ACTIVE Company of the Organization grants it). The role must be live (r.deleted_at is null, 0024 Minor 2) — see has_permission''s comment for why this was contingent rather than structural before.';
