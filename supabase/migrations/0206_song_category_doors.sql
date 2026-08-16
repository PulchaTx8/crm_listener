-- supabase/migrations/0206_song_category_doors.sql

-- Block 27. The three doors that write a song learn its category.
--
-- EACH BODY IS COPIED FORWARD FROM ITS LIVE DEFINITION, never from 0101:
-- create_song from 0140, update_song from 0138, create_song_from_deezer from
-- 0139. Recreating from the original would silently revert 0102's removal of
-- p_legacy_id, 0138's ISRC and album handling and 0140's create-side pair of
-- the same — a mistake this project has made once and written down, and the
-- reason this paragraph is the first thing in the file.
--
-- DROP + CREATE on all three, not REPLACE: each signature changes, and
-- `create or replace` with a new parameter list leaves Postgres holding BOTH
-- overloads, with every existing caller silently resolving to the old body.
-- Dropping resets the ACL, so each revoke/grant pair is restated (0102).
--
-- p_category_id is LAST and DEFAULTED on all three, so any caller that does not
-- know about it keeps working and means "no category".
--
-- THE CATEGORY IS CHECKED BY assert_song_references_live (0205), not by an
-- `exists` beside the album's. The album has its own inline check in two of
-- these bodies because albums are not one of 0100's reference kinds; a category
-- is, so it belongs in the helper with the other three — where the FOR KEY
-- SHARE that pairs with archive_music_reference's FOR UPDATE also lives.

-- ---------------------------------------------------------------------------
-- create_song
-- ---------------------------------------------------------------------------

drop function public.create_song(
  uuid, text, uuid, uuid, uuid,
  public.music_nationality, public.music_vocal, integer, text, text, uuid, text);

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
  p_isrc             text default null,
  p_category_id      uuid default null
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

  perform public.assert_song_references_live(
    p_company_id, p_artist_id, p_label_id, p_genre_id, p_category_id);

  -- The album joins that assertion's job, in the same spirit and for the same
  -- reason: the composite foreign key proves the Station but cannot see
  -- deleted_at, because it references a non-partial constraint. Without this,
  -- an archived album could be named by a new song and the record would render
  -- a blank where the album should be. (The category needs the identical guard
  -- and gets it inside the helper above, where it can also take the row lock
  -- 0103's pair depends on — an album has no archive door racing it.)
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
       album_id, isrc, category_id, created_by)
    values
      (v_org, p_company_id, v_title, p_artist_id, p_label_id, p_genre_id,
       p_nationality, p_vocal, p_duration_seconds, v_code, v_legacy,
       p_album_id, v_isrc, p_category_id, v_actor)
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
                        'legacy_id', v_legacy, 'album_id', p_album_id, 'isrc', v_isrc,
                        'category_id', p_category_id));

  return v_id;
end;
$$;

comment on function public.create_song(uuid, text, uuid, uuid, uuid, public.music_nationality, public.music_vocal, integer, text, text, uuid, text, uuid) is
  'Registers a song typed by hand. Gained p_album_id and p_isrc in Block 13a and p_category_id in Block 27, each because SongFields is ONE component shared with the edit form — a control rendered there with no parameter here is a control that discards what is typed into it. Still takes no p_deezer_track_id: that column has one write path, 0139.';

