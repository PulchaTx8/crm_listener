-- supabase/migrations/0126_report_page.sql

-- Block 8b, Task 7: one door for five queries.
--
-- The worker knows nothing about report internals: it calls this, walks the
-- cursor, and stops. request_report (0127) calls the SAME function with
-- p_limit => 1 to preflight the row ceiling, which is why the ceiling has no
-- second implementation anywhere -- total_count rides back on this call.
--
-- THE `else` BRANCH IS NOT DEFENSIVE PROGRAMMING. report_type is an enum, and a
-- value added later without a branch here would fall out of the CASE returning
-- nothing at all -- an empty file, which reads exactly like a report of a
-- Station with no data. Raising is the only outcome that cannot be mistaken for
-- a result.
--
-- A PANEL TYPE RAISES rather than dispatching. A panel's numbers are captured
-- at request time under the caller's own rights (D2), because the three
-- aggregates are SECURITY INVOKER and granted to authenticated only; there is
-- deliberately no path by which the worker re-queries them, and asking for one
-- here is a programming error rather than an empty result.

create function public.report_page(
  p_user_id     uuid,
  p_report_type public.report_type,
  p_company_ids uuid[],
  p_filters     jsonb,
  -- Defaulted, unlike the five page functions this dispatches to, and for a
  -- reason outside SQL: `supabase gen types` marks a defaulted parameter
  -- optional, and the worker passes no cursor on the first page. Without the
  -- defaults the generated Args type requires a string where the caller has
  -- null, and the only way through is a cast that would silently outlive the
  -- reason for it.
  p_cursor_at   timestamptz default null,
  p_cursor_id   uuid        default null,
  p_limit       integer     default 1000
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
begin
  case p_report_type
    when 'LISTENERS' then
      return query select * from public.report_page_listeners(
        p_user_id, p_company_ids, p_filters, p_cursor_at, p_cursor_id, p_limit);
    when 'PARTICIPATIONS' then
      return query select * from public.report_page_participations(
        p_user_id, p_company_ids, p_filters, p_cursor_at, p_cursor_id, p_limit);
    when 'WINNERS' then
      return query select * from public.report_page_winners(
        p_user_id, p_company_ids, p_filters, p_cursor_at, p_cursor_id, p_limit);
    when 'MUSIC_REQUESTS' then
      return query select * from public.report_page_music_requests(
        p_user_id, p_company_ids, p_filters, p_cursor_at, p_cursor_id, p_limit);
    when 'MOVEMENTS' then
      return query select * from public.report_page_movements(
        p_user_id, p_company_ids, p_filters, p_cursor_at, p_cursor_id, p_limit);
    else
      raise exception 'report type % has no page function', p_report_type
        using errcode = '22023';
  end case;
end;
$$;

comment on function public.report_page(uuid, public.report_type, uuid[], jsonb, timestamptz, uuid, integer) is
  'The one door the worker and request_report both use. Dispatches to the five listing page functions; raises 22023 for a panel type, because a panel''s numbers are captured at request time under the caller''s own rights (D2) and are never re-queried here. The else branch raises rather than returning nothing: an enum value added without a branch would otherwise produce an empty file, which reads as a Station with no data.';

revoke execute on function public.report_page(uuid, public.report_type, uuid[], jsonb, timestamptz, uuid, integer) from public;
grant execute on function public.report_page(uuid, public.report_type, uuid[], jsonb, timestamptz, uuid, integer) to authenticated, service_role;
