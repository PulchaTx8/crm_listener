-- supabase/migrations/0247_campaign_counter_bump.sql

-- Block 29d-2, Task 6b fix round 1 (review Item 2). The atomic increment
-- PostgREST cannot express.
--
-- drainCampaigns (src/services/campaigns.ts) settles a campaign's counters --
-- sent_count, failed_count, suppressed_count -- once per campaign per batch,
-- by reading the current values and writing back the sum with this tick's own
-- tally. That was a READ-THEN-WRITE from TypeScript, not because a lock was
-- forgotten but because there was no other way to say it: a PostgREST PATCH
-- body is literal JSON, never a SQL expression, so "sent_count = sent_count +
-- 1" cannot be said through the REST layer at all. Only a function running
-- the arithmetic INSIDE Postgres can.
--
-- THE COST OF NOT HAVING ONE. pg_cron fires this drain every ten seconds
-- whether or not the previous tick has returned (0063's own reasoning, which
-- transfers unchanged), and this drain's own header says a large campaign
-- takes hours to drain -- so two overlapping ticks settling DIFFERENT rows of
-- the SAME campaign is the ordinary case, not an edge one. Both can read the
-- same starting counters, both add their own tally in JavaScript, and the
-- second write overwrites the first's -- a lost update, silent, with no
-- error anywhere. Concretely: an operator reads "4,300 of 20,000" on a
-- campaign whose every row is actually `sent`, and once retention ages the
-- recipient rows out (Task 8) there is nothing left to recompute the truth
-- from -- message_campaigns' own comment (0242) already states that these
-- counters must still answer once that happens.
--
-- ONE STATEMENT is what closes it: `set x = x + p_x` reads and writes inside
-- the SAME UPDATE, under the row's own lock, so two concurrent calls
-- accumulate rather than clobber -- Postgres serialises the second call
-- behind the first's lock on this row regardless of which one arrives first,
-- and the second sees the first's result before adding its own.
--
-- RETURNS THE POST-BUMP TOTALS, not void, so the caller's own decision --
-- whether this campaign just finished, and if so whether it finished `sent`
-- or `failed` -- is made from the authoritative row Postgres just wrote,
-- never from a value read a moment earlier in TypeScript that a concurrent
-- tick's own bump could since have moved past.
--
-- SERVICE_ROLE ALONE, revoked from public, authenticated and anon
-- explicitly. The drain (Task 6b) is the only caller: it already holds
-- SELECT and UPDATE on message_campaigns directly (0242's own grant
-- comment), so this function grants no new capability -- only a way to
-- exercise the write half of that grant without the race a plain UPDATE
-- issued through PostgREST cannot avoid.
create function public.bump_campaign_counters(
  p_campaign_id uuid,
  p_sent        integer,
  p_failed      integer,
  p_suppressed  integer
)
returns table (
  sent_count       integer,
  failed_count     integer,
  suppressed_count integer
)
language sql
security definer
set search_path = pg_catalog, public
as $$
  update public.message_campaigns
     set sent_count       = sent_count + p_sent,
         failed_count     = failed_count + p_failed,
         suppressed_count = suppressed_count + p_suppressed
   where id = p_campaign_id
  returning sent_count, failed_count, suppressed_count;
$$;

revoke execute on function public.bump_campaign_counters(uuid, integer, integer, integer) from public;
revoke execute on function public.bump_campaign_counters(uuid, integer, integer, integer) from authenticated;
revoke execute on function public.bump_campaign_counters(uuid, integer, integer, integer) from anon;
grant execute on function public.bump_campaign_counters(uuid, integer, integer, integer) to service_role;

comment on function public.bump_campaign_counters(uuid, integer, integer, integer) is
  'Atomically adds one tick''s own tally to a campaign''s sent_count, failed_count and suppressed_count -- the one shape PostgREST cannot express, since a PATCH body is literal JSON and never a column-relative SQL expression. Read-then-write from TypeScript loses an update whenever two overlapping ticks (the ordinary case for this worker -- pg_cron fires every ten seconds regardless of whether the previous tick returned) settle different rows of the SAME campaign in the same window; this closes that race by reading and writing inside the same UPDATE, under the row''s own lock, so concurrent calls accumulate rather than clobber. Returns the POST-BUMP totals so the caller''s finish/status decision is made from the authoritative row just written, not from a value that could already be stale. GRANTED TO service_role ALONE: the drain (Task 6b) already holds SELECT and UPDATE on message_campaigns directly for exactly this settling (0242''s own grant comment), so this adds no new capability, only an atomic way to exercise the write half of it.';
