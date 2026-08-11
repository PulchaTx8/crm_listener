-- supabase/migrations/0175_shows_schedule.sql

-- Block 18. A programme stops being a name and becomes a record: a presenter, a
-- producer, a kind, an age rating, a picture, a weekly schedule and a run of
-- dates.
--
-- Design: docs/superpowers/specs/2026-08-11-block-18-shows-design.md

alter table public.shows
  add column kind             public.show_kind,
  add column age_rating       public.show_age_rating,
  add column presenter_name   text,
  add column producer_name    text,
  add column thumb_url        text,
  add column starts_on        date,
  add column ends_on          date;

-- ---------------------------------------------------------------------------
-- NOTHING ABOVE IS `not null`, AND THAT IS D3 RATHER THAN LAXITY.
--
-- Production already holds four programmes carrying nothing but a name -- Manhã
-- Total, Tarde Animada, Vozes do Brasil, Madrugada Pulchá. A NOT NULL column
-- would have to invent a kind for each of them, and invented data in a field
-- nobody checked is worse than an empty one: it reads as fact.
--
-- The REQUIREMENT lives in save_show below, which refuses to write a programme
-- without a name, a kind, an age rating, a start date and at least one band.
-- The four survive, list as incomplete, and the first edit of each completes it.
-- ---------------------------------------------------------------------------

alter table public.shows
  add constraint shows_run_dates check (
    ends_on is null or starts_on is null or ends_on >= starts_on);

comment on column public.shows.ends_on is
  'When the programme left the air, Block 18 (D7). NULL IS THE INDETERMINATE CASE and not a missing value -- a far-future sentinel would be a date somebody eventually filters on, groups by and believes. Ending is how a programme leaves circulation: nothing pointing at shows cascades (every foreign key is NO ACTION), so a delete would be refused with 23503 the moment one request named it, and the operator would read "could not save" about a row they were removing.';

comment on column public.shows.thumb_url is
  'Uploaded, never typed -- Block 14''s artwork path, written by a door of its own against the saved record.';

-- ---------------------------------------------------------------------------
-- The schedule.
--
-- ONE ROW PER WEEKDAY, and each row remembers which BAND the operator typed it
-- as part of. "Seg-Sex 10:00-12:30" is five rows sharing a marker.
--
-- The alternative -- one row holding `weekdays smallint[]` -- reads back exactly
-- as typed, which is the argument Block 17b used for keeping an interval rather
-- than a count. It fails here for a reason 17b did not have: every question the
-- owner named is "given an instant, which programme was on", which is a per-day
-- question. The marker is what recovers what the array was protecting -- without
-- it, five rows with the same hours are indistinguishable from five bands that
-- happen to coincide, and grouping them for the screen is a guess.
--
-- NO deleted_at, unlike almost every table here. A schedule is not a record of
-- something that happened; it is the current shape of a programme, replaced
-- wholesale on every save the way save_promotion_question replaces a question's
-- options. A soft-deleted band would have to be excluded by every reader for
-- ever, to preserve nothing anyone will read.
-- ---------------------------------------------------------------------------
create table public.show_schedules (
  id              uuid primary key default gen_random_uuid(),
  show_id         uuid not null references public.shows(id),
  organization_id uuid not null references public.organizations(id),
  company_id      uuid not null references public.companies(id),
  band            smallint not null,
  -- ISO: 1 = Monday ... 7 = Sunday, matching `extract(isodow from ...)` so the
  -- on-air query compares a column against a function result rather than
  -- against a convention this schema invented for itself.
  weekday         smallint not null check (weekday between 1 and 7),
  starts_at       time not null,
  ends_at         time not null,
  created_at      timestamptz not null default now(),
  -- No row may end before it starts, because save_show splits the overnight
  -- case on write. A row violating this is a writer that forgot to.
  constraint show_schedules_within_a_day check (ends_at > starts_at)
);

create index show_schedules_show_idx on public.show_schedules (show_id, band, weekday);
create index show_schedules_weekday_idx on public.show_schedules (company_id, weekday);

alter table public.show_schedules enable row level security;

-- Readable with the same permission `shows` itself uses (shows_select_music_view,
-- 0098). No insert, update or delete policy at all: every write goes through the
-- SECURITY DEFINER door below, which is how `shows` has always worked.
create policy show_schedules_select_music_view on public.show_schedules
  for select using (public.has_permission('music.view', company_id));

-- SELECT ONLY, matching `shows` exactly: authenticated reads, service_role
-- reads, and neither writes. A grant is not the policy -- without this line the
-- policy never runs, because PostgREST is refused at the table before RLS is
-- consulted, and the error says "permission denied for table" rather than
-- returning an empty set. That difference is what makes a missing grant look
-- like a broken query.
grant select on public.show_schedules to authenticated;
grant select on public.show_schedules to service_role;

comment on table public.show_schedules is
  'A programme''s weekly hours, Block 18 (D4). One row per weekday, each carrying the band the operator typed it as part of -- so the screen shows back what was written and the queries still ask per day. An overnight band is two rows sharing one marker (D5), split on write so no future filter has to remember that 23:00-02:00 ends before it starts.';

