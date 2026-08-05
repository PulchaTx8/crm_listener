-- supabase/migrations/0121_permission_for.sql

-- Block 8b, Task 2: the identity the worker does not have.
--
-- THE FACT THIS FILE EXISTS FOR. The worker tick (src/app/api/worker/tick)
-- holds a service_role client. In it, auth.uid() is null -- a service_role JWT
-- carries no `sub` claim -- so is_platform_admin() is false, has_company_access
-- is false, and has_permission is false for every code and every Station. That
-- is correct behaviour, and it is also why a background job cannot ask the
-- existing helpers anything useful: they can only answer about the CALLER, and
-- the worker is never the person whose report it is generating.
--
-- So each helper gains a sibling taking the user id explicitly, and each
-- EXISTING helper becomes a one-line wrapper passing auth.uid(). The wrapper
-- shape is the entire safety argument: two independent implementations of "may
-- this user read this" would agree on the day they were written and drift
-- afterwards, and a drift here does not look like a defect -- it looks like a
-- report with the wrong rows in it. 21_permission_for.test.sql asserts that the
-- old signatures keep NO body of their own, so an editor who inlines one for
-- "performance" fails the suite rather than silently forking the rule.
--
-- NOTHING ABOUT THE AUTHORISATION RULES CHANGES HERE. Every body below is the
-- body that stood after 0024, with auth.uid() replaced by the parameter. A
-- reader diffing this against 0005/0016/0024 who finds a difference that is not
-- that substitution has found a defect in this migration.
--
-- has_org_permission is deliberately NOT given a sibling. No background job in
-- this block asks an Organization-scoped question, and a function nobody calls
-- is a rule nobody maintains. It still delegates correctly, because the two
-- helpers inside it (is_platform_admin, is_owner) are wrappers from here on.

-- ---------------------------------------------------------------------------
-- 1. is_platform_admin_for
-- ---------------------------------------------------------------------------

