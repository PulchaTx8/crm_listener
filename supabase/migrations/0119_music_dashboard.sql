-- supabase/migrations/0119_music_dashboard.sql

-- Block 8a, Task 4: the Music dashboard. Same shape as 0118 (same arguments,
-- same station CTE, same permission loop, same payload contract); what follows
-- is only what is specific to music.
--
-- WHAT MASTER SPEC §4.2 GOT WRONG, and this function does not. It describes the
-- last two indicators as "domestic/international" and "male/female".
-- music_vocal has FIVE values -- MALE, FEMALE, DUO, GROUP, INSTRUMENTAL -- and
-- songs.vocal and songs.nationality are both nullable. A two-slice chart would
-- silently drop duets, groups, instrumentals and every song whose attribute was
-- never filled in, and the slices would not add up to the request total printed
-- beside them. Both breakdowns therefore carry every value of their enum plus an
-- explicit "not stated" bucket, and the pgTAP suite asserts the sum rather than
-- the slices, because it is the sum that a future edit would break silently. The
-- window filter is applied inside these two CTEs (rather than left implicit the
-- way 0118's blocks_by_kind reads a pre-filtered slice) so the invariant holds
-- for every period requested, not only the one the fixtures happen to cover.
--
-- Nothing here is ever withheld (D13): every table this reads -- songs,
-- music_requests, music_genres -- is gated by music.view, which is this panel's
-- own gate. The withheld key is still present and empty, so the three payloads
-- share one shape and one Zod schema.
--
-- "Total" is reported twice, separately labelled: §4.2 does not say whether it
-- meant the catalogue or the requests, and the two answer different questions --
-- catalogue is a stock figure measured as of each window's end (D6), requests a
-- flow figure counted inside each window.
--
-- SECURITY INVOKER, for the same reason 0118 gives (D4): the select policies
-- already in force -- 0099's on songs/music_requests/music_genres -- apply
-- INSIDE this function and cannot be forgotten. What is still done by hand is
-- the permission check below, because RLS answers "which rows" and not "may
-- this person be here at all".
create or replace function public.get_music_dashboard(
  p_company_ids uuid[],
  p_preset      text default 'current_month',
  p_from        date default null,
  p_to          date default null
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_ids          uuid[];
  v_id           uuid;
  v_consolidated boolean;
  v_result       jsonb;
begin
  if p_company_ids is null or cardinality(p_company_ids) = 0 then
    raise exception 'at least one station is required' using errcode = '22023';
  end if;

  -- Deduplicated before anything counts, so naming a Station twice cannot
  -- double its rows.
  select array_agg(distinct s) into v_ids from unnest(p_company_ids) as t(s);
  v_consolidated := cardinality(v_ids) > 1;

  foreach v_id in array v_ids loop
    if not public.has_permission('music.view', v_id) then
      raise exception 'music.view is required in every station requested'
        using errcode = '42501';
    end if;
    if v_consolidated and not public.has_permission('reports.consolidated', v_id) then
      raise exception 'reports.consolidated is required in every station of a consolidated view'
        using errcode = '42501';
    end if;
  end loop;

  with station as (
    -- organization_id is selected here and not looked up again below, for the
    -- same reason 0118 gives: the Organization-wide branches (none needed
    -- here, but the shape stays shared) would otherwise re-read a row this
    -- CTE already holds.
    select c.id, c.organization_id, c.name, c.timezone, p.*
      from public.companies c
      cross join lateral public.resolve_dashboard_period(p_preset, p_from, p_to, c.timezone) p
     where c.id = any(v_ids)
  ),
  song as (
    select sg.id, sg.title, sg.genre_id, sg.nationality, sg.vocal, sg.created_at,
           st.timezone, st.from_at, st.to_at, st.previous_from_at, st.previous_to_at
      from public.songs sg
      join station st on st.id = sg.company_id
     where sg.deleted_at is null
  ),
  -- Every non-deleted request in every requested Station, spanning both
  -- windows -- exactly like 0118's `link`, so cards can filter current vs.
  -- previous with FILTER rather than two separately-scoped CTEs. Carries the
  -- joined song's nationality and vocal so the breakdowns below need no
  -- second join to songs.
  request as (
    select r.id, r.requested_at, r.song_id, sg.genre_id, sg.title as song_title,
           sg.nationality, sg.vocal, sg.timezone,
           sg.from_at, sg.to_at, sg.previous_from_at, sg.previous_to_at
      from public.music_requests r
      join song sg on sg.id = r.song_id
     where r.deleted_at is null
  ),
  song_cards as (
    select
      -- Stock figure: the catalogue as it stood at the end of each window
      -- (D6), from songs.created_at -- not "as of now", or a historical
      -- period would report today's catalogue size instead of its own.
      count(*) filter (where created_at < to_at)          as catalogue_current,
      count(*) filter (where created_at < previous_to_at) as catalogue_previous,
      -- Flow figure: songs catalogued inside each window.
      count(*) filter (where created_at >= from_at and created_at < to_at)
                                                            as new_current,
      count(*) filter (where created_at >= previous_from_at and created_at < previous_to_at)
                                                            as new_previous
      from song
  ),
  request_cards as (
    select
      count(*) filter (where requested_at >= from_at and requested_at < to_at)
        as current,
      count(*) filter (where requested_at >= previous_from_at and requested_at < previous_to_at)
        as previous
      from request
  ),
  monthly as (
    select jsonb_agg(jsonb_build_object('month', m.bucket, 'count', m.n) order by m.bucket) as rows
      from (
        select to_char(date_trunc('month', r.requested_at at time zone r.timezone), 'YYYY-MM') as bucket,
               count(*) as n
          from request r
         where r.requested_at < r.to_at
           and r.requested_at >= (r.to_at - interval '12 months')
         group by 1
      ) m
  ),
  top_songs as (
    select jsonb_agg(jsonb_build_object('id', t.song_id, 'label', t.title, 'count', t.n)
                     order by t.n desc, t.title) as rows
      from (
        select r.song_id, r.song_title as title, count(*) as n
          from request r
         where r.requested_at >= r.from_at and r.requested_at < r.to_at
         group by r.song_id, r.song_title
         order by count(*) desc, r.song_title
         limit 10
      ) t
  ),
  top_genres as (
    select jsonb_agg(jsonb_build_object('id', t.genre_id, 'label', t.name, 'count', t.n)
                     order by t.n desc, t.name) as rows
      from (
        select r.genre_id, g.name, count(*) as n
          from request r
          join public.music_genres g on g.id = r.genre_id and g.deleted_at is null
         where r.requested_at >= r.from_at and r.requested_at < r.to_at
         group by r.genre_id, g.name
         order by count(*) desc, g.name
         limit 10
      ) t
  ),
  -- Every value of the enum, whether or not it was requested, plus the rows
  -- whose song never had the attribute filled in. Built by LEFT JOINing the
  -- enum to the counts, so a value with no requests reports 0 instead of
  -- vanishing from the chart -- and by UNIONing an explicit null bucket, so
  -- the slices sum to the request total printed beside them. A chart whose
  -- parts do not sum to its whole is a chart that lies quietly. Both arms are
  -- scoped to the CURRENT window (r.requested_at against r.from_at/r.to_at),
  -- so the sum matches cards.requests.current, not an all-time total.
  nationality as (
    select jsonb_agg(jsonb_build_object('key', b.key, 'label', b.label, 'count', b.n)
                     order by b.sort, b.label) as rows
      from (
        select v::text as key, v::text as label, 0 as sort,
               count(r.id) as n
          from unnest(enum_range(null::public.music_nationality)) as v
          left join request r
            on r.nationality = v
           and r.requested_at >= r.from_at and r.requested_at < r.to_at
         group by v
        union all
        select 'NOT_STATED', 'Not stated', 1,
               count(r.id)
          from request r
         where r.nationality is null
           and r.requested_at >= r.from_at and r.requested_at < r.to_at
      ) b
  ),
  -- Identical shape over music_vocal, which has FIVE values -- MALE, FEMALE,
  -- DUO, GROUP, INSTRUMENTAL -- and not the two master spec §4.2 named.
  vocal as (
    select jsonb_agg(jsonb_build_object('key', b.key, 'label', b.label, 'count', b.n)
                     order by b.sort, b.label) as rows
      from (
        select v::text as key, v::text as label, 0 as sort,
               count(r.id) as n
          from unnest(enum_range(null::public.music_vocal)) as v
          left join request r
            on r.vocal = v
           and r.requested_at >= r.from_at and r.requested_at < r.to_at
         group by v
        union all
        select 'NOT_STATED', 'Not stated', 1,
               count(r.id)
          from request r
         where r.vocal is null
           and r.requested_at >= r.from_at and r.requested_at < r.to_at
      ) b
  )
  select jsonb_build_object(
    'period', (
      select jsonb_build_object(
        'preset', p_preset,
        'from', min(from_date), 'to', min(to_date),
        'previous_from', min(previous_from_date), 'previous_to', min(previous_to_date))
        from station),
    'stations', (
      select jsonb_agg(jsonb_build_object('id', id, 'name', name, 'timezone', timezone) order by name)
        from station),
    'cards', (
      select jsonb_build_object(
        'catalogue', jsonb_build_object('current', sc.catalogue_current, 'previous', sc.catalogue_previous),
        'new_songs', jsonb_build_object('current', sc.new_current,       'previous', sc.new_previous),
        'requests',  jsonb_build_object('current', rc.current,           'previous', rc.previous))
        from song_cards sc, request_cards rc),
    'monthly',    coalesce((select rows from monthly), '[]'::jsonb),
    'breakdowns', jsonb_build_object(
                    'nationality', coalesce((select rows from nationality), '[]'::jsonb),
                    'vocal',       coalesce((select rows from vocal), '[]'::jsonb)),
    'top',        jsonb_build_object(
                    'songs',  coalesce((select rows from top_songs), '[]'::jsonb),
                    'genres', coalesce((select rows from top_genres), '[]'::jsonb)),
    'withheld',   '[]'::jsonb
  ) into v_result;

  return v_result;
end;
$$;

comment on function public.get_music_dashboard(uuid[], text, date, date) is
  'The Music dashboard for one Station or a consolidated set, both windows in one call. Same contract and SECURITY INVOKER rationale as get_audience_dashboard (D4): 0099''s select policies on songs/music_requests/music_genres apply inside it. Refuses with 42501 unless the caller holds music.view in EVERY station named, and reports.consolidated in every one when more than one is named (D3). Reports two distinct totals, separately labelled, because master spec §4.2 never said which it meant: catalogue is a STOCK figure (songs that exist), measured as of each window''s end from songs.created_at, not as of now; requests is a FLOW figure (times a song was asked for) counted inside each window. The nationality and vocal breakdowns each carry every value of their enum -- vocal has FIVE (MALE, FEMALE, DUO, GROUP, INSTRUMENTAL), not the two §4.2 named -- plus an explicit "not stated" bucket for the nullable songs.nationality/songs.vocal, so the buckets always sum to cards.requests.current: a two-slice chart would silently drop duets, groups, instrumentals and unfilled songs, and its parts would stop summing to the whole printed beside it. Soft-deleted songs and requests (deleted_at) are excluded throughout. withheld is always empty here (D13): every table this reads is gated by music.view, this panel''s own gate, so no figure on it can be withheld by a MORE specific permission the way took_part is on the audience panel -- the key is still present so all three dashboard payloads share one shape and one Zod schema.';

grant execute on function public.get_music_dashboard(uuid[], text, date, date) to authenticated;
