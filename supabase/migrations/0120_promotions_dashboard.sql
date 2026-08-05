-- supabase/migrations/0120_promotions_dashboard.sql

-- Block 8a, Task 5: the Promotions dashboard, and the situation rule's
-- second copy.

-- The situation rule, in SQL, for the second time in this codebase.
--
-- src/lib/promotion-situation.ts:14 is the first copy: the promotions grid and
-- the record dialog are client components and cannot call this. An aggregate
-- has to classify in the database, so the rule exists twice -- accepted in the
-- design spec's D11 on three conditions, all met here: the same half-open
-- window; each copy naming the other; and BOTH proved at the same boundary
-- instants (supabase/tests/20_dashboards.test.sql and
-- tests/unit/promotion-situation-boundary.test.ts).
--
-- Half-open, matching 0040's exclusion constraint: a promotion is live at the
-- instant it starts and over at the instant it ends.
create or replace function public.promotion_is_live(
  p_starts_at    timestamptz,
  p_ends_at      timestamptz,
  p_cancelled_at timestamptz,
  p_at           timestamptz
)
returns boolean
language sql
immutable
set search_path = pg_catalog, public
as $$
  select p_cancelled_at is null
     and p_at >= p_starts_at
     and p_at <  p_ends_at;
$$;

comment on function public.promotion_is_live(timestamptz, timestamptz, timestamptz, timestamptz) is
  'Whether a promotion is on air at a given instant: not cancelled, started, and not yet ended, over a half-open window matching 0040''s exclusion constraint. THE SECOND COPY of a rule src/lib/promotion-situation.ts also holds -- the grid and the record dialog are client components and cannot call a database function, and an aggregate cannot call TypeScript. Design spec D11 accepts the duplication only because both copies are pinned at the same three boundary instants by paired tests; change one and the other fails.';

grant execute on function public.promotion_is_live(timestamptz, timestamptz, timestamptz, timestamptz) to authenticated;