create or replace function public.is_platform_admin_for(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select exists (
    select 1 from public.platform_admins pa
    where pa.user_id = p_user_id
  );
$$;

comment on function public.is_platform_admin_for(uuid) is
  'Block 8b. Whether a NAMED user is a platform admin; is_platform_admin() is this with auth.uid(). A null argument matches nothing, because platform_admins.user_id is NOT NULL -- which is exactly the behaviour the worker needs: no identity means no rights.';

create or replace function public.is_platform_admin()
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select public.is_platform_admin_for(auth.uid());
$$;

-- ---------------------------------------------------------------------------
-- 2. is_owner_for
-- ---------------------------------------------------------------------------

create or replace function public.is_owner_for(p_user_id uuid, p_organization_id uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select exists (
    select 1 from public.organization_memberships om
    where om.user_id = p_user_id
      and om.organization_id = p_organization_id
      and om.role = 'owner'
      and om.deleted_at is null
  );
$$;

comment on function public.is_owner_for(uuid, uuid) is
  'Block 8b. Whether a NAMED user owns the Organization; is_owner(uuid) is this with auth.uid().';

create or replace function public.is_owner(p_organization_id uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select public.is_owner_for(auth.uid(), p_organization_id);
$$;

-- ---------------------------------------------------------------------------
-- 3. has_company_access_for
--
-- The subscription term (c.status = 'active') stays INSIDE, exactly where 0016
-- put it. It is what stops a lapsed customer reading through a role that still
-- exists, and a background job is the last place it should become optional.
-- ---------------------------------------------------------------------------

create or replace function public.has_company_access_for(p_user_id uuid, p_company_id uuid)
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
        public.is_platform_admin_for(p_user_id)
        or public.is_owner_for(p_user_id, c.organization_id)
        or exists (
          select 1 from public.company_memberships cm
          where cm.user_id = p_user_id
            and cm.company_id = c.id
            and cm.deleted_at is null
        )
      )
  );
$$;

comment on function public.has_company_access_for(uuid, uuid) is
  'Block 8b. Active subscription AND (platform admin OR owner of the Organization OR a live membership), for a NAMED user; has_company_access(uuid) is this with auth.uid(). The owner holds no membership row by design.';

create or replace function public.has_company_access(p_company_id uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select public.has_company_access_for(auth.uid(), p_company_id);
$$;

-- ---------------------------------------------------------------------------
-- 4. has_permission_for
--
-- The permission-existence check stays OUTSIDE every bypass, which is 0010's
-- rule and the one most easily lost in a refactor: written the obvious way,
-- `is_platform_admin_for(u) or exists(...)` short-circuits before
-- permission_code is ever compared, and a typo'd code would return true for an
-- admin on any active Company. 21_permission_for.test.sql asserts that case
-- directly.
--
-- The live-role join (r.deleted_at is null) is 0024's Minor 2, carried forward
-- verbatim.
-- ---------------------------------------------------------------------------

create or replace function public.has_permission_for(
  p_user_id     uuid,
  p_permission  text,
  p_company_id  uuid
)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select exists (select 1 from public.permissions p where p.code = p_permission)
     and public.has_company_access_for(p_user_id, p_company_id)
     and (
       public.is_platform_admin_for(p_user_id)
       or exists (
         select 1 from public.companies c
         where c.id = p_company_id and public.is_owner_for(p_user_id, c.organization_id)
       )
       or exists (
         select 1
         from public.company_memberships cm
         join public.roles r on r.id = cm.role_id and r.deleted_at is null
         join public.role_permissions rp on rp.role_id = cm.role_id
         where cm.user_id = p_user_id
           and cm.company_id = p_company_id
           and cm.deleted_at is null
           and rp.permission_code = p_permission
       )
     );
$$;

comment on function public.has_permission_for(uuid, text, uuid) is
  'Block 8b. Valid code AND active subscription AND (admin OR owner OR the role assigned in THAT Company grants it) -- for a NAMED user rather than the caller. has_permission(text, uuid) is this with auth.uid() and keeps no body of its own, so the two can never disagree. This is what lets the worker tick generate a report scoped to the person who asked for it, having no identity of its own.';

create or replace function public.has_permission(p_permission text, p_company_id uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select public.has_permission_for(auth.uid(), p_permission, p_company_id);
$$;

comment on function public.has_permission(text, uuid) is
  'Valid code AND active subscription AND (admin OR owner OR the role assigned in THAT Company grants it). The role must be live (r.deleted_at is null, 0024 Minor 2). Since 0121 this function has NO BODY OF ITS OWN: it is has_permission_for(auth.uid(), ...), so the rule the worker applies and the rule a screen applies cannot drift apart.';

-- ---------------------------------------------------------------------------
-- 5. is_owner_of_company_for
--
-- FOUND WHILE WRITING 0124, not while writing this file, and the way it was
-- found is worth recording. 0044 introduced is_owner_of_company so a policy
-- could admit the Organization's owner to rows it hides from everyone else --
-- an ARCHIVED promotion, which the owner must see to resolve a discrepancy
-- himself. 0090 restates that rule by hand, because SECURITY DEFINER inherits
-- none of it, and the report over participations must restate it identically or
-- the export and the screen disagree about which entries exist.
--
-- Without this sibling, that restatement in the worker would ask about
-- auth.uid() -- null -- and quietly answer "not the owner". The failure is
-- FAIL-CLOSED, so nothing leaks; it is worse than a leak in one specific way:
-- an owner who exported a report would get a file missing exactly the rows the
-- screen was showing him, with nothing anywhere saying why.
-- ---------------------------------------------------------------------------

create or replace function public.is_owner_of_company_for(p_user_id uuid, p_company_id uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select public.is_platform_admin_for(p_user_id)
      or exists (
        select 1 from public.companies c
        where c.id = p_company_id and public.is_owner_for(p_user_id, c.organization_id)
      );
$$;

comment on function public.is_owner_of_company_for(uuid, uuid) is
  'Block 8b. True for the platform admin and for the Organization owner of that Station, for a NAMED user; is_owner_of_company(uuid) is this with auth.uid(). Exists so a background job can apply 0044''s archived-row rule as the person who asked for the report rather than as nobody.';

create or replace function public.is_owner_of_company(p_company_id uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select public.is_owner_of_company_for(auth.uid(), p_company_id);
$$;

-- ---------------------------------------------------------------------------
-- Grants.
--
-- The `_for` siblings go to service_role as well as authenticated, which is the
-- entire point of them. The wrappers keep exactly the grants 0005 gave them and
-- gain nothing: service_role has no use for a function that asks about
-- auth.uid(), and granting it would invite exactly the mistake this block
-- exists to avoid -- a background job calling the caller-shaped door and
-- getting a confident false.
-- ---------------------------------------------------------------------------

revoke execute on function public.is_platform_admin_for(uuid) from public;
revoke execute on function public.is_owner_for(uuid, uuid) from public;
revoke execute on function public.has_company_access_for(uuid, uuid) from public;
revoke execute on function public.has_permission_for(uuid, text, uuid) from public;
revoke execute on function public.is_owner_of_company_for(uuid, uuid) from public;

grant execute on function public.is_platform_admin_for(uuid) to authenticated, service_role;
grant execute on function public.is_owner_for(uuid, uuid) to authenticated, service_role;
grant execute on function public.has_company_access_for(uuid, uuid) to authenticated, service_role;
grant execute on function public.has_permission_for(uuid, text, uuid) to authenticated, service_role;
grant execute on function public.is_owner_of_company_for(uuid, uuid) to authenticated, service_role;
