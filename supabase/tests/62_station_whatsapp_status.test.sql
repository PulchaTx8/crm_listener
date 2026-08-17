begin;
select plan(8);

-- Block 29a, 0218. The door that lets an Organization OWNER read whether their
-- Station is paired with WhatsApp.
--
-- WHY IT NEEDS A FILE OF ITS OWN. This is the first function in the codebase to
-- read `integrations` (0057) for anybody other than the platform admin. That
-- table has RLS enabled and NO POLICIES, so it is reachable only through
-- SECURITY DEFINER functions, and all three of 0130's open on
-- `is_platform_admin()`. Widening that reach is exactly the kind of change that
-- must be pinned structurally rather than trusted to a screen: the screen can
-- be rewritten, the grant cannot be, and a grant to `anon` here would hand a
-- Station's telephone number to the internet.

-- ---------------------------------------------------------------------------
-- 1. It exists, and it is the shape the caller was written against.
-- ---------------------------------------------------------------------------
select has_function('public', 'station_whatsapp_status', array['uuid'],
  'station_whatsapp_status(uuid) exists');

-- SECURITY DEFINER is the whole mechanism: `integrations` has no policy for
-- `authenticated` to satisfy, so an INVOKER-rights version of this function
-- would return an empty row for every caller and look like "nothing is paired"
-- rather than like a permission error. That is the failure mode this product
-- keeps paying for, and it would be indistinguishable on screen from the state
-- the whole block exists to help an owner leave.
select is(
  (select prosecdef from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'station_whatsapp_status'),
  true,
  'it is SECURITY DEFINER -- an INVOKER version would read nothing and say "not connected"');

-- An unpinned search_path in a SECURITY DEFINER function is the redirection
-- hazard pinning exists to close, and every door in this schema carries it.
select ok(
  exists (
    select 1 from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname = 'station_whatsapp_status'
       and p.proconfig @> array['search_path=pg_catalog, public']),
  'its search_path is pinned');

-- STABLE rather than VOLATILE: it writes nothing, and the planner may say so.
select is(
  (select provolatile from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'station_whatsapp_status'),
  's'::"char",
  'it is STABLE -- it reads and writes nothing');

-- ---------------------------------------------------------------------------
-- 2. The grants. The positive half alone would pass for a function granted to
-- the world, so both halves are here.
-- ---------------------------------------------------------------------------
select ok(
  has_function_privilege('authenticated', 'public.station_whatsapp_status(uuid)', 'execute'),
  'authenticated may call it -- the owner is an ordinary signed-in member');

-- The two that must NEVER hold it. `anon` is the widget's role and the sign-in
-- screen's; a Station's display number is not public. `public` is the default
-- ACL PostgreSQL hands out unless a migration revokes it, which is the hole
-- 0029 found in review and four migrations have closed since.
select ok(
  not has_function_privilege('anon', 'public.station_whatsapp_status(uuid)', 'execute'),
  'anon may not -- a Station''s telephone number is not public');

select ok(
  not exists (
    select 1
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace,
           unnest(coalesce(p.proacl, acldefault('f', p.proowner))) as acl
     where n.nspname = 'public'
       and p.proname = 'station_whatsapp_status'
       and acl::text like '=X/%'),
  'PUBLIC holds no EXECUTE -- the default ACL was revoked, not left');

-- ---------------------------------------------------------------------------
-- 3. THE GATE. The one assertion this file would be worthless without: the
-- function must refuse a caller who is not the owner. `is_owner_of_company`
-- (0044) is also true for the platform admin, which is the house convention
-- and the intended reading (support acting for a customer) -- so what is
-- pinned here is that SOME ownership predicate is consulted at all, by name,
-- rather than the function returning rows to whoever calls it.
--
-- Asserted against the function's SOURCE rather than by calling it as a fake
-- user, and the reason is worth stating: `auth.uid()` reads a request-scoped
-- JWT claim that pgTAP has no way to set truthfully, so a call-based test here
-- would exercise the null-actor path and pass whether or not the guard names
-- the right predicate. tests/isolation/ is where doors are proved against real
-- sessions; this file proves the guard is present and cannot be dropped in a
-- refactor.
-- ---------------------------------------------------------------------------
select ok(
  (select prosrc from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'station_whatsapp_status')
    like '%is_owner_of_company%',
  'it consults is_owner_of_company before returning anything');

select * from finish();
rollback;
