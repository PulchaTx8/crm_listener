-- supabase/migrations/0124_report_pages_a.sql

-- Block 8b, Task 5: the first two page functions.
--
-- ONE SIGNATURE FOR ALL FIVE, and the two departures from the list RPCs they
-- mirror are both deliberate:
--
--   1. p_user_id is an ARGUMENT. The list RPCs ask has_permission about
--      auth.uid(); these ask has_permission_for about a named user, because the
--      worker generating the file is never the person entitled to it (0121's
--      header argues it in full). The same function therefore serves the
--      request path -- which passes auth.uid() to preflight the row ceiling,
--      before any run row exists -- and the worker, which passes
--      report_runs.requested_by.
--
--   2. total_count AND withheld come back WITH the rows. 0090 established the
--      first half ("total_count is computed from the same CTE the rows come
--      from, so a page and its count cannot narrow differently"); this block
--      needs the same guarantee for the withheld set, because a file whose
--      columns disagree with the list of columns it SAYS were withheld is worse
--      than either error alone.
--
-- p_company_ids is an ARRAY because a consolidated report is one file. The
-- guard refuses the WHOLE call if any named Station is unreadable -- it does
-- not quietly drop that Station and return the rest, which would be a report
-- wrong in a way nothing on its face reveals. reports.consolidated is checked
-- in request_report (0127), not here: this function is also the preflight for
-- an ordinary single-Station request, and checking it here would refuse the
-- preflight for a reason the operator has not reached yet.

-- ---------------------------------------------------------------------------
-- The shared guard. A function rather than five copies, for the reason this
-- whole block exists.
-- ---------------------------------------------------------------------------

create function public.report_guard(
  p_user_id     uuid,
  p_company_ids uuid[],
  p_permission  text
)
returns void
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  v_company uuid;
begin
  -- Before anything else. A null identity is the worker before it has been told
  -- whose report this is, and it must be an error rather than a query that
  -- happens to return nothing.
  if p_user_id is null then
    raise exception 'a report needs an identity' using errcode = '42501';
  end if;

  if p_company_ids is null or cardinality(p_company_ids) = 0 then
    raise exception 'at least one station is required' using errcode = '22023';
  end if;

  foreach v_company in array p_company_ids loop
    if not public.has_permission_for(p_user_id, p_permission, v_company) then
      raise log 'report denied: user=% company=% permission=%',
        p_user_id, v_company, p_permission;
      raise exception 'permission denied for this station' using errcode = '42501';
    end if;
  end loop;
end;
$$;

comment on function public.report_guard(uuid, uuid[], text) is
  'Block 8b. The opening of every page function: an identity, a non-empty Station list, and the named permission in EVERY Station or a 42501 for the whole call. Refusing the whole call rather than dropping the unreadable Station is the point -- a consolidated file silently missing one radio is wrong in a way nothing on its face reveals.';

revoke execute on function public.report_guard(uuid, uuid[], text) from public;
grant execute on function public.report_guard(uuid, uuid[], text) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 1. Listeners.
--
-- THE UNIT IS THE LINK, NOT THE MEMBER. 8a's D9 settled that a new listener at
-- a Station is a new member_company_links row, because an Organization-scoped
-- member reaching a second radio is new to that radio and not to the group.
-- Sorting and filtering both use linked_at, so this export and the Audience
-- panel cannot disagree about who arrived in a period.
--
-- NO WITHHELD SET, and that is a property of this report rather than an
-- omission: members.view gates the entire listing, so a caller gets every
-- column or a 42501. The provenance block prints that fact, because a file
-- silent about it is indistinguishable from one that quietly dropped a column.
--
-- THERE IS NO CPF COLUMN. 0031 stores a SHA-256 and three digits, and says the
-- raw number "is stored nowhere and appears in no query log". No export can
-- undo that and none should; cpf_last_digits is what a person confirms out
-- loud, and it is what ships.
-- ---------------------------------------------------------------------------

create function public.report_page_listeners(
  p_user_id     uuid,
  p_company_ids uuid[],
  p_filters     jsonb,
  p_cursor_at   timestamptz,
  p_cursor_id   uuid,
  p_limit       integer
)
returns table (
  sort_at     timestamptz,
  sort_id     uuid,
  row_data    jsonb,
  total_count bigint,
  withheld    text[]
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  v_from      timestamptz := nullif(p_filters ->> 'from', '')::timestamptz;
  v_to        timestamptz := nullif(p_filters ->> 'to', '')::timestamptz;
  v_situation text        := nullif(p_filters ->> 'situation', '');
  v_age_min   integer     := nullif(p_filters ->> 'age_min', '')::integer;
  v_age_max   integer     := nullif(p_filters ->> 'age_max', '')::integer;
  v_consent   boolean     := nullif(p_filters ->> 'consent', '')::boolean;
  v_now       timestamptz := now();
begin
  perform public.report_guard(p_user_id, p_company_ids, 'members.view');

  return query
  with matched as (
    select
      mcl.linked_at as k_at,
      m.id          as k_id,
      m.full_name, m.phone, m.email, m.cpf_last_digits, m.birth_date,
      m.city, m.state, m.discovery_source,
      c.name as company_name,
      m.deleted_at,
      -- The active-block window is 0032's and 0036's, restated because this is
      -- SECURITY DEFINER and RLS is not applying: lifted_at null, started, not
      -- yet ended. A block with a NULL company_id is Organization-wide and
      -- applies to every Station -- 8a's §3.1 counts it once per Station for
      -- the same reason.
      exists (
        select 1 from public.member_blocks b
        where b.member_id = m.id
          and (b.company_id is null or b.company_id = mcl.company_id)
          and b.lifted_at is null
          and b.starts_at <= v_now
          and (b.ends_at is null or b.ends_at > v_now)
      ) as is_blocked,
      exists (
        select 1 from public.member_consents mc
        where mc.member_id = m.id
          and mc.company_id = mcl.company_id
          and mc.granted
      ) as has_consent
    from public.member_company_links mcl
    join public.members m on m.id = mcl.member_id
    join public.companies c on c.id = mcl.company_id
    where mcl.company_id = any(p_company_ids)
      and (v_from is null or mcl.linked_at >= v_from)
      and (v_to   is null or mcl.linked_at <  v_to)
      -- An age band is a birth_date range, never an age computed per row:
      -- computing it in the predicate defeats members_birth_date_idx (0036) and
      -- scans the Organization. `>`, not `>=`, on the lower bound: somebody born
      -- exactly age_max + 1 years ago today has had that birthday and is
      -- outside the band. services/members.ts carries the identical reasoning,
      -- and the two must agree or the screen and its export disagree about who
      -- is thirty.
      and (v_age_max is null
           or m.birth_date > (current_date - make_interval(years => v_age_max + 1)))
      and (v_age_min is null
           or m.birth_date <= (current_date - make_interval(years => v_age_min)))
  ),
  situated as (
    select mt.*,
      case
        when mt.deleted_at is not null then 'archived'
        when mt.is_blocked then 'blocked'
        else 'active'
      end as situation
    from matched mt
  ),
  filtered as (
    select s.* from situated s
    where (v_situation is null or s.situation = v_situation)
      and (v_consent is null or s.has_consent = v_consent)
      -- Archived listeners are excluded unless explicitly asked for. An export
      -- that silently included erased people would defeat Block 3's whole
      -- stance; one that could never show them would make the archive
      -- unauditable.
      and (v_situation = 'archived' or s.deleted_at is null)
  ),
  counted as (select count(*) as n from filtered)
  select
    f.k_at,
    f.k_id,
    jsonb_build_object(
      'station',          f.company_name,
      'name',             f.full_name,
      'phone',            f.phone,
      'email',            f.email,
      'cpf_last_digits',  f.cpf_last_digits,
      'birth_date',       f.birth_date,
      'city',             f.city,
      'state',            f.state,
      'discovery_source', f.discovery_source,
      'situation',        f.situation,
      'consent',          f.has_consent,
      'linked_at',        f.k_at
    ),
    counted.n,
    '{}'::text[]
  from filtered f, counted
  where p_cursor_at is null
     or (f.k_at, f.k_id) < (p_cursor_at, p_cursor_id)
  order by f.k_at desc, f.k_id desc
  limit p_limit;
end;
$$;

comment on function public.report_page_listeners(uuid, uuid[], jsonb, timestamptz, uuid, integer) is
  'One keyset page of the listeners export, newest link first. The unit is the member_company_links row, not the member, because 8a''s D9 settled that a new listener at a Station is a new link -- so this export and the Audience panel cannot disagree about who arrived in a period. members.view gates the whole listing, so there is no withheld set: a caller gets every column or a 42501. No CPF column exists beyond cpf_last_digits, because 0031 stores only a SHA-256 and three digits.';

-- ---------------------------------------------------------------------------
-- 2. Participations.
--
-- TWO PERMISSION CODES, AND THE SECOND IS THE ONE A REWRITE LOSES. 0090's
-- header records it: 0053's policy read has_permission('participations.view',
-- company_id) AND promotion_id in (select id from public.promotions), and
-- public.promotions is itself behind RLS, so that second term silently required
-- promotions.view as well. A SECURITY DEFINER function gating on
-- participations.view alone is MORE PERMISSIVE than the query it replaces.
--
-- THE ARCHIVED-PROMOTION RULE is 0044's, restated the way 0090 restates it, and
-- through is_owner_of_company_FOR -- because asking is_owner_of_company inside
-- the worker would ask about auth.uid(), get null, and quietly answer "not the
-- owner". That failure is fail-closed and therefore not a leak; it is worse
-- than a leak in one specific way, which is that an owner's export would be
-- missing exactly the rows his screen was showing him, with nothing saying why.
--
-- The listener's identity is the withheld set, exactly as in 0090: a caller
-- with participations.view but not members.view gets every row and no name,
-- phone or document -- and those keys are ABSENT from row_data rather than
-- null, so the file cannot print an empty phone column that reads as "these
-- listeners have no phone".
-- ---------------------------------------------------------------------------

create function public.report_page_participations(
  p_user_id     uuid,
  p_company_ids uuid[],
  p_filters     jsonb,
  p_cursor_at   timestamptz,
  p_cursor_id   uuid,
  p_limit       integer
)
returns table (
  sort_at     timestamptz,
  sort_id     uuid,
  row_data    jsonb,
  total_count bigint,
  withheld    text[]
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  v_from      timestamptz := nullif(p_filters ->> 'from', '')::timestamptz;
  v_to        timestamptz := nullif(p_filters ->> 'to', '')::timestamptz;
  v_promotion uuid        := nullif(p_filters ->> 'promotion_id', '')::uuid;
  v_status    text        := nullif(p_filters ->> 'status', '');
  v_source    text        := nullif(p_filters ->> 'source', '');
  v_names     boolean := true;
  v_withheld  text[]  := '{}';
  v_company   uuid;
begin
  perform public.report_guard(p_user_id, p_company_ids, 'participations.view');

  -- The second code, per 0090. Checked in every Station, like the first.
  foreach v_company in array p_company_ids loop
    if not public.has_permission_for(p_user_id, 'promotions.view', v_company) then
      raise log 'report denied: user=% company=% permission=promotions.view',
        p_user_id, v_company;
      raise exception 'permission denied for this station' using errcode = '42501';
    end if;
  end loop;

  -- The identity columns ride on a third code the caller may not hold. ONE
  -- evaluation, used both for the row shape and for the withheld list, so the
  -- two cannot disagree. Withheld if it is missing in ANY named Station: a
  -- consolidated file with names for one radio and blanks for another is a
  -- worse artefact than one with no names at all.
  foreach v_company in array p_company_ids loop
    if not public.has_permission_for(p_user_id, 'members.view', v_company) then
      v_names := false;
    end if;
  end loop;

  if not v_names then
    v_withheld := array['name', 'phone', 'cpf_last_digits'];
  end if;

  return query
  with matched as (
    select
      p.participated_at as k_at,
      p.id              as k_id,
      pr.name as promotion_name,
      c.name  as company_name,
      p.status, p.source,
      m.full_name, m.phone, m.cpf_last_digits
    from public.participations p
    join public.promotions pr
      on pr.id = p.promotion_id and pr.company_id = p.company_id
    join public.companies c on c.id = p.company_id
    join public.members m on m.id = p.member_id
    where p.company_id = any(p_company_ids)
      -- 0044's rule, restated because SECURITY DEFINER inherits none of it.
      and (pr.deleted_at is null
           or public.is_owner_of_company_for(p_user_id, pr.company_id))
      and (v_from      is null or p.participated_at >= v_from)
      and (v_to        is null or p.participated_at <  v_to)
      and (v_promotion is null or p.promotion_id = v_promotion)
      and (v_status    is null or p.status::text = v_status)
      and (v_source    is null or p.source::text = v_source)
  ),
  counted as (select count(*) as n from matched)
  select
    mt.k_at,
    mt.k_id,
    jsonb_build_object(
      'station',         mt.company_name,
      'promotion',       mt.promotion_name,
      'status',          mt.status,
      'source',          mt.source,
      'participated_at', mt.k_at
    )
    -- Absent, not null. `||` adds the keys only when the caller may have them,
    -- and v_withheld above names exactly the keys this branch withholds.
    || case when v_names then jsonb_build_object(
         'name',            mt.full_name,
         'phone',           mt.phone,
         'cpf_last_digits', mt.cpf_last_digits)
       else '{}'::jsonb end,
    counted.n,
    v_withheld
  from matched mt, counted
  where p_cursor_at is null
     or (mt.k_at, mt.k_id) < (p_cursor_at, p_cursor_id)
  order by mt.k_at desc, mt.k_id desc
  limit p_limit;
end;
$$;

comment on function public.report_page_participations(uuid, uuid[], jsonb, timestamptz, uuid, integer) is
  'One keyset page of the participations export. THREE permission codes: participations.view and promotions.view are both required (0090''s header explains why the second is the one a rewrite loses -- RLS on public.promotions silently supplied it), and members.view decides whether the listener''s name, phone and document are present at all. Withheld keys are ABSENT from row_data and named in the withheld array, never null, because an empty phone column in a spreadsheet is a false statement about people.';

revoke execute on function public.report_page_listeners(uuid, uuid[], jsonb, timestamptz, uuid, integer) from public;
revoke execute on function public.report_page_participations(uuid, uuid[], jsonb, timestamptz, uuid, integer) from public;
grant execute on function public.report_page_listeners(uuid, uuid[], jsonb, timestamptz, uuid, integer) to authenticated, service_role;
grant execute on function public.report_page_participations(uuid, uuid[], jsonb, timestamptz, uuid, integer) to authenticated, service_role;
