-- supabase/migrations/0138_songs_deezer.sql

-- Block 13a, Task 3. Three columns on songs, and the one consequence for
-- update_song.
--
-- ALL THREE ARE OPTIONAL, and that is the requirement rather than a
-- convenience: songs typed by hand and songs registered from Deezer coexist
-- for good (the owner's ruling of 2026-08-07), and every screen must render
-- both without either looking broken.

alter table public.songs
  add column album_id        uuid,
  add column deezer_track_id bigint,
  add column isrc            text;

-- The Station proof, in a constraint. 0098 gives artist_id, label_id and
-- genre_id the same treatment for the same reason: an album from another
-- Station is refused by Postgres, before any screen or RPC gets a say.
alter table public.songs
  add constraint songs_album_company_fk
    foreign key (album_id, company_id)
    references public.albums (id, company_id);

-- An ISRC is two letters of country, three of registrant, two of year and five
-- of designation.
--
-- THERE IS NO UNIQUE INDEX HERE, deliberately (design D8). This column is
-- hand-editable, because not every song comes from Deezer and the ISRC is the
-- code the radio industry actually uses -- and a unique index would turn one
-- operator's typo into a door nobody can open. The duplicate guard belongs on
-- deezer_track_id below, which no human types.
alter table public.songs
  add constraint songs_isrc_shape
    check (isrc is null or isrc ~ '^[A-Z]{2}[A-Z0-9]{3}[0-9]{7}$');

-- Design D9. Partial for 0057's reason -- archiving and re-registering must
-- stay possible -- and it is THIS INDEX, not the interface, that makes
-- "already registered" true when two tabs are open at once.
create unique index songs_deezer_live
  on public.songs (company_id, deezer_track_id)
  where deleted_at is null and deezer_track_id is not null;

create index songs_album on public.songs (album_id) where deleted_at is null;

comment on column public.songs.deezer_track_id is
  'Block 13a. Set only by create_song_from_deezer and link_song_to_deezer (0139). update_song takes no parameter for it, by design D6 -- the code and the cover travel together, and a hand-typed code would leave the cover pointing at another album with nothing noticing.';

comment on column public.songs.isrc is
  'Block 13a. Hand-editable: not every song comes from Deezer, and the ISRC is what the radio industry actually uses. Format-checked, never unique (design D8).';

comment on column public.songs.album_id is
  'Block 13a. Where the cover comes from -- it lives on the album, not here (design D5). Null means no album, or an album RLS hides, and the screens render both the same honest way.';

-- ---------------------------------------------------------------------------
-- update_song, with two new trailing parameters and NOT A THIRD.
--
-- p_album_id and p_isrc are here because design D7 makes both hand-editable.
-- p_deezer_track_id is NOT here and must never be added: design D6 says the
-- code and the cover travel together, and 0102 already paid once for believing
-- that a form which does not send a field is the same as a field that cannot
-- be written. 0139's two doors are the only write path.
--
-- DROP + CREATE, NOT CREATE OR REPLACE. Two new parameters change the
-- signature, and `create or replace` would leave Postgres holding BOTH
-- overloads -- so every caller still passing nine arguments would keep
-- resolving to the old body, silently, and albums and ISRCs would appear to
-- save and not. 0047, 0055 and 0102 each hit this and each drop the full old
-- signature first. Dropping resets the ACL (Postgres grants EXECUTE to PUBLIC
-- on every newly created function), so the revoke/grant pair is restated at
-- the bottom -- not out of tidiness.
--
-- Everything else below is 0102's body unchanged, including the audit write:
-- every field is still set on every call, the convention update_prize and
-- update_role established, so a partial submission blanks what it omits. The
-- two new parameters must therefore be sent by every caller, and
-- src/app/(app)/music/songs/actions.ts is updated in the same block.
-- ---------------------------------------------------------------------------

drop function public.update_song(
  uuid, text, uuid, uuid, uuid,
  public.music_nationality, public.music_vocal, integer, text);

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
  p_isrc             text default null
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

  perform public.assert_song_references_live(v_company, p_artist_id, p_label_id, p_genre_id);

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
           'album_id', album_id, 'isrc', isrc,
           'legacy_id', legacy_id, 'deezer_track_id', deezer_track_id)
    into v_before
  from public.songs where id = p_song_id;

  -- legacy_id is not in this list (0102), and deezer_track_id is not in it
  -- either (0139 owns that column). No exception handler around this
  -- statement: songs_legacy_unique and songs_deezer_live are the only unique
  -- constraints over columns of this table, and this SET list writes neither
  -- of their columns.
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
       'album_id', p_album_id, 'isrc', v_isrc,
       -- Neither is changed by this call, and both say so: read from v_before
       -- rather than from a parameter, because there IS no parameter to read
       -- either of them from.
       'legacy_id', v_before->>'legacy_id',
       'deezer_track_id', v_before->>'deezer_track_id')));
end;
$$;

comment on function public.update_song(uuid, text, uuid, uuid, uuid, public.music_nationality, public.music_vocal, integer, text, uuid, text) is
  'Replaces a song''s fields wholesale (every field set on every call, never merged) — except legacy_id (0102) and deezer_track_id (0139/design D6), neither of which this function takes or can write. Gained p_album_id and p_isrc in Block 13a because design D7 makes both hand-editable. The Organization and Company are resolved from the song row, never from a parameter.';

revoke execute on function public.update_song(uuid, text, uuid, uuid, uuid, public.music_nationality, public.music_vocal, integer, text, uuid, text) from public;
grant  execute on function public.update_song(uuid, text, uuid, uuid, uuid, public.music_nationality, public.music_vocal, integer, text, uuid, text) to authenticated;
