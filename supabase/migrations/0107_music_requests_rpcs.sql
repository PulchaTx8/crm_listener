-- supabase/migrations/0107_music_requests_rpcs.sql

-- Block 7b, Task 3: the doors onto music_requests, and the list.
--
-- The table landed in 0098 with nothing writing to it. This is what writes,
-- withdraws and reads it.

-- ---------------------------------------------------------------------------
-- The write. Gated on music.request (D8), which is its own code because
-- recording what a listener asked for is a different job from maintaining the
-- catalogue.
--
-- NO CHANNEL PARAMETER, deliberately. §3.3 gives the column MANUAL | IMPORT
-- and this door writes MANUAL unconditionally, so a hand-typed row cannot be
-- labelled an import by a caller. record_participation (0054) does take a
-- p_source and its own comment calls it "recorded, not consulted" — that is a
-- wider door than this block needs, and 0101's warning about "a parameter that
-- looks like it decides something while deciding nothing" points the other
-- way. Block 9's ETL gets its own door, the way import_participations is
-- separate from record_participation.
-- ---------------------------------------------------------------------------

create function public.create_music_request(
  p_company_id   uuid,
  p_member_id    uuid,
  p_song_id      uuid,
  p_show_id      uuid        default null,
  p_requested_at timestamptz default null
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor uuid := auth.uid();
  v_org   uuid;
  v_id    uuid;
begin
  -- Permission first, existence second (0093). has_permission is false for a
  -- Station that does not exist and for one that is suspended, so this answers
  -- 42501 without confirming whether the id names anything.
  if not public.has_permission('music.request', p_company_id) then
    raise log 'create_music_request denied: actor=% company=%', v_actor, p_company_id;
    raise exception 'permission denied: music.request required' using errcode = '42501';
  end if;

  select organization_id into v_org
    from public.companies
   where id = p_company_id and deleted_at is null;

  if not found then
    raise exception 'station not found: %', p_company_id using errcode = 'P0002';
  end if;

  -- The listener must be reachable FROM THIS STATION. 0098's composite foreign
  -- key proves only the Organization — members are Organization-scoped (0031),
  -- so the same person entering at two of the group's Stations is one row —
  -- and which Stations may see them is member_company_links' business. 0098's
  -- own comment says this door checks that link; this is it.
  --
  -- An anonymised listener is excluded for the reason searchStationListeners
  -- gives: 0034 scrubs full_name, so the row would be a blank line nobody can
  -- identify, and recording fresh activity against somebody who exercised
  -- erasure is precisely what that erasure was for.
  if not exists (
    select 1 from public.members m
      join public.member_company_links l on l.member_id = m.id
     where m.id = p_member_id
       and m.organization_id = v_org
       and l.company_id = p_company_id
       and m.deleted_at is null
       and m.anonymized_at is null
  ) then
    raise exception 'listener not found in this station: %', p_member_id using errcode = 'P0002';
  end if;

  -- The song and the show are proved by the composite foreign keys 0098
  -- declares — a song from another Station cannot be inserted at all. What
  -- those keys CANNOT see is deleted_at (they reference a non-partial
  -- constraint), so an archived song would otherwise be a legal target.
  --
  -- FOR KEY SHARE, NOT A BARE `exists` — and this is 0103's defect one level
  -- down, caught in review before it was written a second time.
  --
  -- 0106's merge takes FOR UPDATE on the song and the show it is about to
  -- archive. A plain read takes no row lock and is never blocked by one, so
  -- under READ COMMITTED this sequence commits a live request naming a song
  -- that no longer exists to any reader:
  --   1. merge_songs locks the loser FOR UPDATE and starts repointing;
  --   2. create_music_request reads the loser as live — the merge has not
  --      committed — and returns from its check;
  --   3. the merge commits, archiving the loser;
  --   4. the INSERT lands, and 0099's policy makes its song unreadable.
  -- The request is then a row the Requests screen shows with a title only
  -- list_music_requests can still see, pointing at a song the merge already
  -- counted and moved past. It is exactly the state 0103 was written to close
  -- for songs naming artists, and 0027 for movements naming prizes.
  --
  -- FOR KEY SHARE is the mode with exactly one conflict — FOR UPDATE — which
  -- is the whole requirement: it serialises against the merge's archive and
  -- against nothing else, so two concurrent requests for the same song never
  -- queue behind each other and an ordinary rename (FOR NO KEY UPDATE) does
  -- not block either. 0103's header sets out the reasoning in full.
  --
  -- `perform` rather than `if not exists`, because `exists` discards the lock:
  -- the row has to actually be selected for FOR KEY SHARE to be taken on it.
  perform 1 from public.songs
    where id = p_song_id and company_id = p_company_id and deleted_at is null
    for key share;

  if not found then
    raise exception 'song not found in this station: %', p_song_id using errcode = 'P0002';
  end if;

  if p_show_id is not null then
    perform 1 from public.shows
      where id = p_show_id and company_id = p_company_id and deleted_at is null
      for key share;

    if not found then
      raise exception 'programme not found in this station: %', p_show_id using errcode = 'P0002';
    end if;
  end if;

  insert into public.music_requests
    (organization_id, company_id, member_id, song_id, show_id, channel, requested_at, created_by)
  values
    (v_org, p_company_id, p_member_id, p_song_id, p_show_id, 'MANUAL',
     coalesce(p_requested_at, now()), v_actor)
  returning id into v_id;

  insert into public.audit_logs
    (actor_id, action, target_table, target_id, organization_id, company_id, detail)
  values
    (v_actor, 'create_music_request', 'music_requests', v_id, v_org, p_company_id,
     jsonb_build_object('member_id', p_member_id, 'song_id', p_song_id, 'show_id', p_show_id));

  return v_id;
end;
$$;

comment on function public.create_music_request(uuid, uuid, uuid, uuid, timestamptz) is
  'Records by hand that a listener asked for a song. Gated on music.request, checked before the Station is resolved. The channel is always MANUAL and there is no parameter to say otherwise — Block 9''s ETL gets its own door rather than this one being widened. The listener must be linked to this Station and not anonymised; the song and the programme must be live in it, which the composite foreign keys cannot check because they cannot see deleted_at.';

-- ---------------------------------------------------------------------------
-- The withdrawal. Gated on music.request, not music.merge: §D5 says
-- deleted_at exists on this table only so a MISTYPED MANUAL ENTRY can be
-- withdrawn, and whoever may record one is who notices they typed it wrong.
-- music.merge is the destructive code for the CATALOGUE, where the loss is a
-- record other rows point at; withdrawing a request loses one historical fact
-- that the same person just created.
-- ---------------------------------------------------------------------------

create function public.archive_music_request(p_request_id uuid)
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
  -- 0093's one-gated-query idiom: no such id, an id in a Station this caller
  -- holds nothing in, and an already-withdrawn row all answer 42501 alike.
  select organization_id, company_id into v_org, v_company
    from public.music_requests
   where id = p_request_id and deleted_at is null
     and public.has_permission('music.request', company_id);

  if v_company is null then
    raise log 'archive_music_request denied: actor=% request=%', v_actor, p_request_id;
    raise exception 'permission denied: music.request required' using errcode = '42501';
  end if;

  update public.music_requests
     set deleted_at = now(), updated_at = now()
   where id = p_request_id;

  insert into public.audit_logs
    (actor_id, action, target_table, target_id, organization_id, company_id, detail)
  values
    (v_actor, 'archive_music_request', 'music_requests', p_request_id, v_org, v_company,
     '{}'::jsonb);
end;
$$;

comment on function public.archive_music_request(uuid) is
  'Withdraws a request. Gated on music.request rather than a destructive code, because D5 puts deleted_at on this table for one purpose only: a mistyped manual entry. Never a DELETE.';

-- ---------------------------------------------------------------------------
-- The list. SECURITY DEFINER, so what 0099's policy would have done for free
-- is done here by hand — D6, which is not a new decision: it is what
-- list_participations (0090) and list_pickups (0095) already do, and 0090
-- writes out the reasoning in full.
--
--   * RULE 1 — music.view at this Station, or a 42501. An empty page would be
--     indistinguishable from a Station where nobody has asked for anything;
--   * RULE 2 — the listener's name and phone ONLY to a caller holding
--     members.view. Without it THE LIST STILL LISTS, every row, with those two
--     null;
--   * RULE 3 — a SEARCH without members.view returns NOTHING. Searching a
--     field you may not read answers "is there a listener called X here?" to
--     somebody forbidden the name itself.
--
-- ONE THING THIS LIST DOES THAT THE OTHER TWO DO NOT: it returns an ARCHIVED
-- song's title, marked. archive_song (0101) is deliberately never refused over
-- a live request naming it — a request is a historical fact that outlives the
-- song — so a request CAN point at a song 0099's policy has made unreadable.
-- Reading it from inside this body is the only way the row is legible at all;
-- hiding the title would leave the operator a request for nothing. song_archived
-- is returned beside it so the screen can say which it is rather than implying
-- the song is still in the catalogue.
--
-- Keyset on (requested_at desc, id desc). requested_at is NOT NULL (0098), so
-- there is no null region and plain tuple comparison is enough — this is
-- list_participations' shape, not list_pickups', which needed regions because
-- deadline_at is nullable.
-- ---------------------------------------------------------------------------

create function public.list_music_requests(
  p_company_id   uuid,
  p_song_id      uuid    default null,
  p_show_id      uuid    default null,
  p_channel      public.music_request_channel default null,
  p_search       text    default null,
  p_cursor_at    timestamptz default null,
  p_cursor_id    uuid    default null,
  p_walking_back boolean default false,
  p_limit        integer default 51
)
returns table (
  request_id    uuid,
  member_id     uuid,
  member_name   text,
  member_phone  text,
  song_id       uuid,
  song_title    text,
  song_archived boolean,
  artist_name   text,
  show_id       uuid,
  show_name     text,
  channel       public.music_request_channel,
  requested_at  timestamptz,
  total_count   integer
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  v_names  boolean;
  v_search text := nullif(btrim(coalesce(p_search, '')), '');
begin
  -- RULE 1.
  if not public.has_permission('music.view', p_company_id) then
    raise log 'list_music_requests denied: actor=% company=%', auth.uid(), p_company_id;
    raise exception 'permission denied: music.view required' using errcode = '42501';
  end if;

  -- RULE 2.
  v_names := public.has_permission('members.view', p_company_id);

  -- RULE 3.
  if v_search is not null and not v_names then
    return;
  end if;

  return query
  with visible as (
    select r.id, r.member_id, r.song_id, r.show_id, r.channel, r.requested_at,
           m.full_name, m.phone,
           s.title as song_title,
           (s.deleted_at is not null) as song_archived,
           a.name as artist_name,
           sh.name as show_name
      from public.music_requests r
      join public.members m on m.id = r.member_id
      join public.songs   s on s.id = r.song_id
      join public.artists a on a.id = s.artist_id
      left join public.shows sh on sh.id = r.show_id
     where r.company_id = p_company_id
       and r.deleted_at is null
       and (p_song_id is null or r.song_id = p_song_id)
       and (p_show_id is null or r.show_id = p_show_id)
       and (p_channel is null or r.channel = p_channel)
       and (v_search is null or m.full_name ilike '%' || v_search || '%'
                             or public.normalize_phone(m.phone)
                                  like '%' || public.normalize_phone(v_search) || '%')
  )
  select f.id,
         f.member_id,
         case when v_names then f.full_name else null end,
         case when v_names then f.phone else null end,
         f.song_id,
         f.song_title,
         f.song_archived,
         f.artist_name,
         f.show_id,
         f.show_name,
         f.channel,
         f.requested_at,
         -- From the SAME CTE the rows come from, so a page and its count
         -- cannot narrow differently (0090's rule).
         (select count(*) from visible)::integer as total_count
    from visible f
   where p_cursor_id is null
      or (
        case when p_walking_back then
          -- Toward earlier positions in display order (newest first).
          f.requested_at > p_cursor_at
          or (f.requested_at = p_cursor_at and f.id > p_cursor_id)
        else
          f.requested_at < p_cursor_at
          or (f.requested_at = p_cursor_at and f.id < p_cursor_id)
        end
      )
   -- Newest first. Walking back reads the opposite of display order so LIMIT
   -- keeps the rows nearest the cursor, and the caller reverses the small
   -- batch — list_participations' own shape.
   order by
     case when p_walking_back then f.requested_at end asc,
     case when p_walking_back then f.id end asc,
     case when not p_walking_back then f.requested_at end desc,
     case when not p_walking_back then f.id end desc
   limit p_limit;
end;
$$;

comment on function public.list_music_requests(uuid, uuid, uuid, public.music_request_channel, text, timestamptz, uuid, boolean, integer) is
  'One keyset page of a Station''s music requests, newest first. SECURITY DEFINER, so D6''s three rules are restated by hand: (1) music.view or a 42501 rather than an empty page; (2) the listener''s name and phone only to a caller holding members.view — without it the list still lists, every row, with those two null; (3) a SEARCH without members.view returns nothing at all, because searching a field you may not read is an oracle (0090 argues it in full). Returns an ARCHIVED song''s title with song_archived true rather than hiding it: archive_song is deliberately never refused over a live request naming it, so such rows exist and would otherwise be illegible. total_count is computed from the same CTE the rows come from.';

revoke execute on function public.create_music_request(uuid, uuid, uuid, uuid, timestamptz) from public;
revoke execute on function public.archive_music_request(uuid) from public;
revoke execute on function public.list_music_requests(uuid, uuid, uuid, public.music_request_channel, text, timestamptz, uuid, boolean, integer) from public;

grant execute on function public.create_music_request(uuid, uuid, uuid, uuid, timestamptz) to authenticated;
grant execute on function public.archive_music_request(uuid) to authenticated;
grant execute on function public.list_music_requests(uuid, uuid, uuid, public.music_request_channel, text, timestamptz, uuid, boolean, integer) to authenticated;
