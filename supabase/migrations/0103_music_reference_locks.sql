-- supabase/migrations/0103_music_reference_locks.sql

-- Block 7a, final whole-branch review, finding I2: assert_song_references_live
-- now LOCKS the three rows it checks, so archive_music_reference's FOR UPDATE
-- finally means what 0100's comment already claimed it meant.
--
-- WHAT COULD HAPPEN BEFORE THIS FILE. A live song naming an archived artist —
-- the one state archive_music_reference's "still used by N live row(s)" guard
-- exists to make impossible, and the state 0099 makes unreadable: an archived
-- artist is invisible to every caller, so the song's own record would render an
-- artist that had silently become blank.
--
-- THE INTERLEAVING (READ COMMITTED, which is what these RPCs run in):
--   1. archive_music_reference locks the artist FOR UPDATE (0100:210-214) and
--      counts live songs naming it — zero.
--   2. create_song calls assert_song_references_live, whose check was
--      `exists (select 1 from public.artists where ... and deleted_at is null)`.
--      A plain read takes no row lock and is never blocked by one, so it reads
--      the artist as live (the archive has not committed yet) and returns.
--   3. The INSERT's own foreign-key check does take FOR KEY SHARE on the artist
--      row, and does block on the archive's FOR UPDATE — but by then the
--      decision has been made. The archive commits; only deleted_at changed, so
--      the key columns the FK cares about are intact, the FK is satisfied, and
--      the insert completes.
--   4. Committed result: a live song naming an archived artist. Both
--      transactions succeeded and each one's guard read as if it had held.
--
-- Measured, not argued. Two concurrent sessions against this schema, driving
-- the shipped body, produce exactly step 4: the creator INSERTs and a join of
-- live songs against archived artists returns 1. The same probe against the
-- body below returns 0, and the creator is refused with P0002.
--
-- 0027_inventory_rpcs.sql:35-49 is the precedent and says the same thing about
-- prizes: apply_inventory_movement takes `for share` on the prize precisely so
-- that archive_prize's `for update` has something to conflict with. Block 7a
-- shipped the archive half and not the reader half, and then asserted the
-- guarantee in a comment. This file supplies the missing half.
--
-- LOCK MODE, AND WHY FOR KEY SHARE. Postgres has four row-lock modes — FOR KEY
-- SHARE, FOR SHARE, FOR NO KEY UPDATE, FOR UPDATE — and its "Conflicting
-- Row-Level Locks" table gives FOR KEY SHARE exactly one conflict: FOR UPDATE.
-- That single conflict is the whole requirement here, and nothing more is
-- wanted:
--   * It conflicts with archive_music_reference's explicit FOR UPDATE, so the
--     two serialise. Whichever arrives second waits; READ COMMITTED then
--     re-evaluates the qual against the committed row version, so a create_song
--     that waited on an archive raises P0002 on an artist that is now archived,
--     and an archive that waited on a create_song counts songs in a later
--     statement — a fresh snapshot — sees the one just committed, and refuses
--     with 23503. Both orders end correctly; neither ends in step 4.
--   * It does NOT conflict with another FOR KEY SHARE, so two create_song calls
--     naming the same artist never queue behind each other. The common case
--     stays exactly as concurrent as it was.
--   * It does NOT conflict with FOR NO KEY UPDATE, so an ordinary rename
--     through update_music_reference — a bare UPDATE of a non-key column takes
--     FOR NO KEY UPDATE — does not block song creation either.
-- FOR SHARE would also close the race and would block more; FOR UPDATE would
-- serialise every create_song against every other for no gain. FOR KEY SHARE is
-- the weakest mode that closes it, so it is the one taken.
--
-- The conflict table was verified against this Postgres (17.6) rather than
-- taken on trust: with a probing `for key share` on one artists row, a holder
-- of FOR UPDATE blocks it, while holders of FOR NO KEY UPDATE, FOR SHARE, FOR
-- KEY SHARE, a bare rename and a bare `set deleted_at = now()` all leave it
-- unblocked.
--
-- THE PAIR IS THE GUARANTEE — NEITHER HALF ALONE. Because FOR KEY SHARE
-- conflicts with FOR UPDATE and with nothing weaker, this lock excludes the
-- archive ONLY because archive_music_reference takes an explicit `for update`
-- on the reference row before counting. A future archive path that simply ran
-- `update ... set deleted_at = now()` would take FOR NO KEY UPDATE, which does
-- not conflict with this (measured, above), and the race would be back with
-- both comments still reading as though it were closed. Whoever changes one
-- half changes both.
--
-- WHY `perform ... for key share` AND NOT `exists (... for key share)`. Not
-- correctness: on Postgres 17 the sublink form both parses and genuinely takes
-- the lock (measured — a holder of FOR UPDATE blocks it just the same). It is
-- the shape 0027 already uses for the identical job, and `if not found` after a
-- PERFORM is plpgsql's own way of asking "was there a row", where a locking
-- clause buried inside an EXISTS reads like a decoration on a test that most
-- readers know as lock-free. The nullable label and genre move inside their
-- `is not null` guard for the same reason: with PERFORM, FOUND is set by every
-- execution, so `if p_label_id is not null and not found` would work only by
-- accident of evaluation order.
--
-- CREATE OR REPLACE, NOT DROP + CREATE. The signature is unchanged, so there is
-- no second overload for a caller to resolve to and nothing to drop. REPLACE
-- also keeps the function's ACL, so 0101's `revoke execute ... from public`
-- still stands and this helper still holds EXECUTE for nobody — 0102 restated
-- its revoke/grant pair because DROP resets an ACL, and that reason does not
-- reach this file. (Worth knowing while reading the body: a locking clause
-- needs UPDATE privilege on the table, not merely SELECT — Postgres says so in
-- GRANT's own wording, and says it again in the error hint if you try. 0099
-- grants `authenticated` and `service_role` select only, so this function could
-- not take these locks for anyone but its SECURITY DEFINER callers, which run
-- as the table owner. One more reason it grants EXECUTE to nobody.)

