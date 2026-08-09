-- supabase/migrations/0150_external_ids.sql

-- Block 15, design D5. The calling system's own primary key, on both things
-- this API creates.
--
-- ITS OWN COLUMN RATHER THAN legacy_id, AND THAT IS THE DECISION. legacy_id is
-- reserved for Block 9's ETL over the legacy system -- 0098 gives it a unique
-- index per Station precisely so "one row of the old system imports once into
-- one Station" holds. Two sources sharing that index would collide on values
-- that mean different things, and the collision would reach an integrator as
-- "a song with legacy id X already exists" about a record they have never seen.
--
-- ON music_requests TOO, for a reason the songs column does not have on its
-- own: AN AUTOMATION RETRIES. Without a key here a network retry writes a
-- SECOND request into the history, and Block 8's dashboards count requests --
-- so the damage is a number that looks right and is not. A listener genuinely
-- asking twice still produces two rows, because the caller sends two different
-- ids for two different conversations.

alter table public.songs          add column external_id text;
alter table public.music_requests add column external_id text;

comment on column public.songs.external_id is
  'Block 15, D5. The primary key of the row in the system that sent it. Beside legacy_id, never instead of it: that one belongs to Block 9''s import, and sharing the namespace would report one source''s duplicate as the other''s.';
comment on column public.music_requests.external_id is
  'Block 15. The caller''s own id for this request, so a retry resolves to the row it already created rather than adding a second one to a history Block 8 counts.';

-- Partial on both counts, the shape 0098 uses for legacy_id: unique WHEN
-- PRESENT, so the many rows with no external key do not collide -- the trap
-- prizes.internal_code (0025) hit first -- and only among live rows, so
-- archiving and re-sending stays possible.
create unique index songs_external_live
  on public.songs (company_id, external_id)
  where deleted_at is null and external_id is not null;

create unique index music_requests_external_live
  on public.music_requests (company_id, external_id)
  where deleted_at is null and external_id is not null;
