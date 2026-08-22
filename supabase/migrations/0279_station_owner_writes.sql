-- supabase/migrations/0279_station_owner_writes.sql

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
       -- THE STATION'S OWN OWNER (design D17), unconditional: every permission,
       -- read and write, at THIS Station and at no other. 0278's comment says
       -- why the concept had to arrive with 0277 rather than in a later block --
       -- without it that migration leaves every Station operable by nobody.
       --
       -- Deliberately NOT is_owner_of_company, which resolves the Station's
       -- Organization and asks whether the caller owns the GROUP. That is the
       -- question 0277 just narrowed, and it is also the question nine SELECT
       -- policies ask; the two must not be conflated.
       or public.is_station_owner_for(p_user_id, p_company_id)
       -- D19, AND IT IS A RESTRICTION RATHER THAN THE ADDITION THE DECISION
       -- SOUNDS LIKE. Until this migration this branch was unconditional: a
       -- group's owner held EVERY permission at every Station of the group --
       -- creating promotions, adjusting inventory, erasing listeners, at a
       -- Station they had never staffed. The owner's ruling of 2026-08-22 is
       -- that an Organization's users read everything and change nothing, so
       -- the branch now asks the catalogue what kind of permission this is.
       --
       -- has_company_access_for, in the line above, is deliberately NOT touched.
       -- It is what lets the group reach the Station at all, and narrowing it
       -- would take the reading away along with the writing -- the opposite of
       -- what D19 asks for.
       --
       -- THE KIND IS READ FROM THE CATALOGUE (0276) rather than matched on the
       -- code's shape. "Everything ending in .view" would have been shorter and
       -- would have made a WRITE of reports.consolidated, which gates the
       -- dashboard's Station pills -- reading numbers across a group, and the
       -- single most group-shaped thing in the product.
       or exists (
         select 1
         from public.companies c
         join public.permissions p on p.code = p_permission
         where c.id = p_company_id
           and p.kind = 'READ'
           and public.is_owner_for(p_user_id, c.organization_id)
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
  'Valid code AND active subscription AND (platform admin OR THIS Station''s own owner OR the Organization''s owner FOR A READ ONLY OR the role assigned in THIS Company grants it). The role must be live (r.deleted_at is null, 0024 Minor 2). Two of those four are newer than the function. The Organisation clause was unconditional until 0277, when design D19 narrowed it to permissions the catalogue marks READ (0276): a group''s owner had held every permission at every Station of the group, writes included. And the Station-owner clause arrived in 0279 because 0277 needed it -- a Station has no staff of its own, add_company creating only the company and an audit row, so the narrowing alone left every Station operable by nobody. has_company_access_for is untouched throughout, so a group still reaches its Stations; what it lost is the ability to change anything there. has_permission has had no body of its own since 0121; it is this function with auth.uid(), so the rule a worker applies and the rule a screen applies cannot drift apart.';
