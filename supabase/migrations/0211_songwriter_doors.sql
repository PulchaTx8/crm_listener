-- supabase/migrations/0211_songwriter_doors.sql

-- Block 28. The six functions that name the old word — in a returned string, in
-- a branch, or in a parameter.
--
-- FOUR OF THEM ARE DROP + CREATE, and not by preference: `create or replace`
-- REFUSES to change the name of an input parameter, and supabase-js calls every
-- RPC with NAMED arguments — so p_category_id → p_songwriter_id is a break the
-- service layer moves with in Task 2, and there is no in-place edit that would
-- have avoided it. Each revoke/grant pair is restated because DROP resets an
-- ACL (0102).
--
-- Each body is copied forward from its LIVE definition: update_song from 0208,
-- create_song and create_song_from_deezer from 0206, the other three from 0205.
-- Not from 0101, and not from 0140 — this project has recreated a function from
-- the wrong migration before and written it down.
--
-- The first two below MUST be replaced even though neither signature changes,
-- and this is not tidiness: 0209 renamed the enum value, so the literal
-- 'CATEGORY' in each of these bodies no longer names a label of
-- music_reference_kind. Both would raise `invalid input value for enum` on the
-- next call. Between 0209 and this file the two are broken on purpose, which is
-- the price of the house rule that enum vocabulary travels alone.

-- ---------------------------------------------------------------------------
-- The two whose signature does not change.
--
-- CREATE OR REPLACE keeps the ACL, so 0100's `revoke execute ... from public`
-- on music_reference_table (granted to nobody) and the grant to authenticated
-- on archive_music_reference both still stand and are not restated. 0102 had to
-- restate its pair because DROP resets an ACL; that reason does not reach here.
-- ---------------------------------------------------------------------------

create or replace function public.music_reference_table(p_kind public.music_reference_kind)
returns text
language sql
immutable
set search_path = pg_catalog, public
as $$
  select case p_kind
    when 'GENRE'      then 'music_genres'
    when 'LABEL'      then 'record_labels'
    when 'ARTIST'     then 'artists'
    when 'SHOW'       then 'shows'
    when 'SONGWRITER' then 'songwriters'
  end;
$$;

comment on function public.music_reference_table(public.music_reference_kind) is
  'Maps a reference kind to its table name, for the format(%I) in 0100''s three doors. IMMUTABLE and total: a value with no branch here returns null, and every caller formats that null into `public.""` and fails loudly rather than writing somewhere unintended. EXECUTE granted to nobody: it is only ever called from inside a SECURITY DEFINER body.';