-- ---------------------------------------------------------------------------
-- get_promotions_dashboard: the third and last of the three aggregates. Same
-- shape as 0118/0119 (same arguments, same dedup, same permission loop, same
-- station CTE, same payload keys); what follows is only what is specific to
-- promotions.
--
-- SECURITY INVOKER, for the same reason 0118 gives (D4): 0044's promotions
-- policy, 0052's participations policy and 0075's winners policy all apply
-- INSIDE this function and cannot be forgotten. What is still done by hand is
-- the permission check below, because RLS answers "which rows" and not "may
-- this person be here at all".
--
-- D12. cancel_draw (0079) reverses the prize unit but deliberately leaves
-- winners.status at AWAITING_PICKUP -- 6a has no vocabulary for "un-awarded".
-- list_pickups (0095) and sweep_pickup_deadlines (0094) both exclude these
-- rows and each says why in its own header; this is the third reader to treat
-- AWAITING_PICKUP as live and so the third that has to. Counting them would
-- report prizes handed out that were taken back before anyone was told. The
-- exclusion is carried by every winner-derived figure below: awarded, overdue
-- and the prize_cycle breakdown all read the same `winner` CTE, which joins
-- to draws and filters out a cancelled one there, once, rather than repeating
-- the predicate in each figure separately.
--
-- D13. participations is gated by participations.view (0053), which
-- promotions.view -- this panel's own gate -- does not imply. It feeds the
-- whole entry side of this panel: the participation count, the distinct
-- listeners, the refusal breakdown, the busiest-promotions list AND the
-- monthly participation chart. All five are OMITTED (never zeroed, never an
-- empty array standing in for a number the caller may not see) for a caller
-- lacking participations.view in any selected Station, and named in withheld
-- instead -- monthly included, because an empty chart reads as "nobody took
-- part in twelve months", the same false claim a zero card would make, only
-- in a different shape. The prize cycle does not cross that line: winners is
-- gated by promotions.view, so a caller who lacks participations.view still
-- sees on-air, ended, awarded, overdue and the prize_cycle breakdown in full.
--
-- live_now and overdue carry no `previous` key at all -- not a null one -- as
-- neither has a comparison that would mean anything: on-air-now is a fact
-- about this instant, and a zero previous overdue count would read as "it used
-- to be fine and now it is not" when the truth is simply that the figure has
-- no "before".
create or replace function public.get_promotions_dashboard(
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
  v_ids            uuid[];
  v_id             uuid;
  v_consolidated   boolean;
  v_participations boolean := true;
  v_result         jsonb;
begin
  if p_company_ids is null or cardinality(p_company_ids) = 0 then
    raise exception 'at least one station is required' using errcode = '22023';
  end if;

  -- Deduplicated before anything counts, so naming a Station twice cannot
  -- double its rows.
  select array_agg(distinct s) into v_ids from unnest(p_company_ids) as t(s);
  v_consolidated := cardinality(v_ids) > 1;

  foreach v_id in array v_ids loop
    if not public.has_permission('promotions.view', v_id) then
      raise exception 'promotions.view is required in every station requested'
        using errcode = '42501';
    end if;
    if v_consolidated and not public.has_permission('reports.consolidated', v_id) then
      raise exception 'reports.consolidated is required in every station of a consolidated view'
        using errcode = '42501';
    end if;
    -- Not a refusal: the figures it feeds are withheld instead (D13).
    if not public.has_permission('participations.view', v_id) then
      v_participations := false;
    end if;
  end loop;

  with station as (
    select c.id, c.organization_id, c.name, c.timezone, p.*
      from public.companies c
      cross join lateral public.resolve_dashboard_period(p_preset, p_from, p_to, c.timezone) p
     where c.id = any(v_ids)
  ),
  -- Every promotion of every named Station, both windows in one row each, so
  -- the cards below can FILTER current vs. previous. No explicit
  -- deleted_at/is_owner_of_company predicate here: 0044's own select policy
  -- already carries that pair, and this function is SECURITY INVOKER
  -- precisely so it need not be restated.
  promotion as (
    select pr.starts_at, pr.ends_at, pr.cancelled_at,
           s.from_at, s.to_at, s.previous_from_at, s.previous_to_at
      from public.promotions pr
      join station s on s.id = pr.company_id
  ),
  promotion_cards as (
    select
      -- On air right now, at the single instant every Station shares --
      -- promotion_is_live already folds in "not cancelled" (D11).
      count(*) filter (where public.promotion_is_live(starts_at, ends_at, cancelled_at, now()))
        as live_now,
      count(*) filter (where cancelled_at is null and ends_at >= from_at and ends_at < to_at)
        as ended_current,
      count(*) filter (where cancelled_at is null and ends_at >= previous_from_at and ends_at < previous_to_at)
        as ended_previous
      from promotion
  ),
  -- Every participation of every named Station, both windows in one row --
  -- the CTE the whole entry side of this panel (D13) is built from.
  --
  -- BOUNDED, and this is the single largest read in the block (whole-branch
  -- review, Important B6). Five figures reference this CTE, so Postgres
  -- materialises it and pushes no consumer's date predicate down into it:
  -- unbounded, opening this dashboard read the Station's ENTIRE participation
  -- history -- every entry of every promotion it has ever run -- to produce
  -- figures that span at most twelve months, and
  -- participations_company_period_idx (0116) was never exercised on its
  -- second column at all. The bound is a semantic no-op, checked consumer by
  -- consumer: participation_cards filters the two windows, the refusal
  -- breakdown and top_promotions filter the current window, and monthly
  -- filters [to_at - 12 months, to_at). `least` because the comparison window
  -- of a long custom range can open earlier than twelve months back.
  --
  -- `and v_participations` short-circuits the whole scan on the withheld path
  -- (the same reasoning 0118's took_part carries, Minor C6): every consumer
  -- of this CTE is omitted for a caller lacking participations.view, so
  -- reading the table at all was work whose only possible outcome was being
  -- thrown away. The aggregates below still return their one row of zeros
  -- over an empty input, and the `case when` clauses discard it exactly as
  -- they discarded the real numbers.
  participation as (
    select p.id, p.member_id, p.promotion_id, p.status, p.participated_at,
           s.timezone, s.from_at, s.to_at, s.previous_from_at, s.previous_to_at
      from public.participations p
      join station s on s.id = p.company_id
     where v_participations
       and p.participated_at >= least(s.previous_from_at, s.to_at - interval '12 months')
       and p.participated_at <  s.to_at
  ),
  participation_cards as (
    select
      count(*) filter (where participated_at >= from_at and participated_at < to_at)
        as current,
      count(*) filter (where participated_at >= previous_from_at and participated_at < previous_to_at)
        as previous,
      count(distinct member_id) filter (where participated_at >= from_at and participated_at < to_at)
        as distinct_current,
      count(distinct member_id) filter (where participated_at >= previous_from_at and participated_at < previous_to_at)
        as distinct_previous
      from participation
  ),
  -- D12, applied once: a winner whose DRAW was cancelled is excluded from
  -- every figure that reads this CTE (awarded, overdue, prize_cycle), because
  -- cancel_draw (0079) reverses the unit but deliberately leaves
  -- winners.status at AWAITING_PICKUP.
  -- DELIBERATELY UNBOUNDED BY DATE, unlike `participation` above: `overdue`
  -- is a fact about right now over ALL time (an AWAITING_PICKUP winner whose
  -- deadline passed two years ago is still uncollected today), so a
  -- window bound here would silently shrink the one figure on this panel that
  -- has no window. winners_company_created_idx (0116) still serves the
  -- awarded FILTERs, and 0075's partial (deadline_at) index serves overdue.
  winner as (
    select w.id, w.status, w.deadline_at, w.created_at,
           s.from_at, s.to_at, s.previous_from_at, s.previous_to_at
      from public.winners w
      join station s on s.id = w.company_id
      join public.draws d on d.id = w.draw_id and d.status <> 'CANCELLED'
  ),
  winner_cards as (
    select
      count(*) filter (where created_at >= from_at and created_at < to_at)
        as awarded_current,
      count(*) filter (where created_at >= previous_from_at and created_at < previous_to_at)
        as awarded_previous,
      -- Overdue is a fact about right now, not about the chosen period -- no
      -- window filter, the same reason live_now has none.
      count(*) filter (where status = 'AWAITING_PICKUP' and deadline_at is not null and deadline_at < now())
        as overdue_current
      from winner
  ),
  -- Why entries were refused, current window only (no comparison, like every
  -- other breakdown in this block). Every value of participation_status is
  -- listed whether or not it occurred, via unnest(enum_range(...)) LEFT
  -- JOINed to the rows -- so a status nobody hit this period reports 0 instead
  -- of vanishing from the chart, and the buckets always sum to
  -- cards.participations.current. The column is never null (0052), so there is
  -- no "not stated" bucket to add, unlike 0119's nationality/vocal.
  participation_status_breakdown as (
    select jsonb_agg(jsonb_build_object('key', b.key, 'label', b.label, 'count', b.n)
                     order by b.sort, b.label) as rows
      from (
        select v::text as key, v::text as label, 0 as sort,
               count(p.id) as n
          from unnest(enum_range(null::public.participation_status)) as v
          left join participation p
            on p.status = v
           and p.participated_at >= p.from_at and p.participated_at < p.to_at
         group by v
      ) b
  ),
  -- The prize cycle, identical shape, over winner_status -- and, per D12,
  -- reading the SAME `winner` CTE every other winner-derived figure does, so a
  -- cancelled draw's winner cannot appear here either.
  prize_cycle as (
    select jsonb_agg(jsonb_build_object('key', b.key, 'label', b.label, 'count', b.n)
                     order by b.sort, b.label) as rows
      from (
        select v::text as key, v::text as label, 0 as sort,
               count(w.id) as n
          from unnest(enum_range(null::public.winner_status)) as v
          left join winner w
            on w.status = v
           and w.created_at >= w.from_at and w.created_at < w.to_at
         group by v
      ) b
  ),
  -- Busiest promotions, top ten by participation count in the window --
  -- part of the entry side (D13), so joined off `participation`, not
  -- `promotion` above.
  --
  -- THE ARCHIVED-PROMOTION JOIN IS CONSISTENT WITH THE CARD ABOVE IT, and a
  -- reader is right to check (whole-branch review, Minor C4 -- raised as a
  -- discrepancy, and it is not one; recorded here so the next reader stops
  -- where this one did). This joins public.promotions under RLS, so
  -- promotions_select_promotions_view (0044:43-48) hides an archived
  -- promotion from anyone but the Organization owner and this list loses its
  -- name. The worry is that its participations would still swell
  -- cards.participations, printing a total no named promotion accounts for --
  -- but they do not: participations_select_participations_view (0053:25-30)
  -- carries `promotion_id in (select id from public.promotions)`, and that
  -- subquery is itself filtered by the policy above. The same caller who
  -- cannot see the promotion cannot see its participations either, so the
  -- rows are gone from `participation` before any figure counts them. Both
  -- sides move together, in both directions, for every caller. Spec §7's
  -- isolation requirement ("an archived promotion's participations do not
  -- reach a non-owner's totals") is the assertion that pins it.
  top_promotions as (
    select jsonb_agg(jsonb_build_object('id', t.promotion_id, 'label', t.name, 'count', t.n)
                     order by t.n desc, t.name) as rows
      from (
        select p.promotion_id, pm.name, count(*) as n
          from participation p
          join public.promotions pm on pm.id = p.promotion_id
         where p.participated_at >= p.from_at and p.participated_at < p.to_at
         group by p.promotion_id, pm.name
         order by count(*) desc, pm.name
         limit 10
      ) t
  ),
  -- Monthly participations, over the last twelve months ending at the
  -- window's end, at the Station's own clock -- also entry-side (D13).
  monthly as (
    select jsonb_agg(jsonb_build_object('month', m.bucket, 'count', m.n) order by m.bucket) as rows
      from (
        select to_char(date_trunc('month', p.participated_at at time zone p.timezone), 'YYYY-MM') as bucket,
               count(*) as n
          from participation p
         where p.participated_at < p.to_at
           and p.participated_at >= (p.to_at - interval '12 months')
         group by 1
      ) m
  )
  -- The whole payload is wrapped in jsonb_strip_nulls, ONCE, at the top --
  -- and 0118 and 0119 now spell it exactly this way too (whole-branch review,
  -- Minor C3: this function stripped at four levels, 0118 at one and 0119 at
  -- none, on three payloads sharing one Zod schema and one D13 contract).
  -- jsonb_strip_nulls recurses, so the inner calls this function used to make
  -- on `cards`, `breakdowns` and `top` were redundant and are gone.
  --
  -- `monthly` is a TOP-level key (matching 0118/0119's own shape) and, unlike
  -- `cards`/`breakdowns`/`top`, has no sub-object of its own to strip inside.
  -- D13 applies to it exactly as it does to the entry cards: an empty chart
  -- reads as "nobody took part in twelve months", a claim about the
  -- audience made to someone simply not allowed to see the answer -- the
  -- same confusion a zero card would cause, in a different shape. So it is
  -- omitted (null, then stripped) rather than returned as `[]`, and named in
  -- withheld alongside the cards it shares its gate with.
  select jsonb_strip_nulls(jsonb_build_object(
    'period', (
      select jsonb_build_object(
        'preset', p_preset,
        'from', min(from_date), 'to', min(to_date),
        'previous_from', min(previous_from_date), 'previous_to', min(previous_to_date))
        from station),
    -- Each Station's own resolved dates beside its timezone (D5 as amended) --
    -- see 0118's own comment for the full argument.
    'stations', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', id, 'name', name, 'timezone', timezone,
               'from', from_date, 'to', to_date) order by name)
        from station), '[]'::jsonb),
    'cards', (
      select jsonb_build_object(
        'live_now', jsonb_build_object('current', pc.live_now),
        'ended',    jsonb_build_object('current', pc.ended_current, 'previous', pc.ended_previous),
        'participations', case when v_participations
                                then jsonb_build_object('current', ptc.current, 'previous', ptc.previous)
                                else null end,
        'distinct_participants', case when v_participations
                                       then jsonb_build_object('current', ptc.distinct_current, 'previous', ptc.distinct_previous)
                                       else null end,
        'awarded', jsonb_build_object('current', wc.awarded_current, 'previous', wc.awarded_previous),
        'overdue', jsonb_build_object('current', wc.overdue_current))
        from promotion_cards pc, participation_cards ptc, winner_cards wc),
    'monthly', case when v_participations
                    then coalesce((select rows from monthly), '[]'::jsonb)
                    else null end,
    'breakdowns', jsonb_build_object(
                    'participation_status', case when v_participations
                                                  then coalesce((select rows from participation_status_breakdown), '[]'::jsonb)
                                                  else null end,
                    'prize_cycle', coalesce((select rows from prize_cycle), '[]'::jsonb)),
    'top', jsonb_build_object(
             'promotions', case when v_participations
                                 then coalesce((select rows from top_promotions), '[]'::jsonb)
                                 else null end),
    'withheld', case when v_participations then '[]'::jsonb
                     else jsonb_build_array(
                            jsonb_build_object('figure', 'participations', 'needs', 'participations.view'),
                            jsonb_build_object('figure', 'distinct_participants', 'needs', 'participations.view'),
                            jsonb_build_object('figure', 'participation_status', 'needs', 'participations.view'),
                            jsonb_build_object('figure', 'promotions', 'needs', 'participations.view'),
                            jsonb_build_object('figure', 'monthly', 'needs', 'participations.view'))
                     end
  )) into v_result;

  return v_result;
