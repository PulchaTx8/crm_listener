-- supabase/migrations/0137_album_rpcs.sql

-- Block 13a, Task 2: the album's three doors, plus the private resolver the
-- Deezer register path calls.
--
-- NOT FOLDED INTO 0100's create/update/archive_music_reference trio, and the
-- reason is that trio's own comment. It exists because four tables had
-- IDENTICAL columns -- a name and a legacy handle -- so twelve near-identical
-- bodies would have been twelve places for one fix to be applied to eleven.
-- Albums are not identical: they carry a UPC, a Deezer id, a cover hash and a
-- release date. Widening music_reference_kind to include them would push five
-- album-only parameters into every genre and label call, which is the opposite
-- of what that trio was for.
--
-- The permission is the same single code, music.manage (D8), and the order is
-- the one 0100 settled and 0093 argued: PERMISSION FIRST, EXISTENCE SECOND.
-- has_permission is false for a Station that does not exist and for one that
-- is suspended, so an unknown id and an unauthorised Station are one 42501
-- from outside, and neither confirms whether the other is the reason.

create or replace function public.create_album(
  p_company_id      uuid,
  p_title           text,
  p_upc             text   default null,
  p_deezer_album_id bigint default null,
  p_cover_md5       text   default null,
  p_release_date    date   default null,
  p_legacy_id       text   default null
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor uuid := auth.uid();
  v_org   uuid;
  v_title text := nullif(btrim(p_title), '');
  v_id    uuid;
begin
  if not public.has_permission('music.manage', p_company_id) then
    raise log 'create_album denied: actor=% company=%', v_actor, p_company_id;
    raise exception 'permission denied: music.manage required' using errcode = '42501';
  end if;

  if v_title is null then
    raise exception 'an album needs a title' using errcode = '23514';
  end if;

  select organization_id into v_org
  from public.companies
  where id = p_company_id and deleted_at is null;

  if v_org is null then
    raise exception 'no such station' using errcode = '42501';
  end if;

  insert into public.albums (
    organization_id, company_id, title, upc, deezer_album_id,
    cover_md5, release_date, legacy_id, created_by
  )
  values (
    v_org,
    p_company_id,
    v_title,
    nullif(btrim(coalesce(p_upc, '')), ''),
    p_deezer_album_id,
    nullif(btrim(coalesce(p_cover_md5, '')), ''),
    p_release_date,
    nullif(btrim(coalesce(p_legacy_id, '')), ''),
    v_actor
  )
  returning id into v_id;

  return v_id;
end;
$$;

comment on function public.create_album(uuid, text, text, bigint, text, date, text) is
  'Block 13a. Registers an album in one Station. music.manage, checked before anything is resolved.';

-- ---------------------------------------------------------------------------
-- update_album takes TITLE AND UPC AND NOTHING ELSE.
--
-- deezer_album_id and cover_md5 are deliberately absent, for the reason 0102
-- had to learn the expensive way with legacy_id: a field that must not be
-- edited is protected by THE ABSENCE OF A WRITE PATH, not by a form that
-- happens not to send it. An update form that simply never carries a value
-- forward is indistinguishable, to the function it calls, from an operator who
-- cleared it -- and update_song used to take that as "set it to null" and
-- apply it unconditionally.
--
-- The code and the cover travel together and are set by the Deezer path alone
-- (0139). Nothing here can move them, forged payload or not.
-- ---------------------------------------------------------------------------

create or replace function public.update_album(
  p_album_id uuid,
  p_title    text,
  p_upc      text default null
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor uuid := auth.uid();
  v_title text := nullif(btrim(p_title), '');
begin
  if v_title is null then
    raise exception 'an album needs a title' using errcode = '23514';
  end if;

  -- 0093's one-gated-query idiom: the permission is evaluated inside the same
  -- statement that finds the row, so an unknown id and an unreachable Station
  -- are the same refusal from outside.
  update public.albums
  set title      = v_title,
      upc        = nullif(btrim(coalesce(p_upc, '')), ''),
      updated_at = now()
  where id = p_album_id
    and deleted_at is null
    and public.has_permission('music.manage', company_id);

  if not found then
    raise log 'update_album denied or missing: actor=% album=%', v_actor, p_album_id;
    raise exception 'permission denied: music.manage required' using errcode = '42501';
  end if;
end;
$$;

comment on function public.update_album(uuid, text, text) is
  'Block 13a. Title and UPC only. No parameter reaches deezer_album_id or cover_md5 -- design D6, and 0102''s lesson.';

create or replace function public.archive_album(p_album_id uuid)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor uuid := auth.uid();
begin
  update public.albums
  set deleted_at = now()
  where id = p_album_id
    and deleted_at is null
    and public.has_permission('music.manage', company_id);

  if not found then
    raise log 'archive_album denied or missing: actor=% album=%', v_actor, p_album_id;
    raise exception 'permission denied: music.manage required' using errcode = '42501';
  end if;

  -- SONGS KEEP POINTING AT IT, deliberately. albums_select_music_view hides
  -- the row, so services/music.ts's embed comes back null while songs.album_id
  -- still names it -- exactly the behaviour SONG_COLUMNS' comment describes for
  -- an archived artist, and the screens already render it. Nulling
  -- songs.album_id here would destroy which album a song belonged to in order
  -- to tidy a display.
end;
$$;

comment on function public.archive_album(uuid) is
  'Block 13a. Soft-deletes an album. Songs keep album_id; the embed simply stops resolving, as it already does for an archived artist.';

-- ---------------------------------------------------------------------------
-- The private resolver.
--
-- EXECUTE GRANTED TO NOBODY. It writes without checking a permission, because
-- its only caller -- 0139's create_song_from_deezer -- has already checked one
-- and already resolved the Organization. Exposing it would be a second,
-- ungated write path into albums.
--
-- Matching is by Deezer id first and by folded title second. `unaccent` is NOT
-- used and cannot be: 0001 installs pgcrypto only, and adding an extension for
-- this would be a large decision taken sideways. So the match is
-- case-insensitive on the raw title, and an accent difference produces a
-- SECOND album rather than a wrong match. That is the safe direction -- a
-- duplicate an operator can rename beats silently filing a song under somebody
-- else's record -- and it is why albums got a catalogue tab in this block.
-- ---------------------------------------------------------------------------

create or replace function public.resolve_or_create_album(
  p_company_id      uuid,
  p_title           text,
  p_deezer_album_id bigint,
  p_upc             text,
  p_cover_md5       text,
  p_release_date    date
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_org   uuid;
  v_title text := nullif(btrim(p_title), '');
  v_id    uuid;
begin
  -- An album is optional on a song, and Deezer does not carry one for every
  -- track. Null rather than an exception: the caller inserts the song either
  -- way.
  if v_title is null then
    return null;
  end if;

  if p_deezer_album_id is not null then
    select id into v_id
    from public.albums
    where company_id = p_company_id
      and deezer_album_id = p_deezer_album_id
      and deleted_at is null;

    if v_id is not null then
      return v_id;
    end if;
  end if;

  select id into v_id
  from public.albums
  where company_id = p_company_id
    and deleted_at is null
    and lower(title) = lower(v_title)
  order by created_at
  limit 1;

  if v_id is not null then
    -- An album first typed by hand and now met on Deezer: fill in what it
    -- LACKED, never overwrite what it has. An operator's correction outranks a
    -- catalogue's, every time -- which is what coalesce says here.
    update public.albums
    set deezer_album_id = coalesce(deezer_album_id, p_deezer_album_id),
        upc             = coalesce(upc, nullif(btrim(coalesce(p_upc, '')), '')),
        cover_md5       = coalesce(cover_md5, nullif(btrim(coalesce(p_cover_md5, '')), '')),
        release_date    = coalesce(release_date, p_release_date),
        updated_at      = now()
    where id = v_id;

    return v_id;
  end if;

  select organization_id into v_org
  from public.companies
  where id = p_company_id and deleted_at is null;

  insert into public.albums (
    organization_id, company_id, title, upc, deezer_album_id,
    cover_md5, release_date, created_by
  )
  values (
    v_org,
    p_company_id,
    v_title,
    nullif(btrim(coalesce(p_upc, '')), ''),
    p_deezer_album_id,
    nullif(btrim(coalesce(p_cover_md5, '')), ''),
    p_release_date,
    auth.uid()
  )
  returning id into v_id;

  return v_id;
end;
$$;

revoke execute on function
  public.resolve_or_create_album(uuid, text, bigint, text, text, date)
  from public;

comment on function public.resolve_or_create_album(uuid, text, bigint, text, text, date) is
  'Block 13a. Deezer id first, folded title second, insert last. EXECUTE granted to nobody: it is called only from create_song_from_deezer, which has already checked music.manage.';
