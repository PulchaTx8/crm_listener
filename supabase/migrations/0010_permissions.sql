-- Permissions are seeded data, not runtime data. Roles are fixed
-- (member_role from 0003), so "who may do what" changes through a reviewed,
-- versioned migration rather than a click in production. That is why this
-- block ships no role-editing screen: it would be its highest-risk surface
-- and the business has not asked for it.
create table public.permissions (
  code                text primary key,
  description         text not null,
  introduced_by_block text not null,
  created_at          timestamptz not null default now()
);

comment on table public.permissions is 'Catalogue of permission codes. Each block inserts its own in its own migration.';

create table public.role_permissions (
  role            public.member_role not null,
  permission_code text not null references public.permissions (code) on delete cascade,
  primary key (role, permission_code)
);

comment on table public.role_permissions is 'Which fixed role grants which permission. Seeded; never written at runtime.';

-- This block seeds only what it enforces. Block 2 adds inventory.* in its own
-- migration, so a permission is born beside the feature it guards.
insert into public.permissions (code, description, introduced_by_block) values
  ('users.invite', 'Create and revoke invitations to the Organization', '1b'),
  ('users.manage', 'Change a member''s role and remove members',        '1b'),
  ('audit.view',   'Read the Organization''s audit trail',              '1b');

-- operator and viewer intentionally hold nothing in this block. There is no
-- business domain yet, so the only distinction that exists is owner/not-owner.
insert into public.role_permissions (role, permission_code) values
  ('owner', 'users.invite'),
  ('owner', 'users.manage'),
  ('owner', 'audit.view');

-- Business tables use this from Block 2 onward.
--
-- The permissions-existence check sits OUTSIDE the platform-admin bypass, and
-- the order matters. Written the obvious way, `is_platform_admin() or exists(...)`
-- short-circuits before permission_code is ever compared, so a typo'd code would
-- return true for an admin on any active Company. has_company_access (0005) uses
-- that same shape correctly, because the check it bypasses is membership; here it
-- would bypass the validity of the code itself. The shape does not transfer.
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
         select 1
         from public.company_memberships cm
         join public.role_permissions rp on rp.role = cm.role
         where cm.user_id = auth.uid()
           and cm.company_id = p_company_id
           and cm.deleted_at is null
           and rp.permission_code = p_permission
       )
     );
$$;

comment on function public.has_permission(text, uuid) is
  'Valid permission code AND active subscription AND the role grants it. Business tables use this.';

-- Identity operations are Organization-scoped, so they need their own helper:
-- forcing an invitation through a Company-scoped check would make it pick an
-- arbitrary Company just to satisfy the signature. No subscription term here,
-- because an Organization is always active — only Companies are suspended.
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
       or exists (
         select 1
         from public.organization_memberships om
         join public.role_permissions rp on rp.role = om.role
         where om.user_id = auth.uid()
           and om.organization_id = p_organization_id
           and om.deleted_at is null
           and rp.permission_code = p_permission
       )
     );
$$;

comment on function public.has_org_permission(text, uuid) is
  'Valid permission code AND the Organization role grants it. Identity operations use this.';

revoke execute on function public.has_permission(text, uuid) from public;
revoke execute on function public.has_org_permission(text, uuid) from public;
grant execute on function public.has_permission(text, uuid) to authenticated;
grant execute on function public.has_org_permission(text, uuid) to authenticated;
