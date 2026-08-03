-- supabase/migrations/0096_list_movements.sql

-- Block 6d, Task 6: the whole ledger, as one list.
--
-- inventory_movements already has a working RLS select policy
-- (inventory_movements_select_inventory_view, 0029), gated on inventory.view
-- alone: the ROW itself needs no function. What does is the promotion NAME a
-- movement is filed under. inventory_movements.promotion_prize_id (0045) is
-- nullable WITH MEANING -- null is a purchase entry or a stock adjustment,
-- which belongs to no promotion at all, on purpose, never "not yours to
-- see". A plain PostgREST embed of promotion_prizes -> promotions inherits
-- promotions' OWN select policy (promotions_select_promotions_view, 0044),
-- which additionally requires promotions.view: a caller holding
-- inventory.view but not promotions.view would see the embedded promotion as
-- null through RLS, and that null would be INDISTINGUISHABLE from "no
-- promotion at all" -- the same shape of ambiguity 0090 and 0095 already
-- fought on the archival axis, reappearing here on the permission axis. So
-- this function resolves promotion_name unconditionally to anyone holding
-- inventory.view, the one permission the row itself already required.
--
-- THE ARCHIVED PROMOTION, on top of that, and it is NOT the same rule
-- restated. 0044:47 hides an archived promotion (deleted_at is not null)
-- from everybody but the platform admin and the Organization's owner. A
-- movement is the Station's OWN stock history; hiding the row because its
-- promotion was later archived would delete inventory history from an
-- inventory screen, which is wrong the same way 0095's header already
-- refused it for winners. So the row always lists. The NAME is what the
-- archived rule actually reaches, through the same is_owner_of_company()
-- helper 0044's own policy names -- not a second expression of "who may see
-- an archived row" -- and because withholding only the name would produce a
-- THIRD state indistinguishable from the other two nulls (no promotion at
-- all; a promotion this caller may not be told the name of), the return type
-- carries promotion_archived, said out loud, so the screen can render
-- "(archived promotion)" instead of a blank cell it would otherwise read as
-- "no promotion".
--
-- actor_id (0026) is nullable too, and for the identical reason
-- sweep_pickup_deadlines (0094) records none: pg_cron carries no auth.uid(),
-- so a movement the clock made carries no actor. actor_name resolves through
-- public.profiles -- the application record for a panel operator, an
-- Organization member -- and NEVER public.members, the audience table this
-- schema keeps deliberately separate (company_memberships' own comment,
-- 0003). Coalesced with the profile's email, which is NOT NULL (0003), so
-- the one and only actor_name null means exactly one thing: actor_id itself
-- is null. Without that coalesce, an operator who never set a display name
-- would read as indistinguishable from the clock -- the identical class of
-- ambiguity this function is built to close on the promotion side, left open
-- on the actor side if the fallback were skipped.
--
-- Ordering is created_at desc, movement_id desc -- newest first, tie-broken
-- by id. created_at is NOT NULL (0026), so unlike list_pickups' deadline_at
-- there is no terminal null region the keyset has to reach separately: the
-- cursor is a plain tuple comparison, the shape list_participations'
-- participated_at already uses for the identical reason.
--
-- total_count is computed from the SAME CTE the rows come from (0090's rule,
-- restated by every list in this block since).
create function public.list_movements(
  p_company_id   uuid,
  p_type         public.inventory_movement_type default null,
  p_prize_id     uuid    default null,
  p_promotion_id uuid    default null,
  p_from         timestamptz default null,
  p_to           timestamptz default null,
  p_cursor_at    timestamptz default null,
  p_cursor_id    uuid    default null,
  p_walking_back boolean default false,
  p_limit        integer default 26
)
returns table (
  movement_id        uuid,
  created_at         timestamptz,
  movement_type      public.inventory_movement_type,
  quantity           integer,
  from_bucket        public.inventory_bucket,
  to_bucket          public.inventory_bucket,
  prize_id           uuid,
  prize_name         text,
  promotion_id       uuid,
  promotion_name     text,
  promotion_archived boolean,
  actor_id           uuid,
  actor_name         text,
  note               text,
  total_count        integer
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
begin
  -- The one permission the row already needed (inventory_movements_select_
  -- inventory_view, 0029). Unlike list_pickups/list_participations this
  -- function names no second permission: promotions.view buys nothing here,
  -- because promotion_name is returned to inventory.view alone (see header).
  if not public.has_permission('inventory.view', p_company_id) then
    raise log 'list_movements denied: actor=% company=%', auth.uid(), p_company_id;
    raise exception 'permission denied: inventory.view required' using errcode = '42501';
  end if;

  return query
  with visible as (
    select m.id,
           m.created_at,
           m.movement_type,
           m.quantity,
           m.from_bucket,
           m.to_bucket,
           m.prize_id,
           pz.name as prize_name,
           pp.promotion_id,
           -- Null for a movement naming no promotion at all (pp is null
           -- through the left join, so pp.promotion_id is null and this
           -- whole expression short-circuits to null). Otherwise: the name,
           -- unless the promotion is archived and this caller is not the
           -- Organization's owner -- 0044's own predicate, through 0044's
           -- own helper, never a second expression of the same rule.
           case
             when pp.promotion_id is null then null
             when pr.deleted_at is null or public.is_owner_of_company(pr.company_id) then pr.name
             else null
           end as promotion_name,
           -- False, never null, when there is no promotion at all: this
           -- column answers "is the null beside it the archival null", and a
           -- movement naming no promotion has no such null to explain.
           (pp.promotion_id is not null and pr.deleted_at is not null) as promotion_archived,
           m.actor_id,
           -- profiles.email is NOT NULL (0003); coalescing onto it means the
           -- ONLY null actor_name is the one actor_id is null already
           -- explains, never an operator who simply never set a full_name.
           coalesce(pf.full_name, pf.email) as actor_name,
           m.note
      from public.inventory_movements m
      join public.prizes pz
        on pz.id = m.prize_id
      left join public.promotion_prizes pp
        on pp.id = m.promotion_prize_id and pp.company_id = m.company_id
      left join public.promotions pr
        on pr.id = pp.promotion_id and pr.company_id = m.company_id
      left join public.profiles pf
        on pf.id = m.actor_id
     where m.company_id = p_company_id
       and (p_type is null         or m.movement_type = p_type)
       and (p_prize_id is null     or m.prize_id = p_prize_id)
       and (p_promotion_id is null or pp.promotion_id = p_promotion_id)
       and (p_from is null         or m.created_at >= p_from)
       and (p_to is null           or m.created_at <= p_to)
  )
  select f.id,
         f.created_at,
         f.movement_type,
         f.quantity,
         f.from_bucket,
         f.to_bucket,
         f.prize_id,
         f.prize_name,
         f.promotion_id,
         f.promotion_name,
         f.promotion_archived,
         f.actor_id,
         f.actor_name,
         f.note,
         -- The total of the FILTERED set, computed from the SAME CTE the
         -- rows come from, so a page and its count cannot narrow differently
         -- (0090's rule, restated here).
         (select count(*) from visible)::integer as total_count
    from visible f
   -- No cursor at all (p_cursor_id null) means the first page. Otherwise a
   -- plain tuple comparison: created_at is NOT NULL on every row (0026), so
   -- there is no terminal null region to reach separately the way
   -- list_pickups' deadline_at needs -- the same shape list_participations'
   -- participated_at cursor already uses.
   where p_cursor_at is null
      or p_cursor_id is null
      or (case when p_walking_back
               then (f.created_at, f.id) > (p_cursor_at, p_cursor_id)
               else (f.created_at, f.id) < (p_cursor_at, p_cursor_id)
          end)
   -- Newest first, tie-broken by id. Walking back reads the opposite of
   -- display order and the caller reverses the small batch, exactly as
   -- list_participations' own keyset does it.
   order by
     case when p_walking_back then f.created_at end asc,
     case when p_walking_back then f.id end asc,
     case when not p_walking_back then f.created_at end desc,
     case when not p_walking_back then f.id end desc
   limit p_limit;
end;
$$;

comment on function public.list_movements(uuid, public.inventory_movement_type, uuid, uuid, timestamptz, timestamptz, timestamptz, uuid, boolean, integer) is
  'One keyset page of a Station''s whole inventory ledger, newest first (created_at desc, movement_id desc -- created_at is NOT NULL, so unlike list_pickups there is no terminal null region to reach). Gated on inventory.view alone, the same single permission inventory_movements_select_inventory_view (0029) already required for the row -- this function exists only because the PROMOTION NAME needs more than that policy gives: promotion_prize_id is nullable with meaning (null is a purchase entry or a stock adjustment, belonging to no promotion at all), and a plain embed would additionally require promotions.view, whose absence would make a withheld name indistinguishable from that same null. So promotion_name comes back to anyone holding inventory.view. Separately, an ARCHIVED promotion (0044:47) hides its NAME, not its row -- a movement is the Station''s own stock history and hiding it would delete that history from an inventory screen -- and promotion_archived says which of the two nulls this is, through the same is_owner_of_company() helper 0044''s own policy names. actor_name is coalesced from profiles.full_name and its NOT NULL email, so the ONLY actor_name null means actor_id itself is null -- the deadline sweep (0094) running under pg_cron with no auth.uid() -- which the screen renders as "(deadline)". total_count is computed from the same CTE the rows come from, so a page and its count cannot narrow differently.';

revoke execute on function public.list_movements(uuid, public.inventory_movement_type, uuid, uuid, timestamptz, timestamptz, timestamptz, uuid, boolean, integer) from public;
grant execute on function public.list_movements(uuid, public.inventory_movement_type, uuid, uuid, timestamptz, timestamptz, timestamptz, uuid, boolean, integer) to authenticated;
