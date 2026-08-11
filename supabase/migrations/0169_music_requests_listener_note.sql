-- supabase/migrations/0169_music_requests_listener_note.sql

-- Block 17b. The listener's note reaches the operator.
--
-- DROP AND RECREATE rather than CREATE OR REPLACE: this function RETURNS
-- TABLE, and Postgres will not let a replacement change that shape. The body
-- below is 0107's, copied byte-for-byte by a script rather than retyped, with
-- exactly two edits -- listener_note in the returned columns and in the two
-- selects that build them. Copying a function body forward is how a shipped
-- fix gets reverted, which happened to 0163's public-key pin one migration
-- ago; 0107 is the only definition of this function, checked before writing
-- this, so there is nothing later to lose.

drop function if exists public.list_music_requests(uuid, uuid, uuid, public.music_request_channel, text, timestamptz, uuid, boolean, integer);
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
  -- Block 17b. Null for every request that did not arrive through the widget,
  -- and null for a widget request whose listener wrote nothing -- the screen
  -- has no reason to tell those apart, because both mean there is nothing to
  -- read. NOT gated on members.view like the two name columns above: a note is
  -- about the request, not about who made it.
  listener_note text,
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
           r.listener_note,
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
         f.listener_note,
         -- From the SAME CTE the rows come from, so a page and its count
         -- cannot narrow differently (0090's rule).
         (select count(*) from visible)::integer as total_count
    from visible f
   -- Fix round 1, Important 2: guard on BOTH p_cursor_at is null and
   -- p_cursor_id is null, matching list_participations (0090:191-192) and
   -- list_movements (0096:193-194) — both NOT NULL sort keys, exactly this
   -- shape. The single-condition form (p_cursor_id is null alone) is
   -- list_pickups' (0095), and its own comment says it cannot express the
   -- other because deadline_at is nullable; requested_at is NOT NULL here, so
   -- there was never a reason to take that weaker form. Without both, a
   -- caller passing p_cursor_id with a null p_cursor_at evaluates every
   -- comparison against NULL, gets zero rows, and — since total_count comes
   -- from the same zero-row result — an empty page from the one list whose
   -- Rule 1 exists specifically so an empty page is never silent.
   where p_cursor_at is null
      or p_cursor_id is null
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
  'Block 12b''s list, extended by 17b. One page of a Station''s music requests, newest first, with the listener''s name and telephone withheld rather than the page refused when the caller lacks members.view (0107''s RULE 2), and nothing at all returned for a listener search made without it (RULE 3). listener_note is Block 17b''s: what a listener typed alongside a request made from the Station''s own website, and it is NOT withheld with the names -- a note is about the request rather than about who made it.';

revoke execute on function public.list_music_requests(uuid, uuid, uuid, public.music_request_channel, text, timestamptz, uuid, boolean, integer) from public;
grant execute on function public.list_music_requests(uuid, uuid, uuid, public.music_request_channel, text, timestamptz, uuid, boolean, integer) to authenticated;
