-- supabase/migrations/0191_music_requests_list_triage.sql

-- Block 22, Task 3. The list learns the two statuses, four orderings and a
-- telephone number cut down to four digits.
--
-- DROP AND RECREATE rather than CREATE OR REPLACE: this function RETURNS
-- TABLE, and Postgres will not let a replacement change that shape. The shape
-- changes twice here -- five triage columns are added, and member_phone is
-- REPLACED by member_phone_last4 rather than joined by it (D8).
--
-- WHERE THIS BODY CAME FROM, AND WHY THAT SENTENCE IS HERE. Not from 0169. It
-- was dumped out of the running database with pg_get_functiondef() after
-- `npm run db:reset` had applied every migration through 0190, and that dump
-- was diffed against 0169's text before one character of it was edited: the
-- two agree byte for byte, and pg_proc holds exactly one list_music_requests,
-- so 0169 really was the last word on this function. That was checked rather
-- than assumed, because retyping a function body out of an old migration is
-- how a shipped fix gets silently reverted -- it happened in this repository
-- to 0163's public-key pin -- and "0169 is probably still the definition" is
-- precisely the sentence that costs the fix. Every comment in the live body
-- is carried down verbatim, with one exception said out loud rather than left
-- to be noticed: the comment over the `order by` is rewritten, because the
-- ordering it describes is the one thing in this body that stopped being what
-- it was.

