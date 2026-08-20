-- supabase/migrations/0254_pickup_and_participation_phone_last4.sql

-- Block 30a D1. The pickups and participations lists stop returning a
-- listener's telephone number and return its last four digits -- the same
-- SHAPE list_music_requests has returned since Block 22 (0191). The RULE is
-- not yet shared with it here: 0191's own masking is its own inline
-- `right(normalize_phone(...), 4)`, which disagrees with member_phone_last4
-- below at the under-four-digit edge (0256, whole-branch review F2, moves
-- 0191 onto this same function; see that migration's header for the case
-- probed live).
--
-- MASKING IN REACT WOULD NOT HAVE DONE THIS. The whole number would still be in
-- the HTML payload, in the browser's memory and in any error report the page
-- produces -- "a lock on a door standing in an open field", which is the
-- sentence services/music.ts already carries about the screen Block 22 fixed.
-- The whole number is now asked for one listener at a time through
-- reveal_member_field (0253), which records the asking.
--
-- RULE 2 OF EACH DOOR IS UNTOUCHED, and that is the half most easily lost: a
-- caller WITHOUT members.view still gets null, not four digits. Withheld and
-- masked are different facts -- one says "you may not know this person", the
-- other says "you may, and here is enough to recognise them" -- and the
-- narrowing must not answer the first question with "a little".
--
-- BOTH BODIES BELOW ARE THE LIVE DEFINITIONS (pg_get_functiondef), with the one
-- projection line changed. Re-deriving either from 0090 or 0095 would revert
-- every later repair silently, which has cost this project whole blocks.
--
-- total_count still comes from the same CTE the rows come from. The change is
-- to the projection only; a page and its count cannot narrow differently.

-- The rule, in one place, so list_pickups and list_participations below
-- cannot drift from each other or from src/lib/members/mask.ts. Digits only,
-- because normalize_phone (0031) is digits only; null under four, because a
-- mask that reveals a two-digit number is not a mask. list_music_requests
-- (0191) does not move onto this same function until 0256 -- three lists
-- share it only once this branch's last migration has run, not as of this
-- one.
create or replace function public.member_phone_last4(p_phone text)
returns text
language sql
immutable
set search_path = pg_catalog, public
as $$
  select case
    when length(d) < 4 then null
    else right(d, 4)
  end
  from (select public.normalize_phone(p_phone) as d) s;
$$;

revoke execute on function public.member_phone_last4(text) from public;
grant execute on function public.member_phone_last4(text) to authenticated;

-- DROP AND RECREATE, NOT CREATE OR REPLACE, for both functions below.
-- Postgres refuses a plain replace once a `returns table` column is renamed
-- ("cannot change return type of existing function", 42P13) -- reproduced
-- against this exact change before this file was written, rather than trusted
-- from the plan that preceded it. 0191's own header names the identical
-- restriction for list_music_requests, for the identical reason (member_phone
-- becoming member_phone_last4 there too). A replace would have kept the grant
-- below for free; a drop does not, so it is restated after each create, the
-- same way 0191 restates list_music_requests' own.
drop function if exists public.list_pickups(uuid, public.winner_status, uuid, text, timestamptz, uuid, boolean, integer);
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
  member_phone_last4 text,
  prize_id       uuid,
  prize_name     text,
  allows_return_to_stock boolean,
  promotion_id   uuid,
  promotion_name text,
  status         public.winner_status,
  deadline_at    timestamptz,
  draw_status    public.draw_status,
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
    select w.id, w.member_id, w.status, w.deadline_at, d.status as draw_status,
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
       -- THE FIFTH FACT, NOT A FIFTH RULE. A cancelled draw's winner is not
       -- awaiting anything: cancel_draw (0079) already reversed its unit back
       -- to linked and left winners.status at AWAITING_PICKUP on purpose (6a
       -- had no vocabulary for "un-awarded"). Without this line the row would
       -- list as a real pickup, and an operator could try to deliver a prize
       -- that was already un-awarded.
       and d.status <> 'CANCELLED'
       and (p_status is null       or w.status = p_status)
       and (p_promotion_id is null or pr.id = p_promotion_id)
       and (v_search is null       or m.full_name ilike '%' || v_search || '%'
                                   or public.normalize_phone(m.phone)
                                        like '%' || public.normalize_phone(v_search) || '%')
  )
  select f.id,
         f.member_id,
         case when v_names then f.full_name else null end,
         case when v_names then public.member_phone_last4(f.phone) else null end,
         f.prize_id,
         f.prize_name,
         f.allows_return_to_stock,
         f.promotion_id,
         f.promotion_name,
         f.status,
         f.deadline_at,
         f.draw_status,
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
  'One keyset page of the pickups list: every winner across every promotion of a Station, soonest deadline first (nulls -- no deadline at all -- last), with the status and promotion filters and a listener search the screen carries. SECURITY DEFINER, so what RLS used to do is done here by hand, in four rules: (1) promotions.view or a 42501 rather than an empty page (winners_select_by_promotion_view, 0075); (2) the listener''s name and the last four digits of the phone returned only to a caller holding members.view -- without it the list still lists, every row, with those two null; (3) a SEARCH without members.view returns nothing at all, because searching a field you may not read is an oracle (0090 argues this in full for the participants list); (4) an archived promotion''s winners hidden from everybody but the platform admin and the Organization''s owner, through the same is_owner_of_company predicate 0044''s policy names -- the exact rule Block 6c''s list_participations lost for five commits, caught only by tests/isolation. Plus a fifth fact that is not a fifth rule: a winner whose draw was CANCELLED is excluded outright, because cancel_draw (0079) reverses the unit but deliberately leaves winners.status at AWAITING_PICKUP, and RLS never hid that either -- this function is simply the first reader to treat AWAITING_PICKUP as "live" and so the first that has to say so. draw_status is returned alongside it (Task 9, edited in place) precisely because that fifth fact is a filter and not a promise: availableWinnerActions (src/components/draws/winner-actions.tsx) requires a drawStatus to decide whether a row''s actions may render at all, and a caller reading the real column here stays correct if this function''s own filtering ever changes, where a caller assuming COMPLETED by construction would not. total_count is computed from the same CTE the rows come from, so a page and its count cannot narrow differently.';

