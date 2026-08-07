-- supabase/migrations/0140_create_song_album_and_isrc.sql

-- Block 13a, fix round: create_song gains the two fields 0138 gave update_song.
--
-- FOUND BY BUILDING THE FORM, not by reading the plan. Design D7 makes the
-- album and the ISRC hand-editable, and SongFields is ONE component shared by
-- the create dialog and the edit form -- deliberately, so the two cannot drift
-- apart. So the moment the album select and the ISRC input were added, the
-- create form rendered two controls that accepted input and silently discarded
-- it: create_song had no parameter to receive either.
--
-- An editable-looking control with nowhere to submit is the false affordance
-- song-fields.tsx's own `disabled` prop exists to avoid. The honest fix is the
-- parameters, not hiding the fields on create.
--
-- DROP + CREATE, for 0102's reason restated once more: two new parameters
-- change the signature, and `create or replace` would leave Postgres holding
-- both overloads with every ten-argument caller silently resolving to the old
-- body. Dropping resets the ACL, so the revoke/grant pair is restated.
--
-- THE unique_violation HANDLER STAYS CORRECT AND STAYS. songs_legacy_unique is
-- still the only unique constraint this SET list can violate: create_song does
-- not write deezer_track_id, so songs_deezer_live (0138) is out of its reach.
-- That is exactly why 0139 has a door of its own rather than three more
-- parameters here -- reusing this insert would have reported duplicate
-- recordings as legacy-id collisions.

drop function public.create_song(
  uuid, text, uuid, uuid, uuid,
  public.music_nationality, public.music_vocal, integer, text, text);

create function public.create_song(
  p_company_id       uuid,
  p_title            text,
  p_artist_id        uuid,
  p_label_id         uuid default null,
  p_genre_id         uuid default null,
  p_nationality      public.music_nationality default null,
  p_vocal            public.music_vocal default null,
  p_duration_seconds integer default null,
  p_internal_code    text default null,
  p_legacy_id        text default null,
  p_album_id         uuid default null,
  p_isrc             text default null
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
  -- Folded before storing and before checking: songs_isrc_shape accepts upper
  -- case only, and an operator reading a code off a sleeve will not shift-lock.
  v_isrc   text := nullif(btrim(upper(coalesce(p_isrc, ''))), '');
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

  -- The album joins that assertion's job, in the same spirit and for the same
  -- reason: the composite foreign key proves the Station but cannot see
  -- deleted_at, because it references a non-partial constraint. Without this,
  -- an archived album could be named by a new song and the record would render
  -- a blank where the album should be.
  if p_album_id is not null and not exists (
    select 1 from public.albums
    where id = p_album_id and company_id = p_company_id and deleted_at is null
  ) then
    raise exception 'album not found in this station: %', p_album_id using errcode = 'P0002';
  end if;

  begin
    insert into public.songs
      (organization_id, company_id, title, artist_id, label_id, genre_id,
       nationality, vocal, duration_seconds, internal_code, legacy_id,
       album_id, isrc, created_by)
    values
      (v_org, p_company_id, v_title, p_artist_id, p_label_id, p_genre_id,
       p_nationality, p_vocal, p_duration_seconds, v_code, v_legacy,
       p_album_id, v_isrc, v_actor)
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
     jsonb_build_object('title', v_title, 'artist_id', p_artist_id,
                        'legacy_id', v_legacy, 'album_id', p_album_id, 'isrc', v_isrc));

  return v_id;
end;
$$;

comment on function public.create_song(uuid, text, uuid, uuid, uuid, public.music_nationality, public.music_vocal, integer, text, text, uuid, text) is
  'Registers a song typed by hand. Gained p_album_id and p_isrc in Block 13a, because design D7 makes both hand-editable and SongFields is shared with the edit form — without them the create dialog rendered two controls that discarded what was typed into them. Still takes no p_deezer_track_id: that column has one write path, 0139.';

revoke execute on function public.create_song(uuid, text, uuid, uuid, uuid, public.music_nationality, public.music_vocal, integer, text, text, uuid, text) from public;
grant  execute on function public.create_song(uuid, text, uuid, uuid, uuid, public.music_nationality, public.music_vocal, integer, text, text, uuid, text) to authenticated;
