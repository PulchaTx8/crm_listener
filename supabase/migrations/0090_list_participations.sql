-- Block 6c, Task 5: the participants list, as one function.
--
-- It was a PostgREST query with two embeds, a keyset cursor and a search over
-- the listener's name and phone. It becomes an RPC because the two filters this
-- block adds -- did they answer correctly, did they choose this option -- are
-- not expressible over an embed, and the alternatives lose more than they save
-- (spec 5: a view breaks the embed that IS the search; two round trips put a
-- promotion's whole participation list into a URL).
--
-- WHAT HAD TO BE CARRIED ACROSS BY HAND, because SECURITY DEFINER means RLS is
-- no longer doing it:
--
--   * participations.view at this Station, or nothing at all;
--   * the listener's name, phone and document are returned ONLY to a caller
--     holding members.view. Without it the list still lists -- every row, with
--     those three null -- which is what the plain (non-`!inner`) select did;
--   * a SEARCH without members.view returns NOTHING. That is not an oversight
--     carried over: a caller who may not read a listener's name cannot search
--     by it either, and the old `!inner` variant produced exactly this. The
--     alternative -- searching a field the caller cannot see -- is an oracle;
--   * an ARCHIVED promotion's entries are hidden from everybody except the
--     platform admin and the Organization's owner. That one was MISSED on the
--     first writing of this file and found by tests/isolation, which is the
--     whole argument for the suite: 0044's promotions policy reads
--     `deleted_at is null or is_owner_of_company(company_id)`, and 0053's
--     participations policy inherited it for free through the
--     `promotion_id in (select id from public.promotions)` sub-select. A
--     SECURITY DEFINER function inherits nothing, so a rule that used to cost
--     no words now costs these.
--
-- The keyset and the search both worked before this file existed, so
-- 11_filtered_hat.test.sql walks a page boundary forwards and backwards and
-- searches by name, by phone and by document digits. Testing only the two new
-- filters would let this rewrite regress the part nobody asked to change.

create function public.list_participations(
  p_company_id         uuid,
  p_promotion_id       uuid    default null,
  p_status             public.participation_status default null,
  p_source             public.participation_source default null,
  p_from               timestamptz default null,
  p_to                 timestamptz default null,
  p_search             text    default null,
  p_answered_correctly boolean default null,
  p_option_id          uuid    default null,
  p_cursor_at          timestamptz default null,
  p_cursor_id          uuid    default null,
  p_walking_back       boolean default false,
  p_limit              integer default 26
)
returns table (
  id                       uuid,
  promotion_id             uuid,
  promotion_name           text,
  member_id                uuid,
  listener_name            text,
  listener_phone           text,
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
         case when v_names then f.phone else null end,
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
  'One keyset page of the participants list, with every filter the screen carries: Station, promotion, status, source, date range, listener search, and Block 6c''s two -- answered correctly, and chose a given option -- which AND with each other and with the rest. Also returns already_won, which is what explains a listener vanishing between draw rounds. SECURITY DEFINER, so what RLS used to do is done here by hand: participations.view AND promotions.view or a 42501 rather than an empty page; an archived promotion''s entries only to the platform admin and the Organization''s owner (0044''s rule, which 0053 used to inherit through a sub-select); the listener''s name, phone and document only to a caller holding members.view, and the list still lists without it; and a SEARCH without members.view returns nothing at all, because searching a field you may not read is an oracle -- which is precisely what the old query''s !inner embed produced. total_count is computed from the same CTE the rows come from, so a page and its count cannot narrow differently.';

revoke execute on function public.list_participations(uuid, uuid, public.participation_status, public.participation_source, timestamptz, timestamptz, text, boolean, uuid, timestamptz, uuid, boolean, integer) from public;
grant execute on function public.list_participations(uuid, uuid, public.participation_status, public.participation_source, timestamptz, timestamptz, text, boolean, uuid, timestamptz, uuid, boolean, integer) to authenticated;
