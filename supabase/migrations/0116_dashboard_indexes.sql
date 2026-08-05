-- supabase/migrations/0116_dashboard_indexes.sql

-- Block 8a, Task 1: two indexes the aggregates need, each a gap found by
-- reading the existing DDL -- and a third this migration originally added on
-- the same reasoning, which the fix wave's own EXPLAIN (ANALYZE) then refused.
--
-- Every figure in this block filters one table by Station AND a date range.
-- Two of the four source tables have no index that supports that pair, and
-- music_requests -- a third -- already has (company_id, requested_at) from
-- 0098 and is deliberately untouched here.

-- participations' only listing index is (promotion_id, participated_at desc,
-- id desc) from 0052, which serves the participants screen: that screen always
-- knows its promotion. A Station-wide count over a period has no promotion to
-- start from and would scan.
create index participations_company_period_idx
  on public.participations (company_id, participated_at);

-- member_company_links (company_id, linked_at) was proposed here on the
-- reasoning that linked_at is the column every arrival figure filters on
-- (design spec D9) and (company_id) alone from 0031 does not cover it. It
-- shipped in this migration's first draft and was measured, not kept: EXPLAIN
-- (ANALYZE) against every plan this block produces -- including an isolated
-- read bound to a single literal date -- never chose it. Postgres prefers
-- 0031's existing single-column member_links_company_idx (company_id) in
-- every case, for two structural reasons rather than one unlucky plan: the
-- `link` CTE in 0118 selects member_id, not linked_at, so no index-only scan
-- is possible regardless of column order, and by the time the date bound
-- reaches the planner it is a filter on an already-materialised CTE rather
-- than a range Postgres can push into an index scan. An index nothing reads
-- is a write cost with no reader, so it is not created here. The migration is
-- unmerged, so this is that first draft corrected in place, not a later
-- migration undoing it.

-- winners has (draw_id, awarded_rank) and a partial (deadline_at) from 0075.
-- Neither serves "prizes awarded at this Station during this period"; the
-- deadline index serves the overdue figure and stays as it is.
create index winners_company_created_idx
  on public.winners (company_id, created_at);