revoke execute on function public.create_song(uuid, text, uuid, uuid, uuid, public.music_nationality, public.music_vocal, integer, text, text, uuid, text, uuid) from public;
grant  execute on function public.create_song(uuid, text, uuid, uuid, uuid, public.music_nationality, public.music_vocal, integer, text, text, uuid, text, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- update_song
-- ---------------------------------------------------------------------------

drop function public.update_song(
  uuid, text, uuid, uuid, uuid,
  public.music_nationality, public.music_vocal, integer, text, uuid, text);

create function public.update_song(
  p_song_id          uuid,
  p_title            text,
  p_artist_id        uuid,
  p_label_id         uuid default null,
  p_genre_id         uuid default null,
  p_nationality      public.music_nationality default null,
  p_vocal            public.music_vocal default null,
  p_duration_seconds integer default null,
  p_internal_code    text default null,
  p_album_id         uuid default null,
  p_isrc             text default null,
  p_category_id      uuid default null
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
  -- Folded before it is stored and before it is checked. An operator reading
  -- it off a sleeve will not shift-lock, and songs_isrc_shape only accepts
  -- upper case -- so without this a correct ISRC typed in lower case is
  -- refused as malformed.
  v_isrc    text := nullif(btrim(upper(coalesce(p_isrc, ''))), '');
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

  perform public.assert_song_references_live(
    v_company, p_artist_id, p_label_id, p_genre_id, p_category_id);

  -- The album joins that assertion's job, in the same spirit: an album RLS
  -- would hide is refused rather than silently written, so a song cannot end
  -- up naming a record no screen can read. The composite foreign key already
  -- refuses another Station's album; what it cannot see is deleted_at, because
  -- it references a non-partial constraint.
  if p_album_id is not null and not exists (
    select 1 from public.albums
    where id = p_album_id and company_id = v_company and deleted_at is null
  ) then
    raise exception 'that album is not available in this station' using errcode = '23503';
  end if;

  select jsonb_build_object(
           'title', title, 'artist_id', artist_id, 'label_id', label_id,
           'genre_id', genre_id, 'nationality', nationality, 'vocal', vocal,
           'duration_seconds', duration_seconds, 'internal_code', internal_code,
           'album_id', album_id, 'isrc', isrc, 'category_id', category_id,
           'legacy_id', legacy_id, 'deezer_track_id', deezer_track_id)
    into v_before
  from public.songs where id = p_song_id;

  -- legacy_id is not in this list (0102), and deezer_track_id is not in it
  -- either (0139 owns that column). category_id IS, and on every call: this
  -- function replaces wholesale, so a caller omitting it clears the category —
  -- which is precisely how the Song data tab's <select> set to "No category"
  -- has to behave, and how the isolation suite detaches a song before archiving
  -- the category it wore. No exception handler around this statement:
  -- songs_legacy_unique and songs_deezer_live are the only unique constraints
  -- over columns of this table, and this SET list writes neither of their
  -- columns.
  update public.songs
     set title            = v_title,
         artist_id        = p_artist_id,
         label_id         = p_label_id,
         genre_id         = p_genre_id,
         nationality      = p_nationality,
         vocal            = p_vocal,
         duration_seconds = p_duration_seconds,
         internal_code    = v_code,
         album_id         = p_album_id,
         isrc             = v_isrc,
         category_id      = p_category_id,
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
       'album_id', p_album_id, 'isrc', v_isrc, 'category_id', p_category_id,
       -- Neither is changed by this call, and both say so: read from v_before
       -- rather than from a parameter, because there IS no parameter to read
       -- either of them from.
       'legacy_id', v_before->>'legacy_id',
       'deezer_track_id', v_before->>'deezer_track_id')));
end;
$$;

comment on function public.update_song(uuid, text, uuid, uuid, uuid, public.music_nationality, public.music_vocal, integer, text, uuid, text, uuid) is
  'Replaces a song''s fields wholesale (every field set on every call, never merged) — except legacy_id (0102) and deezer_track_id (0139/design D6), neither of which this function takes or can write. Gained p_album_id and p_isrc in Block 13a and p_category_id in Block 27. Omitting the category clears it, which is what "wholesale" has to mean and is how a song is detached from a category before that category can be archived. The Organization and Company are resolved from the song row, never from a parameter.';

