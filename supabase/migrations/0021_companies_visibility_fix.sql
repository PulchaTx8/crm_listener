-- supabase/migrations/0021_companies_visibility_fix.sql

-- companies_select_org_member (0006) predates Block 1c's per-Company roles: it
-- let ANY member of an Organization read the metadata of EVERY Company in it,
-- which was harmless when an Organization held exactly one Company and "member
-- of the org" and "member of its one Company" were the same fact. Now that an
-- Organization can hold several Companies (0017's add_company) with roles
-- assigned per Company, that policy quietly defeats the point of this block:
-- found while writing the Task 12 end-to-end journey — a colleague granted a
-- role in Station A alone could still see Station B's name and status on
-- `/app` (Task 11) before ever being granted access to it. Task 11's own brief
-- ("RLS already limits this to the user's Organization") assumed Organization
-- membership was the right boundary for this list; Block 1c moved that
-- boundary to the Company.
--
-- Fixed to the same shape has_company_access (0016) already uses for business
-- data: the Organization owner and a platform admin still see every Company
-- (they have full access to all of them, by ownership or by role); anyone
-- else only sees a Company where they hold a live company_membership row.
-- Suspended Companies stay visible to whoever already has access to them, so
-- "why did access stop" still renders (0006's original intent) — this fix
-- narrows WHO can see a Company's metadata, not WHEN a reachable Company's
-- metadata is hidden.
--
-- is_company_member is its own SECURITY DEFINER helper, not an inline exists()
-- against company_memberships in the policy below — company_memberships'
-- OWN select policy (0016) reads back from companies (to resolve the owner
-- bypass), so an inline subquery here recurses: evaluating companies'
-- policy requires evaluating company_memberships' policy, which requires
-- evaluating companies' policy again. Postgres catches this at runtime with
-- "infinite recursion detected in policy for relation companies" (42P17) —
-- confirmed empirically while writing this migration. Every cross-table RLS
-- helper in this project (is_org_member, is_owner, has_company_access,
-- shares_organization_with, ...) is SECURITY DEFINER for exactly this reason:
-- it runs as the function's owner, which sidesteps the calling role's RLS
-- entirely instead of re-entering it.
create or replace function public.is_company_member(p_company_id uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select exists (
    select 1 from public.company_memberships cm
    where cm.company_id = p_company_id
      and cm.user_id = auth.uid()
      and cm.deleted_at is null
  );
$$;

comment on function public.is_company_member(uuid) is
  'A live company_membership row for this caller in this Company, regardless of its status. Company metadata visibility uses this; has_company_access (0016) additionally requires an active subscription for business data.';

revoke execute on function public.is_company_member(uuid) from public;
grant execute on function public.is_company_member(uuid) to authenticated;

drop policy companies_select_org_member on public.companies;

create policy companies_select_org_member on public.companies
  for select to authenticated
  using (
    deleted_at is null
    and (
      public.is_platform_admin()
      or public.is_owner(organization_id)
      or public.is_company_member(id)
    )
  );