drop function if exists public.list_music_requests(uuid, uuid, uuid, public.music_request_channel, text, timestamptz, uuid, boolean, integer);
create function public.list_music_requests(
  p_company_id   uuid,
  p_song_id      uuid    default null,
  p_show_id      uuid    default null,
  p_channel      public.music_request_channel default null,
  p_search       text    default null,
  -- New parameters, all defaulting to "narrow nothing".
  p_read_status  public.music_request_read_status default null,
  p_play_status  public.music_request_play_status default null,
  -- One of requested | song | artist | show. TEXT rather than an enum type:
  -- this names a UI ordering, not a fact about the domain, and a database type
  -- whose only purpose is to enumerate the sort menu is a type that has to be
  -- migrated every time the menu changes. Anything unrecognised falls back to
  -- `requested` rather than raising -- the same tolerance parseChannel already
  -- has for a hand-edited URL.
  p_sort         text default 'requested',
  p_cursor_at    timestamptz default null,
  p_cursor_id    uuid    default null,
  p_walking_back boolean default false,
  p_limit        integer default 51
)
returns table (
  request_id    uuid,
  member_id     uuid,
  member_name   text,
  -- Block 22 (D8). The last four digits of the normalised number, or null
  -- without members.view -- see the projection below for the argument.
  member_phone_last4 text,
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
  -- Block 22. The two derived statuses and the three stamps they are derived
  -- from (0189), together, so the screen can both show the state and say when
  -- it was reached without a second query. Not gated on members.view either,
  -- and for listener_note's reason: what has been done about a request is a
  -- fact about the request rather than about who made it.
  read_status   public.music_request_read_status,
  play_status   public.music_request_play_status,
  read_at       timestamptz,
  played_at     timestamptz,
  cancelled_at  timestamptz,
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
  -- THE CURSOR IS ONLY MEANINGFUL FOR ONE ORDERING. A keyset compares exactly
  -- the columns it orders by, so the three text orderings ignore the cursor
  -- entirely and return one bounded batch instead (design D6/D7). Honouring a
  -- requested_at cursor while ordering by title is how a list starts repeating
  -- rows and skipping others, which is the defect this variable exists to make
  -- impossible rather than merely unlikely.
  v_sort   text := case when p_sort in ('song', 'artist', 'show') then p_sort else 'requested' end;
  v_keyset boolean := (v_sort = 'requested');
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
           r.read_status, r.play_status, r.read_at, r.played_at, r.cancelled_at,
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
       and (p_read_status is null or r.read_status = p_read_status)
       and (p_play_status is null or r.play_status = p_play_status)
       and (v_search is null or m.full_name ilike '%' || v_search || '%'
                             or public.normalize_phone(m.phone)
                                  like '%' || public.normalize_phone(v_search) || '%')
  )
  select f.id,
         f.member_id,
         case when v_names then f.full_name else null end,
         -- FOUR DIGITS, NEVER THE NUMBER (Block 22 D8). Withheld entirely from a
         -- caller without members.view, exactly as the whole number was under
         -- 0107's RULE 2 -- what changed is that holding members.view no longer
         -- puts every listener's telephone number in the page source. The rest
         -- is asked for one request at a time through reveal_request_phone
         -- (0190), which records the asking.
         case when v_names then right(public.normalize_phone(f.phone), 4) else null end,
         f.song_id,
         f.song_title,
         f.song_archived,
         f.artist_name,
         f.show_id,
         f.show_name,
         f.channel,
         f.requested_at,
         f.listener_note,
         f.read_status,
         f.play_status,
         f.read_at,
         f.played_at,
         f.cancelled_at,
         -- From the SAME CTE the rows come from, so a page and its count
         -- cannot narrow differently (0090's rule).
         (select count(*) from visible)::integer as total_count
    from visible f
   -- THE FIRST DISJUNCT IS THE ORDERING GUARD, NOT A NULL GUARD (D6/D7).
   -- `not v_keyset` short-circuits the whole keyset comparison for the three
   -- text orderings: a cursor names a position in ONE ordering, so comparing
   -- requested_at while sorting by title would drop rows that belong in the
   -- batch and keep rows that do not. It is written here, in the WHERE, rather
   -- than by refusing the parameters, because the caller is allowed to pass a
   -- stale cursor along with a new sort -- the URL carries both and the
   -- operator changed one of them.
   --
   -- The two that follow are about NULLs and nothing else.
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
   where not v_keyset
      or p_cursor_at is null
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
   -- Newest first for the keyset ordering, and walking back reads the opposite
   -- of display order so LIMIT keeps the rows nearest the cursor -- 0107's own
   -- shape, unchanged. The three text orderings are A to Z with the row id as
   -- the tiebreak, so a page is stable when two songs share a title (D2 of Block
   -- 7 allows exactly that duplicate). A request with no programme sorts last
   -- rather than first, because "no programme" is not a name that begins with a
   -- space.
   order by
     case when v_keyset and p_walking_back then f.requested_at end asc,
     case when v_keyset and p_walking_back then f.id end asc,
     case when v_keyset and not p_walking_back then f.requested_at end desc,
     case when v_keyset and not p_walking_back then f.id end desc,
     case when v_sort = 'song'   then f.song_title  end asc nulls last,
     case when v_sort = 'artist' then f.artist_name end asc nulls last,
     case when v_sort = 'show'   then f.show_name   end asc nulls last,
     case when not v_keyset then f.id end asc
   -- D7'S SECOND CLAMP, AND THE REASON THERE ARE TWO. The URL parser clamps a
   -- typed limit to 1-200 (music/requests/list-params.ts), and that is the
   -- only clamp a form can be made to respect -- but this function is granted
   -- to `authenticated`, so anybody holding music.view can POST
   -- p_limit: 2000000000 straight at PostgREST and never touch the parser at
   -- all. A URL is not a form, and a grant is not a screen. `coalesce` first
   -- because LIMIT NULL in Postgres means "no limit", which is the same
   -- unbounded read arriving by a quieter route.
   limit greatest(1, least(coalesce(p_limit, 51), 200));
end;
$$;

comment on function public.list_music_requests(uuid, uuid, uuid, public.music_request_channel, text, public.music_request_read_status, public.music_request_play_status, text, timestamptz, uuid, boolean, integer) is
  'Block 7b''s list, extended by 17b and again by Block 22. One page of a Station''s music requests, with 0107''s three rules unchanged: (1) music.view or a 42501 rather than an empty page; (2) the listener''s name and telephone withheld rather than the page refused without members.view; (3) a listener search made without members.view returns nothing at all. Block 22 changes three things: the two derived statuses and their stamps come with every row; the telephone arrives as FOUR DIGITS and the rest is asked for through reveal_request_phone; and p_sort chooses between the keyset ordering (requested_at desc, cursor honoured) and three text orderings that ignore the cursor and return one bounded batch, because a keyset compares exactly the columns it orders by. p_limit is clamped to 1-200 HERE as well as in the URL parser (D7): this function is granted to authenticated, so the parser is not the last word on how many rows one call may read.';

revoke execute on function public.list_music_requests(uuid, uuid, uuid, public.music_request_channel, text, public.music_request_read_status, public.music_request_play_status, text, timestamptz, uuid, boolean, integer) from public;
grant  execute on function public.list_music_requests(uuid, uuid, uuid, public.music_request_channel, text, public.music_request_read_status, public.music_request_play_status, text, timestamptz, uuid, boolean, integer) to authenticated;