revoke execute on function public.update_song(uuid, text, uuid, uuid, uuid, public.music_nationality, public.music_vocal, integer, text, uuid, text, uuid) from public;
grant  execute on function public.update_song(uuid, text, uuid, uuid, uuid, public.music_nationality, public.music_vocal, integer, text, uuid, text, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- create_song_from_deezer
--
-- A uuid among twelve names, and that is not an inconsistency: the other four
-- references arrive BY NAME here because Deezer names them and the named thing
-- often does not exist in this Station yet, so this door resolves or creates
-- them. Deezer carries no category at all — there is no name to resolve and
-- nothing to create — so the operator picks from this Station's own list on
-- both paths, and what arrives is an id. song-fields.tsx renders the same
-- <select> under a Deezer prefill for exactly this reason.
-- ---------------------------------------------------------------------------

drop function public.create_song_from_deezer(
  uuid, text, text, text, text, text, bigint, bigint, text, text, text, date, integer);

create function public.create_song_from_deezer(
  p_company_id       uuid,
  p_title            text,
  p_artist_name      text,
  p_label_name       text    default null,
  p_genre_name       text    default null,
  p_album_title      text    default null,
  p_deezer_track_id  bigint  default null,
  p_deezer_album_id  bigint  default null,
  p_isrc             text    default null,
  p_upc              text    default null,
  p_cover_md5        text    default null,
  p_release_date     date    default null,
  p_duration_seconds integer default null,
  p_category_id      uuid    default null
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
  v_artist uuid;
  v_label  uuid;
  v_genre  uuid;
  v_album  uuid;
  -- Folded before storing and before checking, for the reason 0138's own
  -- v_isrc carries: songs_isrc_shape accepts upper case only.
  v_isrc   text := nullif(btrim(upper(coalesce(p_isrc, ''))), '');
  v_id     uuid;
begin
  if not public.has_permission('music.manage', p_company_id) then
    raise log 'create_song_from_deezer denied: actor=% company=%', v_actor, p_company_id;
    raise exception 'permission denied: music.manage required' using errcode = '42501';
  end if;

  if v_title is null then
    raise exception 'a title is required' using errcode = '22023';
  end if;

  if nullif(btrim(coalesce(p_artist_name, '')), '') is null then
    raise exception 'a song must name an artist' using errcode = '22023';
  end if;

  select organization_id into v_org
  from public.companies
  where id = p_company_id and deleted_at is null;

  if not found then
    raise exception 'station not found: %', p_company_id using errcode = 'P0002';
  end if;

  v_artist := public.resolve_or_create_reference(p_company_id, 'ARTIST', p_artist_name);
  v_label  := public.resolve_or_create_reference(p_company_id, 'LABEL',  p_label_name);
  v_genre  := public.resolve_or_create_reference(p_company_id, 'GENRE',  p_genre_name);
  v_album  := public.resolve_or_create_album(
                p_company_id, p_album_title, p_deezer_album_id,
                p_upc, p_cover_md5, p_release_date);

  -- 0101's assertion still applies, and is not redundant with the resolve
  -- above: 0103's reference locks close the window in which a row this
  -- function just resolved is archived by a concurrent transaction before the
  -- insert lands. This is the guard that refuses such a song rather than
  -- writing one whose artist no screen can read. The category was never
  -- resolved here — it arrives as an id the operator chose — so for it the
  -- assertion is the ONLY check that it exists, is live and is this Station's.
  perform public.assert_song_references_live(
    p_company_id, v_artist, v_label, v_genre, p_category_id);

  -- NO unique_violation HANDLER, deliberately, and this is exactly where
  -- 0101's handler would have lied. songs_deezer_live raises 23505 carrying
  -- its own constraint name, and src/app/(app)/music/errors.ts tells it apart
  -- by that name to say "another song in this Station is already linked to
  -- that recording". Catching it here would replace a precise refusal with a
  -- generic one -- the mistake 0130's own comment warns about at length.
  insert into public.songs
    (organization_id, company_id, title, artist_id, label_id, genre_id,
     album_id, duration_seconds, deezer_track_id, isrc, category_id, created_by)
  values
    (v_org, p_company_id, v_title, v_artist, v_label, v_genre,
     v_album,
     -- 0098 checks duration_seconds > 0. Deezer answers 0 for a handful of
     -- rows, and a 0 would fail that check and take the whole registration
     -- with it -- over a field nobody asked for.
     nullif(coalesce(p_duration_seconds, 0), 0),
     p_deezer_track_id, v_isrc, p_category_id, v_actor)
  returning id into v_id;

  insert into public.audit_logs
    (actor_id, action, target_table, target_id, organization_id, company_id, detail)
  values
    (v_actor, 'create_song_from_deezer', 'songs', v_id, v_org, p_company_id,
     jsonb_build_object(
       'title', v_title,
       'artist_id', v_artist,
       'deezer_track_id', p_deezer_track_id,
       'isrc', v_isrc,
       'category_id', p_category_id,
       -- Which references this call had to CREATE rather than find is the
       -- fact an operator asks about later ("where did this artist come
       -- from?"), and it is unrecoverable from the row afterwards.
       'album_id', v_album));

  return v_id;
end;
$$;

comment on function public.create_song_from_deezer(uuid, text, text, text, text, text, bigint, bigint, text, text, text, date, integer, uuid) is
  'Block 13a, design D3. Resolves or creates artist, label, genre and album and inserts the song, all in one transaction, so a failure anywhere leaves no orphan reference behind. p_category_id (Block 27) is the one reference that arrives as an ID rather than a name: Deezer carries no category, so there is nothing to resolve and the operator picks from this Station''s own list.';

revoke execute on function public.create_song_from_deezer(uuid, text, text, text, text, text, bigint, bigint, text, text, text, date, integer, uuid) from public;
grant  execute on function public.create_song_from_deezer(uuid, text, text, text, text, text, bigint, bigint, text, text, text, date, integer, uuid) to authenticated;
