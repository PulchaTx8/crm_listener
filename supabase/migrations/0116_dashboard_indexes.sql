-- supabase/migrations/0116_dashboard_indexes.sql

-- Block 8a, Task 1: the three indexes the aggregates need, and none of them is
-- a precaution -- each is a gap found by reading the existing DDL.
--
-- Every figure in this block filters one table by Station AND a date range.
-- Three of the four source tables have no index that supports that pair, and
-- music_requests -- the fourth -- already has (company_id, requested_at) from
-- 0098 and is deliberately untouched here.

-- participations' only listing index is (promotion_id, participated_at desc,
-- id desc) from 0052, which serves the participants screen: that screen always
-- knows its promotion. A Station-wide count over a period has no promotion to
-- start from and would scan.
create index participations_company_period_idx
  on public.participations (company_id, participated_at);

-- member_company_links has (company_id) alone from 0031. linked_at is the
-- column every arrival figure filters on -- design spec D9, a listener is new
-- at a Station when the LINK is new, because members themselves are
-- Organization-scoped and members.created_at would date them to another
-- Station's first sight of them.
create index member_links_company_linked_idx
  on public.member_company_links (company_id, linked_at);

-- winners has (draw_id, awarded_rank) and a partial (deadline_at) from 0075.
-- Neither serves "prizes awarded at this Station during this period"; the
-- deadline index serves the overdue figure and stays as it is.
create index winners_company_created_idx
  on public.winners (company_id, created_at);
