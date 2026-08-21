-- supabase/migrations/0270_promotions_geography.sql

-- Block 30e, item 19. Where a Station's entries come from.
--
-- SECURITY INVOKER, like the four aggregates before it (0118, 0119, 0120, 0215):
-- the caller's own RLS still cuts every participation and every member this
-- reads, so the function cannot widen anybody's reach even if its own guard were
-- wrong. A SECURITY DEFINER version would move the tenancy boundary from a policy
-- into a function body, which is the direction this project has spent several
-- blocks moving away from.
--
-- IT COUNTS THE PARTICIPATIONS CARD'S POPULATION, and that is the whole of design
-- D11: every entry in the window, OF EVERY STATUS, exactly as
-- get_promotions_dashboard (0120) counts for the card rendered above this map.
-- Counting only VALID here would put a number under the map that no card on the
-- panel agrees with, while the coverage line compared two populations and looked
-- like one -- the failure Block 8a's D12b exists to prevent.
--
-- TWO PERMISSIONS WITHHOLD AND NEITHER REFUSES. The panel's own gate is
-- promotions.view, and that one does refuse. participations.view decides whether
-- the entries may be counted at all (0053), and members.view decides whether the
-- listeners behind them may be read (0035) -- and because this function is
-- SECURITY INVOKER, a caller lacking the second would get every place cut by
-- their own RLS and an EMPTY MAP under a coverage line still naming a total. An
-- empty map claims the Station has no geography, which is a different and false
-- claim. So the payload names whichever permission is missing and the panel says
-- which, the way 0120's own `withheld` array already does for five figures.

