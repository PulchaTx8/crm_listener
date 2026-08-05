-- supabase/migrations/0118_audience_dashboard.sql

-- Block 8a, Task 3: the Audience dashboard, as one function.
--
-- Design spec §3.1. One jsonb, both windows, one round trip -- Block 3b
-- measured what the alternative costs (102 queries to 5) and this screen would
-- otherwise ask ten questions to fill one page.
--
-- SECURITY INVOKER, and that is the decision worth reading (D4). Every other
-- read RPC here is SECURITY DEFINER and therefore has to restate by hand each
-- predicate RLS used to apply -- 0095's header lists four such rules and
-- records that one of them went five commits missing, caught only by the
-- isolation suite. An aggregate carries the same risk with a worse symptom: a
-- list that leaks a row looks wrong, while a count that includes rows the
-- caller may not read looks like a number. Running as the caller means
-- members_select_reachable (0035) and its siblings apply INSIDE this function
-- and cannot be forgotten.
--
-- What is still done by hand is the permission check below, because RLS
-- answers "which rows" and not "may this person be here at all", and a caller
-- without members.view must be told 42501 rather than shown a screen of
-- zeros. Zero and "you may not see this" must never render alike.
--
-- ONE FIGURE CROSSES A PERMISSION LINE (D13). "Took part" reads participations,
-- gated by participations.view (0053), which members.view does not imply. It is
-- not zeroed for a caller lacking it -- it is omitted from cards and named in
-- withheld, so the screen can render an em dash and say which permission fills
-- it.
create or replace function public.get_audience_dashboard(
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
    if not public.has_permission('members.view', v_id) then
      raise exception 'members.view is required in every station requested'
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
    -- organization_id is selected here and not looked up again below: the
    -- Organization-wide block branch needs it per Station, and a correlated
    -- subquery back to companies would re-read a row this CTE already holds.
    select c.id, c.organization_id, c.name, c.timezone, p.*
      from public.companies c
      cross join lateral public.resolve_dashboard_period(p_preset, p_from, p_to, c.timezone) p
     where c.id = any(v_ids)
  ),
  -- Deleted and anonymised members are not audience; an anonymised row is a
  -- person whose data was erased under LGPD, and counting them as reachable
  -- listeners would overstate every figure on this page.
  --
  -- BOUNDED BY `to_at`, and the bound is not cosmetic (whole-branch review,
  -- Important B6). This CTE is referenced four times below, so Postgres
  -- materialises it and pushes NO date predicate down into it from any
  -- consumer -- without the line below, `member_links_company_linked_idx`
  -- (0116) is never exercised on its second column and every load reads the
  -- Station's whole arrival history. The bound is a semantic no-op, checked
  -- consumer by consumer: cards filter `< to_at` or `< previous_to_at`
  -- (previous_to_at = from_at <= to_at), monthly filters `< to_at`, and both
  -- top-ten lists filter `< to_at`. Nothing below ever asks about a link made
  -- after the window ended.
  link as (
    select l.member_id, l.linked_at, s.*
      from public.member_company_links l
      join station s on s.id = l.company_id
      join public.members m
        on m.id = l.member_id and m.deleted_at is null and m.anonymized_at is null
     where l.linked_at < s.to_at
  ),
  cards as (
    select
      -- Stock figures, measured as of the end of each window (D6).
      count(distinct member_id) filter (where linked_at < to_at)             as listeners_current,
      count(distinct member_id) filter (where linked_at < previous_to_at)    as listeners_previous,
      -- Flow figures.
      count(distinct member_id) filter (where linked_at >= from_at and linked_at < to_at)
                                                                            as new_current,
      count(distinct member_id) filter (where linked_at >= previous_from_at and linked_at < previous_to_at)
                                                                            as new_previous
      from link
  ),
  -- D12b: every figure on this panel counts the same population. took_part
  -- reads participations directly, with no obligation on its own to exclude an
  -- erased member -- the participation genuinely happened. But left that way,
  -- this card and `listeners` above would silently disagree about who counts,
  -- and nothing on screen says so: a page that prints more "took part" than
  -- "listeners" reads as a bug even when each number is individually true. The
  -- accepted cost is the opposite, smaller error -- activity by a since-erased
  -- listener is undercounted -- rather than the two cards contradicting each
  -- other.
  --
  -- `and v_participations` short-circuits the whole scan on the withheld path
  -- (whole-branch review, Minor C6): without it this counted a table the
  -- caller may not see and then threw the answer away in the `case when`
  -- below. An aggregate with no GROUP BY still returns exactly one row of
  -- zeros over an empty input, so the cross join that builds `cards` keeps
  -- its row and the payload shape is unchanged -- the zeros are discarded by
  -- the same `case` that discarded the real numbers before.
  took_part as (
    select
      count(distinct p.member_id) filter (where p.participated_at >= s.from_at and p.participated_at < s.to_at)
        as current,
      count(distinct p.member_id) filter (where p.participated_at >= s.previous_from_at and p.participated_at < s.previous_to_at)
        as previous
      from public.participations p
      join station s on s.id = p.company_id
      join public.members m
        on m.id = p.member_id and m.deleted_at is null and m.anonymized_at is null
     -- Bounded for the same reason `link` above is: neither FILTER clause can
     -- restrict the scan by itself, and the comparison window always opens
     -- before the chosen one (v_pto := v_from, 0117), so
     -- [previous_from_at, to_at) is exactly the union of the two windows this
     -- CTE measures -- a bound, never a narrowing.
     where v_participations
       and p.participated_at >= s.previous_from_at
       and p.participated_at <  s.to_at
  ),
  -- Shared by barred and blocks_by_kind below (review fix round 1, Minor: the
  -- two had triplicated the same Station-or-Organization-wide join). 0032
  -- states a null member_blocks.company_id means the whole Organization, so a
  -- group-wide block matches every Station named -- the reason a consolidated
  -- bar figure is not always the sum of its parts, and the reason both
  -- consumers below count DISTINCT MEMBERS rather than matched rows: without
  -- that, a group-wide block would count once per Station reached in a
  -- consolidated view instead of once (Finding 1's own regression assertion
  -- proves this in the test file). Same D12b join as took_part above, for the
  -- same reason: a block recorded against a since-erased member must not make
  -- `barred`/`blocks_by_kind` disagree with `listeners` about who is in the
  -- audience this panel describes. Written once here rather than copied into
  -- both CTEs, so the join cannot drift between them the way it had already
  -- diverged from took_part before D12b closed that gap.
  --
  -- WHAT "STILL IN FORCE" MEANS, and it is not `lifted_at is null` alone
  -- (whole-branch review, Minor C9). 0032 gives member_blocks a nullable
  -- `ends_at` and is_member_blocked (0032, superseded by 0036) derives in
  -- force at read time from all three columns:
  --   lifted_at is null and starts_at <= now() and (ends_at is null or ends_at > now())
  -- A dated suspension therefore ENDS BECAUSE THE DATE PASSED -- nobody lifts
  -- it, and `lifted_at` stays null forever. Counting it here would report a
  -- listener as barred on a panel while every screen that asks
  -- is_member_blocked says they are not, which is the same disagreement
  -- between two readings of one table that D12b was written to refuse.
  --
  -- `starts_at <= now()` is deliberately NOT restated: this card asks "barred
  -- IN THE PERIOD", and the window filter its two consumers apply
  -- (starts_at >= from_at and starts_at < to_at) is what places the block in
  -- the period. Adding a second, now()-relative start test would make a
  -- forward-dated block inside a forward-dated custom range vanish for a
  -- reason the card's own label never mentions.
  blocked as (
    select b.member_id, b.kind, b.starts_at,
           s.from_at, s.to_at, s.previous_from_at, s.previous_to_at
      from public.member_blocks b
      join station s
        on s.id = b.company_id
        or (b.company_id is null and b.organization_id = s.organization_id)
      join public.members m
        on m.id = b.member_id and m.deleted_at is null and m.anonymized_at is null
     where b.lifted_at is null
       and (b.ends_at is null or b.ends_at > now())
  ),
  barred as (
    select
      count(distinct member_id) filter (where starts_at >= from_at and starts_at < to_at)
        as current,
      count(distinct member_id) filter (where starts_at >= previous_from_at and starts_at < previous_to_at)
        as previous
      from blocked
  ),
  -- EVERY VALUE OF THE ENUM, whether or not anybody was barred that way this
  -- period (whole-branch review, Important B1). This was a plain `group by
  -- kind` and so dropped a bucket with no rows: a period in which nobody was
  -- suspended showed a one-bar chart, and a reader has no way to tell "nobody
  -- was suspended" from "this chart does not cover suspensions". 0119's
  -- nationality/vocal and 0120's participation_status/prize_cycle all already
  -- unnest their enum and LEFT JOIN the counts onto it for exactly that
  -- reason; this is the same shape, and the window filter rides in the join
  -- condition rather than a WHERE so the empty side survives it.
  blocks_by_kind as (
    select jsonb_agg(jsonb_build_object('key', k.kind, 'label', k.kind, 'count', k.n)
                     order by k.n desc, k.kind) as rows
      from (
        select v::text as kind, count(distinct b.member_id) as n
          from unnest(enum_range(null::public.member_block_kind)) as v
          left join blocked b
            on b.kind = v
           and b.starts_at >= b.from_at and b.starts_at < b.to_at
         group by v
      ) k
  ),
  monthly as (
    select jsonb_agg(jsonb_build_object('month', m.bucket, 'count', m.n) order by m.bucket) as rows
      from (
        select to_char(date_trunc('month', l.linked_at at time zone l.timezone), 'YYYY-MM') as bucket,
               count(distinct l.member_id) as n
          from link l
         where l.linked_at < l.to_at
           and l.linked_at >= (l.to_at - interval '12 months')
         group by 1
      ) m
  ),
  -- GROUPED BY THE NORMALISED VALUE, not the raw one (whole-branch review,
  -- Minor C1). These two grouped by `coalesce(m.discovery_source, '')` while
  -- labelling by the trimmed, nullif'd form, so 'Instagram' and ' Instagram '
  -- became two buckets both printed `Instagram`, and null, '' and '   '
  -- became up to three all printed `Not stated` -- on a chart that keys its
  -- axis on the LABEL, which is TopList's own dataKey. Trimming inside the
  -- group key makes `label` a pure function of `value` again (''
  -- -> 'Not stated', anything else -> itself), so `group by 1, 2` collapses
  -- to one bucket per real answer and the printed axis can no longer repeat
  -- itself. `id` stays the normalised value rather than the label, so the
  -- payload still distinguishes the bucket's identity from its wording.
  discovery as (
    select jsonb_agg(jsonb_build_object('id', d.value, 'label', d.label, 'count', d.n)
                     order by d.n desc, d.label) as rows
      from (
        select coalesce(btrim(m.discovery_source), '') as value,
               coalesce(nullif(btrim(m.discovery_source), ''), 'Not stated') as label,
               count(distinct l.member_id) as n
          from link l
          join public.members m on m.id = l.member_id
         where l.linked_at < l.to_at
         group by 1, 2
         order by count(distinct l.member_id) desc, 2
         limit 10
      ) d
  ),
  first_contact as (
    select jsonb_agg(jsonb_build_object('id', f.value, 'label', f.label, 'count', f.n)
                     order by f.n desc, f.label) as rows
      from (
        select coalesce(btrim(m.first_contact_origin), '') as value,
               coalesce(nullif(btrim(m.first_contact_origin), ''), 'Not stated') as label,
               count(distinct l.member_id) as n
          from link l
          join public.members m on m.id = l.member_id
         where l.linked_at < l.to_at
         group by 1, 2
         order by count(distinct l.member_id) desc, 2
         limit 10
      ) f
  )
  -- ONE PAYLOAD SHAPE ACROSS ALL THREE FUNCTIONS (whole-branch review, Minor
  -- C3). 0118 stripped nulls from `cards` only, 0119 from nothing and 0120
  -- from the whole object, which mattered because stripping IS the mechanism
  -- D13 rests on: a withheld figure is a null that must become an ABSENT key,
  -- and three different strip scopes are three chances for one of them to
  -- start sending `null` instead. jsonb_strip_nulls recurses, so one call at
  -- the top covers every level and every inner call is redundant; all three
  -- functions now carry exactly this one.
  --
  -- `stations` is coalesced for the same reason every other array here is.
  -- An empty `station` CTE cannot happen today (has_permission refuses an id
  -- that names no Company, so the loop above raises 42501 first), but
  -- uncoalesced it would have produced `null` -- and under the top-level
  -- strip that is an ABSENT key, which is D13's signal for "withheld", on a
  -- key D13 never withholds.
  select jsonb_strip_nulls(jsonb_build_object(
    'period', (
      select jsonb_build_object(
        'preset', p_preset,
        'from', min(from_date), 'to', min(to_date),
        'previous_from', min(previous_from_date), 'previous_to', min(previous_to_date))
        from station),
    -- EACH STATION'S OWN RESOLVED DATES, beside its own timezone (D5, as
    -- amended 2026-08-05). A preset resolves from now() at each Station's
    -- clock, so on the turn of a month two Stations in distant zones resolve
    -- DIFFERENT CALENDAR MONTHS -- the owner's ruling keeps that arithmetic
    -- and fixes the reporting instead. `period` above still carries the
    -- overall bounds; these are what let the screen notice they disagree and
    -- name the Stations that differ, rather than asserting a uniformity the
    -- query does not provide.
    'stations', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', id, 'name', name, 'timezone', timezone,
               'from', from_date, 'to', to_date) order by name)
        from station), '[]'::jsonb),
    'cards', (
      select jsonb_build_object(
        'listeners',     jsonb_build_object('current', c.listeners_current, 'previous', c.listeners_previous),
        'new_listeners', jsonb_build_object('current', c.new_current,       'previous', c.new_previous),
        'took_part',     case when v_participations
                              then jsonb_build_object('current', t.current, 'previous', t.previous)
                              else null end,
        'barred',        jsonb_build_object('current', b.current, 'previous', b.previous))
        from cards c, took_part t, barred b),
    'monthly',    coalesce((select rows from monthly), '[]'::jsonb),
    'breakdowns', jsonb_build_object(
                    'blocks_by_kind', coalesce((select rows from blocks_by_kind), '[]'::jsonb)),
    'top',        jsonb_build_object(
                    'discovery_source',      coalesce((select rows from discovery), '[]'::jsonb),
                    'first_contact_origin',  coalesce((select rows from first_contact), '[]'::jsonb)),
    'withheld',   case when v_participations then '[]'::jsonb
                       else jsonb_build_array(jsonb_build_object(
                              'figure', 'took_part', 'needs', 'participations.view')) end
  )) into v_result;

  return v_result;
