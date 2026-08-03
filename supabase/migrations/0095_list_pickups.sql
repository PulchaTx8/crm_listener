-- supabase/migrations/0095_list_pickups.sql

-- Block 6d, Task 5: the pickups list, as one function.
--
-- Design spec 6.2: one row per winner across every promotion of the Station,
-- keyset paginated on (deadline_at, id) ascending -- soonest first, because the
-- row that needs attention is the one about to expire. draws/winners never had
-- a screen before this block, so this was never a PostgREST query later
-- replaced by an RPC; it is written as one from the start, for the same reason
-- list_participations (0090) had to become one: the keyset cursor and the
-- search are not expressible over a PostgREST embed.
--
-- WHAT RLS WOULD HAVE DONE FOR FREE, and so has to be done here by hand --
-- 0090's own header makes the same list for the participants screen, and this
-- is the identical shape of problem applied to a second list:
--
--   * RULE 1 -- promotions.view at this Station, or a 42501 rather than an
--     empty page. winners_select_by_promotion_view (0075) reads exactly this
--     permission; an empty page would be indistinguishable from a Station
--     where nobody has won anything;
--   * RULE 2 -- the listener's name and phone are returned ONLY to a caller
--     holding members.view. Without it the list still lists -- every row, with
--     those two null -- which is what a plain (non-`!inner`) embed would have
--     given. get_draw (0080) answers this question differently for the
--     winners of ONE draw -- the owner's ruling there was that promotions.view
--     alone earns the names -- and the design spec's D7 records that Pickups
--     and that single-draw drill-down now deliberately disagree;
--   * RULE 3 -- a SEARCH without members.view returns NOTHING, not a widened
--     net over what the caller cannot read. 0090 argues this at length for the
--     participants list and the reasoning is the same rule applied here:
--     searching a field you may not read answers "is there a listener called X
--     here?" to somebody forbidden the name itself;
--   * RULE 4 -- THE ONE BLOCK 6C LOST FOR FIVE COMMITS. an ARCHIVED
--     promotion's winners are hidden from everybody but the platform admin and
--     the Organization's owner. 0044's promotions policy reads `deleted_at is
--     null or is_owner_of_company(company_id)`; a plain query joining
--     promotions inherited that for free, and this function inherits nothing,
--     so the same predicate is restated here, through the same helper 0044
--     names -- not a second expression of "who may see an archived row".
--
-- Nulls last, and the ordering and the cursor filter agree on it in as many
-- words as keysetFilter's own contract (src/lib/keyset.ts) uses: deadline_at
-- is nullable and the null means a winner with no deadline at all (0075), so
-- those rows are a terminal region the paging has to be able to REACH, not
-- merely tolerate. Plain tuple comparison on (deadline_at, id) goes blind the
-- moment either side is null -- Postgres's three-valued logic makes `NULL >
-- x` neither true nor false -- so the cursor filter below is written out by
-- region (dated vs. null) rather than as one `(a, b) > (c, d)` the way
-- list_participations could get away with, because participated_at there is
-- never null.

create function public.list_pickups(
  p_company_id   uuid,
  p_status       public.winner_status default null,
  p_promotion_id uuid    default null,
  p_search       text    default null,
  p_cursor_at    timestamptz default null,
  p_cursor_id    uuid    default null,
  p_walking_back boolean default false,
  p_limit        integer default 26
)
returns table (
  winner_id      uuid,
  member_id      uuid,
  member_name    text,
  member_phone   text,
  prize_id       uuid,
  prize_name     text,
  allows_return_to_stock boolean,
  promotion_id   uuid,
  promotion_name text,
  status         public.winner_status,
  deadline_at    timestamptz,
  total_count    integer
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  v_names  boolean;
  v_search text := nullif(btrim(coalesce(p_search, '')), '');
begin
  -- RULE 1. The permission, first, and a refusal rather than an empty page.
  if not public.has_permission('promotions.view', p_company_id) then
    raise log 'list_pickups denied: actor=% company=%', auth.uid(), p_company_id;
    raise exception 'permission denied: promotions.view required'
      using errcode = '42501';
  end if;

  -- RULE 2. Identity only to a caller who may read it.
  v_names := public.has_permission('members.view', p_company_id);

  -- RULE 3. Searching a field you may not read is an oracle: it answers "is
  -- there a listener called X here?" to somebody forbidden the name itself.
  -- Returning nothing is the only honest answer.
  if v_search is not null and not v_names then
    return;
  end if;

  return query
  with visible as (
    select w.id, w.member_id, w.status, w.deadline_at,
           pz.id as prize_id, pz.name as prize_name, pz.allows_return_to_stock,
           pr.id as promotion_id, pr.name as promotion_name,
           m.full_name, m.phone
      from public.winners w
      join public.draws d            on d.id = w.draw_id
      join public.promotions pr      on pr.id = d.promotion_id
      join public.promotion_prizes l on l.id = w.promotion_prize_id
      join public.prizes pz          on pz.id = l.prize_id
      join public.members m          on m.id = w.member_id
     where w.company_id = p_company_id
       -- RULE 4. THE ONE BLOCK 6C LOST FOR FIVE COMMITS.
       and (pr.deleted_at is null or public.is_owner_of_company(pr.company_id))
       and (p_status is null       or w.status = p_status)
       and (p_promotion_id is null or pr.id = p_promotion_id)
       and (v_search is null       or m.full_name ilike '%' || v_search || '%'
                                   or public.normalize_phone(m.phone)
                                        like '%' || public.normalize_phone(v_search) || '%')
  )
  select f.id,
         f.member_id,
         case when v_names then f.full_name else null end,
         case when v_names then f.phone else null end,
         f.prize_id,
         f.prize_name,
         f.allows_return_to_stock,
         f.promotion_id,
         f.promotion_name,
         f.status,
         f.deadline_at,
         -- The total of the FILTERED set, computed from the SAME CTE the rows
         -- come from, so a page and its count cannot narrow differently
         -- (0090's rule, restated here).
         (select count(*) from visible)::integer as total_count
  from visible f
  -- No cursor at all (p_cursor_id null) means the first page: take everything,
  -- subject only to the ORDER BY and LIMIT below. Otherwise p_cursor_at itself
  -- carries meaning: non-null means the cursor sat on a DATED row, and null
  -- means it sat on the terminal null-deadline row -- a state a plain
  -- "p_cursor_at is null" check cannot express here the way it could for
  -- list_participations, because a real cursor built from a null-deadline
  -- winner has to be resumable too.
  where p_cursor_id is null
     or (
       case when p_walking_back then
         -- Toward earlier positions in display order (deadline_at asc, nulls
         -- last): every dated row precedes every null row, so walking back
         -- FROM the null region reaches every dated row before any earlier
         -- null one; walking back from a dated row reaches only smaller dated
         -- rows, since nulls never precede a dated row.
         case
           when p_cursor_at is not null then
             f.deadline_at < p_cursor_at
             or (f.deadline_at = p_cursor_at and f.id < p_cursor_id)
           else
             f.deadline_at is not null
             or (f.deadline_at is null and f.id < p_cursor_id)
         end
       else
         -- Toward later positions: from a dated row, larger dated rows AND
         -- (eventually) the whole trailing null region; from the null region,
         -- only later null rows -- there is nothing past it.
         case
           when p_cursor_at is not null then
             f.deadline_at > p_cursor_at
             or (f.deadline_at = p_cursor_at and f.id > p_cursor_id)
             or f.deadline_at is null
           else
             f.deadline_at is null and f.id > p_cursor_id
         end
       end
     )
  -- Soonest first. Walking back reads the opposite of display order (the rows
  -- nearest the cursor come out first, so LIMIT keeps the closest ones) and
  -- the caller reverses the small batch back into display order, exactly the
  -- way list_participations' own keyset does it for participated_at desc.
  order by
    case when p_walking_back then f.deadline_at end desc nulls first,
    case when p_walking_back then f.id end desc,
    case when not p_walking_back then f.deadline_at end asc nulls last,
    case when not p_walking_back then f.id end asc
  limit p_limit;
end;
$$;

comment on function public.list_pickups(uuid, public.winner_status, uuid, text, timestamptz, uuid, boolean, integer) is
  'One keyset page of the pickups list: every winner across every promotion of a Station, soonest deadline first (nulls -- no deadline at all -- last), with the status and promotion filters and a listener search the screen carries. SECURITY DEFINER, so what RLS used to do is done here by hand, in four rules: (1) promotions.view or a 42501 rather than an empty page (winners_select_by_promotion_view, 0075); (2) the listener''s name and phone returned only to a caller holding members.view -- without it the list still lists, every row, with those two null; (3) a SEARCH without members.view returns nothing at all, because searching a field you may not read is an oracle (0090 argues this in full for the participants list); (4) an archived promotion''s winners hidden from everybody but the platform admin and the Organization''s owner, through the same is_owner_of_company predicate 0044''s policy names -- the exact rule Block 6c''s list_participations lost for five commits, caught only by tests/isolation. total_count is computed from the same CTE the rows come from, so a page and its count cannot narrow differently.';

revoke execute on function public.list_pickups(uuid, public.winner_status, uuid, text, timestamptz, uuid, boolean, integer) from public;
grant execute on function public.list_pickups(uuid, public.winner_status, uuid, text, timestamptz, uuid, boolean, integer) to authenticated;
