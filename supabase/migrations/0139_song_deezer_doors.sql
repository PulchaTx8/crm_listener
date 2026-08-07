-- supabase/migrations/0139_song_deezer_doors.sql

-- Block 13a, Task 4: the three doors the Deezer tab uses.
--
-- A SEPARATE DOOR RATHER THAN THREE MORE PARAMETERS ON create_song, and the
-- reason is concrete rather than aesthetic. 0101 wraps create_song's insert in
--
--   exception when unique_violation then
--     raise exception 'a song with legacy id "%" already exists ...'
--
-- which was true when songs_legacy_unique was the only unique constraint that
-- insert could violate. 0138 adds songs_deezer_live. Had the Deezer columns
-- gone into create_song, every duplicate recording would have been reported to
-- the operator as a legacy-id collision -- a precise-sounding message about the
-- wrong column, which is worse than a vague one.
--
-- ATOMICITY IS THE WHOLE POINT OF create_song_from_deezer (design D3). It
-- resolves-or-creates FOUR references -- artist, label, genre, album -- and
-- then inserts the song. Doing that from four round trips in Node would leave,
-- on any failure after the first write, up to four orphan rows in a Station's
-- catalogue with nothing to explain where they came from and no screen that
-- would ever show them as related. A plpgsql function body is one transaction;
-- a raised exception unwinds every one of them.

-- ---------------------------------------------------------------------------
-- The reference resolver, twin of 0137's resolve_or_create_album, over 0100's
-- four short lists.
--
-- EXECUTE GRANTED TO NOBODY. It writes without checking a permission, because
-- its only caller has already checked one. Exposing it would be an ungated
-- write path into four tables at once.
--
-- A null or blank name returns null rather than raising: label and genre are
-- optional on a song, and Deezer carries neither for every track.
-- ---------------------------------------------------------------------------