create or replace function public.archive_music_reference(
  p_kind public.music_reference_kind,
  p_id   uuid
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor   uuid := auth.uid();
  v_table   text := public.music_reference_table(p_kind);
  v_org     uuid;
  v_company uuid;
  v_in_use  integer;
begin
  execute format(
    'select organization_id, company_id from public.%I
      where id = $1 and deleted_at is null
        and public.has_permission(''music.manage'', company_id)
        for update', v_table)
  into v_org, v_company
  using p_id;

  if v_company is null then
    raise log 'archive_music_reference denied: actor=% kind=% id=%', v_actor, p_kind, p_id;
    raise exception 'permission denied: music.manage required' using errcode = '42501';
  end if;

  if p_kind = 'ARTIST' then
    select count(*) into v_in_use from public.songs
     where artist_id = p_id and deleted_at is null;
  elsif p_kind = 'LABEL' then
    select count(*) into v_in_use from public.songs
     where label_id = p_id and deleted_at is null;
  elsif p_kind = 'GENRE' then
    select count(*) into v_in_use from public.songs
     where genre_id = p_id and deleted_at is null;
  -- Block 27, under Block 28's word. REFUSED while a live song wears it, not
  -- detached — and the difference from archive_prize_category (0202/0203) is
  -- the point rather than an inconsistency. Its three siblings above all refuse,
  -- and a fourth kind behaving differently INSIDE THIS SAME FUNCTION, chosen by
  -- an argument, would make one function mean two things depending on what you
  -- passed it. 0202 detaches because prizes.category_id has no assert_ helper
  -- standing over it and a prize left pointing at an unreadable row renders as
  -- uncategorised anyway; here the song would render a songwriter that had
  -- silently become blank, which is the exact failure 0100's own comment gives
  -- for artists.
  elsif p_kind = 'SONGWRITER' then
    select count(*) into v_in_use from public.songs
     where songwriter_id = p_id and deleted_at is null;
  else
    select count(*) into v_in_use from public.music_requests
     where show_id = p_id and deleted_at is null;
  end if;

  if v_in_use > 0 then
    raise exception 'this record is still used by % live row(s); change them first', v_in_use
      using errcode = '23503';
  end if;

  execute format(
    'update public.%I set deleted_at = now(), updated_at = now() where id = $1', v_table)
  using p_id;

  insert into public.audit_logs
    (actor_id, action, target_table, target_id, organization_id, company_id, detail)
  values
    (v_actor, 'archive_music_reference', v_table, p_id, v_org, v_company,
     jsonb_build_object('kind', p_kind));
end;
$$;

comment on function public.archive_music_reference(public.music_reference_kind, uuid) is
  'Soft-deletes a genre, label, artist, songwriter or show. Gated on music.manage. Never a DELETE — this project deletes nothing, and 0106''s merge history needs rows to keep pointing at. Refused while a live song (or, for a show, a live request) still names it, so no screen is left rendering a reference that RLS has made unreadable. Takes FOR UPDATE on the row before counting; that excludes a concurrent create_song only because 0103 makes assert_song_references_live take FOR KEY SHARE on the same row, and FOR KEY SHARE conflicts with FOR UPDATE and with nothing weaker. The two locks are a pair and neither works alone: until 0103 the reader took no lock, so an archive and a create could interleave and leave a live song naming an archived reference. Do not weaken this FOR UPDATE — FOR SHARE does not conflict with FOR KEY SHARE, so that change would reopen the race while both comments still claimed it was closed. 0205 added the fifth branch as CATEGORY; 0211 renamed it to SONGWRITER, and it is held by the same pair.';

-- ---------------------------------------------------------------------------
-- The live-reference check. DROP + CREATE because the fifth parameter's NAME
-- changes and REPLACE cannot do that.
--
-- The parameter stays LAST and DEFAULTED, so 0152's and apply_song_intake's
-- four-argument calls keep resolving here. Both call positionally, so the new
-- name reaches no existing call site.
--
-- The revoke is restated because DROP RESETS THE ACL. Without it the default
-- ACL would leave every role holding EXECUTE on a helper that takes row locks —
-- and a locking clause needs UPDATE privilege on the table, not merely SELECT,
-- so a caller who somehow reached it would fail confusingly rather than
-- harmlessly.
-- ---------------------------------------------------------------------------

drop function public.assert_song_references_live(uuid, uuid, uuid, uuid, uuid);

create function public.assert_song_references_live(
  p_company_id    uuid,
  p_artist_id     uuid,
  p_label_id      uuid,
  p_genre_id      uuid,
  p_songwriter_id uuid default null
)
returns void
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if p_artist_id is null then
    raise exception 'a song must name an artist' using errcode = '22023';
  end if;

  -- FOR KEY SHARE, not a bare read: this is the half that holds the row against
  -- archive_music_reference's FOR UPDATE. See 0103's header for the measured
  -- conflict table, and for why `perform ... for key share` is the shape rather
  -- than `exists (... for key share)`.
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

  -- Inside the `is not null` guard for the reason 0103's header gives about the
  -- two above it: with PERFORM, FOUND is set by every execution, so
  -- `if p_songwriter_id is not null and not found` would work only by accident
  -- of evaluation order.
  --
  -- The message says "songwriter", where 0205's said "category". That is not
  -- cosmetic: public.prize_categories raises the identical sentence from
  -- 0027/0203, and tests/isolation/prize-categories.test.ts matches on it. Two
  -- domains raising one string is how a failing test ends up read against the
  -- wrong table.
  if p_songwriter_id is not null then
    perform 1 from public.songwriters
     where id = p_songwriter_id and company_id = p_company_id and deleted_at is null
     for key share;

    if not found then
      raise exception 'songwriter not found in this station: %', p_songwriter_id using errcode = 'P0002';
    end if;
  end if;
end;
$$;

revoke execute on function public.assert_song_references_live(uuid, uuid, uuid, uuid, uuid) from public;

comment on function public.assert_song_references_live(uuid, uuid, uuid, uuid, uuid) is
  'Refuses an artist, label, genre or songwriter that is missing, archived, or from another Station. SECURITY INVOKER, EXECUTE granted to nobody. The composite foreign keys prove the Station by themselves; what they cannot see is deleted_at, which is the half this covers. Each check takes FOR KEY SHARE on the row it reads (0103), the weakest row-lock mode that conflicts with archive_music_reference''s FOR UPDATE: without it the two could interleave and leave a live song naming an archived reference. It deliberately does not conflict with another FOR KEY SHARE, so concurrent song creation is not serialised. p_songwriter_id is last and defaulted (0205, renamed 0211) so the four-argument calls in 0152 and apply_song_intake resolve here unchanged and mean "no songwriter".';

-- ---------------------------------------------------------------------------
-- The three song doors. DROP + CREATE for the parameter name; grants restated
-- because DROP resets the ACL.
--
-- The audit `detail` key travels with the column. A trail is read by people,
-- and a key naming a column that no longer exists is worse than no key: it
-- sends whoever is reading it to a \d that will not have it. Rows written
-- before this migration keep the old key, which is correct — they record what
-- the column was called when they were written.
-- ---------------------------------------------------------------------------

drop function public.create_song(uuid, text, uuid, uuid, uuid, public.music_nationality,
                                 public.music_vocal, integer, text, text, uuid, text, uuid);

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
  p_songwriter_id    uuid default null
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
    p_company_id, p_artist_id, p_label_id, p_genre_id, p_songwriter_id);

  -- The album joins that assertion's job, in the same spirit and for the same
  -- reason: the composite foreign key proves the Station but cannot see
  -- deleted_at, because it references a non-partial constraint. Without this,
  -- an archived album could be named by a new song and the record would render
  -- a blank where the album should be. (The songwriter needs the identical
  -- guard and gets it inside the helper above, where it can also take the row
  -- lock 0103's pair depends on — an album has no archive door racing it.)
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
       album_id, isrc, songwriter_id, created_by)
    values
      (v_org, p_company_id, v_title, p_artist_id, p_label_id, p_genre_id,
       p_nationality, p_vocal, p_duration_seconds, v_code, v_legacy,
       p_album_id, v_isrc, p_songwriter_id, v_actor)
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
                        'songwriter_id', p_songwriter_id));

  return v_id;
