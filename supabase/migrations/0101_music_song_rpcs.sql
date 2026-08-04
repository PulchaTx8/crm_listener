-- supabase/migrations/0101_music_song_rpcs.sql

-- Block 7a, Task 4: songs get their own three doors, because songs are the
-- one catalogue entity with fields rather than a name.

-- Private. SECURITY INVOKER and EXECUTE for nobody — it is only ever called
-- from inside a SECURITY DEFINER body, where it already runs with that body's
-- privileges, and making it DEFINER too would let a future GRANT turn it into
-- an unchecked read path. The shape apply_inventory_movement (0027) and
-- apply_winner_transition (0092) both use.
--
-- The composite foreign keys on songs (0098) prove the Station on their own,
-- so this is not that. It is the half they cannot prove: a foreign key
-- references a non-partial constraint and therefore cannot see deleted_at, so
-- without this an ARCHIVED artist could still be named by a new song — and
-- 0099's policy makes that artist unreadable, so the song's record would
-- render a blank where the artist should be.
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

  if not exists (
    select 1 from public.artists
     where id = p_artist_id and company_id = p_company_id and deleted_at is null
  ) then
    raise exception 'artist not found in this station: %', p_artist_id using errcode = 'P0002';
  end if;

  if p_label_id is not null and not exists (
    select 1 from public.record_labels
     where id = p_label_id and company_id = p_company_id and deleted_at is null
  ) then
    raise exception 'record label not found in this station: %', p_label_id using errcode = 'P0002';
  end if;

  if p_genre_id is not null and not exists (
    select 1 from public.music_genres
     where id = p_genre_id and company_id = p_company_id and deleted_at is null
  ) then
    raise exception 'genre not found in this station: %', p_genre_id using errcode = 'P0002';
  end if;
end;
$$;

revoke execute on function public.assert_song_references_live(uuid, uuid, uuid, uuid) from public;

comment on function public.assert_song_references_live(uuid, uuid, uuid, uuid) is
  'Refuses an artist, label or genre that is missing, archived, or from another Station. SECURITY INVOKER, EXECUTE granted to nobody. The composite foreign keys prove the Station by themselves; what they cannot see is deleted_at, which is the half this covers.';

