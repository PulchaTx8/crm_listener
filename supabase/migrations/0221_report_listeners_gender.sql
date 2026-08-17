-- supabase/migrations/0221_report_listeners_gender.sql

-- The gender block, Task 3: the Listeners export learns the column too.
--
-- WHY IT IS NOT OPTIONAL. This block exists so a campaign can be addressed to
-- part of an audience, and the screen that proves a criterion before a send is
-- the members list (which now filters on it). The export is the same question
-- asked in a form somebody can hand to a sponsor — and an operator who filters
-- by sex on screen and finds no such column in the spreadsheet has to conclude
-- one of the two is lying to them.
--
-- SEPARATE MIGRATION FROM 0220, and not because 0219's ADD VALUE rule applies
-- here (it does not — nothing below touches an enum). It is separate because
-- 0220 is about the FIELD and this is about a report, and a reader tracing why
-- `report_page_listeners` changed should find a file whose name says so.
--
-- LIVE DEFINITION FORWARD, as everywhere in this block. The body below is what
-- `pg_get_functiondef` returned before this migration ran, plus three lines:
-- the column in the CTE, the key in the row object, and this paragraph.
--
-- NOTHING ELSE MOVES. The guard (`report_guard`, members.view), the keyset
-- ordering, the archived-listener rule and the empty `withheld` array are
-- untouched — `withheld` in particular, because it is Block 8b's contract for
-- "these columns were suppressed for this caller" and a column added to a
-- report is not a column withheld from one.

create or replace function public.report_page_listeners(
  p_user_id uuid,
  p_company_ids uuid[],
  p_filters jsonb,
  p_cursor_at timestamptz,
  p_cursor_id uuid,
  p_limit integer)
returns table (
  sort_at timestamptz,
  sort_id uuid,
  row_data jsonb,
  total_count bigint,
  withheld text[])
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
      -- The gender block. Exported RAW ('M', 'F', 'N' or null) rather than
      -- spelled out, and that is the same choice every other coded column in
      -- this report already makes: `situation` ships its code, `consent` ships
      -- a boolean. A spreadsheet is read by a person AND by whatever they paste
      -- it into, and a translated word is the half that breaks when the reader
      -- switches language. Null stays null and is the fourth state — nobody
      -- asked — which is not the same as 'N'.
      m.gender,
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
      'gender',           f.gender,
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
