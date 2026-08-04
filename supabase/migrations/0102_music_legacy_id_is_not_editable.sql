-- supabase/migrations/0102_music_legacy_id_is_not_editable.sql

-- Block 7a, Task 8 fix round 1: legacy_id stops being an update_ parameter.
--
-- D7 (0098) made legacy_id the ETL's idempotency handle: without it, a
-- second import run duplicates the whole acervo, because D2 removed every
-- other uniqueness. update_song and update_music_reference (0100/0101) both
-- followed the "every field set on every call, never merged" convention
-- update_prize and update_role established, and took p_legacy_id as one more
-- field in that list, defaulting to null and applied unconditionally.
--
-- The Songs screen (Task 8) exposed why that convention does not extend to
-- this one column. legacy_id is not an operator's field — it is read-only in
-- the UI, on purpose, per the same D7 reasoning — so the form never carries
-- it forward on save. Every ordinary edit-and-save therefore called
-- update_song with p_legacy_id omitted, which took the SQL default of null,
-- which the UPDATE then wrote unconditionally. The first save of any
-- imported song silently erased the one column D7 exists to protect — not
-- from a hand-edited value duplicating the row, but from an erased handle
-- making the NEXT import fail to recognise the row and duplicate it outright.
-- update_music_reference carried the identical shape and would have
-- reproduced the identical bug the moment Task 9 built its own form on it.
--
-- A hidden field re-forwarding the current value would stop the erasure but
-- would leave legacy_id writable by anyone who can craft a POST, which is not
-- read-only in any sense that matters — a "read-only" guarantee that holds
-- only in the browser is not a guarantee at all. The honest fix removes the
-- write path itself: p_legacy_id is gone from both update_ functions below.
-- create_song and create_music_reference keep it — that is where the ETL
-- sets it, and D7's uniqueness index is still exactly what refuses a second
-- import of the same handle there.
--
-- This also settles a smaller thing in 0101's own favour: its comment on
-- create_song already criticises "a parameter that looks like it decides
-- something while deciding nothing." A parameter that must never be used is
-- exactly that, and the honest move is to remove it, not to document that it
-- is ignored.
--
-- Changing a parameter list needs DROP + CREATE, not CREATE OR REPLACE —
-- otherwise Postgres keeps both overloads and every caller passing the old
-- argument count keeps resolving to the old, buggy body, silently. 0047 and
-- 0055 both hit exactly this and both drop the full old signature before
-- creating the new one; the same shape is followed here. Dropping resets the
-- ACL (Postgres grants EXECUTE to PUBLIC on every newly created function), so
-- the revoke/grant pair is restated below for both functions, not out of
-- tidiness.
--
-- The unique_violation exception handler each UPDATE statement carried is
-- removed along with the column, not merely narrowed: songs_legacy_unique
-- and the four *_legacy_unique indexes (0098) are the only unique
-- constraints either UPDATE's SET list could ever violate, and neither SET
-- list touches legacy_id any more. A handler that can no longer fire is not
-- defensive, it is a comment that stops being true — the same standard this
-- codebase has held its other error handling to throughout.

drop function public.update_song(
  uuid, text, uuid, uuid, uuid,
  public.music_nationality, public.music_vocal, integer, text, text);