create function public.get_promotions_geography(
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
  v_missing      text := null;
  v_result       jsonb;
begin
  if p_company_ids is null or cardinality(p_company_ids) = 0 then
    raise exception 'at least one station is required' using errcode = '22023';
  end if;

  -- Deduplicated before anything counts, so naming a Station twice cannot double
  -- its rows.
  select array_agg(distinct s) into v_ids from unnest(p_company_ids) as t(s);
  v_consolidated := cardinality(v_ids) > 1;

  -- The loop is COPIED from get_promotions_dashboard rather than re-derived, down
  -- to the two error messages: a second wording for the same refusal is a second
  -- thing to keep in step, and the e2e suite matches on the sentence.
  foreach v_id in array v_ids loop
    if not public.has_permission('promotions.view', v_id) then
      raise exception 'promotions.view is required in every station requested'
        using errcode = '42501';
    end if;
    if v_consolidated and not public.has_permission('reports.consolidated', v_id) then
      raise exception 'reports.consolidated is required in every station of a consolidated view'
        using errcode = '42501';
    end if;
    -- participations.view is named first when both are missing: it is the one
    -- the panel beside this map already withholds five figures for, so naming it
    -- keeps one screen telling one story.
    if not public.has_permission('participations.view', v_id) then
      v_missing := 'participations.view';
    elsif v_missing is null and not public.has_permission('members.view', v_id) then
      v_missing := 'members.view';
    end if;
  end loop;

  if v_missing is not null then
    return jsonb_build_object(
      'places',     '[]'::jsonb,
      'with_place', 0,
      'total',      0,
      'withheld',   jsonb_build_array(
                      jsonb_build_object('figure', 'places', 'needs', v_missing)));
  end if;

  with station as (
    select c.id, c.organization_id, c.name, c.timezone, c.country, p.*
      from public.companies c
      cross join lateral public.resolve_dashboard_period(p_preset, p_from, p_to, c.timezone) p
     where c.id = any(v_ids)
  ),
  -- The card's own predicate, copied rather than rewritten (D11): every status,
  -- and the window half-open at its end the way 0120 reads it. No deleted_at
  -- test, because a participation has neither (0052) -- it is a thing that
  -- happened.
  entry as (
    select p.id, p.member_id, p.promotion_id, s.country
      from public.participations p
      join station s on s.id = p.company_id
     where p.participated_at >= s.from_at
       and p.participated_at <  s.to_at
  ),
  -- The listener behind each entry, and the place that listener resolves to.
  -- `member_place_key` is called with exactly the arguments enqueue_missing_places
  -- (0214) uses, which is what makes the key here the key that was geocoded.
  --
  -- An INNER join, deliberately: an entry whose listener has since been deleted
  -- or anonymised has no place to draw, and it stays in `total` below because
  -- `total` is taken from `entry` rather than from here.
  placed as (
    select e.id, e.promotion_id,
           public.member_place_key(coalesce(m.country, e.country), m.state, m.city, m.neighbourhood)
             as place_key
      from entry e
      join public.members m
        on m.id = e.member_id and m.deleted_at is null and m.anonymized_at is null
  ),
  resolved as (
    select pl.id, pl.promotion_id, pl.place_key,
           -- The names from the CACHE, not from the listener's own columns: two
           -- listeners who wrote "sao luis" and "São Luís" share a key and must
           -- share a label, or one dot renders under two spellings.
           g.city          as place_city,
           g.neighbourhood as place_neighbourhood,
           g.latitude,
           g.longitude,
           g.precision
      from placed pl
      join public.geocoded_places g
        on g.place_key = pl.place_key and g.resolved_at is not null
  ),
  -- The promotion most played IN EACH PLACE, which is what makes this map worth
  -- more than a count: a Station learns that a neighbourhood plays something its
  -- other neighbourhoods do not. Ties broken by name so two loads of the same
  -- data name the same promotion -- without it `distinct on` picks whichever row
  -- the plan produced first, and a panel that changes on refresh reads as a bug.
  top_promotion as (
    select distinct on (r.place_key)
           r.place_key, pr.name as promotion_name, count(*)::int as n
      from resolved r
      join public.promotions pr on pr.id = r.promotion_id
     group by r.place_key, pr.name
     order by r.place_key, count(*) desc, pr.name
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
          tp.promotion_name     as top_promotion,
          tp.n                  as top_promotion_count
          from resolved r
          left join top_promotion tp on tp.place_key = r.place_key
         group by r.place_key, r.place_city, r.place_neighbourhood,
                  r.latitude, r.longitude, r.precision, tp.promotion_name, tp.n
      ) t
  )
  select jsonb_build_object(
    'places',     coalesce((select rows from places), '[]'::jsonb),
    -- `with_place` counts the entries that reached a coordinate; `total` counts
    -- the entries the card counts, taken from `entry` -- BEFORE the join to
    -- members -- precisely so an entry whose listener was deleted or anonymised
    -- still counts in the total. Taking it from `placed` would make this map's
    -- own denominator smaller than the card's number, which is the disagreement
    -- D11 forbids.
    'with_place', (select count(*)::int from resolved),
    'total',      (select count(*)::int from entry),
    'withheld',   '[]'::jsonb
  ) into v_result;

  return v_result;
end;
$$;

comment on function public.get_promotions_geography(uuid[], text, date, date) is
  'Block 30e, item 19. Where a Station''s entries come from, as one payload: the places with a coordinate, how many entries those cover, the promotion most played in each, and the total the participations card counts. SECURITY INVOKER -- the caller''s own RLS cuts every row, and the loop re-checks promotions.view per Station and reports.consolidated when more than one is named. `total` IS get_promotions_dashboard''s participations figure for the same window: every status, and counted before the join to members, because Block 8a''s D12b makes "every figure on this panel counts the same people" a rule and a map counting a different population from the card beside it is the failure that rule exists to prevent. promotions.view refuses; participations.view and members.view WITHHOLD, naming which is missing, because an empty map would claim the Station has no geography rather than say the caller may not see it.';

revoke execute on function public.get_promotions_geography(uuid[], text, date, date) from public;
grant execute on function public.get_promotions_geography(uuid[], text, date, date) to authenticated;
