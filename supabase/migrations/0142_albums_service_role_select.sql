-- supabase/migrations/0142_albums_service_role_select.sql

-- Block 13a, fix round: albums was the only music table service_role could not
-- read.
--
-- FOUND BY PROBING, after /music/songs failed in production for an unrelated
-- reason (the hosted database was seven migrations behind). Running the
-- screen's own query against the LOCAL stack answered:
--
--   42501 permission denied for table albums
--
-- and the grants explain it. Every sibling created in 0098 carries SELECT for
-- service_role; albums, created in 0136, does not:
--
--   artists | service_role | REFERENCES, SELECT, TRIGGER
--   songs   | service_role | REFERENCES, SELECT, TRIGGER
--   albums  | service_role | REFERENCES, TRIGGER, TRUNCATE   <-- no SELECT
--
-- 0136 copied 0099's `revoke all ... from anon, authenticated` faithfully, and
-- that line was never what gave the older tables their service_role SELECT.
-- They got it from the default privileges in force when they were created;
-- albums did not, because `auto_expose_new_tables` is unset in config.toml and
-- new tables are no longer auto-exposed.
--
-- WHY THIS IS WORSE THAN AN ORDINARY BUG. The hosted project is older and still
-- auto-exposes, so the same query answered 200 there and 42501 locally. A
-- defect that is invisible in production and only appears on a fresh install is
-- one that surfaces for whoever sets the next environment up — a new
-- developer, a staging project, a restore — and never for the people who could
-- have fixed it cheaply. Stated explicitly here rather than left to a
-- project-level setting nobody controls from this repository.
--
-- SELECT ONLY, matching the siblings exactly. service_role bypasses RLS, so
-- this is read access to every Station's albums for a key that already has the
-- same reach over songs and artists. It is not widened beyond what those have,
-- and no write privilege is granted: albums are written through 0137's and
-- 0139's SECURITY DEFINER doors, which is where the music.manage check lives.

grant select on public.albums to service_role;

comment on table public.albums is
  'Block 13a. One Station''s albums. Holds the cover hash every screen that names a song renders, and the UPC of the release. service_role holds SELECT (0142), matching songs and artists; anon holds nothing, and every write goes through 0137/0139.';
