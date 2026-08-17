-- supabase/migrations/0214_geocoded_places.sql

-- Block 28. One coordinate per distinct PLACE, for the whole platform.
--
-- NOT per listener and NOT per Station, and that is the point: ten thousand
-- listeners in São Luís are one geocoding request, once, ever. A per-listener
-- column would be ten thousand requests, a bill, and ten thousand rows to
-- re-request the day somebody corrects a spelling.
--
-- The key is computed by src/lib/places/normalise.ts and by 0215's two
-- aggregates, which must produce the SAME string — see place_key's own comment.

create table public.geocoded_places (
  id             uuid primary key default gen_random_uuid(),
  place_key      text not null,
  -- The parts as they were when the key was built, kept for reading rather than
  -- for matching: nothing joins on these. A person looking at why a dot is in
  -- the wrong place needs to see what was asked, and the key is folded past
  -- recognition by design.
  country        text,
  state          text,
  city           text,
  neighbourhood  text,
  latitude       numeric,
  longitude      numeric,
  precision      text,
  provider       text not null default 'google',
  queued_at      timestamptz not null default now(),
  resolved_at    timestamptz,
  failed_at      timestamptz,
  failure_reason text,
  attempts       integer not null default 0,
  constraint geocoded_places_key_not_blank check (btrim(place_key) <> ''),
  -- Both or neither, the same pairing companies.latitude/longitude carries
  -- (0155) and for the same reason: half a coordinate is not a place, and a
  -- caller that reads one and not the other puts a dot on the prime meridian.
  constraint geocoded_places_coordinate_pair
    check ((latitude is null) = (longitude is null)),
  constraint geocoded_places_precision_known
    check (precision is null or precision in ('neighbourhood', 'city', 'region', 'country'))
);

-- THE CACHE IS THE UNIQUENESS. Without this a second tick claiming the same
-- place, or two Stations whose listeners share a city, would each insert a row
-- and each pay for a lookup.
create unique index geocoded_places_key_unique on public.geocoded_places (place_key);

comment on table public.geocoded_places is
  'One coordinate per distinct place, shared by the whole platform (Block 28). Global rather than per-Station on purpose: a place is a fact about the world, not about a tenant, and two Stations in the same city must not each pay to geocode it. Rows are created unresolved by whatever first needs the place and filled in by the worker''s drain; resolved_at and failed_at are how the queue is read.';

comment on column public.geocoded_places.place_key is
  'The folded, labelled key src/lib/places/normalise.ts builds — "c:br|s:ma|t:sao luis|n:cohab". THE SEGMENTS ARE LABELLED so that {BR, MA, no city} and {BR, no state, city called MA} cannot collide, which plain positional joining allows. Two writers compute this string: the TypeScript normaliser and 0215''s aggregates. If they ever disagree, every listener looks unresolved and the map is empty with no error anywhere — which is why the aggregates build it with the same expression rather than a similar one.';

comment on column public.geocoded_places.failed_at is
  'When the provider last said it could not place this. NOT the same as an error: ZERO_RESULTS means the place is real and Google does not know it, which is a fact worth recording once rather than a reason to retry forever. A quota refusal never reaches this column — the drain stops the batch instead, leaving the row unclaimed (src/lib/integrations/google/transport.ts).';

-- ---------------------------------------------------------------------------
-- RLS.
--
-- `using (true)` for authenticated, and this is the one table in this schema
-- where that is right rather than an oversight. It holds place names and
-- coordinates: no tenant column, no personal data, nothing that says WHO is
-- there. "Cohab, São Luís is at -2.53, -44.31" is a fact about a map.
--
-- The alternative was a SECURITY DEFINER read, and it was rejected because it
-- would hide the join 0215's two aggregates have to make: both are SECURITY
-- INVOKER, deliberately, so that the caller's own RLS still cuts the members
-- they may count — and a definer-only place table would force them to be
-- definer too, which would put the tenancy boundary inside a function body
-- instead of in a policy.
-- ---------------------------------------------------------------------------

alter table public.geocoded_places enable row level security;
revoke all on public.geocoded_places from anon, authenticated;
grant select on public.geocoded_places to authenticated;

create policy geocoded_places_select_any on public.geocoded_places
  for select to authenticated
  using (true);

comment on policy geocoded_places_select_any on public.geocoded_places is
  'Every signed-in caller may read every place. Deliberate: this table carries no company_id, no member_id and no personal data — only place names and their coordinates. The rows it holds are derived from listeners'' addresses, so the PLACES a Station''s listeners live in are inferable from it in aggregate; what is not inferable is who, how many, or which Station, and those are what 0215''s aggregates gate on reports.consolidated and members.view.';

-- ---------------------------------------------------------------------------
-- The queue doors. service_role only: the worker is the only caller, there is
-- no user to check, and nothing on any screen writes here.
-- ---------------------------------------------------------------------------

