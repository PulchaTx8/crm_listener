-- These four functions are the whole isolation model. They query the
-- membership tables on every call rather than reading JWT claims, so that
-- revoking access takes effect immediately instead of waiting up to an hour
-- for a token to refresh. STABLE lets PostgreSQL reuse the result within a
-- single statement, and the *_lookup indexes from 0003 keep it cheap.
--
-- All of them are SECURITY DEFINER so that they can read the membership
-- tables regardless of the policies on those tables — otherwise a policy that
-- calls the helper would recurse into itself.

create or replace function public.is_platform_admin()
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select exists (
    select 1 from public.platform_admins pa
    where pa.user_id = auth.uid()
  );
$$;

create or replace function public.is_org_member(p_organization_id uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select public.is_platform_admin() or exists (
    select 1 from public.organization_memberships om
    where om.user_id = auth.uid()
      and om.organization_id = p_organization_id
      and om.deleted_at is null
  );
$$;

create or replace function public.is_owner(p_organization_id uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select exists (
    select 1 from public.organization_memberships om
    where om.user_id = auth.uid()
      and om.organization_id = p_organization_id
      and om.role = 'owner'
      and om.deleted_at is null
  );
$$;

-- The helper every business table will use from Block 2 onward. It carries
-- BOTH conditions: the user is a member, AND the Company's subscription is
-- active. A suspended Company therefore yields no business data even to its
-- own Owner, without any table needing to remember the status check.
create or replace function public.has_company_access(p_company_id uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select exists (
    select 1
    from public.companies c
    where c.id = p_company_id
      and c.status = 'active'
      and c.deleted_at is null
      and (
        public.is_platform_admin()
        or exists (
          select 1 from public.company_memberships cm
          where cm.user_id = auth.uid()
            and cm.company_id = c.id
            and cm.deleted_at is null
        )
      )
  );
$$;

comment on function public.has_company_access(uuid) is
  'Membership AND active subscription. Business tables use this; company metadata visibility uses is_org_member instead.';

revoke execute on function public.is_platform_admin() from public;
revoke execute on function public.is_org_member(uuid) from public;
revoke execute on function public.is_owner(uuid) from public;
revoke execute on function public.has_company_access(uuid) from public;

grant execute on function public.is_platform_admin() to authenticated;
grant execute on function public.is_org_member(uuid) to authenticated;
grant execute on function public.is_owner(uuid) to authenticated;
grant execute on function public.has_company_access(uuid) to authenticated;
