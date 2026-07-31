-- supabase/migrations/0053_rls_participations.sql

revoke all on public.participations        from anon, authenticated;
revoke all on public.participation_answers from anon, authenticated;

-- No table takes an insert, update or delete grant from any role, service_role
-- included: every write goes through a SECURITY DEFINER RPC (0054) that runs as
-- the table owner and needs no grant of its own.
grant select on public.participations        to authenticated, service_role;
grant select on public.participation_answers to authenticated, service_role;

-- `revoke all` above ran against anon and authenticated only, so service_role
-- kept the default ACL's TRUNCATE on both. Closed here at the same time as the
-- grant rather than after somebody notices — 0029 had to come back for this one.
revoke truncate on public.participations        from service_role;
revoke truncate on public.participation_answers from service_role;

-- The `promotion_id in (select ...)` clause is not redundant with the permission
-- check beside it. That subquery is itself filtered by 0044's policy on
-- promotions, which hides an archived promotion from everyone but the
-- Organization owner and the platform admin. Without it, a delegate who kept an
-- id could read the participations of a promotion that has left every one of
-- their other reads — the participations, not the promotion, would become the
-- leak.
create policy participations_select_participations_view on public.participations
  for select to authenticated
  using (
    public.has_permission('participations.view', company_id)
    and promotion_id in (select id from public.promotions)
  );

-- Same shape one level down, and the subquery is what carries the
-- archived-promotion rule from the policy above rather than restating it.
create policy participation_answers_select_participations_view on public.participation_answers
  for select to authenticated
  using (
    public.has_permission('participations.view', company_id)
    and participation_id in (select id from public.participations)
  );