create function public.enqueue_place(
  p_place_key     text,
  p_country       text,
  p_state         text,
  p_city          text,
  p_neighbourhood text
)
returns uuid
language sql
security definer
set search_path = pg_catalog, public
as $$
  insert into public.geocoded_places (place_key, country, state, city, neighbourhood)
  values (p_place_key, p_country, p_state, p_city, p_neighbourhood)
  -- DO UPDATE rather than DO NOTHING, and only so that RETURNING has a row:
  -- DO NOTHING returns nothing on a conflict, which would make this function
  -- answer null for a place that exists. The update is a no-op write of the
  -- column to itself.
  on conflict (place_key) do update set place_key = excluded.place_key
  returning id;
$$;

revoke execute on function public.enqueue_place(text, text, text, text, text) from public;
grant execute on function public.enqueue_place(text, text, text, text, text) to service_role;

comment on function public.enqueue_place(text, text, text, text, text) is
  'Registers a place as needing a coordinate, or answers the id of the one already registered. Idempotent by place_key. service_role only.';

create function public.claim_places_to_geocode(p_limit integer default 25)
returns setof public.geocoded_places
language sql
security definer
set search_path = pg_catalog, public
as $$
  update public.geocoded_places p
     set attempts = p.attempts + 1
   where p.id in (
     select c.id from public.geocoded_places c
      where c.resolved_at is null
        -- A place that failed is retried, but not soon: ZERO_RESULTS today is
        -- ZERO_RESULTS tomorrow, and the row only becomes resolvable if
        -- somebody corrects the spelling behind it. A week is long enough that
        -- retrying costs nothing and short enough that a correction lands.
        and (c.failed_at is null or c.failed_at < now() - interval '7 days')
      order by c.queued_at
      -- SKIP LOCKED, so two ticks running at once claim disjoint batches
      -- rather than one waiting on the other or — far worse — both geocoding
      -- the same place and paying twice. claim_report_run (0161) and
      -- claim_outbox_batch take the same lock for the same reason.
      for update skip locked
      limit greatest(1, least(coalesce(p_limit, 25), 200))
   )
  returning p.*;
$$;

revoke execute on function public.claim_places_to_geocode(integer) from public;
grant execute on function public.claim_places_to_geocode(integer) to service_role;

comment on function public.claim_places_to_geocode(integer) is
  'The next places needing a coordinate, claimed for one worker. Bounded at 200 whatever the caller asks for, and at least 1: this is a paid API and an unbounded batch is an unbounded bill. Increments attempts as it claims, so a place that keeps failing is visible without a second write.';

-- All four value parameters are DEFAULTED, and not for the caller's
-- convenience: Postgres's function metadata carries no nullability signal
-- beyond "has a default", so supabase-js's generated Args type gives a
-- parameter without one the type `number` with no `| null` in the union. A
-- failure — which is exactly the case that passes no coordinate — would then be
-- unrepresentable in TypeScript. Omitting the key applies the default, which is
-- null, which is the state this function exists to record.
create function public.record_place_geocode(
  p_id             uuid,
  p_latitude       numeric default null,
  p_longitude      numeric default null,
  p_precision      text default null,
  p_failure_reason text default null
)
returns void
language sql
security definer
set search_path = pg_catalog, public
as $$
  update public.geocoded_places
     set latitude       = p_latitude,
         longitude      = p_longitude,
         precision      = p_precision,
         -- Exactly one of the two is stamped, decided by whether a coordinate
         -- arrived. Writing both, or neither, would leave the row in a state
         -- claim_places_to_geocode reads as still queued and the aggregates
         -- read as resolved.
         resolved_at    = case when p_latitude is not null then now() end,
         failed_at      = case when p_latitude is null then now() end,
         failure_reason = p_failure_reason
   where id = p_id;
$$;

revoke execute on function public.record_place_geocode(uuid, numeric, numeric, text, text) from public;
grant execute on function public.record_place_geocode(uuid, numeric, numeric, text, text) to service_role;

comment on function public.record_place_geocode(uuid, numeric, numeric, text, text) is
  'Writes one place''s verdict: a coordinate, or a failure. Never both — resolved_at and failed_at are stamped from the same condition so the row cannot be in two states at once.';

-- ---------------------------------------------------------------------------
-- The key, in SQL.
--
-- THIS FUNCTION AND src/lib/places/normalise.ts MUST PRODUCE THE SAME STRING,
-- and nothing in either language can check that — one is TypeScript and the
-- other is SQL. So both are pinned to the same literal:
-- tests/unit/place-normalise.test.ts and 61_places.test.sql each assert that
-- {BR, MA, São Luís, Cohab} folds to 'c:br|s:ma|t:sao luis|n:cohab'. If the two
-- ever drift, every listener looks unresolved, the map renders empty, and there
-- is no error anywhere to explain it — which is why the check is a literal in
-- two files rather than a comment asking people to be careful.
--
-- `unaccent` is NOT used and cannot be: 0001 installs pgcrypto only (0137
-- records the ruling). The fold is an explicit translate() over the letters
-- Brazilian, Portuguese and Spanish place names actually use.
-- ---------------------------------------------------------------------------