end;
$$;

revoke execute on function public.create_song(uuid, text, uuid, uuid, uuid, public.music_nationality,
                                              public.music_vocal, integer, text, text, uuid, text, uuid) from public;
grant execute on function public.create_song(uuid, text, uuid, uuid, uuid, public.music_nationality,
                                             public.music_vocal, integer, text, text, uuid, text, uuid) to authenticated;

drop function public.update_song(uuid, text, uuid, uuid, uuid, public.music_nationality,
                                 public.music_vocal, integer, uuid, text, uuid);

create function public.update_song(
  p_song_id          uuid,
  p_title            text,
  p_artist_id        uuid,
  p_label_id         uuid default null,
  p_genre_id         uuid default null,
  p_nationality      public.music_nationality default null,
  p_vocal            public.music_vocal default null,
  p_duration_seconds integer default null,
  p_album_id         uuid default null,
  p_isrc             text default null,
  p_songwriter_id    uuid default null
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
    v_company, p_artist_id, p_label_id, p_genre_id, p_songwriter_id);

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
           'album_id', album_id, 'isrc', isrc, 'songwriter_id', songwriter_id,
           'legacy_id', legacy_id, 'deezer_track_id', deezer_track_id)
    into v_before
  from public.songs where id = p_song_id;

  -- THREE columns are not in this list and each has its own reason:
  -- legacy_id (0102, Block 9's import handle), deezer_track_id (0139 owns it,
  -- design D6) and internal_code (0208). All three are the same shape of
  -- decision: a column this form does not carry must not be writable by this
  -- call at all, or "not carried" and "cleared" become the same payload.
  --
  -- No exception handler around this statement: songs_legacy_unique and
  -- songs_deezer_live are the only unique constraints over columns of this
  -- table, and this SET list writes neither of their columns.
  update public.songs
     set title            = v_title,
         artist_id        = p_artist_id,
         label_id         = p_label_id,
         genre_id         = p_genre_id,
         nationality      = p_nationality,
         vocal            = p_vocal,
         duration_seconds = p_duration_seconds,
         album_id         = p_album_id,
         isrc             = v_isrc,
         songwriter_id    = p_songwriter_id,
         updated_at       = now()
   where id = p_song_id;

  insert into public.audit_logs
    (actor_id, action, target_table, target_id, organization_id, company_id, detail)
  values
    (v_actor, 'update_song', 'songs', p_song_id, v_org, v_company,
     jsonb_build_object('before', v_before, 'after', jsonb_build_object(
       'title', v_title, 'artist_id', p_artist_id, 'label_id', p_label_id,
       'genre_id', p_genre_id, 'nationality', p_nationality, 'vocal', p_vocal,
       'duration_seconds', p_duration_seconds,
       'album_id', p_album_id, 'isrc', v_isrc, 'songwriter_id', p_songwriter_id,
       -- None of the three is changed by this call, and all three say so: read
       -- from v_before rather than from a parameter, because there IS no
       -- parameter to read any of them from.
       'internal_code', v_before->>'internal_code',
       'legacy_id', v_before->>'legacy_id',
       'deezer_track_id', v_before->>'deezer_track_id')));