create or replace function public.create_song(
  p_company_id       uuid,
  p_title            text,
  p_artist_id        uuid,
  p_label_id         uuid default null,
  p_genre_id         uuid default null,
  p_nationality      public.music_nationality default null,
  p_vocal            public.music_vocal default null,
  p_duration_seconds integer default null,
  p_internal_code    text default null,
  p_legacy_id        text default null
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor  uuid := auth.uid();
  v_org    uuid;
  v_title  text := nullif(btrim(p_title), '');
  v_code   text := nullif(btrim(coalesce(p_internal_code, '')), '');
  v_legacy text := nullif(btrim(coalesce(p_legacy_id, '')), '');
  v_id     uuid;
begin
  if not public.has_permission('music.manage', p_company_id) then
    raise log 'create_song denied: actor=% company=%', v_actor, p_company_id;
    raise exception 'permission denied: music.manage required' using errcode = '42501';
  end if;

  select organization_id into v_org
  from public.companies
  where id = p_company_id and deleted_at is null;

  if not found then
    raise exception 'station not found: %', p_company_id using errcode = 'P0002';
  end if;

  if v_title is null then
    raise exception 'a title is required' using errcode = '22023';
  end if;

  if p_duration_seconds is not null and p_duration_seconds <= 0 then
    raise exception 'a duration is a positive number of whole seconds' using errcode = '22023';
  end if;

  perform public.assert_song_references_live(p_company_id, p_artist_id, p_label_id, p_genre_id);

  begin
    insert into public.songs
      (organization_id, company_id, title, artist_id, label_id, genre_id,
       nationality, vocal, duration_seconds, internal_code, legacy_id, created_by)
    values
      (v_org, p_company_id, v_title, p_artist_id, p_label_id, p_genre_id,
       p_nationality, p_vocal, p_duration_seconds, v_code, v_legacy, v_actor)
    returning id into v_id;
  exception
    when unique_violation then
      raise exception 'a song with legacy id "%" already exists in this station', v_legacy
        using errcode = '23505';
  end;

  insert into public.audit_logs
    (actor_id, action, target_table, target_id, organization_id, company_id, detail)
  values
    (v_actor, 'create_song', 'songs', v_id, v_org, p_company_id,
     jsonb_build_object('title', v_title, 'artist_id', p_artist_id, 'legacy_id', v_legacy));

  return v_id;
end;
$$;

comment on function public.create_song(uuid, text, uuid, uuid, uuid, public.music_nationality, public.music_vocal, integer, text, text) is
  'Registers a song. Gated on music.manage, checked before the Station is resolved. The artist is required (a song without one is a draft, not a record); label and genre are optional because the legacy source may not carry them. Every reference must be live and in the same Station — refused with P0002 naming the id, which the composite foreign keys would also refuse but with a constraint name. No uniqueness on title and artist, deliberately (D2): the duplicate is the maintenance screen''s business, not this door''s.';

create or replace function public.update_song(
  p_song_id          uuid,
  p_title            text,
  p_artist_id        uuid,
  p_label_id         uuid default null,
  p_genre_id         uuid default null,
  p_nationality      public.music_nationality default null,
  p_vocal            public.music_vocal default null,
  p_duration_seconds integer default null,
  p_internal_code    text default null,
  p_legacy_id        text default null
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
  v_legacy  text := nullif(btrim(coalesce(p_legacy_id, '')), '');
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

  begin
    update public.songs
       set title            = v_title,
           artist_id        = p_artist_id,
           label_id         = p_label_id,
           genre_id         = p_genre_id,
           nationality      = p_nationality,
           vocal            = p_vocal,
           duration_seconds = p_duration_seconds,
           internal_code    = v_code,
           legacy_id        = v_legacy,
           updated_at       = now()
     where id = p_song_id;
  exception
    when unique_violation then
      raise exception 'a song with legacy id "%" already exists in this station', v_legacy
        using errcode = '23505';
  end;

  insert into public.audit_logs
    (actor_id, action, target_table, target_id, organization_id, company_id, detail)
  values
    (v_actor, 'update_song', 'songs', p_song_id, v_org, v_company,
     jsonb_build_object('before', v_before, 'after', jsonb_build_object(
       'title', v_title, 'artist_id', p_artist_id, 'label_id', p_label_id,
       'genre_id', p_genre_id, 'nationality', p_nationality, 'vocal', p_vocal,
       'duration_seconds', p_duration_seconds, 'internal_code', v_code,
       'legacy_id', v_legacy)));
end;
$$;

comment on function public.update_song(uuid, text, uuid, uuid, uuid, public.music_nationality, public.music_vocal, integer, text, text) is
  'Replaces a song''s fields wholesale (the convention update_prize and update_role follow: every field set on every call, never merged). The Organization and Company are resolved from the song row, never from a parameter. Gated on music.manage; an unknown id, an unreachable Station and an archived song all answer 42501.';

create or replace function public.archive_song(p_song_id uuid)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor   uuid := auth.uid();
  v_org     uuid;
  v_company uuid;
begin
  select organization_id, company_id into v_org, v_company
  from public.songs
  where id = p_song_id and deleted_at is null
    and public.has_permission('music.manage', company_id)
    for update;

  if not found then
    raise log 'archive_song denied: actor=% song=%', v_actor, p_song_id;
    raise exception 'permission denied: music.manage required' using errcode = '42501';
  end if;

  -- Deliberately NOT refused when requests point at it, unlike
  -- archive_music_reference's guard on artists. A request is a historical
  -- fact (D5) — this person asked for this song on this day — and that fact
  -- does not stop being true because the Station retired the song. 7b's
  -- requests list reads the title from inside its own SECURITY DEFINER body,
  -- where 0099's deleted_at filter does not apply, so an archived song's
  -- requests still render with their title rather than a blank.
  update public.songs set deleted_at = now(), updated_at = now() where id = p_song_id;

  insert into public.audit_logs
    (actor_id, action, target_table, target_id, organization_id, company_id)
  values
    (v_actor, 'archive_song', 'songs', p_song_id, v_org, v_company);
end;
$$;

comment on function public.archive_song(uuid) is
  'Soft-deletes a song. Gated on music.manage. Never refused over existing requests — a request is a historical fact and stays true after the song is retired — which is the opposite of archive_music_reference''s guard on an artist, because a song with no artist would render blank and a request with a retired song does not. 7b''s list_music_requests reads titles from inside a SECURITY DEFINER body, where the deleted_at policy does not apply.';

revoke execute on function public.create_song(uuid, text, uuid, uuid, uuid, public.music_nationality, public.music_vocal, integer, text, text) from public;
revoke execute on function public.update_song(uuid, text, uuid, uuid, uuid, public.music_nationality, public.music_vocal, integer, text, text)  from public;
revoke execute on function public.archive_song(uuid)                                                                                            from public;

grant execute on function public.create_song(uuid, text, uuid, uuid, uuid, public.music_nationality, public.music_vocal, integer, text, text) to authenticated;
grant execute on function public.update_song(uuid, text, uuid, uuid, uuid, public.music_nationality, public.music_vocal, integer, text, text)  to authenticated;
grant execute on function public.archive_song(uuid)                                                                                            to authenticated;
