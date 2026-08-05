-- supabase/migrations/0117_resolve_dashboard_period.sql

-- Block 8a, Task 2: what a period IS, in one place.
--
-- Design spec D5 and D6. Three aggregates need the same two windows -- the one
-- the operator chose and the one immediately before it -- and each needs them
-- per Station, because a group's radios do not share a clock. Three copies of
-- "what the previous month is" is three chances to disagree, and a disagreement
-- here does not look like a defect: it looks like a number.
--
-- WHY THE ARITHMETIC IS HERE AND NOT IN NODE. The server runs UTC. Resolving
-- 'current month' in TypeScript would take the server's date, and for the three
-- hours either side of midnight in Sao Paulo -- and for a full day at the edges
-- of the Pacific -- that is a different month. Every card on the page would be
-- wrong together, which is the hardest kind of wrong to notice. 0062 and 0112
-- already carry this rule for what a listener is TOLD; this is the same rule
-- for what the owner is SHOWN.
--
-- Every bound is half-open: from inclusive, to exclusive. That matches 0040's
-- exclusion constraint on a promotion's own window and the rule
-- src/lib/promotion-situation.ts restates -- a period is over at the instant it
-- ends, not a moment after -- so a row cannot fall in two adjacent periods or
-- in neither.
--
-- SECURITY INVOKER (the default, stated for the reader): it reads no table and
-- so has nothing to bypass. It is pure arithmetic over its arguments.
create or replace function public.resolve_dashboard_period(
  p_preset   text,
  p_from     date,
  p_to       date,
  p_timezone text
)
returns table (
  from_at            timestamptz,
  to_at              timestamptz,
  previous_from_at   timestamptz,
  previous_to_at     timestamptz,
  from_date          date,
  to_date            date,
  previous_from_date date,
  previous_to_date   date
)
language plpgsql
stable
set search_path = pg_catalog, public
as $$
declare
  v_today date;
  v_from  date;
  v_to    date;
  v_pfrom date;
  v_pto   date;
begin
  if p_timezone is null or btrim(p_timezone) = '' then
    raise exception 'a station timezone is required' using errcode = '22023';
  end if;

  -- The Station's today, never the server's.
  v_today := (now() at time zone p_timezone)::date;

  -- Each branch sets its OWN comparison window, and that is the whole point of
  -- the shape below. A calendar preset compares against the previous CALENDAR
  -- unit, which is not the same thing as subtracting the current unit's length:
  -- `date - date` in Postgres is a count of days, so subtracting the span of a
  -- 31-day May would place the comparison window at 31 March, giving one day of
  -- March plus all of April and calling it "the previous month". That is right
  -- only when two adjacent units happen to share a length -- true for July into
  -- August, false for ten month pairs in twelve and for every year after a leap
  -- year -- and it fails as a plausible number rather than an error.
  case p_preset
    when 'current_month' then
      v_from  := date_trunc('month', v_today::timestamp)::date;
      v_to    := (v_from + interval '1 month')::date;
      v_pfrom := (v_from - interval '1 month')::date;
    when 'previous_month' then
      v_to    := date_trunc('month', v_today::timestamp)::date;
      v_from  := (v_to - interval '1 month')::date;
      v_pfrom := (v_from - interval '1 month')::date;
    when 'current_year' then
      v_from  := date_trunc('year', v_today::timestamp)::date;
      v_to    := (v_from + interval '1 year')::date;
      v_pfrom := (v_from - interval '1 year')::date;
    when 'custom' then
      if p_from is null or p_to is null then
        raise exception 'a custom period needs both bounds' using errcode = '22023';
      end if;
      if p_to <= p_from then
        raise exception 'a period cannot end before it starts' using errcode = '22023';
      end if;
      v_from := p_from;
      v_to   := p_to;
      -- The only preset where subtracting the span IS the right answer: an
      -- arbitrary range of N days has no calendar unit to step back by, so the
      -- immediately preceding N days is the only sensible comparison.
      v_pfrom := (v_from - (v_to - v_from))::date;
    else
      -- Not defaulted to a month. A typo in a search param must be an error the
      -- screen can name, not a silently different question answered correctly.
      raise exception 'unknown period preset: %', p_preset using errcode = '22023';
  end case;

  -- Common to every preset: the comparison window ends where the chosen one
  -- begins, so the two are adjacent and never overlap.
  v_pto := v_from;

  return query select
    (v_from::timestamp  at time zone p_timezone),
    (v_to::timestamp    at time zone p_timezone),
    (v_pfrom::timestamp at time zone p_timezone),
    (v_pto::timestamp   at time zone p_timezone),
    v_from, v_to, v_pfrom, v_pto;
end;
$$;

comment on function public.resolve_dashboard_period(text, date, date, text) is
  'The two windows every Block 8a dashboard measures: the one chosen and the one immediately before it, both half-open (from inclusive, to exclusive). For calendar presets the comparison is the CALENDAR unit before (not the same as subtracting a day count: a 31-day May minus 31 days is 31 March, which is one day of March plus all of April, a misalignment passed by only when adjacent units share a length). Takes the Station''s timezone and returns BOTH the local dates and the instants they bound, because the screen shows dates and the queries filter timestamptz. Presets (current_month, previous_month, current_year) are resolved from now() at the STATION''s clock -- the server runs UTC, and resolving them there would misplace the hours either side of local midnight into the neighbouring period, wrongly and in every card at once. An unknown preset raises 22023 rather than defaulting, so a bad search param is an error the screen can name instead of a different question answered correctly. Pure arithmetic over its arguments: it reads no table.';

grant execute on function public.resolve_dashboard_period(text, date, date, text) to authenticated;