end;
$$;

revoke execute on function public.update_song(uuid, text, uuid, uuid, uuid, public.music_nationality,
                                              public.music_vocal, integer, uuid, text, uuid) from public;
grant execute on function public.update_song(uuid, text, uuid, uuid, uuid, public.music_nationality,
                                             public.music_vocal, integer, uuid, text, uuid) to authenticated;

drop function public.create_song_from_deezer(uuid, text, text, text, text, text, bigint, bigint,
                                             text, text, text, date, integer, uuid);

create function public.create_song_from_deezer(
  p_company_id       uuid,
  p_title            text,
  p_artist_name      text,
  p_label_name       text default null,
  p_genre_name       text default null,
  p_album_title      text default null,
  p_deezer_track_id  bigint default null,
  p_deezer_album_id  bigint default null,
  p_isrc             text default null,
  p_upc              text default null,
  p_cover_md5        text default null,
  p_release_date     date default null,
  p_duration_seconds integer default null,
  p_songwriter_id    uuid default null
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
  -- writing one whose artist no screen can read. The songwriter was never
  -- resolved here — it arrives as an id the operator chose — so for it the
  -- assertion is the ONLY check that it exists, is live and is this Station's.
  perform public.assert_song_references_live(
    p_company_id, v_artist, v_label, v_genre, p_songwriter_id);

  -- NO unique_violation HANDLER, deliberately, and this is exactly where
  -- 0101's handler would have lied. songs_deezer_live raises 23505 carrying
  -- its own constraint name, and src/app/(app)/music/errors.ts tells it apart
  -- by that name to say "another song in this Station is already linked to
  -- that recording". Catching it here would replace a precise refusal with a
  -- generic one -- the mistake 0130's own comment warns about at length.
  insert into public.songs
    (organization_id, company_id, title, artist_id, label_id, genre_id,
     album_id, duration_seconds, deezer_track_id, isrc, songwriter_id, created_by)
  values
    (v_org, p_company_id, v_title, v_artist, v_label, v_genre,
     v_album,
     -- 0098 checks duration_seconds > 0. Deezer answers 0 for a handful of
     -- rows, and a 0 would fail that check and take the whole registration
     -- with it -- over a field nobody asked for.
     nullif(coalesce(p_duration_seconds, 0), 0),
     p_deezer_track_id, v_isrc, p_songwriter_id, v_actor)
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
       'songwriter_id', p_songwriter_id,
       -- Which references this call had to CREATE rather than find is the
       -- fact an operator asks about later ("where did this artist come
       -- from?"), and it is unrecoverable from the row afterwards.
       'album_id', v_album));

  return v_id;
end;
$$;

revoke execute on function public.create_song_from_deezer(uuid, text, text, text, text, text, bigint, bigint,
                                                          text, text, text, date, integer, uuid) from public;
grant execute on function public.create_song_from_deezer(uuid, text, text, text, text, text, bigint, bigint,
                                                         text, text, text, date, integer, uuid) to authenticated;