create function public.update_song(
  p_song_id          uuid,
  p_title            text,
  p_artist_id        uuid,
  p_label_id         uuid default null,
  p_genre_id         uuid default null,
  p_nationality      public.music_nationality default null,
  p_vocal            public.music_vocal default null,
  p_duration_seconds integer default null,
  p_internal_code    text default null
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor   uuid := auth.uid();
  v_org     uuid;
  v_company uuid;
  v_title   text := nullif(btrim(p_title), '');
  v_code    text := nullif(btrim(coalesce(p_internal_code, '')), '');
  v_before  jsonb;
begin
  -- The Station — and so the permission to check — comes from the song
  -- itself, never from a parameter a caller could point at whichever Station
  -- they happen to hold music.manage in. 0093's idiom, so an unknown id, an
  -- unreachable Station and an archived song are one answer from outside.
  select organization_id, company_id into v_org, v_company
  from public.songs
  where id = p_song_id and deleted_at is null
    and public.has_permission('music.manage', company_id);

  if not found then
    raise log 'update_song denied: actor=% song=%', v_actor, p_song_id;
    raise exception 'permission denied: music.manage required' using errcode = '42501';
  end if;

  if v_title is null then
    raise exception 'a title is required' using errcode = '22023';
  end if;

  if p_duration_seconds is not null and p_duration_seconds <= 0 then
    raise exception 'a duration is a positive number of whole seconds' using errcode = '22023';
  end if;

  perform public.assert_song_references_live(v_company, p_artist_id, p_label_id, p_genre_id);

  select jsonb_build_object(
           'title', title, 'artist_id', artist_id, 'label_id', label_id,
           'genre_id', genre_id, 'nationality', nationality, 'vocal', vocal,
           'duration_seconds', duration_seconds, 'internal_code', internal_code,
           'legacy_id', legacy_id)
    into v_before
  from public.songs where id = p_song_id;

  -- legacy_id is simply not in this list any more (see the migration header).
  -- No exception handler around this statement: songs_legacy_unique is the
  -- only unique constraint touching any column this SET list writes, and
  -- this SET list no longer writes legacy_id.
  update public.songs
     set title            = v_title,
         artist_id        = p_artist_id,
         label_id         = p_label_id,
         genre_id         = p_genre_id,
         nationality      = p_nationality,
         vocal            = p_vocal,
         duration_seconds = p_duration_seconds,
         internal_code    = v_code,
         updated_at       = now()
   where id = p_song_id;

  insert into public.audit_logs
    (actor_id, action, target_table, target_id, organization_id, company_id, detail)
  values
    (v_actor, 'update_song', 'songs', p_song_id, v_org, v_company,
     jsonb_build_object('before', v_before, 'after', jsonb_build_object(
       'title', v_title, 'artist_id', p_artist_id, 'label_id', p_label_id,
       'genre_id', p_genre_id, 'nationality', p_nationality, 'vocal', p_vocal,
       'duration_seconds', p_duration_seconds, 'internal_code', v_code,
       -- Unchanged by this call, and said so: read from v_before rather than
       -- from a parameter, because there is no longer a parameter to read it
       -- from.
       'legacy_id', v_before->>'legacy_id')));
end;
$$;

comment on function public.update_song(uuid, text, uuid, uuid, uuid, public.music_nationality, public.music_vocal, integer, text) is
  'Replaces a song''s fields wholesale (the convention update_prize and update_role follow: every field set on every call, never merged) — except legacy_id, which this function does not take and cannot write (0102). legacy_id is Block 9''s ETL idempotency handle (D7), read-only in every screen; only create_song sets it. The Organization and Company are resolved from the song row, never from a parameter. Gated on music.manage; an unknown id, an unreachable Station and an archived song all answer 42501.';

drop function public.update_music_reference(
  public.music_reference_kind, uuid, text, text);

create function public.update_music_reference(
  p_kind      public.music_reference_kind,
  p_id        uuid,
  p_name      text
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor   uuid := auth.uid();
  v_table   text := public.music_reference_table(p_kind);
  v_name    text := nullif(btrim(p_name), '');
  v_org     uuid;
  v_company uuid;
begin
  -- 0093's idiom: ONE gated query resolves the Station, and `not found`
  -- covers three facts on purpose — no such id, an id in a Station this
  -- caller holds nothing in, and an already-archived row. The composite
  -- foreign keys cannot see deleted_at (they reference a non-partial
  -- constraint), so `deleted_at is null` here is the only thing standing
  -- between an archived genre and an edit that puts it back in every screen's
  -- reference list.
  execute format(
    'select organization_id, company_id from public.%I
      where id = $1 and deleted_at is null
        and public.has_permission(''music.manage'', company_id)', v_table)
  into v_org, v_company
  using p_id;

  if v_company is null then
    raise log 'update_music_reference denied: actor=% kind=% id=%', v_actor, p_kind, p_id;
    raise exception 'permission denied: music.manage required' using errcode = '42501';
  end if;

  if v_name is null then
    raise exception 'a name is required' using errcode = '22023';
  end if;

  -- legacy_id is simply not in this list any more (see the migration
  -- header). No exception handler around this statement: the four
  -- *_legacy_unique indexes (0098) are the only unique constraints this SET
  -- list could ever violate, and this SET list no longer writes legacy_id.
  execute format(
    'update public.%I set name = $1, updated_at = now() where id = $2', v_table)
  using v_name, p_id;

  insert into public.audit_logs
    (actor_id, action, target_table, target_id, organization_id, company_id, detail)
  values
    (v_actor, 'update_music_reference', v_table, p_id, v_org, v_company,
     jsonb_build_object('kind', p_kind, 'name', v_name));
end;
$$;

comment on function public.update_music_reference(public.music_reference_kind, uuid, text) is
  'Replaces a reference record''s name wholesale — legacy_id is not among the fields this function takes or writes any more (0102): it is Block 9''s ETL idempotency handle (D7), read-only in every screen, and only create_music_reference sets it. The Station is resolved from the row itself, never from a parameter, so a caller cannot redirect the permission check at a Station they do hold music.manage in. An unknown id, a Station the caller cannot reach and an already-archived row all answer 42501 alike.';

revoke execute on function public.update_song(uuid, text, uuid, uuid, uuid, public.music_nationality, public.music_vocal, integer, text) from public;
revoke execute on function public.update_music_reference(public.music_reference_kind, uuid, text)                                       from public;

grant execute on function public.update_song(uuid, text, uuid, uuid, uuid, public.music_nationality, public.music_vocal, integer, text) to authenticated;
grant execute on function public.update_music_reference(public.music_reference_kind, uuid, text)                                       to authenticated;