-- ---------------------------------------------------------------------------
-- The write. One call for the programme AND its whole schedule, because they
-- are one form: splitting them would let a programme exist for an instant with
-- no schedule, or still carrying the previous version's. save_promotion_question
-- (0055) established this shape for a question and its options.
-- ---------------------------------------------------------------------------
create function public.save_show(
  p_company_id     uuid,
  p_name           text,
  p_kind           public.show_kind,
  p_age_rating     public.show_age_rating,
  p_starts_on      date,
  -- The bands AS THE OPERATOR TYPED THEM:
  --   [{"days":[1,2,3,4,5],"starts":"10:00","ends":"12:30"}]
  -- The screen never sends rows. Expanding a band into days, and splitting one
  -- that crosses midnight, both happen here -- in the one place that writes.
  p_bands          jsonb,
  p_presenter_name text default null,
  p_producer_name  text default null,
  p_ends_on        date default null,
  p_show_id        uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor  uuid := auth.uid();
  v_org    uuid;
  v_id     uuid := p_show_id;
  v_name   text := nullif(btrim(coalesce(p_name, '')), '');
  v_band   jsonb;
  v_index  smallint := 0;
  v_day    int;
  v_starts time;
  v_ends   time;
begin
  select organization_id into v_org
    from public.companies
   where id = p_company_id and deleted_at is null;

  if not found then
    raise exception 'station not found: %', p_company_id using errcode = 'P0002';
  end if;

  if not public.has_permission('music.manage', p_company_id) then
    raise log 'save_show denied: actor=% company=%', v_actor, p_company_id;
    raise exception 'permission denied: music.manage required' using errcode = '42501';
  end if;

  -- D3 and D7's required set, enforced HERE rather than only on the screen: the
  -- columns are nullable so four existing programmes survive, and this is what
  -- keeps that from meaning "anything goes".
  if v_name is null then
    raise exception 'the programme needs a name' using errcode = '22023';
  end if;
  if p_kind is null then
    raise exception 'the programme needs a kind' using errcode = '22023';
  end if;
  if p_age_rating is null then
    raise exception 'the programme needs an age rating' using errcode = '22023';
  end if;
  if p_starts_on is null then
    raise exception 'the programme needs a start date' using errcode = '22023';
  end if;
  if p_bands is null or jsonb_array_length(p_bands) = 0 then
    raise exception 'the programme needs at least one band in its schedule'
      using errcode = '22023';
  end if;

  if v_id is null then
    insert into public.shows
      (organization_id, company_id, name, kind, age_rating,
       presenter_name, producer_name, starts_on, ends_on, created_by)
    values
      (v_org, p_company_id, v_name, p_kind, p_age_rating,
       nullif(btrim(coalesce(p_presenter_name, '')), ''),
       nullif(btrim(coalesce(p_producer_name, '')), ''),
       p_starts_on, p_ends_on, v_actor)
    returning id into v_id;
  else
    update public.shows set
      name           = v_name,
      kind           = p_kind,
      age_rating     = p_age_rating,
      presenter_name = nullif(btrim(coalesce(p_presenter_name, '')), ''),
      producer_name  = nullif(btrim(coalesce(p_producer_name, '')), ''),
      starts_on      = p_starts_on,
      ends_on        = p_ends_on,
      updated_at     = now()
    where id = v_id and company_id = p_company_id and deleted_at is null;

    if not found then
      raise exception 'programme not found: %', v_id using errcode = 'P0002';
    end if;
  end if;

  -- WHOLESALE REPLACE, the convention update_prize and update_role already use:
  -- a band removed on screen is removed in the row. Without this, editing a
  -- programme from five days to two would leave it airing on seven.
  delete from public.show_schedules where show_id = v_id;

  for v_band in select * from jsonb_array_elements(p_bands)
  loop
    v_index := v_index + 1;
    v_starts := (v_band ->> 'starts')::time;
    v_ends   := (v_band ->> 'ends')::time;

    if v_starts is null or v_ends is null then
      raise exception 'a band needs a start and an end' using errcode = '22023';
    end if;
    if v_band -> 'days' is null or jsonb_array_length(v_band -> 'days') = 0 then
      raise exception 'a band needs at least one day' using errcode = '22023';
    end if;

    for v_day in select value::int from jsonb_array_elements_text(v_band -> 'days')
    loop
      if v_ends > v_starts then
        insert into public.show_schedules
          (show_id, organization_id, company_id, band, weekday, starts_at, ends_at)
        values (v_id, v_org, p_company_id, v_index, v_day, v_starts, v_ends);
      else
        -- THE OVERNIGHT SPLIT, and doing it here rather than in every reader is
        -- the whole decision. One of the four programmes in production is
        -- called Madrugada Pulchá; a band from 23:00 to 02:00 ends before it
        -- starts, and `time between start and end` returns nothing for it --
        -- the programme disappears from "on air now" during precisely the hours
        -- it is on air. Two rows, on the two days it actually covers, sharing
        -- one band marker so the screen still shows 23:00-02:00.
        insert into public.show_schedules
          (show_id, organization_id, company_id, band, weekday, starts_at, ends_at)
        values (v_id, v_org, p_company_id, v_index, v_day, v_starts, '24:00'::time);

        insert into public.show_schedules
          (show_id, organization_id, company_id, band, weekday, starts_at, ends_at)
        values (v_id, v_org, p_company_id, v_index,
                case when v_day = 7 then 1 else v_day + 1 end,
                '00:00'::time, v_ends);
      end if;
    end loop;
  end loop;

  insert into public.audit_logs
    (actor_id, action, target_table, target_id, organization_id, company_id, detail)
  values
    (v_actor, 'save_show', 'shows', v_id, v_org, p_company_id,
     jsonb_build_object('name', v_name, 'kind', p_kind, 'bands', jsonb_array_length(p_bands)));

  return v_id;
end;
$$;

comment on function public.save_show is
  'Block 18. Writes a programme and its whole schedule in one call, because they are one form. Refuses without a name, a kind, an age rating, a start date or at least one band (D3, D7) -- the columns are nullable so the four programmes that predate this block survive, and this is what keeps that from meaning anything goes. The bands arrive as the operator typed them and are expanded here; one crossing midnight becomes two rows on the two days it covers, sharing a marker (D5). The schedule is replaced wholesale. Granted to authenticated; re-checks music.manage against auth.uid().';

-- ---------------------------------------------------------------------------
-- Ending. D8's only way out: there is no delete on this screen.
-- ---------------------------------------------------------------------------
create function public.end_show(p_show_id uuid, p_ends_on date)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_company uuid;
begin
  select company_id into v_company
    from public.shows where id = p_show_id and deleted_at is null;

  if not found then
    raise exception 'programme not found: %', p_show_id using errcode = 'P0002';
  end if;

  if not public.has_permission('music.manage', v_company) then
    raise log 'end_show denied: actor=% show=%', auth.uid(), p_show_id;
    raise exception 'permission denied: music.manage required' using errcode = '42501';
  end if;

  -- THE SCHEDULE IS LEFT EXACTLY AS IT WAS, deliberately: a request made last
  -- month is still read against the hours it was made in, which is the filter
  -- the owner has said is coming.
  update public.shows
     set ends_on = p_ends_on, updated_at = now()
   where id = p_show_id;

  insert into public.audit_logs
    (actor_id, action, target_table, target_id, organization_id, company_id, detail)
  select auth.uid(), 'end_show', 'shows', p_show_id, s.organization_id, s.company_id,
         jsonb_build_object('ends_on', p_ends_on)
    from public.shows s where s.id = p_show_id;
end;
$$;

comment on function public.end_show is
  'Block 18 (D8). Ends a programme by date rather than deleting it, which is the only one of the two that works: nothing pointing at shows cascades, so a delete would be refused with 23503 the moment one request named it. The schedule is left intact so a past request is still readable against the hours it was made in.';

-- ---------------------------------------------------------------------------
-- What is on air, in the STATION'S OWN CLOCK.
--
-- A schedule is wall-clock time. Computed against a bare now() this works every
-- afternoon and is wrong at 21:00 -- the same class of trap Block 17b avoided by
-- choosing an interval over a calendar count, and the reason 43_shows.test.sql
-- puts two Stations 25 hours apart.
-- ---------------------------------------------------------------------------
create function public.shows_on_air(p_company_id uuid)
returns uuid[]
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select coalesce(array_agg(distinct s.id), '{}'::uuid[])
    from public.shows s
    join public.companies c on c.id = s.company_id
    join public.show_schedules sc on sc.show_id = s.id
   where s.company_id = p_company_id
     and s.deleted_at is null
     and (s.starts_on is null or s.starts_on <= (now() at time zone c.timezone)::date)
     and (s.ends_on is null or s.ends_on >= (now() at time zone c.timezone)::date)
     and sc.weekday = extract(isodow from (now() at time zone c.timezone))::smallint
     and (now() at time zone c.timezone)::time >= sc.starts_at
     and (now() at time zone c.timezone)::time < sc.ends_at;
$$;

comment on function public.shows_on_air is
  'Block 18. Which of a Station''s programmes are on the air right now, answered in THAT STATION''S timezone (companies.timezone) rather than the server''s -- computed against a bare now() this passes every suite run in the afternoon and is wrong at 21:00. An ended programme is excluded; its schedule is not touched. Half-open on the hour (>= start, < end) so two consecutive bands never both claim the same minute.';

revoke execute on function public.save_show(
  uuid, text, public.show_kind, public.show_age_rating, date, jsonb, text, text, date, uuid) from public;
revoke execute on function public.end_show(uuid, date) from public;
revoke execute on function public.shows_on_air(uuid) from public;

grant execute on function public.save_show(
  uuid, text, public.show_kind, public.show_age_rating, date, jsonb, text, text, date, uuid) to authenticated;
grant execute on function public.end_show(uuid, date) to authenticated;
grant execute on function public.shows_on_air(uuid) to authenticated;