end;
$$;

comment on function public.get_promotions_dashboard(uuid[], text, date, date) is
  'The Promotions dashboard for one Station or a consolidated set, both windows in one call. Same contract and SECURITY INVOKER rationale as get_audience_dashboard/get_music_dashboard (D4): 0044''s policy on promotions, 0052''s on participations and 0075''s on winners all apply inside it. Refuses with 42501 unless the caller holds promotions.view in EVERY station named, and reports.consolidated in every one when more than one is named (D3). live_now uses promotion_is_live (this migration''s own second copy of src/lib/promotion-situation.ts''s rule, pinned by paired tests per D11) against a single shared instant, so it and overdue -- a fact about right now, not the chosen period -- carry no previous key at all, never a null one. A winner whose DRAW was cancelled counts toward NOTHING on this panel (D12): cancel_draw (0079) reverses the unit but deliberately leaves winners.status at AWAITING_PICKUP, and awarded, overdue and the prize_cycle breakdown all read one `winner` CTE that excludes it once, so no figure here can forget the exclusion the way a copy-pasted predicate could. participations is gated by participations.view (0053), which promotions.view -- this panel''s own gate -- does not imply (D13): the whole entry side -- participations, distinct_participants, the participation_status breakdown, the busiest-promotions top ten AND the monthly participation chart -- is OMITTED (never zeroed, never an empty array in place of a number the caller may not see) for a caller lacking it in any selected Station, and named in withheld instead; the prize cycle is unaffected, because winners answers to promotions.view alone. Every enum breakdown (participation_status, prize_cycle) lists every value whether or not it occurred this window, so its buckets always sum to the card printed beside it.';

grant execute on function public.get_promotions_dashboard(uuid[], text, date, date) to authenticated;
