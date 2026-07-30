-- supabase/migrations/0044_rls_promotions.sql

-- has_permission (0024) already admits the platform admin and the Organization
-- owner, so it cannot express "the owner ALSO sees archived rows" by itself —
-- every caller it admits would see them. This is that second predicate.
--
-- It has to be SECURITY DEFINER rather than an inline EXISTS over
-- public.companies inside the policy: an EXISTS in a policy body is itself
-- subject to the read policies of the table it touches, which is exactly what
-- forced the same move in 0024.
create or replace function public.is_owner_of_company(p_company_id uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select public.is_platform_admin()
      or exists (
        select 1 from public.companies c
        where c.id = p_company_id and public.is_owner(c.organization_id)
      );
$$;

comment on function public.is_owner_of_company(uuid) is
  'True for the platform admin and for the Organization owner of that Station. Exists so a policy can admit the owner to rows it hides from everyone else: the owner resolves discrepancies himself rather than calling support, and cannot do that without seeing the archived row and who archived it.';

revoke execute on function public.is_owner_of_company(uuid) from public;
grant execute on function public.is_owner_of_company(uuid) to authenticated;

-- No table takes an insert, update or delete grant from any role, service_role
-- included: every write goes through a SECURITY DEFINER RPC that runs as the
-- table owner and needs no grant of its own. This is what makes 0042/0043 the
-- single write path rather than merely the intended one.
grant select on public.promotions                 to authenticated, service_role;
grant select on public.promotion_questions        to authenticated, service_role;
grant select on public.promotion_question_options to authenticated, service_role;

-- Unlike prizes (0029), `deleted_at is null` is NOT baked in for everyone. That
-- decision cost the inventory screen its archived filter and left an open item
-- in the Block 3b report; here the owner keeps the read and the service does
-- the hiding, so an "archived" filter is possible without touching RLS again.
create policy promotions_select_promotions_view on public.promotions
  for select to authenticated
  using (
    public.has_permission('promotions.view', company_id)
    and (deleted_at is null or public.is_owner_of_company(company_id))
  );

-- The `promotion_id in (select ...)` clause is not redundant with the
-- permission check beside it. That subquery is itself filtered by the policy
-- above, so an archived promotion's quiz is visible to exactly whoever can see
-- the archived promotion. Without it, a delegate who kept an id could still
-- read the questions of a promotion that has left every one of their other
-- reads — the quiz, not the promotion, would become the leak.
create policy promotion_questions_select_promotions_view on public.promotion_questions
  for select to authenticated
  using (
    public.has_permission('promotions.view', company_id)
    and promotion_id in (select id from public.promotions)
  );

create policy promotion_question_options_select_promotions_view on public.promotion_question_options
  for select to authenticated
  using (
    public.has_permission('promotions.view', company_id)
    and question_id in (select id from public.promotion_questions)
  );
