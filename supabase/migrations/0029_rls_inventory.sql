-- supabase/migrations/0029_rls_inventory.sql

alter table public.prize_categories    enable row level security;
alter table public.prizes              enable row level security;
alter table public.inventory_movements enable row level security;
alter table public.inventory_balances  enable row level security;

revoke all on public.prize_categories    from anon, authenticated;
revoke all on public.prizes              from anon, authenticated;
revoke all on public.inventory_movements from anon, authenticated;
revoke all on public.inventory_balances  from anon, authenticated;

-- Four tables built across Tasks 1 and 2, secured only now. That split is how
-- every block in this project has sequenced it, and Block 1c's final review
-- closed the safety question with evidence: the default ACL on `public`
-- grants a freshly created table only Dxtm to the Supabase roles, so there
-- was never a readable window between Task 2 and this migration. But a table
-- this migration misses looks exactly like a table that never needed
-- securing — this project has shipped that mistake once already
-- (rate_limit_counters, Block 0) — so the state is asserted in
-- 02_permissions.test.sql rather than left to whoever reads the migration
-- list.
--
-- Read gate only, on all four: `select` for authenticated, gated on
-- inventory.view, resolved from the row's own company_id. No deleted_at
-- filter on prize_categories/prizes here — unlike the identity-block tables,
-- inventory.view is meant to see the full catalogue including archived
-- entries (reconciliation and history need them too), and inventory_movements
-- / inventory_balances carry no deleted_at at all, so a uniform condition
-- across all four keeps the four policies readable as siblings.
--
-- No table takes an insert, update or delete grant from any role, including
-- service_role. On inventory_movements this is what makes the ledger's
-- append-only comment (0026) real rather than promised; on
-- inventory_balances it is what makes apply_inventory_movement (0027) the
-- single writer rather than merely the intended one. Every write in this
-- block — catalogue and ledger alike — goes through a SECURITY DEFINER RPC
-- that runs as the table owner and so needs no grant of its own.
grant select on public.prize_categories    to authenticated;
grant select on public.prizes              to authenticated;
grant select on public.inventory_movements to authenticated;
grant select on public.inventory_balances  to authenticated;

create policy prize_categories_select_inventory_view on public.prize_categories
  for select to authenticated
  using (public.has_permission('inventory.view', company_id));

create policy prizes_select_inventory_view on public.prizes
  for select to authenticated
  using (public.has_permission('inventory.view', company_id));

create policy inventory_movements_select_inventory_view on public.inventory_movements
  for select to authenticated
  using (public.has_permission('inventory.view', company_id));

create policy inventory_balances_select_inventory_view on public.inventory_balances
  for select to authenticated
  using (public.has_permission('inventory.view', company_id));

-- service_role needs explicit grants: the default ACL gives it only Dxtm and
-- BYPASSRLS does not substitute for a GRANT (Block 1a §3.9) — a table missing
-- this fails at runtime, not at deploy time. Read-only here too: the RPCs in
-- 0027/0028 are SECURITY DEFINER and run as the table owner, so service_role
-- never needs a write grant to make them work, and giving it one would be a
-- second, unaudited way to move stock or rewrite the ledger.
grant select on public.prize_categories    to service_role;
grant select on public.prizes              to service_role;
grant select on public.inventory_movements to service_role;
grant select on public.inventory_balances  to service_role;
