-- supabase/migrations/0216_geocoded_places_worker_read.sql

-- Block 28. The worker may read its own queue.
--
-- 0214 granted `select` to `authenticated` and left service_role to whatever
-- Supabase's default privileges give a new table in `public`. That turned out to
-- be REFERENCES, TRIGGER and TRUNCATE and NOT select — so the worker, which is
-- service_role, could call all three SECURITY DEFINER doors (those run as their
-- owner) and could not run a plain count against the table they operate on.
--
-- Found by a logged failure rather than by a test: `drainGeocodeQueue` reports
-- its backlog with a head-count when no geocoding key is configured, and that
-- count answered an empty error object every tick while everything else worked.
-- Nothing was broken by it — the number is a counter in a tick's response — but
-- a log line that fires ten times a minute and means nothing is how a real one
-- gets missed.
--
-- SELECT ONLY. The worker's writes go through enqueue_place,
-- claim_places_to_geocode and record_place_geocode, which is what keeps
-- `resolved_at`/`failed_at` mutually exclusive and the claim bounded; a direct
-- INSERT or UPDATE grant would be a second way in that skips all of that.

grant select on public.geocoded_places to service_role;