create or replace function public.assert_song_references_live(
  p_company_id uuid,
  p_artist_id  uuid,
  p_label_id   uuid,
  p_genre_id   uuid
)
returns void
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if p_artist_id is null then
    raise exception 'a song must name an artist' using errcode = '22023';
  end if;

  -- FOR KEY SHARE, not a bare read: this is the half that holds the artist
  -- against archive_music_reference's FOR UPDATE. See the header.
  perform 1 from public.artists
   where id = p_artist_id and company_id = p_company_id and deleted_at is null
   for key share;

  if not found then
    raise exception 'artist not found in this station: %', p_artist_id using errcode = 'P0002';
  end if;

  if p_label_id is not null then
    perform 1 from public.record_labels
     where id = p_label_id and company_id = p_company_id and deleted_at is null
     for key share;

    if not found then
      raise exception 'record label not found in this station: %', p_label_id using errcode = 'P0002';
    end if;
  end if;

  if p_genre_id is not null then
    perform 1 from public.music_genres
     where id = p_genre_id and company_id = p_company_id and deleted_at is null
     for key share;

    if not found then
      raise exception 'genre not found in this station: %', p_genre_id using errcode = 'P0002';
    end if;
  end if;
end;
$$;

comment on function public.assert_song_references_live(uuid, uuid, uuid, uuid) is
  'Refuses an artist, label or genre that is missing, archived, or from another Station. SECURITY INVOKER, EXECUTE granted to nobody. The composite foreign keys prove the Station by themselves; what they cannot see is deleted_at, which is the half this covers. Each check takes FOR KEY SHARE on the row it reads (0103), which is the weakest row-lock mode that conflicts with archive_music_reference''s FOR UPDATE: without it the two could interleave and leave a live song naming an archived reference. It deliberately does not conflict with another FOR KEY SHARE, so concurrent song creation is not serialised.';

-- 0100's own comment on archive_music_reference ended with a claim that was
-- false the day it was written: "Takes FOR UPDATE on the row, so a create_song
-- naming this artist cannot interleave past the count." The FOR UPDATE was
-- real; what it could not do was block a reader that took no lock. The function
-- body is unchanged and migrations here are append-only, so the honest
-- correction is to restate the comment rather than edit 0100 — a comment
-- asserting a concurrency property the code does not provide is worse than no
-- comment, because the next person to touch either function will trust it.
comment on function public.archive_music_reference(public.music_reference_kind, uuid) is
  'Soft-deletes a genre, label, artist or show. Gated on music.manage. Never a DELETE — this project deletes nothing, and 7b''s merge history needs rows to keep pointing at. Refused while a live song (or, for a show, a live request) still names it, so no screen is left rendering a reference that RLS has made unreadable. Takes FOR UPDATE on the row before counting; that excludes a concurrent create_song only because 0103 makes assert_song_references_live take FOR KEY SHARE on the same row, which is the one mode FOR UPDATE conflicts with. The two locks are a pair and neither works alone: until 0103 the reader took no lock, so an archive and a create could interleave and leave a live song naming an archived reference.';