create or replace function public.resolve_or_create_reference(
  p_company_id uuid,
  p_kind       public.music_reference_kind,
  p_name       text
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_table text := public.music_reference_table(p_kind);
  v_name  text := nullif(btrim(coalesce(p_name, '')), '');
  v_org   uuid;
  v_id    uuid;
begin
  if v_name is null then
    return null;
  end if;

  -- format(%I) over a value THIS SCHEMA produced from an enum, never over a
  -- caller's string -- 0100's rule, and music_reference_table is total, so an
  -- enum value added without a branch there returns null and this fails loudly
  -- on `public.""` rather than writing somewhere unintended. Every value is
  -- bound.
  --
  -- Case-insensitive on the raw name. `unaccent` is not installed (0001 brings
  -- pgcrypto only), so an accent difference produces a SECOND artist rather
  -- than a wrong match -- the safe direction, and the maintenance screen's
  -- merge (0105) is where a duplicate is joined afterwards.
  execute format(
    'select id from public.%I
      where company_id = $1 and deleted_at is null and lower(name) = lower($2)
      order by created_at limit 1', v_table)
  into v_id using p_company_id, v_name;

  if v_id is not null then
    return v_id;
  end if;

  select organization_id into v_org
  from public.companies
  where id = p_company_id and deleted_at is null;

  execute format(
    'insert into public.%I (organization_id, company_id, name, created_by)
     values ($1, $2, $3, $4) returning id', v_table)
  into v_id using v_org, p_company_id, v_name, auth.uid();

  return v_id;
end;
$$;

revoke execute on function
  public.resolve_or_create_reference(uuid, public.music_reference_kind, text)
  from public;

comment on function public.resolve_or_create_reference(uuid, public.music_reference_kind, text) is
  'Block 13a. Finds a reference by folded name in one Station or creates it. EXECUTE granted to nobody: called only from create_song_from_deezer, which has already checked music.manage.';

-- ---------------------------------------------------------------------------
-- create_song_from_deezer. Design D1, D2, D3.
-- ---------------------------------------------------------------------------

create or replace function public.create_song_from_deezer(
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
  p_duration_seconds integer default null
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
  -- writing one whose artist no screen can read.
  perform public.assert_song_references_live(p_company_id, v_artist, v_label, v_genre);

  -- NO unique_violation HANDLER, deliberately, and this is exactly where
  -- 0101's handler would have lied. songs_deezer_live raises 23505 carrying
  -- its own constraint name, and src/app/(app)/music/errors.ts tells it apart
  -- by that name to say "another song in this Station is already linked to
  -- that recording". Catching it here would replace a precise refusal with a
  -- generic one -- the mistake 0130's own comment warns about at length.
  insert into public.songs
    (organization_id, company_id, title, artist_id, label_id, genre_id,
     album_id, duration_seconds, deezer_track_id, isrc, created_by)
  values
    (v_org, p_company_id, v_title, v_artist, v_label, v_genre,
     v_album,
     -- 0098 checks duration_seconds > 0. Deezer answers 0 for a handful of
     -- rows, and a 0 would fail that check and take the whole registration
     -- with it -- over a field nobody asked for.
     nullif(coalesce(p_duration_seconds, 0), 0),
     p_deezer_track_id, v_isrc, v_actor)
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
       -- Which references this call had to CREATE rather than find is the
       -- fact an operator asks about later ("where did this artist come
       -- from?"), and it is unrecoverable from the row afterwards.
       'album_id', v_album));

  return v_id;
end;
$$;

comment on function public.create_song_from_deezer is
  'Block 13a, design D3. Resolves or creates artist, label, genre and album and inserts the song, all in one transaction, so a failure anywhere leaves no orphan reference behind.';

-- ---------------------------------------------------------------------------
-- link_song_to_deezer: the only write path to deezer_track_id on a song that
-- already exists (design D10).
--
-- IT TOUCHES THE DEEZER COLUMNS AND THE ALBUM AND NOTHING THE OPERATOR TYPED
-- -- not the title, not the artist, not the genre, not the duration. Somebody
-- who has curated a record for a year is not corrected by a catalogue. The
-- ISRC is written only when the song has none, by the same rule.
-- ---------------------------------------------------------------------------

create or replace function public.link_song_to_deezer(
  p_song_id         uuid,
  p_deezer_track_id bigint,
  p_album_title     text   default null,
  p_deezer_album_id bigint default null,
  p_upc             text   default null,
  p_cover_md5       text   default null,
  p_release_date    date   default null,
  p_isrc            text   default null
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
  v_album   uuid;
begin
  select organization_id, company_id into v_org, v_company
  from public.songs
  where id = p_song_id and deleted_at is null
    and public.has_permission('music.manage', company_id);

  if not found then
    raise log 'link_song_to_deezer denied: actor=% song=%', v_actor, p_song_id;
    raise exception 'permission denied: music.manage required' using errcode = '42501';
  end if;

  if p_deezer_track_id is null then
    raise exception 'a link needs a deezer track id' using errcode = '22023';
  end if;

  v_album := public.resolve_or_create_album(
               v_company, p_album_title, p_deezer_album_id,
               p_upc, p_cover_md5, p_release_date);

  update public.songs
     set deezer_track_id = p_deezer_track_id,
         album_id        = coalesce(v_album, album_id),
         isrc            = coalesce(isrc, nullif(btrim(upper(coalesce(p_isrc, ''))), '')),
         updated_at      = now()
   where id = p_song_id;

  insert into public.audit_logs
    (actor_id, action, target_table, target_id, organization_id, company_id, detail)
  values
    (v_actor, 'link_song_to_deezer', 'songs', p_song_id, v_org, v_company,
     jsonb_build_object('deezer_track_id', p_deezer_track_id, 'album_id', v_album));
end;
$$;

comment on function public.link_song_to_deezer is
  'Block 13a, design D10. Writes the Deezer id, the album and (only if absent) the ISRC onto a song that already exists. Touches nothing the operator typed.';

create or replace function public.unlink_song_from_deezer(p_song_id uuid)
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
    and public.has_permission('music.manage', company_id);

  if not found then
    raise log 'unlink_song_from_deezer denied: actor=% song=%', v_actor, p_song_id;
    raise exception 'permission denied: music.manage required' using errcode = '42501';
  end if;

  update public.songs
     set deezer_track_id = null,
         updated_at      = now()
   where id = p_song_id;

  -- album_id AND isrc SURVIVE AN UNLINK, deliberately. Unlinking says "this
  -- row is no longer the same recording as that Deezer track"; it does not say
  -- the album was wrong or the ISRC was wrong. Clearing them would throw away
  -- an operator's data in order to tidy a relationship.

  insert into public.audit_logs
    (actor_id, action, target_table, target_id, organization_id, company_id, detail)
  values
    (v_actor, 'unlink_song_from_deezer', 'songs', p_song_id, v_org, v_company,
     jsonb_build_object('song_id', p_song_id));
end;
$$;

comment on function public.unlink_song_from_deezer(uuid) is
  'Block 13a. Clears the Deezer id alone. The album and the ISRC survive: unlinking is not a statement that either was wrong.';

-- Postgres grants EXECUTE to PUBLIC on every newly created function, so each
-- public door is revoked and re-granted explicitly. The two resolvers above
-- are revoked and NOT granted -- that is the whole of their protection.
revoke execute on function public.create_song_from_deezer(uuid, text, text, text, text, text, bigint, bigint, text, text, text, date, integer) from public;
revoke execute on function public.link_song_to_deezer(uuid, bigint, text, bigint, text, text, date, text)                                       from public;
revoke execute on function public.unlink_song_from_deezer(uuid)                                                                                 from public;

grant execute on function public.create_song_from_deezer(uuid, text, text, text, text, text, bigint, bigint, text, text, text, date, integer) to authenticated;
grant execute on function public.link_song_to_deezer(uuid, bigint, text, bigint, text, text, date, text)                                       to authenticated;
grant execute on function public.unlink_song_from_deezer(uuid)                                                                                 to authenticated;
