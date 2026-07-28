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
-- inventory.view, resolved from the row's own company_id. prize_categories
-- and prizes ALSO filter deleted_at is null, the same convention every other
-- soft-deleted table in this project uses at the policy (0006's companies,
-- 0019's roles) — an ordinary select through PostgREST must not list archived
-- rows just because whoever writes the next screen forgot to filter them out
-- client-side. reconcile_inventory (0028) is not a reason to omit the filter:
-- it is SECURITY DEFINER and runs as the table owner, so it never consults
-- this policy at all — the same RLS-bypass 0024's own comment documents for
-- why an inline EXISTS had to move into a SECURITY DEFINER helper. Filtering
-- here costs that function nothing and closes a real gap in the ordinary
-- read path. inventory_movements and inventory_balances carry no deleted_at
-- at all, so no equivalent filter applies to them.
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
  using (deleted_at is null and public.has_permission('inventory.view', company_id));

create policy prizes_select_inventory_view on public.prizes
  for select to authenticated
  using (deleted_at is null and public.has_permission('inventory.view', company_id));

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

-- `revoke all` above only ever ran against anon/authenticated (the two roles
-- this migration explicitly seals), so service_role kept the default ACL's
-- TRUNCATE grant on all four tables (the same "Dxtm" default this migration's
-- own comment names for anon/authenticated before the explicit revoke) — in
-- direct tension with "immutability is a grant, not a comment": TRUNCATE is
-- neither INSERT, UPDATE nor DELETE, so nothing above closes it, and a single
-- `TRUNCATE inventory_movements` from service_role could still wipe the
-- ledger in one statement. Closed with the one grant class this migration had
-- not yet touched for this role.
revoke truncate on public.prize_categories    from service_role;
revoke truncate on public.prizes              from service_role;
revoke truncate on public.inventory_movements from service_role;
revoke truncate on public.inventory_balances  from service_role;
