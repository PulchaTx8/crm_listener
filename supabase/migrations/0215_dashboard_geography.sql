-- supabase/migrations/0215_dashboard_geography.sql

-- Block 28. Where a Station's listeners are, and where its most-requested songs
-- are asked for.
--
-- BOTH ARE SECURITY INVOKER, like the three dashboard aggregates before them
-- (0118, 0119) and unlike most of this schema. It is deliberate and it is what
-- makes the join below safe: the caller's own RLS still cuts the members they
-- may read, so this function cannot widen anybody's reach even if its own guard
-- were wrong. A SECURITY DEFINER version would move the tenancy boundary from a
-- policy into a function body, which is the direction this project has spent
-- several blocks moving away from.
--
-- The permission loop is COPIED from get_audience_dashboard rather than
-- re-derived, down to the two error messages: a second wording for the same
-- refusal is a second thing to keep in step, and the e2e suite matches on the
-- sentence.

-- ---------------------------------------------------------------------------
-- Where the listeners are.
--
-- IT COUNTS THE LISTENERS CARD'S POPULATION, and that is the whole of design
-- D11. `link` below is 0118's own CTE — member_company_links joined to members
-- with deleted_at and anonymized_at excluded and `linked_at < to_at` — copied
-- rather than rewritten, so `total` here IS `listeners` there for the same
-- window. Block 8a's D12b made "every figure on this panel counts the same
-- people" a rule, and a map counting a flow beside a card counting a stock is
-- the exact failure it exists to prevent. tests/isolation/geography.test.ts
-- asserts the two are equal, which is what would fail the moment somebody
-- "improves" one of the counts.
-- ---------------------------------------------------------------------------

create function public.get_audience_geography(
  p_company_ids uuid[],
  p_preset      text default 'current_month',
  p_from        date default null,
  p_to          date default null
)
returns jsonb
language plpgsql
stable
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

  select array_agg(distinct s) into v_ids from unnest(p_company_ids) as t(s);
  v_consolidated := cardinality(v_ids) > 1;

  foreach v_id in array v_ids loop
    if not public.has_permission('members.view', v_id) then
      raise exception 'members.view is required in every station requested'
        using errcode = '42501';
    end if;
    if v_consolidated and not public.has_permission('reports.consolidated', v_id) then
      raise exception 'reports.consolidated is required in every station of a consolidated view'
        using errcode = '42501';
    end if;
  end loop;

  with station as (
    select c.id, c.organization_id, c.name, c.timezone, c.country, p.*
      from public.companies c
      cross join lateral public.resolve_dashboard_period(p_preset, p_from, p_to, c.timezone) p
     where c.id = any(v_ids)
  ),
  link as (
    select
      l.member_id,
      -- THE LISTENER'S OWN COUNTRY, FALLING BACK TO THEIR STATION'S. Design
      -- D10: a listener who never declared one is where their Station is, and
      -- the diaspora case is the exception that made the column exist.
      -- enqueue_missing_places (0214) coalesces exactly the same way, which is
      -- what makes the key it queued the key this groups by.
      public.member_place_key(coalesce(m.country, s.country), m.state, m.city, m.neighbourhood)
        as place_key,
      m.city,
      m.neighbourhood
      from public.member_company_links l
      join station s on s.id = l.company_id
      join public.members m
        on m.id = l.member_id and m.deleted_at is null and m.anonymized_at is null
     where l.linked_at < s.to_at
  ),
  -- DISTINCT MEMBER FIRST, before anything is counted. A listener linked to two
  -- of the Stations in a consolidated view appears twice in `link`, and without
  -- this they would be two dots — or one dot counted twice — which is the same
  -- double-count 0118's own `count(distinct member_id)` exists to avoid. The
  -- place is taken with the member because it is a property of the member, not
  -- of the link.
  member_place as (
    select distinct member_id, place_key, city, neighbourhood from link
  ),
  resolved as (
    select
      mp.member_id,
      mp.place_key,
      -- The names from the CACHE, not from the listener's own columns: two
      -- listeners who wrote "sao luis" and "São Luís" share a key and must
      -- share a label, or the same dot renders under two spellings.
      g.city          as place_city,
      g.neighbourhood as place_neighbourhood,
      g.latitude,
      g.longitude,
      g.precision
      from member_place mp
      join public.geocoded_places g
        on g.place_key = mp.place_key and g.resolved_at is not null
  ),
  places as (
    select jsonb_agg(row_to_json(t)::jsonb order by t.count desc, t.key) as rows
      from (
        select
          r.place_key                as key,
          r.place_city               as city,
          r.place_neighbourhood      as neighbourhood,
          r.latitude::float8         as latitude,
          r.longitude::float8        as longitude,
          r.precision                as precision,
          count(*)::int              as count
          from resolved r
         group by r.place_key, r.place_city, r.place_neighbourhood,
                  r.latitude, r.longitude, r.precision
      ) t
  )
  select jsonb_build_object(
    'places',     coalesce((select rows from places), '[]'::jsonb),
    -- The coverage line's two numbers. `with_place` is how many of the
    -- listeners counted by the Listeners card have a coordinate, and `total`
    -- is that card's own figure — so a panel can say "412 of 1,208 listeners
    -- are on this map" rather than showing 412 dots and implying that is
    -- everybody.
    'with_place', (select count(*)::int from resolved),
    'total',      (select count(*)::int from member_place)
  ) into v_result;

  return v_result;
end;
$$;