end;
$$;

comment on function public.get_audience_dashboard(uuid[], text, date, date) is
  'The Audience dashboard for one Station or a consolidated set, both windows in one call. SECURITY INVOKER by design (spec D4): the select policies of 0035 apply inside it, so the multi-tenant cut is structural rather than restated -- the failure mode a DEFINER aggregate carries is a count that silently includes rows the caller may not read, which looks like a number rather than a defect. Refuses with 42501 unless the caller holds members.view in EVERY station named, and reports.consolidated in every one when more than one is named (D3), so a consolidated total can never contain a Station the caller could not have visited alone. New listeners are counted from member_company_links.linked_at, not members.created_at (D9): members are Organization-scoped and a listener arriving here from a sister Station is new HERE. Stock figures are measured as of each window''s end, so a historical period compares two true totals. listeners, new_listeners, took_part and barred ALL count distinct members, so none of them is the sum of its parts in a consolidated call: one listener linked to two selected Stations is one listener, and the screen says so beside each. The bar figure additionally treats a null member_blocks.company_id as the Organization-wide block 0032 says it is, and counts a block as still in force on is_member_blocked''s own definition (0032/0036: lifted_at is null AND ends_at is null or still ahead) -- a dated suspension ends because the date passed and nobody ever lifts it, so reading lifted_at alone would report a listener barred here whom every other screen calls free. stations carries each Station''s OWN resolved from/to dates beside its timezone (D5 as amended): a preset resolves at each Station''s clock, so on a month boundary two Stations in distant zones resolve different calendar months, and the screen names the ones that disagree rather than claiming a uniformity this function does not provide. Deleted and anonymised members are excluded throughout -- every figure on this panel counts the same population, took_part and barred/blocks_by_kind included, so the cards cannot contradict each other by silently counting different audiences under one page; the cost accepted is that activity by a since-erased listener is undercounted, the smaller error next to a page that could otherwise print more "took part" than "listeners" (D12b). took_part reads participations, gated by participations.view, which members.view does not imply: a caller lacking it gets the figure OMITTED and named in withheld, never zeroed (D13).';

grant execute on function public.get_audience_dashboard(uuid[], text, date, date) to authenticated;
