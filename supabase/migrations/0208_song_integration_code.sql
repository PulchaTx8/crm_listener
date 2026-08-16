-- supabase/migrations/0208_song_integration_code.sql

-- Block 27, found by building the tab rather than by reading the plan — the
-- same way 0140 was found.
--
-- THE OWNER'S ITEM MOVED songs.internal_code OFF THE SONG DATA TAB and onto the
-- new Integration tab, relabelled "Integration code". The field moving is the
-- whole of the request; what the request could not know is what update_song
-- does with a field that is no longer on the form it serves.
--
-- update_song REPLACES EVERY FIELD IT TAKES ON EVERY CALL — its own comment
-- says so, and that is the convention. So a Song data form that no longer
-- carries the code posts nothing for it, the RPC's default (null) applies, and
-- EVERY ORDINARY SAVE OF A SONG SILENTLY ERASES ITS INTEGRATION CODE. Nothing on
-- screen would report it; the operator would find the Integration tab empty
-- some time later and have no way to know when.
--
-- THIS IS 0102 EXACTLY, one column over. That migration removed
-- p_legacy_id from update_song after the read-only legacy-id field left every
-- save omitting it, and its reasoning applies here word for word: a form that
-- simply never carries a value forward is indistinguishable, to the RPC, from
-- somebody who cleared it. The fix that actually closes it is the same one —
-- REMOVE THE PARAMETER, so there is no longer a write path to the column for
-- any update payload, hand-crafted or otherwise.
--
-- What replaces it is a door of its own, below: one column, one caller, one
-- permission check. Not a wider update_song, and not a second overload.

-- ---------------------------------------------------------------------------
-- update_song loses p_internal_code.
--
-- Copied forward from 0206, which is its live definition. DROP + CREATE because
-- the signature changes; the revoke/grant pair is restated because DROP resets
-- an ACL.
-- ---------------------------------------------------------------------------

drop function public.update_song(
  uuid, text, uuid, uuid, uuid,
  public.music_nationality, public.music_vocal, integer, text, uuid, text, uuid);

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

  -- THREE columns are not in this list and each has its own reason:
  -- legacy_id (0102, Block 9's import handle), deezer_track_id (0139 owns it,
  -- design D6) and now internal_code (0208 — this file's header). All three are
  -- the same shape of decision: a column this form does not carry must not be
  -- writable by this call at all, or "not carried" and "cleared" become the same
  -- payload.
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
       'duration_seconds', p_duration_seconds,
       'album_id', p_album_id, 'isrc', v_isrc, 'category_id', p_category_id,
       -- None of the three is changed by this call, and all three say so: read
       -- from v_before rather than from a parameter, because there IS no
       -- parameter to read any of them from.
       'internal_code', v_before->>'internal_code',
       'legacy_id', v_before->>'legacy_id',
       'deezer_track_id', v_before->>'deezer_track_id')));
end;
$$;

comment on function public.update_song(uuid, text, uuid, uuid, uuid, public.music_nationality, public.music_vocal, integer, uuid, text, uuid) is
  'Replaces a song''s fields wholesale (every field set on every call, never merged) — except legacy_id (0102), deezer_track_id (0139/design D6) and internal_code (0208), none of which this function takes or can write. internal_code left in Block 27, when the field moved to the Integration tab: a form that no longer carries a value posts the same payload as somebody clearing it, so every ordinary save would have erased the integration code. set_song_integration_code is the only update path for that column now.';

revoke execute on function public.update_song(uuid, text, uuid, uuid, uuid, public.music_nationality, public.music_vocal, integer, uuid, text, uuid) from public;
grant  execute on function public.update_song(uuid, text, uuid, uuid, uuid, public.music_nationality, public.music_vocal, integer, uuid, text, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- set_song_integration_code: the only update path to songs.internal_code.
--
-- ONE COLUMN, and deliberately so. The alternative was to let the Integration
-- tab post the whole song through update_song with the code changed, which
-- means the tab would have to carry every other field as a hidden input and
-- keep them in step — re-creating by hand exactly the "partial submission
-- blanks what it omits" trap this file exists to close.
--
-- create_song still writes the column on registration (0206), which is the
-- other half of the pair: a code can be given when the song is registered, and
-- changed afterwards here. Nothing else can touch it.
-- ---------------------------------------------------------------------------

create function public.set_song_integration_code(
  p_song_id uuid,
  p_code    text default null
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
  v_before  text;
  v_code    text := nullif(btrim(coalesce(p_code, '')), '');
begin
  -- 0093's one-gated-query idiom, the same one update_song uses: an unknown id,
  -- a Station this caller holds nothing in, and an archived song are one answer
  -- from outside.
  select organization_id, company_id, internal_code into v_org, v_company, v_before
  from public.songs
  where id = p_song_id and deleted_at is null
    and public.has_permission('music.manage', company_id);

  if not found then
    raise log 'set_song_integration_code denied: actor=% song=%', v_actor, p_song_id;
    raise exception 'permission denied: music.manage required' using errcode = '42501';
  end if;

  -- The column is unbounded `text` and the form's maxLength is a courtesy a
  -- caller posting straight at this RPC never sees. 40 matches
  -- save_song_integration's own bound on the code it is matched against, so a
  -- song can never carry a code longer than a card could be registered for.
  if v_code is not null and length(v_code) > 40 then
    raise exception 'an integration code is at most 40 characters' using errcode = '22023';
  end if;

  -- Blank CLEARS it, and that is the whole meaning of an empty box on the tab:
  -- this song is no longer linked to anything in the other system. There is no
  -- unique index on this column (0098 gives it none, deliberately — several
  -- songs may carry one code), so nothing here can collide.
  update public.songs
     set internal_code = v_code,
         updated_at    = now()
   where id = p_song_id;

  insert into public.audit_logs
    (actor_id, action, target_table, target_id, organization_id, company_id, detail)
  values
    (v_actor, 'set_song_integration_code', 'songs', p_song_id, v_org, v_company,
     jsonb_build_object('before', v_before, 'after', v_code));
end;
$$;

comment on function public.set_song_integration_code(uuid, text) is
  'Points a song at a code in the customer''s own system, or clears it when blank. The only update path to songs.internal_code since 0208 — update_song lost the parameter when the field moved to the Integration tab, because a form that stops carrying a value posts the same thing as somebody clearing it. Gated on music.manage, resolved from the song row rather than from an argument. Writes ONE column: routing this through update_song instead would make the tab carry every other field as a hidden input and keep them in step, which is the trap the parameter removal exists to close.';

revoke execute on function public.set_song_integration_code(uuid, text) from public;
grant  execute on function public.set_song_integration_code(uuid, text) to authenticated;