create function public.place_fold(p_value text)
returns text
language sql
immutable
set search_path = pg_catalog, public
as $$
  select coalesce(
    nullif(
      btrim(regexp_replace(
        translate(lower(coalesce(p_value, '')),
                  'áàâãäéèêëíìîïóòôõöúùûüçñýÿ',
                  'aaaaaeeeeiiiiooooouuuucnyy'),
        '\s+', ' ', 'g')),
      ''),
    '');
$$;

revoke execute on function public.place_fold(text) from public;

comment on function public.place_fold(text) is
  'Lower case, accents stripped, whitespace collapsed — the SQL half of src/lib/places/normalise.ts''s fold(). IMMUTABLE so it can sit in an index expression if a Station ever grows big enough to need one.';

create function public.member_place_key(
  p_country       text,
  p_state         text,
  p_city          text,
  p_neighbourhood text
)
returns text
language sql
immutable
set search_path = pg_catalog, public
as $$
  select array_to_string(
    array_remove(array[
      case when public.place_fold(p_country) <> '' then 'c:' || public.place_fold(p_country) end,
      case when public.place_fold(p_state)   <> '' then 's:' || public.place_fold(p_state)   end,
      case when public.place_fold(p_city)    <> '' then 't:' || public.place_fold(p_city)    end,
      -- The same leading-noise list normalise.ts carries, and `vila` is
      -- deliberately absent from both: "Vila Nova" is a name, and stripping it
      -- would merge every Vila X with every X.
      case when public.place_fold(
             regexp_replace(coalesce(p_neighbourhood, ''),
                            '^\s*(bairro\s+(do|da|de)\s+|bairro\s+|barrio\s+(del|de)\s+|barrio\s+)',
                            '', 'i')) <> ''
        then 'n:' || public.place_fold(
               regexp_replace(coalesce(p_neighbourhood, ''),
                              '^\s*(bairro\s+(do|da|de)\s+|bairro\s+|barrio\s+(del|de)\s+|barrio\s+)',
                              '', 'i'))
      end
    ], null),
    '|');
$$;

revoke execute on function public.member_place_key(text, text, text, text) from public;

comment on function public.member_place_key(text, text, text, text) is
  'One listener''s place, as the key geocoded_places.place_key stores. The SQL twin of normalisePlaceKey (src/lib/places/normalise.ts): SEGMENTS ARE LABELLED so a state and a city of the same name cannot collide, and an absent part is omitted rather than left as an empty slot. Empty string when there is no place at all, which is the signal a caller filters on.';

-- ---------------------------------------------------------------------------
-- What puts rows in the queue.
--
-- A SWEEP RATHER THAN A TRIGGER on members, and the choice is deliberate. A
-- trigger would fire on every listener write — including the bulk import paths
-- Block 9 will bring — to compute a key that is usually already queued, and it
-- would put a geocoding concern inside the transaction that registers a
-- listener. This runs on the worker's own tick, sees the whole table at once,
-- and cannot slow down a save.
-- ---------------------------------------------------------------------------

create function public.enqueue_missing_places(p_limit integer default 100)
returns integer
language sql
security definer
set search_path = pg_catalog, public
as $$
  with candidates as (
    select distinct
      public.member_place_key(
        coalesce(m.country, c.country), m.state, m.city, m.neighbourhood) as place_key,
      coalesce(m.country, c.country) as country,
      m.state, m.city, m.neighbourhood
    from public.members m
    join public.member_company_links l on l.member_id = m.id
    join public.companies c on c.id = l.company_id
    where m.deleted_at is null
      and m.anonymized_at is null
      -- A listener with no city has no place worth a request. The
      -- neighbourhood alone is not enough to geocode and the country alone is
      -- not worth a dot.
      and nullif(btrim(coalesce(m.city, '')), '') is not null
    limit greatest(1, least(coalesce(p_limit, 100), 1000))
  )
  insert into public.geocoded_places (place_key, country, state, city, neighbourhood)
  select place_key, country, state, city, neighbourhood
  from candidates
  where place_key <> ''
  on conflict (place_key) do nothing
  returning 1;
$$;

revoke execute on function public.enqueue_missing_places(integer) from public;
grant execute on function public.enqueue_missing_places(integer) to service_role;

comment on function public.enqueue_missing_places(integer) is
  'Registers every distinct place this platform''s live listeners live in that has no row yet. A LISTENER INHERITS THEIR STATION''S COUNTRY when they declared none (design D10), which is why this joins companies rather than reading members.country alone — the same coalesce 0215''s aggregates make, so the two produce the same keys. ON CONFLICT DO NOTHING, so it is safe on every tick. service_role only.';
