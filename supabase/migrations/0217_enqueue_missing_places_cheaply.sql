-- supabase/migrations/0217_enqueue_missing_places_cheaply.sql

-- Block 28. The place sweep stops reading the whole audience every ten seconds.
--
-- 0214's version was measured after the fact and does THREE SEQUENTIAL SCANS —
-- member_company_links, members and companies — on every single tick, whether or
-- not there is anything new to enqueue. On the local stack that is 2ms and
-- invisible. On a platform with a real audience it is a full scan of every
-- listener and every link, six times a minute, forever, to discover nothing.
--
-- TWO THINGS CAUSED IT, and both are fixed here.
--
-- The `distinct` did. A LIMIT cannot short-circuit a scan whose rows must all be
-- collected before they can be deduplicated, so the bound this function appeared
-- to have never applied to the READ — only to the write. It is gone: `on
-- conflict (place_key) do nothing` already dedupes, and unlike DO UPDATE it is
-- safe when one statement carries the same key twice, which is precisely the
-- case the distinct was there for.
--
-- And nothing excluded places already known. Every listener in the platform was
-- re-derived into a key and offered to the insert, for the insert to discard.
-- The `not exists` below turns that into an index probe against
-- geocoded_places_key_unique, so a place that has a row never reaches the insert
-- and never counts against p_limit — which is what makes the limit mean "this
-- many NEW places" rather than "this many rows looked at".
--
-- The partial index is what makes the steady state cheap: a listener with no
-- city can never produce a place, and in a real audience most of them have none.

create index members_place_sweep_idx
  on public.members (id)
  where deleted_at is null
    and anonymized_at is null
    and city is not null;

comment on index public.members_place_sweep_idx is
  'Narrows enqueue_missing_places (0217) to the listeners that could produce a place at all. Partial on the three conditions that function filters by, because in a real audience most listeners carry no city and scanning them to prove it is the cost this index removes.';

create or replace function public.enqueue_missing_places(p_limit integer default 100)
returns integer
language sql
security definer
set search_path = pg_catalog, public
as $$
  with candidates as (
    select
      public.member_place_key(
        coalesce(m.country, c.country), m.state, m.city, m.neighbourhood) as place_key,
      coalesce(m.country, c.country) as country,
      m.state, m.city, m.neighbourhood
    from public.members m
    join public.member_company_links l on l.member_id = m.id
    join public.companies c on c.id = l.company_id
    where m.deleted_at is null
      and m.anonymized_at is null
      -- A listener with no city has no place worth a request: the neighbourhood
      -- alone cannot be geocoded and the country alone is not worth a dot.
      and nullif(btrim(coalesce(m.city, '')), '') is not null
      -- THE ANTI-JOIN. Without it every known place is re-derived and re-offered
      -- on every tick for the insert to throw away, and the limit below bounds
      -- the writing rather than the reading.
      and not exists (
        select 1 from public.geocoded_places g
         where g.place_key = public.member_place_key(
                 coalesce(m.country, c.country), m.state, m.city, m.neighbourhood)
      )
    -- Now that nothing has to be collected before it can be deduplicated, this
    -- bound reaches the scan: the read stops as soon as p_limit new places have
    -- been found.
    limit greatest(1, least(coalesce(p_limit, 100), 1000))
  ),
  inserted as (
    insert into public.geocoded_places (place_key, country, state, city, neighbourhood)
    select place_key, country, state, city, neighbourhood
    from candidates
    where place_key <> ''
    -- DO NOTHING and not DO UPDATE, and the difference is load-bearing now that
    -- the distinct is gone: DO NOTHING tolerates the same key appearing twice in
    -- one statement, which two listeners in one neighbourhood produce every
    -- time. DO UPDATE raises "cannot affect row a second time" for exactly that.
    on conflict (place_key) do nothing
    returning 1
  )
  -- The COUNT, where 0214 returned a bare `1` — that answered "1" for any
  -- non-empty insert and null for an empty one, which reads like a count and is
  -- not one. The drain logs this number.
  select count(*)::integer from inserted;
$$;

revoke execute on function public.enqueue_missing_places(integer) from public;
grant execute on function public.enqueue_missing_places(integer) to service_role;

comment on function public.enqueue_missing_places(integer) is
  'Registers every distinct place this platform''s live listeners live in that has no row yet, and answers how many it added. A LISTENER INHERITS THEIR STATION''S COUNTRY when they declared none (design D10), which is why this joins companies rather than reading members.country alone — the same coalesce 0215''s aggregates make, so the two produce the same keys. Bounded at 1000 whatever the caller asks for, and the bound reaches the READ since 0217: places already in the cache are excluded by an anti-join rather than re-derived and discarded by the insert. Safe on every tick. service_role only.';