revoke execute on function public.list_pickups(uuid, public.winner_status, uuid, text, timestamptz, uuid, boolean, integer) from public;
grant execute on function public.list_pickups(uuid, public.winner_status, uuid, text, timestamptz, uuid, boolean, integer) to authenticated;

drop function if exists public.list_participations(uuid, uuid, public.participation_status, public.participation_source, timestamptz, timestamptz, text, boolean, uuid, timestamptz, uuid, boolean, integer);
create function public.list_participations(
  p_company_id         uuid,
  p_promotion_id       uuid    default null,
  p_status             public.participation_status default null,
  p_source             public.participation_source default null,
  p_from               timestamptz default null,
  p_to                 timestamptz default null,
  p_search             text    default null,
  p_answered_correctly boolean default null,
  p_option_id          uuid default null,
  p_cursor_at          timestamptz default null,
  p_cursor_id          uuid default null,
  p_walking_back       boolean default false,
  p_limit              integer default 26
)
returns table (
  id                       uuid,
  promotion_id             uuid,
  promotion_name           text,
  member_id                uuid,
  listener_name            text,
  listener_phone_last4     text,
  listener_cpf_last_digits text,
  status                   public.participation_status,
  source                   public.participation_source,
  participated_at          timestamptz,
  already_won              boolean,
  total_count              bigint
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  v_names  boolean;
  v_term   text := nullif(btrim(coalesce(p_search, '')), '');
  v_digits text;
begin
  -- BOTH codes, and the second one is the one a rewrite loses.
  --
  -- 0053's policy reads `has_permission('participations.view', company_id) and
  -- promotion_id in (select id from public.promotions)`, and that second term
  -- is not decoration: `public.promotions` is itself behind RLS, so it silently
  -- required promotions.view as well. A SECURITY DEFINER function that gated on
  -- participations.view alone would be MORE permissive than the query it
  -- replaces -- a caller who could see no promotion would suddenly read its
  -- participations. Caught by a test whose role was written with exactly that
  -- pair of permissions, which is why the pair is now named here.
  --
  -- It raises rather than returning nothing, which is the one deliberate
  -- difference from the policy: an operator who may not see the promotion gets
  -- a sentence instead of an empty screen they would read as "nobody entered".
  if not public.has_permission('participations.view', p_company_id)
     or not public.has_permission('promotions.view', p_company_id) then
    raise log 'list_participations denied: actor=% company=%', auth.uid(), p_company_id;
    raise exception 'permission denied: participations.view and promotions.view required'
      using errcode = '42501';
  end if;

  v_names := public.has_permission('members.view', p_company_id);

  -- A search this caller cannot see the target of matches nothing at all,
  -- rather than matching on a field they are not allowed to read.
  if v_term is not null and not v_names then
    return;
  end if;

  v_digits := nullif(regexp_replace(coalesce(v_term, ''), '[^0-9]', '', 'g'), '');

  return query
  with filtered as (
    select p.id,
           p.promotion_id,
           pr.name as promotion_name,
           p.member_id,
           m.full_name,
           m.phone,
           m.cpf_last_digits,
           p.status,
           p.source,
           p.participated_at,
           -- Block 6c: the column that explains why somebody vanishes from the
           -- list between rounds. Same rule as draw_eligible_participations
           -- (0076) -- a cancelled draw's winner has won nothing.
           exists (
             select 1
             from public.winners w
             join public.draws d on d.id = w.draw_id
             where w.member_id = p.member_id
               and d.promotion_id = p.promotion_id
               and d.status <> 'CANCELLED'
           ) as already_won
    from public.participations p
    join public.promotions pr
      on pr.id = p.promotion_id and pr.company_id = p.company_id
    join public.members m on m.id = p.member_id
    where p.company_id = p_company_id
      -- 0044's rule, restated because SECURITY DEFINER inherits none of it: an
      -- archived promotion is visible to the platform admin and the
      -- Organization's owner and to nobody else, so its entries are not in this
      -- Station's list either. Same predicate the policy names, through the same
      -- function, rather than a second expression of "who may see an archived
      -- row".
      and (pr.deleted_at is null or public.is_owner_of_company(pr.company_id))
      and (p_promotion_id is null or p.promotion_id = p_promotion_id)
      and (p_status is null or p.status = p_status)
      and (p_source is null or p.source = p_source)
      and (p_from is null or p.participated_at >= p_from)
      and (p_to is null or p.participated_at <= p_to)
      -- The search, over exactly the three fields the old select embedded plus
      -- the generated digits-only phone (0031), which is how a term typed with
      -- punctuation still finds a number.
      and (v_term is null
           or m.full_name ilike '%' || v_term || '%'
           or m.phone ilike '%' || v_term || '%'
           or (v_digits is not null
               and (m.cpf_last_digits ilike '%' || v_digits || '%'
                    or m.phone_normalized ilike '%' || v_digits || '%')))
      -- D5's two filters. Both read the one home of their rule rather than
      -- re-expressing it, and they AND with each other and with everything
      -- above, the way every other filter on this screen already does.
      and (p_answered_correctly is null
           or exists (
             select 1
             from public.promotion_participation_correctness(p.promotion_id) c
             where c.participation_id = p.id
               and c.answered_correctly = p_answered_correctly
           ))
      and (p_option_id is null
           or exists (
             select 1 from public.participation_answers a
             where a.participation_id = p.id and a.option_id = p_option_id
           ))
  )
  select f.id,
         f.promotion_id,
         f.promotion_name,
         f.member_id,
         -- Null for an anonymised listener AND for a caller without
         -- members.view, and the grid must not tell those apart (0034 scrubs
         -- full_name, and this branch withholds it).
         case when v_names then f.full_name else null end,
         case when v_names then public.member_phone_last4(f.phone) else null end,
         case when v_names then f.cpf_last_digits else null end,
         f.status,
         f.source,
         f.participated_at,
         f.already_won,
         -- The total of the FILTERED set, computed from the same CTE the rows
         -- come from, so the count and the page cannot narrow differently --
         -- the defect the old code avoided by building both reads from one
         -- builder, kept here by having only one query.
         (select count(*) from filtered) as total_count
  from filtered f
  where p_cursor_at is null
     or p_cursor_id is null
     or (case when p_walking_back
              then (f.participated_at, f.id) > (p_cursor_at, p_cursor_id)
              else (f.participated_at, f.id) < (p_cursor_at, p_cursor_id)
         end)
  -- Newest first, tie-broken by id: exactly what participations_listing_idx
  -- (0052) carries, and the reason the ordering is fixed rather than chosen.
  -- Walking back reads ascending and the caller turns the page around, which is
  -- what the old keysetPage did.
  order by
    case when p_walking_back then f.participated_at end asc,
    case when p_walking_back then f.id end asc,
    case when not p_walking_back then f.participated_at end desc,
    case when not p_walking_back then f.id end desc
  limit p_limit;
end;
$$;

comment on function public.list_participations(uuid, uuid, public.participation_status, public.participation_source, timestamptz, timestamptz, text, boolean, uuid, timestamptz, uuid, boolean, integer) is
  'One keyset page of the participants list, with every filter the screen carries: Station, promotion, status, source, date range, listener search, and Block 6c''s two -- answered correctly, and chose a given option -- which AND with each other and with the rest. Also returns already_won, which is what explains a listener vanishing between draw rounds. SECURITY DEFINER, so what RLS used to do is done here by hand: participations.view AND promotions.view or a 42501 rather than an empty page; an archived promotion''s entries only to the platform admin and the Organization''s owner (0044''s rule, which 0053 used to inherit through a sub-select); the listener''s name, the last four digits of the phone, and the document only to a caller holding members.view, and the list still lists without it; and a SEARCH without members.view returns nothing at all, because searching a field you may not read is an oracle -- which is precisely what the old query''s !inner embed produced. total_count is computed from the same CTE the rows come from, so a page and its count cannot narrow differently.';

revoke execute on function public.list_participations(uuid, uuid, public.participation_status, public.participation_source, timestamptz, timestamptz, text, boolean, uuid, timestamptz, uuid, boolean, integer) from public;
grant execute on function public.list_participations(uuid, uuid, public.participation_status, public.participation_source, timestamptz, timestamptz, text, boolean, uuid, timestamptz, uuid, boolean, integer) to authenticated;