comment on function public.get_audience_geography(uuid[], text, date, date) is
  'Where a Station''s listeners are, as one payload: the places with a coordinate, how many listeners those cover, and the total the Listeners card counts. SECURITY INVOKER — the caller''s own RLS cuts the members, and the loop above re-checks members.view per Station and reports.consolidated for every id when more than one is named. `total` IS get_audience_dashboard''s listeners figure for the same window, by construction: the link CTE is copied from 0118 rather than rewritten, because Block 8a''s D12b makes "every figure on this panel counts the same people" a rule and a map counting a different population from the card beside it is the failure that rule exists to prevent.';

-- ---------------------------------------------------------------------------
-- Where the music is asked for.
--
-- A DIFFERENT POPULATION FROM THE ONE ABOVE, on purpose: this counts REQUESTS
-- in the window, not listeners as of its end. The Music panel's own cards count
-- requests, so this matches the card beside IT — which is the same D12b rule
-- applied to a different page, not an inconsistency with the audience map.
-- ---------------------------------------------------------------------------

create function public.get_music_geography(
  p_company_ids uuid[],
  p_preset      text default 'current_month',
  p_from        date default null,
  p_to          date default null
)
returns jsonb
language plpgsql
stable
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
    select c.id, c.organization_id, c.name, c.timezone, c.country, p.*
      from public.companies c
      cross join lateral public.resolve_dashboard_period(p_preset, p_from, p_to, c.timezone) p
     where c.id = any(v_ids)
  ),
  request as (
    select
      r.id,
      r.song_id,
      sg.title as song_title,
      public.member_place_key(coalesce(m.country, s.country), m.state, m.city, m.neighbourhood)
        as place_key
      from public.music_requests r
      join station s on s.id = r.company_id
      -- An anonymous request — one with no listener behind it — has no place
      -- and is counted in `total` but never on the map, which is what the
      -- coverage line is for.
      left join public.members m
        on m.id = r.member_id and m.deleted_at is null and m.anonymized_at is null
      join public.songs sg on sg.id = r.song_id
     where r.deleted_at is null
       and r.requested_at >= s.from_at
       and r.requested_at <  s.to_at
  ),
  resolved as (
    select r.*, g.city as place_city, g.neighbourhood as place_neighbourhood,
           g.latitude, g.longitude, g.precision
      from request r
      join public.geocoded_places g
        on g.place_key = r.place_key and g.resolved_at is not null
  ),
  -- The most-requested song IN EACH PLACE, which is the whole point of this map
  -- as opposed to the audience one: a Station learns that a neighbourhood asks
  -- for something its other neighbourhoods do not.
  top_song as (
    select distinct on (place_key)
           place_key, song_id, song_title, count(*)::int as n
      from resolved
     group by place_key, song_id, song_title
     -- Ties broken by title so the answer is stable between two loads of the
     -- same data. Without it `distinct on` picks whichever row the plan
     -- happened to produce first, and a panel that changes on refresh reads as
     -- a bug.
     order by place_key, count(*) desc, song_title
  ),
  places as (
    select jsonb_agg(row_to_json(t)::jsonb order by t.count desc, t.key) as rows
      from (
        select
          r.place_key           as key,
          r.place_city          as city,
          r.place_neighbourhood as neighbourhood,
          r.latitude::float8    as latitude,
          r.longitude::float8   as longitude,
          r.precision           as precision,
          count(*)::int         as count,
          ts.song_title         as top_song,
          ts.n                  as top_song_count
          from resolved r
          left join top_song ts on ts.place_key = r.place_key
         group by r.place_key, r.place_city, r.place_neighbourhood,
                  r.latitude, r.longitude, r.precision, ts.song_title, ts.n
      ) t
  )
  select jsonb_build_object(
    'places',     coalesce((select rows from places), '[]'::jsonb),
    'with_place', (select count(*)::int from resolved),
    'total',      (select count(*)::int from request)
  ) into v_result;

  return v_result;
end;
$$;

comment on function public.get_music_geography(uuid[], text, date, date) is
  'Where a Station''s song requests come from, with the most-requested song in each place. SECURITY INVOKER, gated on music.view per Station and on reports.consolidated for every id when more than one is named — the same loop get_music_dashboard runs, copied rather than reworded. It counts REQUESTS in the window rather than listeners at its end, matching the cards on its own panel: the audience map counts a different population because the cards beside THAT one do.';

revoke execute on function public.get_audience_geography(uuid[], text, date, date) from public;
grant execute on function public.get_audience_geography(uuid[], text, date, date) to authenticated;
revoke execute on function public.get_music_geography(uuid[], text, date, date) from public;
grant execute on function public.get_music_geography(uuid[], text, date, date) to authenticated;

-- ---------------------------------------------------------------------------
-- The two key helpers become callable by a signed-in caller.
--
-- 0214 granted them to nobody, on the rule this schema follows everywhere: a
-- helper is called from inside a SECURITY DEFINER body and needs no ACL of its
-- own. THAT RULE DOES NOT REACH HERE, because the two functions above are
-- SECURITY INVOKER — deliberately, so the caller's own RLS cuts the members
-- they may count — and a SECURITY INVOKER body runs every call it makes as the
-- caller too. Without these grants both aggregates raise
-- `permission denied for function member_place_key` for every authenticated
-- caller, which is what happened the first time this suite ran.
--
-- Safe to grant: both are IMMUTABLE pure text transforms. They read no table,
-- take no lock, and answer the same string for the same input to anybody —
-- there is nothing to learn from calling one that the caller did not already
-- type in.
-- ---------------------------------------------------------------------------

grant execute on function public.place_fold(text) to authenticated;
grant execute on function public.member_place_key(text, text, text, text) to authenticated;
