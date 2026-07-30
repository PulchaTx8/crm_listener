-- supabase/migrations/0046_rls_promotion_prizes.sql
--
-- Earlier in the block than 0029 and 0044 sat in theirs, and deliberately: every
-- task after this one asserts state by reading these two tables, and a suite
-- that cannot read them would have to assert through functions that do not
-- exist yet. There was no readable window either way — 0045 enabled RLS on both
-- tables at creation, and the default ACL on `public` grants a fresh table only
-- Dxtm to the Supabase roles, the point 0029's own comment settled with
-- evidence.

revoke all on public.promotion_prizes         from anon, authenticated;
revoke all on public.promotion_prize_balances from anon, authenticated;

-- No table takes an insert, update or delete grant from any role, service_role
-- included: every write goes through a SECURITY DEFINER RPC that runs as the
-- table owner and needs no grant of its own. On promotion_prize_balances this
-- is what makes apply_inventory_movement (0047) the single writer rather than
-- merely the intended one.
grant select on public.promotion_prizes         to authenticated, service_role;
grant select on public.promotion_prize_balances to authenticated, service_role;

-- `revoke all` above ran against anon and authenticated only, so service_role
-- kept the default ACL's TRUNCATE on both — the hole 0029 found late and closed
-- for the four inventory tables. Closed here at the same time as the grant,
-- rather than after somebody notices again.
revoke truncate on public.promotion_prizes         from service_role;
revoke truncate on public.promotion_prize_balances from service_role;

-- `deleted_at is null` is baked in here, unlike 0044's policy on promotions
-- itself. That exception exists so the owner can filter for archived
-- promotions; there is no equivalent screen for unwound links, and their
-- history lives in the ledger, so an ordinary read must not list them.
--
-- The `promotion_id in (select ...)` clause is not redundant with the
-- permission check beside it: that subquery is itself filtered by 0044's
-- policy, so an archived promotion's links are visible to exactly whoever can
-- see the archived promotion. Without it a delegate who kept an id could read
-- the links of a promotion that has left every one of their other reads — the
-- links, not the promotion, would become the leak.
create policy promotion_prizes_select_promotions_view on public.promotion_prizes
  for select to authenticated
  using (
    deleted_at is null
    and public.has_permission('promotions.view', company_id)
    and promotion_id in (select id from public.promotions)
  );

-- Same shape one level down, and the subquery is what carries both the
-- soft-delete filter and the archived-promotion rule from the policy above
-- rather than restating either.
create policy promotion_prize_balances_select_promotions_view on public.promotion_prize_balances
  for select to authenticated
  using (
    public.has_permission('promotions.view', company_id)
    and promotion_prize_id in (select id from public.promotion_prizes)
  );
