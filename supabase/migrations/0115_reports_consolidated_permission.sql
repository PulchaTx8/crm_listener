-- supabase/migrations/0115_reports_consolidated_permission.sql

-- Block 8a, Task 1: the one permission this block introduces.
--
-- Design spec D2 and D3. Each dashboard is gated by its own domain's code --
-- members.view, music.view, promotions.view -- because a counter is a small
-- leak of a fact the caller was not allowed to see, and a single dashboards.view
-- would hand somebody the size, origin and growth of an audience they cannot
-- list. This code buys exactly one thing on top of those: summing more than one
-- Station into a single screen.
--
-- Company-scoped, not organization-scoped, and the difference is the whole
-- design: a consolidated call requires this code in EVERY Station it names
-- (D3), so the total can never contain a Station the caller could not have
-- visited one at a time. An organization-scoped code would be satisfied by
-- holding it in any single Station, which is the opposite of the rule.
--
-- THE DAY THIS SHIPS IT IS LIVE. Unlike music.request in 7a -- which shipped
-- assignable at zero capability and acquired a real one a block later -- any
-- role granted this code reads the whole group's numbers in one screen from
-- the moment 0118-0120 land.
insert into public.permissions
  (code, description, introduced_by_block, module, label, scope, display_order)
values
  ('reports.consolidated',
   'Sum several Stations into one dashboard',
   '8a', 'reports', 'See a consolidated dashboard', 'company', 10);
